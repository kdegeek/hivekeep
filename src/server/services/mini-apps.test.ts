import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { resolve, join, extname } from 'path'

// ─── Pure helper re-implementations for isolated testing ─────────────────────
// These mirror the private helpers in mini-apps.ts — tested for correctness.

function validatePath(base: string, relativePath: string): string {
  const absoluteBase = resolve(base)
  const resolved = resolve(base, relativePath)
  if (!resolved.startsWith(absoluteBase + '/') && resolved !== absoluteBase) {
    throw new Error('Invalid path: path traversal detected')
  }
  return resolved
}

function guessMimeType(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  const map: Record<string, string> = {
    html: 'text/html', htm: 'text/html',
    css: 'text/css', js: 'application/javascript',
    json: 'application/json', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
    txt: 'text/plain', md: 'text/markdown', xml: 'application/xml',
    mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf',
  }
  return map[ext] ?? 'application/octet-stream'
}

function appDir(agentId: string, appId: string): string {
  return join('/data/mini-apps', agentId, appId)
}

function snapshotDir(agentId: string, appId: string, version: number): string {
  return join('/data/mini-apps', agentId, appId, '.snapshots', String(version))
}

// ─── validatePath ───────────────────────────────────────────────────────────

describe('validatePath', () => {
  const base = '/data/mini-apps/kin1/app1'

  it('resolves a simple relative path', () => {
    const result = validatePath(base, 'index.html')
    expect(result).toBe(resolve(base, 'index.html'))
  })

  it('resolves nested paths', () => {
    const result = validatePath(base, 'src/components/App.tsx')
    expect(result).toBe(resolve(base, 'src/components/App.tsx'))
  })

  it('allows the base directory itself', () => {
    const result = validatePath(base, '.')
    expect(result).toBe(resolve(base))
  })

  it('blocks path traversal with ../', () => {
    expect(() => validatePath(base, '../../../etc/passwd')).toThrow('path traversal')
  })

  it('blocks path traversal with ../ that escapes base', () => {
    expect(() => validatePath(base, '../../other-agent/app/secret.html')).toThrow('path traversal')
  })

  it('blocks absolute paths that escape base', () => {
    expect(() => validatePath(base, '/etc/passwd')).toThrow('path traversal')
  })

  it('allows ../ that stays within base', () => {
    // src/../index.html resolves to base/index.html which is inside base
    const result = validatePath(base, 'src/../index.html')
    expect(result).toBe(resolve(base, 'index.html'))
  })

  it('blocks path that resolves to base prefix (e.g. /data/mini-apps/kin1/app1-evil)', () => {
    // This tests the "+ '/'" guard: resolved must start with base + "/" or equal base
    const evilBase = '/data/mini-apps/kin1/app1'
    // "../app1-evil" from base resolves to /data/mini-apps/kin1/app1-evil
    // which starts with the base string but NOT base + "/"
    expect(() => validatePath(evilBase, '../app1-evil/index.html')).toThrow('path traversal')
  })

  it('handles empty relative path', () => {
    const result = validatePath(base, '')
    expect(result).toBe(resolve(base))
  })

  it('handles deeply nested traversal attempt', () => {
    expect(() => validatePath(base, 'a/b/c/../../../../../../../../etc/shadow')).toThrow('path traversal')
  })

  it('handles paths with double slashes', () => {
    const result = validatePath(base, 'src//index.html')
    expect(result).toBe(resolve(base, 'src//index.html'))
    expect(result.startsWith(resolve(base) + '/')).toBe(true)
  })

  it('handles dotfiles within base', () => {
    const result = validatePath(base, '.env')
    expect(result).toBe(resolve(base, '.env'))
  })

  it('handles paths with spaces', () => {
    const result = validatePath(base, 'my folder/my file.html')
    expect(result).toBe(resolve(base, 'my folder/my file.html'))
  })
})

// ─── guessMimeType ──────────────────────────────────────────────────────────

