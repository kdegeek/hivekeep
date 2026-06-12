import { describe, it, expect } from 'bun:test'
import { applyAgentNamePrefix } from '@/server/services/channel-prefix'

// Pure identity-prefix logic shared by deliverChannelResponse (transfer fallback)
// and sendToChannelAs (cross-Agent send). No DB / module mocks needed.
describe('applyAgentNamePrefix', () => {
  it('prepends "[Name] " to plain content', () => {
    expect(applyAgentNamePrefix('Hello world', 'VeilleurIA')).toBe('[VeilleurIA] Hello world')
  })

  it('is idempotent when the exact prefix is already present', () => {
    expect(applyAgentNamePrefix('[VeilleurIA] Hello', 'VeilleurIA')).toBe('[VeilleurIA] Hello')
  })

  it('does not duplicate when content already starts with [Name] (no trailing space)', () => {
    expect(applyAgentNamePrefix('[VeilleurIA]Hello', 'VeilleurIA')).toBe('[VeilleurIA]Hello')
  })

  it('still prefixes when a DIFFERENT agent name bracket is present', () => {
    expect(applyAgentNamePrefix('[OtherAgent] Hi', 'VeilleurIA')).toBe('[VeilleurIA] [OtherAgent] Hi')
  })

  it('returns empty / whitespace-only content untouched', () => {
    expect(applyAgentNamePrefix('', 'VeilleurIA')).toBe('')
    expect(applyAgentNamePrefix('   ', 'VeilleurIA')).toBe('   ')
  })

  it('returns content untouched when agent name is empty', () => {
    expect(applyAgentNamePrefix('Hello', '')).toBe('Hello')
  })
})
