import type { ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, MonitorSmartphone } from 'lucide-react'
// Real offline SVG flags (emoji flags render as the bare country code on
// Windows/Chrome). Named imports from the index resolve via the package's
// `exports` map (the per-country deep paths are NOT exported).
import {
  GB, FR, ES, DE, BR, PT, CN, TW, JP, RU, IT, PL, SA, BD, BG, HR, CZ, DK, NL,
  EE, FI, GR, IL, IN, HU, ID, KR, LV, LT, MY, NO, IR, RO, RS, SK, SI, SE, TH,
  TR, UA, VN,
} from 'country-flag-icons/react/3x2'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/client/components/ui/select'
import { AGENT_LANGUAGES } from '@/shared/constants'
import { cn } from '@/client/lib/utils'

/** UI translation languages (must match SUPPORTED_LANGUAGES + shipped locales). */
const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ru', label: 'Русский' },
  { value: 'it', label: 'Italiano' },
  { value: 'pl', label: 'Polski' },
] as const

/** Minimal prop surface we actually use; the package's flag components accept a
 *  superset of optional HTML/SVG attributes, so they're assignable here. */
type FlagComponent = ComponentType<{ className?: string }>

/** Locale → SVG flag component. Unknown locales fall back to a neutral globe.
 *  (A language is not a country — these are conventional associations only;
 *  e.g. Catalan has no flag here on purpose.) */
const FLAGS: Record<string, FlagComponent> = {
  en: GB,
  fr: FR,
  es: ES,
  de: DE,
  'pt-BR': BR,
  'pt-PT': PT,
  'zh-CN': CN,
  'zh-TW': TW,
  ja: JP,
  ru: RU,
  it: IT,
  pl: PL,
  ar: SA,
  bn: BD,
  bg: BG,
  hr: HR,
  cs: CZ,
  da: DK,
  nl: NL,
  et: EE,
  fi: FI,
  el: GR,
  he: IL,
  hi: IN,
  hu: HU,
  id: ID,
  ko: KR,
  lv: LV,
  lt: LT,
  ms: MY,
  no: NO,
  fa: IR,
  ro: RO,
  sr: RS,
  sk: SK,
  sl: SI,
  sv: SE,
  th: TH,
  tr: TR,
  uk: UA,
  vi: VN,
}

function Flag({ value }: { value: string }) {
  const FlagSvg = FLAGS[value]
  if (!FlagSvg) return <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
  return (
    <span aria-hidden className="contents">
      <FlagSvg className="w-5 h-auto rounded-[2px] shrink-0" />
    </span>
  )
}

interface LanguageSelectorProps {
  value: string
  onValueChange: (value: string) => void
  className?: string
  /** Locale options to offer. Defaults to the shared UI-language list. */
  options?: { value: string; label: string }[]
}

export function LanguageSelector({ value, onValueChange, className, options }: LanguageSelectorProps) {
  const items = options ?? (LANGUAGES as readonly { value: string; label: string }[])
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((lang) => (
          <SelectItem key={lang.value} value={lang.value}>
            <span className="flex items-center gap-1.5 min-w-0">
              <Flag value={lang.value} />
              <span className="truncate">{lang.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Sentinel for "follow the interface language" (DB null). Not a language code. */
const FOLLOW_UI = 'follow-ui'

interface AgentLanguageSelectorProps {
  /** Agent language code, or null to follow the interface language. */
  value: string | null
  onValueChange: (value: string | null) => void
  className?: string
}

/**
 * Picker for the language Agents speak to the user — decoupled from the UI
 * language. Offers every AGENT_LANGUAGES entry (LLMs speak far more languages
 * than the UI ships) plus a "same as interface" option mapping to null.
 */
export function AgentLanguageSelector({ value, onValueChange, className }: AgentLanguageSelectorProps) {
  const { t } = useTranslation()
  return (
    <Select
      value={value ?? FOLLOW_UI}
      onValueChange={(v) => onValueChange(v === FOLLOW_UI ? null : v)}
    >
      <SelectTrigger className={cn('w-full', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={FOLLOW_UI}>
          <span className="flex items-center gap-1.5 min-w-0">
            <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{t('common.agentLanguageFollowUi')}</span>
          </span>
        </SelectItem>
        {AGENT_LANGUAGES.map((lang) => (
          <SelectItem key={lang.code} value={lang.code}>
            <span className="flex items-center gap-1.5 min-w-0">
              <Flag value={lang.code} />
              <span className="truncate">{lang.nativeName}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
