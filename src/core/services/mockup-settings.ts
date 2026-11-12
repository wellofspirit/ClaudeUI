/**
 * Main-process reader for the two mockup iframe security settings:
 *   - `mockupConnectAllowlist` — newline-separated list of additional origins
 *      to whitelist in `connect-src` (CSP).
 *   - `mockupAllowHttp` — whether to allow plaintext `http:` and `ws:` as
 *      fallback schemes (HTTPS-only when off).
 *
 * Read through `appSetting` on every call: canonical state is current after a
 * client's save and after a settings.json watcher change alike, so there is no
 * cache to invalidate. The parse is a few string splits, cheap next to the
 * asset request it guards.
 */

import { appSetting } from './app-settings'

export interface MockupSecuritySettings {
  connectAllowlist: string[]
  allowHttp: boolean
}

export function getMockupSecuritySettings(): MockupSecuritySettings {
  return parseMockupSettings({
    mockupConnectAllowlist: appSetting('mockupConnectAllowlist'),
    mockupAllowHttp: appSetting('mockupAllowHttp')
  })
}

/**
 * Parse raw settings into the typed security shape. Exported for tests.
 * The textarea value is split on newlines; each non-empty trimmed line is
 * validated as a CSP-safe origin token (no spaces, no quotes, no semicolons).
 */
export function parseMockupSettings(raw: Record<string, unknown>): MockupSecuritySettings {
  const allowlistRaw =
    typeof raw.mockupConnectAllowlist === 'string' ? raw.mockupConnectAllowlist : ''
  const allowHttp = raw.mockupAllowHttp === true

  const connectAllowlist: string[] = []
  for (const line of allowlistRaw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Reject characters that would break out of the CSP directive.
    if (/[\s'";]/.test(trimmed)) continue
    // Block keywords like 'self' / 'unsafe-inline' sneaking in — those
    // must stay hard-coded in the CSP builder.
    if (trimmed.startsWith("'")) continue
    // Block the lone `*` which would open everything. Subdomain wildcards
    // like `*.vendor.io` are still allowed.
    if (trimmed === '*') continue
    connectAllowlist.push(trimmed)
  }

  return { connectAllowlist, allowHttp }
}
