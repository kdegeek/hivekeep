/**
 * Diagnostic: render a representative main-Agent system prompt and print it,
 * so we can read the real artifact end-to-end (coherence, grammar, leaks).
 * Not wired anywhere — run with `bun scripts/dump-system-prompt.ts`.
 */
import { buildSystemPrompt, joinSystemPrompt } from '@/server/services/prompt-builder'

const now = Date.now()
const params: any = {
  agent: {
    name: 'Atlas',
    slug: 'atlas',
    role: 'the household operations lead',
    character: 'Calm, dry wit, gets to the point. Speaks like a trusted chief of staff.',
    expertise: 'Scheduling, travel logistics, home maintenance, light research.',
    kind: 'standard',
  },
  globalPrompt: 'Never share secrets. Default to metric units. Keep replies under 6 sentences unless asked.',
  contacts: [
    { id: 'c1', displayName: 'Niko', firstName: 'Niko', lastName: null, nicknames: ['boss'], linkedUserName: 'Niko', identifierSummary: 'niko@example.com' },
    { id: 'c2', displayName: 'Marie', firstName: 'Marie', lastName: null, nicknames: [], identifierSummary: 'telegram' },
  ],
  relevantMemories: [
    { category: 'preference', content: 'Niko prefers window seats on flights.', subject: 'travel', importance: 6, score: 0.92, updatedAt: new Date(now - 86400000) },
    { category: 'fact', content: 'The boiler service contract renews in October.', subject: 'home', importance: 8, score: 0.71, updatedAt: new Date(now - 8640000000) },
  ],
  relevantKnowledge: [],
  agentDirectory: [
    { slug: 'sage', name: 'Sage', role: 'research specialist' },
    { slug: 'pixel', name: 'Pixel', role: 'design & images' },
  ],
  currentSpeaker: { firstName: 'Niko', lastName: null, pseudonym: 'Niko', role: 'owner', contactId: 'c1', contactNotes: ['Owner.'], agentNotes: ['Likes terse answers.'], userNotes: [] },
  participants: [{ name: 'Niko', platform: 'web', messageCount: 12, lastSeenAt: new Date(now) }],
  compactingSummaries: [
    { summary: 'Earlier: planned a trip to Lisbon, booked flights, discussed the boiler.', firstMessageAt: new Date(now - 9000000000), lastMessageAt: new Date(now - 8000000000), depth: 0 },
  ],
  conversationState: { visibleMessageCount: 12, totalMessageCount: 40, hasCompactedHistory: true, oldestVisibleMessageAt: new Date(now - 100000000) },
  currentMessageSource: { platform: 'web' },
  userLanguage: 'en',
  mcpTools: [],
  activeChannels: [{ platform: 'telegram', name: 'Family group' }],
  workspacePath: undefined,
  activeProject: undefined,
  taskTodos: [],
  isSubAgent: false,
  toolsEnabled: true,
}

const seg = buildSystemPrompt(params)
console.log('========== STABLE (' + seg.stable.length + ' chars) ==========\n')
console.log(seg.stable)
console.log('\n\n========== VOLATILE (' + seg.volatile.length + ' chars) ==========\n')
console.log(seg.volatile)
console.log('\n\n========== JOINED LENGTH: ' + joinSystemPrompt(seg).length + ' chars ==========')
