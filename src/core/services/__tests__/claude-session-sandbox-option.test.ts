/**
 * @vitest-environment node
 *
 * The `sandbox` option a Claude session spawns with, for each shape of the Claude
 * engine's sandbox settings (`engines/claude.json#sandbox`), and the `--settings`
 * JSON it becomes. A dispatched Claude agent is spawned with the same option
 * (ADR-116), so this spec pins the session's side of that mapping: what is sent for
 * a disabled sandbox, which keys are left out, and what the network block looks
 * like with and without domain restrictions.
 *
 * Mock scaffold mirrors `claude-session-behavior-settings.test.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'
import { buildArgs, claudeSandboxOption } from '../../sdk/args'
import type { QueryOptions } from '../../sdk'
import type { SandboxSettings } from '../../../shared/types'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: mockQuery,
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})
vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: {
    setServerStartedHook: () => {},
    isBinaryAvailable: (): boolean => false
  }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => false
}))
vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('../ui-config', () => ({
  saveSlashCommands: vi.fn(),
  loadEngineConfig: vi.fn(() => ({}))
}))
vi.mock('../claude-mcp', () => ({
  loadMcpServers: vi.fn(() => ({})),
  readDisabledMcpServers: vi.fn(() => [])
}))
vi.mock('../session-history', () => ({
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 }))
}))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { updateFromRateLimitEvent: vi.fn(), fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))
vi.mock('../../../main/services/account-manager', () => ({
  accountManager: { getState: vi.fn(() => ({ enabled: false, activeId: null })) }
}))
vi.mock('../../../main/auth/ClaudeAuthProvider', () => ({
  claudeAuthProvider: { buildAccountRef: vi.fn(() => null), updateAuthSource: vi.fn() }
}))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import type { BrowserWindow } from 'electron'

const live: ClaudeSession[] = []

afterEach(() => {
  for (const s of live.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  vi.clearAllMocks()
})

/** Everything off and empty: the shape Settings writes for an untouched sandbox page. */
function sandboxSettings(over: {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
  excludedCommands?: string[]
  network?: Partial<SandboxSettings['network']>
  filesystem?: Partial<SandboxSettings['filesystem']>
}): SandboxSettings {
  return {
    enabled: over.enabled ?? true,
    autoAllowBashIfSandboxed: over.autoAllowBashIfSandboxed ?? false,
    allowUnsandboxedCommands: over.allowUnsandboxedCommands ?? false,
    excludedCommands: over.excludedCommands ?? [],
    network: {
      restrictNetwork: false,
      allowLocalBinding: false,
      allowedDomains: [],
      allowManagedDomainsOnly: false,
      allowAllUnixSockets: false,
      allowUnixSockets: [],
      ...over.network
    },
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], ...over.filesystem }
  }
}

/** Construct with `sandboxConfig`, run one prompt, and return the options cli.js was spawned with. */
async function spawnOptions(sandboxConfig?: SandboxSettings): Promise<QueryOptions> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      yield* []
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }))
  const win = {
    isDestroyed: () => false,
    webContents: { send: (): void => {} }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  const session = new ClaudeSession('sandbox', win, '/tmp/proj', { sandboxConfig })
  live.push(session)
  await session.run('go')
  expect(mockQuery).toHaveBeenCalled()
  const [{ options }] = mockQuery.mock.calls.at(-1) as [{ options: QueryOptions }]
  // The session sends the shared mapping's answer and nothing of its own: the literals in
  // the tests below therefore pin the mapping a dispatched Claude agent is spawned with too.
  expect(options.sandbox).toStrictEqual(claudeSandboxOption(sandboxConfig))
  return options
}

/** The `--settings` JSON `buildArgs` emits for these options. */
function flagSettings(options: QueryOptions): Record<string, unknown> {
  const args = buildArgs(options)
  const at = args.indexOf('--settings')
  expect(at).toBeGreaterThan(-1)
  expect(args.lastIndexOf('--settings')).toBe(at)
  return JSON.parse(args[at + 1]) as Record<string, unknown>
}

