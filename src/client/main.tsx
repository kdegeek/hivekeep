import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/client/lib/i18n'
import '@/client/styles/globals.css'
import { App } from '@/client/App'
import { ThemeProvider } from '@/client/components/theme-provider'
import { Toaster } from '@/client/components/ui/sonner'
import { ErrorBoundary } from '@/client/components/common/ErrorBoundary'
import { AuthProvider } from '@/client/hooks/useAuth'
import { ThemeDbSync } from '@/client/components/ThemeDbSync'
import * as HostReact from 'react'
// Expose the host's single React instance so server-bundled custom-tool result
// renderers (loaded at runtime via import()) share it. Sharing one React is what
// makes their hooks work — a second React instance would throw "Invalid hook
// call". See services/custom-tool-renderer.ts (banner const React = …) and
// components/chat/CustomToolRenderer.tsx.
;(window as unknown as { __HIVEKEEP_REACT__?: typeof HostReact }).__HIVEKEEP_REACT__ = HostReact

if (new URLSearchParams(window.location.search).get('quickPanel') === '1') {
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('hide_quick_panel'))
      .catch(() => undefined)
  }, true)
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ThemeDbSync />
          <App />
          <Toaster />
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
