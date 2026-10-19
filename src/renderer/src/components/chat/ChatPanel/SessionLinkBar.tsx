/**
 * "Continued in →" / "Continued from ←" under the top bar (session tools, slice 1b).
 *
 * A hand-off leaves the original session running and starts a fresh one, so each
 * side of the pair says where the other is: the original names the session it
 * continued in, the new one the session it continued from. Each name opens that
 * session. A plain `started` session is not a continuation (the originating
 * session's transcript has its card), and the markers stay whether or not the user
 * has detached the pair from its group: the lineage is kept. Reads the replicated
 * links only; renders nothing when the active
 * session has none. Flex-wrap, 32px targets, no viewport units (ADR-093).
 */
import { useMemo } from 'react'
import { useSessionStore } from '../../../stores/session-store'
import {
  openSessionById,
  originLinkOf,
  sessionTitleOf,
  startedLinksOf
} from '../../../lib/session-links'

export interface Continuation {
  direction: 'from' | 'into'
  id: string
  title: string
}

export function SessionLinkBarView({
  items,
  onOpen
}: {
  items: Continuation[]
  onOpen: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <div
      data-testid="SessionLinkBar"
      className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 border-b border-border text-[12px] text-text-muted"
    >
      {items.map((item) => (
        <button
          key={`${item.direction}:${item.id}`}
          type="button"
          data-testid={item.direction === 'from' ? 'SessionLinkBar.from' : 'SessionLinkBar.into'}
          data-id={item.id}
          onClick={() => onOpen(item.id)}
          title={item.title}
          className="min-h-8 max-w-full flex items-center gap-1.5 hover:text-text-primary transition-colors cursor-pointer"
        >
          <span className="shrink-0">
            {item.direction === 'from' ? 'Continued from ←' : 'Continued in →'}
          </span>
          <span className="truncate text-text-secondary">{item.title}</span>
        </button>
      ))}
    </div>
  )
}

/** The bar for the active session. */
export function SessionLinkBar(): React.JSX.Element | null {
  // One string, so the selector's result is a primitive and compares by value.
  const key = useSessionStore((s) => {
    const id = s.activeSessionId
    if (!id) return '[]'
    const items: Continuation[] = []
    const origin = originLinkOf(s, id)
    if (origin?.link.kind === 'handoff' && origin.originId) {
      items.push({
        direction: 'from',
        id: origin.originId,
        title: sessionTitleOf(s, origin.originId) || 'previous session'
      })
    }
    for (const child of startedLinksOf(s, id)) {
      if (child.link.kind === 'handoff' && child.childId) {
        items.push({
          direction: 'into',
          id: child.childId,
          title: sessionTitleOf(s, child.childId) || 'new session'
        })
      }
    }
    return JSON.stringify(items)
  })
  const items = useMemo(() => JSON.parse(key) as Continuation[], [key])
  return <SessionLinkBarView items={items} onOpen={(id) => void openSessionById(id)} />
}
