/**
 * Diagnose why compacting is leaving a Kin much heavier than expected.
 *
 * Usage on prod:
 *   bun run scripts/diag-compacting.ts <kin-slug-or-id>
 *
 * Decomposes the post-compact context into:
 *   - System prompt + tools + memories (stuff that compacting can't touch)
 *   - Active compacting summaries (should be <= summaryBudget)
 *   - Non-compacted messages (the keep-window survivors)
 *   - Per-message size distribution (to spot huge survivors)
 */
import { Database } from 'bun:sqlite'
import { resolve } from 'path'

const arg = process.argv[2]
if (!arg) {
  console.error('Usage: bun run scripts/diag-compacting.ts <kin-slug-or-id>')
  process.exit(1)
}

// Adjust if your prod DB is at a different path
const DB_PATH = process.env.KINBOT_DB ?? resolve('./data/kinbot.db')
const db = new Database(DB_PATH, { readonly: true })

// chars/4 is a fast rough estimate (gpt-tokenizer would be more accurate
// but adds startup cost — for an order-of-magnitude diagnostic chars/4 is fine)
const tok = (s: string | null | undefined) => s ? Math.ceil(s.length / 4) : 0

// Resolve kin
const kin = db.query<{ id: string; slug: string; name: string; model: string; compacting_config: string | null; tool_config: string | null }, string>(
  `SELECT id, slug, name, model, compacting_config, tool_config FROM kins WHERE id = ? OR slug = ?`,
).all(arg, arg)[0]

if (!kin) {
  console.error(`No kin found for "${arg}"`)
  process.exit(1)
}

console.log(`\n═══ Compacting diagnostic for ${kin.name} (${kin.slug}) ═══`)
console.log(`Kin ID: ${kin.id}`)
console.log(`Model:  ${kin.model}`)

// Per-Kin compacting config (overrides global)
const compactingConfig = kin.compacting_config ? JSON.parse(kin.compacting_config) : {}
console.log(`\n--- Compacting config (per-Kin overrides) ---`)
console.log(JSON.stringify(compactingConfig, null, 2))

// Active summaries
const summaries = db.query<{ id: string; summary: string; first_message_at: number; last_message_at: number; message_count: number; depth: number; created_at: number }, string>(
  `SELECT id, summary, first_message_at, last_message_at, message_count, depth, created_at
   FROM compacting_summaries
   WHERE kin_id = ? AND is_in_context = 1
   ORDER BY last_message_at ASC`,
).all(kin.id)

console.log(`\n--- Active summaries (${summaries.length}) ---`)
let totalSummaryTokens = 0
for (const s of summaries) {
  const t = tok(s.summary)
  totalSummaryTokens += t
  console.log(`  ${s.id.slice(0, 8)} depth=${s.depth} msgs=${s.message_count} tokens=${t.toLocaleString()} created=${new Date(s.created_at).toISOString()}`)
}
console.log(`  TOTAL summary tokens: ${totalSummaryTokens.toLocaleString()}`)

// Cutoff = lastMessageAt of latest active summary
const cutoff = summaries.length > 0 ? summaries[summaries.length - 1]!.last_message_at : null
console.log(`\nCutoff timestamp: ${cutoff ? new Date(cutoff).toISOString() : '(none — no summaries)'}`)

// Non-compacted messages (those that buildMessageHistory will load)
const recentMsgs = db.query<{ id: string; role: string; content: string | null; tool_calls: string | null; created_at: number; source_type: string | null }, [string, number]>(
  `SELECT id, role, content, tool_calls, created_at, source_type
   FROM messages
   WHERE kin_id = ?
     AND task_id IS NULL
     AND session_id IS NULL
     AND source_type != 'compacting'
     AND (created_at > ? OR ? = 0)
   ORDER BY created_at ASC`,
).all(kin.id, cutoff ?? 0, cutoff ? 1 : 0)

