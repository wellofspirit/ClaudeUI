import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import {
  TailscaleManager,
  TailscaleServeError,
  serveTargetForPort,
  type TailscaleExecFn,
  type TailscaleExecFailure
} from '../../../core/services/tailscale-manager'

// ---------------------------------------------------------------------------
// Canned CLI output — copied from a real macOS tailscale 1.98.5 (standalone
// "macsys" build). Keeping these verbatim is the point: the detection matrix is
// only as good as the fixtures it is driven by.
// ---------------------------------------------------------------------------

const VERSION_STDOUT = `1.98.5
  tailscale commit: 8f8fe6a2e167459ed0f62616287b61b0b0a54eb5
  long version: 1.98.5-t8f8fe6a2e-gc1619fb10
  other commit: c1619fb10d5db0f7cb1d109d5b67d053f7751508
  go version: go1.26.3 (tailscale/go e877d97384)
`

const DNS_NAME = 'cg-mac.tail3140f8.ts.net'
/** Real observed shape: a ~16-digit id, still exact in JS (< 2^53). */
const USER_ID = 8563107102318965
const SELF_IP = '100.93.9.58'

/** `whois --json` body for our own address. */
function whoisJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Node: { Name: `${DNS_NAME}.`, ID: 1, User: USER_ID, Tags: null },
    UserProfile: { ID: USER_ID, LoginName: 'Owner@Example.com', DisplayName: 'Liu Daniel' },
    CapMap: {},
    ...over
  })
}

/** `status --json` skeleton; `Self.DNSName` keeps its real trailing dot. */
function statusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    BackendState: 'Running',
    AuthURL: '',
    CertDomains: ['cg-mac.tail3140f8.ts.net'],
    Version: '1.98.5-t8f8fe6a2e-gc1619fb10',
    MagicDNSSuffix: 'tail3140f8.ts.net',
    CurrentTailnet: {
      Name: 'someone@example.com',
      MagicDNSSuffix: 'tail3140f8.ts.net',
      MagicDNSEnabled: true
    },
    Self: {
      DNSName: `${DNS_NAME}.`,
      HostName: 'CMJQN26J4D-45',
      Online: true,
      Tags: null,
      Capabilities: ['https', 'https://tailscale.com/cap/is-owner'],
      CapMap: { 'https://tailscale.com/cap/is-owner': null },
      UserID: USER_ID,
      TailscaleIPs: [SELF_IP, 'fd7a:115c:a1e0::8839:93a']
    },
    // Mixed case on purpose: the manager lowercases, because the identity
    // comparison against `Tailscale-User-Login` is case-insensitive.
    User: {
      [String(USER_ID)]: {
        ID: USER_ID,
        LoginName: 'Owner@Example.com',
        DisplayName: 'Liu Daniel'
      }
    },
    ...over
  })
}

/** A `serve status --json` body with one web handler on `httpsPort`. */
function serveJson(entries: Array<{ httpsPort: number; proxy: string }>): string {
  const tcp: Record<string, unknown> = {}
  const web: Record<string, unknown> = {}
  for (const { httpsPort, proxy } of entries) {
    tcp[String(httpsPort)] = { HTTPS: true }
    web[`${DNS_NAME}:${httpsPort}`] = { Handlers: { '/': { Proxy: proxy } } }
  }
  return JSON.stringify({ TCP: tcp, Web: web })
}

function execFailure(
  over: Partial<TailscaleExecFailure> & { message?: string }
): TailscaleExecFailure {
  const err = new Error(over.message ?? 'Command failed') as TailscaleExecFailure
  Object.assign(err, over)
  return err
}

const ENOENT = (): TailscaleExecFailure =>
  execFailure({ code: 'ENOENT', message: 'spawn tailscale ENOENT', stderr: '' })

// ---------------------------------------------------------------------------
// Recording exec stub. Routes on argv so a single table drives a whole test.
// ---------------------------------------------------------------------------

/** First entry of BINARY_CANDIDATES for the platform the tests run on. */
const FIRST_CANDIDATE = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'

interface StubOpts {
  /** Candidate paths that "exist". Anything else rejects with ENOENT. */
  installedAt?: string[]
  version?: string | (() => never)
  status?: string | (() => never)
  whois?: string | (() => never)
  serveStatus?: string | string[] | (() => never)
  serveMutate?: string | (() => never)
}

