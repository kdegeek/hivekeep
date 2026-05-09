import { db } from '@/server/db/index'
import { kins, messages, userProfiles, compactingSummaries, tasks } from '@/server/db/schema'
import { eq, and, isNull, desc, ne, asc } from 'drizzle-orm'
import { getFilesForMessages } from '@/server/services/files'
import { buildSystemPrompt, joinSystemPrompt } from '@/server/services/prompt-builder'
import { getRelevantMemories } from '@/server/services/memory'
import { listContactsForPrompt } from '@/server/services/contacts'
import { listAvailableKins } from '@/server/services/inter-kin'
import { getMCPToolsSummary, resolveMCPTools } from '@/server/services/mcp'
import { resolveCustomTools } from '@/server/services/custom-tools'
import { toolRegistry } from '@/server/tools/index'
import { getGlobalPrompt, getHubKinId } from '@/server/services/app-settings'
import { fetchPreviousCronRuns } from '@/server/services/tasks'
import { fetchCronLearnings } from '@/server/services/cron-learnings'
import { getActiveChannelsForKin } from '@/server/services/channels'
import type { KinToolConfig, KinCompactingConfig } from '@/shared/types'
import { getModelContextWindow } from '@/shared/model-context-windows'
import { config } from '@/server/config'

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown> | null
}

interface MessagePreview {
  role: string
  content: string | null
  hasToolCalls: boolean
  /** Server-side estimate covering content + toolCalls JSON content. The
   *  tool calls JSON is intentionally NOT sent in the preview (it would
   *  bloat the response), but its tokens DO count toward the context size. */
  tokenEstimate: number
  createdAt: number | null
}

interface SummaryPreview {
  summary: string
  firstMessageAt: string
  lastMessageAt: string
  depth: number
  tokenEstimate: number
  messageCount: number
}

interface CronRunPreview {
  status: string
  result: string | null
  createdAt: string
  updatedAt: string
  durationSec: number
}

interface CronLearningPreview {
  id: string
  content: string
  category: string | null
  createdAt: string
}

interface ContextPreviewResult {
  /** System prompt with tools block appended (for structured/markdown view) */
  systemPrompt: string
  /** Raw compacting summary — combined text (null if no compacting has occurred) */
  compactingSummary: string | null
  /** Individual summaries with metadata for detailed display */
  summaries: SummaryPreview[]
  /** Previous cron run results (only for cron-spawned tasks) */
  cronRuns: CronRunPreview[]
  /** Accumulated cron learnings (only for cron-spawned tasks) */
  cronLearnings: CronLearningPreview[]
  /** Full raw payload as JSON (system + messages + tools) */
  rawPayload: {
    system: string
    messages: MessagePreview[]
    tools: ToolDefinition[]
  }
  /** Estimated token breakdown by section */
  tokenEstimate: {
    systemPrompt: number
    summary: number
    cronRuns: number
    cronLearnings: number
    messages: number
    tools: number
    total: number
  }
  /** Model's max context window in tokens */
  contextWindow: number
  /** Compacting threshold as % of context window (null for tasks / quick sessions) */
  compactingThresholdPercent: number | null
  messageCount: number
  generatedAt: number
}

/**
 * Estimate the additional tokens contributed by attached files on a message.
 * Mirrors the file-handling logic in kin-engine's estimateContextTokens so
 * the visualizer matches the live banner.
 */
function estimateMessageFilesTokens(
  attachedFiles: Array<{ mimeType: string; size: number }> | undefined,
): number {
  if (!attachedFiles || attachedFiles.length === 0) return 0
  let total = 0
  for (const f of attachedFiles) {
    if (f.mimeType?.startsWith('image/')) {
      // Same heuristic as the live banner: ~bytes/750 with a 1500 floor for
      // typical screenshots. Beats the prior flat 85.
      total += Math.max(1500, Math.round(f.size / 750))
    } else if (f.mimeType === 'application/pdf') {
      total += Math.max(500, Math.ceil(f.size / 3000) * 500)
    } else if (f.size > 0 && f.size <= 100_000) {
      // Small text-readable files get inlined: ~bytes/4 tokens.
      total += Math.ceil(f.size / 4)
    }
    // Larger binary files are mentioned by path only (negligible tokens).
  }
  return total
}

