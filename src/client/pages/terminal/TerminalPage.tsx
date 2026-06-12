import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { SquareTerminal, Plus, Plug, MoreHorizontal, PanelLeft, Pencil, Trash2 } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { useAuth } from '@/client/hooks/useAuth'
import { useSSE, useSSEResync } from '@/client/hooks/useSSE'
import { PageHeader } from '@/client/components/layout/PageHeader'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { EmptyState } from '@/client/components/common/EmptyState'
import { Sheet, SheetContent, SheetTitle } from '@/client/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/client/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/client/components/ui/alert-dialog'
import { api, ApiRequestError, getErrorMessage } from '@/client/lib/api'
import { cn } from '@/client/lib/utils'
import type { TerminalSessionDTO } from '@/shared/types'

/**
 * Admin-only web terminal on the host machine (or the container under Docker).
 *
 * tmux-like sessions: shells run server-side and survive disconnects, so a
 * session started on the desktop can be picked up from the phone. The sidebar
 * lists the user's live sessions (synced across devices via the
 * `terminal:sessions-changed` SSE event); closing one there kills its shell.
 * xterm.js renders; a WebSocket at /api/terminal/ws carries input/output.
 */

const SESSION_KEY = 'hivekeep.terminal.sessionId'
const PING_INTERVAL_MS = 30_000

type Status = 'connecting' | 'connected' | 'disconnected' | 'ended' | 'disabled'

// Fixed dark theme (One Dark-ish): terminals stay dark in both app modes, like
// embedded terminals in IDEs. xterm needs concrete colors, not CSS variables.
const TERMINAL_THEME = {
  background: '#0d1117',
  foreground: '#d6dde6',
  cursor: '#d6dde6',
  cursorAccent: '#0d1117',
  selectionBackground: 'rgba(110, 140, 180, 0.35)',
  black: '#1c2128',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d6dde6',
  brightBlack: '#5c6370',
  brightRed: '#ef7d85',
  brightGreen: '#a9d389',
  brightYellow: '#f0cc8b',
  brightBlue: '#74bcff',
  brightMagenta: '#d68aef',
  brightCyan: '#66c6d2',
  brightWhite: '#f0f4f8',
}

function InlineRenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="h-6 min-w-0 flex-1 px-1.5 text-sm"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onSubmit(value.trim())
        if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => {
        if (value.trim() && value.trim() !== initial) onSubmit(value.trim())
        else onCancel()
      }}
    />
  )
}

