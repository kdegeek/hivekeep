import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Circle, Loader2, Sparkles, X } from 'lucide-react'
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
import { Label } from '@/client/components/ui/label'
import { Checkbox } from '@/client/components/ui/checkbox'
import { Progress } from '@/client/components/ui/progress'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { ModelPicker, modelPickerValue } from '@/client/components/common/ModelPicker'
import { api, toastError } from '@/client/lib/api'
import { useSSE } from '@/client/hooks/useSSE'
import { cn } from '@/client/lib/utils'
import type { ProviderModel } from '@/client/hooks/useModels'
import type { AgentKind } from '@/shared/types'

export interface BulkRegenAgent {
  id: string
  name: string
  role: string
  avatarUrl: string | null
  kind: AgentKind
}

type RowStatus = 'pending' | 'running' | 'ok' | 'error'
type Phase = 'select' | 'running' | 'done'

interface BulkAvatarJobSnapshot {
  id: string
  status: 'running' | 'done'
  agentIds: string[]
  total: number
  done: number
  succeeded: number
  failed: number
  currentAgentId: string | null
  results: { agentId: string; name: string; ok: boolean; error?: string }[]
}

interface BulkAvatarRegenModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: BulkRegenAgent[]
  imageModels: ProviderModel[]
}

export function BulkAvatarRegenModal({ open, onOpenChange, agents, imageModels }: BulkAvatarRegenModalProps) {
  const { t } = useTranslation()

  const [phase, setPhase] = useState<Phase>('select')
  const phaseRef = useRef(phase)
  useEffect(() => { phaseRef.current = phase }, [phase])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [selectedModelValue, setSelectedModelValue] = useState('')

  const [rowStatus, setRowStatus] = useState<Map<string, RowStatus>>(new Map())
  const [errors, setErrors] = useState<Map<string, string>>(new Map())
  const [prog, setProg] = useState({ done: 0, total: 0, succeeded: 0, failed: 0 })

  const hasImageModels = imageModels.length > 0

  const selectedImageModel = selectedModelValue
    ? (() => {
        const sep = selectedModelValue.indexOf(':')
        return { providerId: selectedModelValue.slice(0, sep), modelId: selectedModelValue.slice(sep + 1) }
      })()
    : undefined

  // Seed the model picker with the saved default image model once, on open.
  useEffect(() => {
    if (!open || !hasImageModels || selectedModelValue) return
    const first = imageModels[0]
    setSelectedModelValue(first ? `${first.providerId}:${first.id}` : '')
    api
      .get<{ defaultImageModel: string | null; defaultImageProviderId: string | null }>('/settings/default-models')
      .then((data) => {
        if (!data.defaultImageModel || !data.defaultImageProviderId) return
        const match = imageModels.find(
          (m) => m.id === data.defaultImageModel && m.providerId === data.defaultImageProviderId,
        )
        if (match) setSelectedModelValue(`${match.providerId}:${match.id}`)
      })
      .catch(() => {})
  }, [open, hasImageModels, imageModels, selectedModelValue])

  // On open: reset to the selection screen, OR hydrate live progress if a bulk
  // job is already running (started here earlier, or from another device).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .get<{ job: BulkAvatarJobSnapshot | null }>('/settings/avatars/bulk-regenerate')
      .then(({ job }) => {
        if (cancelled) return
        if (job && job.status === 'running') {
          const rs = new Map<string, RowStatus>()
          for (const id of job.agentIds) rs.set(id, 'pending')
          for (const r of job.results) rs.set(r.agentId, r.ok ? 'ok' : 'error')
          if (job.currentAgentId) rs.set(job.currentAgentId, 'running')
          const errs = new Map<string, string>()
          for (const r of job.results) if (!r.ok && r.error) errs.set(r.agentId, r.error)
          setRowStatus(rs)
          setErrors(errs)
          setProg({ done: job.done, total: job.total, succeeded: job.succeeded, failed: job.failed })
          setPhase('running')
        } else {
          setPhase('select')
          setSelected(new Set())
          setRowStatus(new Map())
          setErrors(new Map())
        }
      })
      .catch(() => {
        if (!cancelled) setPhase('select')
      })
    return () => { cancelled = true }
  }, [open])

  // Live progress — only react while this modal is showing a running job.
  useSSE({
    'avatar-bulk:progress': (data) => {
      if (phaseRef.current !== 'running') return
      const phaseKind = data.phase as 'start' | 'result'
      const agentId = data.agentId as string
      setRowStatus((prev) => {
        const next = new Map(prev)
        if (phaseKind === 'start') next.set(agentId, 'running')
        else if (phaseKind === 'result') next.set(agentId, data.ok ? 'ok' : 'error')
        return next
      })
      if (phaseKind === 'result' && data.error) {
        setErrors((prev) => new Map(prev).set(agentId, String(data.error)))
      }
      setProg({
        done: (data.done as number) ?? 0,
        total: (data.total as number) ?? 0,
        succeeded: (data.succeeded as number) ?? 0,
        failed: (data.failed as number) ?? 0,
      })
    },
    'avatar-bulk:done': (data) => {
      if (phaseRef.current !== 'running') return
      setProg({
        done: (data.total as number) ?? 0,
        total: (data.total as number) ?? 0,
        succeeded: (data.succeeded as number) ?? 0,
        failed: (data.failed as number) ?? 0,
      })
      setPhase('done')
    },
  })

  const allSelected = agents.length > 0 && selected.size === agents.length
  const someSelected = selected.size > 0 && !allSelected

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(agents.map((a) => a.id)))
  }
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleRegenerate = async () => {
    const ids = agents.filter((a) => selected.has(a.id)).map((a) => a.id)
    if (ids.length === 0) return
    setSubmitting(true)
    // Optimistically switch to the running view BEFORE the request so SSE
    // events that fire during the round-trip are not dropped by the gate above.
    setRowStatus(new Map(ids.map((id) => [id, 'pending'] as const)))
    setErrors(new Map())
    setProg({ done: 0, total: ids.length, succeeded: 0, failed: 0 })
    setPhase('running')
    try {
      await api.post('/settings/avatars/bulk-regenerate', {
        agentIds: ids,
        ...(selectedImageModel
          ? { imageProviderId: selectedImageModel.providerId, imageModel: selectedImageModel.modelId }
          : {}),
      })
    } catch (err) {
      setPhase('select')
      toastError(err)
    } finally {
      setSubmitting(false)
    }
  }

  // In select mode the whole roster is pickable; once running/done, show only
  // the agents enrolled in the job (those that have a per-row status).
  const visibleAgents = phase === 'select' ? agents : agents.filter((a) => rowStatus.has(a.id))
  const failedAgents = agents.filter((a) => rowStatus.get(a.id) === 'error')

  const renderStatusIcon = (status: RowStatus | undefined) => {
    switch (status) {
      case 'running':
        return <Loader2 className="size-4 animate-spin text-primary" />
      case 'ok':
        return <Check className="size-4 text-success" />
      case 'error':
        return <X className="size-4 text-destructive" />
      default:
        return <Circle className="size-3 text-muted-foreground/40" />
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>{t('settings.avatars.bulk.title')}</DialogTitle>
          <DialogDescription>
            {phase === 'select'
              ? t('settings.avatars.bulk.description')
              : t('settings.avatars.bulk.running.note')}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {phase === 'select' && hasImageModels && (
            <div className="space-y-1.5">
              <Label className="text-xs">{t('settings.avatars.bulk.model')}</Label>
              <ModelPicker
                models={imageModels}
                value={selectedModelValue}
                onValueChange={(modelId, pid) => setSelectedModelValue(modelPickerValue(modelId, pid))}
              />
            </div>
          )}

          {phase !== 'select' && (
            <div className="space-y-1.5">
              <Progress value={prog.total > 0 ? (prog.done / prog.total) * 100 : 0} variant="gradient" />
              <p className="text-xs text-muted-foreground">
                {t('settings.avatars.bulk.running.progress', { done: prog.done, total: prog.total })}
                {prog.failed > 0 && ` · ${t('settings.avatars.bulk.running.failedCount', { count: prog.failed })}`}
              </p>
            </div>
          )}

          {phase === 'select' && agents.length > 0 && (
            <div className="flex items-center justify-between gap-2 px-1">
              <button
                type="button"
                onClick={toggleAll}
                className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} />
                {allSelected ? t('settings.avatars.bulk.deselectAll') : t('settings.avatars.bulk.selectAll')}
              </button>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
                {t('settings.avatars.bulk.selectedCount', { count: selected.size })}
              </span>
            </div>
          )}

          {visibleAgents.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('settings.avatars.bulk.noAgents')}
            </p>
          ) : (
            <div className="max-h-[320px] overflow-y-auto rounded-lg border border-border">
              <div className="divide-y divide-border/60">
                {visibleAgents.map((agent) => {
                  const status = rowStatus.get(agent.id)
                  const checked = selected.has(agent.id)
                  const interactive = phase === 'select'
                  const Row = interactive ? 'label' : 'div'
                  return (
                    <Row
                      key={agent.id}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5',
                        interactive && 'cursor-pointer hover:bg-muted/40',
                      )}
                    >
                      {interactive ? (
                        <Checkbox className="shrink-0" checked={checked} onCheckedChange={() => toggleOne(agent.id)} />
                      ) : (
                        <span className="grid size-4 shrink-0 place-content-center">{renderStatusIcon(status)}</span>
                      )}
                      <Avatar className="size-9 shrink-0 rounded-lg ring-1 ring-border">
                        {agent.avatarUrl && <AvatarImage src={agent.avatarUrl} alt={agent.name} className="object-cover" />}
                        <AvatarFallback className="rounded-lg text-xs">
                          {agent.name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{agent.name}</span>
                          {agent.kind === 'configurator' && (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t('settings.avatars.bulk.configuratorTag')}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{agent.role}</p>
                      </div>
                      {!interactive && status === 'error' && errors.get(agent.id) && (
                        <span className="max-w-[40%] shrink-0 truncate text-xs text-destructive" title={errors.get(agent.id)}>
                          {errors.get(agent.id)}
                        </span>
                      )}
                    </Row>
                  )
                })}
              </div>
            </div>
          )}

          {phase === 'done' && (
            <p className="text-sm">
              {prog.failed === 0
                ? t('settings.avatars.bulk.done.allOk', { count: prog.succeeded })
                : t('settings.avatars.bulk.done.summary', { succeeded: prog.succeeded, failed: prog.failed })}
              {failedAgents.length > 0 && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t('settings.avatars.bulk.failedList')} {failedAgents.map((a) => a.name).join(', ')}
                </span>
              )}
            </p>
          )}
        </DialogBody>

        <DialogFooter>
          {phase === 'select' ? (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleRegenerate} disabled={selected.size === 0 || submitting || !hasImageModels}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {t('settings.avatars.bulk.regenerate', { count: selected.size })}
              </Button>
            </>
          ) : (
            <Button onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
