/**
 * @vitest-environment node
 *
 * The `sandbox` option a Claude session spawns with: `claudeSandboxFlags('session')` read from
 * the shared user settings file (CLAUDE_CONFIG_DIR, a temp dir here) when the process is
 * spawned, and the `--settings` JSON it becomes. Nothing while the switch is off; the user
 * block verbatim plus `failIfUnavailable` while it is on; read per spawn, so a file change
 * between two spawns binds the second.
 *
 * Mock scaffold mirrors `claude-session-behavior-settings.test.ts`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { subscribeWindowToSync } from '../../../test/helpers/sync-subscriber-window'
import { clearSyncSubscribersForTests } from '../sync-host'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildArgs } from '../../sdk/args'
import type { QueryOptions } from '../../sdk'

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
  loadSettings: vi.fn(() => ({})),
  saveEngineConfig: vi.fn(),
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
let configDir: string
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-option-'))
  process.env.CLAUDE_CONFIG_DIR = configDir
})

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
  fs.rmSync(configDir, { recursive: true, force: true })
  for (const s of live.splice(0)) s.cancel()
  clearSyncSubscribersForTests()
  vi.clearAllMocks()
})

function writeUserSettings(sandbox: unknown): void {
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ sandbox }))
}

function newSession(): ClaudeSession {
  const win = {
    isDestroyed: () => false,
    webContents: { send: (): void => {} }
  } as unknown as BrowserWindow
  subscribeWindowToSync(
    win as unknown as { webContents: { send: (c: string, ...a: unknown[]) => void } }
  )
  const session = new ClaudeSession('sandbox', win, '/tmp/proj', {})
  live.push(session)
  return session
}

/** Run one prompt on the session and return the options cli.js was spawned with. */
async function spawnOptions(session = newSession()): Promise<QueryOptions> {
  mockQuery.mockImplementation(() => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      yield* []
    },
    initializationResult: (): Promise<never> => new Promise<never>(() => {}),
    interrupt: vi.fn(async () => {})
  }))
  await session.run('go')
  expect(mockQuery).toHaveBeenCalled()
  const [{ options }] = mockQuery.mock.calls.at(-1) as [{ options: QueryOptions }]
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
  it('sends no sandbox with no settings file or no block', async () => {
    const options = await spawnOptions()
    expect(options).not.toHaveProperty('sandbox')
    expect(flagSettings(options)).not.toHaveProperty('sandbox')
  })

  it('sends no sandbox while the shared switch is off, whatever else the block says', async () => {
    writeUserSettings({ enabled: false, excludedCommands: ['docker'] })
    const options = await spawnOptions()
    expect(options).not.toHaveProperty('sandbox')
    expect(flagSettings(options)).not.toHaveProperty('sandbox')
  })

  it('switch on: the validated block (unknown keys not carried), failIfUnavailable added, no gate key', async () => {
    writeUserSettings({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      enableWeakerNestedSandbox: true,
      network: { allowedDomains: ['example.com'], deniedDomains: ['bad.example'] }
    })
    const options = await spawnOptions()
    expect(options.sandbox).toStrictEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      network: { allowedDomains: ['example.com'], allowLocalBinding: false },
      failIfUnavailable: true
    })
    expect(flagSettings(options).sandbox).toStrictEqual(options.sandbox)
  })

  it('reads the file at each spawn: a change between two spawns binds the second', async () => {
    const session = newSession()
    const first = await spawnOptions(session)
    expect(first).not.toHaveProperty('sandbox')
    writeUserSettings({ enabled: true })
    const second = await spawnOptions(session)
    expect(second.sandbox).toStrictEqual({ enabled: true, failIfUnavailable: true })
  })
})
