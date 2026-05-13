// ─── Plugin Card primitives ─────────────────────────────────────────────────
//
// A plugin card is a declarative tree of primitives plus a state object.
// The plugin emits a card once (layout + initial state) and then pushes state
// patches to update the view in place. The client interpolates `{{key}}`
// placeholders in the layout from the current state before rendering.
//
// Cards persist as system messages on the conversation (role='system',
// sourceType='system', metadata.systemEvent='plugin-card') so they survive
// reloads and are part of the normal message timeline. Live updates ride on
// the SSE `card:updated` event.

export type PluginCardVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'primary'
  | 'muted'

export interface PluginCardActionInput {
  type: 'text' | 'textarea'
  placeholder?: string
}

export interface PluginCardAction {
  id: string
  label: string
  variant?: PluginCardVariant
  input?: PluginCardActionInput
  /** If true, the UI confirms with the user before firing the action. */
  confirm?: boolean
}

export interface PluginCardStatItem {
  label: string
  value: string
  variant?: PluginCardVariant
}

export interface PluginCardInfoGridItem {
  label: string
  value: string
  variant?: PluginCardVariant
  /** When true, long values are clipped with ellipsis and a tooltip shows the full text. */
  truncate?: boolean
  /**
   * Icon next to the value. Either a Lucide icon name (`"Sparkles"`) or a
   * react-icons identifier in the form `"<collection>/<ComponentName>"`
   * (`"bs/BsClaude"`, `"si/SiOpenai"`).
   */
  icon?: string
}

export type PluginCardBannerAnimation = 'pulse' | 'shimmer' | 'spin' | 'none'

export type PluginCardPrimitive =
  | {
      type: 'header'
      title: string
      /**
       * Either a Lucide icon name or a react-icons id of the form
       * `"<collection>/<ComponentName>"` (e.g. `"bs/BsClaude"`).
       */
      icon?: string
      accent?: PluginCardVariant
    }
  | { type: 'stat-row'; items: PluginCardStatItem[] }
  | {
      type: 'info-grid'
      columns?: 2 | 3
      items: PluginCardInfoGridItem[]
    }
  | {
      type: 'status-banner'
      label: string
      sublabel?: string
      variant?: PluginCardVariant
      /** Lucide name or `"<collection>/<ComponentName>"` for react-icons. */
      icon?: string
      animated?: PluginCardBannerAnimation
    }
  | { type: 'progress'; value?: number; max?: number; indeterminate?: boolean; label?: string }
  | { type: 'collapsible'; label: string; defaultOpen?: boolean; content: PluginCardPrimitive | PluginCardPrimitive[] }
  | { type: 'log-stream'; lines: string[]; autoscroll?: boolean; maxHeight?: number }
  | { type: 'action-row'; actions: PluginCardAction[] }
  | { type: 'markdown'; content: string }
  | { type: 'spinner'; label?: string }
  | {
      type: 'badge'
      text: string
      variant?: PluginCardVariant
      /** Lucide name or `"<collection>/<ComponentName>"` for react-icons. */
      icon?: string
    }
  | { type: 'divider'; label?: string }

export interface PluginCard {
  /** Name of the plugin that owns this card (matches manifest.name). */
  pluginId: string
  /** Plugin-defined identifier for the kind of card (e.g. 'task-run'). */
  cardType: string
  /** Stable UUID used to target this card with live updates. */
  cardInstanceId: string
  /** Declarative layout. Strings may contain `{{key}}` placeholders. */
  layout: PluginCardPrimitive[]
  /** Values interpolated into the layout at render time. */
  state: Record<string, unknown>
}

/** Shape of the `systemEvent` payload surfaced for plugin-card system rows. */
export interface PluginCardSystemEvent {
  type: 'plugin-card'
  pluginCard: PluginCard
}
