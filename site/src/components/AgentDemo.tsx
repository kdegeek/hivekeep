/**
 * Interactive hero "your agents" panel. Renders the same panel as before, but
 * every row is clickable: it slides open a drawer that replays a scripted
 * conversation for that agent (user question → a couple of real-looking tool
 * calls with spinners that resolve to checkmarks → a concrete answer). The
 * drawer mirrors the real Hivekeep chat (bubbles, inline tool-call cards, typing
 * dots, a composer) using the site's own design tokens.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Terminal,
  FileCode,
  Globe,
  Search,
  Mail,
  Calendar,
  KeyRound,
  SlidersHorizontal,
  Brain,
  Check,
  Loader2,
  ArrowUp,
  X,
  RotateCcw,
  User,
  Play,
  type LucideIcon,
} from 'lucide-react'
import { AGENT_DEMOS, type DemoToolDomain } from '../data/agent-demos'

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
const avatarSrc = (p: string) => (p.startsWith('http') ? p : `${BASE}${p}`)

const DOMAIN_ICON: Record<DemoToolDomain, LucideIcon> = {
  shell: Terminal,
  filesystem: FileCode,
  browse: Globe,
  search: Search,
  email: Mail,
  calendar: Calendar,
  vault: KeyRound,
  config: SlidersHorizontal,
  memory: Brain,
}

// Very small inline markdown: **bold** and `code`. Enough for the demo copy.
function renderRich(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i}>{p.slice(1, -1)}</code>
    return <span key={i}>{p}</span>
  })
}

interface Props {
  /** Full roster length, for the "{n} active" header count. */
  total: number
  /** Translated chrome labels (transcripts stay English by design). */
  labels?: typeof DEFAULT_LABELS
}

const DEFAULT_LABELS = {
  rosterTitle: '// your agents',
  active: '{count} active',
  seeInAction: 'See {name} in action',
  demoTag: 'demo',
  close: 'Close',
  replay: 'Replay',
  placeholder: 'Message {name}\u2026',
  note: 'This is a scripted preview. The real thing runs on your server.',
  statusOnline: 'online',
  statusWorking: 'working',
  statusIdle: 'idle',
}

