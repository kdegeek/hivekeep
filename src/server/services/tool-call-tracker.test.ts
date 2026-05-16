import { describe, it, expect, beforeEach, mock } from 'bun:test'

mock.module('@/server/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const {
  noteCall,
  forgetTask,
  readFileSignature,
  grepSignature,
  recordReadPath,
  hasReadPath,
  _resetTracker,
  _peek,
} = await import('./tool-call-tracker')

beforeEach(() => {
  _resetTracker()
})

describe('readFileSignature', () => {
  it('normalises default offset and limit', () => {
    expect(readFileSignature({ path: 'a.ts' })).toBe(readFileSignature({ path: 'a.ts', offset: 1 }))
  })

  it('differentiates by path, offset, and limit', () => {
    const a = readFileSignature({ path: 'a.ts', offset: 10, limit: 50 })
    const b = readFileSignature({ path: 'a.ts', offset: 11, limit: 50 })
    const c = readFileSignature({ path: 'b.ts', offset: 10, limit: 50 })
    const d = readFileSignature({ path: 'a.ts', offset: 10, limit: 51 })
    expect(new Set([a, b, c, d]).size).toBe(4)
  })
})

describe('grepSignature', () => {
  it('hashes pattern + path + glob + output_mode + context flags', () => {
    const base = { pattern: 'foo', path: 'src', glob: '*.ts', output_mode: 'content' }
    const a = grepSignature(base)
    const b = grepSignature({ ...base, pattern: 'bar' })
    const c = grepSignature({ ...base, path: 'lib' })
    const d = grepSignature({ ...base, output_mode: 'files_with_matches' })
    expect(new Set([a, b, c, d]).size).toBe(4)
  })

  it('treats missing flags as defaults (idempotent calls hash the same)', () => {
    const a = grepSignature({ pattern: 'foo' })
    const b = grepSignature({ pattern: 'foo', output_mode: 'content', path: '.' })
    expect(a).toBe(b)
  })
})

describe('noteCall', () => {
  it('returns 0 the first time, then increments', () => {
    const sig = 'read|a.ts|1|0'
    expect(noteCall('task-1', 'read_file', sig).previousCallCount).toBe(0)
    expect(noteCall('task-1', 'read_file', sig).previousCallCount).toBe(1)
    expect(noteCall('task-1', 'read_file', sig).previousCallCount).toBe(2)
  })

  it('is per-task — same signature in another task starts fresh', () => {
    const sig = readFileSignature({ path: 'a.ts' })
    noteCall('task-1', 'read_file', sig)
    expect(noteCall('task-2', 'read_file', sig).previousCallCount).toBe(0)
  })

  it('no-ops when taskId is undefined (main Kin context)', () => {
    const sig = readFileSignature({ path: 'a.ts' })
    expect(noteCall(undefined, 'read_file', sig).previousCallCount).toBe(0)
    expect(noteCall(undefined, 'read_file', sig).previousCallCount).toBe(0)
  })

  it('different signatures inside the same task do not collide', () => {
    const a = readFileSignature({ path: 'a.ts' })
    const b = readFileSignature({ path: 'b.ts' })
    expect(noteCall('task-1', 'read_file', a).previousCallCount).toBe(0)
    expect(noteCall('task-1', 'read_file', b).previousCallCount).toBe(0)
    expect(noteCall('task-1', 'read_file', a).previousCallCount).toBe(1)
  })
})

describe('forgetTask', () => {
  it('clears state so subsequent calls start fresh', () => {
    const sig = readFileSignature({ path: 'a.ts' })
    noteCall('task-1', 'read_file', sig)
    expect(_peek('task-1')?.size).toBe(1)
    forgetTask('task-1')
    expect(_peek('task-1')).toBeUndefined()
    expect(noteCall('task-1', 'read_file', sig).previousCallCount).toBe(0)
  })

  it('does not touch other tasks', () => {
    const sig = readFileSignature({ path: 'a.ts' })
    noteCall('task-1', 'read_file', sig)
    noteCall('task-2', 'read_file', sig)
    forgetTask('task-1')
    expect(_peek('task-2')?.size).toBe(1)
  })

  it('clears recorded read paths too', () => {
    recordReadPath('task-1', 'src/foo.ts')
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(true)
    forgetTask('task-1')
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(false)
  })
})

describe('read-before-edit tracking (recordReadPath / hasReadPath)', () => {
  it('returns false when the task has not read the path', () => {
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(false)
  })

  it('returns true after recordReadPath', () => {
    recordReadPath('task-1', 'src/foo.ts')
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(true)
  })

  it('is idempotent — recording twice is a no-op', () => {
    recordReadPath('task-1', 'src/foo.ts')
    recordReadPath('task-1', 'src/foo.ts')
    expect(_peek('task-1')).toBeDefined()
    // No assertion on exact size — the readPaths Set is internal — but the
    // double-call must not throw or behave differently.
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(true)
  })

  it('is per-task isolated', () => {
    recordReadPath('task-1', 'src/foo.ts')
    expect(hasReadPath('task-2', 'src/foo.ts')).toBe(false)
  })

  it("returns true when taskId is undefined (main Kin bypasses the guard)", () => {
    // Main-Kin context has the user in the loop; the read-before-edit
    // guard is a sub-Kin safeguard only.
    expect(hasReadPath(undefined, 'anything.ts')).toBe(true)
  })

  it('recordReadPath with no taskId is a no-op (no bucket created)', () => {
    recordReadPath(undefined, 'whatever.ts')
    expect(_peek('whatever.ts')).toBeUndefined()
  })

  it('distinguishes paths exactly (no normalisation)', () => {
    recordReadPath('task-1', 'src/foo.ts')
    expect(hasReadPath('task-1', 'src/foo.ts')).toBe(true)
    expect(hasReadPath('task-1', './src/foo.ts')).toBe(false)
    expect(hasReadPath('task-1', '/abs/src/foo.ts')).toBe(false)
  })
})
