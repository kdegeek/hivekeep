import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, SVGProps } from 'react'
import { useTranslation } from 'react-i18next'
import { FormDialog } from '@/client/components/common/FormDialog'
import { FormField, FormRow } from '@/client/components/common/FormField'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { Textarea } from '@/client/components/ui/textarea'
import { CodeEditor, type CodeEditorLanguage } from '@/client/components/ui/code-editor'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/client/components/ui/collapsible'
import { ToggleGroup, ToggleGroupItem } from '@/client/components/ui/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/client/components/ui/tooltip'
import { Loader2, Play, PackageCheck, ChevronRight, Terminal } from 'lucide-react'
import { SiPython, SiNodedotjs, SiBun, SiTypescript, SiGnubash, SiDeno } from 'react-icons/si'
import type { IconType } from 'react-icons'
import { SchemaArgsForm } from '@/client/components/toolbox/SchemaArgsForm'
import { LanguageSelector } from '@/client/components/common/LanguageSelector'
import { ToolDomainIcon } from '@/client/components/common/ToolDomainIcon'
import { CustomToolRenderer } from '@/client/components/chat/CustomToolRenderer'
import { useToolDomains } from '@/client/hooks/useToolDomains'
import type { CustomTool, CustomToolTranslations } from '@/shared/types'
import type {
  CreateCustomToolInput,
  UpdateCustomToolInput,
  SetupResult,
  TestResult,
} from '@/client/hooks/useCustomTools'

const LANGUAGES = ['python', 'node', 'bun', 'typescript', 'bash', 'sh', 'deno'] as const
const SLUG_RE = /^[a-z][a-z0-9_]*$/

/** Brand icon per interpreter language. Falls back to a Lucide Terminal. */
const LANGUAGE_ICONS: Record<string, IconType> = {
  python: SiPython,
  node: SiNodedotjs,
  bun: SiBun,
  typescript: SiTypescript,
  bash: SiGnubash,
  sh: SiGnubash,
  deno: SiDeno,
}

function LanguageIcon({ language, className }: { language: string; className?: string }) {
  const Icon: ComponentType<SVGProps<SVGSVGElement>> = LANGUAGE_ICONS[language] ?? Terminal
  return <Icon className={className} aria-hidden />
}

/** Locales that have UI label files. */
const TRANSLATION_LOCALES = ['en', 'fr'] as const

/** Native-name labels for the translation-locale picker. */
const LOCALE_LABELS: Record<string, string> = {
  en: 'English',
  fr: 'Français',
}

/** Extract the property keys of a JSON-Schema object (for per-param labels). */
function parseParamNames(parametersJson: string): string[] {
  try {
    const schema = JSON.parse(parametersJson) as { properties?: Record<string, unknown> }
    if (schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object') {
      return Object.keys(schema.properties)
    }
  } catch {
    /* invalid JSON → no params */
  }
  return []
}

