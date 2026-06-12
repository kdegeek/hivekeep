/**
 * THEMED PRIMITIVES KIT for custom-tool result renderers.
 *
 * A custom tool's renderer (a server-bundled React component loaded at runtime)
 * receives this object as its `ui` prop. It's a tiny, dependency-free set of
 * presentational components created with the HOST React. Every primitive styles
 * itself with INLINE styles using `var(--color-*)` design tokens, so a renderer
 * composing these building blocks auto-themes with the app (dark/light + the
 * active palette) WITHOUT needing Tailwind utility classes (which are NOT present
 * in the host CSS for arbitrary classes a renderer might invent) or host imports.
 *
 * Renderers may also style inline directly with the same tokens; the kit just
 * removes the boilerplate for the common shapes (card, header, badge, stat,
 * key/values, table, code block).
 *
 * Keep these intentionally small and self-contained — they are the public,
 * documented contract for renderer authors (see prompt-builder.ts / prompt-system.md).
 */
import type { CSSProperties, ReactNode } from 'react'

// ─── Shared token helpers ─────────────────────────────────────────────────────

const FONT_SANS = 'inherit'
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'destructive' | 'info' | 'muted'

const BADGE_TOKENS: Record<BadgeVariant, { bg: string; fg: string }> = {
  default: { bg: 'var(--color-secondary)', fg: 'var(--color-secondary-foreground)' },
  primary: { bg: 'var(--color-primary)', fg: 'var(--color-primary-foreground)' },
  success: { bg: 'var(--color-success)', fg: 'var(--color-success-foreground)' },
  warning: { bg: 'var(--color-warning)', fg: 'var(--color-warning-foreground)' },
  destructive: { bg: 'var(--color-destructive)', fg: 'var(--color-destructive-foreground)' },
  info: { bg: 'var(--color-info)', fg: 'var(--color-info-foreground)' },
  muted: { bg: 'var(--color-muted)', fg: 'var(--color-muted-foreground)' },
}

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Outer surface. A bordered, padded card that follows the card token. */
function Card({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: 'var(--color-card)',
        color: 'var(--color-card-foreground)',
        border: '1px solid var(--color-border)',
        borderRadius: 10,
        padding: 12,
        fontFamily: FONT_SANS,
        fontSize: 13,
        lineHeight: 1.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** A titled section. `title` renders as a small header; `action` sits on the right. */
function Section({
  title,
  action,
  children,
  style,
}: {
  title?: ReactNode
  action?: ReactNode
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {(title || action) && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {title ? (
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--color-muted-foreground)',
              }}
            >
              {title}
            </div>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/** Standalone header / heading line. */
function Header({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-foreground)', ...style }}>{children}</div>
  )
}

/** Horizontal row. `gap` and `align`/`justify` are convenience props. */
function Row({
  children,
  gap = 8,
  align = 'center',
  justify = 'flex-start',
  wrap = false,
  style,
}: {
  children?: ReactNode
  gap?: number
  align?: CSSProperties['alignItems']
  justify?: CSSProperties['justifyContent']
  wrap?: boolean
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        gap,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** Vertical stack. */
function Stack({
  children,
  gap = 8,
  style,
}: {
  children?: ReactNode
  gap?: number
  style?: CSSProperties
}) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>{children}</div>
}

/** Small pill badge in a token-driven color variant. */
function Badge({
  children,
  variant = 'default',
  style,
}: {
  children?: ReactNode
  variant?: BadgeVariant
  style?: CSSProperties
}) {
  const tokens = BADGE_TOKENS[variant] ?? BADGE_TOKENS.default
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: tokens.bg,
        color: tokens.fg,
        borderRadius: 999,
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/** A label + prominent value (e.g. a metric tile). */
function Stat({
  label,
  value,
  style,
}: {
  label: ReactNode
  value: ReactNode
  style?: CSSProperties
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--color-muted)',
        minWidth: 0,
        ...style,
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--color-muted-foreground)' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-foreground)' }}>{value}</span>
    </div>
  )
}

/** Record → two-column key/value table. Accepts an object or an entries array. */
function KeyValues({
  data,
  style,
}: {
  data: Record<string, ReactNode> | Array<[ReactNode, ReactNode]>
  style?: CSSProperties
}) {
  const entries: Array<[ReactNode, ReactNode]> = Array.isArray(data) ? data : Object.entries(data)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 12, rowGap: 4, ...style }}>
      {entries.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}>
          <div style={{ color: 'var(--color-muted-foreground)', fontSize: 12, whiteSpace: 'nowrap' }}>{k}</div>
          <div style={{ color: 'var(--color-foreground)', fontSize: 12, wordBreak: 'break-word', minWidth: 0 }}>
            {v}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Simple data table. `columns` are header labels; `rows` are arrays of cells. */
function Table({
  columns,
  rows,
  style,
}: {
  columns: ReactNode[]
  rows: ReactNode[][]
  style?: CSSProperties
}) {
  const cellStyle: CSSProperties = {
    padding: '6px 8px',
    fontSize: 12,
    textAlign: 'left',
    borderBottom: '1px solid var(--color-border)',
    verticalAlign: 'top',
  }
  return (
    <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--color-border)', ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', color: 'var(--color-foreground)' }}>
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th
                key={i}
                style={{
                  ...cellStyle,
                  fontWeight: 600,
                  color: 'var(--color-muted-foreground)',
                  background: 'var(--color-muted)',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, ci) => (
                <td key={ci} style={cellStyle}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Monospace preformatted block (logs, snippets, raw output). */
function Code({
  children,
  style,
}: {
  children?: ReactNode
  style?: CSSProperties
}) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        borderRadius: 8,
        background: 'var(--color-muted)',
        color: 'var(--color-foreground)',
        fontFamily: FONT_MONO,
        fontSize: 12,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        overflowX: 'auto',
        ...style,
      }}
    >
      {children}
    </pre>
  )
}

// ─── Kit ────────────────────────────────────────────────────────────────────

/** The `ui` object passed to every custom-tool renderer. */
export const UI_KIT = {
  Card,
  Section,
  Header,
  Row,
  Stack,
  Badge,
  Stat,
  KeyValues,
  Table,
  Code,
  /** The design tokens, for renderers that style inline directly. */
  tokens: {
    background: 'var(--color-background)',
    foreground: 'var(--color-foreground)',
    card: 'var(--color-card)',
    cardForeground: 'var(--color-card-foreground)',
    muted: 'var(--color-muted)',
    mutedForeground: 'var(--color-muted-foreground)',
    primary: 'var(--color-primary)',
    primaryForeground: 'var(--color-primary-foreground)',
    border: 'var(--color-border)',
    success: 'var(--color-success)',
    warning: 'var(--color-warning)',
    destructive: 'var(--color-destructive)',
    info: 'var(--color-info)',
  },
} as const

export type CustomToolUiKit = typeof UI_KIT
