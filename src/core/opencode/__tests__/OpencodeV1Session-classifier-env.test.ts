/**
 * @vitest-environment node
 *
 * ADR-065 phase 4 — the classifier trust lists reach opencode's judge from the
 * SHARED `~/.claude/ui/automode.json`, not from `engines/opencode.json#autoMode`.
 *
 * This is the half of the move that a UI test cannot cover: the settings pane
 * could write the shared file perfectly and the judge would still be handed
 * nothing if `classifierEnvironment()` kept reading the engine block. So the two
 * config readers are mocked apart and the environment is inspected directly —
 * the engine mock even returns a stale copy of the old keys, which must NOT
 * appear.
 *
 * ADR-083 adds the user's merged permission rules (read fresh on every
 * approval) and the shared judge guidance lists to the same environment; the
 * second block pins that both reach the judge. The mapping's own rules (dedupe,
 * omission, sanitising) are unit-tested in `automode/__tests__/environment.test.ts`.
 *
 * `classifierEnvironment` is private; it is reached through a cast rather than
 * through a real judged approval, because driving one would need a live server,
 * an SSE stream and a judge transport to observe one object.
 *
 * Mock scaffold mirrors OpencodeSession-connect-race.test.ts.
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
  mockCaptureRepoVisibility,
  MockOpencodeClient
} = vi.hoisted(() => ({
  mockLoadClaudePermissions: vi.fn(),
  mockLoadEngineConfig: vi.fn(),
  mockLoadSharedAutoModeConfig: vi.fn(),
  mockCaptureGitRemotes: vi.fn(),
  mockCaptureRepoVisibility: vi.fn(),
  MockOpencodeClient: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: vi.fn(),
    release: vi.fn(),
    releaseIfCurrent: vi.fn(),
    subscribeExit: () => () => {}
  }
}))
vi.mock('../OpencodeV1Client', () => ({ OpencodeV1Client: MockOpencodeClient }))
vi.mock('../../services/claude-settings', () => ({
  loadClaudePermissions: mockLoadClaudePermissions,
  saveClaudePermissions: vi.fn()
}))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: mockLoadEngineConfig,
  loadSharedAutoModeConfig: mockLoadSharedAutoModeConfig
}))
vi.mock('../model-discovery', () => ({
  getOpencodeModelContextWindow: vi.fn().mockReturnValue(0),
  getOpencodeModelCapabilities: vi.fn().mockReturnValue(undefined),
  discoverOpencodeModels: vi.fn().mockResolvedValue([]),
  invalidateOpencodeModelCache: vi.fn(),
  parseModelString: (model: string) => {
    const slash = model.indexOf('/')
    return slash < 0
      ? { providerID: 'opencode', modelID: model }
      : { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  }
}))
vi.mock('../command-skill-discovery', () => ({
  discoverOpencodeSkills: vi.fn().mockResolvedValue([])
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

import { OpencodeV1Session as OpencodeSession } from '../OpencodeV1Session'
import type { HostWindowHandle } from '../../host'

/** The private ground-truth builder the judge prompt is rendered from. */
function environmentOf(session: OpencodeSession): Promise<EnvironmentInfo> {
  return (
    session as unknown as { classifierEnvironment(): Promise<EnvironmentInfo> }
  ).classifierEnvironment()
}

function makeSession(): OpencodeSession {
  const win = new MockWindow() as unknown as HostWindowHandle
  return new OpencodeSession('routing_oc_env', win, '/tmp/test-cwd', { model: 'anthropic/claude' })
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
  // A STALE copy of the pre-migration keys: the engine block is not where these
  // come from any more, so none of these values may surface.
  mockLoadEngineConfig.mockReturnValue({
    autoMode: {
      enabled: true,
      judgeModel: 'openai/gpt-5',
      trustedDomains: ['stale.engine.example'],
      trustedRegistries: ['https://stale.registry.example'],
      protectedPatterns: ['stale-*']
    }
  })
  mockLoadSharedAutoModeConfig.mockReturnValue({})
  mockCaptureGitRemotes.mockResolvedValue([])
  mockCaptureRepoVisibility.mockResolvedValue('unknown')
  MockOpencodeClient.mockImplementation(function () {
    return {}
  })
})

describe('OpencodeSession classifier environment — shared trust lists', () => {
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

  it('ignores trust lists left behind in engines/opencode.json', async () => {
    // Only the shared file is empty here; the engine block is full of them.
    const env = await environmentOf(makeSession())

    expect(env).not.toHaveProperty('trustedDomains')
    expect(env).not.toHaveProperty('trustedRegistries')
    expect(env).not.toHaveProperty('protectedPatterns')
  })

  it('omits an EMPTY list rather than reporting [] to the judge', async () => {
    mockLoadSharedAutoModeConfig.mockReturnValue({
      trustedDomains: [],
      protectedPatterns: ['acme-live-*']
    })

    const env = await environmentOf(makeSession())

    // The policy renders "nothing is trusted" for an ABSENT slot, so an empty
    // array must not become a present-but-empty one.
    expect(env).not.toHaveProperty('trustedDomains')
    expect(env.protectedPatterns).toEqual(['acme-live-*'])
  })

  it('reads the shared file ONCE per session, however many approvals ask', async () => {
    const session = makeSession()
    await environmentOf(session)
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

describe('OpencodeSession classifier environment — permission rules + guidance (ADR-083)', () => {
  it("hands the judge the user's merged rules, deduped across scopes, in scope order", async () => {
    // user → project → local; the project scope repeats a user rule.
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

  it('reads the rules FRESH on every approval, so a mid-session edit reaches the judge', async () => {
    const session = makeSession()
    expect(await environmentOf(session)).not.toHaveProperty('permissionRules')

    mockLoadClaudePermissions.mockReturnValue({
      allow: [],
      deny: ['Bash(rm -rf:*)'],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    })
    expect((await environmentOf(session)).permissionRules).toEqual({ deny: ['Bash(rm -rf:*)'] })
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