describe('guessMimeType', () => {
  it('returns text/html for .html', () => {
    expect(guessMimeType('index.html')).toBe('text/html')
  })

  it('returns text/html for .htm', () => {
    expect(guessMimeType('page.htm')).toBe('text/html')
  })

  it('returns text/css for .css', () => {
    expect(guessMimeType('styles.css')).toBe('text/css')
  })

  it('returns application/javascript for .js', () => {
    expect(guessMimeType('app.js')).toBe('application/javascript')
  })

  it('returns application/json for .json', () => {
    expect(guessMimeType('data.json')).toBe('application/json')
  })

  it('returns image/svg+xml for .svg', () => {
    expect(guessMimeType('logo.svg')).toBe('image/svg+xml')
  })

  it('returns image/png for .png', () => {
    expect(guessMimeType('icon.png')).toBe('image/png')
  })

  it('returns image/jpeg for .jpg', () => {
    expect(guessMimeType('photo.jpg')).toBe('image/jpeg')
  })

  it('returns image/jpeg for .jpeg', () => {
    expect(guessMimeType('photo.jpeg')).toBe('image/jpeg')
  })

  it('returns image/gif for .gif', () => {
    expect(guessMimeType('anim.gif')).toBe('image/gif')
  })

  it('returns image/webp for .webp', () => {
    expect(guessMimeType('photo.webp')).toBe('image/webp')
  })

  it('returns image/x-icon for .ico', () => {
    expect(guessMimeType('favicon.ico')).toBe('image/x-icon')
  })

  it('returns font/woff for .woff', () => {
    expect(guessMimeType('font.woff')).toBe('font/woff')
  })

  it('returns font/woff2 for .woff2', () => {
    expect(guessMimeType('font.woff2')).toBe('font/woff2')
  })

  it('returns font/ttf for .ttf', () => {
    expect(guessMimeType('font.ttf')).toBe('font/ttf')
  })

  it('returns text/plain for .txt', () => {
    expect(guessMimeType('readme.txt')).toBe('text/plain')
  })

  it('returns text/markdown for .md', () => {
    expect(guessMimeType('README.md')).toBe('text/markdown')
  })

  it('returns application/xml for .xml', () => {
    expect(guessMimeType('data.xml')).toBe('application/xml')
  })

  it('returns audio/mpeg for .mp3', () => {
    expect(guessMimeType('song.mp3')).toBe('audio/mpeg')
  })

  it('returns video/mp4 for .mp4', () => {
    expect(guessMimeType('video.mp4')).toBe('video/mp4')
  })

  it('returns application/pdf for .pdf', () => {
    expect(guessMimeType('doc.pdf')).toBe('application/pdf')
  })

  it('returns application/octet-stream for unknown extensions', () => {
    expect(guessMimeType('file.xyz')).toBe('application/octet-stream')
    expect(guessMimeType('archive.tar.gz')).toBe('application/octet-stream')
    expect(guessMimeType('binary.bin')).toBe('application/octet-stream')
  })

  it('returns application/octet-stream for files with no extension', () => {
    expect(guessMimeType('Makefile')).toBe('application/octet-stream')
    expect(guessMimeType('LICENSE')).toBe('application/octet-stream')
  })

  it('is case-insensitive for extensions', () => {
    expect(guessMimeType('FILE.HTML')).toBe('text/html')
    expect(guessMimeType('IMAGE.PNG')).toBe('image/png')
    expect(guessMimeType('style.CSS')).toBe('text/css')
  })

  it('handles nested path with extension', () => {
    expect(guessMimeType('src/components/App.tsx')).toBe('application/octet-stream')
    expect(guessMimeType('public/assets/logo.svg')).toBe('image/svg+xml')
  })

  it('handles dotfiles', () => {
    // .env has extension "env" which is not in the map
    expect(guessMimeType('.env')).toBe('application/octet-stream')
    expect(guessMimeType('.gitignore')).toBe('application/octet-stream')
  })

  it('handles files with multiple dots', () => {
    expect(guessMimeType('app.min.js')).toBe('application/javascript')
    expect(guessMimeType('style.module.css')).toBe('text/css')
    expect(guessMimeType('image.thumb.png')).toBe('image/png')
  })
})