export default function AgentDemo({ total, labels = DEFAULT_LABELS }: Props) {
  const [mounted, setMounted] = useState(false)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [visible, setVisible] = useState(false)
  const [shown, setShown] = useState(0)
  const [typing, setTyping] = useState(false)
  const [toolDone, setToolDone] = useState<Record<number, boolean>>({})
  const [finished, setFinished] = useState(false)
  const timers = useRef<number[]>([])

  useEffect(() => {
    setMounted(true)
    return () => timers.current.forEach((t) => clearTimeout(t))
  }, [])

  const clearTimers = () => {
    timers.current.forEach((t) => clearTimeout(t))
    timers.current = []
  }
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  const startDemo = (idx: number) => {
    clearTimers()
    setOpenIdx(idx)
    setShown(0)
    setTyping(false)
    setToolDone({})
    setFinished(false)
    // next frame → trigger slide-in transition
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
  }

  const replay = () => {
    if (openIdx == null) return
    const i = openIdx
    clearTimers()
    setShown(0)
    setTyping(false)
    setToolDone({})
    setFinished(false)
    // force the playback effect to re-run from 0
    setOpenIdx(null)
    requestAnimationFrame(() => setOpenIdx(i))
  }

  const close = () => {
    clearTimers()
    setVisible(false)
    window.setTimeout(() => {
      setOpenIdx(null)
      setShown(0)
      setTyping(false)
      setToolDone({})
      setFinished(false)
    }, 240)
  }

  // Body scroll lock + Escape to close while the drawer is open. Hiding the
  // overflow removes the vertical scrollbar, which would widen the viewport and
  // shift the (centered) page sideways — so we pad the body by the scrollbar
  // width to keep the layout perfectly still.
  useEffect(() => {
    if (openIdx == null) return
    const prevOverflow = document.body.style.overflow
    const prevPad = document.body.style.paddingRight
    const scrollbarW = window.innerWidth - document.documentElement.clientWidth
    document.body.style.overflow = 'hidden'
    if (scrollbarW > 0) document.body.style.paddingRight = `${scrollbarW}px`
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPad
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdx])

  // Sequential playback: reveal one step at a time, pacing by step type.
  useEffect(() => {
    if (openIdx == null) return
    const steps = AGENT_DEMOS[openIdx].steps
    if (shown >= steps.length) {
      setFinished(true)
      return
    }
    const next = steps[shown]
    if (next.kind === 'user') {
      later(() => setShown((s) => s + 1), shown === 0 ? 300 : 550)
    } else if (next.kind === 'text') {
      setTyping(true)
      later(() => {
        setTyping(false)
        setShown((s) => s + 1)
      }, 1100)
    } else {
      const idx = shown
      later(() => {
        setShown((s) => s + 1)
        later(() => setToolDone((d) => ({ ...d, [idx]: true })), 950)
      }, 460)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIdx, shown])

  const demo = openIdx != null ? AGENT_DEMOS[openIdx] : null

  // Group consecutive non-user steps into a single agent "turn" (avatar once).
  function conversation() {
    if (!demo) return null
    const steps = demo.steps.slice(0, shown)
    const blocks: React.ReactNode[] = []
    let i = 0
    while (i < steps.length) {
      const s = steps[i]
      if (s.kind === 'user') {
        blocks.push(
          <div className="dm-row user" key={`u-${i}`}>
            <span className="dm-av dm-av-you">
              <User />
            </span>
            <div className="dm-bubble user">{renderRich(s.text)}</div>
          </div>,
        )
        i++
      } else {
        const group: { node: React.ReactNode }[] = []
        const startI = i
        while (i < steps.length && steps[i].kind !== 'user') {
          const step = steps[i]
          const key = i
          if (step.kind === 'text') {
            group.push({ node: <div className="dm-bubble agent" key={`t-${key}`}>{renderRich(step.text)}</div> })
          } else {
            const Icon = DOMAIN_ICON[step.domain]
            const done = toolDone[key]
            group.push({
              node: (
                <div className="dm-tool" key={`x-${key}`}>
                  <span className={`dm-tool-ic dm-t-${step.domain}`}>
                    <Icon />
                  </span>
                  <span className="dm-tool-nm">
                    {step.name}
                    {step.detail && <span className="dm-tool-detail"> · {step.detail}</span>}
                  </span>
                  <span className="dm-tool-status">
                    {done ? <Check className="dm-ok" /> : <Loader2 className="dm-spin" />}
                  </span>
                </div>
              ),
            })
          }
          i++
        }
        blocks.push(
          <div className="dm-row" key={`a-${startI}`}>
            <img className="dm-av" src={avatarSrc(demo.avatar)} alt={demo.name} width={36} height={36} />
            <div className="dm-col">
              <span className="dm-sender">{demo.name}</span>
              {group.map((g) => g.node)}
            </div>
          </div>,
        )
      }
    }
    if (typing) {
      blocks.push(
        <div className="dm-row" key="typing">
          <img className="dm-av" src={avatarSrc(demo.avatar)} alt={demo.name} width={36} height={36} />
          <div className="dm-col">
            <span className="dm-sender">{demo.name}</span>
            <div className="dm-typing">
              <span className="dm-dot" />
              <span className="dm-dot" />
              <span className="dm-dot" />
            </div>
          </div>
        </div>,
      )
    }
    return blocks
  }

  return (
    <>
      <div className="panel glass">
        <div className="ph-head">
          <span className="t">{labels.rosterTitle}</span>
          <span className="c">{labels.active.replace('{count}', String(total))}</span>
        </div>
        <div>
          {AGENT_DEMOS.map((k, idx) => {
            const st = k.status === 'working' ? 'work' : k.status === 'idle' ? 'idle' : ''
            const label = k.status === 'working' ? labels.statusWorking : k.status === 'idle' ? labels.statusIdle : labels.statusOnline
            return (
              <button
                type="button"
                className="krow dm-krow"
                key={k.name}
                style={{ animationDelay: `${idx * 0.18}s` }}
                onClick={() => startDemo(idx)}
                aria-label={labels.seeInAction.replace('{name}', k.name)}
                title={`“${k.prompt}”`}
              >
                <span className="av">
                  <img className="av-img" src={avatarSrc(k.avatar)} alt={k.name} width={34} height={34} />
                </span>
                <span className="meta2">
                  <span className="nm">{k.name}</span>
                  <span className="dm">{k.domain}</span>
                </span>
                <span className={`st ${st}`}>
                  <span className="pip" />
                  {label}
                </span>
                <span className="dm-go" aria-hidden="true">
                  <Play />
                </span>
              </button>
            )
          })}
        </div>
        <div className="dm-hint">
          <Play /> Click an agent to watch it work
        </div>
      </div>

      {mounted &&
        createPortal(
          <div className={`dm-overlay${visible ? ' open' : ''}`} aria-hidden={openIdx == null}>
            <div className="dm-scrim" onClick={close} />
            <aside
              className={`dm-drawer${visible ? ' open' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-label={demo ? `${demo.name} demo conversation` : 'agent demo'}
            >
              {demo && (
                <>
                  <header className="dm-head">
                    <img className="dm-head-av" src={avatarSrc(demo.avatar)} alt={demo.name} width={40} height={40} />
                    <div className="dm-head-meta">
                      <div className="dm-head-top">
                        <span className="dm-head-nm">{demo.name}</span>
                        <span className={`dm-chip ${demo.status === 'working' ? 'work' : ''}`}>
                          <span className="pip" />
                          {demo.status === 'working' ? labels.statusWorking : demo.status === 'idle' ? labels.statusIdle : labels.statusOnline}
                        </span>
                      </div>
                      <span className="dm-head-role">{demo.role}</span>
                    </div>
                    <span className="dm-demo-tag">{labels.demoTag}</span>
                    <button type="button" className="dm-close" onClick={close} aria-label={labels.close}>
                      <X />
                    </button>
                  </header>

                  <div className="dm-body">
                    {conversation()}
                    {finished && (
                      <div className="dm-replay-wrap">
                        <button type="button" className="dm-replay" onClick={replay}>
                          <RotateCcw /> {labels.replay}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="dm-input" aria-hidden="true">
                    <div className="dm-input-box">
                      <span className="dm-input-ph">{labels.placeholder.replace('{name}', demo.name)}</span>
                      <span className="dm-send">
                        <ArrowUp />
                      </span>
                    </div>
                    <span className="dm-input-note">{labels.note}</span>
                  </div>
                </>
              )}
            </aside>
          </div>,
          document.body,
        )}
    </>
  )
}
