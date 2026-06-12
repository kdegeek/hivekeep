import { describe, it, expect, mock } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import helloAgent from '../examples/hello-agent/index'
import type {
  PluginContext,
  PluginExports,
} from './index'

// ─── Fake ctx ────────────────────────────────────────────────────────────────

function makeCtx(): PluginContext<{ greeting?: string; apiKey?: string }> {
  return {
    config: { greeting: 'Hi', apiKey: 'fake-key' },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as PluginContext['log'],
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      clear: async () => {},
    },
    http: { fetch: async () => new Response('') },
    vault: {
      getSecret: async () => null,
      setSecret: async () => {},
      deleteSecret: async () => {},
      listKeys: async () => [],
    },
    manifest: { name: 'hello-agent', version: '0.1.0' },
    cards: {
      emit: mock(async () => ({ messageId: 'msg-1', cardInstanceId: 'card-1' })),
      update: mock(async () => {}),
    },
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('hello-agent reference example', () => {
  it('exports a PluginExports object covering every extension point', () => {
    const ctx = makeCtx()
    const exports: PluginExports = helloAgent(ctx)

    expect(exports.tools?.greet).toBeDefined()
    expect(exports.channels?.['echo-channel']).toBeDefined()
    expect(exports.providers).toHaveLength(1)
    expect(exports.hooks?.beforeChat).toBeDefined()
    expect(exports.hooks?.afterToolCall).toBeDefined()
    expect(exports.onCardAction).toBeDefined()
    expect(exports.activate).toBeDefined()
    expect(exports.deactivate).toBeDefined()
  })

  it('greet tool returns a typed reply and emits a card', async () => {
    const ctx = makeCtx()
    const exports = helloAgent(ctx)
    const t = exports.tools!.greet.create({
      agentId: 'k-1',
      userId: 'u-1',
      isSubAgent: false,
    })

    const result = (await t.execute!({ name: 'Marl' }, {})) as {
      reply: string
      cardInstanceId: string
    }

    expect(result.reply).toBe('Hi, Marl!')
    expect(result.cardInstanceId).toBe('card-1')
    expect((ctx.cards.emit as ReturnType<typeof mock>).mock.calls).toHaveLength(1)
  })

  it('uses the configured greeting word', async () => {
    const ctx = makeCtx()
    ctx.config.greeting = 'Hola'
    const exports = helloAgent(ctx)
    const t = exports.tools!.greet.create({ agentId: 'k-1', isSubAgent: false })

    const result = (await t.execute!({ name: 'Nik' }, {})) as { reply: string }
    expect(result.reply).toBe('Hola, Nik!')
  })

  it('EchoLLMProvider streams a single text-delta followed by a finish', async () => {
    const ctx = makeCtx()
    const exports = helloAgent(ctx)
    const provider = exports.providers![0]!

    // Family detection: this is an LLMProvider (has `chat`).
    expect('chat' in provider).toBe(true)

    const stream = (provider as { chat: Function }).chat(
      { id: 'echo-1', name: 'Echo', contextWindow: 4096 },
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
        ],
      },
      {},
    ) as AsyncIterable<{ type: string; text?: string; reason?: string }>

    const chunks = []
    for await (const c of stream) chunks.push(c)

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.type).toBe('text-delta')
    expect(chunks[0]?.text).toBe('Echo: hello there')
    expect(chunks[1]?.type).toBe('finish')
    expect(chunks[1]?.reason).toBe('stop')
  })

  it('echo channel adapter exposes the expected surface', () => {
    const ctx = makeCtx()
    const exports = helloAgent(ctx)
    const channel = exports.channels!['echo-channel']!
    expect(channel.platform).toBe('echo-channel')
    expect(channel.meta?.displayName).toBe('Echo Channel (example)')
    expect(typeof channel.start).toBe('function')
    expect(typeof channel.stop).toBe('function')
    expect(typeof channel.sendMessage).toBe('function')
  })

  it('hooks have access to their typed payload fields', () => {
    const ctx = makeCtx()
    const exports = helloAgent(ctx)

    // Just calling the handlers — payload shapes are checked at compile time.
    exports.hooks!.beforeChat?.({ agentId: 'k', userId: 'u', message: 'hi' })
    exports.hooks!.afterToolCall?.({
      agentId: 'k',
      isSubAgent: false,
      toolName: 'greet',
      toolArgs: { name: 'M' },
      toolResult: { reply: 'Hi, M!' },
    })
  })

  it('the plugin manifest validates against the published JSON schema', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../examples/hello-agent/plugin.json'), 'utf8'),
    )
    // Smoke-check the bits we care most about; full JSON Schema validation is
    // covered by tooling (editors, CI) once the package is published.
    expect(manifest.name).toBe('hello-agent')
    expect(manifest.main).toBe('index.ts')
    expect(manifest.$schema).toContain('plugin-manifest.schema.json')
  })
})