interface Stub {
  exec: TailscaleExecFn
  calls: Array<{ file: string; args: string[]; timeoutMs: number }>
}

function makeStub(opts: StubOpts = {}): Stub {
  const calls: Stub['calls'] = []
  const installed = opts.installedAt ?? [FIRST_CANDIDATE]
  let serveStatusIdx = 0

  const resolveOr = (v: string | (() => never)): string => {
    if (typeof v === 'function') return v()
    return v
  }

  const exec: TailscaleExecFn = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    if (!installed.includes(file)) throw ENOENT()

    if (args[0] === 'version') {
      return { stdout: resolveOr(opts.version ?? VERSION_STDOUT), stderr: '' }
    }
    if (args[0] === 'status') {
      return { stdout: resolveOr(opts.status ?? statusJson()), stderr: '' }
    }
    if (args[0] === 'whois') {
      return { stdout: resolveOr(opts.whois ?? whoisJson()), stderr: '' }
    }
    if (args[0] === 'serve' && args[1] === 'status') {
      const s = opts.serveStatus ?? '{}'
      if (typeof s === 'function') return s()
      const body = Array.isArray(s) ? (s[serveStatusIdx++] ?? s[s.length - 1]) : s
      return { stdout: body, stderr: '' }
    }
    if (args[0] === 'serve') {
      return { stdout: resolveOr(opts.serveMutate ?? ''), stderr: '' }
    }
    throw execFailure({ code: 1, stderr: `unexpected argv: ${args.join(' ')}` })
  }

  return { exec, calls }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// detect() — one test per state
// ---------------------------------------------------------------------------

