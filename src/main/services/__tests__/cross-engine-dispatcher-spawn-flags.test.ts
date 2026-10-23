/**
 * @vitest-environment node
 *
 * ADR-105 — what the REAL Claude spawn (`defaultSpawnClaudeQuery`) hands the SDK: a
 * dispatch target's session is persisted (it used to carry `persistSession: false`,
 * i.e. `--no-session-persistence`), created under the uuid the dispatcher recorded in
 * the ledger BEFORE the spawn, and resumed by `--resume` once its process is gone.
 *
 * The component suite injects `spawnClaudeQuery`, so the flags themselves are only
 * visible here, with the SDK's `query` replaced.
 */
import { describe, expect, it, vi } from 'vitest'
import type { QueryHandle, SDKMessage } from '../../../core/sdk'
import { CrossEngineDispatcher } from '../../../core/services/cross-engine-dispatcher'
import type { DispatchContext } from '../../../core/services/cross-engine-dispatcher'
import { makeFakeDispatchLedger } from '../../../test/helpers/fake-dispatch-ledger'
import { withDefaultDescription } from '../../../test/helpers/default-dispatch-description'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../../../core/sdk', async (importActual) => ({
  ...(await importActual<typeof import('../../../core/sdk')>()),
  query: mocks.query
}))
vi.mock('../../../core/providers/claude-spawn-prep', () => ({ claudeSpawnPrep: vi.fn() }))
vi.mock('../../../core/sdk/host-token', async (importActual) => ({
  ...(await importActual<typeof import('../../../core/sdk/host-token')>()),
  ensureHostTokenFresh: vi.fn(async () => {})
}))

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** A process that answers its first prompt: init, then a result — and then stays quiet. */
function oneTurnProcess(sessionId: string): QueryHandle {
  const script: SDKMessage[] = [
    { type: 'system', subtype: 'init', session_id: sessionId } as SDKMessage,
    { type: 'result', subtype: 'success', result: 'done', session_id: sessionId } as SDKMessage
  ]
  const iterator: AsyncIterator<SDKMessage> = {
    next: () =>
      script.length > 0
        ? Promise.resolve({ value: script.shift()!, done: false })
        : new Promise(() => {}),
    return: async () => {
      throw new Error('iterator.return() would kill the process')
    }
  }
  return {
    [Symbol.asyncIterator]: () => iterator,
    setPermissionMode: vi.fn(async () => {})
  } as unknown as QueryHandle
}

function ctx(): DispatchContext {
  return {
    fromEngine: 'opencode',
    fromRoutingId: 'parent-A',
    cwd: '/tmp/proj',
    getAutonomyMode: () => 'default',
    getMessages: () => [],
    emit: vi.fn()
  }
}

describe('the real Claude dispatch spawn (ADR-105)', () => {
  it('persists the session under the recorded uuid, and --resume-s it after the process is gone', async () => {
    mocks.query.mockReset()
    const ledger = makeFakeDispatchLedger()
    const dispatcher = withDefaultDescription(
      new CrossEngineDispatcher({
        serverManager: {
          acquire: vi.fn(),
          releaseIfCurrent: vi.fn(),
          subscribeExit: vi.fn(() => () => {})
        },
        makeClient: vi.fn(),
        loadEngineConfig: () => ({ dispatch: { defaultModel: 'haiku' } }),
        loadUserRules: () => ({
          allow: [],
          deny: [],
          ask: [],
          additionalDirectories: [],
          defaultMode: undefined
        }),
        resolveMaxConcurrent: () => 5,
        ledger,
        locateClaudeTranscript: () => '/projects/x.jsonl',
        targetCwdExists: () => true
      })
    )

    // The ledger row is there when `query` is called: the uuid it names is the one used.
    const rowAtSpawn: unknown[] = []
    mocks.query.mockImplementationOnce((input: { options: { sessionId?: string } }) => {
      rowAtSpawn.push(ledger.rowFor('claude', input.options.sessionId ?? ''))
      return oneTurnProcess('claude-sess-1')
    })
    const first = await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())

    const created = mocks.query.mock.calls[0][0].options as Record<string, unknown>
    expect(created.sessionId).toMatch(UUID_V4)
    expect(rowAtSpawn[0]).toMatchObject({ harnessRef: created.sessionId, state: 'running' })
    // Persisted: neither spelling of "no transcript" is passed.
    expect(created.persistSession).toBeUndefined()
    expect(created).not.toHaveProperty('persistSession')
    expect(created.resume).toBeUndefined()

    dispatcher.disposeFor('parent-A')
    mocks.query.mockImplementationOnce(() => oneTurnProcess('claude-sess-1'))
    await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: first.sessionId },
      ctx()
    )

    const resumed = mocks.query.mock.calls[1][0].options as Record<string, unknown>
    expect(resumed.resume).toBe('claude-sess-1')
    expect(resumed.sessionId).toBeUndefined()
    expect(resumed.persistSession).toBeUndefined()
    expect(resumed.cwd).toBe('/tmp/proj')
  })
})
