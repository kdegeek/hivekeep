import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/client/components/ui/select'
import { cn } from '@/client/lib/utils'
import { FIELD_OPS, opValueKind, MAX_CONDITION_DEPTH } from '@/shared/account-triggers'
import type { ConditionField, ConditionLeaf, ConditionNode, ConditionOp } from '@/shared/types'

const ALL_FIELDS = Object.keys(FIELD_OPS) as ConditionField[]

export function defaultLeaf(): ConditionLeaf {
  return { type: 'leaf', field: 'subject', op: 'contains', value: '' }
}
export function defaultGroup(): ConditionNode {
  return { type: 'group', op: 'and', children: [defaultLeaf()] }
}

/** Reset a leaf's value when its operator's value-kind changes. */
function coerceValue(op: ConditionOp): string | string[] | boolean {
  const kind = opValueKind(op)
  if (kind === 'list') return []
  if (kind === 'none') return true
  return ''
}

function LeafEditor({
  leaf, onChange, onRemove,
}: { leaf: ConditionLeaf; onChange: (n: ConditionLeaf) => void; onRemove: () => void }) {
  const { t } = useTranslation()
  const ops = FIELD_OPS[leaf.field]
  const kind = opValueKind(leaf.op)

  return (
    <div className="flex items-center gap-2 rounded-lg bg-background/60 p-1.5 ring-1 ring-border/60">
      {/* Polarity toggle — clearly a toggle, distinct from the selects */}
      <button
        type="button"
        onClick={() => onChange({ ...leaf, negate: !leaf.negate })}
        title={t('settings.triggers.negateHint')}
        className={cn(
          'h-8 shrink-0 rounded-md border px-2 text-[11px] font-medium transition-colors',
          leaf.negate
            ? 'border-destructive/40 bg-destructive/10 text-destructive'
            : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
        )}
      >
        {leaf.negate ? t('settings.triggers.isNot') : t('settings.triggers.is')}
      </button>

      <Select
        value={leaf.field}
        onValueChange={(field) => {
          const f = field as ConditionField
          const op = FIELD_OPS[f][0]!
          onChange({ type: 'leaf', field: f, op, value: coerceValue(op) })
        }}
      >
        <SelectTrigger className="h-8 w-48 shrink-0 border-transparent bg-transparent text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {ALL_FIELDS.map((f) => (
            <SelectItem key={f} value={f} className="text-xs">{t(`settings.triggers.fields.${f}`)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={leaf.op}
        onValueChange={(op) => {
          const o = op as ConditionOp
          const next: ConditionLeaf = { ...leaf, op: o }
          if (opValueKind(o) !== opValueKind(leaf.op)) next.value = coerceValue(o)
          onChange(next)
        }}
      >
        <SelectTrigger className="h-8 w-36 shrink-0 border-transparent bg-transparent text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          {ops.map((o) => (
            <SelectItem key={o} value={o} className="text-xs">{t(`settings.triggers.ops.${o}`)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {kind === 'string' && (
        <Input
          value={typeof leaf.value === 'string' ? leaf.value : ''}
          onChange={(e) => onChange({ ...leaf, value: e.target.value })}
          placeholder={leaf.op === 'matches' ? t('settings.triggers.regexPlaceholder') : t('settings.triggers.valuePlaceholder')}
          className="h-8 min-w-0 flex-1 border-transparent bg-muted/60 text-xs focus-visible:bg-background"
        />
      )}
      {kind === 'list' && (
        <Input
          value={Array.isArray(leaf.value) ? leaf.value.join(', ') : ''}
          onChange={(e) => onChange({ ...leaf, value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          placeholder={t('settings.triggers.listPlaceholder')}
          className="h-8 min-w-0 flex-1 border-transparent bg-muted/60 text-xs focus-visible:bg-background"
        />
      )}
      {kind === 'none' && <div className="flex-1" />}

      <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0 text-muted-foreground hover:text-destructive" onClick={onRemove} title={t('common.remove')}>
        <X className="size-4" />
      </Button>
    </div>
  )
}

export function ConditionNodeEditor({
  node, onChange, onRemove, depth = 1,
}: {
  node: ConditionNode
  onChange: (n: ConditionNode) => void
  onRemove?: () => void
  depth?: number
}) {
  const { t } = useTranslation()

  if (node.type === 'leaf') {
    return <LeafEditor leaf={node} onChange={onChange} onRemove={onRemove ?? (() => {})} />
  }

  const updateChild = (i: number, child: ConditionNode) => {
    const children = node.children.slice()
    children[i] = child
    onChange({ ...node, children })
  }
  const removeChild = (i: number) => {
    const children = node.children.slice()
    children.splice(i, 1)
    onChange({ ...node, children: children.length > 0 ? children : [defaultLeaf()] })
  }

  return (
    <div className={cn('rounded-xl border border-border bg-muted/30 p-3', depth > 1 && 'border-l-2 border-l-primary/50')}>
      {/* Header: a self-explanatory AND/OR pill */}
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <Select value={node.op} onValueChange={(op) => onChange({ ...node, op: op as 'and' | 'or' })}>
          <SelectTrigger className="h-7 w-auto gap-1.5 rounded-full bg-background px-3 text-[11px] font-semibold"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="and" className="text-xs">{t('settings.triggers.matchAll')}</SelectItem>
            <SelectItem value="or" className="text-xs">{t('settings.triggers.matchAny')}</SelectItem>
          </SelectContent>
        </Select>
        {onRemove && (
          <Button type="button" size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={onRemove} title={t('common.remove')}>
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      {/* Conditions */}
      <div className="space-y-2">
        {node.children.map((child, i) => (
          <ConditionNodeEditor
            key={i}
            node={child}
            depth={depth + 1}
            onChange={(c) => updateChild(i, c)}
            onRemove={() => removeChild(i)}
          />
        ))}
      </div>

      {/* Add actions — dashed + muted so they never read as conditions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 border border-dashed border-border text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
          onClick={() => onChange({ ...node, children: [...node.children, defaultLeaf()] })}
        >
          <Plus className="size-3" />{t('settings.triggers.addCondition')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 border border-dashed border-border text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
          disabled={depth + 1 > MAX_CONDITION_DEPTH}
          onClick={() => onChange({ ...node, children: [...node.children, defaultGroup()] })}
        >
          <Plus className="size-3" />{t('settings.triggers.addGroup')}
        </Button>
      </div>
    </div>
  )
}