// ─── appDir ─────────────────────────────────────────────────────────────────

describe('appDir', () => {
  it('constructs correct path from agentId and appId', () => {
    expect(appDir('agent-123', 'app-456')).toBe('/data/mini-apps/agent-123/app-456')
  })

  it('handles UUID-style IDs', () => {
    const result = appDir('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'f0e1d2c3-b4a5-6789-0123-456789abcdef')
    expect(result).toContain('a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(result).toContain('f0e1d2c3-b4a5-6789-0123-456789abcdef')
  })
})

// ─── snapshotDir ────────────────────────────────────────────────────────────

describe('snapshotDir', () => {
  it('constructs correct snapshot path', () => {
    const result = snapshotDir('agent-1', 'app-1', 1)
    expect(result).toBe('/data/mini-apps/agent-1/app-1/.snapshots/1')
  })

  it('increments version in path', () => {
    const v1 = snapshotDir('agent-1', 'app-1', 1)
    const v5 = snapshotDir('agent-1', 'app-1', 5)
    expect(v1).not.toBe(v5)
    expect(v5).toContain('/5')
  })
})

// ─── MiniAppSummary serialization ───────────────────────────────────────────

describe('serializeApp (logic)', () => {
  // Test the serialization logic inline since serializeApp is not exported.
  // We verify the expected output shape and timestamp conversion.

  function serializeApp(
    row: {
      id: string
      agentId: string
      name: string
      slug: string
      description: string | null
      icon: string | null
      entryFile: string
      hasBackend: boolean
      isActive: boolean
      version: number
      createdAt: Date
      updatedAt: Date
    },
    agentName: string,
    agentAvatarUrl: string | null,
  ) {
    return {
      id: row.id,
      agentId: row.agentId,
      agentName,
      agentAvatarUrl,
      name: row.name,
      slug: row.slug,
      description: row.description,
      icon: row.icon,
      entryFile: row.entryFile,
      hasBackend: row.hasBackend,
      isActive: row.isActive,
      version: row.version,
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    }
  }

  it('converts dates to timestamps', () => {
    const now = new Date('2026-01-15T12:00:00Z')
    const result = serializeApp(
      {
        id: 'app-1',
        agentId: 'agent-1',
        name: 'My App',
        slug: 'my-app',
        description: 'A test app',
        icon: '🎮',
        entryFile: 'index.html',
        hasBackend: false,
        isActive: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      'TestAgent',
      null,
    )

    expect(result.createdAt).toBe(now.getTime())
    expect(result.updatedAt).toBe(now.getTime())
    expect(typeof result.createdAt).toBe('number')
  })

  it('includes all fields from row', () => {
    const now = new Date()
    const result = serializeApp(
      {
        id: 'app-id',
        agentId: 'agent-id',
        name: 'Test',
        slug: 'test',
        description: null,
        icon: null,
        entryFile: 'index.html',
        hasBackend: true,
        isActive: false,
        version: 3,
        createdAt: now,
        updatedAt: now,
      },
      'AgentName',
      'https://example.com/avatar.png',
    )

    expect(result.id).toBe('app-id')
    expect(result.agentId).toBe('agent-id')
    expect(result.agentName).toBe('AgentName')
    expect(result.agentAvatarUrl).toBe('https://example.com/avatar.png')
    expect(result.name).toBe('Test')
    expect(result.slug).toBe('test')
    expect(result.description).toBeNull()
    expect(result.icon).toBeNull()
    expect(result.entryFile).toBe('index.html')
    expect(result.hasBackend).toBe(true)
    expect(result.isActive).toBe(false)
    expect(result.version).toBe(3)
  })

  it('handles null agentAvatarUrl', () => {
    const now = new Date()
    const result = serializeApp(
      {
        id: 'a', agentId: 'k', name: 'N', slug: 's',
        description: null, icon: null, entryFile: 'index.html',
        hasBackend: false, isActive: true, version: 1,
        createdAt: now, updatedAt: now,
      },
      'Agent',
      null,
    )
    expect(result.agentAvatarUrl).toBeNull()
  })
})
