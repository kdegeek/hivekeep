import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { useProject } from '@/client/hooks/useProjects'

interface ActiveProjectChipProps {
  projectId: string | null
}

/**
 * A small clickable chip that shows the active project of an Agent and
 * navigates to the Projects mode (kanban) when clicked.
 *
 * Renders nothing when projectId is null (no active project).
 */
export function ActiveProjectChip({ projectId }: ActiveProjectChipProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { project } = useProject(projectId)

  if (!projectId || !project) return null

  return (
    <button
      type="button"
      onClick={() => navigate(`/projects/${projectId}`)}
      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
      title={t('projects.chip.tooltip', { title: project.title })}
    >
      <Sparkles className="size-3 text-primary" strokeWidth={2} />
      <span className="font-medium">{project.title}</span>
    </button>
  )
}