describe('TailscaleManager.detect', () => {
  it('returns ok with the trailing dot stripped from DNSName', async () => {
    const { exec } = makeStub()
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('ok')
    if (d.state !== 'ok') return
    expect(d.dnsName).toBe(DNS_NAME) // NOT 'cg-mac.tail3140f8.ts.net.'
    expect(d.dnsName.endsWith('.')).toBe(false)
    expect(d.version).toBe('1.98.5') // line 1, first token — not the long version
    expect(d.certDomains).toEqual(['cg-mac.tail3140f8.ts.net'])
    expect(d.binaryPath).toBe(FIRST_CANDIDATE)
  })

  it('reports not-installed when no candidate binary execs', async () => {
    const { exec } = makeStub({ installedAt: [] })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('not-installed')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/tailscale\.com\/download/)
  })

  it('reports daemon-down on the localapi dial failure', async () => {
    const { exec } = makeStub({
      status: () => {
        throw execFailure({
          code: 1,
          stderr:
            'Failed to connect to local Tailscale daemon for /localapi/v0/status; not running? Error: dial unix /var/run/tailscaled.socket: connect: no such file or directory\n'
        })
      }
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('daemon-down')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/daemon is not running/i)
    expect(d.binaryPath).toBe(FIRST_CANDIDATE)
  })

  it('reports daemon-down for BackendState Stopped (daemon alive, Tailscale off)', async () => {
    const { exec } = makeStub({ status: statusJson({ BackendState: 'Stopped' }) })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('daemon-down')
    if (d.state === 'ok') return
    expect(d.detail).toBe('BackendState=Stopped')
  })

  it('reports logged-out for BackendState NeedsLogin and surfaces the AuthURL', async () => {
    // Regression guard: `status --json` exits 0 even when logged out, so the
    // classification MUST come from BackendState, never the exit code.
    const { exec } = makeStub({
      status: statusJson({
        BackendState: 'NeedsLogin',
        AuthURL: 'https://login.tailscale.com/a/deadbeef',
        CertDomains: null,
        CurrentTailnet: null
      })
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('logged-out')
    if (d.state === 'ok') return
    expect(d.message).toContain('https://login.tailscale.com/a/deadbeef')
  })

  it('reports logged-out for NeedsMachineAuth with an approval message', async () => {
    const { exec } = makeStub({ status: statusJson({ BackendState: 'NeedsMachineAuth' }) })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('logged-out')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/admin/i)
  })

  it('reports https-disabled when Running but CertDomains is null and the https cap is absent', async () => {
    // This is the real observed state of the dev machine: certs are simply not
    // enabled for the tailnet.
    const { exec } = makeStub({
      status: statusJson({
        CertDomains: null,
        Self: {
          DNSName: `${DNS_NAME}.`,
          Online: true,
          Tags: null,
          Capabilities: ['default-auto-update', 'https://tailscale.com/cap/is-owner'],
          CapMap: { 'https://tailscale.com/cap/is-owner': null }
        }
      })
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('https-disabled')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/HTTPS Certificates/)
  })

  it('accepts an empty CertDomains when the node still carries the https capability', async () => {
    const { exec } = makeStub({
      status: statusJson({
        CertDomains: [],
        Self: {
          DNSName: `${DNS_NAME}.`,
          Online: true,
          Tags: null,
          Capabilities: null,
          CapMap: { https: null }
        }
      })
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('ok')
    if (d.state !== 'ok') return
    expect(d.certDomains).toEqual([])
  })

  it('reports no-operator on the Access denied / --operator hint', async () => {
    const { exec } = makeStub({
      status: () => {
        throw execFailure({
          code: 1,
          stderr:
            "Access denied: status access denied\n\nUse 'sudo tailscale status'.\nTo not require root, use 'sudo tailscale set --operator=$USER' once.\n"
        })
      }
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('no-operator')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/--operator=\$USER/)
  })

  it('reports error on an exec timeout (killed) rather than hanging', async () => {
    const { exec } = makeStub({
      status: () => {
        throw execFailure({ killed: true, signal: 'SIGTERM', code: null as unknown as number })
      }
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('error')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/did not respond within/)
  })

  it('reports error on unparseable status JSON', async () => {
    const { exec } = makeStub({ status: 'not json at all' })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('error')
    if (d.state === 'ok') return
    expect(d.detail).toContain('not json')
  })

  it('reports error on a transient BackendState like Starting', async () => {
    const { exec } = makeStub({ status: statusJson({ BackendState: 'Starting' }) })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('error')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/not ready yet \(state: Starting\)/)
  })

  it('reports error when MagicDNS gives no DNSName', async () => {
    const { exec } = makeStub({
      status: statusJson({
        Self: { DNSName: '', Online: true, Capabilities: ['https'], CapMap: {} }
      })
    })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state).toBe('error')
    if (d.state === 'ok') return
    expect(d.message).toMatch(/MagicDNS/)
  })
})

// ---------------------------------------------------------------------------
// detect().ownerLogin — the ENTIRE tailnet-identity allowlist (Phase 3).
//
// Every uncertain case must be null: null disables identity auth outright, so a
// wrong guess here would either lock the owner out (harmless) or accept a login
// that is not theirs (not harmless).
// ---------------------------------------------------------------------------

describe('TailscaleManager.detect — ownerLogin', () => {
  /**
   * Owner login for a status payload. The whois fallback is stubbed to resolve
   * NOTHING here on purpose, so these cases isolate the `User`-map lookup — the
   * fallback has its own tests above.
   */
  async function ownerLoginFor(statusBody: string): Promise<string | null | undefined> {
    const { exec } = makeStub({ status: statusBody, whois: whoisJson({ UserProfile: {} }) })
    const d = await new TailscaleManager(exec).detect()
    return d.state === 'ok' ? d.ownerLogin : undefined
  }

  it('resolves User[Self.UserID].LoginName, lowercased', async () => {
    const { exec, calls } = makeStub()
    const d = await new TailscaleManager(exec).detect()
    expect(d.state === 'ok' && d.ownerLogin).toBe('owner@example.com')
    // The map answered, so no second exec was needed.
    expect(calls.some((c) => c.args[0] === 'whois')).toBe(false)
  })

  // OBSERVED on a live 1.98.5: `status --json --peers=false` emits `User: null`
  // (the user map only ships with the peer list), so on a real machine the map
  // lookup NEVER resolves and identity auth would be permanently disabled
  // without this fallback. GUARD.
  it('falls back to `whois` when the status payload carries no User map (GUARD)', async () => {
    const { exec, calls } = makeStub({ status: statusJson({ User: null }) })
    const d = await new TailscaleManager(exec).detect()

    expect(d.state === 'ok' && d.ownerLogin).toBe('owner@example.com')
    const whois = calls.find((c) => c.args[0] === 'whois')
    // Our own tailnet IPv4, and the JSON form — not the human one.
    expect(whois?.args).toEqual(['whois', '--json', SELF_IP])
  })

  it('is null when whois reports a tagged node', async () => {
    const { exec } = makeStub({
      status: statusJson({ User: null }),
      whois: whoisJson({ Node: { Tags: ['tag:ci'] }, UserProfile: { LoginName: 'ci@example.com' } })
    })
    const d = await new TailscaleManager(exec).detect()
    expect(d.state === 'ok' && d.ownerLogin).toBeNull()
  })

  it('is null (and detection still ok) when whois fails outright', async () => {
    const { exec } = makeStub({
      status: statusJson({ User: null }),
      whois: () => {
        throw execFailure({ code: 1, stderr: 'whois: no match\n' })
      }
    })
    const d = await new TailscaleManager(exec).detect()
    expect(d.state).toBe('ok')
    expect(d.state === 'ok' && d.ownerLogin).toBeNull()
  })

  it('is null when whois returns unparseable output', async () => {
    const { exec } = makeStub({ status: statusJson({ User: null }), whois: 'not json' })
    const d = await new TailscaleManager(exec).detect()
    expect(d.state === 'ok' && d.ownerLogin).toBeNull()
  })

  it('does not call whois for a tagged node (no identity headers exist for one)', async () => {
    const { exec, calls } = makeStub({
      status: statusJson({
        User: null,
        Self: {
          DNSName: `${DNS_NAME}.`,
          Online: true,
          Tags: ['tag:ci'],
          Capabilities: ['https'],
          CapMap: {},
          UserID: USER_ID,
          TailscaleIPs: [SELF_IP]
        }
      })
    })
    const d = await new TailscaleManager(exec).detect()
    expect(d.state === 'ok' && d.ownerLogin).toBeNull()
    expect(calls.some((c) => c.args[0] === 'whois')).toBe(false)
  })

  it('does not call whois when the node has no tailnet address', async () => {
    const { exec, calls } = makeStub({
      status: statusJson({
        User: null,
        Self: {
          DNSName: `${DNS_NAME}.`,
          Online: true,
          Tags: null,
          Capabilities: ['https'],
          CapMap: {},
          UserID: USER_ID,
          TailscaleIPs: null
        }
      })
    })
    const d = await new TailscaleManager(exec).detect()
    expect(d.state === 'ok' && d.ownerLogin).toBeNull()
    expect(calls.some((c) => c.args[0] === 'whois')).toBe(false)
  })

  it('is null for a TAGGED node (serve sends no identity headers for those)', async () => {
    const status = statusJson({
      Self: {
        DNSName: `${DNS_NAME}.`,
        Online: true,
        Tags: ['tag:ci'],
        Capabilities: ['https'],
        CapMap: {},
        UserID: USER_ID
      }
    })
    expect(await ownerLoginFor(status)).toBeNull()
  })

  it('does not resolve from the map when it is missing entirely', async () => {
    expect(await ownerLoginFor(statusJson({ User: undefined }))).toBeNull()
  })

  it('does not resolve from the map when it has no entry for Self.UserID', async () => {
    const status = statusJson({
      User: { '111': { ID: 111, LoginName: 'someone.else@example.com' } }
    })
    expect(await ownerLoginFor(status)).toBeNull()
  })

  it('falls back to scanning by ID when the map key is formatted differently', async () => {
    const status = statusJson({
      User: { 'urn:whatever': { ID: USER_ID, LoginName: 'Keyed@Oddly.com' } }
    })
    expect(await ownerLoginFor(status)).toBe('keyed@oddly.com')
  })

  it('does not resolve from the map when Self.UserID is absent', async () => {
    const status = statusJson({
      Self: {
        DNSName: `${DNS_NAME}.`,
        Online: true,
        Tags: null,
        Capabilities: ['https'],
        CapMap: {}
      }
    })
    expect(await ownerLoginFor(status)).toBeNull()
  })

  it('does not resolve from the map when the LoginName is blank', async () => {
    const status = statusJson({ User: { [String(USER_ID)]: { ID: USER_ID, LoginName: '   ' } } })
    expect(await ownerLoginFor(status)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

describe('TailscaleManager binary discovery', () => {
  it('falls through the candidate list in order and caches the winner', async () => {
    if (process.platform !== 'darwin') return // candidate list is platform-specific
    const { exec, calls } = makeStub({ installedAt: ['/usr/local/bin/tailscale'] })
    const mgr = new TailscaleManager(exec)

    const d = await mgr.detect()
    expect(d.state).toBe('ok')
    if (d.state !== 'ok') return
    expect(d.binaryPath).toBe('/usr/local/bin/tailscale')

    const probes = calls.filter((c) => c.args[0] === 'version').map((c) => c.file)
    expect(probes).toEqual(['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'])

    // Second call reuses the cache — no further `version` probes.
    await mgr.detect()
    expect(calls.filter((c) => c.args[0] === 'version')).toHaveLength(3)
  })

  it('prefers an access-denied failure over ENOENT when nothing works', async () => {
    const exec: TailscaleExecFn = async (file, args) => {
      if (args[0] !== 'version') throw ENOENT()
      if (file === 'tailscale') throw ENOENT()
      throw execFailure({
        code: 1,
        stderr: "Access denied: permission denied\nuse 'sudo tailscale set --operator=$USER' once."
      })
    }
    const d = await new TailscaleManager(exec).detect()
    expect(d.state).toBe('no-operator')
  })

  it('retries status without --peers=false when the CLI rejects the flag', async () => {
    const calls: string[][] = []
    const exec: TailscaleExecFn = async (_file, args) => {
      calls.push(args)
      if (args[0] === 'version') return { stdout: VERSION_STDOUT, stderr: '' }
      if (args[0] === 'status') {
        if (args.includes('--peers=false')) {
          throw execFailure({ code: 1, stderr: 'flag provided but not defined: -peers' })
        }
        return { stdout: statusJson(), stderr: '' }
      }
      throw ENOENT()
    }
    const mgr = new TailscaleManager(exec)

    expect((await mgr.detect()).state).toBe('ok')
    expect(calls.filter((a) => a[0] === 'status')).toEqual([
      ['status', '--json', '--peers=false'],
      ['status', '--json']
    ])

    // The fallback sticks — no second wasted probe.
    await mgr.detect()
    expect(calls.filter((a) => a[0] === 'status')).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// getServeStatus()
// ---------------------------------------------------------------------------

describe('TailscaleManager.getServeStatus', () => {
  it('treats the empty `{}` no-config body as nothing occupied', async () => {
    const { exec } = makeStub({ serveStatus: '{}' })
    expect(await new TailscaleManager(exec).getServeStatus(5173)).toEqual({ occupied: [] })
  })

  it('marks a handler pointing at our local port as ours, and others as foreign', async () => {
    const { exec } = makeStub({
      serveStatus: serveJson([
        { httpsPort: 443, proxy: 'http://127.0.0.1:3000' },
        { httpsPort: 8443, proxy: 'http://127.0.0.1:5173' }
      ])
    })
    const { occupied } = await new TailscaleManager(exec).getServeStatus(5173)

    expect(occupied).toEqual([
      { httpsPort: 443, target: 'http://127.0.0.1:3000', ours: false },
      { httpsPort: 8443, target: 'http://127.0.0.1:5173', ours: true }
    ])
  })

  it('detects a port claimed by a FOREGROUND serve session (hidden from the top level)', async () => {
    // Regression guard for ipn.ServeConfig.Foreground: a `tailscale serve 3000`
    // without --bg holds the port but writes only under Foreground[sessionID].
    const { exec } = makeStub({
      serveStatus: JSON.stringify({
        Foreground: {
          'sess-abc': {
            TCP: { '443': { HTTPS: true } },
            Web: { [`${DNS_NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } }
          }
        }
      })
    })
    const { occupied } = await new TailscaleManager(exec).getServeStatus(5173)

    expect(occupied).toEqual([{ httpsPort: 443, target: 'http://127.0.0.1:3000', ours: false }])
  })

  it('reports a raw TCP forwarder as occupancy even with no Web entry', async () => {
    const { exec } = makeStub({
      serveStatus: JSON.stringify({ TCP: { '8443': { TCPForward: '127.0.0.1:22' } } })
    })
    const { occupied } = await new TailscaleManager(exec).getServeStatus(5173)

    expect(occupied).toEqual([{ httpsPort: 8443, target: 'tcp-forward:127.0.0.1:22', ours: false }])
  })

  it('falls back to this-process ownership when no localPort is supplied', async () => {
    // Same config throughout: :443 already proxies to our local port. Without a
    // localPort argument the only ownership signal is "did we enable it".
    const { exec } = makeStub({
      serveStatus: serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
    })
    const mgr = new TailscaleManager(exec)

    // Nothing enabled by *this process* yet → not ours.
    expect((await mgr.getServeStatus()).occupied[0].ours).toBe(false)

    await mgr.enableServe(5173, 443)
    expect((await mgr.getServeStatus()).occupied[0].ours).toBe(true)
  })

  // ADR-042: the candidate list is gone, so the default scan set is "every port
  // the live config mentions" — including ports outside the old 443/8443/10000
  // triple, which the old implementation was structurally blind to.
  it('reports ports outside the retired candidate triple', async () => {
    const { exec } = makeStub({
      serveStatus: serveJson([
        { httpsPort: 9443, proxy: 'http://127.0.0.1:3000' },
        { httpsPort: 443, proxy: 'http://127.0.0.1:5173' }
      ])
    })
    const { occupied } = await new TailscaleManager(exec).getServeStatus(5173)

    expect(occupied).toEqual([
      { httpsPort: 443, target: 'http://127.0.0.1:5173', ours: true },
      { httpsPort: 9443, target: 'http://127.0.0.1:3000', ours: false }
    ])
  })

  it('scans only the requested ports when a list is supplied', async () => {
    const { exec } = makeStub({
      serveStatus: serveJson([
        { httpsPort: 443, proxy: 'http://127.0.0.1:3000' },
        { httpsPort: 8443, proxy: 'http://127.0.0.1:5173' }
      ])
    })
    const { occupied } = await new TailscaleManager(exec).getServeStatus(5173, [8443])

    expect(occupied).toEqual([{ httpsPort: 8443, target: 'http://127.0.0.1:5173', ours: true }])
  })
})

// ---------------------------------------------------------------------------
// enableServe()
// ---------------------------------------------------------------------------

describe('TailscaleManager.enableServe', () => {
  it('binds the PINNED port when it is free and emits the pinned 1.98.5 argv', async () => {
    const { exec, calls } = makeStub({
      serveStatus: ['{}', serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])]
    })
    const res = await new TailscaleManager(exec).enableServe(5173, 443)

    expect(res).toEqual({ httpsPort: 443, url: `https://${DNS_NAME}` })
    const mutate = calls.find((c) => c.args[0] === 'serve' && c.args[1] === '--bg')
    expect(mutate?.args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:5173'])
  })

  // ADR-042: `tailscale serve` accepts any uint16; 443/8443/10000 was only ever
  // the Funnel-compatible triple, never a platform limit.
  it('accepts an arbitrary uint16 pinned port and puts it in the URL', async () => {
    const { exec, calls } = makeStub({
      serveStatus: ['{}', serveJson([{ httpsPort: 9443, proxy: 'http://127.0.0.1:5173' }])]
    })
    const res = await new TailscaleManager(exec).enableServe(5173, 9443)

    expect(res).toEqual({ httpsPort: 9443, url: `https://${DNS_NAME}:9443` })
    expect(calls.find((c) => c.args[1] === '--bg')?.args[2]).toBe('--https=9443')
  })

  // GUARD (the ADR-042 regression): the OLD implementation silently fell back to
  // 8443 here, breaking the user's `https://<node>.ts.net` bookmark. There is no
  // fallback any more — a foreign occupant is a loud failure that mutates
  // nothing.
  it('throws port-occupied for a FOREIGN occupant of the pinned port and never falls back (GUARD)', async () => {
    const { exec, calls } = makeStub({
      serveStatus: serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:3000' }])
    })
    const err = await new TailscaleManager(exec).enableServe(5173, 443).catch((e) => e)

    expect(err).toBeInstanceOf(TailscaleServeError)
    expect((err as TailscaleServeError).reason).toBe('port-occupied')
    // The occupant is named, so the banner/log says what to free.
    expect((err as Error).message).toContain('443')
    expect((err as TailscaleServeError).detail).toContain('http://127.0.0.1:3000')
    expect(calls.some((c) => c.args[0] === 'serve' && c.args[1] === '--bg')).toBe(false)
    // …and specifically NOT a serve call on any other port.
    expect(calls.some((c) => c.args.some((a) => a.startsWith('--https=')))).toBe(false)
  })

  it('force: true overwrites a foreign occupant of the pinned port', async () => {
    const { exec, calls } = makeStub({
      serveStatus: [
        // Only ONE serve-status read happens with force (the post-exec verify) —
        // the occupancy check is skipped entirely.
        serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
      ]
    })
    const res = await new TailscaleManager(exec).enableServe(5173, 443, { force: true })

    expect(res).toEqual({ httpsPort: 443, url: `https://${DNS_NAME}` })
    expect(calls.find((c) => c.args[1] === '--bg')?.args).toEqual([
      'serve',
      '--bg',
      '--https=443',
      'http://127.0.0.1:5173'
    ])
  })

  // The production bug: a leaked entry from a previous run points at that run's
  // (now dead) random loopback port, so target-equality says "foreign". The
  // persisted record's target proves it was ours.
  it('reclaimTargets classifies a STALE OWN entry as ours (no force needed)', async () => {
    const stale = { httpsPort: 443, proxy: 'http://127.0.0.1:64032' }
    const { exec, calls } = makeStub({
      serveStatus: [
        serveJson([stale]),
        serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
      ]
    })
    const res = await new TailscaleManager(exec).enableServe(5173, 443, {
      reclaimTargets: [serveTargetForPort(64032)]
    })

    expect(res.httpsPort).toBe(443)
    expect(calls.filter((c) => c.args[1] === '--bg')).toHaveLength(1)
  })

  it('a reclaim target that does NOT match the occupant still fails (GUARD)', async () => {
    const { exec } = makeStub({
      serveStatus: serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:3000' }])
    })
    await expect(
      new TailscaleManager(exec).enableServe(5173, 443, {
        reclaimTargets: [serveTargetForPort(64032)]
      })
    ).rejects.toMatchObject({ name: 'TailscaleServeError', reason: 'port-occupied' })
  })

  it('reuses a port whose target is already ours', async () => {
    const already = serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
    const { exec, calls } = makeStub({ serveStatus: [already, already] })
    const res = await new TailscaleManager(exec).enableServe(5173, 443)

    expect(res.httpsPort).toBe(443)
    // Still re-issues the (idempotent) CLI call rather than assuming state.
    expect(calls.filter((c) => c.args[1] === '--bg')).toHaveLength(1)
  })

  it('treats a port THIS process enabled as ours even after the local port moves', async () => {
    const first = serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
    const second = serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:6000' }])
    const { exec } = makeStub({ serveStatus: [first, first, first, second] })
    const mgr = new TailscaleManager(exec)

    await mgr.enableServe(5173, 443)
    // Same process, new listener port: the occupant's target is the old port, so
    // only `ownedHttpsPorts` can classify it — and it must.
    await expect(mgr.enableServe(6000, 443)).resolves.toMatchObject({ httpsPort: 443 })
  })

  it('refuses to run when detect() is not ok (https-disabled would hang or no-op the CLI)', async () => {
    // Guard for the enableFeatureInteractive trap: on a certs-disabled tailnet
    // `serve --https=… <target>` either os.Exit(0)s doing nothing, or blocks on
    // WatchIPNBus. We must never reach the exec.
    const { exec, calls } = makeStub({
      status: statusJson({
        CertDomains: null,
        Self: {
          DNSName: `${DNS_NAME}.`,
          Online: true,
          Capabilities: [],
          CapMap: {}
        }
      })
    })
    await expect(new TailscaleManager(exec).enableServe(5173, 443)).rejects.toMatchObject({
      name: 'TailscaleServeError',
      reason: 'not-ready'
    })
    expect(calls.some((c) => c.args[0] === 'serve')).toBe(false)
  })

  it('throws verify-failed when the CLI exits 0 but no handler landed', async () => {
    // Exactly the enableFeatureInteractive `os.Exit(0)` shape: success exit code,
    // a setup URL on stdout, empty serve config afterwards.
    const { exec } = makeStub({
      serveStatus: ['{}', '{}'],
      serveMutate:
        '\nHTTPS must be enabled for your tailnet before you can use Tailscale Serve.\n\n         https://login.tailscale.com/admin/dns\n\n'
    })
    await expect(new TailscaleManager(exec).enableServe(5173, 443)).rejects.toMatchObject({
      name: 'TailscaleServeError',
      reason: 'verify-failed'
    })
  })

  it('throws exec-failed with a timeout message when the mutation is killed', async () => {
    const { exec } = makeStub({
      serveStatus: '{}',
      serveMutate: () => {
        throw execFailure({ killed: true, signal: 'SIGTERM' })
      }
    })
    const err = await new TailscaleManager(exec).enableServe(5173, 443).catch((e) => e)
    expect(err).toBeInstanceOf(TailscaleServeError)
    expect((err as TailscaleServeError).reason).toBe('exec-failed')
    expect((err as Error).message).toMatch(/did not finish configuring serve within/)
  })
})

// ---------------------------------------------------------------------------
// disableServe()
// ---------------------------------------------------------------------------

describe('TailscaleManager.disableServe', () => {
  it('issues a targeted `--https=<port> off` and never `serve reset`', async () => {
    const { exec, calls } = makeStub()
    await new TailscaleManager(exec).disableServe(8443)

    const serveCalls = calls.filter((c) => c.args[0] === 'serve')
    expect(serveCalls).toHaveLength(1)
    expect(serveCalls[0].args).toEqual(['serve', '--https=8443', 'off'])
    expect(calls.some((c) => c.args.includes('reset'))).toBe(false)
    // `off` must be last; `--bg` is meaningless for a turn-off.
    expect(serveCalls[0].args.at(-1)).toBe('off')
    expect(serveCalls[0].args).not.toContain('--bg')
  })

  it('is idempotent — "handler does not exist" counts as already off', async () => {
    const { exec } = makeStub({
      serveMutate: () => {
        throw execFailure({ code: 1, stderr: 'error: handler does not exist\n\n' })
      }
    })
    await expect(new TailscaleManager(exec).disableServe(443)).resolves.toBeUndefined()
  })

  it('propagates a real failure as exec-failed', async () => {
    const { exec } = makeStub({
      serveMutate: () => {
        throw execFailure({
          code: 1,
          stderr: 'Another client is changing the serve config; please try again.\n'
        })
      }
    })
    const err = await new TailscaleManager(exec).disableServe(443).catch((e) => e)
    expect(err).toBeInstanceOf(TailscaleServeError)
    expect((err as TailscaleServeError).reason).toBe('exec-failed')
    expect((err as TailscaleServeError).detail).toMatch(/Another client is changing/)
  })

  it('clears our ownership so a later status no longer claims the port', async () => {
    const enabled = serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])
    const { exec } = makeStub({ serveStatus: [enabled, enabled, enabled] })
    const mgr = new TailscaleManager(exec)

    await mgr.enableServe(5173, 443)
    expect((await mgr.getServeStatus()).occupied[0].ours).toBe(true)

    await mgr.disableServe(443)
    expect((await mgr.getServeStatus()).occupied[0].ours).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Timeouts are actually plumbed through
// ---------------------------------------------------------------------------

describe('TailscaleManager exec timeouts', () => {
  it('passes a finite timeout to every invocation, larger for mutations', async () => {
    const { exec, calls } = makeStub({
      serveStatus: ['{}', serveJson([{ httpsPort: 443, proxy: 'http://127.0.0.1:5173' }])]
    })
    await new TailscaleManager(exec).enableServe(5173, 443)

    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.timeoutMs).toBeGreaterThan(0)

    const query = calls.find((c) => c.args[0] === 'status')!.timeoutMs
    const mutate = calls.find((c) => c.args[1] === '--bg')!.timeoutMs
    expect(mutate).toBeGreaterThan(query)
  })
})