describe('ClaudeSession — the `sandbox` spawn option', () => {
  it('sends no sandbox when the engine has no sandbox settings', async () => {
    const options = await spawnOptions()
    expect(options).not.toHaveProperty('sandbox')
    expect(flagSettings(options)).not.toHaveProperty('sandbox')
  })

  it('sends no sandbox when it is switched off, whatever else is set', async () => {
    const options = await spawnOptions(
      sandboxSettings({
        enabled: false,
        autoAllowBashIfSandboxed: true,
        excludedCommands: ['docker'],
        network: { restrictNetwork: true, allowedDomains: ['example.com'] },
        filesystem: { allowWrite: ['/data'] }
      })
    )
    expect(options).not.toHaveProperty('sandbox')
    expect(flagSettings(options)).not.toHaveProperty('sandbox')
  })

  it('an untouched sandbox switched on: the three switches, no network block, an empty filesystem block', async () => {
    const options = await spawnOptions(sandboxSettings({}))
    expect(options.sandbox).toStrictEqual({
      enabled: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: {}
    })
  })

  it('passes the two approval switches and the excluded commands as set', async () => {
    const options = await spawnOptions(
      sandboxSettings({
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        excludedCommands: ['docker', 'git push']
      })
    )
    expect(options.sandbox).toStrictEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      excludedCommands: ['docker', 'git push'],
      filesystem: {}
    })
  })

  it('restricted network: binding and the domain list always, the three optional keys only when set', async () => {
    const bare = await spawnOptions(sandboxSettings({ network: { restrictNetwork: true } }))
    expect((bare.sandbox as Record<string, unknown>).network).toStrictEqual({
      allowLocalBinding: false,
      allowedDomains: []
    })

    const full = await spawnOptions(
      sandboxSettings({
        network: {
          restrictNetwork: true,
          allowLocalBinding: true,
          allowedDomains: ['example.com', '*.npmjs.org'],
          allowManagedDomainsOnly: true,
          allowAllUnixSockets: true,
          allowUnixSockets: ['/var/run/docker.sock']
        }
      })
    )
    expect((full.sandbox as Record<string, unknown>).network).toStrictEqual({
      allowLocalBinding: true,
      allowedDomains: ['example.com', '*.npmjs.org'],
      allowManagedDomainsOnly: true,
      allowAllUnixSockets: true,
      allowUnixSockets: ['/var/run/docker.sock']
    })
  })

  it('unrestricted network: no network block unless binding or sockets are set, and never a domain list', async () => {
    // A domain list left over from a time the restriction was on must not restrict now.
    const leftover = await spawnOptions(
      sandboxSettings({
        network: {
          restrictNetwork: false,
          allowedDomains: ['example.com'],
          allowManagedDomainsOnly: true
        }
      })
    )
    expect(leftover.sandbox).not.toHaveProperty('network')

    const binding = await spawnOptions(
      sandboxSettings({ network: { allowLocalBinding: true, allowedDomains: ['example.com'] } })
    )
    expect((binding.sandbox as Record<string, unknown>).network).toStrictEqual({
      allowLocalBinding: true
    })

    const sockets = await spawnOptions(
      sandboxSettings({
        network: { allowAllUnixSockets: true, allowUnixSockets: ['/var/run/docker.sock'] }
      })
    )
    expect((sockets.sandbox as Record<string, unknown>).network).toStrictEqual({
      allowLocalBinding: false,
      allowAllUnixSockets: true,
      allowUnixSockets: ['/var/run/docker.sock']
    })
  })

  it('filesystem: each list only when it has entries', async () => {
    const options = await spawnOptions(
      sandboxSettings({ filesystem: { allowWrite: ['/data'], denyRead: ['~/.ssh'] } })
    )
    expect((options.sandbox as Record<string, unknown>).filesystem).toStrictEqual({
      allowWrite: ['/data'],
      denyRead: ['~/.ssh']
    })

    const all = await spawnOptions(
      sandboxSettings({
        filesystem: { allowWrite: ['/data'], denyWrite: ['/data/keep'], denyRead: ['~/.ssh'] }
      })
    )
    expect((all.sandbox as Record<string, unknown>).filesystem).toStrictEqual({
      allowWrite: ['/data'],
      denyWrite: ['/data/keep'],
      denyRead: ['~/.ssh']
    })
  })

  it('reaches cli.js inside the one --settings JSON, required to start, beside the session settings', async () => {
    const options = await spawnOptions(
      sandboxSettings({ excludedCommands: ['docker'], filesystem: { allowWrite: ['/data'] } })
    )
    const settings = flagSettings(options)
    expect(settings.sandbox).toStrictEqual({
      enabled: true,
      // cli.js then refuses to start where the sandbox cannot run, instead of running unsandboxed.
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      excludedCommands: ['docker'],
      filesystem: { allowWrite: ['/data'] }
    })
    expect(settings.idleCompaction).toBe(false)
    expect(settings.permissions).toEqual({
      allow: ['Edit(/tmp/proj/.claude/ui/**)', 'Write(/tmp/proj/.claude/ui/**)']
    })
  })
})
