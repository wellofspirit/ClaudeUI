/**
 * Main-process reader for the two mockup iframe security settings:
 *   - `mockupConnectAllowlist` — newline-separated list of additional origins
 *      to whitelist in `connect-src` (CSP).
 *   - `mockupAllowHttp` — whether to allow plaintext `http:` and `ws:` as
 *      fallback schemes (HTTPS-only when off).
 *
 * A tiny in-memory cache is populated by `loadSettings()` on first request
 * and refreshed via `invalidateMockupSecuritySettings()` whenever the
 * settings IPC handler writes them. Avoids hitting disk on every asset
 * request (mockups often load dozens of sibling files per page).
 */

import { loadSettings } from './ui-config'

export interface MockupSecuritySettings {
  connectAllowlist: string[]
  allowHttp: boolean
}

let cache: MockupSecuritySettings | null = null

export function getMockupSecuritySettings(): MockupSecuritySettings {
  if (cache) return cache
  cache = readFromDisk()
  return cache
}

export function invalidateMockupSecuritySettings(): void {
  cache = null
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

function readFromDisk(): MockupSecuritySettings {
  try {
    const raw = loadSettings() as Record<string, unknown>
    return parseMockupSettings(raw)
  } catch {
    return { connectAllowlist: [], allowHttp: false }
  }
}
