# KinBot — Calendar

Read **and write** access to calendars (Google, Outlook, iCloud, generic CalDAV)
so Kins can answer "what's on my week?" and create / move / cancel events.

## Provider family (SDK)

`CalendarProvider` lives in `@kinbot-developer/sdk` (v0.9.0), alongside
`EmailProvider` / `ContactsProvider`. The host detects the family by the presence
of `listEvents` + `listCalendars` (`detectProviderFamily`), so a plugin
contributes a calendar provider like any other.

```ts
interface CalendarProvider extends ProviderUIHints {
  type, displayName, configSchema, capabilities, oauth?
  authenticate(config): Promise<AuthResult>
  listCalendars(config): Promise<CalendarRef[]>
  listEvents(opts, config): Promise<EventListResult>
  getEvent(calendarId, eventId, config): Promise<CalendarEvent>
  createEvent?(params, config): Promise<CalendarEvent>   // write — optional
  updateEvent?(params, config): Promise<CalendarEvent>
  deleteEvent?(calendarId, eventId, config): Promise<void>
}
```

Times are **ISO 8601** strings; all-day events set `allDay` with date-only
`start`/`end`. An event carries its `calendarId` so the Kin can pass it back to
get / update / delete. Registry: `src/server/calendar/registry.ts`; built-ins
register at boot via `registerBuiltinCalendarProviders()`.

## Built-in providers

| type | calendar | auth | scope / endpoint |
|---|---|---|---|
| `gmail` | Google Calendar API v3 | OAuth | `auth/calendar` |
| `microsoft` | Graph `/me/events` + `/calendarView` | OAuth | `Calendars.ReadWrite` |
| `icloud` | CalDAV (`caldav.icloud.com`) | app password | — |
| `imap` | CalDAV (optional `caldav_url` on the IMAP account) | password | server URL |
| `caldav` | generic CalDAV (calendar-only) | password | server URL |

Keyed by the **same `type`** as the email/contacts providers → one Google /
Microsoft / iCloud account serves mail + contacts + calendar from a single row
(`capabilities: ['email','contacts','calendar']`). CalDAV uses `ical.js` to parse
VEVENTs and to generate them on write (shared `caldav-core.ts`). Graph dateTimes
carry no offset, so writes are normalized to UTC.

> ⚠️ Scope note: CalDAV create/update write SUMMARY / DTSTART / DTEND /
> DESCRIPTION / LOCATION. Attendee **invitations** over CalDAV are out of scope
> (read-only mapping of existing ATTENDEEs); use Google / Microsoft for invites.

## Connect (capability-aware)

OAuth: `POST /api/email-accounts/connect/:type` with `{ capabilities }` requests
the **union** of email + contacts + calendar scopes in one consent. Config
(CalDAV): `POST /api/connected-accounts/connect-config/:type` validates every
requested capability before writing one row. `resolveCalendarProvider` reuses the
account's refresh token (OAuth) or credentials (CalDAV).

## Kin tools + toolbox

Native tools (`src/server/tools/calendar-tools.ts`), gated by the built-in
`calendar` toolbox, tool domain `calendar`:

| Tool | Flags | |
|---|---|---|
| `list_calendar_accounts` | readOnly | accounts this Kin may use |
| `list_calendars` | readOnly | calendars in an account |
| `list_events` | readOnly | events in a time range |
| `get_event` | readOnly | one event |
| `create_event` | destructive | add an event |
| `update_event` | destructive | change set fields |
| `delete_event` | destructive | remove an event |

## UI

Settings → **Connected Accounts**: OAuth providers show an **"Also access
calendar"** toggle; config providers (iCloud) expose Mail / Contacts / **Calendar**
capability toggles. Accounts show a **Calendar** capability badge.

## Out of scope (fast-follows)

Recurring-event editing nuances (this/all occurrences) · CalDAV attendee invites ·
free/busy queries · timezone-aware all-day windows on Graph.
