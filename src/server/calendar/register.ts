import { registerCalendarProvider } from '@/server/calendar/registry'
import { googleCalendarProvider } from '@/server/calendar/providers/google'
import { microsoftCalendarProvider } from '@/server/calendar/providers/microsoft'
import { icloudCalendarProvider } from '@/server/calendar/providers/icloud'
import { genericCalDavProvider } from '@/server/calendar/providers/generic-caldav'

/** Register the built-in calendar providers. Called once at server boot,
 *  alongside the other provider families (see src/server/index.ts). */
export function registerBuiltinCalendarProviders(): void {
  registerCalendarProvider(googleCalendarProvider)
  registerCalendarProvider(microsoftCalendarProvider)
  registerCalendarProvider(icloudCalendarProvider)
  registerCalendarProvider(genericCalDavProvider)
}