// Backed by gpt-tokenizer (BPE) — within ~5-15% of provider tokenizers,
// vastly more accurate than chars/4 on JSON / YAML / CLI output that
// dominates tool-heavy Kins.
import { countTokens as countTokensShared } from '@/shared/token-estimator'
function estimateTokens(text: string): number {
  return countTokensShared(text)
}

/** Read the per-Kin EMA-smoothed calibration factor written by recordApiContextSize.
 *  Lazy-import to avoid a circular dep with kin-engine. */
async function getKinCalibrationFactor(kinId: string): Promise<number> {
  try {
    const { getLastContextUsage } = await import('@/server/services/kin-engine')
    const cached = await getLastContextUsage(kinId)
    return cached?.calibrationFactor ?? 1
  } catch {
    return 1
  }
}

/**
 * Safely extract a JSON Schema from a Zod schema (Zod v4 .toJSONSchema()).
 * Falls back to null if the method is unavailable.
 */
function safeToJsonSchema(schema: unknown): Record<string, unknown> | null {
  if (schema && typeof schema === 'object' && 'toJSONSchema' in schema && typeof (schema as { toJSONSchema: unknown }).toJSONSchema === 'function') {
    try {
      return (schema as { toJSONSchema(): Record<string, unknown> }).toJSONSchema()
    } catch {
      return null
    }
  }
  return null
}

/**
 * Build a context preview for a Kin — the system prompt as it would be
 * assembled right now, plus the list of available tools and message history.
 *
 * This mirrors the data-gathering logic in kin-engine.processKinQueue()
 * but without queue-specific concerns (no queue item, no speaker profile,
 * no channel context).
 */
