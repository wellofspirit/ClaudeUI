import { protocol } from 'electron'
import * as fs from 'fs'
import { join, resolve, extname, sep } from 'path'
import { MOCKUP_ASSET_SCHEME, MOCKUP_HTTP_PREFIX } from '../../shared/mockup-url'
import { getMockupSecuritySettings, type MockupSecuritySettings } from './mockup-settings'

export { MOCKUP_ASSET_SCHEME }

const MOCKUP_ID_RE = /^[a-f0-9]{8}$/
const HOST_SUFFIX = '.m'

/**
 * CDN allowlist for external scripts/styles/fonts. Intentionally narrow —
 * matches the set Anthropic's own artifact sandbox uses, minus the ones
 * ClaudeUI has no need for. See docs/mockup-sandbox-research.md §2 for
 * rationale.
 */
const CDN_SCRIPT = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://code.jquery.com'
]
const CDN_STYLE = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://code.jquery.com'
]
const CDN_FONT = [
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com'
]

/**
 * Build the Content-Security-Policy for the mockup HTML document.
 *
 * Layered posture: the iframe sandbox (allow-scripts allow-same-origin)
 * pairs with this CSP. The sub-origin wall is the real isolation boundary;
 * CSP is defense-in-depth.
 *
 * `connect-src` is dynamic — the user can extend it via settings. `http:`
 * is gated behind a separate toggle (HTTPS-only by default).
 */
