/**
 * The first-boot console chain (S3 stage 2).
 *
 * The branch that matters most is the bootstrap one: zero credentials AND no
 * password means nothing can connect, and the console is the only thing in the
 * system allowed to fix that. These tests pin that it fires exactly then, that
 * it stays idempotent, and that its failure mode is guidance rather than a
 * stack trace.
 */

import { describe, it, expect, vi } from 'vitest'
import { runFirstBootChain, type BootstrapConfigView } from '../first-boot'

function config(over: Partial<BootstrapConfigView> = {}): BootstrapConfigView {
  return { credentialCount: 0, passwordSet: false, effectiveAuthPolicy: 'password', ...over }
}

function harness(
  cfg: BootstrapConfigView,
  server: {
    mintEnrollToken?: () => never | { token: string; expiresAt: number; url: string }
    lanLink?: () => string | null
  }
): { out: string; lines: string[]; result: ReturnType<typeof runFirstBootChain> } {
  const lines: string[] = []
  const result = runFirstBootChain({
    config: cfg,
    server: {
      mintEnrollToken:
        server.mintEnrollToken ??
        (() => ({
          token: 't',
          expiresAt: Date.now() + 600_000,
          url: 'https://box.ts.net/remote#enroll=t'
        })),
      lanLink: server.lanLink ?? (() => null)
    },
    print: (l) => lines.push(l)
  })
  return { out: lines.join('\n'), lines, result }
}

describe('runFirstBootChain — bootstrap', () => {
  it('mints and prints an enrollment link when nothing can connect', () => {
    const mint = vi.fn(() => ({
      token: 'tok',
      expiresAt: Date.now() + 600_000,
      url: 'https://box.ts.net/remote#enroll=tok'
    }))
    const { out, result } = harness(config(), { mintEnrollToken: mint })

    expect(mint).toHaveBeenCalledTimes(1)
    expect(out).toContain('https://box.ts.net/remote#enroll=tok')
    expect(out).toMatch(/ONE-TIME link/i)
    expect(result.enrollUrl).toBe('https://box.ts.net/remote#enroll=tok')
    expect(result.enrolled).toBe(false)
  })

  it('reports the remaining TTL so an operator knows if it is already stale', () => {
    const { out } = harness(config(), {
      mintEnrollToken: () => ({
        token: 't',
        expiresAt: Date.now() + 9 * 60_000,
        url: 'https://x/y'
      })
    })
    expect(out).toMatch(/~9 min/)
  })

  it('turns a mint failure into guidance, not a stack trace', () => {
    // The realistic failure: no `tailscale serve`, so there is no HTTPS origin
    // and a passkey would bind to a name that will not exist tomorrow.
    const { out } = harness(config(), {
      mintEnrollToken: () => {
        throw new Error('enroll-unavailable')
      }
    })
    expect(out).toContain('enroll-unavailable')
    expect(out).toMatch(/--tls/)
    expect(out).toMatch(/binds to the origin/i)
  })

  it('does NOT mint when a break-glass password is already set', () => {
    const mint = vi.fn()
    const { out, result } = harness(config({ passwordSet: true }), {
      mintEnrollToken: mint as never
    })
    expect(mint).not.toHaveBeenCalled()
    expect(result.enrollUrl).toBeNull()
    expect(out).toMatch(/break-glass password/i)
  })

  it('does NOT mint once a credential is enrolled', () => {
    const mint = vi.fn()
    const { out, result } = harness(config({ credentialCount: 1 }), {
      mintEnrollToken: mint as never
    })
    expect(mint).not.toHaveBeenCalled()
    expect(result.enrolled).toBe(true)
    expect(out).not.toMatch(/No passkey is enrolled/)
  })

  it('is idempotent — re-running while unenrolled prints again', () => {
    // A link that scrolled past, or landed in a log nobody was tailing, is a
    // bricked box. Re-printing is safe precisely because the state that gates it
    // is the state in which the link is useless to anyone who cannot already
    // read this console.
    const cfg = config()
    const first = harness(cfg, {})
    const second = harness(cfg, {})
    expect(first.result.enrollUrl).toBeTruthy()
    expect(second.result.enrollUrl).toBeTruthy()
  })
})

describe('runFirstBootChain — LAN link', () => {
  it('prints the LAN link and explains the channel-key fragment', () => {
    const { out, result } = harness(config({ credentialCount: 1 }), {
      lanLink: () => 'http://192.168.1.5:7411/remote#k=abc'
    })
    expect(out).toContain('http://192.168.1.5:7411/remote#k=abc')
    expect(out).toMatch(/not a\n\s+password/)
    expect(result.lanUrl).toBe('http://192.168.1.5:7411/remote#k=abc')
  })

  it('omits the fragment explanation for a loopback link that has none', () => {
    const { out } = harness(config({ credentialCount: 1 }), {
      lanLink: () => 'http://127.0.0.1:7411/remote'
    })
    expect(out).toContain('http://127.0.0.1:7411/remote')
    expect(out).not.toMatch(/channel key/)
  })
})

describe('runFirstBootChain — auth off', () => {
  it('leads with an unmissable warning and skips the auth guidance', () => {
    const mint = vi.fn()
    const { out, lines, result } = harness(config({ effectiveAuthPolicy: 'off' }), {
      mintEnrollToken: mint as never,
      lanLink: () => 'http://192.168.1.5:7411/remote'
    })

    expect(out).toMatch(/REMOTE AUTHENTICATION IS DISABLED/)
    expect(out).toMatch(/operator-level access/)
    // Nothing about enrolling: none of it applies when the door is open.
    expect(mint).not.toHaveBeenCalled()
    expect(result.enrollUrl).toBeNull()
    expect(out).not.toMatch(/ONE-TIME/)
    // The warning comes before the URL, so a truncated console still shows it.
    const warnAt = lines.findIndex((l) => l.includes('DISABLED'))
    const urlAt = lines.findIndex((l) => l.includes('192.168.1.5'))
    expect(warnAt).toBeGreaterThanOrEqual(0)
    expect(warnAt).toBeLessThan(urlAt)
  })

  it('still reports the URL so the operator can reach the box', () => {
    const { result } = harness(config({ effectiveAuthPolicy: 'off' }), {
      lanLink: () => 'http://192.168.1.5:7411/remote'
    })
    expect(result.lanUrl).toBe('http://192.168.1.5:7411/remote')
  })
})
