/**
 * SheetFrame — the geometry both provider sheets wear (ADR-065 phase 6b/6c,
 * boards `board2-ProviderManage.png` and `board2-ProviderAdd.png`).
 *
 * Extracted from `ProviderSheet` when the Add sheet arrived: two sheets that
 * pin themselves to the dialog's right edge by mirroring its box formula would
 * be two chances to get that formula wrong, and they must never disagree.
 *
 * DELIBERATE GEOMETRY (unchanged from 6b). The frame is a `fixed` overlay that
 * reproduces the settings dialog's own box (`View.tsx`:
 * `min(1040px, 92vw/scale) × min(700px, 88vh/scale)`, centred) and pins the
 * panel to that box's right edge below the 52px header, so it reads as part of
 * the dialog rather than as another stacked modal. It mirrors the formula
 * instead of measuring, because the dialog renders under CSS `zoom` and a
 * measured rect and a `fixed` inset resolve in different coordinate spaces. On
 * a phone (`useIsMobile`) the whole thing is the screen.
 *
 * ESCAPE CLOSES THE TOPMOST SHEET ONLY, captured, and the event is stopped so
 * the settings dialog behind does not close along with it. See `SHEET_STACK`.
 */

import { useEffect, useRef } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { useIsMobile } from '../../hooks/useIsMobile'

/**
 * Every mounted frame, oldest first. The Manage sheet mounts a SECOND frame for
 * "Edit endpoint", and both listen for Escape on `document` — so one press used
 * to close both, dropping the user back on the providers list when they only
 * meant to cancel the edit. A frame answers Escape only while it is the last
 * entry here.
 *
 * Module level because that is the only scope both frames share: they are
 * siblings in ProviderSheet's tree, not parent and child, so no context or ref
 * reaches from one to the other.
 */
const SHEET_STACK: object[] = []

export interface SheetFrameProps {
  /** Tier-1 testid of the OWNING sheet — the frame stamps no id of its own. */
  testid: string
  dataId?: string
  title: string
  /** Rendered after the title (the id, the credential chip). */
  titleExtras?: React.ReactNode
  /** The bottom bar: whatever the sheet's own actions are. */
  footer: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}

export function SheetFrame({
  testid,
  dataId,
  title,
  titleExtras,
  footer,
  onClose,
  children
}: SheetFrameProps): React.JSX.Element {
  const isMobile = useIsMobile()
  const uiFontScale = useSessionStore((s) => s.settings.uiFontScale)

  /**
   * Read through a ref so the registration below can depend on NOTHING. The
   * endpoint sheet passes an inline arrow as `onClose`, so a `[onClose]` effect
   * would re-run on every render of its parent — and re-registering means
   * re-pushing, which would make whichever sheet last re-rendered the "top" one
   * regardless of mount order.
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const token = {}
    SHEET_STACK.push(token)
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Not the top sheet: say nothing at all — including not stopping the
      // event, which is the top sheet's job.
      if (SHEET_STACK[SHEET_STACK.length - 1] !== token) return
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('keydown', handler, true)
    return () => {
      document.removeEventListener('keydown', handler, true)
      const at = SHEET_STACK.indexOf(token)
      if (at !== -1) SHEET_STACK.splice(at, 1)
    }
  }, [])

  const panel = (
    <div
      data-testid={testid}
      data-id={dataId}
      // `relative z-10` is load-bearing: the scrim below is an absolutely
      // positioned sibling, and a STATIC panel paints beneath it — every click
      // inside the sheet then lands on the scrim and closes it. Found by the
      // real-app probe; jsdom does no hit-testing.
      className={`relative z-10 pointer-events-auto flex flex-col bg-bg-primary animate-fade-in ${
        isMobile ? 'w-full h-full' : 'w-[560px] max-w-full h-full border-l border-border shadow-2xl'
      }`}
    >
      <div className="h-[52px] shrink-0 flex items-center gap-2 px-4 border-b border-border">
        <span className="text-[15px] font-semibold text-text-primary truncate">{title}</span>
        {titleExtras}
        <button
          type="button"
          data-testid={`${testid}.close`}
          title="Close"
          onClick={onClose}
          className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{children}</div>

      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border">
        {footer}
      </div>
    </div>
  )

  if (isMobile) {
    return <div className="fixed inset-0 z-[100] flex">{panel}</div>
  }
  return (
    // The dialog's own geometry, mirrored rather than measured — see the header.
    <div className="fixed inset-0 z-[100] flex items-center justify-center pointer-events-none">
      <div
        style={{
          width: `min(1040px, calc(92vw / ${uiFontScale}))`,
          height: `min(700px, calc(88vh / ${uiFontScale}))`
        }}
        className="relative flex justify-end pt-[52px] overflow-hidden rounded-xl"
      >
        <span
          data-testid={`${testid}.scrim`}
          onClick={onClose}
          className="absolute inset-0 pointer-events-auto bg-black/30"
        />
        {panel}
      </div>
    </div>
  )
}

/** A group header inside a sheet: the board's caps label, plus an optional chip. */
export function SheetGroup({
  testid,
  id,
  label,
  trailing,
  children
}: {
  /** `${SHEET}.group` — the owning sheet's namespace. */
  testid: string
  id: string
  label: string
  trailing?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testid} data-id={id} className="mt-5 first:mt-0">
      <div className="flex items-center gap-3 h-8 px-1 mb-2">
        <span className="flex-1 min-w-0 truncate text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
          {label}
        </span>
        {trailing}
      </div>
      <div className="border border-border rounded-lg bg-bg-secondary overflow-hidden divide-y divide-border/55">
        {children}
      </div>
    </div>
  )
}
