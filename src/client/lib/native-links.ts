// The desktop shell's webview has no shell-open permission by default (Tauri
// v2's capability system is deny-by-default), so a plain `window.open()` or
// `<a target="_blank">` click just tries to navigate the app's own webview to
// an external URL and goes nowhere. Route external links through Tauri's
// opener plugin instead so they land in the user's OS browser, the same place
// a web/mobile user would expect them to open.

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' &&
    Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

/**
 * Open an external URL in the OS browser when running inside the Tauri
 * desktop shell, falling back to a normal `window.open` everywhere else
 * (web, mobile, and desktop builds running outside a real Tauri webview,
 * e.g. the Playwright desktop-smoke tests).
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (hasTauriBridge()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return
    } catch {
      // Fall through to window.open below.
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Install a single document-level click interceptor that redirects clicks on
 * any absolute, cross-origin http(s) link through {@link openExternalUrl}.
 * Covers every existing `<a target="_blank">` in the app (and future ones)
 * without patching each call site individually. No-ops outside the desktop
 * shell. Safe to call more than once — only the first call attaches the
 * listener.
 */
let installed = false
export function installNativeLinkHandling(): void {
  if (installed) return
  if (typeof document === 'undefined' || !hasTauriBridge()) return
  installed = true

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

    const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return
    if (anchor.origin === window.location.origin) return

    event.preventDefault()
    void openExternalUrl(anchor.href)
  }, true)
}
