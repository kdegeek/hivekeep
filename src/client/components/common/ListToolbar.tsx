import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { Input } from '@/client/components/ui/input'
import { Button } from '@/client/components/ui/button'
import { cn } from '@/client/lib/utils'

interface ListToolbarProps {
  query: string
  onQueryChange: (value: string) => void
  placeholder?: string
  /** Filter controls (e.g. <Select>) rendered after the search box. */
  children?: ReactNode
  /** When set, a "Clear" button appears once `active` is true. */
  onClear?: () => void
  /** Whether any search/filter is currently active (gates the Clear button). */
  active?: boolean
  className?: string
}

/**
 * Shared filter bar for settings/management lists: a search box on the left
 * (grows to fill), screen-specific filter controls next to it, and an optional
 * Clear button. Mirrors the model-registry layout so every list filters the
 * same way and wraps cleanly on mobile (each control should be `w-full sm:w-*`).
 */
export function ListToolbar({
  query,
  onQueryChange,
  placeholder,
  children,
  onClear,
  active,
  className,
}: ListToolbarProps) {
  const { t } = useTranslation()
  return (
    <div className={cn('flex items-center gap-2 flex-wrap', className)}>
      <div className="relative flex-1 min-w-[12rem]">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder={placeholder ?? t('common.search', 'Search...')}
          className="pl-8"
        />
      </div>
      {children}
      {onClear && active && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="size-4" />
          {t('common.clearFilters', 'Clear')}
        </Button>
      )}
    </div>
  )
}
