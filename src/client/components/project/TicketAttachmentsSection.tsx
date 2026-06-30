import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Download,
  Eye,
  FileIcon,
  FileImage,
  FileText,
  FileType,
  Loader2,
  Paperclip,
  Pencil,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/client/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/client/components/ui/dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/client/components/ui/avatar'
import { cn } from '@/client/lib/utils'
import {
  buildApiUrl,
  getErrorMessage,
  isNativeApiRuntime,
  withNativeAuthTransport,
} from '@/client/lib/api'
import { toast } from 'sonner'
import { formatRelativeTime } from '@/client/lib/time'
import { useTicketAttachments } from '@/client/hooks/useTicketAttachments'
import type { TicketAttachment } from '@/shared/types'

interface TicketAttachmentsSectionProps {
  ticketId: string
}

/** Small `<icon>` resolver based on MIME type for the row preview. */
function attachmentIcon(att: TicketAttachment) {
  if (att.mimeType.startsWith('image/')) return FileImage
  if (att.mimeType === 'application/pdf') return FileType
  if (att.mimeType.startsWith('text/') || att.mimeType.includes('json') || att.mimeType.includes('yaml')) {
    return FileText
  }
  return FileIcon
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * Whether a stored attachment URL must be fetched with the native bearer
 * transport. On the native (Tauri/Capacitor) runtime, API-served assets sit
 * behind bearer auth, so a bare `<img src>`/`<iframe src>`/`<a href>` (which
 * cannot attach the `Authorization` header) would 401. On the web the browser's
 * session cookie authenticates those direct requests, so no rewrite is needed.
 */
function needsNativeAssetAuth(url: string | null | undefined): boolean {
  return isNativeApiRuntime() && !!url && url.startsWith('/api/')
}

/** Fetch an API-served asset with the native bearer transport. */
async function fetchAuthedAssetBlob(apiUrl: string): Promise<Blob> {
  const url = buildApiUrl(apiUrl.slice('/api'.length))
  const response = await fetch(url, withNativeAuthTransport())
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.blob()
}

/**
 * Resolve a displayable URL for an attachment. On the web (or for already
 * absolute/blob URLs) the original URL is returned unchanged. On the native
 * runtime, an API-served URL is fetched with bearer auth and exposed as an
 * object URL, which is revoked on cleanup / when the input changes.
 */
type AuthedAssetStatus = 'idle' | 'loading' | 'ready' | 'error'

interface AuthedAsset {
  url: string | null
  status: AuthedAssetStatus
}

/**
 * Resolve an asset URL for rendering, fetching it with native bearer auth into
 * an object URL when the native runtime requires it (pass-through on web).
 *
 * Returns the resolved URL alongside an explicit status so callers can tell a
 * still-loading fetch apart from a failed one (a 401/404/network error). A
 * `null` URL with `status: 'error'` must surface a failure state rather than an
 * indefinite loading spinner.
 */
function useAuthedAssetUrl(url: string | null | undefined): AuthedAsset {
  const passThrough = !!url && !needsNativeAssetAuth(url)
  const [asset, setAsset] = useState<AuthedAsset>(
    passThrough
      ? { url: url as string, status: 'ready' }
      : { url: null, status: url ? 'loading' : 'idle' },
  )

  useEffect(() => {
    if (!url) {
      setAsset({ url: null, status: 'idle' })
      return
    }
    if (!needsNativeAssetAuth(url)) {
      setAsset({ url, status: 'ready' })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setAsset({ url: null, status: 'loading' })
    fetchAuthedAssetBlob(url)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setAsset({ url: objectUrl, status: 'ready' })
      })
      .catch(() => {
        if (!cancelled) setAsset({ url: null, status: 'error' })
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])

  return asset
}

/**
 * Trigger a browser download for an attachment. On the web this follows the
 * server's `?download=1` URL directly (cookie-authenticated). On the native
 * runtime it fetches the asset with bearer auth and saves the resulting blob.
 */
async function downloadAttachment(url: string, name: string): Promise<void> {
  if (!needsNativeAssetAuth(url)) {
    const a = document.createElement('a')
    a.href = `${url}?download=1`
    a.download = name
    a.rel = 'noopener'
    a.click()
    return
  }
  const blob = await fetchAuthedAssetBlob(url)
  const objectUrl = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = name
    a.click()
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function TicketAttachmentsSection({ ticketId }: TicketAttachmentsSectionProps) {
  const { t } = useTranslation()
  const {
    attachments,
    isLoading,
    uploads,
    uploadFiles,
    dismissUploadError,
    renameAttachment,
    deleteAttachment,
  } = useTicketAttachments(ticketId)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const dropRef = useRef<HTMLDivElement | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [previewAttachment, setPreviewAttachment] = useState<TicketAttachment | null>(null)
  const [renameTarget, setRenameTarget] = useState<TicketAttachment | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<TicketAttachment | null>(null)
  const [busy, setBusy] = useState(false)

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files) return
      const arr = Array.from(files)
      if (arr.length === 0) return
      try {
        await uploadFiles(arr)
      } catch (err) {
        toast.error(getErrorMessage(err))
      }
    },
    [uploadFiles],
  )

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }
  function onDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setIsDragOver(false)
  }
  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    void handleFiles(e.dataTransfer?.files ?? null)
  }

  async function handleRenameSubmit() {
    if (!renameTarget) return
    const next = renameValue.trim()
    if (!next || next === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setBusy(true)
    try {
      await renameAttachment(renameTarget.id, next)
      setRenameTarget(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function handleDeleteConfirm() {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await deleteAttachment(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      toast.error(getErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mb-4">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Paperclip className="size-3.5" />
        {t('projects.ticket.attachments.title')}
        {attachments.length > 0 && (
          <span className="text-muted-foreground/70">({attachments.length})</span>
        )}
      </h3>

      <div
        ref={dropRef}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={cn(
          'mb-2 rounded-md border border-dashed border-border bg-muted/30 p-3 text-center text-xs transition-colors',
          isDragOver && 'border-primary bg-primary/5 text-foreground',
        )}
      >
        <p className="mb-2 text-muted-foreground">
          {t('projects.ticket.attachments.dropHint')}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          <Upload className="mr-1 size-3.5" />
          {t('projects.ticket.attachments.addFile')}
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {uploads.length > 0 && (
        <ul className="mb-2 space-y-1">
          {uploads.map((u) => (
            <li
              key={u.localId}
              className={cn(
                'flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs',
                u.status === 'error' && 'border-destructive/40 bg-destructive/5 text-destructive',
              )}
            >
              {u.status === 'uploading' ? (
                <Loader2 className="size-3 shrink-0 animate-spin" />
              ) : (
                <X className="size-3 shrink-0" />
              )}
              <span className="flex-1 truncate">{u.name}</span>
              <span className="text-muted-foreground">{formatBytes(u.size)}</span>
              {u.status === 'error' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-5"
                  onClick={() => dismissUploadError(u.localId)}
                  title={t('common.close')}
                >
                  <X className="size-3" />
                </Button>
              )}
              {u.error && <span className="text-[10px] text-muted-foreground">{u.error}</span>}
            </li>
          ))}
        </ul>
      )}

      {isLoading && attachments.length === 0 && (
        <p className="text-xs text-muted-foreground">{t('common.loading')}</p>
      )}

      {!isLoading && attachments.length === 0 && uploads.length === 0 && (
        <p className="text-xs italic text-muted-foreground">
          {t('projects.ticket.attachments.empty')}
        </p>
      )}

      {attachments.length > 0 && (
        <ul className="space-y-1">
          {attachments.map((att) => (
            <AttachmentRow
              key={att.id}
              att={att}
              onPreview={() => setPreviewAttachment(att)}
              onRename={() => {
                setRenameTarget(att)
                setRenameValue(att.name)
              }}
              onDelete={() => setDeleteTarget(att)}
            />
          ))}
        </ul>
      )}

      <AttachmentPreviewDialog
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />

      <Dialog
        open={!!renameTarget}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('projects.ticket.attachments.renameTitle')}</DialogTitle>
            <DialogDescription>
              {t('projects.ticket.attachments.renameDescription')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder={t('projects.ticket.attachments.renamePlaceholder')}
            autoFocus
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleRenameSubmit} disabled={busy || !renameValue.trim()}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projects.ticket.attachments.deleteConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects.ticket.attachments.deleteConfirm.description', {
                name: deleteTarget?.name ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('projects.ticket.attachments.deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

interface AttachmentRowProps {
  att: TicketAttachment
  onPreview: () => void
  onRename: () => void
  onDelete: () => void
}

function AttachmentRow({ att, onPreview, onRename, onDelete }: AttachmentRowProps) {
  const { t } = useTranslation()
  const Icon = attachmentIcon(att)
  const isImage = att.mimeType.startsWith('image/')
  const { url: thumbnailUrl } = useAuthedAssetUrl(isImage ? att.url : null)

  async function handleDownload() {
    try {
      await downloadAttachment(att.url, att.name)
    } catch (err) {
      toast.error(getErrorMessage(err))
    }
  }

  return (
    <li className="group flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
      {isImage && thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt={att.name}
          className="size-8 shrink-0 rounded object-cover ring-1 ring-border"
          loading="lazy"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <p className="truncate text-xs font-medium" title={att.name}>
            {att.name}
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>{formatBytes(att.size)}</span>
          <span>·</span>
          <span>{formatRelativeTime(att.createdAt)}</span>
          {att.uploadedBy && (
            <>
              <span>·</span>
              <span className="inline-flex items-center gap-1">
                <Avatar className="size-3.5">
                  {att.uploadedBy.avatarUrl && (
                    <AvatarImage src={att.uploadedBy.avatarUrl} alt={att.uploadedBy.name} />
                  )}
                  <AvatarFallback className="text-[7px]">
                    {att.uploadedBy.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span>{att.uploadedBy.name}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 group-hover:opacity-100">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onPreview}
          title={t('projects.ticket.attachments.preview')}
        >
          <Eye className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-foreground/70 hover:text-foreground"
          onClick={handleDownload}
          title={t('projects.ticket.attachments.download')}
        >
          <Download className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onRename}
          title={t('projects.ticket.attachments.rename')}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={onDelete}
          title={t('projects.ticket.attachments.delete')}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </li>
  )
}

interface AttachmentPreviewDialogProps {
  attachment: TicketAttachment | null
  onClose: () => void
}

function AttachmentPreviewDialog({ attachment, onClose }: AttachmentPreviewDialogProps) {
  const { t } = useTranslation()
  const [textContent, setTextContent] = useState<string | null>(null)
  const [textLoading, setTextLoading] = useState(false)
  const [textError, setTextError] = useState<string | null>(null)

  const isImage = !!attachment && attachment.mimeType.startsWith('image/')
  const isPdf = !!attachment && attachment.mimeType === 'application/pdf'
  const isText =
    !!attachment &&
    (attachment.mimeType.startsWith('text/') ||
      attachment.mimeType === 'application/json' ||
      attachment.mimeType === 'application/xml' ||
      attachment.mimeType === 'application/x-yaml')

  // Resolve the binary-preview URL with native bearer auth when required so the
  // `<img>`/`<iframe>` load works on the native runtime (object URL on native,
  // pass-through on web).
  const { url: previewUrl, status: previewStatus } = useAuthedAssetUrl(
    attachment && (isImage || isPdf) ? attachment.url : null,
  )

  // Lazily fetch text content when the preview is for a text-y mime.
  useEffect(() => {
    if (!attachment || !isText) return
    let cancelled = false
    setTextContent(null)
    setTextError(null)
    setTextLoading(true)
    const isApiUrl = attachment.url.startsWith('/api/')
    const url = isApiUrl
      ? buildApiUrl(attachment.url.slice('/api'.length))
      : attachment.url
    fetch(url, isApiUrl ? withNativeAuthTransport() : { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((txt) => {
        if (!cancelled) setTextContent(txt)
      })
      .catch((err) => {
        if (!cancelled) setTextError(err instanceof Error ? err.message : 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setTextLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [attachment, isText])

  function handleOpenChange(open: boolean) {
    if (!open) {
      setTextContent(null)
      setTextError(null)
      setTextLoading(false)
      onClose()
    }
  }

  if (!attachment) return null

  return (
    <Dialog open={!!attachment} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{attachment.name}</DialogTitle>
          <DialogDescription>
            {attachment.mimeType} · {formatBytes(attachment.size)}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[65vh] min-h-[200px] overflow-auto rounded-md border border-border bg-muted/30">
          {isImage &&
            (previewUrl ? (
              <img
                src={previewUrl}
                alt={attachment.name}
                className="mx-auto max-h-[65vh] object-contain"
              />
            ) : (
              <div className="flex h-40 items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {previewStatus === 'error'
                  ? t('projects.ticket.attachments.previewFailed')
                  : t('common.loading')}
              </div>
            ))}
          {isPdf &&
            (previewUrl ? (
              <iframe
                src={previewUrl}
                title={attachment.name}
                sandbox=""
                className="h-[65vh] w-full"
              />
            ) : (
              <div className="flex h-40 items-center justify-center p-4 text-center text-xs text-muted-foreground">
                {previewStatus === 'error'
                  ? t('projects.ticket.attachments.previewFailed')
                  : t('common.loading')}
              </div>
            ))}
          {isText && (
            <pre className="m-0 max-h-[65vh] whitespace-pre-wrap break-words p-3 text-xs">
              {textLoading
                ? t('common.loading')
                : textError
                  ? textError
                  : textContent ?? ''}
            </pre>
          )}
          {!isImage && !isPdf && !isText && (
            <div className="flex h-40 items-center justify-center p-4 text-center text-xs text-muted-foreground">
              {t('projects.ticket.attachments.noPreview')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void (async () => {
                try {
                  await downloadAttachment(attachment.url, attachment.name)
                } catch (err) {
                  toast.error(getErrorMessage(err))
                }
              })()
            }}
          >
            <Download className="mr-1 size-4" />
            {t('projects.ticket.attachments.download')}
          </Button>
          <Button onClick={() => handleOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