export async function buildContextPreview(kinId: string): Promise<ContextPreviewResult> {
  // Load the Kin
  const kin = db
    .select()
    .from(kins)
    .where(eq(kins.id, kinId))
    .get()
  if (!kin) throw new Error('Kin not found')

  // Contacts
  const contactsWithSlug = await listContactsForPrompt()

  // Kin directory
  const kinDirectory = (await listAvailableKins(kinId)).map((k) => ({
    slug: k.slug,
    name: k.name,
    role: k.role,
  }))

  // Relevant memories — use the last user message as query, or fallback
  let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
  try {
    const lastUserMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.kinId, kinId), eq(messages.role, 'user'), isNull(messages.taskId), isNull(messages.sessionId)))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    const query = lastUserMsg?.content ?? kin.name
    relevantMemories = await getRelevantMemories(kinId, query)
  } catch {
    // Non-fatal
  }

  // Knowledge
  let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
  try {
    const { searchKnowledge } = await import('@/server/services/knowledge')
    const lastUserMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.kinId, kinId), eq(messages.role, 'user'), isNull(messages.taskId), isNull(messages.sessionId)))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    relevantKnowledge = await searchKnowledge(kinId, lastUserMsg?.content ?? kin.name, 5)
  } catch {
    // Non-fatal
  }

  // MCP tools summary for prompt
  const mcpToolsSummary = await getMCPToolsSummary(kinId)

  // Active channels
  const activeChannelRows = await getActiveChannelsForKin(kinId)
  const activeChannels = activeChannelRows.map((ch) => ({ platform: ch.platform, name: ch.name }))

  // Global prompt
  const globalPrompt = await getGlobalPrompt()

  // Hub detection
  const hubKinId = await getHubKinId()
  const isHub = hubKinId === kinId

  let hubKinDirectory: Array<{ slug: string | null; name: string; role: string; expertiseSummary: string; activeChannels?: string[] }> | undefined
  if (isHub) {
    const otherKins = db
      .select({ id: kins.id, slug: kins.slug, name: kins.name, role: kins.role, expertise: kins.expertise })
      .from(kins)
      .where(ne(kins.id, kinId))
      .all()

    hubKinDirectory = await Promise.all(
      otherKins.map(async (k) => {
        const kinChannels = await getActiveChannelsForKin(k.id)
        return {
          slug: k.slug,
          name: k.name,
          role: k.role,
          expertiseSummary: k.expertise.length > 300 ? k.expertise.slice(0, 300) + '...' : k.expertise,
          activeChannels: kinChannels.length > 0 ? kinChannels.map((ch) => `${ch.platform}: "${ch.name}"`) : undefined,
        }
      }),
    )
  }

  // Compacting summaries (from active in-context summaries)
  const activeSummaries = db
    .select()
    .from(compactingSummaries)
    .where(and(eq(compactingSummaries.kinId, kinId), eq(compactingSummaries.isInContext, true)))
    .orderBy(asc(compactingSummaries.lastMessageAt))
    .all()

  const compactingSummariesData = activeSummaries.length > 0
    ? activeSummaries.map((s) => ({
        summary: s.summary,
        firstMessageAt: new Date(s.firstMessageAt as unknown as number),
        lastMessageAt: new Date(s.lastMessageAt as unknown as number),
        depth: s.depth ?? 0,
      }))
    : null

  // Resolve cutoff timestamp from the latest summary
  const latestSummary = activeSummaries.length > 0 ? activeSummaries[activeSummaries.length - 1]! : null
  const cutoffTimestamp = latestSummary ? (latestSummary.lastMessageAt as unknown as number) : null

  // Fetch recent messages for history preview
  const recentMessages = db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      toolCalls: messages.toolCalls,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(and(
      eq(messages.kinId, kinId),
      isNull(messages.taskId),
      isNull(messages.sessionId),
      ne(messages.sourceType, 'compacting'),
    ))
    .orderBy(desc(messages.createdAt))
    // Match the live banner's history fetch limit so token estimates agree.
    // The previous limit(100) caused the visualizer to under-count by
    // hundreds of thousands of tokens on Kins with long histories — the
    // actual API call (kin-engine.buildMessageHistory) loads up to
    // config.historyMaxMessages messages.
    .limit(config.historyMaxMessages)
    .all()

  recentMessages.reverse()

  // Filter to post-snapshot messages (mirrors buildMessageHistory logic)
  const visibleMessages = cutoffTimestamp
    ? recentMessages.filter((m) => m.createdAt && (m.createdAt as unknown as number) > cutoffTimestamp)
    : recentMessages

  // Pre-load attached files for all visible messages so we can count their
  // tokens (images, inlined text files, PDFs) — matches what kin-engine sends
  // to the API.
  const visibleIds = visibleMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const filesByMessageId = visibleIds.length > 0 ? await getFilesForMessages(visibleIds) : new Map()

  const messagesPreviews: MessagePreview[] = visibleMessages.map((m) => ({
    role: m.role,
    content: m.content,
    hasToolCalls: m.toolCalls !== null,
    tokenEstimate:
      estimateTokens(m.content ?? '')
      + estimateTokens((m.toolCalls as string | null) ?? '')
      + estimateMessageFilesTokens(filesByMessageId.get(m.id ?? '')),
    createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
  }))

  // Message counts for conversation state
  const totalMessageCount = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.kinId, kinId), isNull(messages.taskId), isNull(messages.sessionId)))
    .all()
    .length

  const visibleMessageCount = visibleMessages.length
  const hasCompactedHistory = activeSummaries.length > 0

  // User language — get from first user profile as fallback
  let userLanguage: 'fr' | 'en' = 'fr'
  const firstProfile = db.select({ language: userProfiles.language }).from(userProfiles).limit(1).get()
  if (firstProfile) {
    userLanguage = firstProfile.language as 'fr' | 'en'
  }

  // Build system prompt
  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    kin: { name: kin.name, slug: kin.slug, role: kin.role, character: kin.character, expertise: kin.expertise },
    contacts: contactsWithSlug,
    relevantMemories,
    relevantKnowledge,
    kinDirectory,
    mcpTools: mcpToolsSummary,
    isSubKin: false,
    activeChannels: activeChannels.length > 0 ? activeChannels : undefined,
    globalPrompt,
    userLanguage,
    isHub,
    hubKinDirectory,
    compactingSummaries: compactingSummariesData,
    conversationState: {
      visibleMessageCount,
      totalMessageCount,
      hasCompactedHistory,
    },
    workspacePath: kin.workspacePath,
  }))

  // Resolve tools
  const toolConfig: KinToolConfig | null = kin.toolConfig ? JSON.parse(kin.toolConfig) : null
  const nativeTools = toolRegistry.resolve({ kinId, isSubKin: false })

  if (toolConfig?.disabledNativeTools?.length) {
    for (const name of toolConfig.disabledNativeTools) {
      delete nativeTools[name]
    }
  }

  if (!isHub) {
    const allRegistered = toolRegistry.list()
    const optInSet = new Set(toolConfig?.enabledOptInTools ?? [])
    for (const reg of allRegistered) {
      if (reg.defaultDisabled && !optInSet.has(reg.name)) {
        delete nativeTools[reg.name]
      }
    }
  }

  const mcpTools = await resolveMCPTools(kinId, toolConfig)
  const customToolDefs = await resolveCustomTools(kinId)
  const allTools = { ...nativeTools, ...mcpTools, ...customToolDefs }

  const toolDefinitions = buildToolDefs(allTools)

  const combinedSummary = compactingSummariesData
    ? compactingSummariesData.map((s) => s.summary).join('\n\n---\n\n')
    : null

  const summaryPreviews: SummaryPreview[] = activeSummaries.map((s) => ({
    summary: s.summary,
    firstMessageAt: new Date(s.firstMessageAt as unknown as number).toISOString(),
    lastMessageAt: new Date(s.lastMessageAt as unknown as number).toISOString(),
    depth: s.depth ?? 0,
    tokenEstimate: s.tokenEstimate ?? estimateTokens(s.summary),
    messageCount: s.messageCount ?? 0,
  }))

  // Resolve compacting threshold for this Kin
  let perKinCompacting: KinCompactingConfig | null = null
  if (kin.compactingConfig) {
    try { perKinCompacting = JSON.parse(kin.compactingConfig) as KinCompactingConfig } catch { /* ignore */ }
  }
  const compactingThresholdPercent = perKinCompacting?.thresholdPercent ?? config.compacting.thresholdPercent

  const calibrationFactor = await getKinCalibrationFactor(kinId)
  return formatResult(systemPrompt, toolDefinitions, messagesPreviews, totalMessageCount, getModelContextWindow(kin.model), combinedSummary, summaryPreviews, compactingThresholdPercent, [], [], calibrationFactor)
}

