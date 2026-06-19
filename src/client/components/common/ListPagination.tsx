import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { cn } from '@/client/lib/utils'

interface ListPaginationProps {
  /** 1-based current page. */
  page: number
  pageCount: number
  total: number
  /** 1-based index of the first/last row shown (from useListControls). */
  rangeFrom: number
  rangeTo: number
  onPageChange: (page: number) => void
  /** When provided alongside `onPerPageChange`, renders the per-page selector. */
  perPage?: number
  perPageOptions?: number[]
  onPerPageChange?: (n: number) => void
  className?: string
}

const DEFAULT_PER_PAGE_OPTIONS = [10, 25, 50, 100]

/**
 * Shared pagination footer for settings lists: "from-to of total" on one side,
 * an optional per-page selector and prev/next on the other. Extracted from the
 * model-registry table; stacks on mobile (`flex-col-reverse sm:flex-row`).
 */
export function ListPagination({
  page,
  pageCount,
  total,
  rangeFrom,
  rangeTo,
  onPageChange,
  perPage,
  perPageOptions = DEFAULT_PER_PAGE_OPTIONS,
  onPerPageChange,
  className,
}: ListPaginationProps) {
  const { t } = useTranslation()
  if (total === 0) return null
  return (
    <div className={cn('flex flex-col-reverse items-center justify-between gap-3 text-sm text-muted-foreground sm:flex-row', className)}>
      <span className="tabular-nums">
        {t('common.listRange', {
          from: rangeFrom,
          to: rangeTo,
          total,
          defaultValue: '{{from}}-{{to}} of {{total}}',
        })}
      </span>
      <div className="flex items-center gap-2">
        {perPage != null && onPerPageChange && (
          <>
            <span className="hidden sm:inline">{t('common.perPage', 'Per page')}</span>
            <Select value={String(perPage)} onValueChange={(v) => onPerPageChange(Number(v))}>
              <SelectTrigger className="h-8 w-[4.5rem]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {perPageOptions.map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        )}
        <Button
          variant="outline"
          size="icon-sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={t('common.previous', 'Previous')}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="tabular-nums">{page} / {pageCount}</span>
        <Button
          variant="outline"
          size="icon-sm"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label={t('common.next', 'Next')}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
