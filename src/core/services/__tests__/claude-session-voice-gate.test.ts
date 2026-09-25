/**
 * @vitest-environment node
 *
 * `ClaudeSession.capabilities.voice` follows the spawned binary.
 *
 * The voice server is our cli.js patch; Anthropic's own binary answers the
 * voice control request with "Unsupported control request subtype". So the
 * HONEST per-session value (ADR-030) is the static Claude flag AND the harness
 * carrying `voice-server`, the same shape as `crossEngineDispatch`. Every mic
 * gate (InputBox, `voice:start-*` IPC, remote `voice:start`) reads this value.
 *
 * Mock scaffold mirrors `claude-session-snapshot-fallback.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { harnessHasPatch } = vi.hoisted(() => ({ harnessHasPatch: vi.fn((_name: string) => true) }))

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))

vi.mock('../../sdk/harness', () => ({
  harnessHasPatch,
  readHarnessInfo: () => ({ version: '0.0.0-test', patches: new Set<string>() }),
  getCliVersion: (): string => '0.0.0-test'
}))
vi.mock('../../sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk')>()
  return {
    ...actual,
    query: vi.fn(),
    locateBunClaude: (): string => __filename,
    getCliVersion: (): string => '0.0.0-test'
  }
})

vi.mock('../../opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { isBinaryAvailable: (): boolean => false }
}))
vi.mock('../cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), resolveApproval: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: (): boolean => true
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
  computeTokenMetrics: vi.fn(async () => ({ totalTokens: 0, totalCostUsd: 0 })),
  fallbackBlockText: vi.fn(() => '')
}))
vi.mock('../skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../subagent-watcher', () => ({ unwatchAllSubagents: vi.fn() }))
vi.mock('../voice-capture', () => ({ startRecording: vi.fn(), stopRecording: vi.fn() }))
vi.mock('../voice-client', () => ({ VoiceClient: class {} }))
vi.mock('../context-window', () => ({ getContextWindowSize: vi.fn(() => 200000) }))
vi.mock('../usage-fetcher', () => ({
  usageFetcher: { fetch: vi.fn(async () => null) }
}))
vi.mock('../usage-provider', () => ({ resolveUsageProvider: vi.fn() }))

// Import AFTER mocks.
import { ClaudeSession } from '../claude-session'
import { resolveClaudeCapabilities } from '../../../shared/model-capabilities'

beforeEach(() => {
  harnessHasPatch.mockReset()
})

describe('ClaudeSession.capabilities.voice', () => {
  it('is on when the spawned binary carries the voice-server patch', () => {
    harnessHasPatch.mockReturnValue(true)
    const session = new ClaudeSession('rid-voice-patched', null, '/tmp/proj')
    expect(session.capabilities.voice).toBe(true)
    expect(harnessHasPatch).toHaveBeenCalledWith('voice-server')
  })

  it('is off on a binary without the patch, and nothing else changes', () => {
    harnessHasPatch.mockReturnValue(false)
    const session = new ClaudeSession('rid-voice-official', null, '/tmp/proj')
    expect(session.capabilities.voice).toBe(false)
    expect(session.capabilities).toEqual({ ...resolveClaudeCapabilities('default'), voice: false })
  })

  it('reaches every client through the status the session publishes', () => {
    harnessHasPatch.mockReturnValue(false)
    const session = new ClaudeSession('rid-voice-status', null, '/tmp/proj')
    expect(session.status.capabilities.voice).toBe(false)
  })
})
