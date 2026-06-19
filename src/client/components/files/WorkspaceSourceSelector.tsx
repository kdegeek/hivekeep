import { useTranslation } from 'react-i18next'
import { FolderGit2, FolderInput, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
} from '@/client/components/ui/select'
import { AgentSelectItem, type AgentOption } from '@/client/components/common/AgentSelectItem'
import type { WorkspaceSourceRef } from '@/shared/types'

/** A project repo offered as a browse source (only `ready` clones are listed). */
export interface WorkspaceProjectOption {
  id: string
  title: string
}

interface WorkspaceSourceSelectorProps {
  value: WorkspaceSourceRef | null
  onChange: (source: WorkspaceSourceRef) => void
  agents: AgentOption[]
  folders: Array<{ id: string; label: string; path: string }>
  projects?: WorkspaceProjectOption[]
  onAddFolder: () => void
  placeholder?: string
}

const ADD_FOLDER = '__add_folder__'
const encode = (type: WorkspaceSourceRef['type'], id: string) => `${type}:${id}`

/**
 * Files-section source picker: agents, project repos and user-added folders in
 * one grouped dropdown (reuses the Select primitives + AgentSelectItem so an
 * agent row looks identical to every other agent picker in the app). The
 * project worktree sub-selector and git badge live in FilesPage, next to this.
 */
export function WorkspaceSourceSelector({
  value,
  onChange,
  agents,
  folders,
  projects = [],
  onAddFolder,
  placeholder,
}: WorkspaceSourceSelectorProps) {
  const { t } = useTranslation()

  const selectedValue = value ? encode(value.type, value.id) : ''

  const handleChange = (raw: string) => {
    if (raw === ADD_FOLDER) {
      onAddFolder()
      return
    }
    const sep = raw.indexOf(':')
    const type = raw.slice(0, sep) as WorkspaceSourceRef['type']
    const id = raw.slice(sep + 1)
    onChange({ type, id })
  }

  const triggerLabel = (() => {
    if (!value) return null
    if (value.type === 'agent') {
      const agent = agents.find((a) => a.id === value.id)
      return agent ? <AgentSelectItem agent={agent} /> : null
    }
    if (value.type === 'project') {
      const project = projects.find((p) => p.id === value.id)
      return <SourceRow icon={FolderGit2} label={project?.title ?? value.id} />
    }
    const folder = folders.find((f) => f.id === value.id)
    return <SourceRow icon={FolderInput} label={folder?.label ?? value.id} sub={folder?.path} />
  })()

  return (
    <Select value={selectedValue} onValueChange={handleChange}>
      <SelectTrigger className="w-full h-auto min-h-9">
        {triggerLabel ?? <span className="text-muted-foreground">{placeholder}</span>}
      </SelectTrigger>
      <SelectContent position="popper">
        {agents.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t('files.sources.agents')}</SelectLabel>
            {agents.map((agent) => (
              <SelectItem key={`agent:${agent.id}`} value={encode('agent', agent.id)} className="py-2">
                <AgentSelectItem agent={agent} />
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        {projects.length > 0 && (
          <SelectGroup>
            <SelectLabel>{t('files.sources.projects')}</SelectLabel>
            {projects.map((project) => (
              <SelectItem key={`project:${project.id}`} value={encode('project', project.id)} className="py-2">
                <SourceRow icon={FolderGit2} label={project.title} />
              </SelectItem>
            ))}
          </SelectGroup>
        )}

        <SelectGroup>
          <SelectLabel>{t('files.sources.folders')}</SelectLabel>
          {folders.map((folder) => (
            <SelectItem key={`folder:${folder.id}`} value={encode('folder', folder.id)} className="py-2">
              <SourceRow icon={FolderInput} label={folder.label} sub={folder.path} />
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={ADD_FOLDER} className="py-2 text-muted-foreground">
            <SourceRow icon={Plus} label={t('files.sources.addFolder')} />
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function SourceRow({ icon: Icon, label, sub }: { icon: typeof FolderInput; label: string; sub?: string }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0 text-left">
      <Icon className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <span className="block truncate text-sm">{label}</span>
        {sub && <span className="block truncate text-[10px] text-muted-foreground leading-tight">{sub}</span>}
      </div>
    </div>
  )
}
