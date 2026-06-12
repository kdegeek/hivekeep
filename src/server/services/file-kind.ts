import { extname } from 'node:path'

/**
 * Shared file-type helpers for the workspace files API (Files section).
 * Extracted here because the existing equivalents are module-private
 * (filesystem-tools.ts isBinary, file-storage.ts guessMimeType, …).
 */

const EXT_TO_MIME: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  js: 'application/javascript',
  mjs: 'application/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  jsx: 'application/javascript',
  py: 'text/x-python',
  sh: 'text/x-shellscript',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  toml: 'text/toml',
}

export function guessMimeType(filename: string): string {
  const ext = extname(filename).slice(1).toLowerCase()
  return EXT_TO_MIME[ext] ?? 'application/octet-stream'
}

/** Null-byte heuristic over the first 8KB (same as the agent read_file tool). */
export function isBinary(buffer: Buffer): boolean {
  const check = buffer.subarray(0, 8192)
  for (let i = 0; i < check.length; i++) {
    if (check[i] === 0) return true
  }
  return false
}

/**
 * MIME types safe to serve with `Content-Disposition: inline` from the app
 * origin. Deliberately excludes every active format: image/svg+xml (and any
 * image/*+xml) executes scripts inline, text/html obviously does.
 */
export function isInlineSafeMime(mimeType: string): boolean {
  if (mimeType === 'application/pdf' || mimeType === 'text/plain') return true
  if (mimeType.startsWith('image/')) {
    return !mimeType.includes('+xml') && mimeType !== 'image/svg+xml'
  }
  return false
}