console.log(`\n--- Non-compacted messages (${recentMsgs.length}) ---`)
let totalMsgTokens = 0
const sizes: number[] = []
for (const m of recentMsgs) {
  const t = tok(m.content) + tok(m.tool_calls)
  totalMsgTokens += t
  sizes.push(t)
}
console.log(`  TOTAL message tokens: ${totalMsgTokens.toLocaleString()}`)
console.log(`  AVG: ${(totalMsgTokens / Math.max(1, recentMsgs.length)).toFixed(0)} tokens/msg`)

// Top 10 heaviest messages
sizes.sort((a, b) => b - a)
console.log(`  Top 10 heaviest messages:`)
for (let i = 0; i < Math.min(10, sizes.length); i++) {
  console.log(`    #${i + 1}: ${sizes[i]!.toLocaleString()} tokens`)
}

// Distribution
const buckets = [
  { name: '<1k',   max: 1_000 },
  { name: '1-5k',  max: 5_000 },
  { name: '5-20k', max: 20_000 },
  { name: '20-50k', max: 50_000 },
  { name: '50-100k', max: 100_000 },
  { name: '>100k', max: Infinity },
]
console.log(`  Distribution:`)
for (const b of buckets) {
  const count = sizes.filter((s) => s < b.max).length - sizes.filter((s) => s < (buckets[buckets.indexOf(b) - 1]?.max ?? 0)).length
  if (count > 0) console.log(`    ${b.name}: ${count} msg`)
}

// Cached context usage (what the navbar shows)
const usage = db.query<{ value: string }, string>(
  `SELECT value FROM app_settings WHERE key = ?`,
).all(`context_usage:${kin.id}`)[0]
if (usage) {
  const parsed = JSON.parse(usage.value)
  console.log(`\n--- Cached context usage (navbar source) ---`)
  console.log(`  contextTokens (calibrated estimate): ${parsed.contextTokens?.toLocaleString() ?? 'n/a'}`)
  console.log(`  apiContextTokens (provider truth):  ${parsed.apiContextTokens?.toLocaleString() ?? 'n/a'}`)
  console.log(`  contextWindow:                       ${parsed.contextWindow?.toLocaleString() ?? 'n/a'}`)
  console.log(`  calibrationFactor:                   ${parsed.calibrationFactor?.toFixed(3) ?? 'n/a'}`)
  console.log(`  breakdown:                           ${JSON.stringify(parsed.breakdown ?? {})}`)
}

// Memories count (rough indicator)
const memCount = db.query<{ n: number }, string>(`SELECT count(*) AS n FROM memories WHERE kin_id = ?`).all(kin.id)[0]?.n ?? 0
console.log(`\n--- Memories ---`)
console.log(`  Total: ${memCount}`)

// Summary
console.log(`\n═══ Summary ═══`)
const known = totalSummaryTokens + totalMsgTokens
console.log(`  Active summaries:    ${totalSummaryTokens.toLocaleString().padStart(10)} tokens`)
console.log(`  Non-compacted msgs:  ${totalMsgTokens.toLocaleString().padStart(10)} tokens (${recentMsgs.length} messages)`)
console.log(`  --- known so far:    ${known.toLocaleString().padStart(10)} tokens`)
if (usage) {
  const parsed = JSON.parse(usage.value)
  const total = parsed.apiContextTokens ?? parsed.contextTokens
  if (total) {
    const unattributed = total - known
    console.log(`  Total (per cache):   ${total.toLocaleString().padStart(10)} tokens`)
    console.log(`  ↳ Unattributed:      ${unattributed.toLocaleString().padStart(10)} tokens (system prompt + tools + memories + envelope overhead)`)
    console.log(`\nIf "Unattributed" is huge (>200k), the bottleneck is system prompt / tools / memories — compacting can't touch those.`)
    console.log(`If "Non-compacted msgs" is huge (>500k), the keep-window kept too many recent messages — lower keepPercent or check for huge tool outputs.`)
    console.log(`If "Active summaries" is huge (>200k), maybeMergeSummaries isn't firing or maxSummaries is too high.`)
  }
}

db.close()
