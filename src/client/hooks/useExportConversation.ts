import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ChatMessage } from '@/client/hooks/useChat'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString()
}

function roleLabel(role: string): string {
  switch (role) {
    case 'user':
      return 'User'
    case 'assistant':
      return 'Assistant'
    case 'system':
      return 'System'
    default:
      return role
  }
}

function messagesToMarkdown(messages: ChatMessage[], agentName: string): string {
  const lines: string[] = []
  lines.push(`# ${agentName} — Conversation Export`)
  lines.push(``)
  lines.push(`*Exported on ${new Date().toLocaleString()}*`)
  lines.push(`*${messages.length} messages*`)
  lines.push(``)
  lines.push(`---`)
  lines.push(``)

  for (const msg of messages) {
    if (msg.sourceType === 'compacting') continue

    const sender = msg.sourceName ?? roleLabel(msg.role)
    const time = formatDate(msg.createdAt)

    lines.push(`### ${sender}`)
    lines.push(`*${time}*`)
    lines.push(``)
    lines.push(msg.content)

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push(``)
      lines.push(`<details><summary>Tool calls (${msg.toolCalls.length})</summary>`)
      lines.push(``)
      for (const tc of msg.toolCalls) {
        lines.push(`**${tc.name}**`)
        lines.push('```json')
        lines.push(JSON.stringify(tc.args, null, 2))
        lines.push('```')
        if (tc.result !== undefined) {
          lines.push('Result:')
          lines.push('```json')
          lines.push(JSON.stringify(tc.result, null, 2))
          lines.push('```')
        }
      }
      lines.push(`</details>`)
    }

    lines.push(``)
    lines.push(`---`)
    lines.push(``)
  }

  return lines.join('\n')
}

function messagesToJSON(messages: ChatMessage[], agentName: string): string {
  const exportData = {
    agentName,
    exportedAt: new Date().toISOString(),
    messageCount: messages.length,
    messages: messages
      .filter((m) => m.sourceType !== 'compacting')
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        sourceName: m.sourceName,
        sourceType: m.sourceType,
        toolCalls: m.toolCalls,
        files: m.files,
        createdAt: m.createdAt,
      })),
  }
  return JSON.stringify(exportData, null, 2)
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function useExportConversation(messages: ChatMessage[], agentName: string) {
  const { t } = useTranslation()

  const exportAsMarkdown = useCallback(() => {
    if (messages.length === 0) {
      toast.info(t('chat.export.empty'))
      return
    }
    const md = messagesToMarkdown(messages, agentName)
    const filename = `${slugify(agentName)}-conversation-${new Date().toISOString().slice(0, 10)}.md`
    downloadFile(md, filename, 'text/markdown')
    toast.success(t('chat.export.success'))
  }, [messages, agentName, t])

  const exportAsJSON = useCallback(() => {
    if (messages.length === 0) {
      toast.info(t('chat.export.empty'))
      return
    }
    const json = messagesToJSON(messages, agentName)
    const filename = `${slugify(agentName)}-conversation-${new Date().toISOString().slice(0, 10)}.json`
    downloadFile(json, filename, 'application/json')
    toast.success(t('chat.export.success'))
  }, [messages, agentName, t])

  return { exportAsMarkdown, exportAsJSON }
}
