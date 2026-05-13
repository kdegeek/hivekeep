/**
 * PluginIcon: renders an icon from either lucide-react (default) or
 * react-icons (dynamic by collection).
 *
 * Naming convention:
 *   - no slash: a Lucide icon name, e.g. `"Sparkles"`, `"CheckCircle2"`.
 *   - one slash: `"<collection>/<ComponentName>"`, e.g. `"bs/BsClaude"`,
 *     `"si/SiOpenai"`. The collection is dynamically imported on demand
 *     so the initial bundle does not ship the full react-icons catalogue.
 *
 * The collection promise is cached in module scope so subsequent renders
 * of icons from the same collection do not re-trigger the dynamic import.
 * When the collection or the component name cannot be resolved we fall
 * back to a Lucide `HelpCircle` icon and warn once per offending id.
 *
 * SSR is not a concern here: plugin cards only render client-side in the
 * chat panel.
 */

import { memo, useEffect, useRef, useState, type ComponentType } from 'react'
import { HelpCircle, type LucideIcon } from 'lucide-react'
import * as LucideIcons from 'lucide-react'

interface PluginIconProps {
  name: string
  color?: string
  size?: number
  className?: string
}

interface ReactIconProps {
  color?: string
  size?: number | string
  className?: string
}

type IconModule = Record<string, ComponentType<ReactIconProps>>

const collectionCache = new Map<string, Promise<IconModule>>()
const warnedNames = new Set<string>()

function warnOnce(name: string, reason: string) {
  if (warnedNames.has(name)) return
  warnedNames.add(name)
  // eslint-disable-next-line no-console
  console.warn(`[PluginIcon] ${reason}: "${name}"`)
}

/**
 * Vite needs a static fragment in the dynamic import path to know which
 * modules to pre-bundle. The switch covers the collections we expect
 * plugins to use; unknown collections fall through to a warning and the
 * Lucide fallback. Add new entries here as needed.
 */
function loadCollection(collection: string): Promise<IconModule> | null {
  const cached = collectionCache.get(collection)
  if (cached) return cached

  let raw: Promise<unknown> | null = null
  switch (collection) {
    case 'ai': raw = import('react-icons/ai'); break
    case 'bi': raw = import('react-icons/bi'); break
    case 'bs': raw = import('react-icons/bs'); break
    case 'cg': raw = import('react-icons/cg'); break
    case 'di': raw = import('react-icons/di'); break
    case 'fa': raw = import('react-icons/fa'); break
    case 'fa6': raw = import('react-icons/fa6'); break
    case 'fc': raw = import('react-icons/fc'); break
    case 'fi': raw = import('react-icons/fi'); break
    case 'gi': raw = import('react-icons/gi'); break
    case 'go': raw = import('react-icons/go'); break
    case 'gr': raw = import('react-icons/gr'); break
    case 'hi': raw = import('react-icons/hi'); break
    case 'hi2': raw = import('react-icons/hi2'); break
    case 'im': raw = import('react-icons/im'); break
    case 'io': raw = import('react-icons/io'); break
    case 'io5': raw = import('react-icons/io5'); break
    case 'lia': raw = import('react-icons/lia'); break
    case 'lu': raw = import('react-icons/lu'); break
    case 'md': raw = import('react-icons/md'); break
    case 'pi': raw = import('react-icons/pi'); break
    case 'ri': raw = import('react-icons/ri'); break
    case 'rx': raw = import('react-icons/rx'); break
    case 'si': raw = import('react-icons/si'); break
    case 'sl': raw = import('react-icons/sl'); break
    case 'tb': raw = import('react-icons/tb'); break
    case 'tfi': raw = import('react-icons/tfi'); break
    case 'ti': raw = import('react-icons/ti'); break
    case 'vsc': raw = import('react-icons/vsc'); break
    case 'wi': raw = import('react-icons/wi'); break
    default:
      return null
  }

  const promise = raw as Promise<IconModule>
  collectionCache.set(collection, promise)
  return promise
}

function LucideRender({ name, color, size = 16, className }: PluginIconProps) {
  const Icon = (LucideIcons as unknown as Record<string, LucideIcon | undefined>)[name]
  if (!Icon) {
    warnOnce(name, 'Lucide icon not found')
    return <HelpCircle size={size} color={color} className={className} />
  }
  return <Icon size={size} color={color} className={className} />
}

function ReactIconRender({ name, color, size = 16, className }: PluginIconProps) {
  const [collection, componentName] = name.split('/')
  const [Component, setComponent] = useState<ComponentType<ReactIconProps> | null>(null)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!collection || !componentName) {
      warnOnce(name, 'Malformed react-icons id (expected "collection/Name")')
      setFailed(true)
      return
    }
    const promise = loadCollection(collection)
    if (!promise) {
      warnOnce(name, `Unknown react-icons collection "${collection}"`)
      setFailed(true)
      return
    }
    let cancelled = false
    promise
      .then((mod) => {
        if (cancelled || !mounted.current) return
        const Comp = mod[componentName]
        if (!Comp) {
          warnOnce(name, `react-icons component "${componentName}" not found in "${collection}"`)
          setFailed(true)
          return
        }
        setComponent(() => Comp)
      })
      .catch((err) => {
        if (cancelled || !mounted.current) return
        warnOnce(name, `Failed to load react-icons collection "${collection}": ${err instanceof Error ? err.message : String(err)}`)
        setFailed(true)
      })
    return () => { cancelled = true }
  }, [collection, componentName, name])

  if (failed) {
    return <HelpCircle size={size} color={color} className={className} />
  }
  if (!Component) {
    // Invisible placeholder of the same size to prevent layout shift while
    // the dynamic import resolves.
    return (
      <span
        aria-hidden
        className={className}
        style={{ display: 'inline-block', width: size, height: size }}
      />
    )
  }
  return <Component size={size} color={color} className={className} />
}

export const PluginIcon = memo(function PluginIcon(props: PluginIconProps) {
  if (!props.name) return null
  if (props.name.includes('/')) {
    return <ReactIconRender {...props} />
  }
  return <LucideRender {...props} />
})
