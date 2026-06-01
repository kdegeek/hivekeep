import type { CalendarProvider } from '@/server/calendar/types'

const registry = new Map<string, CalendarProvider>()

export function registerCalendarProvider(provider: CalendarProvider): void {
  if (registry.has(provider.type)) {
    throw new Error(`Calendar provider already registered: ${provider.type}`)
  }
  registry.set(provider.type, provider)
}

export function unregisterCalendarProvider(type: string): void {
  registry.delete(type)
}

export function getCalendarProvider(type: string): CalendarProvider | undefined {
  return registry.get(type)
}

export function listCalendarProviders(): CalendarProvider[] {
  return [...registry.values()]
}
