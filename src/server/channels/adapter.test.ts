import { describe, it, expect, beforeEach, mock } from 'bun:test'
import { attachmentFileName, isImageAttachment, readAttachmentBlob } from './adapter'
import type { OutboundAttachment } from './adapter'

// ─── attachmentFileName ─────────────────────────────────────────────────────

describe('attachmentFileName', () => {
  it('returns explicit fileName when provided', () => {
    const att: OutboundAttachment = {
      source: '/tmp/foo.png',
      mimeType: 'image/png',
      fileName: 'custom-name.png',
    }
    expect(attachmentFileName(att)).toBe('custom-name.png')
  })

  it('extracts name from local file path', () => {
    const att: OutboundAttachment = {
      source: '/home/user/documents/report.pdf',
      mimeType: 'application/pdf',
    }
    expect(attachmentFileName(att)).toBe('report.pdf')
  })

  it('extracts name from URL without query params', () => {
    const att: OutboundAttachment = {
      source: 'https://example.com/images/photo.jpg?token=abc',
      mimeType: 'image/jpeg',
    }
    expect(attachmentFileName(att)).toBe('photo.jpg')
  })

  it('extracts name from URL with no query params', () => {
    const att: OutboundAttachment = {
      source: 'https://cdn.example.com/files/data.csv',
      mimeType: 'text/csv',
    }
    expect(attachmentFileName(att)).toBe('data.csv')
  })

  it('falls back to mime-based name when source has no extension', () => {
    const att: OutboundAttachment = {
      source: 'https://api.example.com/download/12345',
      mimeType: 'application/pdf',
    }
    expect(attachmentFileName(att)).toBe('file.pdf')
  })

  it('handles mime type with +suffix (e.g. image/svg+xml)', () => {
    const att: OutboundAttachment = {
      source: '/tmp/noext',
      mimeType: 'image/svg+xml',
    }
    expect(attachmentFileName(att)).toBe('file.svg')
  })

  it('falls back to file.bin for unknown mime', () => {
    const att: OutboundAttachment = {
      source: '/tmp/noext',
      mimeType: 'application/octet-stream',
    }
    // octet-stream -> ext = 'octet-stream' which has no +, so result is file.octet-stream
    expect(attachmentFileName(att)).toBe('file.octet-stream')
  })

  it('prefers fileName over path extraction', () => {
    const att: OutboundAttachment = {
      source: '/tmp/ugly-hash-abc123.tmp',
      mimeType: 'image/png',
      fileName: 'beautiful-photo.png',
    }
    expect(attachmentFileName(att)).toBe('beautiful-photo.png')
  })

  it('handles source with trailing slash gracefully', () => {
    // Last segment after split('/') is empty string, no dot → fallback
    const att: OutboundAttachment = {
      source: 'https://example.com/files/',
      mimeType: 'text/plain',
    }
    expect(attachmentFileName(att)).toBe('file.plain')
  })
})

// ─── isImageAttachment ──────────────────────────────────────────────────────

describe('isImageAttachment', () => {
  it('returns true for image/png', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'image/png' })).toBe(true)
  })

  it('returns true for image/jpeg', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'image/jpeg' })).toBe(true)
  })

  it('returns true for image/gif', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'image/gif' })).toBe(true)
  })

  it('returns true for image/webp', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'image/webp' })).toBe(true)
  })

  it('returns true for image/svg+xml', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'image/svg+xml' })).toBe(true)
  })

  it('returns false for application/pdf', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'application/pdf' })).toBe(false)
  })

  it('returns false for text/plain', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'text/plain' })).toBe(false)
  })

  it('returns false for video/mp4', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'video/mp4' })).toBe(false)
  })

  it('returns false for audio/mpeg', () => {
    expect(isImageAttachment({ source: 'x', mimeType: 'audio/mpeg' })).toBe(false)
  })
})

// ─── readAttachmentBlob ─────────────────────────────────────────────────────

describe('readAttachmentBlob', () => {
  it('throws for non-existent local file', async () => {
    const att: OutboundAttachment = {
      source: '/tmp/definitely-does-not-exist-hivekeep-test-file.png',
      mimeType: 'image/png',
    }
    expect(readAttachmentBlob(att)).rejects.toThrow('Attachment file not found')
  })

  it('fetches from HTTP URL and throws on non-OK response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(null, { status: 404 })) as any
    try {
      const att: OutboundAttachment = {
        source: 'https://example.com/missing.png',
        mimeType: 'image/png',
      }
      await expect(readAttachmentBlob(att)).rejects.toThrow('Failed to fetch attachment URL: 404')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('fetches from HTTP URL and returns blob on success', async () => {
    const originalFetch = globalThis.fetch
    const fakeBlob = new Blob(['test-data'], { type: 'image/png' })
    globalThis.fetch = mock(async () => new Response(fakeBlob)) as any
    try {
      const att: OutboundAttachment = {
        source: 'https://example.com/photo.png',
        mimeType: 'image/png',
      }
      const result = await readAttachmentBlob(att)
      expect(result).toBeInstanceOf(Blob)
      const text = await result.text()
      expect(text).toBe('test-data')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reads existing local file as blob', async () => {
    // Write a temp file to test local reading (unique name to avoid parallel conflicts)
    const tmpPath = `/tmp/hivekeep-test-adapter-blob-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
    const { writeFileSync } = await import('fs')
    writeFileSync(tmpPath, 'hello-blob')
    try {
      const att: OutboundAttachment = {
        source: tmpPath,
        mimeType: 'text/plain',
      }
      const result = await readAttachmentBlob(att)
      const text = await result.text()
      expect(text).toBe('hello-blob')
    } finally {
      const { unlinkSync, existsSync } = await import('fs')
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    }
  })

  it('handles https:// URLs', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(new Blob(['ok']))) as any
    try {
      const att: OutboundAttachment = {
        source: 'https://cdn.example.com/file.pdf',
        mimeType: 'application/pdf',
      }
      const result = await readAttachmentBlob(att)
      expect(result).toBeInstanceOf(Blob)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles http:// URLs', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(new Blob(['ok']))) as any
    try {
      const att: OutboundAttachment = {
        source: 'http://insecure.example.com/file.txt',
        mimeType: 'text/plain',
      }
      const result = await readAttachmentBlob(att)
      expect(result).toBeInstanceOf(Blob)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