export function TerminalPage() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const statusRef = useRef<Status>('connecting')
  const [sessions, setSessions] = useState<TerminalSessionDTO[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [closeTarget, setCloseTarget] = useState<TerminalSessionDTO | null>(null)

  const setStatusBoth = useCallback((s: Status) => {
    statusRef.current = s
    setStatus(s)
  }, [])

  const setActiveBoth = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
    if (id) sessionStorage.setItem(SESSION_KEY, id)
    else sessionStorage.removeItem(SESSION_KEY)
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      const res = await api.get<{ sessions: TerminalSessionDTO[] }>('/terminal/sessions')
      setSessions(res.sessions)
    } catch {
      // Transient; the next SSE event or resync will repair the list.
    }
  }, [])

  // The sidebar is shared state across the user's devices: the server pushes
  // the fresh list on every lifecycle change, and we refetch on SSE resume
  // (events are not replayed after a disconnect/locked phone).
  useSSE({
    'terminal:sessions-changed': (data) => {
      const list = (data as { sessions?: TerminalSessionDTO[] }).sessions
      if (list) setSessions(list)
    },
  })
  useSSEResync(refreshSessions)

  const closeSocket = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current)
      pingRef.current = null
    }
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onclose = null
      ws.close()
    }
  }, [])

  /** Open the WS: attach to `sessionId`, or create a fresh shell when null. */
  const connect = useCallback((sessionId: string | null) => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    closeSocket()
    setStatusBoth('connecting')

    const params = new URLSearchParams({ cols: String(term.cols), rows: String(term.rows) })
    if (sessionId) params.set('sessionId', sessionId)
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/api/terminal/ws?${params}`)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      let msg: { type: string; data?: string; sessionId?: string; resumed?: boolean; code?: string }
      try {
        msg = JSON.parse(String(evt.data))
      } catch {
        return
      }
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data)
      } else if (msg.type === 'ready') {
        if (msg.sessionId) setActiveBoth(msg.sessionId)
        // A resumed session replays its full scrollback right after `ready`,
        // so wipe whatever the previous attachment left on screen.
        if (msg.resumed) term.reset()
        setStatusBoth('connected')
        term.focus()
      } else if (msg.type === 'exit') {
        setActiveBoth(null)
        setStatusBoth('ended')
      } else if (msg.type === 'error') {
        term.writeln(`\r\n${t('terminal.maxSessions')}`)
        setActiveBoth(null)
        setStatusBoth('ended')
      }
    }
    ws.onclose = () => {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
      if (wsRef.current !== ws) return
      wsRef.current = null
      // A close after 'exit' is expected teardown; anything else is a drop.
      if (statusRef.current !== 'ended') setStatusBoth('disconnected')
    }
    // Periodic ping: keeps Bun's WS idle timeout and reverse proxies from
    // dropping a shell that is just sitting at a prompt.
    pingRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
    }, PING_INTERVAL_MS)
  }, [closeSocket, setStatusBoth, setActiveBoth, t])

  const selectSession = useCallback((id: string) => {
    setSheetOpen(false)
    if (id === activeIdRef.current && statusRef.current === 'connected') return
    termRef.current?.reset()
    connect(id)
  }, [connect])

  const newSession = useCallback(() => {
    setSheetOpen(false)
    termRef.current?.reset()
    connect(null)
  }, [connect])

  const renameSession = useCallback(async (id: string, name: string) => {
    setRenamingId(null)
    try {
      await api.patch(`/terminal/sessions/${id}`, { name })
      // Sidebar updates via the SSE event.
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }, [])

  const confirmClose = useCallback(async () => {
    const target = closeTarget
    setCloseTarget(null)
    if (!target) return
    try {
      // Killing the active session surfaces as a WS 'exit' message, which
      // drives the ended state — no special-casing needed here.
      await api.delete(`/terminal/sessions/${target.id}`)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }, [closeTarget])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let disposed = false
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: TERMINAL_THEME,
      scrollback: 5000,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(el)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    term.onData((data) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    })

    const observer = new ResizeObserver(() => {
      if (!disposed) fit.fit()
    })
    observer.observe(el)

    // Confirm the feature is enabled before opening the socket (a WS rejection
    // carries no error body, the REST probe does), then resume the last-used
    // session if it is still alive, else the most recent one, else a new shell.
    api
      .get<{ enabled: boolean }>('/terminal/status')
      .then(() => api.get<{ sessions: TerminalSessionDTO[] }>('/terminal/sessions'))
      .then((res) => {
        if (disposed) return
        setSessions(res.sessions)
        const last = sessionStorage.getItem(SESSION_KEY)
        const pick = res.sessions.find((s) => s.id === last) ?? res.sessions[res.sessions.length - 1]
        connect(pick?.id ?? null)
      })
      .catch((err) => {
        if (disposed) return
        if (err instanceof ApiRequestError && err.code === 'TERMINAL_DISABLED') setStatusBoth('disabled')
        else setStatusBoth('disconnected')
      })

    return () => {
      disposed = true
      observer.disconnect()
      closeSocket()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [connect, closeSocket, setStatusBoth])

  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  const statusLabel: Record<Exclude<Status, 'disabled'>, string> = {
    connecting: t('terminal.status.connecting'),
    connected: t('terminal.status.connected'),
    disconnected: t('terminal.status.disconnected'),
    ended: t('terminal.status.ended'),
  }

  const sessionsPanel = (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('terminal.sessions.title')}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={newSession} title={t('terminal.newSession')} aria-label={t('terminal.newSession')}>
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t('terminal.sessions.empty')}</p>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => selectSession(session.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') selectSession(session.id)
              }}
              className={cn(
                'group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                session.id === activeId
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted',
              )}
            >
              <span
                aria-hidden
                className={cn('size-1.5 shrink-0 rounded-full', session.attached ? 'bg-success' : 'bg-muted-foreground/40')}
                title={session.attached ? t('terminal.sessions.attached') : t('terminal.sessions.detached')}
              />
              {renamingId === session.id ? (
                <InlineRenameInput
                  initial={session.name}
                  onSubmit={(name) => void renameSession(session.id, name)}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{session.name}</span>
              )}
              {/* "⋯" — hover-revealed on desktop, always visible below md (touch has no hover) */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="rounded-sm p-0.5 text-muted-foreground opacity-100 hover:bg-muted-foreground/20 hover:text-foreground md:opacity-0 md:group-hover:opacity-100 md:data-[state=open]:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`actions ${session.name}`}
                  >
                    <MoreHorizontal className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-44" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={() => setRenamingId(session.id)}>
                    <Pencil className="size-4" />
                    {t('terminal.sessions.rename')}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => setCloseTarget(session)}>
                    <Trash2 className="size-4" />
                    {t('terminal.sessions.close')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>
    </div>
  )

  return (
    <div className="surface-base flex h-full flex-col overflow-hidden">
      <PageHeader
        icon={SquareTerminal}
        title={t('terminal.title')}
        leading={
          status !== 'disabled' ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => setSheetOpen(true)}
              aria-label={t('terminal.sessions.title')}
            >
              <PanelLeft className="size-4" />
            </Button>
          ) : undefined
        }
        actions={
          status !== 'disabled' ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className={cn(
                    'size-2 rounded-full',
                    status === 'connected' && 'bg-success',
                    status === 'connecting' && 'animate-pulse bg-warning',
                    (status === 'disconnected' || status === 'ended') && 'bg-destructive',
                  )}
                />
                <span className="hidden sm:inline">{statusLabel[status]}</span>
              </span>
              {status === 'disconnected' && activeId && (
                <Button variant="outline" size="sm" onClick={() => connect(activeId)}>
                  <Plug className="size-4" />
                  {t('terminal.reconnect')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={newSession}>
                <Plus className="size-4" />
                <span className="hidden sm:inline">{t('terminal.newSession')}</span>
              </Button>
            </>
          ) : undefined
        }
      />
      {status === 'disabled' ? (
        <div className="p-4 sm:p-6">
          <EmptyState
            icon={SquareTerminal}
            title={t('terminal.disabled.title')}
            description={t('terminal.disabled.description')}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-52 shrink-0 border-r border-border md:flex md:flex-col lg:w-60">
            {sessionsPanel}
          </aside>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="left" className="w-72 p-0 md:hidden">
              <SheetTitle className="sr-only">{t('terminal.sessions.title')}</SheetTitle>
              {sessionsPanel}
            </SheetContent>
          </Sheet>
          <main className="min-h-0 min-w-0 flex-1 p-2 sm:p-4">
            <div
              className="h-full overflow-hidden rounded-lg border border-border p-2"
              style={{ backgroundColor: TERMINAL_THEME.background }}
            >
              <div ref={containerRef} className="h-full w-full" />
            </div>
          </main>
        </div>
      )}

      <AlertDialog open={closeTarget !== null} onOpenChange={(open) => !open && setCloseTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('terminal.sessions.closeConfirmTitle', { name: closeTarget?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('terminal.sessions.closeConfirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmClose()}>
              {t('terminal.sessions.close')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
