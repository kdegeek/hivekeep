// Site i18n: static dictionaries per locale, one page tree per locale.
// English is the source of truth (locales/en.ts); every other locale file is
// typed against it so a missing key is a type error in the editor and a build
// error under `astro check`.
import en from './locales/en'

export const LOCALES = ['en', 'fr', 'es', 'de', 'pt-BR', 'zh-CN', 'ja', 'ru', 'it', 'pl'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

/** Native display names for the navbar switcher. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
  'zh-CN': '简体中文',
  ja: '日本語',
  ru: 'Русский',
  it: 'Italiano',
  pl: 'Polski',
}

/** Open Graph locale identifiers. */
export const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  fr: 'fr_FR',
  es: 'es_ES',
  de: 'de_DE',
  'pt-BR': 'pt_BR',
  'zh-CN': 'zh_CN',
  ja: 'ja_JP',
  ru: 'ru_RU',
  it: 'it_IT',
  pl: 'pl_PL',
}

export type Dict = typeof en

const loaders = import.meta.glob<{ default: Dict }>('./locales/*.ts', { eager: true })

const dictionaries: Partial<Record<Locale, Dict>> = {}
for (const [path, mod] of Object.entries(loaders)) {
  const code = path.replace(/^.*\//, '').replace(/\.ts$/, '') as Locale
  dictionaries[code] = mod.default
}

/** Dictionary for a locale; unknown/missing locales fall back to English. */
export function getDict(locale: string): Dict {
  return dictionaries[locale as Locale] ?? en
}

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value)
}

/** Non-default locales (the ones that get a /<locale>/ URL prefix). */
export const PREFIXED_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE)

/** Localized URL for a base-relative path ('/install' -> '/fr/install'). */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  return locale === DEFAULT_LOCALE ? clean || '/' : `/${locale}${clean === '/' ? '/' : clean}`
}

/** Split a pathname into its locale and the locale-free path. */
export function parseLocaleFromPath(pathname: string): { locale: Locale; path: string } {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/)
  if (match && isLocale(match[1])) {
    return { locale: match[1], path: match[2] || '/' }
  }
  return { locale: DEFAULT_LOCALE, path: pathname || '/' }
}
