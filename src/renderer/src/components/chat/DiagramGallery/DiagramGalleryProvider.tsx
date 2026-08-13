/**
 * DiagramGalleryProvider — owns the session-wide mermaid gallery and the viewer
 * it opens.
 *
 * Mounted around the same message lists as `ImageGalleryProvider` (ChatPanel,
 * SubagentMessages, AutomationRunHistory). Expanding any diagram card hands its
 * `toolUseId` to `openDiagram`, and the viewer opens on **every** diagram of that
 * message list with the clicked one selected — so prev/next, swipe and the arrow
 * keys page a session's diagrams the way they already page its images.
 *
 * Two things make this more than a copy of the image provider:
 *
 *  - The other diagrams were never rendered. Their SVG has to be produced on
 *    demand, through the very pipeline the cards use (`renderMermaidSvg`), which
 *    is why `openDiagram` is async and returns whether it managed to open. A
 *    source that does not render is dropped from the gallery rather than paged to
 *    as a blank; if the CLICKED one is what failed, the call resolves false and
 *    the card falls back to its own overlay (it has a good SVG already).
 *  - Rendering is cached module-side, keyed by theme + source, because paging back
 *    into an already-visited gallery is common and a re-render of a large diagram
 *    is not cheap.
 *
 * The context value is deliberately **identity-stable** (`useCallback(…, [])` over
 * a ref): `MessageBubble` is `memo`-wrapped, and a value that changed on every
 * message update would re-render every bubble on every streaming partial. For the
 * same reason the theme is read imperatively from the store inside `openDiagram`
 * instead of subscribed to — a subscription here would re-render the provider (and
 * with it the whole message list) on unrelated settings churn.
 *
 * The default context is a no-op with `enabled: false`, so a diagram card renders
 * fine unwrapped and simply keeps its local single-entry overlay.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ChatMessage } from '../../../../../shared/types'
import { useActiveSession, useSessionStore } from '../../../stores/session-store'
import { ImageViewerOverlay, type ViewerSvgImage } from '../../shared/ImageViewer'
import { engineToolMap } from '../tool-registry/engine-tool-maps'
import { resolveThemeConfig, type MermaidThemeConfig } from '../mermaid-themes'
import { renderMermaidSvg, toViewerSvgEntry } from '../mermaid-render'
import { deriveDiagrams, type DiagramDescriptor } from './derive'

export const DIAGRAMS_TAB_ID = 'diagrams'
export const DIAGRAMS_TAB_LABEL = 'Diagrams'

export interface DiagramGalleryContextValue {
  /**
   * Open the viewer on one diagram, paging the whole session's diagrams.
   *
   * Resolves **false** when it opened nothing — the id is not in this provider's
   * message list, or that diagram's source failed to render. Callers are expected
   * to fall back to whatever local view they have.
   */
  openDiagram: (toolUseId: string) => Promise<boolean>
  /** False when no provider is mounted — cards keep their own overlay. */
  enabled: boolean
}

const NO_GALLERY: DiagramGalleryContextValue = {
  openDiagram: async () => false,
  enabled: false
}

const DiagramGalleryContext = createContext<DiagramGalleryContextValue>(NO_GALLERY)

export function useDiagramGallery(): DiagramGalleryContextValue {
  return useContext(DiagramGalleryContext)
}

// ---------------------------------------------------------------------------
// Render cache
// ---------------------------------------------------------------------------

/**
 * theme+source → the in-flight or settled SVG render.
 *
 * Module-level, not per-provider: switching session unmounts the provider, and a
 * user flipping between two sessions' diagrams would otherwise re-render
 * everything each time. Bounded because that same longevity is what would
 * otherwise let it grow without limit across a long-lived app session.
 *
 * Caching the *promise* also collapses the duplicate work when two diagrams in one
 * transcript share a source (an LLM re-emitting the same diagram after an edit is
 * common) — the second lookup awaits the first render.
 *
 * A rejected render evicts itself: mermaid failing is usually the source, but it
 * can also be a chunk load that failed on a flaky tunnel, and that must not be
 * remembered as "this diagram is broken" forever.
 */
const MAX_CACHED_RENDERS = 64
const svgCache = new Map<string, Promise<string>>()

/**
 * Identity of a theme for cache purposes.
 *
 * Stringified rather than keyed on object identity: `resolveThemeConfig` returns
 * the shared `THEME_CONFIGS` object for 'auto', but builds a FRESH object for an
 * explicit mermaid theme — an identity key would miss the cache on every open for
 * those users.
 */
