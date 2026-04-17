import { protocol, net, app } from 'electron'
import { join, resolve, extname, sep } from 'path'
import { pathToFileURL } from 'url'
import { MOCKUP_ASSET_SCHEME } from '../../shared/mockup-url'

export { MOCKUP_ASSET_SCHEME }

const MOCKUP_ID_RE = /^[a-f0-9]{8}$/

/**
 * Response CSP for the mockup HTML document. The sandboxed iframe has an
 * opaque origin, but CSP is belt-and-braces: block scripts & nested frames,
 * scope styles to our protocol + inline, allow images/fonts broadly so mockups
 * can pull in stock images and data URIs.
 */
export const MOCKUP_HTML_CSP =
  "default-src 'none'; " +
  'style-src mockup-asset: \'unsafe-inline\'; ' +
  'img-src * data:; ' +
  'font-src * data:; ' +
  "script-src 'none'; " +
  "frame-src 'none'"

/**
 * Allow-list of extensions we'll serve as sibling assets.
 * Keeps us from accidentally exposing .env, source files, or anything else
 * a model might drop into the mockup dir.
 */
export const ASSET_EXT_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
}

export type RouteDecision =
  | { kind: 'tailwind' }
  | { kind: 'html'; mockupDir: string; dark: boolean }
  | { kind: 'asset'; path: string; mime: string }
  | { kind: 'error'; status: number; reason: string }

/**
 * Pure URL → RouteDecision resolver. No file I/O. All validation (id regex,
 * cwd absoluteness, path traversal, extension allow-list) happens here so it
 * can be unit-tested without Electron.
 */
export function routeAndValidate(url: URL): RouteDecision {
  if (url.hostname === 'tailwind.css') {
    return { kind: 'tailwind' }
  }

  if (url.hostname !== 'm') {
    return { kind: 'error', status: 404, reason: 'unknown hostname' }
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    return { kind: 'error', status: 400, reason: 'missing segments' }
  }

  const [b64cwd, id, ...rest] = segments
  if (!MOCKUP_ID_RE.test(id)) {
    return { kind: 'error', status: 400, reason: 'invalid id' }
  }

  let cwd: string
  try {
    cwd = Buffer.from(b64cwd, 'base64url').toString('utf-8')
  } catch {
    return { kind: 'error', status: 400, reason: 'bad cwd encoding' }
  }
  if (!cwd || (!cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd))) {
    return { kind: 'error', status: 400, reason: 'cwd must be absolute' }
  }

  const mockupDir = resolve(join(cwd, '.claude', 'ui', 'mockups', id))
  const relPath = rest.map((s) => decodeURIComponent(s)).join('/')

  if (!relPath || relPath === 'index.html') {
    return {
      kind: 'html',
      mockupDir,
      dark: url.searchParams.get('dark') === '1'
    }
  }

  const targetPath = resolve(join(mockupDir, relPath))
  if (targetPath !== mockupDir && !targetPath.startsWith(mockupDir + sep)) {
    return { kind: 'error', status: 403, reason: 'path traversal blocked' }
  }

  const ext = extname(targetPath).toLowerCase()
  const mime = ASSET_EXT_MIME[ext]
  if (!mime) {
    return { kind: 'error', status: 403, reason: 'file type not allowed' }
  }

  return { kind: 'asset', path: targetPath, mime }
}

/**
 * Privileged scheme registration. Must run before `app.whenReady` fires.
 */
export function registerMockupAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MOCKUP_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

/**
 * Registers the handler that serves assets to the mockup iframe.
 *
 * URL layout:
 *   mockup-asset://tailwind.css/                  → bundled Tailwind CSS
 *   mockup-asset://m/<b64cwd>/<id>/               → mockup HTML (index.html)
 *   mockup-asset://m/<b64cwd>/<id>/<sub/path>     → sibling asset (img/font/css)
 *     ?dark=1   — rewrite <html> to <html class="dark"> (HTML only)
 *     ?v=<n>    — cache-bust on file change
 */
export function registerMockupAssetHandler(): void {
  const isDev = !app.isPackaged
  const cssPath = isDev
    ? join(__dirname, '../../resources/tailwind-full.css')
    : join(process.resourcesPath, 'tailwind-full.css')

  protocol.handle(MOCKUP_ASSET_SCHEME, async (request) => {
    try {
      const decision = routeAndValidate(new URL(request.url))

      if (decision.kind === 'error') {
        return new Response(decision.reason, { status: decision.status })
      }

      if (decision.kind === 'tailwind') {
        const response = await net.fetch(pathToFileURL(cssPath).toString())
        if (!response.ok) return new Response('Not found', { status: 404 })
        const body = await response.arrayBuffer()
        return new Response(body, {
          headers: {
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        })
      }

      if (decision.kind === 'html') {
        return serveHtml(decision.mockupDir, decision.dark)
      }

      const fileResponse = await net.fetch(pathToFileURL(decision.path).toString())
      if (!fileResponse.ok) return new Response('Not found', { status: 404 })
      const body = await fileResponse.arrayBuffer()
      return new Response(body, {
        headers: {
          'Content-Type': decision.mime,
          'Cache-Control': 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('Server error', { status: 500 })
    }
  })
}

async function serveHtml(mockupDir: string, dark: boolean): Promise<Response> {
  const htmlPath = join(mockupDir, 'index.html')
  const fileResponse = await net.fetch(pathToFileURL(htmlPath).toString())
  if (!fileResponse.ok) return new Response('Not found', { status: 404 })

  let html = await fileResponse.text()
  html = rewriteHtml(html, dark)

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Content-Security-Policy': MOCKUP_HTML_CSP,
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

/**
 * Applies server-side HTML transforms: dark-mode class and the back-compat
 * Tailwind placeholder rewrite. Exported for unit tests.
 */
export function rewriteHtml(html: string, dark: boolean): string {
  let out = html
  if (out.includes('<!-- tailwind:inject -->')) {
    out = out.replace(
      '<!-- tailwind:inject -->',
      '<link rel="stylesheet" href="mockup-asset://tailwind.css">'
    )
  }
  if (dark) {
    out = out.replace('<html', '<html class="dark"')
  }
  return out
}