export function buildMockupCsp(
  settings: MockupSecuritySettings,
  /**
   * The "own origin" source token for the served document. For the Electron
   * protocol it's the `mockup-asset:` scheme; for the remote HTTP transport
   * it's the server's concrete origin (e.g. `https://host:port`) — needed
   * because the web iframe runs in a sandboxed opaque origin where CSP `'self'`
   * matches nothing, so assets must be allowed by explicit origin.
   */
  selfSource: string = `${MOCKUP_ASSET_SCHEME}:`
): string {
  const scheme = selfSource
  const connectExtras: string[] = []
  for (const origin of settings.connectAllowlist) {
    // The textarea stores bare origins or wildcards; trust already-validated entries.
    connectExtras.push(origin)
  }
  const httpFallback = settings.allowHttp ? ' http: ws:' : ''

  return [
    `default-src 'none'`,
    // Scripts: inline + eval for Tailwind Play CDN's runtime JIT. `'self'`
    // is redundant with the scheme but harmless.
    `script-src 'self' ${scheme} 'unsafe-inline' 'unsafe-eval' ${CDN_SCRIPT.join(' ')}`,
    `style-src 'self' ${scheme} 'unsafe-inline' ${CDN_STYLE.join(' ')}`,
    `font-src 'self' ${scheme} data: ${CDN_FONT.join(' ')}`,
    `img-src 'self' ${scheme} data: blob: https:`,
    `media-src 'self' ${scheme} data: blob: https:`,
    `connect-src 'self' ${scheme} https: wss:${httpFallback}${connectExtras.length ? ' ' + connectExtras.join(' ') : ''}`,
    `worker-src 'self' ${scheme} blob:`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`
  ].join('; ')
}

/**
 * Allow-list of extensions we'll serve as sibling assets.
 * Keeps us from accidentally exposing .env, source files, or anything else
 * a model might drop into the mockup dir.
 */
export const ASSET_EXT_MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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
  | { kind: 'html'; id: string; mockupDir: string; dark: boolean }
  | { kind: 'asset'; id: string; path: string; mime: string }
  | { kind: 'error'; status: number; reason: string }

/**
 * Pure URL → RouteDecision resolver. No file I/O. All validation (id regex,
 * cwd absoluteness, path traversal, extension allow-list) happens here so it
 * can be unit-tested without Electron.
 */
export function routeAndValidate(url: URL): RouteDecision {
  const host = url.hostname
  if (!host.endsWith(HOST_SUFFIX)) {
    return { kind: 'error', status: 404, reason: 'unknown hostname' }
  }
  const id = host.slice(0, -HOST_SUFFIX.length)
  const segments = url.pathname.split('/').filter(Boolean)
  return routeMockupParts(id, segments, url.searchParams)
}

/**
 * HTTP-transport variant. URL layout: `/mockup/<id>/<b64cwd>/[<subpath>]`.
 * Reuses the same validation as the protocol scheme — only the id/segment
 * extraction differs (id from path, not hostname).
 */
export function routeHttpMockup(pathname: string, searchParams: URLSearchParams): RouteDecision {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] !== MOCKUP_HTTP_PREFIX) {
    return { kind: 'error', status: 404, reason: 'unknown route' }
  }
  const id = segments[1] ?? ''
  return routeMockupParts(id, segments.slice(2), searchParams)
}

/**
 * Transport-agnostic core: validates the mockup id, decodes the cwd, resolves
 * the target path, and enforces the path-traversal + extension allow-lists.
 * `segments` is `[<b64cwd>, ...<subpath>]`.
 */
export function routeMockupParts(
  id: string,
  segments: string[],
  searchParams: URLSearchParams
): RouteDecision {
  if (!MOCKUP_ID_RE.test(id)) {
    return { kind: 'error', status: 400, reason: 'invalid id' }
  }

  if (segments.length < 1) {
    return { kind: 'error', status: 400, reason: 'missing segments' }
  }

  const [b64cwd, ...rest] = segments

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
      id,
      mockupDir,
      dark: searchParams.get('dark') === '1'
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

  return { kind: 'asset', id, path: targetPath, mime }
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
 * URL layout (per-mockup sub-origin):
 *   mockup-asset://<id>.m/<b64cwd>/              → mockup HTML (index.html)
 *   mockup-asset://<id>.m/<b64cwd>/<sub/path>    → sibling asset
 *     ?dark=1           rewrite <html> to <html class="dark"> (HTML only)
 *     ?v=<n>            cache-bust on file change
 *     ?parent=<origin>  parent window origin for postMessage targeting
 */
export function registerMockupAssetHandler(): void {
  protocol.handle(MOCKUP_ASSET_SCHEME, async (request) => {
    const decision = routeAndValidate(new URL(request.url))
    const served = await serveMockup(decision, `${MOCKUP_ASSET_SCHEME}:`)
    // Buffer is a Uint8Array at runtime (valid BodyInit); the cast just
    // satisfies the DOM lib's narrower BodyInit type.
    return new Response(served.body as BodyInit, { status: served.status, headers: served.headers })
  })
}

/** Normalized serve result, consumable by both the Electron `Response` API
 *  (protocol handler) and Node's `http.ServerResponse` (remote server). */
export interface ServedMockup {
  status: number
  headers: Record<string, string>
  body: Buffer | string
}

/**
 * Transport-agnostic serving: turns a {@link RouteDecision} into bytes +
 * headers. Reads from the filesystem directly (no Electron `net`) so the
 * remote HTTP server can reuse it.
 *
 * `selfSource` is threaded into the CSP — `mockup-asset:` for the protocol,
 * the server origin for HTTP. Asset responses carry `Access-Control-Allow-Origin: *`
 * because the web client's sandboxed iframe loads them from an opaque origin.
 */
export async function serveMockup(decision: RouteDecision, selfSource: string): Promise<ServedMockup> {
  try {
    if (decision.kind === 'error') {
      return { status: decision.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: decision.reason }
    }

    if (decision.kind === 'html') {
      let html: string
      try {
        html = await fs.promises.readFile(join(decision.mockupDir, 'index.html'), 'utf-8')
      } catch {
        return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' }
      }
      html = rewriteHtml(html, decision.dark)
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': buildMockupCsp(getMockupSecuritySettings(), selfSource),
          'X-Content-Type-Options': 'nosniff'
        },
        body: html
      }
    }

    let body: Buffer
    try {
      body = await fs.promises.readFile(decision.path)
    } catch {
      return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not found' }
    }
    return {
      status: 200,
      headers: {
        'Content-Type': decision.mime,
        // `no-store` so sibling asset edits (images, CSS, JS) show up on the
        // next iframe reload. `location.reload()` in Chromium still respects
        // cache headers — `max-age` here would pin a stale asset until expiry.
        // Mockups are dev artifacts; the refetch overhead is fine.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*'
      },
      body
    }
  } catch {
    return { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Server error' }
  }
}

/**
 * Bridge/"omelette" script injected at serve time. Forwards console calls
 * plus uncaught errors + resource-load failures to the parent window,
 * reports height for auto-resize, and listens for parent-triggered reloads.
 *
 * Lives here (in the protocol handler, not in `wrapHtml`) so bug fixes and
 * new bridge features apply to every stored mockup file the next time it's
 * served — no rewrite needed.
 *
 * The `data-omelette="1"` attribute is a sentinel: any legacy files that
 * had a previous copy of the bootstrap baked in get that copy stripped
 * before we inject the fresh one, so the bridge never runs twice.
 *
 * Exported for tests.
 */
export const OMELETTE_BOOTSTRAP = `<script data-omelette="1">
(function(){
  try {
    var p = new URLSearchParams(location.search).get('parent');
    if (!p) return;
    var target = p;
    var MAX_LEN = 4000;
    function snip(s){ s = String(s); return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s; }
    function formatValue(v){
      if (v instanceof Error) {
        var head = (v.name || 'Error') + ': ' + (v.message || '');
        return v.stack ? String(v.stack) : head;
      }
      if (v && typeof v === 'object') {
        try {
          return JSON.stringify(v, function(_k, val){
            if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
            return val;
          });
        } catch (e) { return String(v); }
      }
      return String(v);
    }
    function safeArgs(args){
      var out = [];
      for (var i = 0; i < args.length; i++) out.push(snip(formatValue(args[i])));
      return out;
    }
    var levels = ['log','info','warn','error','debug'];
    for (var i = 0; i < levels.length; i++) {
      (function(level){
        var orig = console[level];
        console[level] = function(){
          try { parent.postMessage({type:'mockup:log', level: level, args: safeArgs(arguments)}, target); } catch (e) {}
          if (orig) orig.apply(console, arguments);
        };
      })(levels[i]);
    }
    // ErrorEvent fires for BOTH uncaught JS errors AND resource-load failures
    // (e.g. <img src="missing.png">). The two cases look completely different
    // on the event — split them up so the user sees useful details for each.
    window.addEventListener('error', function(e){
      try {
        var t = e && e.target;
        // Resource-load failure: e.target is an element with a src/href attr,
        // not the window. e.message + e.error are both empty.
        if (t && t !== window && t.nodeType === 1 && (t.src || t.href)) {
          var url = t.src || t.href;
          var tag = (t.tagName || 'resource').toLowerCase();
          parent.postMessage({
            type: 'mockup:error',
            message: snip('Failed to load <' + tag + '>: ' + url),
            stack: '',
            filename: snip(url),
            lineno: 0
          }, target);
          return;
        }
        // Uncaught JS error. e.error holds the real Error object for
        // same-origin scripts; it's null for cross-origin scripts loaded
        // without CORS (e.message is the sanitized "Script error." string).
        var err = e && e.error;
        var name = err && err.name ? err.name : '';
        var msg = err && err.message ? err.message : (e.message || '');
        var fullMsg = name && msg ? (name + ': ' + msg) : (name || msg || 'Uncaught error (details suppressed by browser — likely a cross-origin script without CORS)');
        parent.postMessage({
          type: 'mockup:error',
          message: snip(fullMsg),
          stack: err && err.stack ? snip(err.stack) : '',
          filename: snip(e.filename || ''),
          lineno: e.lineno || 0
        }, target);
      } catch (err) {}
    }, true);
    window.addEventListener('unhandledrejection', function(e){
      try {
        var reason = e && e.reason;
        var isErr = reason instanceof Error;
        var name = isErr && reason.name ? reason.name : '';
        var msg = isErr && reason.message ? reason.message : String(reason);
        var fullMsg = name && msg ? (name + ': ' + msg) : msg;
        parent.postMessage({
          type: 'mockup:error',
          message: snip('Unhandled rejection: ' + fullMsg),
          stack: isErr && reason.stack ? snip(reason.stack) : '',
          filename: '',
          lineno: 0
        }, target);
      } catch (err) {}
    });
    function postHeight(){
      try {
        var h = document.documentElement.scrollHeight;
        parent.postMessage({type:'mockup:height', height: h}, target);
      } catch (e) {}
    }
    function wireHeight(){
      postHeight();
      try {
        var ro = new ResizeObserver(postHeight);
        ro.observe(document.documentElement);
        if (document.body) ro.observe(document.body);
      } catch (e) {}
      window.addEventListener('load', postHeight);
    }
    // Tag <script type="text/babel"|"text/jsx"> blocks with data-plugins +
    // data-filename BEFORE @babel/standalone scans them on DOMContentLoaded.
    // This makes JSX error stack traces readable (filename + line number)
    // instead of pointing at anonymous runtime-compiled blobs. Matches the
    // claude.ai/design runtime behavior. No-op when no Babel scripts are
    // present — cost is a single querySelectorAll per page load.
    function tagBabelScripts(){
      try {
        var scripts = document.querySelectorAll(
          'script[type="text/babel"], script[type="text/jsx"]'
        );
        var n = 0;
        for (var i = 0; i < scripts.length; i++) {
          var s = scripts[i];
          if (!s.hasAttribute('data-plugins')) {
            s.setAttribute('data-plugins', 'transform-react-jsx-source');
          }
          if (!s.hasAttribute('data-filename')) {
            var src = s.getAttribute('src');
            s.setAttribute('data-filename', src || 'inline-' + (++n));
          }
        }
      } catch (e) {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function(){
        tagBabelScripts();
        wireHeight();
      });
    } else {
      tagBabelScripts();
      wireHeight();
    }
    // Parent-triggered in-place reload. Avoids mutating the iframe's src
    // attribute — which in Chromium causes the iframe to steal focus on the
    // new load, scrolling the parent container to the iframe. location.reload()
    // keeps focus on the outer page while still refetching the HTML (no-store).
    window.addEventListener('message', function(ev){
      try {
        if (ev.source !== window.parent) return;
        if (ev.origin !== target) return;
        var d = ev.data;
        if (d && d.type === 'mockup:reload') { location.reload(); }
      } catch (err) {}
    });
  } catch (e) {}
})();
</script>`

/**
 * Strips any `<script data-omelette="1">...</script>` blocks from the HTML.
 * Legacy mockup files may have an older copy of the bridge baked in by a
 * previous `wrapHtml`; stripping guarantees only the serve-time injected
 * copy runs. Case-insensitive match, `s` flag so `.` crosses newlines.
 */
const OMELETTE_STRIP_RE =
  /<script\b[^>]*\bdata-omelette\s*=\s*["']?1["']?[^>]*>[\s\S]*?<\/script>/gi

/**
 * Applies server-side HTML transforms: dark-mode class + bridge script
 * injection. Exported for unit tests.
 */
export function rewriteHtml(html: string, dark: boolean): string {
  let out = html.replace(OMELETTE_STRIP_RE, '')
  // Inject the bridge right before `</head>`. If the HTML has no </head>
  // (malformed / user-edited), fall back to prepending — the script still
  // runs, just later than ideal.
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${OMELETTE_BOOTSTRAP}\n</head>`)
  } else {
    out = OMELETTE_BOOTSTRAP + out
  }
  if (dark) {
    out = out.replace('<html', '<html class="dark"')
  }
  return out
}
