/**
 * The phone's sidebar drawer: a scrim and a left-edge panel over the chat.
 *
 * It is drawn INSIDE SessionView's zoomed root, so its pixels are zoomed pixels
 * (ADR-093): a plain `w-[280px]` is 420px of a 412px screen at uiFontScale 1.5.
 * `max-w-[85%]` caps it against the fixed containing block, which is the
 * window, so it never covers more than 85% of the screen at any scale and the
 * scrim always has a strip to tap. The sidebar inside follows the wrapper
 * (`width: 100%`), or it would overflow the capped panel.
 */
import type { ReactNode } from 'react'

export function MobileSidebarDrawer({
  onClose,
  children
}: {
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div
        data-testid="MobileSidebarDrawer"
        className="fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85%] animate-slide-in-left overflow-y-auto"
      >
        {children}
      </div>
    </>
  )
}
