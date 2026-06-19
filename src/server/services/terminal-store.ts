import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { terminalSessions } from '@/server/db/schema'
import type {
  PersistedTerminalSession,
  TerminalPersistence,
} from '@/server/services/terminal-sessions'

/**
 * DB-backed implementation of the terminal session persistence interface.
 *
 * Kept separate from `terminal-sessions.ts` so that module has no direct DB
 * dependency (it stays a pure, unit-testable state machine). Wired at boot via
 * `setTerminalPersistence`.
 */
export function createDbTerminalPersistence(): TerminalPersistence {
  return {
    loadAll(): PersistedTerminalSession[] {
      return db
        .select()
        .from(terminalSessions)
        .all()
        .map((row) => ({
          id: row.id,
          userId: row.userId,
          name: row.name,
          createdAt: row.createdAt,
          lastActiveAt: row.lastActiveAt,
          lastCwd: row.lastCwd ?? null,
          scrollback: row.scrollback,
          backend: row.backend === 'tmux' ? 'tmux' : 'pty',
          tmuxName: row.tmuxName ?? null,
        }))
    },

    upsert(row: PersistedTerminalSession): void {
      db.insert(terminalSessions)
        .values({
          id: row.id,
          userId: row.userId,
          name: row.name,
          backend: row.backend,
          tmuxName: row.tmuxName,
          lastCwd: row.lastCwd,
          scrollback: row.scrollback,
          createdAt: row.createdAt,
          lastActiveAt: row.lastActiveAt,
        })
        .onConflictDoUpdate({
          target: terminalSessions.id,
          set: {
            name: row.name,
            backend: row.backend,
            tmuxName: row.tmuxName,
            lastCwd: row.lastCwd,
            scrollback: row.scrollback,
            lastActiveAt: row.lastActiveAt,
          },
        })
        .run()
    },

    remove(id: string): void {
      db.delete(terminalSessions).where(eq(terminalSessions.id, id)).run()
    },
  }
}
