/**
 * The CSS zoom in effect on `el`, whichever ancestor applies it (1 when none
 * does). The app renders under `zoom: uiFontScale`, and inside that subtree
 * `getBoundingClientRect()` reports page px while `offsetWidth`, `scrollTop`,
 * `clientHeight` and CSS `left`/`top`/`width` are in the element's own CSS px —
 * see THE ZOOM TRAP in `components/shared/use-anchored-menu.ts`. Divide a
 * measured page-px distance by this to get CSS px.
 *
 * Pass `rect` when the caller has already measured `el`, to avoid a second
 * layout read.
 */
export function effectiveZoom(el: HTMLElement, rect: DOMRect = el.getBoundingClientRect()): number {
  return el.offsetWidth ? rect.width / el.offsetWidth : 1
}
