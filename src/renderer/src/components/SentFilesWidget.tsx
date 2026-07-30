/**
 * SentFilesWidget — the floating "Files" panel.
 *
 * Lists the files Claude Code handed to the user via its `SendUserFile` tool.
 * Visually and behaviourally a sibling of TodoWidget (same pill/expand
 * language), with these deliberate differences:
 *
 *  - the list is cumulative and NEVER auto-dismissed (a delivered file stays
 *    available for the rest of the session);
 *  - each row expands individually to show caption / full path / error, an
 *    image thumbnail, and the transport-appropriate actions;
 *  - every action is a CAPABILITY PROBE, not a platform sniff.
 *    `window.api.openPath` / `showInFolder` exist only in the desktop preload
 *    (the remote web client has no host filesystem); `getSentFilePreview`
 *    exists on both but resolves to a `data:` URL on desktop and to an
 *    authenticated same-origin `/sent-file` URL on the web; the Download
 *    anchor appears only when the file-scoped remote token is present.
 *
 * Both floating widgets are draggable by their header — see
 * `useDraggableWidget` (ADR-043 §2).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useActiveSession, useSessionStore } from '../stores/session-store'
import { useDraggableWidget } from '../hooks/useDraggableWidget'
import { fileBasename, isImagePath } from '../../../shared/file-mime'
import { resolveSentFilePath } from '../../../shared/sent-file-path'
import { buildSentFileUrl } from '../../../shared/sent-file-url'
import type { SentFile } from '../../../shared/types'

// Re-exported for the existing callers/tests that imported it from here before
// it moved to `src/shared` (the remote server needs the same resolution).
export { resolveSentFilePath }

/** Stable per-row identity — the same path can be re-sent by a later call. */
function rowKey(f: SentFile): string {
  return `${f.toolUseId}::${f.path}`
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'error'; error: string }

