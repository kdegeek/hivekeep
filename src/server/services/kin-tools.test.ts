import { describe, test, expect } from 'bun:test'
import { buildKinToolBuckets } from './kin-tools'

describe('buildKinToolBuckets', () => {
  test('returns empty buckets when nothing is registered', () => {
    const result = buildKinToolBuckets({
      registered: [],
      pluginGroups: [],
      toolConfig: null,
    })
    expect(result.nativeTools).toEqual([])
    expect(result.pluginTools).toEqual([])
  })

  test('groups native tools by the domain declared at registration', () => {
    const result = buildKinToolBuckets({
      registered: [
        { name: 'search_web', domain: 'search', defaultDisabled: false },
        { name: 'read_file', domain: 'filesystem', defaultDisabled: false },
        { name: 'write_file', domain: 'filesystem', defaultDisabled: false },
      ],
      pluginGroups: [],
      toolConfig: null,
    })
    const byDomain = new Map(result.nativeTools.map((g) => [g.domain, g]))
    expect(byDomain.get('search')!.tools.map((t) => t.name)).toEqual(['search_web'])
    expect(byDomain.get('filesystem')!.tools.map((t) => t.name).sort()).toEqual(['read_file', 'write_file'])
    expect(result.pluginTools).toEqual([])
  })

  test('extracts plugin tools into their own group keyed by plugin name', () => {
    const result = buildKinToolBuckets({
      registered: [
        { name: 'search_web', domain: 'search', defaultDisabled: false },
        { name: 'plugin_claude-code_claude_code_run', domain: 'plugins', defaultDisabled: true },
        { name: 'plugin_twilio-sms_send_sms', domain: 'plugins', defaultDisabled: true },
      ],
      pluginGroups: [
        { pluginName: 'claude-code', toolNames: ['plugin_claude-code_claude_code_run'] },
        { pluginName: 'twilio-sms', toolNames: ['plugin_twilio-sms_send_sms'] },
      ],
      toolConfig: null,
    })

    // Plugin tools do not leak into native groups, even though they are
    // also present in the registry list.
    expect(result.nativeTools.flatMap((g) => g.tools.map((t) => t.name))).toEqual(['search_web'])

    const byPlugin = new Map(result.pluginTools.map((g) => [g.pluginName, g]))
    expect(byPlugin.has('claude-code')).toBe(true)
    expect(byPlugin.get('claude-code')!.tools).toEqual([
      { name: 'plugin_claude-code_claude_code_run', enabled: false, defaultDisabled: true },
    ])
    expect(byPlugin.get('twilio-sms')!.tools).toEqual([
      { name: 'plugin_twilio-sms_send_sms', enabled: false, defaultDisabled: true },
    ])
  })

  test('plugin tools are opt-in: enabled only when listed in enabledOptInTools', () => {
    const result = buildKinToolBuckets({
      registered: [
        { name: 'plugin_claude-code_claude_code_run', domain: 'plugins', defaultDisabled: true },
        { name: 'plugin_claude-code_other_tool', domain: 'plugins', defaultDisabled: true },
      ],
      pluginGroups: [
        { pluginName: 'claude-code', toolNames: ['plugin_claude-code_claude_code_run', 'plugin_claude-code_other_tool'] },
      ],
      toolConfig: {
        disabledNativeTools: [],
        mcpAccess: {},
        enabledOptInTools: ['plugin_claude-code_claude_code_run'],
      },
    })
    const tools = result.pluginTools[0]!.tools
    expect(tools.find((t) => t.name === 'plugin_claude-code_claude_code_run')!.enabled).toBe(true)
    expect(tools.find((t) => t.name === 'plugin_claude-code_other_tool')!.enabled).toBe(false)
  })

  test('drops plugin groups whose tools are no longer in the registry', () => {
    const result = buildKinToolBuckets({
      registered: [], // registry has been cleared (plugin disabled, unload, etc.)
      pluginGroups: [{ pluginName: 'claude-code', toolNames: ['plugin_claude-code_claude_code_run'] }],
      toolConfig: null,
    })
    expect(result.pluginTools).toEqual([])
  })

  test('honors disabledNativeTools for non-opt-in tools', () => {
    const result = buildKinToolBuckets({
      registered: [
        { name: 'search_web', domain: 'search', defaultDisabled: false },
        { name: 'read_file', domain: 'filesystem', defaultDisabled: false },
      ],
      pluginGroups: [],
      toolConfig: {
        disabledNativeTools: ['read_file'],
        mcpAccess: {},
        enabledOptInTools: [],
      },
    })
    const all = result.nativeTools.flatMap((g) => g.tools)
    expect(all.find((t) => t.name === 'search_web')!.enabled).toBe(true)
    expect(all.find((t) => t.name === 'read_file')!.enabled).toBe(false)
  })
})
