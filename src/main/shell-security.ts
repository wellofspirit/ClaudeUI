/**
 * Pure URL/scheme guards for the Electron shell surface.
 *
 * These functions carry no Electron dependency so they can be unit-tested in
 * isolation. `src/main/index.ts` wires them into `will-navigate`,
 * `setWindowOpenHandler`, the webview navigation guard, and `app:open-in-vscode`.
 */

/** The app's own document — the only target a top-level/sub-frame navigation may reach. */
export type AppOrigin =
  /** Dev: the Vite renderer origin (e.g. "http://localhost:5173"). Same-origin passes. */
  | { mode: 'dev-origin'; origin: string }
  /** Prod: a `file://` href prefix (the renderer directory, trailing slash). */
  | { mode: 'file-prefix'; prefix: string }

/**
 * Whether `shell.openExternal` may open `rawUrl`.
 *
 * Only web + mail schemes are allowed. Everything else — most importantly
 * `file:`, `javascript:`, `vbscript:`, `vscode:` and other custom/handler
 * schemes that can launch local programs — is refused. A URL that does not
 * parse is refused.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }
  return (
    parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:'
  )
}

/**
 * Whether a navigation to `targetUrl` stays inside the app's own document.
 *
 * Dev: the target's origin must match the renderer origin exactly.
 * Prod: the target must be a `file://` URL whose href sits under the renderer
 *       directory prefix (guards against `renderer-evil/…` sibling escapes).
 * A URL that does not parse is treated as a foreign (blocked) navigation.
 */
export function isInAppNavigation(targetUrl: string, appOrigin: AppOrigin): boolean {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return false
  }
  if (appOrigin.mode === 'dev-origin') {
    return parsed.origin === appOrigin.origin
  }
  return parsed.protocol === 'file:' && parsed.href.startsWith(appOrigin.prefix)
}

/**
 * Whether a plugin webview may navigate to `targetUrl`.
 *
 * Plugin views are local HTML bundles, so only `file://` navigations are
 * allowed. This re-validates on every navigation/redirect (not just the
 * initial attach), so a plugin page cannot navigate the top frame to remote
 * content while keeping the plugin preload (and its `pluginId`) attached.
 */
export function isAllowedWebviewNavigation(targetUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return false
  }
  return parsed.protocol === 'file:'
}

/** True if `s` contains any C0 control char (0x00–0x1F) or DEL (0x7F). */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Build a safe `vscode://file/<path>` URL for `cwd`, or `null` if `cwd` is
 * unsafe to interpolate.
 *
 * `vscode:` is a fixed, app-initiated scheme, so it is not subject to the
 * external-scheme allowlist — but the caller-supplied `cwd` is untrusted. We:
 *   - reject empty input and any control character / newline (URL-injection),
 *   - normalise Windows `\` to `/`,
 *   - `encodeURI` the path and additionally percent-encode `?` and `#` so the
 *     cwd cannot open a query/fragment (or otherwise break out of the path).
 */
export function buildVscodeUrl(cwd: string): string | null {
  if (!cwd) return null
  if (hasControlChars(cwd)) return null
  const normalized = cwd.replace(/\\/g, '/')
  const encoded = encodeURI(normalized).replace(/[?#]/g, (c) => encodeURIComponent(c))
  return `vscode://file/${encoded}`
}
