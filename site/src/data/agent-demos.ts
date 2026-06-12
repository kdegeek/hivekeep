// Scripted demos for the hero "your agents" panel. Clicking an agent opens a
// drawer that replays one of these conversations — a small, honest taste of what
// a Hivekeep specialist does: a question, two or three real-looking tool calls,
// then a concrete answer. The tool domains map 1:1 to the app's real tool
// domains (see src/shared/constants.ts TOOL_DOMAIN_META) so the icons/colors
// match the product. `name` is the friendly tool label; `detail` is the mono
// preview shown after it (the command / argument), exactly like the real chat.

export type DemoToolDomain =
  | 'shell'
  | 'filesystem'
  | 'browse'
  | 'search'
  | 'email'
  | 'calendar'
  | 'vault'
  | 'config'
  | 'memory'

export type DemoStep =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; domain: DemoToolDomain; name: string; detail?: string }

export interface AgentDemo {
  /** Matches the name in agents.json. */
  name: string
  /** Short specialty label (matches agents.json domain). */
  domain: string
  /** Longer role line shown under the name in the chat header. */
  role: string
  /** Avatar path under /avatars/ (BASE_URL is prefixed at render time). */
  avatar: string
  status: 'online' | 'working' | 'idle'
  /** The example question, used as the row's hover hint. */
  prompt: string
  steps: DemoStep[]
}

export const AGENT_DEMOS: AgentDemo[] = [
  {
    name: 'Queenie',
    domain: 'Setup & onboarding',
    role: 'Your setup guide · gets the hive running',
    avatar: '/avatars/queenie.jpg',
    status: 'online',
    prompt: 'I want to use Claude as my main model',
    steps: [
      { kind: 'user', text: 'I want to use Claude as my main model.' },
      {
        kind: 'text',
        text: "Welcome! Let's get you on Anthropic. Paste your API key when you're ready — it goes straight into the encrypted vault, never into a prompt.",
      },
      { kind: 'tool', domain: 'vault', name: 'Save secret', detail: 'ANTHROPIC_API_KEY → vault' },
      { kind: 'tool', domain: 'config', name: 'Set default model', detail: 'claude-opus-4-8' },
      {
        kind: 'text',
        text: 'All set ✅ Your key is encrypted at rest and **Claude Opus** is now your default model. Want me to create your first specialist — say, a coding agent like Forge?',
      },
    ],
  },
  {
    name: 'Atlas',
    domain: 'DevOps & infra',
    role: 'Runs your servers, clusters & deployments',
    avatar: '/avatars/atlas.jpg',
    status: 'working',
    prompt: 'Deploy Vaultwarden on my Kubernetes',
    steps: [
      { kind: 'user', text: 'Can you deploy Vaultwarden (Bitwarden) on my Kubernetes cluster?' },
      {
        kind: 'text',
        text: "On it — I'll deploy Vaultwarden and wire it into your existing ingress.",
      },
      { kind: 'tool', domain: 'shell', name: 'Run shell', detail: 'helm upgrade --install vaultwarden …' },
      { kind: 'tool', domain: 'shell', name: 'Run shell', detail: 'kubectl apply -f ingress.yaml' },
      { kind: 'tool', domain: 'browse', name: 'Browse URL', detail: 'https://vault.home.lan/alive' },
      {
        kind: 'text',
        text: 'Done ✅ Vaultwarden is live at **https://vault.home.lan** — exposed through your Traefik ingress with a Let’s Encrypt cert, persistent storage on `longhorn`, and a nightly backup to your NAS.',
      },
    ],
  },
  {
    name: 'Forge',
    domain: 'Dev & code',
    role: 'Writes, refactors & ships code in your repos',
    avatar: '/avatars/forge.jpg',
    status: 'online',
    prompt: 'Add a dark-mode toggle to my repo',
    steps: [
      { kind: 'user', text: 'Add a dark-mode toggle to my portfolio repo.' },
      {
        kind: 'text',
        text: "Sure — I'll add a toggle that remembers the choice and respects the system setting.",
      },
      { kind: 'tool', domain: 'filesystem', name: 'Read file', detail: 'src/components/Header.tsx' },
      { kind: 'tool', domain: 'filesystem', name: 'Write file', detail: 'src/components/ThemeToggle.tsx' },
      { kind: 'tool', domain: 'shell', name: 'Run shell', detail: "git commit -am 'feat: dark mode' && git push" },
      {
        kind: 'text',
        text: 'Pushed `feat: dark mode` to **main**. The toggle persists to `localStorage`, falls back to `prefers-color-scheme`, and reuses your existing color tokens so nothing else shifts.',
      },
    ],
  },
  {
    name: 'Inbox',
    domain: 'Email & calendar',
    role: 'Triages mail and keeps your day on track',
    avatar: '/avatars/inbox.jpg',
    status: 'working',
    prompt: "What's on my plate today?",
    steps: [
      { kind: 'user', text: "What's on my plate today? And tell Sarah I'll be there." },
      { kind: 'text', text: 'Let me pull your day together.' },
      { kind: 'tool', domain: 'calendar', name: 'List events', detail: 'today' },
      { kind: 'tool', domain: 'email', name: 'List emails', detail: 'is:unread' },
      { kind: 'tool', domain: 'email', name: 'Send email', detail: 'to: sarah@…' },
      {
        kind: 'text',
        text: "You've got **3 meetings** — standup at 10:00, design review at 14:00, a 1:1 at 16:30. 4 unread, nothing urgent. I replied to Sarah confirming the 14:00. 🐝",
      },
    ],
  },
  {
    name: 'Sentinel',
    domain: 'Security & pentest',
    role: 'Watches your perimeter & hardens your setup',
    avatar: '/avatars/sentinel.jpg',
    status: 'online',
    prompt: 'Scan my home server for weak spots',
    steps: [
      { kind: 'user', text: 'Scan my home server for open ports and obvious weak spots.' },
      { kind: 'text', text: "Running a non-intrusive scan now." },
      { kind: 'tool', domain: 'shell', name: 'Run shell', detail: 'nmap -sV 192.168.1.10' },
      { kind: 'tool', domain: 'search', name: 'Search web', detail: 'OpenSSH 8.2 known CVEs' },
      {
        kind: 'text',
        text: 'Scan done. Open: **22 (SSH)**, **443 (nginx)**, **51820 (WireGuard)**. One fix: SSH still allows password auth — I’d switch to key-only. No critical CVEs on your versions. Want me to harden `sshd_config`?',
      },
    ],
  },
]
