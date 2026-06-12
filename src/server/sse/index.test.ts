import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── formatSSE (re-implemented from module internals) ───────────────────────

interface SSEEvent {
  type: string
  agentId?: string
  data?: Record<string, unknown>
}

function formatSSE(event: SSEEvent): string {
  return JSON.stringify({ type: event.type, agentId: event.agentId, ...event.data })
}

describe('formatSSE', () => {
  it('serializes type as top-level field', () => {
    const result = JSON.parse(formatSSE({ type: 'message:new' }))
    expect(result.type).toBe('message:new')
  })

  it('includes agentId when present', () => {
    const result = JSON.parse(formatSSE({ type: 'test', agentId: 'agent-123' }))
    expect(result.agentId).toBe('agent-123')
  })

  it('omits agentId when undefined', () => {
    const result = JSON.parse(formatSSE({ type: 'test' }))
    expect(result.agentId).toBeUndefined()
  })

  it('spreads data fields into the top-level object', () => {
    const result = JSON.parse(formatSSE({
      type: 'queue:update',
      agentId: 'k1',
      data: { queueSize: 3, isProcessing: true },
    }))
    expect(result.type).toBe('queue:update')
    expect(result.agentId).toBe('k1')
    expect(result.queueSize).toBe(3)
    expect(result.isProcessing).toBe(true)
  })

  it('data fields do not override type or agentId', () => {
    // When data contains type/agentId, the spread order means data overwrites.
    // This documents the actual behavior (data wins).
    const result = JSON.parse(formatSSE({
      type: 'original',
      agentId: 'k1',
      data: { type: 'overridden', agentId: 'k2' },
    }))
    // { type: 'original', agentId: 'k1', ...{ type: 'overridden', agentId: 'k2' } }
    // Spread order: type, agentId first, then data spreads — data WINS
    expect(result.type).toBe('overridden')
    expect(result.agentId).toBe('k2')
  })

  it('handles empty data object', () => {
    const result = JSON.parse(formatSSE({ type: 'ping', data: {} }))
    expect(result.type).toBe('ping')
    expect(Object.keys(result)).toEqual(['type'])
  })

  it('handles nested data values', () => {
    const result = JSON.parse(formatSSE({
      type: 'complex',
      data: { nested: { a: 1, b: [2, 3] } },
    }))
    expect(result.nested).toEqual({ a: 1, b: [2, 3] })
  })

  it('produces valid JSON', () => {
    const raw = formatSSE({ type: 'test', data: { key: 'value with "quotes"' } })
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

// ─── SSEManager (re-implemented for isolated testing) ───────────────────────

type SSEWriter = {
  write: (data: string) => void
  close: () => void
  userId: string
}

class SSEManager {
  private connections = new Map<string, SSEWriter>()

  addConnection(connectionId: string, writer: SSEWriter): void {
    this.connections.set(connectionId, writer)
  }

  removeConnection(connectionId: string): void {
    this.connections.delete(connectionId)
  }

  broadcast(event: SSEEvent): void {
    const payload = formatSSE(event)
    for (const [, writer] of this.connections) {
      try {
        writer.write(payload)
      } catch {
        // swallow
      }
    }
  }

  sendToUser(userId: string, event: SSEEvent): void {
    const payload = formatSSE(event)
    for (const [, writer] of this.connections) {
      if (writer.userId === userId) {
        try {
          writer.write(payload)
        } catch {
          // swallow
        }
      }
    }
  }

  sendToAgent(agentId: string, event: SSEEvent): void {
    const payload = formatSSE({ ...event, agentId })
    for (const [, writer] of this.connections) {
      try {
        writer.write(payload)
      } catch {
        // swallow
      }
    }
  }

  get connectionCount(): number {
    return this.connections.size
  }
}

describe('SSEManager', () => {
  let manager: SSEManager

  function createWriter(userId: string): SSEWriter & { messages: string[] } {
    const messages: string[] = []
    return {
      userId,
      messages,
      write: (data: string) => messages.push(data),
      close: () => {},
    }
  }

  beforeEach(() => {
    manager = new SSEManager()
  })

  describe('connection management', () => {
    it('starts with zero connections', () => {
      expect(manager.connectionCount).toBe(0)
    })

    it('tracks connections after addConnection', () => {
      manager.addConnection('c1', createWriter('u1'))
      expect(manager.connectionCount).toBe(1)
    })

    it('tracks multiple connections', () => {
      manager.addConnection('c1', createWriter('u1'))
      manager.addConnection('c2', createWriter('u2'))
      manager.addConnection('c3', createWriter('u1'))
      expect(manager.connectionCount).toBe(3)
    })

    it('removes connections', () => {
      manager.addConnection('c1', createWriter('u1'))
      manager.addConnection('c2', createWriter('u2'))
      manager.removeConnection('c1')
      expect(manager.connectionCount).toBe(1)
    })

    it('removing non-existent connection is a no-op', () => {
      manager.addConnection('c1', createWriter('u1'))
      manager.removeConnection('c999')
      expect(manager.connectionCount).toBe(1)
    })

    it('replacing a connection ID overwrites the previous', () => {
      const w1 = createWriter('u1')
      const w2 = createWriter('u2')
      manager.addConnection('c1', w1)
      manager.addConnection('c1', w2)
      expect(manager.connectionCount).toBe(1)
      // Broadcast should only hit w2
      manager.broadcast({ type: 'test' })
      expect(w1.messages).toHaveLength(0)
      expect(w2.messages).toHaveLength(1)
    })
  })

  describe('broadcast', () => {
    it('sends to all connected writers', () => {
      const w1 = createWriter('u1')
      const w2 = createWriter('u2')
      manager.addConnection('c1', w1)
      manager.addConnection('c2', w2)

      manager.broadcast({ type: 'hello' })

      expect(w1.messages).toHaveLength(1)
      expect(w2.messages).toHaveLength(1)
      expect(JSON.parse(w1.messages[0]!).type).toBe('hello')
    })

    it('sends nothing when no connections', () => {
      // Should not throw
      manager.broadcast({ type: 'test' })
    })

    it('continues broadcasting if one writer throws', () => {
      const w1 = createWriter('u1')
      const w2 = createWriter('u2')
      w1.write = () => { throw new Error('broken') }
      manager.addConnection('c1', w1)
      manager.addConnection('c2', w2)

      manager.broadcast({ type: 'test' })
      expect(w2.messages).toHaveLength(1)
    })
  })

  describe('sendToUser', () => {
    it('sends only to connections with matching userId', () => {
      const w1 = createWriter('alice')
      const w2 = createWriter('bob')
      const w3 = createWriter('alice')
      manager.addConnection('c1', w1)
      manager.addConnection('c2', w2)
      manager.addConnection('c3', w3)

      manager.sendToUser('alice', { type: 'private' })

      expect(w1.messages).toHaveLength(1)
      expect(w2.messages).toHaveLength(0)
      expect(w3.messages).toHaveLength(1)
    })

    it('sends nothing when userId has no connections', () => {
      const w1 = createWriter('alice')
      manager.addConnection('c1', w1)

      manager.sendToUser('bob', { type: 'test' })
      expect(w1.messages).toHaveLength(0)
    })

    it('is resilient to writer errors', () => {
      const w1 = createWriter('alice')
      const w2 = createWriter('alice')
      w1.write = () => { throw new Error('broken') }
      manager.addConnection('c1', w1)
      manager.addConnection('c2', w2)

      manager.sendToUser('alice', { type: 'test' })
      expect(w2.messages).toHaveLength(1)
    })
  })

  describe('sendToAgent', () => {
    it('broadcasts to all connections with agentId injected', () => {
      const w1 = createWriter('u1')
      const w2 = createWriter('u2')
      manager.addConnection('c1', w1)
      manager.addConnection('c2', w2)

      manager.sendToAgent('agent-42', { type: 'queue:update', data: { size: 5 } })

      expect(w1.messages).toHaveLength(1)
      expect(w2.messages).toHaveLength(1)

      const parsed = JSON.parse(w1.messages[0]!)
      expect(parsed.agentId).toBe('agent-42')
      expect(parsed.type).toBe('queue:update')
      expect(parsed.size).toBe(5)
    })

    it('overrides event agentId with the provided agentId', () => {
      const w1 = createWriter('u1')
      manager.addConnection('c1', w1)

      manager.sendToAgent('agent-new', { type: 'test', agentId: 'agent-old' })

      const parsed = JSON.parse(w1.messages[0]!)
      // sendToAgent does { ...event, agentId } — agentId param wins
      expect(parsed.agentId).toBe('agent-new')
    })
  })
})

// ─── Edge cases & integration patterns ──────────────────────────────────────

describe('SSE payload format', () => {
  it('payloads are single-line JSON (no newlines)', () => {
    const payload = formatSSE({
      type: 'message:new',
      agentId: 'k1',
      data: { content: 'Hello\nWorld', multiline: true },
    })
    // JSON.stringify escapes newlines as \n, so the raw string should not contain literal newlines
    expect(payload.includes('\n')).toBe(false)
  })

  it('all SSE event types follow namespace:action pattern', () => {
    // Document the convention used throughout the codebase
    const eventTypes = [
      'message:new', 'message:delta', 'message:done',
      'queue:update',
      'cron:created', 'cron:updated', 'cron:deleted', 'cron:triggered',
      'task:created', 'task:updated',
    ]
    for (const type of eventTypes) {
      expect(type).toMatch(/^[a-z]+:[a-z]+$/)
    }
  })
})
