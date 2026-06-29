import { useEffect, useMemo, useState } from 'react'
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
      toast.error('Failed to load code review settings')
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
  const canSave = hasChanges && invalidRoots.length === 0 && !saving

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
      toast.success('Code review repository roots saved')
    } catch (err: unknown) {
      toastError(err)
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setResetting(true)
    try {
      const data = await api.delete<CodeReviewRootsResponse>('/settings/code-review/allowed-repo-roots')
      const nextRoots = data.allowedRepoRoots.length > 0 ? data.allowedRepoRoots : ['']
      setRoots(nextRoots)
      setInitialRoots(data.allowedRepoRoots)
      setSource(data.source)
      setEnvFallback(data.envFallback)
      toast.success('Code review roots reset to environment fallback')
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
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Code Review</h2>
        <p className="text-sm text-muted-foreground">
          Configure host repository roots that local CodeRabbit and Kilo reviewer tools may access outside the current Agent workspace.
        </p>
      </div>

      <Alert className="border-amber-500/30 bg-amber-500/5 text-amber-900 dark:text-amber-100">
        <AlertTriangle className="size-4" />
        <AlertTitle>Security boundary</AlertTitle>
        <AlertDescription>
          Agents with local review tools may run reviewer CLIs against Git repositories under these roots. Keep the list narrow and only include paths you trust for code review access.
        </AlertDescription>
      </Alert>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label>Allowed repository roots</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Absolute paths only. Blank entries are ignored; duplicates are removed on save. Changes apply immediately and do not require restart.
            </p>
          </div>
          <span className="rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
            Source: {source === 'settings' ? 'Settings override' : 'environment fallback'}
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
                    placeholder="/Users/kdegeek/hivekeep"
                    aria-invalid={invalid}
                    className={invalid ? 'border-destructive focus-visible:ring-destructive' : undefined}
                  />
                  {invalid && (
                    <p className="text-xs text-destructive">Enter an absolute path.</p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRoot(index)}
                  aria-label="Remove root"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )
          })}
        </div>

        <Button type="button" variant="outline" onClick={() => setRoots((current) => [...current, ''])}>
          Add root
        </Button>
      </div>

      {source === 'settings' && envFallback.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Environment fallback if the Settings override is reset: {envFallback.join(', ')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {hasChanges && (
          <Button variant="ghost" onClick={() => setRoots(initialRoots.length > 0 ? initialRoots : [''])}>
            Discard
          </Button>
        )}
        <Button variant="outline" onClick={handleReset} disabled={resetting || source === 'env'}>
          <RotateCcw className="mr-2 size-4" />
          {resetting ? 'Resetting…' : 'Reset to env fallback'}
        </Button>
      </div>
    </div>
  )
}
