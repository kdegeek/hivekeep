import type { LucideIcon } from 'lucide-react'
import {
  File,
  FileText,
  FileJson,
  FileCode,
  FileImage,
  FileArchive,
  FileAudio,
  FileVideo,
  FileSpreadsheet,
  FileTerminal,
} from 'lucide-react'

/**
 * Shared filename → lucide icon mapping for the Files section, chat file
 * chips and anywhere else a workspace file is displayed (files.md § 3.3).
 */

const CODE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'lua', 'r', 'vue', 'svelte',
  'html', 'css', 'scss', 'less', 'sql', 'graphql', 'xml', 'yaml', 'yml', 'toml', 'ini',
])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'])
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a'])
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv'])
const TEXT_EXTS = new Set(['md', 'txt', 'log', 'rst', 'adoc'])
const SHEET_EXTS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'ods'])
const SHELL_EXTS = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'])

export function getFileIcon(name: string): LucideIcon {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (ext === 'json') return FileJson
  if (CODE_EXTS.has(ext)) return FileCode
  if (IMAGE_EXTS.has(ext)) return FileImage
  if (ARCHIVE_EXTS.has(ext)) return FileArchive
  if (AUDIO_EXTS.has(ext)) return FileAudio
  if (VIDEO_EXTS.has(ext)) return FileVideo
  if (TEXT_EXTS.has(ext)) return FileText
  if (SHEET_EXTS.has(ext)) return FileSpreadsheet
  if (SHELL_EXTS.has(ext)) return FileTerminal
  return File
}

/** Human-readable byte size (e.g. "2.5 KB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes
  let unit = 'B'
  for (const u of units) {
    if (value < 1024) break
    value /= 1024
    unit = u
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${unit}`
}
