/**
 * SentFilesWidget — the floating "Files" panel.
 *
 * Lists the files Claude Code handed to the user via its `SendUserFile` tool.
 * Visually and behaviourally a sibling of TodoWidget (same pill/expand
 * language), with three deliberate differences:
 *
 *  - the list is cumulative and NEVER auto-dismissed (a delivered file stays
 *    available for the rest of the session);
 *  - each row expands individually to show caption / full path / error and the
 *    open affordances;
 *  - the open affordances are desktop-only. `window.api.openPath` /
 *    `showInFolder` are optional members of the API surface — the remote web
 *    client has no access to the host filesystem — so the buttons are hidden
 *    rather than broken when they are absent.
 */

import { useState } from 'react'
import { useActiveSession } from '../stores/session-store'
import type { SentFile } from '../../../shared/types'

/** True for `/x`, `\x`, and `C:\x` / `C:/x` — i.e. anything not cwd-relative. */
function isAbsoluteLike(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/**
 * Resolve a `SendUserFile` path for the shell IPC.
 *
 * cli.js accepts cwd-relative paths and resolves them itself, but the tool
 * INPUT we observe on the wire keeps whatever the model wrote. The main process
 * refuses relative paths outright (it would resolve them against its own cwd),
 * so join here against the session cwd, preserving the cwd's separator flavour.
 * Absolute inputs pass through untouched — main is still the validating side.
 */
export function resolveSentFilePath(cwd: string, filePath: string): string {
  if (isAbsoluteLike(filePath)) return filePath
  if (!cwd) return filePath
  const sep = cwd.includes('\\') && !cwd.includes('/') ? '\\' : '/'
  const base = cwd.replace(/[\\/]+$/, '')
  const rel = filePath.replace(/^\.[\\/]/, '')
  return `${base}${sep}${rel}`
}

/** Display name for a row: the path's last segment (both separators). */
function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}

/** Stable per-row identity — the same path can be re-sent by a later call. */
function rowKey(f: SentFile): string {
  return `${f.toolUseId}::${f.path}`
}

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
  const [expanded, setExpanded] = useState(false)
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  // Transient per-row failure text from the shell IPC (not part of session state).
  const [openErrors, setOpenErrors] = useState<Record<string, string>>({})

  if (sentFiles.length === 0) return null

  // Newest first — buildSentFilesFromMessages appends in send order.
  const rows = [...sentFiles].reverse()

  const toggleRow = (key: string): void => {
    setOpenRows((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
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

  return (
    <div
      data-testid="SentFilesWidget"
      className="bg-bg-tertiary border border-border light-no-border shadow-lg shadow-black/30 overflow-hidden transition-all duration-200 ease-out"
      style={{
        width: expanded ? 'min(400px, 45%)' : 155,
        borderRadius: expanded ? 12 : 8
      }}
    >
      {/* Header — always visible */}
      <button
        data-testid="SentFilesWidget.toggle"
        onClick={() => setExpanded(!expanded)}
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
              return (
                <div key={key} className="border-b border-border last:border-b-0">
                  <button
                    data-testid="SentFilesWidget.row"
                    data-id={file.path}
                    onClick={() => toggleRow(key)}
                    className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-bg-hover transition-colors cursor-pointer"
                  >
                    <FileIcon error={file.error} />
                    <span
                      className={`flex-1 min-w-0 text-[12px] leading-tight whitespace-nowrap overflow-hidden text-ellipsis ${
                        file.error ? 'text-error' : 'text-text-primary'
                      }`}
                    >
                      {basename(file.path)}
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
                    <div className="px-3 pb-2 pt-0.5 flex flex-col gap-1.5">
                      {file.caption && (
                        <div className="text-[11px] text-text-secondary italic leading-snug">
                          {file.caption}
                        </div>
                      )}
                      <div className="text-[11px] text-text-muted font-mono break-all select-text">
                        {absPath}
                      </div>
                      {file.error && (
                        <div className="text-[11px] text-error leading-snug break-words">
                          {file.error}
                        </div>
                      )}
                      {openError && (
                        <div className="text-[11px] text-error leading-snug break-words">
                          {openError}
                        </div>
                      )}
                      {(canOpen || canReveal) && (
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
    </div>
  )
}
