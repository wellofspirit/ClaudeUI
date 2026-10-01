/**
 * @vitest-environment node
 *
 * ADR-065 phase 4 — the pi twin of `OpencodeSession-classifier-env.test.ts`:
 * pi's judge must read the trust lists from the SHARED
 * `~/.claude/ui/automode.json`, not from `engines/pi.json#autoMode`.
 *
 * Two engines, one file: the whole point of the move is that a host trusted for
 * opencode is trusted for pi, so BOTH derivations need their own guard. The
 * mapping itself is shared now (`automode/environment.ts`, ADR-083), but each
 * session still gathers its own inputs — and pi's rules come from its own
 * `cachedRules` — so the wiring is exactly the kind of thing that misses one.
 *
 * ADR-083 adds the user's permission rules and the judge guidance lists to the
 * same environment; the second block pins that both reach pi's judge.
 *
 * The engine mock returns a stale copy of the old keys; none of it may surface.
 * `classifierEnvironment` is private and reached through a cast (see the
 * opencode twin for why a real judged approval is not the vehicle).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { EnvironmentInfo } from '../../automode/classifier'

class MockWindow extends EventEmitter {
  webContents = { send: vi.fn() }
  isDestroyed(): boolean {
    return false
  }
}

const {
  mockLoadClaudePermissions,
  mockLoadEngineConfig,
  mockLoadSharedAutoModeConfig,
  mockCaptureGitRemotes,
  mockCaptureRepoVisibility
} = vi.hoisted(() => ({
  mockLoadClaudePermissions: vi.fn(),
  mockLoadEngineConfig: vi.fn(),
  mockLoadSharedAutoModeConfig: vi.fn(),
  mockCaptureGitRemotes: vi.fn(),
  mockCaptureRepoVisibility: vi.fn()
}))

vi.mock('../PiRpcClient', () => ({ PiRpcClient: vi.fn(() => ({})) }))
vi.mock('../pi-locate', () => ({
  locatePiLaunch: () => ({ command: '/fake/pi', args: [] }),
  piBinaryAvailable: () => true
}))
vi.mock('../model-discovery', async () => {
  const actual = await vi.importActual<typeof import('../model-discovery')>('../model-discovery')
  return {
    ...actual,
    getPiModelCatalog: vi.fn(async () => []),
    discoverPiModels: vi.fn(async () => [])
  }
})
vi.mock('../../services/pi-session-list', () => ({
  loadPiSessionHistory: vi.fn(async () => ({ messages: [], statusLine: null })),
  findPiSessionFile: vi.fn(() => null)
}))
vi.mock('../../services/usage-recorder', () => ({ recordUsageEvent: vi.fn() }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../../services/mermaid-tool', () => ({
  createMermaidServer: vi.fn(() => ({ tools: [] }))
}))
vi.mock('../../services/mockup-tool', () => ({ createMockupServer: vi.fn(() => ({ tools: [] })) }))
vi.mock('../../services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), disposeFor: vi.fn(), stopDispatch: vi.fn() },
  crossEngineDispatchAvailable: vi.fn(() => false)
}))
vi.mock('../PiBridgeHost', () => ({
  PiBridgeHost: vi.fn(() => ({ start: vi.fn(), dispose: vi.fn() })),
  writeBridgeExtension: vi.fn(),
  writeSubagentExtension: vi.fn()
}))
vi.mock('../../auth/PiAuthProvider', () => ({
  piAuthProvider: {
    probe: vi.fn(async () => ({})),
    buildPiAccountRef: vi.fn(() => null),
    accountIdentity: vi.fn((vendorId: string) => ({
      accountKey: `pi:${vendorId}:native`,
      accountLabel: vendorId
    }))
  }
}))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: vi.fn()
}))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig,
  loadSharedAutoModeConfig: mockLoadSharedAutoModeConfig
}))
vi.mock('../../automode/ground-truth', async () => {
  const actual = await vi.importActual<typeof import('../../automode/ground-truth')>(
    '../../automode/ground-truth'
  )
  return {
    ...actual,
    captureGitRemotes: mockCaptureGitRemotes,
    captureRepoVisibility: mockCaptureRepoVisibility
  }
})

import { PiSession } from '../PiSession'

/** The private ground-truth builder the judge prompt is rendered from. */
function environmentOf(session: PiSession): Promise<EnvironmentInfo> {
  return (
    session as unknown as { classifierEnvironment(): Promise<EnvironmentInfo> }
  ).classifierEnvironment()
}

