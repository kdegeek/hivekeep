import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getErrorMessage } from '@/client/lib/api'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/client/components/ui/dialog'
import { Button } from '@/client/components/ui/button'
import { Label } from '@/client/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { useTickets } from '@/client/hooks/useTickets'
import { toast } from 'sonner'

interface KinOption {
  id: string
  name: string
  activeProjectId: string | null
}

interface StartTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  ticketId: string
  projectId: string
}

export function StartTaskDialog({ open, onOpenChange, ticketId, projectId }: StartTaskDialogProps) {
  const { t } = useTranslation()
  const { startTicketTask } = useTickets(projectId)
  const [kins, setKins] = useState<KinOption[]>([])
  const [selectedKinId, setSelectedKinId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    api
      .get<{ kins: KinOption[] }>('/kins')
      .then((data) => {
        if (cancelled) return
        setKins(data.kins)
        // Pre-select first Kin that has this project as active
        const match = data.kins.find((k) => k.activeProjectId === projectId)
        setSelectedKinId(match?.id ?? data.kins[0]?.id ?? '')
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  async function handleSubmit() {
    if (!selectedKinId) return
    setSubmitting(true)
    try {
      await startTicketTask(ticketId, selectedKinId)
      onOpenChange(false)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('projects.startTask.title')}</DialogTitle>
          <DialogDescription>{t('projects.startTask.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor="kin-select">{t('projects.startTask.kinField')}</Label>
          <Select value={selectedKinId} onValueChange={setSelectedKinId}>
            <SelectTrigger id="kin-select">
              <SelectValue placeholder={t('projects.startTask.kinPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {kins.map((kin) => {
                const isActiveOnProject = kin.activeProjectId === projectId
                return (
                  <SelectItem key={kin.id} value={kin.id}>
                    {kin.name}
                    {isActiveOnProject && (
                      <span className="ml-2 text-xs text-primary">
                        ({t('projects.startTask.activeOnProject')})
                      </span>
                    )}
                  </SelectItem>
                )
              })}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!selectedKinId || submitting}>
            {t('projects.startTask.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
