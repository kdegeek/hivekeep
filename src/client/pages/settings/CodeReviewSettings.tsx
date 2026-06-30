import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertTriangle, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Skeleton } from '@/client/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/client/components/ui/alert'
import { api, getErrorMessage, toastError } from '@/client/lib/api'

interface CodeReviewRootsResponse {
  allowedRepoRoots: string[]
  source: 'env' | 'settings'
  envFallback: string[]
  restartRequired: boolean
  warnings?: string[]
}

function normalizeClientRoots(values: string[]): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    roots.push(trimmed)
  }
  return roots
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

export function CodeReviewSettings() {
  const { t } = useTranslation()
  const [isLoading, setIsLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [roots, setRoots] = useState<string[]>([''])
  const [initialRoots, setInitialRoots] = useState<string[]>([])
  const [source, setSource] = useState<'env' | 'settings'>('env')
  const [envFallback, setEnvFallback] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)

  const loadSettings = async () => {
    try {
      const data = await api.get<CodeReviewRootsResponse>('/settings/code-review/allowed-repo-roots')
      const nextRoots = data.allowedRepoRoots.length > 0 ? data.allowedRepoRoots : ['']
      setRoots(nextRoots)
      setInitialRoots(data.allowedRepoRoots)
      setSource(data.source)
      setEnvFallback(data.envFallback)
      setFetchError(null)
    } catch (err: unknown) {
      setFetchError(getErrorMessage(err))
      toast.error(t('settings.codeReview.fetchError'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadSettings().catch(() => {})
  }, [])

  const normalizedRoots = useMemo(() => normalizeClientRoots(roots), [roots])
  const hasChanges = JSON.stringify(normalizedRoots) !== JSON.stringify(initialRoots)
  const invalidRoots = normalizedRoots.filter((root) => !isAbsolutePath(root))
  const isSubmitting = saving || resetting
  const canSave = hasChanges && invalidRoots.length === 0 && !isSubmitting

  const updateRoot = (index: number, value: string) => {
    setRoots((current) => current.map((root, i) => (i === index ? value : root)))
  }

  const removeRoot = (index: number) => {
    setRoots((current) => {
      const next = current.filter((_, i) => i !== index)
      return next.length > 0 ? next : ['']
    })
  }

  const handleSave = async () => {
    if (isSubmitting) return
    setSaving(true)
    try {
      const data = await api.put<CodeReviewRootsResponse>('/settings/code-review/allowed-repo-roots', {
        allowedRepoRoots: normalizedRoots,
      })
      const nextRoots = data.allowedRepoRoots.length > 0 ? data.allowedRepoRoots : ['']
      setRoots(nextRoots)
      setInitialRoots(data.allowedRepoRoots)
      setSource(data.source)
      setEnvFallback(data.envFallback)
      toast.success(t('settings.codeReview.saveSuccess'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (isSubmitting) return
    setResetting(true)
    try {
      const data = await api.delete<CodeReviewRootsResponse>('/settings/code-review/allowed-repo-roots')
      const nextRoots = data.allowedRepoRoots.length > 0 ? data.allowedRepoRoots : ['']
      setRoots(nextRoots)
      setInitialRoots(data.allowedRepoRoots)
      setSource(data.source)
      setEnvFallback(data.envFallback)
      toast.success(t('settings.codeReview.resetSuccess'))
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setResetting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-40" />
      </div>
    )
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-destructive">{fetchError}</p>
        <Button variant="outline" onClick={() => {
          setIsLoading(true)
          setFetchError(null)
          loadSettings().catch(() => {})
        }}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{t('settings.codeReview.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('settings.codeReview.description')}
        </p>
      </div>

      <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-100">
        <AlertTriangle className="size-4" />
        <AlertTitle>{t('settings.codeReview.securityTitle')}</AlertTitle>
        <AlertDescription>
          {t('settings.codeReview.securityDescription')}
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>{t('settings.codeReview.allowedRootsLabel')}</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('settings.codeReview.allowedRootsHint')}
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
            {t('settings.codeReview.source', { source: source === 'settings' ? t('settings.codeReview.sourceSettings') : t('settings.codeReview.sourceEnv') })}
          </span>
        </div>

        <div className="space-y-2">
          {roots.map((root, index) => {
            const trimmed = root.trim()
            const invalid = trimmed !== '' && !isAbsolutePath(trimmed)
            return (
              <div key={index} className="flex items-start gap-2">
                <div className="flex-1 space-y-1">
                  <Input
                    value={root}
                    onChange={(e) => updateRoot(index, e.target.value)}
                    placeholder={t('settings.codeReview.rootPlaceholder')}
                    aria-invalid={invalid}
                    className={invalid ? 'border-destructive focus-visible:ring-destructive' : undefined}
                  />
                  {invalid && (
                    <p className="text-xs text-destructive">{t('settings.codeReview.absolutePathError')}</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRoot(index)}
                  aria-label={t('settings.codeReview.removeRoot')}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )
          })}
        </div>

        <Button type="button" variant="outline" onClick={() => setRoots((current) => [...current, ''])}>
          {t('settings.codeReview.addRoot')}
        </Button>
      </div>

      {source === 'settings' && envFallback.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('settings.codeReview.envFallback', { roots: envFallback.join(', ') })}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? t('settings.codeReview.saving') : t('common.save')}
        </Button>
        {hasChanges && (
          <Button variant="ghost" disabled={isSubmitting} onClick={() => setRoots(initialRoots.length > 0 ? initialRoots : [''])}>
            {t('settings.codeReview.discard')}
          </Button>
        )}
        <Button variant="outline" onClick={handleReset} disabled={isSubmitting || source === 'env'}>
          <RotateCcw className="mr-2 size-4" />
          {resetting ? t('settings.codeReview.resetting') : t('settings.codeReview.resetToEnv')}
        </Button>
      </div>
    </div>
  )
}
