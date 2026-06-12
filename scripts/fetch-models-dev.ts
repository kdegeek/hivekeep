/**
 * Fetch + trim the models.dev catalogue into the BUNDLED snapshot (shipped in
 * the build for an offline first boot). The fetch/trim logic is shared with the
 * runtime refresh service via `@/server/llm/metadata/models-dev-fetch`.
 *
 * Run: `bun scripts/fetch-models-dev.ts` (manually / pre-release / CI).
 * Output: `src/server/llm/metadata/models-dev-snapshot.json`.
 */
import { fetchModelsDevSnapshot } from '@/server/llm/metadata/models-dev-fetch'

const OUT = new URL('../src/server/llm/metadata/models-dev-snapshot.json', import.meta.url)

async function main() {
  process.stdout.write('Fetching https://models.dev/api.json …\n')
  const { snapshot, providerCount, modelCount } = await fetchModelsDevSnapshot()
  const json = JSON.stringify(snapshot, null, 0)
  await Bun.write(OUT, json + '\n')
  process.stdout.write(
    `Wrote ${OUT.pathname} — ${providerCount} providers, ${modelCount} models, ${(json.length / 1024).toFixed(0)} KB\n`,
  )
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})