/** Drop empty strings / empty param objects so we never store noise. */
function pruneTranslations(input: CustomToolTranslations): CustomToolTranslations | null {
  const out: CustomToolTranslations = {}
  for (const [locale, entry] of Object.entries(input)) {
    const cleaned: { name?: string; description?: string; parameters?: Record<string, { label?: string; description?: string }> } = {}
    if (entry.name?.trim()) cleaned.name = entry.name.trim()
    if (entry.description?.trim()) cleaned.description = entry.description.trim()
    if (entry.parameters) {
      const params: Record<string, { label?: string; description?: string }> = {}
      for (const [param, val] of Object.entries(entry.parameters)) {
        const p: { label?: string; description?: string } = {}
        if (val.label?.trim()) p.label = val.label.trim()
        if (val.description?.trim()) p.description = val.description.trim()
        if (p.label || p.description) params[param] = p
      }
      if (Object.keys(params).length > 0) cleaned.parameters = params
    }
    if (cleaned.name || cleaned.description || cleaned.parameters) out[locale] = cleaned
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Map the tool's runtime language to a CodeEditor syntax mode for the entrypoint. */
function codeLanguageFor(language: string): CodeEditorLanguage {
  switch (language) {
    case 'python':
      return 'python'
    case 'bash':
    case 'sh':
      return 'bash'
    // node / bun / typescript / deno → JS/TS family
    default:
      return 'tsx'
  }
}

function defaultEntrypoint(language: string): string {
  switch (language) {
    case 'python':
      return 'main.py'
    case 'node':
      return 'index.js'
    case 'bash':
    case 'sh':
      return 'run.sh'
    case 'deno':
      return 'main.ts'
    default:
      return 'index.ts'
  }
}

interface CustomToolFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tool: CustomTool | null
  onCreate: (input: CreateCustomToolInput) => Promise<CustomTool>
  onUpdate: (slug: string, input: UpdateCustomToolInput) => Promise<unknown>
  readFile: (slug: string, path: string) => Promise<string>
  writeFile: (slug: string, path: string, content: string) => Promise<void>
  runSetup: (slug: string) => Promise<SetupResult>
  testTool: (slug: string, args: Record<string, unknown>) => Promise<TestResult>
}

const STARTER = `// Reads JSON args on stdin, writes the result to stdout.
const args = JSON.parse(await Bun.stdin.text() || '{}')
console.log(JSON.stringify({ ok: true, args }))
`

/** The renderer entry file (optional themed React result renderer). */
const RENDERER_FILE = 'renderer.tsx'

const RENDERER_STARTER = `// Optional result renderer — pretty-prints this tool's result in the expanded
// chat tool-call view. Style with the provided 'ui' kit or inline var(--color-*)
// tokens (Tailwind classes do NOT apply). It auto-themes (dark/light + palette).
export default function Renderer({ result, args, ui }) {
  const data = result?.output ?? result
  return (
    <ui.Card>
      <ui.Header>Result</ui.Header>
      <ui.Code>{JSON.stringify(data, null, 2)}</ui.Code>
    </ui.Card>
  )
}
`

export function CustomToolFormDialog({
  open,
  onOpenChange,
  tool,
  onCreate,
  onUpdate,
  readFile,
  writeFile,
  runSetup,
  testTool,
}: CustomToolFormDialogProps) {
  const { t, i18n } = useTranslation()
  const { domains } = useToolDomains()
  const isEdit = !!tool

  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [language, setLanguage] = useState<string>('bun')
  const [entrypoint, setEntrypoint] = useState('index.ts')
  const [domainSlug, setDomainSlug] = useState('custom')
  const [parameters, setParameters] = useState('{\n  "type": "object",\n  "properties": {}\n}')
  const [translations, setTranslations] = useState<CustomToolTranslations>({})
  const [translationLocale, setTranslationLocale] = useState<string>('en')
  const [code, setCode] = useState(STARTER)
  const [rendererCode, setRendererCode] = useState('')
  const [rendererOpen, setRendererOpen] = useState(false)
  const [depsContent, setDepsContent] = useState('')
  const [testArgs, setTestArgs] = useState('{}')
  const [testArgsObj, setTestArgsObj] = useState<Record<string, unknown>>({})
  const [testMode, setTestMode] = useState<'form' | 'json'>('form')
  const [testJsonInvalid, setTestJsonInvalid] = useState(false)
  const [testOutput, setTestOutput] = useState<string | null>(null)
  // Raw test result + the args used, kept so the renderer preview can mount the
  // real chat rendering path against the live result.
  const [testResultRaw, setTestResultRaw] = useState<TestResult | null>(null)
  const [argsUsed, setArgsUsed] = useState<Record<string, unknown>>({})
  // Output view for the test panel: formatted JSON string vs live renderer.tsx.
  const [outputMode, setOutputMode] = useState<'json' | 'render'>('json')
  // Monotonic cache-buster: bumped after each renderer.tsx writeFile so
  // CustomToolRenderer re-imports the freshly built module (no timestamps).
  const [rendererBust, setRendererBust] = useState(0)
  const [setupOutput, setSetupOutput] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setError(null)
    setTestOutput(null)
    setTestResultRaw(null)
    setArgsUsed({})
    setOutputMode('json')
    setSetupOutput(null)
    setTranslationLocale('en')
    setRendererOpen(false)
    setTestArgs('{}')
    setTestArgsObj({})
    setTestJsonInvalid(false)
    if (tool) {
      setSlug(tool.slug)
      setName(tool.name)
      setDescription(tool.description)
      setLanguage(tool.language ?? 'bun')
      setEntrypoint(tool.entrypoint)
      setDomainSlug(tool.domainSlug)
      setParameters(tool.parameters)
      setTranslations(tool.translations ?? {})
      setCode('')
      // Load entrypoint content for editing.
      void readFile(tool.slug, tool.entrypoint)
        .then(setCode)
        .catch(() => setCode(''))
      // Load the optional renderer (absent for most tools — leave blank then).
      setRendererCode('')
      void readFile(tool.slug, RENDERER_FILE)
        .then((content) => {
          setRendererCode(content)
          if (content.trim()) setRendererOpen(true)
        })
        .catch(() => setRendererCode(''))
    } else {
      setSlug('')
      setName('')
      setDescription('')
      setLanguage('bun')
      setEntrypoint('index.ts')
      setDomainSlug('custom')
      setParameters('{\n  "type": "object",\n  "properties": {}\n}')
      setTranslations({})
      setCode(STARTER)
      setRendererCode('')
      setDepsContent('')
    }
  }, [open, tool, readFile])

  // Keep entrypoint in sync with language when creating (until user overrides).
  function onLanguageChange(lang: string) {
    setLanguage(lang)
    if (!isEdit) setEntrypoint(defaultEntrypoint(lang))
  }

  const paramNames = parseParamNames(parameters)
  const localeEntry = translations[translationLocale] ?? {}

  // Param translations for the USER's current UI locale (not the editing
  // locale), so the test form mirrors what the user would actually see.
  const uiLocale = (i18n.language || 'en').split('-')[0] || 'en'
  const paramTranslations = translations[uiLocale]?.parameters ?? translations['en']?.parameters ?? {}

  // A renderer preview is available only once a renderer.tsx body exists and the
  // tool is saved (the server build path needs a persisted slug).
  const hasRenderer = isEdit && rendererCode.trim().length > 0

  // Parsed JSON Schema (null when the parameters text is invalid JSON).
  const parsedParameters = useMemo<Record<string, unknown> | null>(() => {
    try {
      const parsed = JSON.parse(parameters)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }, [parameters])

  // Whether the test form is usable: valid schema with at least one property.
  const schemaFormUsable = useMemo(() => {
    const props = parsedParameters?.properties
    return !!props && typeof props === 'object' && Object.keys(props).length > 0
  }, [parsedParameters])

  // Pick the initial test mode when the dialog (re)opens: Form when the schema
  // has ≥1 property and parses, else JSON. Re-run only on open / tool change so
  // we don't yank the user out of a mode mid-edit.
  useEffect(() => {
    if (!open) return
    setTestMode(schemaFormUsable ? 'form' : 'json')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tool])

  // If the renderer becomes unavailable (cleared / not yet saved) while Render
  // mode is selected, fall back to the JSON output view so the toggle (which is
  // hidden in that case) can't strand the panel on an empty Render view.
  useEffect(() => {
    if (!hasRenderer && outputMode === 'render') setOutputMode('json')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRenderer])

  /**
   * Persist the current renderer.tsx body and bump the cache-buster so the
   * server rebuilds and CustomToolRenderer re-imports the fresh module. Resilient
   * by design: a transient build error while the user is typing must not throw
   * uncaught — the CustomToolRenderer ErrorBoundary shows the JsonViewer fallback
   * for a broken build. The cache-buster uses a functional updater so concurrent
   * rebuilds (debounced edit + run-test) never collide on a stale closure value.
   */
  async function rebuildRenderer(): Promise<void> {
    try {
      await writeFile(slug, RENDERER_FILE, rendererCode)
      setRendererBust((n) => n + 1)
    } catch {
      // Swallow — the next successful rebuild (or a run-test) recovers the view.
    }
  }

  // Debounced live rebuild: whenever the renderer body changes while Render mode
  // is active (and a renderer exists), re-persist renderer.tsx ~500ms after the
  // last keystroke so the preview tracks the editor (template insert + edits)
  // instead of a stale build. The on-enter and on-test rebuilds remain; this only
  // covers in-place edits. A test result (testResultRaw) is still required for
  // the preview to mount — the "Run a test first…" guard stays.
  const rebuildTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (outputMode !== 'render' || !hasRenderer || !rendererCode.trim()) return
    if (rebuildTimer.current) clearTimeout(rebuildTimer.current)
    rebuildTimer.current = setTimeout(() => {
      void rebuildRenderer()
    }, 500)
    return () => {
      if (rebuildTimer.current) clearTimeout(rebuildTimer.current)
    }
    // rendererCode is the trigger; outputMode/hasRenderer gate it. rebuildRenderer
    // reads the latest rendererCode from state at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererCode, outputMode, hasRenderer])

  /** Switch the output view; entering Render rebuilds against the live editor. */
  async function onOutputModeChange(next: 'json' | 'render') {
    if (next === outputMode) return
    setOutputMode(next)
    if (next === 'render' && hasRenderer) {
      await rebuildRenderer()
    }
  }

  // If the parameters schema stops being form-usable while Form mode is active,
  // the panel falls back to the JSON editor — seed it from the canonical object
  // so the user keeps their values instead of seeing a stale string.
  useEffect(() => {
    if (testMode === 'form' && !schemaFormUsable) {
      setTestArgs(JSON.stringify(testArgsObj, null, 2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaFormUsable])

  /** Switch test panel mode, syncing the two representations across the toggle. */
  function onTestModeChange(next: 'form' | 'json') {
    if (next === testMode) return
    if (next === 'json') {
      // Form → JSON: serialize the canonical object to pretty JSON.
      setTestArgs(JSON.stringify(testArgsObj, null, 2))
      setTestJsonInvalid(false)
    } else {
      // JSON → Form: parse the JSON into the canonical object when valid;
      // otherwise keep the last object and surface a note.
      try {
        const parsed = JSON.parse(testArgs || '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          setTestArgsObj(parsed as Record<string, unknown>)
          setTestJsonInvalid(false)
        } else {
          setTestJsonInvalid(true)
        }
      } catch {
        setTestJsonInvalid(true)
      }
    }
    setTestMode(next)
  }

  function setLocaleField(field: 'name' | 'description', value: string) {
    setTranslations((prev) => ({
      ...prev,
      [translationLocale]: { ...prev[translationLocale], [field]: value },
    }))
  }

  function setLocaleParamField(param: string, field: 'label' | 'description', value: string) {
    setTranslations((prev) => {
      const cur = prev[translationLocale] ?? {}
      const curParams = cur.parameters ?? {}
      return {
        ...prev,
        [translationLocale]: {
          ...cur,
          parameters: { ...curParams, [param]: { ...curParams[param], [field]: value } },
        },
      }
    })
  }

  const depsFile =
    language === 'python' ? 'requirements.txt' : language === 'node' || language === 'bun' || language === 'typescript' ? 'package.json' : null

  function validate(): string | null {
    if (!isEdit && !SLUG_RE.test(slug)) return t('customTools.errors.slug')
    if (!name.trim()) return t('customTools.errors.name')
    try {
      JSON.parse(parameters)
    } catch {
      return t('customTools.errors.parameters')
    }
    return null
  }

  async function handleSubmit() {
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    setSaving(true)
    setError(null)
    const cleanedTranslations = pruneTranslations(translations)
    try {
      if (isEdit) {
        await onUpdate(slug, { name, description, parameters, entrypoint, language, domainSlug, translations: cleanedTranslations })
        await writeFile(slug, entrypoint, code)
        if (depsFile && depsContent.trim()) await writeFile(slug, depsFile, depsContent)
        if (rendererCode.trim()) await writeFile(slug, RENDERER_FILE, rendererCode)
      } else {
        const created = await onCreate({ slug, name, description, parameters, entrypoint, language, domainSlug, code, translations: cleanedTranslations })
        if (depsFile && depsContent.trim()) await writeFile(created.slug, depsFile, depsContent)
        if (rendererCode.trim()) await writeFile(created.slug, RENDERER_FILE, rendererCode)
      }
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleInstall() {
    if (!isEdit) return
    setBusy(true)
    setSetupOutput(null)
    try {
      if (depsFile && depsContent.trim()) await writeFile(slug, depsFile, depsContent)
      const res = await runSetup(slug)
      setSetupOutput((res.success ? '✅ ' : '❌ ') + res.output + (res.error ? `\n${res.error}` : ''))
    } catch (err) {
      setSetupOutput(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleTest() {
    if (!isEdit) {
      setError(t('customTools.testAfterSave'))
      return
    }
    setBusy(true)
    setTestOutput(null)
    setTestResultRaw(null)
    try {
      let args: Record<string, unknown> = {}
      // The form is only the source of truth when it's actually rendered
      // (schema parses with ≥1 property); otherwise the JSON editor is shown.
      if (testMode === 'form' && schemaFormUsable) {
        // Form mode: the canonical object is the source of truth.
        args = testArgsObj
      } else {
        try {
          args = JSON.parse(testArgs || '{}')
        } catch {
          setTestOutput(t('customTools.errors.testArgs'))
          setBusy(false)
          return
        }
      }
      // Persist code first so the test runs the latest version.
      await writeFile(slug, entrypoint, code)
      const res = await testTool(slug, args)
      setArgsUsed(args)
      setTestResultRaw(res)
      setTestOutput(
        `exit ${res.exitCode} · ${res.executionTime}ms\n` +
          (typeof res.output === 'string' ? res.output : JSON.stringify(res.output, null, 2)) +
          (res.error ? `\n[stderr] ${res.error}` : ''),
      )
      // In Render mode, rebuild renderer.tsx from the live editor so the preview
      // reflects the current code against this fresh result.
      if (outputMode === 'render' && hasRenderer) await rebuildRenderer()
    } catch (err) {
      setTestOutput(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('customTools.edit') : t('customTools.create')}
      description={t('customTools.dialogDescription')}
      size="5xl"
      error={error}
      onSubmit={handleSubmit}
      isSubmitting={saving}
      submitLabel={isEdit ? t('common.save') : t('common.create')}
    >
      <div className="min-w-0 space-y-4">
          <FormRow>
            <FormField label={t('customTools.fields.slug')} htmlFor="ct-slug">
              <Input id="ct-slug" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={isEdit} placeholder="scrape_url" />
            </FormField>
            <FormField label={t('customTools.fields.name')} htmlFor="ct-name">
              <Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Scrape URL" />
            </FormField>
          </FormRow>

          <FormField label={t('customTools.fields.description')} htmlFor="ct-desc">
            <Textarea id="ct-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={t('customTools.fields.descriptionHint')} />
          </FormField>

          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <FormField label={t('customTools.fields.language')}>
              <Select value={language} onValueChange={onLanguageChange}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((l) => (
                    <SelectItem key={l} value={l}>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <LanguageIcon language={l} className="size-3.5 shrink-0" />
                        <span className="truncate">{l}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label={t('customTools.fields.entrypoint')} htmlFor="ct-entry">
              <Input id="ct-entry" value={entrypoint} onChange={(e) => setEntrypoint(e.target.value)} />
            </FormField>
            <FormField label={t('customTools.fields.domain')}>
              <Select value={domainSlug} onValueChange={setDomainSlug}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {domains.map((d) => (
                    <SelectItem key={d.slug} value={d.slug}>
                      <span className="flex items-center gap-1.5 min-w-0">
                        <ToolDomainIcon iconName={d.icon} className="size-3.5 shrink-0" />
                        <span className="truncate">{d.label ?? d.slug}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField label={t('customTools.fields.parameters')} htmlFor="ct-params" hint={t('customTools.fields.parametersHint')}>
            <CodeEditor value={parameters} onChange={setParameters} language="json" height="140px" />
          </FormField>

          {/* Translations — UI-only localized name / description / param labels. */}
          <div className="min-w-0 space-y-2.5 rounded-lg border border-dashed p-3">
            <div className="flex items-center justify-between gap-3">
              <Label className="min-w-0 truncate">{t('customTools.translations.title')}</Label>
              <div className="w-40 shrink-0 min-w-0">
                <LanguageSelector
                  options={TRANSLATION_LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l] ?? l }))}
                  value={translationLocale}
                  onValueChange={setTranslationLocale}
                  className="w-40 min-w-0"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t('customTools.translations.help')}</p>

            <FormField label={t('customTools.translations.uiName')} htmlFor="ct-tr-name">
              <Input
                id="ct-tr-name"
                value={localeEntry.name ?? ''}
                onChange={(e) => setLocaleField('name', e.target.value)}
                placeholder={name}
              />
            </FormField>
            <FormField label={t('customTools.translations.uiDescription')} htmlFor="ct-tr-desc">
              <Textarea
                id="ct-tr-desc"
                value={localeEntry.description ?? ''}
                onChange={(e) => setLocaleField('description', e.target.value)}
                rows={2}
                placeholder={description}
              />
            </FormField>

            {paramNames.length > 0 && (
              <div className="min-w-0 space-y-2.5">
                {paramNames.map((param) => {
                  const pv = localeEntry.parameters?.[param] ?? {}
                  return (
                    <div key={param} className="min-w-0 space-y-1.5 rounded-md bg-muted/40 p-2">
                      <code className="block truncate text-xs text-muted-foreground">{param}</code>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <Input
                          className="min-w-0"
                          aria-label={t('customTools.translations.paramLabel')}
                          value={pv.label ?? ''}
                          onChange={(e) => setLocaleParamField(param, 'label', e.target.value)}
                          placeholder={t('customTools.translations.paramLabel')}
                        />
                        <Input
                          className="min-w-0"
                          aria-label={t('customTools.translations.paramDescription')}
                          value={pv.description ?? ''}
                          onChange={(e) => setLocaleParamField(param, 'description', e.target.value)}
                          placeholder={t('customTools.translations.paramDescription')}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <FormField label={t('customTools.fields.code', { file: entrypoint })} htmlFor="ct-code">
            <CodeEditor value={code} onChange={setCode} language={codeLanguageFor(language)} height="280px" />
          </FormField>

          {depsFile && (
            <FormField label={t('customTools.fields.deps', { file: depsFile })} htmlFor="ct-deps">
              <CodeEditor
                value={depsContent}
                onChange={setDepsContent}
                language={depsFile === 'package.json' ? 'json' : 'bash'}
                height="120px"
              />
              <Button type="button" variant="outline" size="sm" onClick={handleInstall} disabled={!isEdit || busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <PackageCheck className="size-4" />}
                {t('customTools.installDeps')}
              </Button>
              {!isEdit && <p className="text-xs text-muted-foreground">{t('customTools.installAfterSave')}</p>}
              {setupOutput && <pre className="max-h-40 max-w-full overflow-x-auto overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-words">{setupOutput}</pre>}
            </FormField>
          )}

          {/* Optional result renderer (renderer.tsx) — secondary / collapsible. */}
          <Collapsible open={rendererOpen} onOpenChange={setRendererOpen} className="min-w-0 rounded-lg border border-dashed">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium">
              <ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${rendererOpen ? 'rotate-90' : ''}`} />
              <span className="min-w-0 flex-1 truncate">{t('customTools.renderer.title')}</span>
              {rendererCode.trim() && (
                <span className="shrink-0 text-[10px] rounded bg-primary/15 px-1.5 py-0.5 text-primary">{t('customTools.renderer.active')}</span>
              )}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="min-w-0 space-y-1.5 px-3 pb-3">
                <p className="text-xs text-muted-foreground">{t('customTools.renderer.help')}</p>
                <CodeEditor
                  value={rendererCode}
                  onChange={setRendererCode}
                  language="tsx"
                  height="280px"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRendererCode(RENDERER_STARTER)}
                  disabled={!!rendererCode.trim()}
                >
                  {t('customTools.renderer.insertStarter')}
                </Button>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Test panel */}
          <div className="min-w-0 space-y-2 rounded-lg border border-dashed p-3">
            <div className="flex min-w-0 items-center justify-between gap-3">
              <Label className="min-w-0 truncate">{t('customTools.testTitle')}</Label>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={testMode}
                onValueChange={(v) => v && onTestModeChange(v as 'form' | 'json')}
                className="shrink-0"
              >
                {schemaFormUsable ? (
                  <ToggleGroupItem value="form" aria-label={t('customTools.test.form')}>
                    {t('customTools.test.form')}
                  </ToggleGroupItem>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <ToggleGroupItem value="form" disabled aria-label={t('customTools.test.form')}>
                          {t('customTools.test.form')}
                        </ToggleGroupItem>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{t('customTools.test.formDisabled')}</TooltipContent>
                  </Tooltip>
                )}
                <ToggleGroupItem value="json" aria-label={t('customTools.test.json')}>
                  {t('customTools.test.json')}
                </ToggleGroupItem>
              </ToggleGroup>
            </div>

            {testMode === 'form' && schemaFormUsable ? (
              <SchemaArgsForm
                schema={parsedParameters}
                value={testArgsObj}
                onChange={setTestArgsObj}
                paramTranslations={paramTranslations}
              />
            ) : (
              <>
                <CodeEditor value={testArgs} onChange={setTestArgs} language="json" height="80px" />
                {testJsonInvalid && (
                  <p className="text-xs text-muted-foreground">{t('customTools.test.invalidJson')}</p>
                )}
              </>
            )}

            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleTest} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {t('customTools.runTest')}
              </Button>
              {/* Output view toggle — only when a saved renderer exists. */}
              {hasRenderer && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  variant="outline"
                  value={outputMode}
                  onValueChange={(v) => v && void onOutputModeChange(v as 'json' | 'render')}
                  className="shrink-0"
                >
                  <ToggleGroupItem value="json" aria-label={t('customTools.test.outputJson')}>
                    {t('customTools.test.outputJson')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="render" aria-label={t('customTools.test.outputRender')}>
                    {t('customTools.test.outputRender')}
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
            </div>
            {!isEdit && <p className="text-xs text-muted-foreground">{t('customTools.testAfterSave')}</p>}

            {hasRenderer && outputMode === 'render' ? (
              testResultRaw ? (
                <div className="min-w-0 max-h-80 overflow-auto rounded border border-border bg-muted/30 p-2">
                  <CustomToolRenderer
                    slug={slug}
                    result={testResultRaw}
                    args={argsUsed}
                    bust={rendererBust}
                  />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('customTools.test.renderAfterRun')}</p>
              )
            ) : (
              testOutput && <pre className="max-h-40 max-w-full overflow-x-auto overflow-y-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-words">{testOutput}</pre>
            )}
          </div>
      </div>
    </FormDialog>
  )
}
