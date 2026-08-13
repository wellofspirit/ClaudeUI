/**
 * "Copy as image" — rasterize either viewer entry variant to a PNG and put it on
 * the clipboard.
 *
 * Both the Mermaid card's toolbar button and the full-screen viewer's context
 * menu write images, and the viewer's gallery can hold either an inline-SVG
 * entry (a diagram) or a raster one (an attachment / tool-result screenshot).
 * That is why this module sits in `shared/`: the SVG path was extracted from the
 * Mermaid card, the raster path is new, and the clipboard write is identical for
 * both.
 *
 * Everything normalizes to **image/png**. Chromium's async clipboard rejects
 * most other image types outright, so even a JPEG attachment has to go through a
 * canvas rather than being handed over as-is.
 */

import { ensureViewBox, parseSvgElement, svgElementToXml } from './svg-dom'

/**
 * The canvas colour the app sits on, for the PNG's opaque backdrop.
 *
 * Every mermaid theme config sets `background: 'transparent'`, so a diagram is
 * drawn straight onto whatever is behind it — `--color-bg-primary`. A hardcoded
 * white fill therefore pasted dark-theme nodes and light text onto a white
 * sheet. Falls back to white when the variable resolves empty (jsdom, or a theme
 * that stops defining it), which is the historical behaviour.
 */
export function themeCanvasBackground(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-bg-primary')
    .trim()
  return value || '#ffffff'
}

/**
 * Rasterize SVG markup to a PNG blob at 2x, on an opaque `background`.
 *
 * The background is a parameter rather than a call to `themeCanvasBackground()`
 * in here so the function stays pure enough to reason about (and so a caller
 * that already resolved the colour does not resolve it twice).
 */
export async function svgToPngBlob(svgString: string, background: string): Promise<Blob | null> {
  const svgEl = parseSvgElement(svgString)
  if (!svgEl) return null

  const { width, height } = ensureViewBox(svgEl)

  // 2x for retina clarity
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = width * scale
  canvas.height = height * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.scale(scale, scale)

  // Fill an opaque background so transparent SVG areas aren't see-through in
  // the PNG — the app's canvas colour, so the copy matches what was on screen.
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)

  // Use a data URI instead of blob URL — blob URLs taint the canvas in Electron,
  // preventing toBlob() from working. Data URIs are always same-origin.
  // Serialize to XML-well-formed markup so the <img> SVG (parsed as strict XML)
  // doesn't choke on htmlLabels' bare <br> tags. See ADR-012.
  const encoded = btoa(unescape(encodeURIComponent(svgElementToXml(svgEl))))
  const dataUri = `data:image/svg+xml;base64,${encoded}`

  return new Promise<Blob | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, width, height)
      canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png')
    }
    img.onerror = () => resolve(null)
    img.src = dataUri
  })
}

/**
 * Re-encode a raster image (`data:` URI or same-origin URL) as a PNG blob at its
 * natural size.
 *
 * No `crossOrigin` handshake: viewer entries are either data URIs or URLs served
 * by the app itself. A genuinely cross-origin source would taint the canvas and
 * make `toBlob` throw SecurityError, which is caught and reported as "no blob"
 * rather than as an exception the caller has to special-case.
 */
export async function rasterToPngBlob(src: string): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    const img = new Image()
    img.onload = () => {
      const width = img.naturalWidth || img.width
      const height = img.naturalHeight || img.height
      if (!width || !height) return resolve(null)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      try {
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((pngBlob) => resolve(pngBlob), 'image/png')
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * Write a PNG to the clipboard, given the blob as a **promise**.
 *
 * `ClipboardItem` accepts `Promise<Blob>`, and that is the only shape that works
 * here: Chromium requires `clipboard.write()` to be reached inside the
 * user-gesture window, while rasterizing an SVG needs an `<img>` load that
 * resolves several ticks later. Awaiting the blob first loses the gesture and the
 * write is rejected as untrusted.
 *
 * Rejects (rather than silently doing nothing) when rasterizing produced no
 * blob, so callers have one failure path to log.
 */
export async function writeClipboardImage(blobPromise: Promise<Blob | null>): Promise<void> {
  await navigator.clipboard.write([
    new ClipboardItem({
      'image/png': blobPromise.then((blob) => {
        if (!blob) throw new Error('Failed to generate PNG')
        return blob
      })
    })
  ])
}