/** Extract JSON Schema tool definitions from a tools map */
function buildToolDefs(tools: Record<string, unknown>): ToolDefinition[] {
  return Object.entries(tools).map(([name, t]) => {
    const toolObj = t as { description?: string; inputSchema?: unknown }
    return {
      name,
      description: toolObj.description ?? '',
      parameters: safeToJsonSchema(toolObj.inputSchema),
    }
  })
}

const CRON_RUNS_HEADER = '## Previous runs'
const CRON_LEARNINGS_HEADER = '## Learnings from previous runs'

/** Extract token count for a prompt section identified by its header */
function extractSectionTokens(systemPrompt: string, header: string): number {
  const idx = systemPrompt.indexOf(header)
  if (idx === -1) return 0
  const afterHeader = systemPrompt.indexOf('\n## ', idx + header.length)
  const section = afterHeader === -1
    ? systemPrompt.slice(idx)
    : systemPrompt.slice(idx, afterHeader)
  return estimateTokens(section)
}

/** Format a ContextPreviewResult from the assembled parts */
function formatResult(
  systemPrompt: string,
  toolDefinitions: ToolDefinition[],
  messagesPreviews: MessagePreview[],
  messageCount: number,
  contextWindow: number,
  compactingSummary: string | null = null,
  summaries: SummaryPreview[] = [],
  compactingThresholdPercent: number | null = null,
  cronRuns: CronRunPreview[] = [],
  cronLearnings: CronLearningPreview[] = [],
  /** Per-Kin EMA-smoothed factor learned from past API roundtrips (api / raw_BPE).
   *  When > 1 (typical: 1.3-1.6 for Anthropic on tool-heavy contexts), the
   *  visualizer's section totals + per-message estimates are scaled to match
   *  what the navbar shows after calibration. Defaults to 1 when no roundtrip
   *  has been observed yet. */
  calibrationFactor: number = 1,
): ContextPreviewResult {
  let fullPrompt = systemPrompt
  if (toolDefinitions.length > 0) {
    const toolLines = toolDefinitions
      .map((t) => `- **${t.name}**: ${t.description || '(no description)'}`)
      .join('\n')
    fullPrompt += `\n\n## Available tools (${toolDefinitions.length})\n\n${toolLines}`
  }

  // Estimate tokens from dedicated prompt sections
  const cronRunsTokens = extractSectionTokens(systemPrompt, CRON_RUNS_HEADER)
  const cronLearningsTokens = extractSectionTokens(systemPrompt, CRON_LEARNINGS_HEADER)

  // Estimate tokens per section
  const summaryTokens = compactingSummary ? estimateTokens(compactingSummary) : 0
  const rawSystemTokens = estimateTokens(systemPrompt)
  const systemPromptTokens = Math.max(0, rawSystemTokens - summaryTokens - cronRunsTokens - cronLearningsTokens)
  // Count message tokens from the per-message tokenEstimate computed at
  // preview construction time, which covers BOTH content text AND toolCalls
  // JSON. The previous version only counted content, silently under-counting
  // context by 10-20× on tool-heavy Kins (kubectl outputs, file reads,
  // page_state YAMLs all live in toolCalls).
  let messagesTokens = 0
  for (const m of messagesPreviews) {
    messagesTokens += m.tokenEstimate
  }
  const toolsTokens = toolDefinitions.length > 0 ? estimateTokens(JSON.stringify(toolDefinitions)) : 0
  const rawTotal = systemPromptTokens + summaryTokens + cronRunsTokens + cronLearningsTokens + messagesTokens + toolsTokens

  // Apply calibration uniformly across sections + per-message estimates so
  // every number summed in this response matches the navbar's calibrated
  // "estimate" bar. Without this, the visualizer modal shows raw BPE counts
  // (under-counted by 30-60%) while the navbar shows calibrated values —
  // confusing the user about which one is "right".
  const scale = (n: number) => Math.round(n * calibrationFactor)
  const calibratedMessagesPreviews = calibrationFactor === 1
    ? messagesPreviews
    : messagesPreviews.map((m) => ({ ...m, tokenEstimate: scale(m.tokenEstimate) }))

  return {
    systemPrompt: fullPrompt,
    compactingSummary,
    summaries,
    cronRuns,
    cronLearnings,
    rawPayload: {
      system: systemPrompt,
      messages: calibratedMessagesPreviews,
      tools: toolDefinitions,
    },
    tokenEstimate: {
      systemPrompt: scale(systemPromptTokens),
      summary: scale(summaryTokens),
      cronRuns: scale(cronRunsTokens),
      cronLearnings: scale(cronLearningsTokens),
      messages: scale(messagesTokens),
      tools: scale(toolsTokens),
      total: scale(rawTotal),
    },
    contextWindow,
    compactingThresholdPercent,
    messageCount,
    generatedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Task (sub-kin) context preview
// Mirrors executeSubKin() in tasks.ts
// ---------------------------------------------------------------------------

const SUB_KIN_EXCLUDED_TOOLS = new Set([
  'spawn_self', 'spawn_kin',
  'respond_to_task', 'cancel_task', 'list_tasks',
  'reply',
  'create_cron', 'update_cron', 'delete_cron', 'list_crons',
  'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
  'register_tool', 'list_custom_tools',
  'create_kin', 'update_kin', 'delete_kin', 'get_kin_details',
])

export async function buildTaskContextPreview(taskId: string): Promise<ContextPreviewResult> {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) throw new Error('Task not found')

  const parentKin = db.select().from(kins).where(eq(kins.id, task.parentKinId)).get()
  if (!parentKin) throw new Error('Parent Kin not found')

  // Determine identity (same logic as executeSubKin)
  let kinIdentity = parentKin
  if (task.spawnType === 'other' && task.sourceKinId) {
    const sourceKin = db.select().from(kins).where(eq(kins.id, task.sourceKinId)).get()
    if (sourceKin) kinIdentity = sourceKin
  }

  const globalPrompt = await getGlobalPrompt()
  const kinDirectory = (await listAvailableKins(kinIdentity.id)).map((k) => ({
    slug: k.slug,
    name: k.name,
    role: k.role,
  }))

  const previousCronRuns = task.cronId
    ? await fetchPreviousCronRuns(task.cronId, 5)
    : undefined

  const cronLearningsData = task.cronId
    ? fetchCronLearnings(task.cronId)
    : undefined

  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    kin: { name: kinIdentity.name, slug: kinIdentity.slug, role: kinIdentity.role, character: kinIdentity.character, expertise: kinIdentity.expertise },
    contacts: [],
    relevantMemories: [],
    kinDirectory,
    isSubKin: true,
    taskDescription: task.description,
    previousCronRuns,
    cronLearnings: cronLearningsData,
    globalPrompt,
    userLanguage: 'en',
    workspacePath: kinIdentity.workspacePath,
  }))

  // Messages: only this task's messages
  const taskMessages = db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolCalls: messages.toolCalls, createdAt: messages.createdAt })
    .from(messages)
    .where(and(eq(messages.kinId, task.parentKinId), eq(messages.taskId, taskId)))
    .orderBy(asc(messages.createdAt))
    .all()

  const taskMsgIds = taskMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const taskFilesByMessageId = taskMsgIds.length > 0 ? await getFilesForMessages(taskMsgIds) : new Map()

  const messagesPreviews: MessagePreview[] = taskMessages.map((m) => ({
    role: m.role,
    content: m.content,
    hasToolCalls: m.toolCalls !== null,
    tokenEstimate:
      estimateTokens(m.content ?? '')
      + estimateTokens((m.toolCalls as string | null) ?? '')
      + estimateMessageFilesTokens(taskFilesByMessageId.get(m.id ?? '')),
    createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
  }))

  // Tools: same resolution as executeSubKin
  const kinToolConfig: KinToolConfig | null = kinIdentity.toolConfig ? JSON.parse(kinIdentity.toolConfig) : null
  const nativeTools = toolRegistry.resolve({ kinId: kinIdentity.id, taskId, taskDepth: task.depth, isSubKin: false })

  if (kinToolConfig?.disabledNativeTools?.length) {
    for (const name of kinToolConfig.disabledNativeTools) {
      delete nativeTools[name]
    }
  }
  const allRegistered = toolRegistry.list()
  const optInSet = new Set(kinToolConfig?.enabledOptInTools ?? [])
  for (const reg of allRegistered) {
    if (reg.defaultDisabled && !optInSet.has(reg.name)) {
      delete nativeTools[reg.name]
    }
  }
  for (const name of SUB_KIN_EXCLUDED_TOOLS) {
    delete nativeTools[name]
  }

  const subKinTools = toolRegistry.resolve({ kinId: task.parentKinId, taskId, taskDepth: task.depth, isSubKin: true })
  const mcpTools = await resolveMCPTools(kinIdentity.id, kinToolConfig)
  const customToolDefs = await resolveCustomTools(kinIdentity.id)
  const allTools = { ...nativeTools, ...subKinTools, ...mcpTools, ...customToolDefs }

  // Build cron run previews
  const cronRunPreviews: CronRunPreview[] = previousCronRuns
    ? previousCronRuns.map((r) => ({
        status: r.status,
        result: r.result,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        durationSec: Math.round((r.updatedAt.getTime() - r.createdAt.getTime()) / 1000),
      }))
    : []

  // Build cron learning previews
  const cronLearningPreviews: CronLearningPreview[] = cronLearningsData
    ? cronLearningsData.map((l) => ({
        id: l.id,
        content: l.content,
        category: l.category,
        createdAt: l.createdAt.toISOString(),
      }))
    : []

  const modelId = task.model ?? kinIdentity.model
  // Tasks share the parent Kin's calibration factor — same model, same content
  // profile (tools, files, structured outputs).
  const calibrationFactor = await getKinCalibrationFactor(parentKin.id)
  return formatResult(systemPrompt, buildToolDefs(allTools), messagesPreviews, taskMessages.length, getModelContextWindow(modelId), null, [], null, cronRunPreviews, cronLearningPreviews, calibrationFactor)
}