function makeSession(): PiSession {
  const win = new MockWindow() as unknown as never
  return new PiSession('rid-pi-env', win, '/tmp/test-cwd', {})
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadClaudePermissions.mockReturnValue({
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined
  })
  mockLoadEngineConfig.mockReturnValue({
    autoMode: {
      enabled: true,
      judgeModel: 'openai-codex/gpt-5.6-mini',
      trustedDomains: ['stale.engine.example'],
      trustedRegistries: ['https://stale.registry.example'],
      protectedPatterns: ['stale-*']
    }
  })
  mockLoadSharedAutoModeConfig.mockReturnValue({})
  mockCaptureGitRemotes.mockResolvedValue([])
  mockCaptureRepoVisibility.mockResolvedValue('unknown')
})

describe('PiSession classifier environment — shared trust lists', () => {
  it('takes all three lists from the shared config', async () => {
    mockLoadSharedAutoModeConfig.mockReturnValue({
      trustedDomains: ['files.acme.com'],
      trustedRegistries: ['https://npm.acme.internal'],
      protectedPatterns: ['acme-live-*']
    })

    const env = await environmentOf(makeSession())

    expect(env.trustedDomains).toEqual(['files.acme.com'])
    expect(env.trustedRegistries).toEqual(['https://npm.acme.internal'])
    expect(env.protectedPatterns).toEqual(['acme-live-*'])
    expect(env.cwd).toBe('/tmp/test-cwd')
  })

  it('ignores trust lists left behind in engines/pi.json', async () => {
    const env = await environmentOf(makeSession())

    expect(env).not.toHaveProperty('trustedDomains')
    expect(env).not.toHaveProperty('trustedRegistries')
    expect(env).not.toHaveProperty('protectedPatterns')
  })

  it('omits an EMPTY list rather than reporting [] to the judge', async () => {
    mockLoadSharedAutoModeConfig.mockReturnValue({
      trustedRegistries: [],
      trustedDomains: ['files.acme.com']
    })

    const env = await environmentOf(makeSession())

    expect(env).not.toHaveProperty('trustedRegistries')
    expect(env.trustedDomains).toEqual(['files.acme.com'])
  })

  it('reads the shared file ONCE per session, however many approvals ask', async () => {
    const session = makeSession()
    await environmentOf(session)
    await environmentOf(session)

    expect(mockLoadSharedAutoModeConfig).toHaveBeenCalledTimes(1)
  })

  it('falls back to no trust at all when the shared read throws', async () => {
    mockLoadSharedAutoModeConfig.mockImplementation(() => {
      throw new Error('EACCES')
    })

    const env = await environmentOf(makeSession())

    expect(env).not.toHaveProperty('trustedDomains')
    expect(env.cwd).toBe('/tmp/test-cwd')
  })
})

describe('PiSession classifier environment — permission rules + guidance (ADR-083)', () => {
  it("hands the judge the user's merged rules, deduped across scopes, in scope order", async () => {
    mockLoadClaudePermissions
      .mockReturnValueOnce({
        allow: ['Bash(gh pr create:*)'],
        deny: ['Read(.env)'],
        ask: [],
        additionalDirectories: [],
        defaultMode: undefined
      })
      .mockReturnValueOnce({
        allow: ['Bash(gh pr create:*)', 'Bash(bun run test)'],
        deny: [],
        ask: ['Bash(git push:*)'],
        additionalDirectories: [],
        defaultMode: undefined
      })

    const env = await environmentOf(makeSession())

    expect(env.permissionRules).toEqual({
      allow: ['Bash(gh pr create:*)', 'Bash(bun run test)'],
      ask: ['Bash(git push:*)'],
      deny: ['Read(.env)']
    })
  })

  it('serves the rules from the same cache the permission engine decides with', async () => {
    // pi's freshness contract: `currentRules()` is cached until a rule write
    // invalidates it, and the judge must see exactly what the engine enforces.
    const session = makeSession()
    await environmentOf(session)
    const loadsAfterFirst = mockLoadClaudePermissions.mock.calls.length
    await environmentOf(session)

    expect(mockLoadClaudePermissions.mock.calls.length).toBe(loadsAfterFirst)
  })

  it('takes the guidance lists from the shared config', async () => {
    mockLoadSharedAutoModeConfig.mockReturnValue({
      judgeAllow: ['creating and switching git branches'],
      judgeBlock: ['running database migrations']
    })

    const env = await environmentOf(makeSession())

    expect(env.judgeGuidance).toEqual({
      allow: ['creating and switching git branches'],
      block: ['running database migrations']
    })
  })

  it('omits both slots when there are no rules and no guidance', async () => {
    const env = await environmentOf(makeSession())

    expect(env).not.toHaveProperty('permissionRules')
    expect(env).not.toHaveProperty('judgeGuidance')
  })
})