function FileIcon({ error }: { error?: string }): React.JSX.Element {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={`shrink-0 ${error ? 'text-error' : 'text-text-secondary'}`}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

export function SentFilesWidget(): React.JSX.Element | null {
  const sentFiles = useActiveSession((s) => s.sentFiles)
  const cwd = useActiveSession((s) => s.cwd)
  const sessionKey = useSessionStore((s) => s.activeSessionId)
  const [expanded, setExpanded] = useState(false)
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  // Transient per-row failure text from the shell IPC (not part of session state).
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({})
  const [previews, setPreviews] = useState<Record<string, PreviewState>>({})
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const inFlight = useRef<Set<string>>(new Set())
  const drag = useDraggableWidget('claudeui.widgetPos.files')

  const loadPreview = useCallback(
    async (key: string, absPath: string): Promise<void> => {
      const fetchPreview = window.api?.getSentFilePreview
      if (!fetchPreview || inFlight.current.has(key)) return
      inFlight.current.add(key)
      setPreviews((prev) => ({ ...prev, [key]: { status: 'loading' } }))
      try {
        const res = await fetchPreview(sessionKey ?? '', absPath)
        setPreviews((prev) => ({
          ...prev,
          [key]: 'src' in res ? { status: 'ready', src: res.src } : { status: 'error', ...res }
        }))
      } catch (e) {
        setPreviews((prev) => ({
          ...prev,
          [key]: { status: 'error', error: e instanceof Error ? e.message : String(e) }
        }))
      } finally {
        inFlight.current.delete(key)
      }
    },
    [sessionKey]
  )

  // Escape closes the lightbox (backdrop click is handled inline).
  useEffect(() => {
    if (!lightboxSrc) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  if (sentFiles.length === 0) return null

  // Newest first — buildSentFilesFromMessages appends in send order.
  const rows = [...sentFiles].reverse()

  const canPreview = typeof window.api?.getSentFilePreview === 'function'

  const toggleRow = (key: string, file: SentFile, absPath: string): void => {
    const opening = !openRows.has(key)
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    // Lazily fetch the thumbnail the first time a row with an image is opened.
    // `display: 'render'` is NOT required — a delivered photo is exactly the
    // case a thumbnail exists for.
    if (opening && canPreview && !file.error && isImagePath(file.path) && !previews[key]) {
      void loadPreview(key, absPath)
    }
  }

  const runShellAction = async (
    key: string,
    absPath: string,
    action: ((p: string) => Promise<{ error?: string }>) | undefined
  ): Promise<void> => {
    if (!action) return
    try {
      const res = await action(absPath)
      setOpenErrors((prev) => ({ ...prev, [key]: res?.error ?? '' }))
    } catch (e) {
      setOpenErrors((prev) => ({ ...prev, [key]: e instanceof Error ? e.message : String(e) }))
    }
  }

  const canOpen = typeof window.api?.openPath === 'function'
  const canReveal = typeof window.api?.showInFolder === 'function'
  // Remote only: the download is a plain <a download> so the mobile browser
  // handles it natively. Needs the file-scoped token (delivered over the
  // authenticated WS) and the session's routingId for the server-side lookup.
  const fileToken = window.__FILE_TOKEN__
  const canDownload = window.api?.platform === 'web' && !!fileToken && !!sessionKey

  return (
    <div
      data-testid="SentFilesWidget"
      ref={drag.ref}
      data-dragged={drag.dragged || undefined}
      className="bg-bg-tertiary border border-border light-no-border shadow-lg shadow-black/30 overflow-hidden transition-all duration-200 ease-out"
      style={{
        width: expanded ? 'min(400px, 45%)' : 155,
        borderRadius: expanded ? 12 : 8,
        ...drag.style
      }}
    >
      {/* Header — always visible. Doubles as the drag handle: a movement below
          the threshold falls through to this onClick (expand/collapse). */}
      <button
        data-testid="SentFilesWidget.toggle"
        onClick={() => {
          if (drag.didDrag()) return
          setExpanded(!expanded)
        }}
        {...drag.headerHandlers}
        className="w-full flex items-center px-3 h-9 hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <span className="text-[12px] text-text-secondary font-medium whitespace-nowrap">Files</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-text-secondary font-mono whitespace-nowrap">
            {sentFiles.length}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-text-secondary ml-1 transition-transform duration-200"
            style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(180deg)' }}
          >
            <polyline points="6 15 12 9 18 15" />
          </svg>
        </div>
      </button>

      {/* Expandable body */}
      <div
        className="transition-[max-height,opacity] duration-200 ease-out overflow-hidden"
        style={{
          maxHeight: expanded ? 300 : 0,
          opacity: expanded ? 1 : 0
        }}
      >
        <div className="border-t border-border">
          <div className="max-h-[288px] overflow-y-auto">
            {rows.map((file) => {
              const key = rowKey(file)
              const isOpen = openRows.has(key)
              const absPath = resolveSentFilePath(cwd, file.path)
              const openError = openErrors[key]
              const preview = previews[key]
              return (
                <div key={key} className="border-b border-border last:border-b-0">
                  <button
                    data-testid="SentFilesWidget.row"
                    data-id={file.path}
                    onClick={() => toggleRow(key, file, absPath)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover transition-colors cursor-pointer"
                  >
                    <FileIcon error={file.error} />
                    <span
                      className={`flex-1 min-w-0 text-[12px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis ${
                        file.error ? 'text-error' : 'text-text-primary'
                      }`}
                    >
                      {fileBasename(file.path)}
                    </span>
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="text-text-muted shrink-0 transition-transform duration-200"
                      style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(180deg)' }}
                    >
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                  </button>

                  {isOpen && (
                    <div className="px-3 pb-2 pt-0.5 flex flex-col gap-1.5 items-start">
                      {file.caption && (
                        <div className="text-[11px] text-text-secondary italic leading-snug">
                          {file.caption}
                        </div>
                      )}
                      {preview?.status === 'ready' && (
                        <img
                          data-testid="SentFilesWidget.thumb"
                          src={preview.src}
                          alt={fileBasename(file.path)}
                          onClick={() => setLightboxSrc(preview.src)}
                          className="max-h-[120px] max-w-full rounded object-contain cursor-zoom-in border border-border"
                        />
                      )}
                      <div className="text-[11px] text-text-muted font-mono break-all select-text">
                        {absPath}
                      </div>
                      {file.error && (
                        <div className="text-[11px] text-error leading-snug break-words">
                          {file.error}
                        </div>
                      )}
                      {preview?.status === 'error' && (
                        <div className="text-[11px] text-error leading-snug break-words">
                          {preview.error}
                        </div>
                      )}
                      {openError && (
                        <div className="text-[11px] text-error leading-snug break-words">
                          {openError}
                        </div>
                      )}
                      {(canOpen || canReveal || canDownload) && (
                        <div className="flex items-center gap-1.5">
                          {canOpen && (
                            <button
                              data-testid="SentFilesWidget.open"
                              onClick={() => void runShellAction(key, absPath, window.api.openPath)}
                              className="text-[11px] px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                            >
                              Open
                            </button>
                          )}
                          {canReveal && (
                            <button
                              data-testid="SentFilesWidget.reveal"
                              onClick={() =>
                                void runShellAction(key, absPath, window.api.showInFolder)
                              }
                              className="text-[11px] px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                            >
                              Show in folder
                            </button>
                          )}
                          {canDownload && (
                            <a
                              data-testid="SentFilesWidget.download"
                              href={buildSentFileUrl(
                                window.location.origin,
                                sessionKey as string,
                                absPath,
                                { token: fileToken as string }
                              )}
                              download={fileBasename(file.path)}
                              className="text-[11px] px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                            >
                              Download
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Lightbox — portalled to <body> so neither the widget's `overflow-hidden`
          nor a dragged (position: fixed) root can clip or restack it. */}
      {lightboxSrc &&
        createPortal(
          <div
            data-testid="SentFilesWidget.lightbox"
            onClick={() => setLightboxSrc(null)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          >
            <img
              src={lightboxSrc}
              alt=""
              onClick={(e) => e.stopPropagation()}
              className="max-w-[90vw] max-h-[85vh] object-contain rounded shadow-2xl cursor-default"
            />
          </div>,
          document.body
        )}
    </div>
  )
}
