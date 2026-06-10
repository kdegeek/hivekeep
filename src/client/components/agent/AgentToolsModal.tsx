import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Pencil, Wrench } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Badge } from '@/client/components/ui/badge'
import { ToolDomainBadge } from '@/client/components/common/ToolDomainBadge'
import { getToolDomain, getToolDomainMeta } from '@/client/lib/tool-domain-lookup'
import type { ToolDomain } from '@/shared/types'
import type { AgentToolInfo } from '@/client/hooks/useAgentTools'

interface AgentToolsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentName: string
  tools: AgentToolInfo[]
  /** Variant label — quick sessions expose a reduced set. */
  isQuickSession?: boolean
  /** Opens the agent's tools management (the Agent form's Tools tab). */
  onEditTools?: () => void
}

/**
 * Read-only listing of every tool currently exposed to the agent, grouped by
 * domain — opened from the composer's tools badge. The edit button hands off
 * to the agent's tools management.
 */
export function AgentToolsModal({ open, onOpenChange, agentName, tools, isQuickSession, onEditTools }: AgentToolsModalProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? tools.filter((tool) => tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q))
      : tools
    const byDomain = new Map<string, AgentToolInfo[]>()
    for (const tool of filtered) {
      const domain = getToolDomain(tool.name)
      const list = byDomain.get(domain) ?? []
      list.push(tool)
      byDomain.set(domain, list)
    }
    const labelOf = (domain: string): string => {
      const meta = getToolDomainMeta(domain)
      return meta.labelKey ? t(meta.labelKey) : (meta.label ?? domain)
    }
    return [...byDomain.entries()].sort((a, b) => labelOf(a[0]).localeCompare(labelOf(b[0])))
  }, [tools, query, t])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="panel" size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="size-4 text-primary" />
            {t('chat.toolsModal.title', { name: agentName, defaultValue: '{{name}} — tools' })}
            <Badge variant="secondary" className="ml-1">{tools.length}</Badge>
          </DialogTitle>
          <DialogDescription>
            {isQuickSession
              ? t('chat.toolsModal.descriptionQuick', 'Tools exposed in this quick session (session-restricted tools like tasks, crons and inter-agent messaging are excluded).')
              : t('chat.toolsModal.description', 'Every tool currently exposed to this agent, grouped by domain.')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search', 'Search')}
              className="pl-8"
            />
          </div>

          {groups.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.noResults', 'No results')}</p>
          )}

          {groups.map(([domain, domainTools]) => (
            <div key={domain}>
              <div className="mb-1.5 flex items-center gap-2">
                <ToolDomainBadge domain={domain as ToolDomain} />
                <span className="text-xs text-muted-foreground/60">({domainTools.length})</span>
              </div>
              <div className="overflow-hidden rounded-lg border border-border">
                {domainTools.map((tool, i) => (
                  <div key={tool.name} className={`px-3 py-2 ${i > 0 ? 'border-t border-border/50' : ''}`}>
                    <p className="font-mono text-xs font-medium">{tool.name}</p>
                    {tool.description && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </DialogBody>

        <DialogFooter>
          {onEditTools && (
            <Button variant="outline" onClick={() => { onOpenChange(false); onEditTools() }}>
              <Pencil className="size-4" />
              {t('chat.toolsModal.edit', 'Edit tools')}
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>{t('common.close', 'Close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