// ---------------------------------------------------------------------------
// Quick session context preview
// Mirrors processQuickMessage() in kin-engine.ts
// ---------------------------------------------------------------------------

const QUICK_SESSION_EXCLUDED_TOOLS = new Set([
  'spawn_self', 'spawn_kin', 'respond_to_task', 'cancel_task', 'list_tasks',
  'report_to_parent', 'update_task_status', 'request_input',
  'send_message', 'reply', 'list_kins',
  'create_cron', 'update_cron', 'delete_cron', 'list_crons', 'get_cron_journal',
  'add_mcp_server', 'update_mcp_server', 'remove_mcp_server', 'list_mcp_servers',
  'register_tool', 'list_custom_tools',
  'create_kin', 'update_kin', 'delete_kin', 'get_kin_details',
  'create_webhook', 'update_webhook', 'delete_webhook', 'list_webhooks',
  'send_channel_message', 'list_channel_conversations',
  'get_platform_logs',
  'memorize', 'update_memory', 'forget',
])

export async function buildQuickSessionContextPreview(kinId: string, sessionId: string): Promise<ContextPreviewResult> {
  const kin = db.select().from(kins).where(eq(kins.id, kinId)).get()
  if (!kin) throw new Error('Kin not found')

  // User language
  let userLanguage: 'fr' | 'en' = 'fr'
  const firstProfile = db.select({ language: userProfiles.language }).from(userProfiles).limit(1).get()
  if (firstProfile) userLanguage = firstProfile.language as 'fr' | 'en'

  // Memories (use last session message as query)
  let relevantMemories: Array<{ id: string; category: string; content: string; subject: string | null; importance: number | null; updatedAt: Date | null; score: number }> = []
  try {
    const lastMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    if (lastMsg?.content) relevantMemories = await getRelevantMemories(kinId, lastMsg.content)
  } catch {
    // Non-fatal
  }

  // Knowledge
  let relevantKnowledge: Array<{ content: string; sourceId: string; score: number }> = []
  try {
    const { searchKnowledge } = await import('@/server/services/knowledge')
    const lastMsg = db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(desc(messages.createdAt))
      .limit(1)
      .get()
    if (lastMsg?.content) relevantKnowledge = await searchKnowledge(kinId, lastMsg.content, 5)
  } catch {
    // Non-fatal
  }

  const globalPrompt = await getGlobalPrompt()

  const systemPrompt = joinSystemPrompt(buildSystemPrompt({
    kin: { name: kin.name, slug: kin.slug, role: kin.role, character: kin.character, expertise: kin.expertise },
    contacts: [],
    relevantMemories,
    relevantKnowledge,
    kinDirectory: [],
    isSubKin: false,
    isQuickSession: true,
    globalPrompt,
    userLanguage,
    workspacePath: kin.workspacePath,
  }))

  // Messages: only this session
  const sessionMessages = db
    .select({ id: messages.id, role: messages.role, content: messages.content, toolCalls: messages.toolCalls, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(asc(messages.createdAt))
    .all()

  const sessionMsgIds = sessionMessages.map((m) => m.id ?? null).filter((id): id is string => !!id)
  const sessionFilesByMessageId = sessionMsgIds.length > 0 ? await getFilesForMessages(sessionMsgIds) : new Map()

  const messagesPreviews: MessagePreview[] = sessionMessages.map((m) => ({
    role: m.role,
    content: m.content,
    hasToolCalls: m.toolCalls !== null,
    tokenEstimate:
      estimateTokens(m.content ?? '')
      + estimateTokens((m.toolCalls as string | null) ?? '')
      + estimateMessageFilesTokens(sessionFilesByMessageId.get(m.id ?? '')),
    createdAt: m.createdAt ? (m.createdAt as unknown as number) : null,
  }))

  // Tools: same resolution as processQuickMessage
  const kinToolConfig: KinToolConfig | null = kin.toolConfig ? JSON.parse(kin.toolConfig) : null
  const nativeTools = toolRegistry.resolve({ kinId, isSubKin: false })

  if (kinToolConfig?.disabledNativeTools?.length) {
    for (const name of kinToolConfig.disabledNativeTools) {
      delete nativeTools[name]
    }
  }
  const allRegistered = toolRegistry.list()
  const optInSet = new Set(kinToolConfig?.enabledOptInTools ?? [])
  for (const reg of allRegistered) {
    if (reg.defaultDisabled && !optInSet.has(reg.name)) {
      delete nativeTools[reg.name]
    }
  }
  for (const name of QUICK_SESSION_EXCLUDED_TOOLS) {
    delete nativeTools[name]
  }

  const mcpTools = await resolveMCPTools(kinId, kinToolConfig)
  const customToolDefs = await resolveCustomTools(kinId)
  const allTools = { ...nativeTools, ...mcpTools, ...customToolDefs }

  // Quick session shares the Kin's calibration factor — same model, same tools.
  const calibrationFactor = await getKinCalibrationFactor(kinId)
  return formatResult(systemPrompt, buildToolDefs(allTools), messagesPreviews, sessionMessages.length, getModelContextWindow(kin.model), null, [], null, [], [], calibrationFactor)
}
