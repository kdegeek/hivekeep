import { useLocation } from 'react-router-dom'
import { SettingsPage } from '@/client/pages/settings/SettingsPage'
import type { SettingsFilters } from '@/client/pages/settings/SettingsPage'

interface SettingsRouteState {
  section?: string
  filters?: SettingsFilters
}

export function MobileSettingsPage() {
  const location = useLocation()
  const state = location.state as SettingsRouteState | null

  return (
    <SettingsPage
      initialSection={state?.section}
      initialFilters={state?.filters}
    />
  )
}