function themeKeyOf(themeConfig: MermaidThemeConfig): string {
  return `${themeConfig.base}|${JSON.stringify(themeConfig.variables)}`
}

async function cachedRender(
  source: string,
  themeConfig: MermaidThemeConfig,
  themeKey: string
): Promise<string | null> {
  const key = `${themeKey}|${source}`
  let pending = svgCache.get(key)
  if (!pending) {
    pending = renderMermaidSvg(source, themeConfig)
    svgCache.set(key, pending)
    // Attached here (not only at the await below) so a rejection is always
    // handled — an unawaited cache hit would otherwise surface as an unhandled
    // rejection.
    pending.catch(() => {
      if (svgCache.get(key) === pending) svgCache.delete(key)
    })
    // Insertion-ordered eviction: oldest render out first.
    while (svgCache.size > MAX_CACHED_RENDERS) {
      const oldest = svgCache.keys().next()
      if (oldest.done) break
      svgCache.delete(oldest.value)
    }
  }
  try {
    return await pending
  } catch {
    return null
  }
}

/** Test seam: the cache is module state, so a component test has to be able to clear it. */
export function __clearDiagramRenderCache(): void {
  svgCache.clear()
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface OpenState {
  images: ViewerSvgImage[]
  index: number
}

export function DiagramGalleryProvider({
  messages,
  children
}: {
  messages: ChatMessage[]
  children: React.ReactNode
}): React.JSX.Element {
  // Same source of truth ToolCallBlock uses to pick a tool map, so a diagram is
  // classified in here exactly as its own card classified it.
  const engineId = useActiveSession((s) => s.status.engineId)
  const diagrams = useMemo<DiagramDescriptor[]>(
    () => deriveDiagrams(messages, engineToolMap(engineId)),
    [messages, engineId]
  )
  const [open, setOpen] = useState<OpenState | null>(null)

  // Read by the stable `openDiagram` below, which must not re-create itself (and
  // re-render every memoised MessageBubble) when a message arrives.
  const diagramsRef = useRef(diagrams)
  diagramsRef.current = diagrams

  const openDiagram = useCallback(async (toolUseId: string): Promise<boolean> => {
    const descriptors = diagramsRef.current
    const clicked = descriptors.findIndex((d) => d.toolUseId === toolUseId)
    if (clicked < 0) return false

    const { mermaidTheme, theme } = useSessionStore.getState().settings
    const themeConfig = resolveThemeConfig(mermaidTheme ?? 'auto', theme)
    const themeKey = themeKeyOf(themeConfig)

    // Concurrent by design. mermaid's module is a singleton and `initialize` is
    // global, but every render here passes the SAME config, so interleaving is
    // indistinguishable from the status quo — several mounted cards already race
    // each other through exactly this path on any transcript with two diagrams.
    const rendered = await Promise.all(
      descriptors.map((d) => cachedRender(d.source, themeConfig, themeKey))
    )

    const images: ViewerSvgImage[] = []
    let index = -1
    let dropped = 0
    descriptors.forEach((descriptor, i) => {
      const svg = rendered[i]
      const entry =
        svg === null
          ? null
          : toViewerSvgEntry(svg, descriptor.title || 'Mermaid diagram', descriptor.source)
      if (!entry) {
        dropped++
        return
      }
      if (i === clicked) index = images.length
      images.push(entry)
    })

    if (dropped > 0) {
      console.debug(`DiagramGallery: dropped ${dropped} diagram(s) that failed to render`)
    }
    // The clicked diagram itself failed — the card's own SVG is better than an
    // off-by-one gallery, so let it fall back.
    if (index < 0) return false

    setOpen({ images, index })
    return true
  }, [])

  const value = useMemo<DiagramGalleryContextValue>(
    () => ({ openDiagram, enabled: true }),
    [openDiagram]
  )

  return (
    <DiagramGalleryContext.Provider value={value}>
      {children}
      {open && (
        <ImageViewerOverlay
          tabs={[{ id: DIAGRAMS_TAB_ID, label: DIAGRAMS_TAB_LABEL, images: open.images }]}
          initialTabId={DIAGRAMS_TAB_ID}
          initialIndex={open.index}
          onClose={() => setOpen(null)}
        />
      )}
    </DiagramGalleryContext.Provider>
  )
}
