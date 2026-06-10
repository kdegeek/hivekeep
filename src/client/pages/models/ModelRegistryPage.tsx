import { Navigate } from 'react-router-dom'
import { useAuth } from '@/client/hooks/useAuth'
import { ModelRegistryTable } from '@/client/pages/models/ModelRegistryTable'

/**
 * Dedicated, full-width home for the model registry. The table is a dense admin
 * grid (context, modalities, reasoning, pricing per model) that was cramped
 * inside the Settings modal's `max-w-2xl` column — it gets a real page here.
 * Admin-only; non-admins are bounced to the app root.
 */
export function ModelRegistryPage() {
  const { user } = useAuth()
  if (user && user.role !== 'admin') return <Navigate to="/" replace />

  return (
    <div className="surface-base h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl p-4 md:p-6">
        <ModelRegistryTable />
      </div>
    </div>
  )
}
