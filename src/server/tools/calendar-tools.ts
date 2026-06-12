/**
 * Native calendar tools exposed to Agents (read + write).
 *
 *  - list_calendar_accounts — discovery: connected calendar accounts.
 *  - list_calendars         — calendars within an account.
 *  - list_events            — events in a time range.
 *  - get_event              — one event by id.
 *  - create_event           — add an event.
 *  - update_event           — change an event (only set fields).
 *  - delete_event           — remove an event.
 *
 * Every tool resolves an account via `resolveCalendarProvider` (explicit slug →
 * first valid), enforcing the per-account allow-list. Times are ISO 8601.
 */
import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import { resolveCalendarProvider, listCalendarAccounts } from '@/server/services/calendar-accounts'
import type { ToolRegistration } from '@/server/tools/types'

const accountField = z
  .string()
  .optional()
  .describe('Slug of the calendar account to use. Omit to use the first account. Discover via list_calendar_accounts.')

const calendarField = z
  .string()
  .optional()
  .describe('Calendar id (from list_calendars). Omit to use the primary calendar.')

function toErr(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) }
}

// ─── list_calendar_accounts ──────────────────────────────────────────────────

export const listCalendarAccountsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List the calendar accounts this Agent can use (slug, label, type).',
      inputSchema: z.object({}),
      execute: async () => {
        const accounts = await listCalendarAccounts(ctx.agentId)
        return { accounts: accounts.map((a) => ({ slug: a.slug, accountLabel: a.accountLabel, type: a.type, isValid: a.isValid })) }
      },
    }),
}

// ─── list_calendars ──────────────────────────────────────────────────────────

export const listCalendarsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List the calendars within a connected account (id, name, primary, read-only).',
      inputSchema: z.object({ account: accountField }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          return { account: account.slug, calendars: await provider.listCalendars(config) }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── list_events ─────────────────────────────────────────────────────────────

export const listEventsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List events in a time range (default: from now). Returns id, calendarId, title, start, end, location, attendees. ' +
        'Use the id + calendarId for get/update/delete.',
      inputSchema: z.object({
        account: accountField,
        calendar: calendarField,
        time_min: z.string().optional().describe('ISO 8601 lower bound. Default: now.'),
        time_max: z.string().optional().describe('ISO 8601 upper bound.'),
        limit: z.number().int().min(1).max(250).optional().describe('Max events. Default 25.'),
        query: z.string().optional().describe('Free-text filter over title/description/location.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          const res = await provider.listEvents(
            { calendarId: args.calendar, timeMin: args.time_min, timeMax: args.time_max, limit: args.limit, query: args.query },
            config,
          )
          return { account: account.slug, events: res.events, nextPageToken: res.nextPageToken }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── get_event ───────────────────────────────────────────────────────────────

export const getEventTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Get one event by id (and its calendar id, from list_events).',
      inputSchema: z.object({
        account: accountField,
        calendar_id: z.string().describe('Calendar id the event belongs to (from list_events).'),
        event_id: z.string().describe('Event id (from list_events).'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          return { account: account.slug, event: await provider.getEvent(args.calendar_id, args.event_id, config) }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

const eventFields = {
  title: z.string().describe('Event title.'),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().describe('ISO 8601 start (e.g. 2026-06-10T14:00:00Z, or 2026-06-10 for all-day).'),
  end: z.string().describe('ISO 8601 end.'),
  all_day: z.boolean().optional().describe('All-day event (start/end are dates).'),
  time_zone: z.string().optional().describe('IANA time zone (e.g. Europe/Paris).'),
  attendees: z.array(z.object({ email: z.string(), name: z.string().optional() })).optional(),
}

// ─── create_event ────────────────────────────────────────────────────────────

export const createEventTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Create a calendar event. Times are ISO 8601.',
      inputSchema: z.object({ account: accountField, calendar: calendarField, ...eventFields }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          if (!provider.createEvent) return { error: `Account "${account.slug}" does not support creating events` }
          const event = await provider.createEvent(
            {
              calendarId: args.calendar,
              title: args.title,
              description: args.description,
              location: args.location,
              start: args.start,
              end: args.end,
              allDay: args.all_day,
              timeZone: args.time_zone,
              attendees: args.attendees,
            },
            config,
          )
          return { account: account.slug, event }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── update_event ────────────────────────────────────────────────────────────

export const updateEventTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Update an event — only the fields you set are changed. Times are ISO 8601.',
      inputSchema: z.object({
        account: accountField,
        calendar_id: z.string().describe('Calendar id the event belongs to.'),
        event_id: z.string().describe('Event id to update.'),
        title: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
        start: z.string().optional(),
        end: z.string().optional(),
        all_day: z.boolean().optional(),
        time_zone: z.string().optional(),
        attendees: z.array(z.object({ email: z.string(), name: z.string().optional() })).optional(),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          if (!provider.updateEvent) return { error: `Account "${account.slug}" does not support updating events` }
          const event = await provider.updateEvent(
            {
              calendarId: args.calendar_id,
              eventId: args.event_id,
              title: args.title,
              description: args.description,
              location: args.location,
              start: args.start,
              end: args.end,
              allDay: args.all_day,
              timeZone: args.time_zone,
              attendees: args.attendees,
            },
            config,
          )
          return { account: account.slug, event }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}

// ─── delete_event ────────────────────────────────────────────────────────────

export const deleteEventTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete an event by id (and its calendar id).',
      inputSchema: z.object({
        account: accountField,
        calendar_id: z.string().describe('Calendar id the event belongs to.'),
        event_id: z.string().describe('Event id to delete.'),
      }),
      execute: async (args) => {
        try {
          const { provider, config, account } = await resolveCalendarProvider({ slug: args.account, agentId: ctx.agentId })
          if (!provider.deleteEvent) return { error: `Account "${account.slug}" does not support deleting events` }
          await provider.deleteEvent(args.calendar_id, args.event_id, config)
          return { account: account.slug, deleted: true }
        } catch (err) {
          return toErr(err)
        }
      },
    }),
}
