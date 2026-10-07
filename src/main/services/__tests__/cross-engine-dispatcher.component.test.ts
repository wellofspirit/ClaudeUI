/**
 * @vitest-environment node
 *
 * Component tests for CrossEngineDispatcher (ADR-033) — guards, model
 * resolution, target lifecycle, approval forwarding, cancellation.
 *
 * The dispatcher takes constructor-injected deps (server manager, client
 * factory, engine config loader), so no HTTP / process spawning happens here.
 * The singleton's default deps pull in OpencodeServerManager (which imports
 * electron at runtime), so electron is shimmed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { DEFAULT_MAX_CONCURRENT_DISPATCHES } from '../../../shared/dispatch-concurrency'

vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// Every pi-target TEST in this file injects a fake spawnPiTarget dep (bypassing
// defaultSpawnPiTarget entirely), so mocking locatePiLaunch here has no effect
// on them either way — see buildPiTargetChildEnv's own dedicated test for the
// real defaultSpawnPiTarget's recursion-guard property.
vi.mock('../../../core/pi/pi-locate', () => ({
  locatePiLaunch: vi.fn(() => null),
  piBinaryAvailable: vi.fn(() => true)
}))
// Every codex-target TEST injects a fake spawnCodexTarget (bypassing
// defaultSpawnCodexTarget, which is the only thing that would ever locate a
// real binary), so this mock cannot affect them either way.
vi.mock('../../../core/codex/codex-locate', () => ({
  codexBinaryAvailable: vi.fn(() => false),
  locateCodexBinary: vi.fn(() => null),
  locateCodexCodeModeHost: vi.fn(() => null)
}))
// crossEngineDispatchAvailable asks the harness resolver (ADR-082); mocked so
// each harness's availability is controllable per-test, off the real vendor/.
const { harnessInstalled } = vi.hoisted(() => ({
  harnessInstalled: { opencode: true, pi: true, codex: false } as Record<string, boolean>
}))
vi.mock('../../../core/harness/resolve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/harness/resolve')>()),
  harnessAvailable: vi.fn((id: string) => harnessInstalled[id] ?? true)
}))
// The bridged Claude MCP servers for a cwd. Hermetic — never the dev's real
// Claude config: no bridged server.
vi.mock('../../../core/opencode/claude-mcp-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/opencode/claude-mcp-bridge')>()),
  collectClaudeMcpForOpencode: vi.fn((): Record<string, unknown> => ({}))
}))
// ADR-088 — the target judge's ground truth and the shared trust lists stay
// hermetic: no git subprocess, never the dev's own `~/.claude/ui/automode.json`.
vi.mock('../../../core/automode/ground-truth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/automode/ground-truth')>()),
  captureGitRemotes: vi.fn(async () => []),
  captureRepoVisibility: vi.fn(async () => 'unknown'),
  captureGitStatus: vi.fn(async () => null),
  captureGitConfigArmed: vi.fn(async () => [])
}))
vi.mock('../../../core/services/ui-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/ui-config')>()),
  loadSharedAutoModeConfig: vi.fn(() => ({}))
}))

import {
  CrossEngineDispatcher,
  DISPATCH_PROMPT_PREAMBLE,
  DISPATCH_WATCHDOG_INTERVAL_MS,
  XENG_REQUEST_PREFIX,
  crossEngineDispatchAvailable,
  buildPiTargetChildEnv
} from '../../../core/services/cross-engine-dispatcher'
import { opencodeAuthProvider } from '../../../core/auth/OpencodeAuthProvider'
import { piAuthProvider } from '../../../core/auth/PiAuthProvider'
import { usageFetcher } from '../../../core/services/usage-fetcher'
import type { UsageTurnEvent } from '../../../core/services/usage-recorder'
import type {
  ClaudeQuerySpawnOpts,
  DispatchContext,
  DispatcherDeps,
  DispatchResult,
  PiTargetSpawnOpts,
  PiTargetPrimitives,
  CodexTargetAttachOpts,
  SpawnClaudeQueryFn,
  SpawnPiTargetFn,
  AttachCodexTargetFn
} from '../../../core/services/cross-engine-dispatcher'
import { CodexMethodNotFound } from '../../../core/codex/CodexAppServerClient'
import { codexTurnPolicy } from '../../../core/codex/codex-turn-policy'
import type { SessionJudgeOptions } from '../../../core/automode/session-judge'
import type { JudgeRequest } from '../../../core/automode/classifier'
import type { QueryHandle, ResultMessage, SDKMessage, SdkToolExtra } from '../../../core/sdk'
import type { ChatMessage, EngineConfig, EngineId, PendingApproval } from '../../../shared/types'
import { loadSharedAutoModeConfig } from '../../../core/services/ui-config'
import { BlockedCallLedger } from '../../../core/automode/blocked-calls'

/** The hold window the ADR-091 §3 held-card tests run under (`blockHoldSeconds: 120`). */
const HOLD_MS = 120_000
import type { PiRpcClient } from '../../../core/pi/PiRpcClient'
import type { PiBridgeHost, PiBridgeHandler } from '../../../core/pi/PiBridgeHost'
import { SyncCore } from '../../../core/sync/sync-core'
import { PLAN_MODE_DENY_REASON_NO_EXIT_TOOL } from '../../../core/pi/permission-engine'
import type { MergedClaudeRules } from '../../../core/pi/permission-engine'
import { callerRestrictionFromAgent } from '../../../core/opencode/caller-restriction'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * The opencode side of the harness. opencode TARGETS (opencode 2.x, ADR-093
 * S9) have their own suite, `cross-engine-dispatcher-opencode.component.test.ts`,
 * with a fake 2.x server; this file covers the Claude, pi and Codex targets and
 * the shared machinery, so an opencode lease or client here is a test bug.
 */
function unusedOpencode(): never {
  throw new Error(
    'opencode targets are tested in cross-engine-dispatcher-opencode.component.test.ts'
  )
}

/** The user's merged permission rules as the dispatcher loads them (ADR-085 §3). */
function userRules(r: Partial<MergedClaudeRules> = {}): MergedClaudeRules {
  return {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
    ...r
  }
}

function makeHarness(overrides: Partial<DispatcherDeps> = {}): {
  dispatcher: CrossEngineDispatcher
  deps: { serverManager: { acquire: ReturnType<typeof vi.fn> } }
} {
  const serverManager = {
    acquire: vi.fn(async () => unusedOpencode()),
    releaseIfCurrent: vi.fn(),
    subscribeExit: vi.fn(() => () => {})
  }
  const deps: DispatcherDeps = {
    serverManager,
    makeClient: () => unusedOpencode(),
    loadEngineConfig: () => ({ dispatch: { defaultModel: 'openai/gpt-5' } }),
    heartbeatMs: 50,
    // ADR-033 M4c: keep pi's stop/timeout/abort grace-period wait (see
    // PiTargetEntry.settled's "RACE NOTE") fast in tests by default — tests
    // that specifically exercise the grace period's own timing override this.
    piAbortSettleGraceMs: 20,
    // Hermetic: the production default resolver reads the USER's settings.json
    // (`AppSettings.dispatchMaxConcurrent`), which no test may depend on. Every
    // concurrency test overrides this with the cap it is actually about.
    resolveMaxConcurrent: () => DEFAULT_MAX_CONCURRENT_DISPATCHES,
    // Hermetic: the production default (`mergedClaudeRulesFor`) reads the
    // USER's settings files. Tests about the user's rules override it.
    loadUserRules: () => userRules(),
    ...overrides
  }
  return { dispatcher: new CrossEngineDispatcher(deps), deps: { serverManager } }
}

/**
 * `autonomyMode` is a CONVENIENCE override (the ~50 call sites stay readable):
 * it becomes `getAutonomyMode: () => mode`. Pass `getAutonomyMode` itself for a
 * live switch (ADR-088).
 */
function makeCtx(
  overrides: Partial<DispatchContext> & { autonomyMode?: string } = {}
): DispatchContext & {
  emit: ReturnType<typeof vi.fn>
  addDispatchedCost: ReturnType<typeof vi.fn>
} {
  const { autonomyMode = 'default', ...rest } = overrides
  return {
    fromEngine: 'claude',
    fromRoutingId: 'routing-1',
    cwd: '/tmp/xeng-project',
    getAutonomyMode: () => autonomyMode,
    getMessages: () => [],
    emit: vi.fn(),
    addDispatchedCost: vi.fn(),
    ...rest
  } as DispatchContext & {
    emit: ReturnType<typeof vi.fn>
    addDispatchedCost: ReturnType<typeof vi.fn>
  }
}

/**
 * A scripted judge transport for ADR-088's target judge, injected through
 * `DispatcherDeps.makeJudgeTransport` (no mocked modules). Each reply is
 * consumed by one judge call (one call per judgement in `twoStageMode: 'fast'`):
 * a string is the completion, an Error is a transport failure, a function is
 * awaited (a held judge). Unscripted calls allow.
 */
function makeScriptedJudge(): {
  make: ReturnType<
    typeof vi.fn<(opts: SessionJudgeOptions) => (req: JudgeRequest) => Promise<string>>
  >
  opts: SessionJudgeOptions[]
  requests: JudgeRequest[]
  replies: Array<string | Error | (() => Promise<string>)>
} {
  const opts: SessionJudgeOptions[] = []
  const requests: JudgeRequest[] = []
  const replies: Array<string | Error | (() => Promise<string>)> = []
  const make = vi.fn((o: SessionJudgeOptions) => {
    opts.push(o)
    return async (req: JudgeRequest): Promise<string> => {
      requests.push(req)
      const next = replies.shift()
      if (next instanceof Error) throw next
      if (typeof next === 'function') return next()
      return next ?? '<block>no</block>'
    }
  })
  return { make, opts, requests, replies }
}

/** A promise whose resolution a test controls (a judge held mid-flight). */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function makeExtra(overrides: Partial<SdkToolExtra> = {}): SdkToolExtra {
  return {
    signal: new AbortController().signal,
    sendNotification: vi.fn(async () => {}),
    ...overrides
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Advance FAKE timers (and flush the microtasks in between) — the watchdog
 * that governs dispatch turn timeouts polls on a 10 s interval against the
 * injectable clock, so its tests run on fake timers and use this instead of
 * `tick()` (which is `setImmediate` — itself faked, hence never firing).
 */
const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
}

/**
 * The fake-timer analogue of `tick()`: drain the multi-`await` promise chains a
 * dispatch target's creation goes through (spawn → get_state → set_model for
 * pi; config/read → model/list → thread/start for Codex). One `advance(0)`
 * flushes a single microtask round, which is not enough to get from `dispatch()`
 * to the point where the turn — and its watchdog — is actually running.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0)
}

/**
 * The identity a target's account resolves to unless a test says otherwise —
 * the `<engine>:<vendor>:native` shape ADR-071 §3 gives credentials we cannot
 * name.
 *
 * These two spies are NOT a convenience. Both real methods read the engine's
 * own `auth.json` off the host's data dir, so without them this suite would
 * consult the developer's sign-in state (the gotcha that was found in three
 * other suites when `accountIdentity` first shipped). No test here may touch a
 * real credential file.
 */
const NATIVE_OPENCODE_IDENTITY = { accountKey: 'opencode:openai:native', accountLabel: 'openai' }
const NATIVE_PI_IDENTITY = {
  accountKey: 'pi:openai-codex:native',
  accountLabel: 'openai-codex'
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(opencodeAuthProvider, 'accountIdentity').mockReturnValue(NATIVE_OPENCODE_IDENTITY)
  vi.spyOn(piAuthProvider, 'accountIdentity').mockReturnValue(NATIVE_PI_IDENTITY)
})

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — guards', () => {
  it('rejects dispatch into a genuinely unsupported engine (defensive guard — EngineId is closed, but this crosses an IPC boundary at runtime)', async () => {
    const { dispatcher } = makeHarness()
    // A string no EngineId has ever been. 'codex' USED to stand in here; slice
    // H made it a real target, so the defensive guard needs a genuinely
    // unknown engine to be defensive about.
    const result = await dispatcher.dispatch(
      { engine: 'gemini' as unknown as EngineId, prompt: 'x' },
      makeCtx({ fromEngine: 'opencode' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not supported yet')
  })

  // The cap became a user setting (ADR-033, 2026-09-18): "the slot can be a
  // configuration as well … in certain cases we will need more dispatches". The
  // three tests below pin the three things that ruling asks of the gate.
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Target lifecycle
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Timeout / abort / heartbeat
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Turn completion over prompt_async + SSE (ADR-033's 2026-09-01 amendment).
// The synchronous POST /session/{id}/message died at undici's 300 s
// headersTimeout on any long turn; the turn is now forked server-side and
// completed by session.idle / session.error, with text + usage read back from
// stored history — and governed by an inactivity + absolute watchdog instead of
// the fixed 10-minute cap.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Claude direction (ADR-033 M2 — opencode → Claude)
// ---------------------------------------------------------------------------

/**
 * Fake headless Claude target: one shared queue-backed iterator (mirrors the
 * real `MessageQueue`/`makeHandle` shape from sdk/query.ts). `iterator.return`
 * THROWS on purpose — the dispatcher must never call it (see the `.return()`
 * hazard documented on `ClaudeTargetEntry`); a thrown assertion here catches
 * a regression immediately instead of silently killing a fake process.
 */
function makeFakeClaudeTarget(opts: { rejectAuto?: boolean } = {}): {
  spawnClaudeQuery: SpawnClaudeQueryFn
  spawnCalls: ClaudeQuerySpawnOpts[]
  push: (msg: Partial<SDKMessage> & { type: string }) => void
  lastCanUseTool: () => ClaudeQuerySpawnOpts['canUseTool'] | undefined
  lastAbortController: () => AbortController | undefined
  /** Every `set_permission_mode` the dispatcher sent (ADR-088 live mode). */
  setModeCalls: string[]
} {
  const spawnCalls: ClaudeQuerySpawnOpts[] = []
  const setModeCalls: string[] = []
  const queue: SDKMessage[] = []
  let waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null

  const iterator: AsyncIterator<SDKMessage> = {
    next: (): Promise<IteratorResult<SDKMessage>> => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
      return new Promise((resolve) => {
        waiting = resolve
      })
    },
    return: async (): Promise<IteratorResult<SDKMessage>> => {
      throw new Error(
        'iterator.return() must never be called by the dispatcher — it kills the Claude process (sdk/query.ts makeHandle)'
      )
    }
  }
  const handle = {
    [Symbol.asyncIterator]: () => iterator,
    // cli.js answers a rejected `auto` with a control_response error, which
    // QueryHandle.setPermissionMode throws (docs/protocol-cc, ADR-088 F3).
    setPermissionMode: vi.fn(async (mode: string) => {
      setModeCalls.push(mode)
      if (opts.rejectAuto && mode === 'auto') {
        throw new Error('set_permission_mode:auto rejected — gate not enabled')
      }
    })
  } as unknown as QueryHandle

  const spawnClaudeQuery = vi.fn<SpawnClaudeQueryFn>(async (opts) => {
    spawnCalls.push(opts)
    return handle
  })

  return {
    spawnClaudeQuery,
    spawnCalls,
    push(msg) {
      const full = msg as SDKMessage
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: full, done: false })
      } else {
        queue.push(full)
      }
    },
    lastCanUseTool: () => spawnCalls.at(-1)?.canUseTool,
    lastAbortController: () => spawnCalls.at(-1)?.abortController,
    setModeCalls
  }
}

function resultMsg(overrides: Partial<ResultMessage> = {}): SDKMessage {
  return { type: 'result', subtype: 'success', result: 'default text', ...overrides } as SDKMessage
}

describe('CrossEngineDispatcher — Claude direction (ADR-033 M2)', () => {
  it('happy path: spawns once, drives to result, returns text + the discovered session_id', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })

    const pending = dispatcher.dispatch(
      { engine: 'claude', prompt: 'review this' },
      makeCtx({ fromEngine: 'opencode', autonomyMode: 'acceptEdits' })
    )
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)

    target.push({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm1', content: [] } }
    } as unknown as SDKMessage)
    target.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    } as unknown as SDKMessage)
    target.push({ type: 'assistant' } as SDKMessage)
    target.push(resultMsg({ result: 'the review text', session_id: 'claude-sess-1' }))

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the review text')
    expect(result.sessionId).toBe('claude-sess-1')
    expect(target.spawnCalls).toHaveLength(1)
    expect(target.spawnCalls[0].model).toBe('haiku')
    expect(target.spawnCalls[0].cwd).toBe('/tmp/xeng-project')
  })

  it('continuation: session_id reuses the SAME fake handle (no second spawn)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer' }))
    const firstResult = await first
    expect(firstResult.sessionId).toBe('claude-sess-1')

    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'second answer' }))
    const secondResult = await second

    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.text).toBe('second answer')
    expect(secondResult.sessionId).toBe('claude-sess-1')
    expect(target.spawnCalls).toHaveLength(1) // no re-spawn
  })

  it('continuation with an unknown sessionId → isError, no spawn', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const result = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'x', sessionId: 'no-such-claude-session' },
      makeCtx({ fromEngine: 'opencode' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-such-claude-session')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('busy target: a concurrent same-session_id dispatch is REJECTED without disturbing the running turn', async () => {
    // Two dispatch_agent calls with the same session_id can run concurrently
    // (their MCP handlers overlap within one assistant turn). Interleaving
    // them on the target's single iterator would split messages arbitrarily
    // between the two driver loops — so the second call must busy-reject.
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    // Turn 1: establish the session_id, then complete it.
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer' }))
    expect((await first).sessionId).toBe('claude-sess-1')

    // Turn 2: continuation, left in flight (no result pushed yet).
    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()

    // Turn 3: concurrent continuation while turn 2 is mid-flight → busy-reject.
    const third = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'three', sessionId: 'claude-sess-1' },
      ctx
    )
    expect(third.isError).toBe(true)
    expect(third.text).toContain('already running')
    expect(third.sessionId).toBe('claude-sess-1')

    // The busy-reject did NOT abort/remove the target…
    expect(target.spawnCalls).toHaveLength(1)
    expect(target.lastAbortController()?.signal.aborted).toBe(false)

    // …and the in-flight turn still completes normally with ITS OWN result.
    target.push(resultMsg({ result: 'second answer' }))
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.text).toBe('second answer')

    // The target remains continuable after the busy window closes.
    const fourth = dispatcher.dispatch(
      { engine: 'claude', prompt: 'four', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'fourth answer' }))
    expect((await fourth).text).toBe('fourth answer')
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('a result with a non-success subtype → isError with the error detail; target stays alive for continuation', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['Reached maximum number of turns (3)'] })
    )
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Reached maximum number of turns (3)')
    expect(result.sessionId).toBe('claude-sess-1')

    // The process was NOT aborted — a fresh continuation call still works.
    const cont = dispatcher.dispatch(
      { engine: 'claude', prompt: 'retry', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'recovered' }))
    expect((await cont).text).toBe('recovered')
    expect(target.spawnCalls).toHaveLength(1)
  })

  describe('model resolution', () => {
    it('no default configured and no model requested → isError naming engines/claude.json', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({})),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const result = await dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode' })
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('engines/claude.json')
      expect(target.spawnCalls).toHaveLength(0)
    })

    it('allowlist violation → isError, no spawn', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { allowedModels: ['haiku'] } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const result = await dispatcher.dispatch(
        { engine: 'claude', prompt: 'x', model: 'opus' },
        makeCtx({ fromEngine: 'opencode' })
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('allowlist')
      expect(target.spawnCalls).toHaveLength(0)
    })
  })

  describe('autonomy-mode inheritance', () => {
    // ADR-088: an auto parent's Claude target runs cli.js `auto` (its own
    // judge), never bypass; only a bypass parent still spawns bypass + skip.
    it.each([
      ['auto', 'auto', false],
      ['bypassPermissions', 'bypassPermissions', true],
      ['plan', 'default', false],
      ['default', 'default', false],
      ['acceptEdits', 'acceptEdits', false]
    ] as const)(
      'autonomyMode=%s → permissionMode=%s (allowDangerouslySkipPermissions=%s)',
      async (autonomyMode, expectedMode, expectedSkip) => {
        const target = makeFakeClaudeTarget()
        const { dispatcher } = makeHarness({
          loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
          spawnClaudeQuery: target.spawnClaudeQuery
        })
        const pending = dispatcher.dispatch(
          { engine: 'claude', prompt: 'x' },
          makeCtx({ fromEngine: 'opencode', autonomyMode })
        )
        await tick()
        target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
        target.push(resultMsg())
        await pending

        expect(target.spawnCalls[0].permissionMode).toBe(expectedMode)
        expect(target.spawnCalls[0].allowDangerouslySkipPermissions).toBe(expectedSkip)
      }
    )

    it('R2: a `full` parent spawns the Claude target in cli.js `auto` (never the invalid mode `full`)', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode', autonomyMode: 'full' })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg())
      await pending
      expect(target.spawnCalls[0].permissionMode).toBe('auto')
      expect(target.spawnCalls[0].allowDangerouslySkipPermissions).toBe(false)
    })

    it('T9: the pushed prompt carries DISPATCH_PROMPT_PREAMBLE, so cli.js’s judge never reads it as the user’s words', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'tidy the build dir' },
        makeCtx({ fromEngine: 'opencode', autonomyMode: 'auto' })
      )
      await tick()
      const first = await target.spawnCalls[0].prompt[Symbol.asyncIterator]().next()
      const message = (first.value as { message: { content: string } }).message
      expect(message.content).toBe(DISPATCH_PROMPT_PREAMBLE + 'tidy the build dir')
      expect(target.spawnCalls[0].permissionMode).toBe('auto')
      expect(target.spawnCalls[0].allowDangerouslySkipPermissions).toBe(false)
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg())
      await pending
    })

    async function liveClaude(rejectAuto = false) {
      const target = makeFakeClaudeTarget({ rejectAuto })
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      let mode = 'default'
      const ctx = makeCtx({ fromEngine: 'opencode', getAutonomyMode: () => mode })
      const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg())
      await first
      const turn = async (prompt: string): Promise<void> => {
        const next = dispatcher.dispatch(
          { engine: 'claude', prompt, sessionId: 'claude-sess-1' },
          ctx
        )
        await tick()
        target.push(resultMsg())
        expect((await next).isError).toBeUndefined()
      }
      return { target, ctx, turn, setMode: (m: string) => (mode = m) }
    }

    it('T11: a continuation after the parent switched default → auto applies auto ONCE; the same mode again sends nothing', async () => {
      const live = await liveClaude()
      expect(live.target.spawnCalls[0].permissionMode).toBe('default')
      live.setMode('auto')
      await live.turn('two')
      expect(live.target.setModeCalls).toEqual(['auto'])
      await live.turn('three')
      expect(live.target.setModeCalls).toEqual(['auto'])
      expect(live.target.spawnCalls).toHaveLength(1)
    })

    it('F9: spawn bookkeeping — an auto-spawned target continuing in auto sends NO set_permission_mode', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', autonomyMode: 'auto' })
      const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg())
      await first
      const second = dispatcher.dispatch(
        { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
        ctx
      )
      await tick()
      target.push(resultMsg())
      await second
      expect(target.setModeCalls).toEqual([])
    })

    it('F9: spawn bookkeeping — a bypass-spawned target continuing in bypass sends NO set_permission_mode', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', autonomyMode: 'bypassPermissions' })
      const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg())
      await first
      const second = dispatcher.dispatch(
        { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
        ctx
      )
      await tick()
      target.push(resultMsg())
      await second
      expect(target.setModeCalls).toEqual([])
    })

    it('T11: a rejected auto falls back to default with ONE warning, and is not retried', async () => {
      const live = await liveClaude(true)
      live.setMode('auto')
      await live.turn('two')
      expect(live.target.setModeCalls).toEqual(['auto', 'default'])
      await live.turn('three')
      expect(live.target.setModeCalls).toEqual(['auto', 'default'])
      const warnings = live.ctx.emit.mock.calls.filter((c) => c[0] === 'session:warning')
      expect(warnings).toHaveLength(1)
      expect(warnings[0][1]).toContain('auto mode was rejected')
    })

    it('a mid-turn switch reaches the process at the target’s next tool ask', async () => {
      const live = await liveClaude()
      const pending = live.target.spawnCalls[0]
      live.setMode('acceptEdits')
      const ask = pending.canUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal,
        toolUseId: 'toolu_inner'
      } as never)
      await tick()
      expect(live.target.setModeCalls).toEqual(['acceptEdits'])
      // The ask in hand still goes to the human (it was produced under the old mode).
      expect(live.ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)
      void ask
    })

    it('a bypass parent switching a non-bypass process applies default (the skip flag is spawn-only)', async () => {
      const live = await liveClaude()
      live.setMode('acceptEdits')
      await live.turn('two')
      live.setMode('bypassPermissions')
      await live.turn('three')
      expect(live.target.setModeCalls).toEqual(['acceptEdits', 'default'])
    })
  })

  describe('timeout / abort', () => {
    it('the configured absolute cap aborts the target and removes the entry (no continuation possible)', async () => {
      vi.useFakeTimers()
      try {
        const target = makeFakeClaudeTarget()
        const { dispatcher } = makeHarness({
          loadEngineConfig: vi.fn(() => ({
            dispatch: { defaultModel: 'haiku', turnTimeoutMs: 60_000 }
          })),
          heartbeatMs: 30_000,
          spawnClaudeQuery: target.spawnClaudeQuery
        })
        const ctx = makeCtx({ fromEngine: 'opencode' })
        const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
        await settle()
        target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
        // Never push a result — the turn hangs until the configured cap fires.
        await advance(70_000)
        const result = await pending
        expect(result.isError).toBe(true)
        expect(result.text).toContain('timed out')
        expect(result.text).toContain('1 minutes')
        expect(result.sessionId).toBe('claude-sess-1')
        expect(target.lastAbortController()?.signal.aborted).toBe(true)

        // The entry was removed — continuation now fails.
        const cont = await dispatcher.dispatch(
          { engine: 'claude', prompt: 'y', sessionId: 'claude-sess-1' },
          ctx
        )
        expect(cont.isError).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })

    it('extra.signal abort cancels the dispatch and aborts the target', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const abort = new AbortController()
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode', extra: makeExtra({ signal: abort.signal }) })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      abort.abort()
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('cancelled')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)
    })

    it('timeout dismisses forwarded canUseTool approvals still pending for that target', async () => {
      vi.useFakeTimers()
      try {
        // The ABSOLUTE cap, deliberately (mirrors the opencode twin): a pending
        // forwarded approval keeps the INACTIVITY clock rolling, so a turn
        // parked on a human is never an inactive turn.
        const target = makeFakeClaudeTarget()
        const { dispatcher } = makeHarness({
          loadEngineConfig: vi.fn(() => ({
            dispatch: { defaultModel: 'haiku', turnTimeoutMs: 60_000 }
          })),
          heartbeatMs: 30_000,
          spawnClaudeQuery: target.spawnClaudeQuery
        })
        const ctx = makeCtx({ fromEngine: 'opencode' })
        const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
        await settle()
        target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
        await settle()

        // The target calls a tool mid-turn — never resolved by the test.
        const canUseTool = target.lastCanUseTool()!
        const approvalPromise = canUseTool(
          'Bash',
          { command: 'x' },
          {
            signal: new AbortController().signal,
            toolUseId: 'toolu_1'
          }
        )
        await settle()
        expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

        await advance(70_000)
        const result = await pending
        expect(result.isError).toBe(true)
        const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
        expect(dismiss).toBeTruthy()

        // The hanging canUseTool promise must resolve (deny) — never left hanging.
        const approval = await approvalPromise
        expect(approval.behavior).toBe('deny')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('approval forwarding (canUseTool)', () => {
    async function makeApprovingTarget(): Promise<{
      dispatcher: CrossEngineDispatcher
      target: ReturnType<typeof makeFakeClaudeTarget>
      ctx: ReturnType<typeof makeCtx>
      pending: Promise<DispatchResult>
      canUseTool: NonNullable<ClaudeQuerySpawnOpts['canUseTool']>
    }> {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()
      return { dispatcher, target, ctx, pending, canUseTool: target.lastCanUseTool()! }
    }

    it('canUseTool emits an xeng-prefixed approval-request on the dispatching session', async () => {
      const { dispatcher, target, ctx, pending, canUseTool } = await makeApprovingTarget()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'rm -rf x' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
      expect(call).toBeTruthy()
      const approval = call![1] as { requestId: string; toolName: string; toolUseId?: string }
      expect(approval.requestId.startsWith(XENG_REQUEST_PREFIX)).toBe(true)
      expect(approval.toolName).toBe('Bash')
      expect(approval.toolUseId).toBe('toolu_1')

      // Still pending — NOT auto-allowed.
      const sentinel = Symbol('pending')
      expect(await Promise.race([toolPromise, Promise.resolve(sentinel)])).toBe(sentinel)

      // Clean up: resolve + let the turn finish.
      dispatcher.resolveApproval(approval.requestId, 'allow')
      await toolPromise
      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(allow) resolves canUseTool with allow + the original input', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'ls' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      const consumed = dispatcher.resolveApproval(approval.requestId, 'allow')
      expect(consumed).toBe(true)
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })

      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(deny) with feedback resolves canUseTool with deny + the feedback message', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'rm -rf /' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'deny', { feedback: 'too dangerous' })
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'deny', message: 'too dangerous' })

      target.push(resultMsg())
      await pending
    })

    it('resolveApproval(deny) without feedback → "User denied"', async () => {
      const { dispatcher, ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'x' },
        {
          signal: new AbortController().signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'deny')
      expect(await toolPromise).toEqual({ behavior: 'deny', message: 'User denied' })

      target.push(resultMsg())
      await pending
    })

    it('opts.signal abort → dismisses the card and resolves canUseTool with deny (cli.js control_cancel_request)', async () => {
      const { ctx, pending, canUseTool, target } = await makeApprovingTarget()
      const toolAbort = new AbortController()
      const toolPromise = canUseTool(
        'Bash',
        { command: 'x' },
        {
          signal: toolAbort.signal,
          toolUseId: 'toolu_1'
        }
      )
      await tick()
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

      toolAbort.abort()
      const result = await toolPromise
      expect(result).toEqual({ behavior: 'deny', message: 'Dispatch cancelled' })
      const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
      expect(dismiss).toBeTruthy()

      target.push(resultMsg())
      await pending
    })
  })

  describe('disposeFor', () => {
    it('aborts the Claude target process (no server/session to delete)', async () => {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', fromRoutingId: 'routing-claude-owner' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()

      dispatcher.disposeFor('routing-claude-owner')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)

      // Let the hung turn resolve so the test doesn't leave a dangling promise.
      target.push(resultMsg())
      const result = await pending
      // The abort races the result; either outcome is acceptable here — the
      // key assertion is the abortController.abort() call above.
      expect(result).toBeTruthy()
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M3 — streaming, progress, task-notification, stop (both directions)
// ---------------------------------------------------------------------------

const RELEVANT_SUBAGENT_CHANNELS = [
  'session:subagent-stream',
  'session:subagent-message',
  'session:subagent-tool-result',
  'session:task-progress',
  'session:task-notification'
]

describe('CrossEngineDispatcher — M3 (Claude direction: streaming/progress/notification/stop)', () => {
  it('keeps root and native-child streams isolated while remapping both to the outer owner', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'outer-owner' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-interleave' } as SDKMessage)
    const frame = (parent: string | undefined, event: Record<string, unknown>): SDKMessage =>
      ({ type: 'stream_event', parent_tool_use_id: parent, event }) as unknown as SDKMessage
    target.push(frame(undefined, { type: 'message_start', message: { id: 'root-message' } }))
    target.push(
      frame(undefined, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    )
    target.push(frame('native-child', { type: 'message_start', message: { id: 'child-message' } }))
    target.push(
      frame('native-child', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    )
    target.push(
      frame(undefined, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'root' }
      })
    )
    target.push(
      frame('native-child', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'child' }
      })
    )
    await tick()
    target.push(resultMsg({ result: 'done' }))
    await pending

    const deltas = ctx.emit.mock.calls
      .filter((call) => call[0] === 'session:item-delta')
      .map(
        (call) =>
          call[1] as { target: { messageId: string; ownerToolUseId: string }; chunk: string }
      )
    expect(deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            messageId: 'root-message',
            ownerToolUseId: 'outer-owner'
          }),
          chunk: 'root'
        }),
        expect.objectContaining({
          target: expect.objectContaining({
            messageId: 'child-message',
            ownerToolUseId: 'outer-owner'
          }),
          chunk: 'child'
        })
      ])
    )

    const core = new SyncCore({ capacity: 20 })
    core.emit('session:created', ['dispatch', { cwd: '/fixture', engineId: 'claude' }])
    const before = core.getSnapshot().seq
    for (const [channel, payload] of ctx.emit.mock.calls) {
      if (channel === 'session:item-open') core.emit(channel, ['dispatch', payload])
      if (channel === 'session:item-delta') core.emit(channel, ['dispatch', payload])
      if (channel === 'session:item-seal') core.emit(channel, ['dispatch', payload])
    }
    const session = core.getCanonicalState().sessions.dispatch
    expect(Object.keys(session.itemStreams)).toHaveLength(0)
    expect(session.subagentMessages['outer-owner'].map((message) => message.content[0])).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'root' },
        { type: 'text', text: 'child' }
      ])
    )
    const reliableItemEvents = ctx.emit.mock.calls.filter(
      ([channel]) => channel === 'session:item-open' || channel === 'session:item-seal'
    ).length
    expect(core.getSnapshot().seq - before).toBe(reliableItemEvents)
  })

  /**
   * An idle self-resume of a background agent INSIDE the target (Patch E):
   * its stream events carry `agent_id` and no `parent_tool_use_id`, while its
   * snapshots arrive under the agent's ORIGIN Agent call. Before the fix they
   * opened on the target's ROOT lane — the agent's `message_start` finished
   * the root message in flight, whose later deltas then streamed into the
   * agent's message.
   */
  it("routes an agent_id-only frame to its agent's origin lane, and drops one no task_started placed", async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'outer-owner' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-agent-id' } as SDKMessage)
    const frame = (agentId: string | undefined, event: Record<string, unknown>): SDKMessage =>
      ({
        type: 'stream_event',
        ...(agentId ? { agent_id: agentId } : {}),
        event
      }) as unknown as SDKMessage
    const textStart = { type: 'content_block_start', index: 0, content_block: { type: 'text' } }
    const text = (t: string): Record<string, unknown> => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: t }
    })

    // The agent's first run: the origin, then a SendMessage run of it.
    target.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-x',
      tool_use_id: 'native-origin'
    } as SDKMessage)
    target.push({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-x',
      tool_use_id: 'native-run-2'
    } as SDKMessage)
    target.push(frame(undefined, { type: 'message_start', message: { id: 'root-message' } }))
    target.push(frame(undefined, textStart))
    target.push(frame(undefined, text('root ')))
    target.push(frame('agent-x', { type: 'message_start', message: { id: 'agent-message' } }))
    target.push(frame('agent-x', textStart))
    target.push(frame('agent-x', text('agent')))
    target.push(frame('agent-unknown', { type: 'message_start', message: { id: 'lost-message' } }))
    target.push(frame('agent-unknown', textStart))
    target.push(frame('agent-unknown', text('lost')))
    target.push(frame(undefined, text('continues')))
    // The relay parents the agent's snapshot to the origin: same lane as its partials.
    target.push({
      type: 'assistant',
      parent_tool_use_id: 'native-origin',
      message: {
        id: 'agent-message',
        role: 'assistant',
        content: [{ type: 'text', text: 'agent' }]
      }
    } as unknown as SDKMessage)
    await tick()
    target.push(resultMsg({ result: 'done' }))
    await pending

    const chunksByMessage = new Map<string, string>()
    for (const [channel, payload] of ctx.emit.mock.calls) {
      if (channel !== 'session:item-delta') continue
      const { target: t, chunk } = payload as { target: { messageId: string }; chunk: string }
      chunksByMessage.set(t.messageId, (chunksByMessage.get(t.messageId) ?? '') + chunk)
    }
    expect(Object.fromEntries(chunksByMessage)).toEqual({
      'root-message': 'root continues',
      'agent-message': 'agent'
    })
    // The unplaceable agent reaches nothing, the root included.
    expect(JSON.stringify(ctx.emit.mock.calls)).not.toContain('lost-message')
    // The snapshot found the partials' state instead of arriving as a stray message.
    expect(
      ctx.emit.mock.calls.filter(
        ([channel, payload]) =>
          channel === 'session:subagent-message' &&
          (payload as { message: { id: string } }).message.id === 'agent-message'
      )
    ).toEqual([])
  })

  /**
   * A SendMessage-resumed run INSIDE the target (ADR-073 §1): cli.js re-emits
   * `task_started` for the same task_id under the SendMessage call's id, the
   * run's stream events carry that id as `parent_tool_use_id`, and its
   * completed snapshots carry the ORIGIN's. Before the fix the two used
   * different lane keys: the snapshot missed the partials' state and fell back
   * to a plain `session:subagent-message`, and the partial lane sealed alone.
   */
  it("places a SendMessage-resumed run's partials and snapshot on one lane, the origin's", async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'outer-owner' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-run-2' } as SDKMessage)
    const frame = (parent: string, event: Record<string, unknown>): SDKMessage =>
      ({ type: 'stream_event', parent_tool_use_id: parent, event }) as unknown as SDKMessage
    const started = (toolUseId: string): SDKMessage =>
      ({
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-r',
        tool_use_id: toolUseId
      }) as SDKMessage

    target.push(started('native-origin'))
    target.push(started('native-sendmessage'))
    target.push(
      frame('native-sendmessage', { type: 'message_start', message: { id: 'run2-message' } })
    )
    target.push(
      frame('native-sendmessage', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    )
    target.push(
      frame('native-sendmessage', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'resumed ' }
      })
    )
    // The relay parents the run's snapshot to the ORIGIN, mid-stream.
    target.push({
      type: 'assistant',
      parent_tool_use_id: 'native-origin',
      message: {
        id: 'run2-message',
        role: 'assistant',
        content: [{ type: 'text', text: 'resumed ' }]
      }
    } as unknown as SDKMessage)
    target.push(
      frame('native-sendmessage', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'work' }
      })
    )
    target.push(frame('native-sendmessage', { type: 'content_block_stop', index: 0 }))
    target.push(frame('native-sendmessage', { type: 'message_stop' }))
    await tick()
    target.push(resultMsg({ result: 'done' }))
    await pending

    // One item stream for the run's message, fed every delta.
    const opens = ctx.emit.mock.calls.filter(
      ([channel, payload]) =>
        channel === 'session:item-open' &&
        (payload as { target: { messageId: string } }).target.messageId === 'run2-message'
    )
    expect(opens).toHaveLength(1)
    const chunks = ctx.emit.mock.calls
      .filter(([channel]) => channel === 'session:item-delta')
      .map(([, payload]) => payload as { target: { messageId: string }; chunk: string })
      .filter((d) => d.target.messageId === 'run2-message')
      .map((d) => d.chunk)
    expect(chunks.join('')).toBe('resumed work')
    // The snapshot found the partials' state instead of arriving as a stray message.
    expect(
      ctx.emit.mock.calls.filter(
        ([channel, payload]) =>
          channel === 'session:subagent-message' &&
          (payload as { message: { id: string } }).message.id === 'run2-message'
      )
    ).toEqual([])
  })

  it('toolUseId set: forwards stream_event deltas + assistant messages + heartbeat progress + a final "completed" notification', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      heartbeatMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_disp_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)

    target.push({
      type: 'stream_event',
      event: { type: 'message_start', message: { id: 'm1', content: [] } }
    } as unknown as SDKMessage)
    target.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    } as unknown as SDKMessage)
    target.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }
    } as unknown as SDKMessage)
    await tick()
    target.push({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
    } as unknown as SDKMessage)
    await tick()

    // Let at least one heartbeat tick fire.
    await new Promise((r) => setTimeout(r, 30))

    target.push(resultMsg({ result: 'final answer' }))
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(ctx.emit).toHaveBeenCalledWith('session:item-delta', {
      target: expect.objectContaining({ ownerToolUseId: 'toolu_disp_1', kind: 'text' }),
      chunk: 'Hello'
    })

    const progressCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-progress')
    expect(progressCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      toolName: 'dispatch_agent',
      parentToolUseId: null
    })

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({
      taskId: 'claude-sess-1',
      toolUseId: 'toolu_disp_1',
      status: 'completed',
      summary: 'final answer'
    })
  })

  it('toolUseId ABSENT: zero subagent/task emits, dispatch still succeeds', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      heartbeatMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'opencode' }) // no toolUseId
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }
    } as unknown as SDKMessage)
    await new Promise((r) => setTimeout(r, 30))
    target.push(resultMsg({ result: 'ok' }))
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(
      ctx.emit.mock.calls.filter((c) => RELEVANT_SUBAGENT_CHANNELS.includes(c[0]))
    ).toHaveLength(0)
  })

  it('stopDispatch aborts the target, emits a "stopped" notification, and the in-flight dispatch resolves isError', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_stop_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    expect(dispatcher.stopDispatch('toolu_stop_1')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(target.lastAbortController()?.signal.aborted).toBe(true)

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_stop_1', status: 'stopped' })
  })

  it('stopDispatch returns false for an unknown toolUseId', async () => {
    const { dispatcher } = makeHarness()
    expect(dispatcher.stopDispatch('no-such-tool-use-id')).toBe(false)
  })

  it('stopDispatch with the WRONG routingId returns false and leaves the dispatch running (ownership check)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_owned_1'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    // Another session (e.g. a remote client) tries to stop a dispatch it
    // doesn't own — must be refused, and the turn must be undisturbed.
    expect(dispatcher.stopDispatch('toolu_owned_1', 'routing-intruder')).toBe(false)
    expect(target.lastAbortController()?.signal.aborted).toBe(false)

    // The dispatch keeps running to normal completion.
    target.push(resultMsg({ result: 'finished normally' }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('finished normally')
  })

  it('stopDispatch with the CORRECT routingId stops the dispatch (ownership match path)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_owned_2'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    await tick()

    expect(dispatcher.stopDispatch('toolu_owned_2', 'routing-owner')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
  })

  it('Stop DURING spawnClaudeQuery: handle registered before any await; dispatch still ends stopped', async () => {
    // Live-reproduced race: TaskCard's Stop is clickable the moment the tool
    // part shows "running", potentially seconds before the target finishes
    // spawning. The handle must be in activeByToolUseId from dispatch entry —
    // a stop landing mid-spawn takes effect the moment the race starts (the
    // pre-resolved `signal.aborted` race arm).
    const target = makeFakeClaudeTarget()
    let releaseSpawn!: () => void
    const spawnGate = new Promise<void>((r) => {
      releaseSpawn = r
    })
    const delayedSpawn: SpawnClaudeQueryFn = async (opts) => {
      await spawnGate
      return target.spawnClaudeQuery(opts)
    }
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: delayedSpawn
    })
    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_spawn_stop'
    })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()

    // Still inside the (gated) spawn — the Stop handle must already exist.
    expect(dispatcher.stopDispatch('toolu_spawn_stop', 'routing-owner')).toBe(true)

    releaseSpawn()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_spawn_stop', status: 'stopped' })
  })

  it('a timeout notification uses status "failed" (distinct from an explicit user stop)', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_timeout_1' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await advance(70_000)
      const result = await pending
      expect(result.isError).toBe(true)

      const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
      expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_timeout_1', status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M3 — durable stop-intent (armIfUnknown): the renderer's Stop click
// can arrive BEFORE dispatch() is even invoked (opencode marks the tool part
// "running" milliseconds after ctx.ask resolves, while the MCP tools/call
// round-trip takes longer). stopDispatch(…, {armIfUnknown:true}) records the
// intent; dispatchInner consumes it at registration and aborts immediately.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — durable stop-intent (armIfUnknown)', () => {
  it('a pre-armed intent also stops a Claude-direction dispatch at start', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    expect(
      dispatcher.stopDispatch('toolu_pre_claude', 'routing-owner', { armIfUnknown: true })
    ).toBe(true)

    const ctx = makeCtx({
      fromEngine: 'opencode',
      fromRoutingId: 'routing-owner',
      toolUseId: 'toolu_pre_claude'
    })
    const result = await dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(target.lastAbortController()?.signal.aborted).toBe(true)

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_pre_claude', status: 'stopped' })
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-A — crossEngineDispatchAvailable capability helper
// ---------------------------------------------------------------------------

describe('crossEngineDispatchAvailable (ADR-030/M4-A, ADR-082)', () => {
  const setInstalled = (claude: boolean, opencode: boolean, pi: boolean, codex: boolean): void => {
    Object.assign(harnessInstalled, { claude, opencode, pi, codex })
  }
  afterEach(() => {
    setInstalled(true, true, true, false)
  })

  it("'claude' is true when ANY of its three targets is installed, false when none is (slice H)", () => {
    setInstalled(true, true, false, false)
    expect(crossEngineDispatchAvailable('claude')).toBe(true)
    setInstalled(true, false, false, false)
    expect(crossEngineDispatchAvailable('claude')).toBe(false)

    // pi alone is enough — M4c made pi a Claude target but left this branch
    // asking only about opencode, so a pi-only machine hid the tool.
    setInstalled(true, false, true, false)
    expect(crossEngineDispatchAvailable('claude')).toBe(true)

    // codex alone is enough (slice H).
    setInstalled(true, false, false, true)
    expect(crossEngineDispatchAvailable('claude')).toBe(true)
  })

  it("'opencode' is no longer unconditionally true: Claude Code can resolve to nothing (ADR-082)", () => {
    setInstalled(true, false, false, false)
    expect(crossEngineDispatchAvailable('opencode')).toBe(true)
    setInstalled(false, false, false, false)
    expect(crossEngineDispatchAvailable('opencode')).toBe(false)
    // Any other target is enough while Claude Code is unavailable.
    setInstalled(false, false, true, false)
    expect(crossEngineDispatchAvailable('opencode')).toBe(true)
    setInstalled(false, false, false, true)
    expect(crossEngineDispatchAvailable('opencode')).toBe(true)
    // opencode itself is not a target of opencode (the same-engine guard).
    setInstalled(false, true, false, false)
    expect(crossEngineDispatchAvailable('opencode')).toBe(false)
  })

  it("'pi' asks about its targets, not about pi itself", () => {
    setInstalled(true, false, false, false)
    expect(crossEngineDispatchAvailable('pi')).toBe(true)
    setInstalled(false, false, true, false)
    expect(crossEngineDispatchAvailable('pi')).toBe(false)
    setInstalled(false, true, true, false)
    expect(crossEngineDispatchAvailable('pi')).toBe(true)
  })

  it("'codex' counts Codex itself as a target (ADR-069 §7), and Claude Code no longer by default", () => {
    setInstalled(false, false, false, false)
    expect(crossEngineDispatchAvailable('codex')).toBe(false)
    setInstalled(true, false, false, false)
    expect(crossEngineDispatchAvailable('codex')).toBe(true)
    // codex → codex is one more thread on the caller's host.
    setInstalled(false, false, false, true)
    expect(crossEngineDispatchAvailable('codex')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Codex as a dispatch SOURCE (slice E) — the engine guard, not the transport.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — Codex-sourced dispatches', () => {
  it('runs codex→codex — ADR-069 §7 lifted the same-engine guard for this engine alone', async () => {
    // It was never a policy: a same-engine dispatch used to mean a SECOND
    // app-server per dispatch. A target is one more `thread/start` on the
    // caller's own host now, so the refusal has nothing left to protect — and
    // it still stands for every other engine, which pays a whole server or CLI
    // and has a native subagent of its own.
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'codex', fromRoutingId: 'routing-codex' })
    )
    await tick()
    target.completeTurn({ text: 'target answer' })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
  })

  it.each(['claude', 'opencode', 'pi'] as const)(
    'still refuses %s→%s as same-engine work',
    async (engine) => {
      const { dispatcher } = makeHarness()
      const result = await dispatcher.dispatch(
        { engine, prompt: 'x' },
        makeCtx({ fromEngine: engine })
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('targets a different engine')
      expect(result.text).toContain(`"${engine}"`)
    }
  )

  it('no longer refuses a dispatch INTO codex as unimplemented — slice H gave it a target factory', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.completeTurn({ text: 'target answer' })
    const result = await pending
    expect(result.text).not.toBe('Dispatching into engine "codex" is not supported yet.')
    expect(result.isError).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-B — usage capture + attribution
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — M4-B usage capture (Claude direction)', () => {
  it('captures usage/total_cost_usd/duration_ms from the result on success', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_usage_1' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({
        result: 'the answer',
        total_cost_usd: 0.03,
        duration_ms: 4200,
        usage: { input_tokens: 200, output_tokens: 80 }
      })
    )
    const result = await pending
    expect(result.isError).toBeUndefined()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    const usage = (
      notif![1] as { usage?: { totalTokens: number; toolUses: number; durationMs: number } }
    ).usage
    expect(usage!.totalTokens).toBe(280)
    expect(usage!.durationMs).toBe(4200)

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRoutingId: 'routing-1',
        origin: 'dispatch',
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        sessionId: 'claude-sess-1',
        messageId: expect.stringContaining('toolu_claude_usage_1'),
        engineCostUsd: 0.03,
        // cli.js reports an API-equivalent whatever the plan (ADR-034).
        engineCostIsEquivalent: true
      })
    )
    // Slice C — the dispatching session's own cost breakdown gets the fold-in.
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('claude', 'haiku', 0.03)
  })

  it('does NOT call ctx.addDispatchedCost for a timed-out Claude-direction turn', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-sess-timeout'
      } as SDKMessage)
      await advance(70_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('turn 2+ converts the CUMULATIVE total_cost_usd into a per-turn delta (record, fold-in, cap)', async () => {
    // VERIFIED WIRE FACT: result.total_cost_usd is cumulative within one
    // cli.js process. Two turns reporting 0.02 then 0.05 (a running total)
    // spent 0.02 and 0.03 respectively — the pre-fix code recorded/folded/
    // capped 0.02 and 0.05 (over-counting turn 2 by the whole turn-1 spend).
    const recordUsageEvent = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      // maxCostUsd 0.06 discriminates: true per-turn accumulation is
      // 0.02 + 0.03 = 0.05 < 0.06 (turn 3 allowed); the buggy cumulative
      // `+=` reaches 0.02 + 0.05 = 0.07 ≥ 0.06 (turn 3 cap-rejected).
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.06 } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })

    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first', total_cost_usd: 0.02 }))
    expect((await first).sessionId).toBe('claude-sess-1')

    const second = dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'second', total_cost_usd: 0.05 }))
    expect((await second).isError).toBeUndefined()

    // DB rows: per-turn deltas, never the running total.
    expect(recordUsageEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ engineCostUsd: 0.02 })
    )
    expect(recordUsageEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ engineCostUsd: expect.closeTo(0.03, 10) })
    )

    // Live fold-in: same deltas.
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(1, 'claude', 'haiku', 0.02)
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      2,
      'claude',
      'haiku',
      expect.closeTo(0.03, 10)
    )

    // Cap accumulation: 0.05 total → still under the 0.06 cap, turn 3 allowed.
    const third = dispatcher.dispatch(
      { engine: 'claude', prompt: 'three', sessionId: 'claude-sess-1' },
      ctx
    )
    await tick()
    target.push(resultMsg({ result: 'third', total_cost_usd: 0.05 }))
    const thirdResult = await third
    expect(thirdResult.isError).toBeUndefined()
    expect(thirdResult.text).toBe('third')
    // An UNCHANGED cumulative total (turn 3 cost the same process nothing
    // new) is a zero delta — the row records costUsd 0 and there is no
    // fold-in (the >0 guard).
    expect(recordUsageEvent).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ engineCostUsd: 0 })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledTimes(2)
  })

  it('a failed-subtype turn with real cost folds in too — parity with its DB record (seed-on-reload includes it)', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['max turns'], total_cost_usd: 0.04 })
    )
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ engineCostUsd: 0.04 }))
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('claude', 'haiku', 0.04)
  })

  it('a failed-subtype turn counts toward the cost cap — the cap is a spend limit, not a success limit (ADR-034)', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    // The turn FAILED but burned 0.05 of real spend — meeting the cap.
    target.push(
      resultMsg({ subtype: 'error_max_turns', errors: ['max turns'], total_cost_usd: 0.05 })
    )
    const firstResult = await first
    expect(firstResult.isError).toBe(true)

    // Pre-fix, failed-turn spend was invisible to the cap and this
    // continuation ran; now it must be rejected before spawning a turn.
    const second = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: 'claude-sess-1' },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('counts DISTINCT tool_use ids — the same assistant message re-forwarded as partial updates does not double-count', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_tools' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    // includePartialMessages: the SAME assistant message (same betaMessage id,
    // same tool_use id) arrives repeatedly as partial updates. Push it twice —
    // it must count as ONE tool use, not two.
    const assistantMsg = {
      type: 'assistant',
      message: {
        id: 'm1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'done' }
        ]
      }
    } as unknown as SDKMessage
    target.push(assistantMsg)
    await tick()
    target.push(assistantMsg)
    await tick()
    target.push(resultMsg({ result: 'done' }))
    await pending

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    const usage = (notif![1] as { usage?: { toolUses: number } }).usage
    expect(usage!.toolUses).toBe(1)
  })

  it('a throwing recordUsageEvent NEVER fails the dispatch (Claude direction)', async () => {
    const recordUsageEvent = vi.fn(() => {
      throw new Error('disk I/O error')
    })
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_throw' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the successful answer', total_cost_usd: 0.01 }))
    const result = await pending

    expect(recordUsageEvent).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the successful answer')
  })

  it('a stopped turn is NOT recorded; a timed-out turn IS recorded with null usage', async () => {
    vi.useFakeTimers()
    try {
      const recordUsageEvent = vi.fn()
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        spawnClaudeQuery: target.spawnClaudeQuery,
        recordUsageEvent
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_timeout' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await advance(70_000)
      const result = await pending
      expect(result.isError).toBe(true)

      expect(recordUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: expect.stringContaining('toolu_claude_timeout'),
          tokens: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
          engineCostUsd: null
        })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-033 M4-C — per-dispatch cost cap
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ADR-071 §2 — the cap counts what a turn was WORTH, not what opencode billed.
// opencode prices from a catalog that is zeroed for a provider signed in with
// OAuth, so a subscription-authenticated target used to report `info.cost: 0`
// on every turn and the cap never tripped at all.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — M4-C cost cap (Claude direction)', () => {
  it('a continuation turn is rejected once cumulative cost meets the cap; target survives', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const first = dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'first answer', total_cost_usd: 0.05 }))
    const firstResult = await first
    expect(firstResult.isError).toBeUndefined()

    const second = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(second.sessionId).toBe(firstResult.sessionId)
    // Rejected before spawning a second turn on the iterator.
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('a completing turn that crosses the cap appends the warning note to the returned text', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku', maxCostUsd: 0.05 } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the answer', total_cost_usd: 0.06 }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('the answer')
    expect(result.text).toContain('[dispatch cost cap reached')
  })

  it('no cap configured → unlimited, no note ever appended regardless of cost', async () => {
    const target = makeFakeClaudeTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
      spawnClaudeQuery: target.spawnClaudeQuery
    })
    const ctx = makeCtx({ fromEngine: 'opencode' })
    const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
    await tick()
    target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
    target.push(resultMsg({ result: 'the answer', total_cost_usd: 999 }))
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('the answer')
  })
})

// ---------------------------------------------------------------------------
// pi direction (ADR-033 M4c — Claude/opencode → pi)
// ---------------------------------------------------------------------------

/** Loose shape covering exactly what the dispatcher calls on a pi target's client. */
interface FakePiClient {
  request: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

type PiRequestHandler = (
  cmd: Record<string, unknown>
) => Record<string, unknown> | Promise<Record<string, unknown>>

/** Canned responses for the fixed RPC sequence createPiTarget/drivePiTurn issue. */
function defaultPiRequestHandler(sessionId: string): PiRequestHandler {
  return (cmd) => {
    switch (cmd.type) {
      case 'get_state':
        return {
          type: 'response',
          command: 'get_state',
          success: true,
          data: {
            sessionId,
            model: { id: 'gpt-5.6-luna', provider: 'openai-codex' },
            isStreaming: false
          }
        }
      case 'set_model':
        return { type: 'response', command: 'set_model', success: true, data: {} }
      case 'prompt':
        return { type: 'response', command: 'prompt', success: true }
      case 'get_last_assistant_text':
        return {
          type: 'response',
          command: 'get_last_assistant_text',
          success: true,
          data: { text: 'target answer' }
        }
      case 'abort':
        return { type: 'response', command: 'abort', success: true }
      default:
        return { type: 'response', command: String(cmd.type), success: true }
    }
  }
}

/**
 * Fake headless pi target: a fake PiRpcClient (request/onEvent/onExit/dispose)
 * + a fake PiBridgeHost (dispose only). `pushEvent` feeds the SAME onEvent
 * callback the dispatcher registers in createPiTarget (mapPiEvent runs for
 * REAL — only the process/transport is faked, mirroring the Claude fake's
 * "real event-mapper logic, fake iterator" precedent). `gateHandler()` exposes
 * the per-target approval-gate closure the dispatcher builds and hands to
 * spawnPiTarget, for driving/asserting the two-stage gate directly.
 */
function makeFakePiTarget(
  overrides: { sessionId?: string; requestHandler?: PiRequestHandler } = {}
): {
  spawnPiTarget: SpawnPiTargetFn
  spawnCalls: PiTargetSpawnOpts[]
  client: FakePiClient
  bridgeDispose: ReturnType<typeof vi.fn>
  pushEvent: (ev: Record<string, unknown>) => void
  triggerExit: () => void
  gateHandler: () => PiBridgeHandler
} {
  const sessionId = overrides.sessionId ?? 'pi-target-1'
  const handler = overrides.requestHandler ?? defaultPiRequestHandler(sessionId)
  const eventHandlers: Array<(ev: Record<string, unknown>) => void> = []
  const exitHandlers: Array<() => void> = []
  let capturedGateHandler: PiBridgeHandler | undefined

  const client: FakePiClient = {
    request: vi.fn(async (cmd: Record<string, unknown>) => handler(cmd)),
    send: vi.fn(),
    onEvent: vi.fn((cb: (ev: Record<string, unknown>) => void) => {
      eventHandlers.push(cb)
      return () => {}
    }),
    onExit: vi.fn((cb: () => void) => {
      exitHandlers.push(cb)
      return () => {}
    }),
    dispose: vi.fn()
  }
  const bridgeDispose = vi.fn()

  const spawnCalls: PiTargetSpawnOpts[] = []
  const spawnPiTarget = vi.fn<SpawnPiTargetFn>(async (opts) => {
    spawnCalls.push(opts)
    capturedGateHandler = opts.gateHandler
    const primitives: PiTargetPrimitives = {
      client: client as unknown as PiRpcClient,
      bridgeHost: { dispose: bridgeDispose } as unknown as PiBridgeHost
    }
    return primitives
  })

  return {
    spawnPiTarget,
    spawnCalls,
    client,
    bridgeDispose,
    pushEvent: (ev) => {
      for (const cb of eventHandlers) cb(ev)
    },
    triggerExit: () => {
      for (const cb of exitHandlers) cb()
    },
    gateHandler: () => {
      if (!capturedGateHandler) {
        throw new Error(
          'gateHandler not captured yet — spawnPiTarget must resolve first (await tick())'
        )
      }
      return capturedGateHandler
    }
  }
}

/** A pi `message_end` (role: assistant) event — text and/or a tool_use block, plus usage/cost. */
function piAssistantMessageEnd(opts: {
  text?: string
  toolUse?: { id: string; name: string; input: Record<string, unknown> }
  cost?: number
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}): Record<string, unknown> {
  const content: Record<string, unknown>[] = []
  if (opts.text !== undefined) content.push({ type: 'text', text: opts.text })
  if (opts.toolUse) {
    content.push({
      type: 'toolCall',
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      arguments: opts.toolUse.input
    })
  }
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content,
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usage: {
        input: opts.input ?? 10,
        output: opts.output ?? 5,
        cacheRead: opts.cacheRead ?? 0,
        cacheWrite: opts.cacheWrite ?? 0,
        ...(opts.reasoning !== undefined ? { reasoning: opts.reasoning } : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.cost ?? 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    }
  }
}

/** A pi `message_end` (role: toolResult) event. */
function piToolResultEnd(
  toolCallId: string,
  text: string,
  isError = false
): Record<string, unknown> {
  return {
    type: 'message_end',
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError,
      timestamp: Date.now()
    }
  }
}

const PI_AGENT_SETTLED = { type: 'agent_settled' }

describe('CrossEngineDispatcher — pi direction (M4c): target lifecycle', () => {
  it('happy path: spawns, captures session_id EAGERLY via get_state, sets model, drives the turn, returns get_last_assistant_text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'review this' },
      makeCtx({ fromEngine: 'claude', autonomyMode: 'acceptEdits' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'hello', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)

    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toBe('target answer')
    expect(result.sessionId).toBe('pi-target-1')

    expect(target.spawnCalls).toHaveLength(1)
    expect(target.spawnCalls[0].cwd).toBe('/tmp/xeng-project')

    const setModelCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
    )
    expect(setModelCall?.[0]).toMatchObject({ provider: 'openai-codex', modelId: 'gpt-5.6-luna' })
  })

  it('rejects a same-engine (pi → pi) dispatch as isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({ spawnPiTarget: target.spawnPiTarget })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'pi' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('different engine')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('continuation: session_id reuses the SAME target (no second spawn, no second set_model)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first
    expect(firstResult.sessionId).toBe('pi-target-1')

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'second' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second

    expect(secondResult.isError).toBeUndefined()
    expect(secondResult.sessionId).toBe('pi-target-1')
    expect(target.spawnCalls).toHaveLength(1)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
      )
    ).toHaveLength(1)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'prompt'
      )
    ).toHaveLength(2)
  })

  it('continuation with an unknown sessionId → isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', sessionId: 'no-such-pi-session' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no-such-pi-session')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it("continuation with another session's target → isError (scoped to fromRoutingId)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const first = dispatcher.dispatch(
      { engine: 'pi', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first

    const stolen = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-B' })
    )
    expect(stolen.isError).toBe(true)
  })

  it('busy target: a concurrent same-session_id dispatch is REJECTED without disturbing the running turn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await first).sessionId).toBe('pi-target-1')

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()

    const third = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'three', sessionId: 'pi-target-1' },
      ctx
    )
    expect(third.isError).toBe(true)
    expect(third.text).toContain('already running')
    expect(target.spawnCalls).toHaveLength(1)

    target.pushEvent(piAssistantMessageEnd({ text: 'second' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): model resolution', () => {
  it('no default configured and no model requested → isError naming engines/pi.json, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({})),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('engines/pi.json')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('allowlist violation → isError, no spawn', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { allowedModels: ['openai-codex/gpt-5.6-luna'] }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', model: 'anthropic/claude-evil' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('allowlist')
    expect(target.spawnCalls).toHaveLength(0)
  })

  it('a requested model present in allowedModels is decoded via engineMeta and used for set_model', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { allowedModels: ['openai-codex/gpt-5.6-luna', 'anthropic/claude-x'] }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x', model: 'anthropic/claude-x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'ok' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    const setModelCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'set_model'
    )
    expect(setModelCall?.[0]).toMatchObject({ provider: 'anthropic', modelId: 'claude-x' })
  })

  it('a failed set_model → isError naming the failure; the half-built target is torn down (client + bridgeHost disposed)', async () => {
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'set_model') {
          return {
            type: 'response',
            command: 'set_model',
            success: false,
            error: 'Model not found: bogus/nope'
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'bogus/nope' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Model not found')
    expect(target.client.dispose).toHaveBeenCalled()
    expect(target.bridgeDispose).toHaveBeenCalled()
  })

  it('a get_state with no session id reported → isError; the half-built target is torn down', async () => {
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_state')
          return { type: 'response', command: 'get_state', success: true, data: {} }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(target.client.dispose).toHaveBeenCalled()
    expect(target.bridgeDispose).toHaveBeenCalled()
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): autonomy / two-stage approval gate', () => {
  // ADR-088: an auto parent's pi target is JUDGED (see the ADR-088 block
  // below); only with pi's own judge switched off does auto keep the
  // historical allow-all base.
  it("T8: 'auto' with pi's autoMode.enabled false auto-allows a mutating tool with NO forwarded approval and no judge call", async () => {
    const target = makeFakePiTarget()
    const makeJudgeTransport = vi.fn()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' },
        autoMode: { enabled: false }
      })),
      spawnPiTarget: target.spawnPiTarget,
      makeJudgeTransport
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'auto' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
    expect(makeJudgeTransport).not.toHaveBeenCalled()

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'default' autonomy auto-allows a read-only tool (mode-base) with NO forwarded approval", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'read',
      input: { path: 'a.txt' }
    })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'acceptEdits' matches agent-control paths against the target's cwd — an edit inside a .claude/worktrees checkout is not one", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'acceptEdits',
      cwd: '/repo/.claude/worktrees/feat'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'edit',
      input: { path: '/repo/.claude/worktrees/feat/src/a.ts' }
    })
    expect(decision).toEqual({ behavior: 'allow' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'default' autonomy ASKS for a mutating tool — forwards an xeng:-prefixed approval keyed by the pi tool call's OWN id (not ctx.toolUseId)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_dispatch_1'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    await tick()

    const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
    expect(call).toBeTruthy()
    const approval = call![1] as {
      requestId: string
      toolName: string
      toolUseId?: string
      input: Record<string, unknown>
    }
    expect(approval.requestId.startsWith(XENG_REQUEST_PREFIX)).toBe(true)
    expect(approval.toolName).toBe('bash')
    // The PI TOOL CALL's own id — NOT ctx.toolUseId ('toolu_dispatch_1') — see
    // gatePiTargetToolCall's doc comment on why (FloatingApproval matching).
    expect(approval.toolUseId).toBe('pi-call-1')
    expect(approval.input).toEqual({ command: 'rm -rf x' })

    const sentinel = Symbol('pending')
    expect(await Promise.race([decisionPromise, Promise.resolve(sentinel)])).toBe(sentinel)

    const consumed = dispatcher.resolveApproval(approval.requestId, 'allow')
    expect(consumed).toBe(true)
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("resolveApproval('deny') resolves the gate with deny + model-visible feedback", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'deny', { feedback: 'too dangerous' })
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'too dangerous' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("resolveApproval(deny) without feedback → 'User denied'", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'deny')
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'User denied' })

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it("'allowForSession' behaves identically to a one-off 'allow' — a pi dispatch target never persists a per-tool escalation (unlike PiSession's own interactive sessionAllows)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'default' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'allowForSession')
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    // A SECOND identical bash call still asks — no escalation was remembered.
    const secondDecisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-2',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const secondApproval = ctx.emit.mock.calls
      .filter((c) => c[0] === 'session:approval-request')
      .at(-1)![1] as { requestId: string }
    expect(secondApproval.requestId).not.toBe(approval.requestId)
    dispatcher.resolveApproval(secondApproval.requestId, 'allow')
    await secondDecisionPromise

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it('T10: the gate reads the parent’s mode LIVE — default → auto: the next edit is judged and allowed, no human', async () => {
    const target = makeFakePiTarget()
    const judge = makeScriptedJudge()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' },
        autoMode: { twoStageMode: 'fast' as const }
      })),
      spawnPiTarget: target.spawnPiTarget,
      makeJudgeTransport: judge.make
    })
    let mode = 'default'
    const ctx = makeCtx({ fromEngine: 'claude', getAutonomyMode: () => mode })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    void target.gateHandler()({
      toolCallId: 'pi-edit-1',
      toolName: 'edit',
      input: { path: 'src/a.ts' }
    })
    await tick()
    expect(ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-request')).toHaveLength(1)

    mode = 'auto'
    // Under the judged auto base (acceptEdits) a plain edit is allowed outright;
    // a bash command asks and is judged.
    expect(
      await target.gateHandler()({
        toolCallId: 'pi-edit-2',
        toolName: 'edit',
        input: { path: 'src/b.ts' }
      })
    ).toEqual({ behavior: 'allow' })
    expect(
      await target.gateHandler()({
        toolCallId: 'pi-bash-1',
        toolName: 'bash',
        input: { command: 'rm -rf build' }
      })
    ).toEqual({ behavior: 'allow' })
    expect(judge.requests).toHaveLength(1)
    expect(ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-request')).toHaveLength(1)

    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })

  it('T10: created under auto, switched to default — the next bash asks the human with zero judge calls', async () => {
    const target = makeFakePiTarget()
    const judge = makeScriptedJudge()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' },
        autoMode: { twoStageMode: 'fast' as const }
      })),
      spawnPiTarget: target.spawnPiTarget,
      makeJudgeTransport: judge.make
    })
    let mode = 'auto'
    const ctx = makeCtx({ fromEngine: 'claude', getAutonomyMode: () => mode })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    mode = 'default'
    void target.gateHandler()({
      toolCallId: 'pi-bash-1',
      toolName: 'bash',
      input: { command: 'rm -rf build' }
    })
    await tick()
    expect(ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-request')).toHaveLength(1)
    expect(judge.requests).toHaveLength(0)
    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): timeout / abort / stop (process SURVIVES — unlike Claude)', () => {
  it('stopDispatch sends the abort RPC, emits a "stopped" notification, resolves isError — the entry is KEPT ALIVE for continuation', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_stop_1')).toBe(true)

    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
    expect(result.sessionId).toBe('pi-target-1')

    const abortCall = target.client.request.mock.calls.find(
      (c: unknown[]) => (c[0] as { type?: string }).type === 'abort'
    )
    expect(abortCall).toBeTruthy()

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_stop_1', status: 'stopped' })

    // DIVERGES FROM CLAUDE: the process survives — a fresh turn on the SAME
    // session_id works with NO re-spawn.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const contResult = await cont
    expect(contResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })

  it("a late 'ask' arriving after stop has already reported — the entry is draining — is denied immediately with NO approval registered/emitted (see PiTargetEntry.draining's doc comment; the bug this closes: an orphaned approval card no manual action could otherwise clear)", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_draining_1'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_draining_1')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    // The ABANDONED turn's own tool_call hook fires its 'ask' only now — the
    // realistic late-arrival case (pi's abort→tool_call latency is what the
    // grace period bounds, but nothing stops it landing even after the grace
    // period itself has elapsed and resolveAndRunPi has already returned).
    const decision = await target.gateHandler()({
      toolCallId: 'pi-call-late',
      toolName: 'bash',
      input: { command: 'rm -rf x' }
    })
    expect(decision).toEqual({ behavior: 'deny', reason: 'Dispatch stopped' })
    // No approval-request was ever emitted for it — never registered as a
    // pending approval in the first place (not merely dismissed after the fact).
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
  })

  it('a NEW continuation turn after the stop clears draining — gate asks flow normally again', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      toolUseId: 'toolu_draining_2'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_draining_2')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)

    // Fresh continuation on the surviving process — drivePiTurn clears draining.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-after-cont',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')?.[1] as
      { requestId: string } | undefined
    expect(approval).toBeTruthy()
    dispatcher.resolveApproval(approval!.requestId, 'allow')
    expect(await decisionPromise).toEqual({ behavior: 'allow' })

    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await cont).isError).toBeUndefined()
  })

  it('the configured absolute cap interrupts the turn (status "failed", recorded) — the entry is ALSO kept alive for continuation', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20,
        spawnPiTarget: target.spawnPiTarget
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_1' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()
      await advance(70_000)
      // The give-up path's own bounded grace wait (piAbortSettleGraceMs) runs
      // AFTER the cap fires, so the clock has to keep moving past it.
      await advance(1_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')
      expect(result.text).toContain('1 minutes')

      const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
      expect(notif?.[1]).toMatchObject({ toolUseId: 'toolu_timeout_1', status: 'failed' })

      const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
      await settle()
      target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
      target.pushEvent(PI_AGENT_SETTLED)
      await settle()
      expect((await cont).isError).toBeUndefined()
      expect(target.spawnCalls).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('extra.signal abort → "cancelled" text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const abort = new AbortController()
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', extra: makeExtra({ signal: abort.signal }) })
    )
    await tick()
    abort.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('cancelled')
  })

  it('a rejected turn (extension_error) settles as isError but does NOT tear down the entry — a continuation can still be attempted', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('bridge crashed')

    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'y', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'recovered' }))
    target.pushEvent(PI_AGENT_SETTLED)
    expect((await cont).isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })

  it('an unexpected process exit settles the in-flight turn as an error AND disposes the bridge host (port/socket hygiene)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.triggerExit()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('exited unexpectedly')
    expect(target.bridgeDispose).toHaveBeenCalled()
  })

  it("a continuation attempted WHILE the post-stop grace-period drain is still in progress is busy-rejected — never corrupted by a stale settle (see PiTargetEntry.settled's RACE NOTE)", async () => {
    // pi's `abort` is turn-scoped (the process survives), so the STOPPED
    // turn's own terminal event sequence is still in flight when
    // resolveAndRunPi gives up. Without draining it before releasing `busy`,
    // a fast-enough continuation could install a new settle wrapper while
    // the stale one is still pending delivery — pi's wire has no per-event
    // turn correlation to tell them apart on arrival. Proves the mechanism
    // directly: `busy` stays true for the WHOLE grace window, so a
    // continuation attempted inside it is busy-rejected exactly like an
    // ordinary concurrent-turn attempt, never silently corrupted.
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      piAbortSettleGraceMs: 200 // generous enough to reliably land a call inside the window
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_race_1' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_race_1')).toBe(true)
    // `first` is now inside its grace-period wait — nothing settles it
    // naturally in this test, so it resolves once the 200ms grace elapses.

    const duringGrace = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'too soon', sessionId: 'pi-target-1' },
      ctx
    )
    expect(duringGrace.isError).toBe(true)
    expect(duringGrace.text).toContain('already running')

    const firstResult = await first
    expect(firstResult.isError).toBe(true)
    expect(firstResult.text).toContain('stopped')

    // NOW a continuation is safe — entry.settled was drained by the grace wait.
    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'genuine answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1) // still the same process throughout
  })

  it('the post-stop grace-period drain is bounded — resolves on its own if the target never settles (does not hang forever)', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      piAbortSettleGraceMs: 20
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_grace_timeout' })
    )
    await tick()
    expect(dispatcher.stopDispatch('toolu_grace_timeout')).toBe(true)
    // Never push any event — the grace period must still resolve on its own.
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')
  })

  it('a stale settle arriving DURING the grace-period drain resolves the ORIGINAL (stopped) call harmlessly — a subsequent continuation still gets a clean slate', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
      // piAbortSettleGraceMs: 20 (harness default) — plenty of time for a
      // synchronously-pushed event to land within the window.
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_race_2' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    expect(dispatcher.stopDispatch('toolu_race_2')).toBe(true)
    await tick() // let the grace-period wait actually start

    // The stopped turn's own delayed terminal sequence arrives WHILE the
    // grace-period wait is in progress (the realistic case — pi's real
    // abort→agent_settled latency is single-digit ms, verified during the
    // M4c kickoff investigation).
    target.pushEvent(piAssistantMessageEnd({ text: 'stale, from the stopped turn' }))
    target.pushEvent(PI_AGENT_SETTLED)

    const firstResult = await first
    expect(firstResult.isError).toBe(true)
    expect(firstResult.text).toContain('stopped') // the ORIGINAL outcome, unaffected

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'genuine turn two answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const secondResult = await second
    expect(secondResult.isError).toBeUndefined()
    expect(target.spawnCalls).toHaveLength(1)
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): streaming, usage, notification', () => {
  it('forwards item lifecycle/message/tool-result with the exact payload shapes; the final notification carries usage', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      heartbeatMs: 20,
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_disp_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    target.pushEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })
    // pi 0.84+ `message_update`: deltas only — no cumulative `message` field.
    target.pushEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' }
    })
    await tick()

    target.pushEvent(piToolResultEnd('pi-call-1', 'ls output'))
    await tick()

    target.pushEvent(
      piAssistantMessageEnd({
        toolUse: { id: 'pi-call-1', name: 'bash', input: { command: 'ls' } },
        text: 'Hello',
        cost: 0.02,
        input: 100,
        output: 50,
        reasoning: 5
      })
    )
    await new Promise((r) => setTimeout(r, 30)) // let at least one heartbeat tick fire
    target.pushEvent(PI_AGENT_SETTLED)

    const result = await pending
    expect(result.isError).toBeUndefined()

    const openCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:item-open')
    expect(openCall?.[1]).toMatchObject({
      target: { ownerToolUseId: 'toolu_disp_1', blockIndex: 0, kind: 'text' }
    })
    const deltaCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:item-delta')
    expect(deltaCall?.[1]).toMatchObject({
      target: { ownerToolUseId: 'toolu_disp_1', blockIndex: 0, kind: 'text' },
      chunk: 'Hello'
    })

    const sealCalls = ctx.emit.mock.calls.filter((c) => c[0] === 'session:item-seal')
    expect(sealCalls.length).toBeGreaterThan(0)
    const lastSeal = sealCalls.at(-1)![1] as {
      ownerToolUseId: string
      message: { content: unknown[] }
    }
    expect(lastSeal.ownerToolUseId).toBe('toolu_disp_1')
    expect(lastSeal.message.content).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', toolUseId: 'pi-call-1', toolName: 'bash', toolInput: { command: 'ls' } }
    ])

    const toolResultCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:subagent-tool-result')
    expect(toolResultCall?.[1]).toEqual({
      toolUseId: 'toolu_disp_1',
      toolResultToolUseId: 'pi-call-1',
      result: 'ls output',
      isError: false
    })

    const progressCall = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-progress')
    expect(progressCall?.[1]).toMatchObject({
      toolUseId: 'toolu_disp_1',
      toolName: 'dispatch_agent',
      parentToolUseId: null
    })

    const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
    expect(notif?.[1]).toMatchObject({
      taskId: 'pi-target-1',
      toolUseId: 'toolu_disp_1',
      status: 'completed'
    })
    const usage = (
      notif![1] as { usage?: { totalTokens: number; toolUses: number; durationMs: number } }
    ).usage
    expect(usage).toBeTruthy()
    expect(usage!.totalTokens).toBe(155) // 100 + 50 + 5(reasoning)
    expect(usage!.toolUses).toBe(1)
    expect(usage!.durationMs).toEqual(expect.any(Number))
  })

  it('toolUseId ABSENT: zero subagent/task emits, dispatch still succeeds', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' }) // no toolUseId
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'hi' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(
      ctx.emit.mock.calls.filter((c) => RELEVANT_SUBAGENT_CHANNELS.includes(c[0]))
    ).toHaveLength(0)
  })

  it('captures cost/tokens and records a dispatched-usage row on success; folds cost into ctx.addDispatchedCost', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_usage_1' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'ok', cost: 0.02, input: 100, output: 50 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRoutingId: 'routing-1',
        origin: 'dispatch',
        engineId: 'pi',
        vendorId: 'openai-codex',
        modelId: 'gpt-5.6-luna',
        sessionId: 'pi-target-1',
        messageId: expect.stringContaining('toolu_usage_1'),
        engineCostUsd: 0.02
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.02)
  })

  it('does NOT call ctx.addDispatchedCost when turn cost is zero', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // No cost AND no tokens: our table stands in for a turn pi priced at 0
    // (`piCostInputs`), so a turn that is to cost nothing has to spend nothing.
    target.pushEvent(piAssistantMessageEnd({ text: 'ok', cost: 0, input: 0, output: 0 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('turn 2+ converts the CUMULATIVE mapper totalCostUsd into a per-turn delta (result.totalCostUsd is cumulative — same hazard as Claude)', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude' })

    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await first

    const second = dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    await tick()
    // Mapper state's totalCostUsd is CUMULATIVE (0.02 + 0.03 = 0.05) — the
    // per-turn delta must be ~0.03, not the raw 0.05.
    target.pushEvent(piAssistantMessageEnd({ text: 'second', cost: 0.03 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await second

    expect(recordUsageEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ engineCostUsd: 0.02 })
    )
    expect(recordUsageEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ engineCostUsd: expect.closeTo(0.03, 10) })
    )
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      1,
      'pi',
      'openai-codex/gpt-5.6-luna',
      0.02
    )
    expect(ctx.addDispatchedCost).toHaveBeenNthCalledWith(
      2,
      'pi',
      'openai-codex/gpt-5.6-luna',
      expect.closeTo(0.03, 10)
    )
  })

  it('a throwing recordUsageEvent NEVER fails the dispatch', async () => {
    const recordUsageEvent = vi.fn(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the successful answer' }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(recordUsageEvent).toHaveBeenCalled()
    expect(result.isError).toBeUndefined()
  })

  it('a timed-out turn IS recorded (status "failed") with unknown tokens and a known-zero cost; a stopped turn is NOT recorded', async () => {
    vi.useFakeTimers()
    try {
      const recordUsageEvent = vi.fn()
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20,
        spawnPiTarget: target.spawnPiTarget,
        recordUsageEvent
      })
      const pending = dispatcher.dispatch(
        { engine: 'pi', prompt: 'x' },
        makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_record' })
      )
      await settle()
      await advance(70_000)
      await advance(1_000)
      const result = await pending
      expect(result.isError).toBe(true)
      // Tokens are unknown (nothing streamed back), but the cost is a KNOWN
      // zero: pi prices from its own catalog and its cumulative total — after
      // the get_session_stats reconcile — did not move, so the turn spent
      // nothing (ADR-071 §2; `null` in this column means unknown, not free).
      expect(recordUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: expect.stringContaining('toolu_timeout_record'),
          tokens: { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 },
          engineCostUsd: 0
        })
      )

      recordUsageEvent.mockClear()
      const target2 = makeFakePiTarget({ sessionId: 'pi-target-2' })
      const { dispatcher: dispatcher2 } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' }
        })),
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20,
        spawnPiTarget: target2.spawnPiTarget,
        recordUsageEvent
      })
      const pending2 = dispatcher2.dispatch(
        { engine: 'pi', prompt: 'x' },
        makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stopped_norecord' })
      )
      await settle()
      expect(dispatcher2.stopDispatch('toolu_stopped_norecord')).toBe(true)
      await advance(30)
      await pending2
      expect(recordUsageEvent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): non-success turn cost accounting (B1)', () => {
  it('an errored turn that streamed cost still advances cumulativeCostUsd/addDispatchedCost and records the spend+tokens on the usage row; a later successful turn does NOT double-count it', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // Streams real usage/cost BEFORE the extension errors out — the turn
    // burned real spend even though it never reached agent_settled.
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.stringContaining('toolu_err_cost'),
        engineCostUsd: 0.04,
        tokens: expect.objectContaining({ input: 100, output: 40 })
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)

    // KEY REGRESSION ASSERTION: cumulativeCostUsd/lastReportedTotalCostUsd
    // were advanced by the FAILED turn's 0.04 — a continuation that streams
    // only 0.02 MORE (mapper totalCostUsd: 0.04+0.02=0.06 cumulative) must
    // report a per-turn delta of ~0.02, NOT the raw 0.06 (which is what a
    // never-advanced baseline would produce, double-counting the failed
    // turn's spend into this turn's row) — and crossing the 0.05 cap this
    // way (0.04 already spent + 0.02 now = 0.06) proves cumulativeCostUsd
    // itself carried the failed turn's spend forward too.
    const cont = dispatcher.dispatch({ engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'second', cost: 0.02 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const contResult = await cont
    expect(contResult.isError).toBeUndefined()
    expect(contResult.text).toContain('[dispatch cost cap reached')
    expect(recordUsageEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ engineCostUsd: expect.closeTo(0.02, 10) })
    )
    expect(ctx.addDispatchedCost).toHaveBeenLastCalledWith(
      'pi',
      'openai-codex/gpt-5.6-luna',
      expect.closeTo(0.02, 10)
    )
  })

  it("a rejected credential (401) is a FAILED dispatch carrying pi's message, not an empty completion", async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({ spawnPiTarget: target.spawnPiTarget })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_401' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    const errored = piAssistantMessageEnd({ text: '' })
    const msg = errored.message as Record<string, unknown>
    target.pushEvent({
      ...errored,
      message: { ...msg, stopReason: 'error', errorMessage: '401 {"type":"error"}' }
    })
    // pi's own settle after the errored turn must not turn it into a completion.
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Dispatched turn failed: 401 {"type":"error"}')
  })

  it('a timed-out turn that streamed cost still advances cumulativeCostUsd/addDispatchedCost and records the spend+tokens on the usage row', async () => {
    vi.useFakeTimers()
    try {
      const recordUsageEvent = vi.fn()
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', turnTimeoutMs: 60_000 }
        })),
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20,
        spawnPiTarget: target.spawnPiTarget,
        recordUsageEvent
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_cost' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()
      target.pushEvent(
        piAssistantMessageEnd({ text: 'partial', cost: 0.03, input: 20, output: 10 })
      )
      // Never push agent_settled — the turn hangs until the cap fires.
      await advance(70_000)
      await advance(1_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')

      expect(recordUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: expect.stringContaining('toolu_timeout_cost'),
          engineCostUsd: 0.03,
          tokens: expect.objectContaining({ input: 20, output: 10 })
        })
      )
      expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.03)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stopped turn that streamed cost advances cumulativeCostUsd/addDispatchedCost but records NO usage row (ADR-033 M4-B: no usage numbers for a turn that never returned) — cap accounting still applies', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.05 }))
    expect(dispatcher.stopDispatch('toolu_stop_cost')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('stopped')

    // No usage ROW for the stopped turn (row ≠ spend accounting — see the
    // resolveAndRunPi comment)...
    expect(recordUsageEvent).not.toHaveBeenCalled()
    // ...but the fold-in and cap accounting still ran: proven directly via
    // addDispatchedCost, and via a fresh continuation now being rejected
    // outright (cumulativeCostUsd already meets the 0.05 cap).
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.05)
    const cont = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: 'pi-target-1' },
      ctx
    )
    expect(cont.isError).toBe(true)
    expect(cont.text).toContain('cost cap')
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): err/timeout cost reconciliation via get_session_stats (audit-residual C)', () => {
  it('an errored turn whose fake get_session_stats reports MORE cost than any streamed usage event → the recovered (higher) cost is what is counted toward the cap + usage row', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.1,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_reconcile' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // The event stream only ever saw 0.04 before the extension errored out —
    // but pi's OWN backend (get_session_stats) recorded 0.10, spend the
    // mapper never surfaced as a cost-bearing message_end.
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.stringContaining('toolu_err_reconcile'),
        engineCostUsd: 0.1
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.1)
  })

  it('a get_session_stats read that FAILS during error-path reconciliation falls back to the mapperState delta (no throw, error result still returned)', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') throw new Error('target wedged')
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_reconcile_fail' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.stringContaining('toolu_err_reconcile_fail'),
        engineCostUsd: 0.04
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)
  })

  it('a timed-out turn whose fake get_session_stats reports MORE cost than any streamed usage event is reconciled too', async () => {
    // FAKE TIMERS FIRST, before the dispatcher is constructed: its `now` dep
    // defaults to a captured reference to `Date.now`, so installing the fake
    // clock afterwards would leave the watchdog reading real wall time and the
    // configured cap would never fire.
    vi.useFakeTimers()
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.08,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', turnTimeoutMs: 60_000 }
      })),
      heartbeatMs: 30_000,
      piAbortSettleGraceMs: 20,
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_reconcile' })
    try {
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()
      target.pushEvent(
        piAssistantMessageEnd({ text: 'partial', cost: 0.03, input: 20, output: 10 })
      )
      // Never push agent_settled — the turn hangs until the cap fires.
      await advance(70_000)
      await advance(1_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')

      expect(recordUsageEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: expect.stringContaining('toolu_timeout_reconcile'),
          engineCostUsd: 0.08
        })
      )
      expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.08)
    } finally {
      vi.useRealTimers()
    }
  })

  it('when get_session_stats reports the SAME cost as the mapper already streamed, the recorded spend is unchanged (no double count)', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget({
      requestHandler: (cmd) => {
        if (cmd.type === 'get_session_stats') {
          return {
            type: 'response',
            command: 'get_session_stats',
            success: true,
            data: {
              cost: 0.04,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
            }
          }
        }
        return defaultPiRequestHandler('pi-target-1')(cmd)
      }
    })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_err_same_cost' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.04, input: 100, output: 40 }))
    target.pushEvent({
      type: 'extension_error',
      extensionPath: 'x.ts',
      event: 'tool_call',
      error: 'bridge crashed'
    })
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: expect.stringContaining('toolu_err_same_cost'),
        engineCostUsd: 0.04
      })
    )
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', 'openai-codex/gpt-5.6-luna', 0.04)
  })

  it('a STOPPED turn never calls get_session_stats (reconciliation is err/timeout-only — stop stays unreconciled by design, ADR-033 M4-B) and still records no usage row', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_no_reconcile' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'partial', cost: 0.02 }))
    expect(dispatcher.stopDispatch('toolu_stop_no_reconcile')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)

    expect(recordUsageEvent).not.toHaveBeenCalled()
    expect(
      target.client.request.mock.calls.some(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'get_session_stats'
      )
    ).toBe(false)
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): cost cap (ADR-033 M4-C)', () => {
  it('a continuation turn is rejected once cumulative cost meets the cap; target survives; no second prompt is sent', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const first = dispatcher.dispatch({ engine: 'pi', prompt: 'one' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'first', cost: 0.05 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const firstResult = await first
    expect(firstResult.isError).toBeUndefined()

    const second = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('cost cap')
    expect(second.sessionId).toBe(firstResult.sessionId)
    expect(
      target.client.request.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type?: string }).type === 'prompt'
      )
    ).toHaveLength(1)
  })

  it('a completing turn that crosses the cap appends the warning note to the returned text', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', maxCostUsd: 0.05 }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 0.06 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('[dispatch cost cap reached')
  })

  it('no cap configured → unlimited, no note ever appended regardless of cost', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 999 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).not.toContain('cost cap reached')
  })
})

describe('CrossEngineDispatcher — pi direction: the cap follows the same cost rule (ADR-071 §2)', () => {
  const MODEL = 'openai-codex/gpt-5.6-luna'
  let billingSpy: ReturnType<typeof vi.spyOn> | undefined

  afterEach(() => {
    billingSpy?.mockRestore()
    billingSpy = undefined
  })

  it('a free vendor spends nothing, whatever pi reports', async () => {
    billingSpy = vi.spyOn(piAuthProvider, 'buildPiAccountRef').mockReturnValue({
      engineId: 'pi',
      vendorId: 'openai-codex',
      billingType: 'free',
      authState: 'authenticated'
    })
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      recordUsageEvent,
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: MODEL, maxCostUsd: 0.01 } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 0.5 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.text).not.toContain('cost cap')
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
    // pi's own figure rides along raw; what makes the turn free is the
    // BILLING TYPE, which is the whole point of recording it per row.
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ engineCostUsd: 0.5, billingType: 'free' })
    )
  })

  it('a NON-FINITE figure from pi on an UNPRICED model says the cap cannot count it', async () => {
    // pi's own catalog prices every turn whatever the credential, so its
    // figure is a list-price equivalent under every billing type and a
    // reported `0` is a known zero, not an unpriced turn. What is left is a
    // malformed `usage.cost.total`, which the mapper's `+=` turns into NaN —
    // and with no price of our own for the model either, there is nothing left
    // to count: resolveCosts refuses rather than adding a garbage number.
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({
        dispatch: { defaultModel: 'openai/model-with-no-price', maxCostUsd: 0.01 }
      })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: Number.NaN }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.text).toContain('[dispatch cost cap cannot count this turn')
    expect(result.text).not.toContain('[dispatch cost cap reached')
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('a NON-FINITE figure on a model WE price falls back to our table rather than going uncountable', async () => {
    // The turn's tokens reach the cost rule now (they always did for a pi
    // SESSION's own messages), so pi failing to price a turn is no longer the
    // end of it: `piCostInputs` reaches for our table whenever pi reported no
    // real charge, and here it has one.
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: MODEL, maxCostUsd: 0.01 } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // 1M input tokens at $0.20/MTok — over the $0.01 cap on its own.
    target.pushEvent(
      piAssistantMessageEnd({ text: 'the answer', cost: Number.NaN, input: 1_000_000, output: 0 })
    )
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.text).not.toContain('[dispatch cost cap cannot count this turn')
    expect(result.text).toContain('[dispatch cost cap reached')
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', MODEL, expect.closeTo(0.2, 6))
  })

  it('a turn pi reports as 0 is a known zero under `unknown` billing, not an unpriced turn', async () => {
    // No credential for the vendor → billing type `unknown`. pi priced the
    // turn; it just cost nothing (a stop before any spend, say).
    billingSpy = vi.spyOn(piAuthProvider, 'buildPiAccountRef').mockReturnValue(null)
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: MODEL, maxCostUsd: 0.01 } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // Zero tokens with it, so the table cannot price the turn ABOVE pi's zero
    // and what is under test stays pi's figure (`piCostInputs`).
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 0, input: 0, output: 0 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.text).not.toContain('cost cap')
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it("a subscription turn counts pi's own figure — it is already a list-price equivalent", async () => {
    billingSpy = vi.spyOn(piAuthProvider, 'buildPiAccountRef').mockReturnValue({
      engineId: 'pi',
      vendorId: 'openai-codex',
      billingType: 'subscription',
      authState: 'authenticated'
    })
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: MODEL, maxCostUsd: 0.05 } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    target.pushEvent(piAssistantMessageEnd({ text: 'the answer', cost: 0.06 }))
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.text).toContain('[dispatch cost cap reached')
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', MODEL, 0.06)
  })

  it('a dispatch with NO caller tool_use still accounts its tokens — on the row and against the cap', async () => {
    // Accounting rides the same forwarding path that streams a target's
    // output back to a caller's TaskCard, and streaming needs a tool_use id
    // to key its chunks. Tokens do not: an id-less dispatch must still price
    // its turn, or the cap would read it as a free one and the ledger row
    // would record a zero split.

    // The billing type is pinned so the turn's WORTH is what the cap reads: under a subscription
    // a reported `0` cannot be mistaken for a zero charge (`resolveCosts`),
    // which leaves the accumulated tokens as the only thing that can cross it.
    billingSpy = vi.spyOn(piAuthProvider, 'buildPiAccountRef').mockReturnValue({
      engineId: 'pi',
      vendorId: 'openai-codex',
      billingType: 'subscription',
      authState: 'authenticated'
    })
    const recordUsageEvent = vi.fn()
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      recordUsageEvent,
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: MODEL, maxCostUsd: 0.01 } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    expect(ctx.toolUseId).toBeUndefined()
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // Two assistant messages, so the row proves the ACCUMULATION and not just
    // the last message's numbers. 1M input tokens at $0.20/MTok is over the
    // $0.01 cap on its own (the 100 output tokens add $0.00012); pi prices the
    // turn at 0, so the cap only crosses if our own table priced the tokens it
    // was handed.
    target.pushEvent(
      piAssistantMessageEnd({ text: 'part one', cost: 0, input: 600_000, output: 30 })
    )
    // A fresh `message_start` is what lets the mapper see a SECOND assistant
    // message in the same turn (a tool call splits one turn into several).
    target.pushEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })
    target.pushEvent(
      piAssistantMessageEnd({ text: 'part two', cost: 0, input: 400_000, output: 70 })
    )
    target.pushEvent(PI_AGENT_SETTLED)
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.text).toContain('[dispatch cost cap reached')
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('pi', MODEL, expect.closeTo(0.20012, 6))
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: expect.objectContaining({ input: 1_000_000, output: 100 })
      })
    )
  })
})

describe('CrossEngineDispatcher — pi direction (M4c): disposeFor', () => {
  it('tears down: client.dispose() + bridgeHost.dispose(); the dead continuation errors; other routings are untouched', async () => {
    const targetA = makeFakePiTarget({ sessionId: 'pi-sess-A' })
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: targetA.spawnPiTarget
    })
    const first = dispatcher.dispatch(
      { engine: 'pi', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    await tick()
    targetA.pushEvent(piAssistantMessageEnd({ text: 'first' }))
    targetA.pushEvent(PI_AGENT_SETTLED)
    await first

    dispatcher.disposeFor('routing-A')

    expect(targetA.client.dispose).toHaveBeenCalled()
    expect(targetA.bridgeDispose).toHaveBeenCalled()

    const cont = await dispatcher.dispatch(
      { engine: 'pi', prompt: 'again', sessionId: 'pi-sess-A' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-A' })
    )
    expect(cont.isError).toBe(true)
  })

  it('dismisses pending forwarded approvals for the disposed target', async () => {
    const target = makeFakePiTarget()
    const { dispatcher } = makeHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({
      fromEngine: 'claude',
      autonomyMode: 'default',
      fromRoutingId: 'routing-owner'
    })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()

    const decisionPromise = target.gateHandler()({
      toolCallId: 'pi-call-1',
      toolName: 'bash',
      input: { command: 'x' }
    })
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)

    dispatcher.disposeFor('routing-owner')
    const dismiss = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-dismiss')
    expect(dismiss).toBeTruthy()
    expect(await decisionPromise).toEqual({ behavior: 'deny', reason: 'User denied' })

    // Clean up the still-in-flight turn so no heartbeat timer leaks past this test.
    target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending
  })
})

describe('buildPiTargetChildEnv (ADR-033 M4c — recursion guard)', () => {
  it("explicitly overrides CLAUDEUI_PI_HOSTED_TOOLS/DISPATCH_ENABLED/SKILL_DIRS to empty string — never mere omission, since PiRpcClient spawns with {...process.env, ...opts.env} and would otherwise leak the parent shell's own flags through", () => {
    const env = buildPiTargetChildEnv({ url: 'http://127.0.0.1:54321', token: 'test-token' })
    expect(env.CLAUDEUI_PI_HOSTED_TOOLS).toBe('')
    expect(env.CLAUDEUI_PI_DISPATCH_ENABLED).toBe('')
    // S4: nor the dispatch description the bridge would register it with.
    expect(env.CLAUDEUI_PI_DISPATCH_DESCRIPTION).toBe('')
    expect(env.CLAUDEUI_PI_SKILL_DIRS).toBe('')
    // ADR-089: a dispatch target never gets the `agent` tool either.
    expect(env.CLAUDEUI_PI_AGENT_TOOL).toBe('')
    // ADR-089 S3b: nor `send_message`.
    expect(env.CLAUDEUI_PI_SEND_MESSAGE).toBe('')
    expect(env.CLAUDEUI_PI_BRIDGE_URL).toBe('http://127.0.0.1:54321')
    expect(env.CLAUDEUI_PI_BRIDGE_TOKEN).toBe('test-token')
    // Exactly these eight keys — nothing else sneaks in either.
    expect(Object.keys(env).sort()).toEqual([
      'CLAUDEUI_PI_AGENT_TOOL',
      'CLAUDEUI_PI_BRIDGE_TOKEN',
      'CLAUDEUI_PI_BRIDGE_URL',
      'CLAUDEUI_PI_DISPATCH_DESCRIPTION',
      'CLAUDEUI_PI_DISPATCH_ENABLED',
      'CLAUDEUI_PI_HOSTED_TOOLS',
      'CLAUDEUI_PI_SEND_MESSAGE',
      'CLAUDEUI_PI_SKILL_DIRS'
    ])
  })

  it('the empty-string override survives a parent-env spread — {...process.env, ...opts.env} would otherwise let a dev-shell CLAUDEUI_PI_HOSTED_TOOLS=1 leak through', () => {
    // Mirrors PiRpcClient's actual spawn-env merge order (opts.env spread
    // LAST, so it wins) without needing to mock PiRpcClient itself.
    const parentEnv = { CLAUDEUI_PI_HOSTED_TOOLS: '1', CLAUDEUI_PI_DISPATCH_ENABLED: '1' }
    const merged = {
      ...parentEnv,
      ...buildPiTargetChildEnv({ url: 'http://127.0.0.1:1', token: 't' })
    }
    expect(merged.CLAUDEUI_PI_HOSTED_TOOLS).toBe('')
    expect(merged.CLAUDEUI_PI_DISPATCH_ENABLED).toBe('')
  })
})

// ---------------------------------------------------------------------------
// codex direction (ADR-033 slice H — claude/opencode/pi → codex)
// ---------------------------------------------------------------------------

/**
 * Loose shape covering exactly what the dispatcher calls on a Codex target's
 * HOST CONNECTION (ADR-069 §7 — a target is a thread, not a process).
 */
interface FakeCodexClient {
  request: ReturnType<typeof vi.fn>
  abortServerRequests: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
}

type CodexRequestHandler = (
  method: string,
  params: Record<string, unknown>
) => unknown | Promise<unknown>

const CODEX_THREAD_ID = 'codex-thread-1'
const CODEX_TURN_ID = 'codex-turn-1'

/** One `agentMessage` ThreadItem — a turn's result text. */
function codexAgentMessage(text: string, id = 'item-msg-1'): Record<string, unknown> {
  return {
    type: 'agentMessage',
    id,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null
  }
}

/** One `commandExecution` ThreadItem. */
function codexCommandItem(
  command: string,
  opts: { id?: string; status?: string; output?: string; exitCode?: number | null } = {}
): Record<string, unknown> {
  return {
    type: 'commandExecution',
    id: opts.id ?? 'item-cmd-1',
    pluginId: null,
    scriptPath: null,
    command,
    cwd: '/tmp/xeng-project',
    processId: null,
    source: 'shell',
    status: opts.status ?? 'inProgress',
    commandActions: [],
    aggregatedOutput: opts.output ?? null,
    exitCode: opts.exitCode ?? null,
    durationMs: null
  }
}

/** One `fileChange` ThreadItem. */
function codexFileChangeItem(
  path: string,
  opts: { id?: string; kind?: Record<string, unknown>; status?: string } = {}
): Record<string, unknown> {
  return {
    type: 'fileChange',
    id: opts.id ?? 'item-patch-1',
    changes: [{ path, kind: opts.kind ?? { type: 'add' }, diff: 'hello\n' }],
    status: opts.status ?? 'inProgress'
  }
}

function codexUsage(over: Partial<Record<string, number>> = {}): Record<string, number> {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    ...over
  }
}

/**
 * Fake Codex dispatch target: a fake host CONNECTION (request/
 * abortServerRequests/claim/detach) whose canned responses cover the fixed
 * `config/read` → `model/list` → `thread/start` → `turn/start` sequence
 * `createCodexTarget`/`driveCodexTurn` issue.
 *
 * `notify()` feeds the SAME onNotification callback the dispatcher installs, so
 * `mapCodexItem`/`mapCodexDelta` and the whole item/dedupe/settle pipeline run
 * FOR REAL — only the host and its wire are faked (mirrors the pi fake's "real
 * event-mapper logic, fake transport" precedent). `serverRequest()` drives the
 * approval gate the same way the real app-server would; unlike the real host it
 * does NOT demultiplex, so what the gate itself refuses stays visible here.
 */
function makeFakeCodexTarget(
  overrides: {
    threadId?: string
    turnId?: string
    configModel?: string
    catalog?: Array<Record<string, unknown>>
    requestHandler?: CodexRequestHandler
  } = {}
): {
  spawnCodexTarget: AttachCodexTargetFn
  spawnCalls: CodexTargetAttachOpts[]
  client: FakeCodexClient
  requests: Array<{ method: string; params: Record<string, unknown> }>
  notify: (method: string, params: Record<string, unknown>) => void
  serverRequest: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<unknown>
  disconnect: (code?: string) => void
  currentTurnId: () => string
  completeTurn: (opts?: {
    text?: string
    status?: string
    error?: { message: string }
    turnId?: string
    items?: Array<Record<string, unknown>>
    durationMs?: number
  }) => void
  threadStartParams: () => Record<string, unknown>
} {
  const threadId = overrides.threadId ?? CODEX_THREAD_ID
  const turnId = overrides.turnId ?? CODEX_TURN_ID
  // Real, PRICED catalog ids (shared/pricing.ts's openai table) so the cost
  // arithmetic under test is the arithmetic that runs in production.
  const catalog = overrides.catalog ?? [
    {
      model: 'gpt-5.6-luna',
      isDefault: true,
      supportedReasoningEfforts: [],
      inputModalities: ['text']
    },
    { model: 'gpt-5.6-terra', isDefault: false, supportedReasoningEfforts: [], inputModalities: [] }
  ]
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []
  let onNotification: ((method: string, params: unknown) => void) | undefined
  let onServerRequest: CodexTargetAttachOpts['onServerRequest'] | undefined
  let onDisconnect: ((error: { code: string }) => void) | undefined
  let serverRequestSeq = 0
  let turnSeq = 0
  let currentTurnId = turnId

  const defaultHandler: CodexRequestHandler = (method, params) => {
    switch (method) {
      case 'config/read':
        return {
          config: { model: overrides.configModel ?? 'gpt-5.6-luna', model_provider: 'openai' }
        }
      case 'model/list':
        return { data: catalog, nextCursor: null }
      case 'thread/start':
        return {
          thread: { id: threadId, parentThreadId: null, forkedFromId: null },
          model: params.model,
          modelProvider: 'openai',
          reasoningEffort: null
        }
      case 'turn/start':
        // A FRESH id per turn, as the real app-server mints (UUIDv7) — the
        // dispatcher retires a turn by id, so a fake that reused one would be
        // testing a state the binary cannot produce.
        turnSeq += 1
        currentTurnId = turnSeq === 1 ? turnId : `${turnId}-${turnSeq}`
        return {
          turn: {
            id: currentTurnId,
            items: [],
            itemsView: 'complete',
            status: 'inProgress',
            error: null,
            startedAt: null,
            completedAt: null,
            durationMs: null
          }
        }
      case 'turn/interrupt':
        return {}
      default:
        return {}
    }
  }
  const handler = overrides.requestHandler ?? defaultHandler

  const client: FakeCodexClient = {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params })
      return await handler(method, params ?? {})
    }),
    abortServerRequests: vi.fn(),
    claim: vi.fn(),
    // Detaching does NOT kill anything: the host lives on for the other
    // sessions and reads using it (ADR-069 §2).
    detach: vi.fn()
  }

  const spawnCalls: CodexTargetAttachOpts[] = []
  const spawnCodexTarget = vi.fn<AttachCodexTargetFn>(async (opts) => {
    spawnCalls.push(opts)
    onNotification = opts.onNotification
    onServerRequest = opts.onServerRequest
    onDisconnect = opts.onDisconnect as unknown as (error: { code: string }) => void
    return client as unknown as Awaited<ReturnType<AttachCodexTargetFn>>
  })

  const notify = (method: string, params: Record<string, unknown>): void => {
    onNotification?.(method, params)
  }

  return {
    spawnCodexTarget,
    spawnCalls,
    client,
    requests,
    notify,
    serverRequest: (method, params, signal) =>
      onServerRequest!(method, params, {
        id: `srv-${++serverRequestSeq}`,
        signal: signal ?? new AbortController().signal
      }) as Promise<unknown>,
    disconnect: (code = 'process-exited') => onDisconnect?.({ code }),
    currentTurnId: () => currentTurnId,
    completeTurn: (opts = {}) => {
      const items = opts.items ?? [codexAgentMessage(opts.text ?? 'target answer')]
      notify('turn/completed', {
        threadId,
        turn: {
          id: opts.turnId ?? currentTurnId,
          items,
          itemsView: 'complete',
          status: opts.status ?? 'completed',
          error: opts.error ?? null,
          startedAt: null,
          completedAt: null,
          durationMs: opts.durationMs ?? 1234
        }
      })
    },
    threadStartParams: () => requests.find((entry) => entry.method === 'thread/start')?.params ?? {}
  }
}

/**
 * A codex-flavoured harness. The shared `makeHarness` default config carries an
 * OPENCODE model id (`openai/gpt-5`), which a Codex target would take as its
 * requested model and correctly refuse as absent from the native catalog — so
 * every codex test names its own dispatch config rather than inheriting that.
 * Empty by default: `selectCodexModel` then falls back to the target's own
 * `config/read` model, which is the ordinary no-config-needed path.
 */
function makeCodexHarness(
  overrides: Partial<DispatcherDeps> & { dispatch?: Record<string, unknown> } = {}
): { dispatcher: CrossEngineDispatcher } {
  const { dispatch, ...rest } = overrides
  return makeHarness({
    loadEngineConfig: vi.fn(() => ({ dispatch: dispatch ?? {} }) as EngineConfig),
    ...rest
  })
}

describe('CrossEngineDispatcher — codex direction (slice H): the policy envelope', () => {
  it.each([
    ['plan', 'untrusted', 'read-only', 'user'],
    ['default', 'untrusted', 'workspace-write', 'user'],
    ['acceptEdits', 'untrusted', 'workspace-write', 'user'],
    ['auto', 'on-request', 'workspace-write', 'auto_review']
  ])(
    "autonomy '%s' opens the thread with approvalPolicy '%s', sandbox '%s', reviewer '%s' — on thread/start, and again on every turn/start (ADR-088)",
    async (mode, approvalPolicy, sandbox, approvalsReviewer) => {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
      const pending = dispatcher.dispatch(
        { engine: 'codex', prompt: 'x' },
        makeCtx({ fromEngine: 'claude', autonomyMode: mode })
      )
      await tick()
      target.completeTurn()
      await pending

      expect(target.threadStartParams()).toMatchObject({
        cwd: '/tmp/xeng-project',
        approvalPolicy,
        sandbox,
        approvalsReviewer,
        allowProviderModelFallback: false,
        historyMode: 'paginated'
      })
      // ADR-088 — the per-turn request re-sends the policy for the parent's
      // LIVE mode, the same `codexTurnPolicy` CodexSession sends.
      const turnStart = target.requests.find((entry) => entry.method === 'turn/start')!
      expect(turnStart.params).toMatchObject(codexTurnPolicy(mode))
      expect(turnStart.params.approvalPolicy).toBe(approvalPolicy)
      expect(turnStart.params.approvalsReviewer).toBe(approvalsReviewer)
    }
  )

  it('inherits NO MCP servers — a headless target gets no config override (ADR-068 §5)', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, makeCtx())
    await tick()
    target.completeTurn()
    await pending

    // Same reasoning as the dynamic tools below: a dispatched agent is a
    // scrubbed, single-purpose thread. Slice 4 gave INTERACTIVE Codex sessions
    // the user's Claude MCP list; this pins that the target path was left out of
    // it, so no dispatch quietly spawns the user's MCP servers headlessly.
    expect(target.threadStartParams()).not.toHaveProperty('config')
  })

  it('offers NO dynamicTools and no item/tool/call server method — a target can neither dispatch nor run a hosted tool', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, makeCtx())
    await tick()
    target.completeTurn()
    await pending

    expect(target.threadStartParams()).not.toHaveProperty('dynamicTools')
    // The transport used to refuse `item/tool/call` for the target, because the
    // target owned the process and registered four methods on it. A target is a
    // thread on a SHARED host now (ADR-069 §7), whose registered list is the
    // union its owners need — so the scrub is the GATE's, with the same
    // `-32601` an unregistered method earns.
    await expect(
      target.serverRequest('item/tool/call', {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        callId: 'c1',
        tool: 'render_mermaid'
      })
    ).rejects.toBeInstanceOf(CodexMethodNotFound)
    await expect(
      target.serverRequest('mcpServer/elicitation/request', {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID
      })
    ).rejects.toBeInstanceOf(CodexMethodNotFound)
  })

  it('labels its host acquire as a dispatch target and claims exactly its own thread', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, makeCtx())
    await tick()
    target.completeTurn()
    await pending
    // The `clientInfo` that used to identify this target is the HOST's now: the
    // target does not start a process, so what identifies it is the acquire
    // label and the one thread it takes delivery of.
    expect(target.spawnCalls[0]!.label).toBe('dispatch-target')
    expect(target.client.claim.mock.calls).toEqual([[CODEX_THREAD_ID]])
  })

  it('T12: the parent’s LIVE mode re-policies the thread at the next turn/start, and the gate decides by it', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    let mode = 'auto'
    const ctx = makeCtx({ fromEngine: 'claude', getAutonomyMode: () => mode })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    target.completeTurn()
    const firstResult = await first

    mode = 'plan'
    const second = dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    // One thread; the second turn carries the plan policy.
    expect(target.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
    const turnStarts = target.requests.filter((entry) => entry.method === 'turn/start')
    expect(turnStarts).toHaveLength(2)
    expect(turnStarts[0].params).toMatchObject(codexTurnPolicy('auto'))
    expect(turnStarts[1].params).toMatchObject(codexTurnPolicy('plan'))
    // …and the gate decides by the mode that turn runs under: plan refuses.
    const decision = await target.serverRequest('item/commandExecution/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: target.currentTurnId(),
      itemId: 'item-cmd-1',
      command: '/bin/zsh -lc "rm -rf x"',
      cwd: '/tmp/xeng-project'
    })
    expect(decision).toEqual({ decision: 'decline' })
    target.completeTurn()
    await second
  })

  it('R2: a `full` parent runs the thread under the `auto` policy (full is normalised to auto)', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', autonomyMode: 'full' })
    )
    await tick()
    target.completeTurn()
    await pending
    expect(target.threadStartParams()).toMatchObject({ approvalsReviewer: 'auto_review' })
    const turnStart = target.requests.find((entry) => entry.method === 'turn/start')!
    expect(turnStart.params).toMatchObject(codexTurnPolicy('auto'))
  })

  it('a mid-turn switch does not move the gate before the next turn/start (the gate decides by the turn’s snapshot)', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    let mode = 'default'
    const ctx = makeCtx({ fromEngine: 'claude', getAutonomyMode: () => mode })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    // bypassPermissions' mode base would ACCEPT this command; the turn's
    // snapshot (`default`) asks — so a live-mode gate would fail this test.
    mode = 'bypassPermissions'
    const decisionPromise = target.serverRequest('item/commandExecution/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: target.currentTurnId(),
      itemId: 'item-cmd-1',
      command: '/bin/zsh -lc "rm -rf x"',
      cwd: '/tmp/xeng-project'
    })
    await tick()
    // Still the default gate: the human is asked, nothing auto-accepted.
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)
    void decisionPromise
    dispatcher.disposeFor('routing-1')
    await pending
  })
})

describe('CrossEngineDispatcher — codex direction (slice H): the gate', () => {
  async function startTarget(
    mode: string,
    overrides: Partial<DispatcherDeps> = {}
  ): Promise<{
    dispatcher: CrossEngineDispatcher
    target: ReturnType<typeof makeFakeCodexTarget>
    ctx: ReturnType<typeof makeCtx>
    pending: Promise<DispatchResult>
  }> {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      ...overrides
    })
    const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: mode, toolUseId: 'toolu_dispatch_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    return { dispatcher, target, ctx, pending }
  }

  const commandRequest = (command: string): Record<string, unknown> => ({
    threadId: CODEX_THREAD_ID,
    turnId: CODEX_TURN_ID,
    itemId: 'item-cmd-1',
    startedAtMs: 0,
    kind: 'command',
    environmentId: null,
    command,
    cwd: '/tmp/xeng-project'
  })

  it('plan mode DENIES a write outright — no approval is forwarded, nothing waits for a human the target does not have', async () => {
    const { target, ctx, pending } = await startTarget('plan')
    target.notify('item/started', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      item: codexFileChangeItem('notes.md')
    })
    const decision = await target.serverRequest('item/fileChange/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-patch-1',
      startedAtMs: 0
    })
    expect(decision).toEqual({ decision: 'decline' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
    // The denial is visible to the watching human — neither native response
    // type carries a reason.
    const denial = ctx.emit.mock.calls.find(
      (c) =>
        c[0] === 'session:subagent-message' &&
        JSON.stringify((c[1] as { message: unknown }).message).includes('denied')
    )
    expect(JSON.stringify((denial![1] as { message: unknown }).message)).toContain(
      PLAN_MODE_DENY_REASON_NO_EXIT_TOOL
    )
    target.completeTurn()
    await pending
  })

  it('plan mode DENIES a non-plan-safe command outright too', async () => {
    const { target, ctx, pending } = await startTarget('plan')
    const decision = await target.serverRequest(
      'item/commandExecution/requestApproval',
      commandRequest('/bin/zsh -lc "rm -rf /tmp/x"')
    )
    expect(decision).toEqual({ decision: 'decline' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
    target.completeTurn()
    await pending
  })

  it("default mode forwards an ASK to the CALLER's client bound to the target item's own id, and resolveApproval answers the native request", async () => {
    const { dispatcher, target, ctx, pending } = await startTarget('default')
    const decisionPromise = target.serverRequest(
      'item/commandExecution/requestApproval',
      commandRequest('/bin/zsh -lc "rm -rf x"')
    )
    await tick()

    const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
    expect(call).toBeTruthy()
    const approval = call![1] as {
      requestId: string
      toolName: string
      toolUseId?: string
      input: Record<string, unknown>
    }
    expect(approval.requestId.startsWith(XENG_REQUEST_PREFIX)).toBe(true)
    expect(approval.toolName).toBe('commandExecution')
    // The TARGET ITEM's composite id — NOT ctx.toolUseId ('toolu_dispatch_1').
    expect(approval.toolUseId).toBe(
      `codex:${JSON.stringify([CODEX_THREAD_ID, CODEX_TURN_ID, 'item-cmd-1'])}`
    )
    // The login-shell wrapper is unwrapped for gating, with the raw string kept.
    expect(approval.input).toEqual({
      command: 'rm -rf x',
      rawCommand: '/bin/zsh -lc "rm -rf x"',
      cwd: '/tmp/xeng-project'
    })

    const sentinel = Symbol('pending')
    expect(await Promise.race([decisionPromise, Promise.resolve(sentinel)])).toBe(sentinel)

    expect(dispatcher.resolveApproval(approval.requestId, 'allow')).toBe(true)
    expect(await decisionPromise).toEqual({ decision: 'accept' })
    target.completeTurn()
    await pending
  })

  it("resolveApproval('deny') declines the native request", async () => {
    const { dispatcher, target, ctx, pending } = await startTarget('default')
    const decisionPromise = target.serverRequest(
      'item/commandExecution/requestApproval',
      commandRequest('ls')
    )
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(approval.requestId, 'deny', { feedback: 'no' })
    expect(await decisionPromise).toEqual({ decision: 'decline' })
    target.completeTurn()
    await pending
  })

  it("'allowForSession' is a one-off allow — a second identical command still asks", async () => {
    const { dispatcher, target, ctx, pending } = await startTarget('default')
    const first = target.serverRequest(
      'item/commandExecution/requestApproval',
      commandRequest('ls')
    )
    await tick()
    const a1 = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.resolveApproval(a1.requestId, 'allowForSession')
    expect(await first).toEqual({ decision: 'accept' })

    const second = target.serverRequest('item/commandExecution/requestApproval', {
      ...commandRequest('ls'),
      itemId: 'item-cmd-2'
    })
    await tick()
    const a2 = ctx.emit.mock.calls
      .filter((c) => c[0] === 'session:approval-request')
      .at(-1)![1] as { requestId: string }
    expect(a2.requestId).not.toBe(a1.requestId)
    dispatcher.resolveApproval(a2.requestId, 'allow')
    await second
    target.completeTurn()
    await pending
  })

  // ADR-088 review R1: `auto` gates as `default` (the interactive
  // `CodexSession.gate()` rule) — what reaches the gate under `auto_review` is
  // what the guardian ESCALATED, and escalations belong to the human.
  it('R1: auto mode ASKS the human for what the native reviewer escalated — never a silent accept', async () => {
    const { target, ctx, pending } = await startTarget('auto')
    void target.serverRequest(
      'item/commandExecution/requestApproval',
      commandRequest('/bin/zsh -lc "rm -rf x"')
    )
    await tick()
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)
    target.completeTurn()
    await pending
  })

  it("acceptEdits allows a patch INSIDE the workspace but asks for one outside it (Codex's workspaceWrite line, not the mode base's)", async () => {
    const { dispatcher, target, ctx, pending } = await startTarget('acceptEdits')
    target.notify('item/started', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      item: codexFileChangeItem('notes.md')
    })
    expect(
      await target.serverRequest('item/fileChange/requestApproval', {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        itemId: 'item-patch-1',
        startedAtMs: 0
      })
    ).toEqual({ decision: 'accept' })

    target.notify('item/started', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      item: codexFileChangeItem('/etc/hosts', { id: 'item-patch-2' })
    })
    const outside = target.serverRequest('item/fileChange/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-patch-2',
      startedAtMs: 0
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
      input: { files: Array<{ path: string }> }
    }
    expect(approval.input.files[0]!.path).toBe('/etc/hosts')
    dispatcher.resolveApproval(approval.requestId, 'allow')
    await outside
    target.completeTurn()
    await pending
  })

  it('a fileChange request with NO known changes ASKS — never allows on no evidence', async () => {
    const { dispatcher, target, ctx, pending } = await startTarget('auto')
    const decisionPromise = target.serverRequest('item/fileChange/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-patch-unknown',
      startedAtMs: 0
    })
    await tick()
    const call = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')
    expect(call, 'a request with nothing to gate must ask even under auto').toBeTruthy()
    dispatcher.resolveApproval((call![1] as { requestId: string }).requestId, 'allow')
    await decisionPromise
    target.completeTurn()
    await pending
  })

  it('never grants a native permission profile, and never answers a user question', async () => {
    const { target, ctx, pending } = await startTarget('default')
    expect(
      await target.serverRequest('item/permissions/requestApproval', {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        itemId: 'item-perm-1'
      })
    ).toEqual({ permissions: {}, scope: 'turn' })
    expect(
      await target.serverRequest('item/tool/requestUserInput', {
        threadId: CODEX_THREAD_ID,
        turnId: CODEX_TURN_ID,
        itemId: 'item-q-1',
        questions: [{ id: 'q', question: 'which?', header: null, isSecret: false, isOther: false }]
      })
    ).toEqual({ answers: {} })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
    target.completeTurn()
    await pending
  })

  it('refuses a request raised by a native CHILD thread the target spawned', async () => {
    const { target, pending } = await startTarget('default')
    await expect(
      target.serverRequest('item/commandExecution/requestApproval', {
        ...commandRequest('ls'),
        threadId: 'some-child-thread'
      })
    ).rejects.toThrow('no live owning dispatch turn')
    target.completeTurn()
    await pending
  })
})

describe('CrossEngineDispatcher — codex direction (slice H): streaming, result, usage', () => {
  it('folds plan and thinking items, seals interrupted thinking, and rejects late completed deltas across owners', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
      const ctx1 = makeCtx({ fromEngine: 'claude', toolUseId: 'codex-owner-1' })
      const first = dispatcher.dispatch({ engine: 'codex', prompt: 'first' }, ctx1)
      await vi.advanceTimersByTimeAsync(0)
      const turn1 = target.currentTurnId()

      target.notify('item/reasoning/summaryTextDelta', {
        threadId: CODEX_THREAD_ID,
        turnId: turn1,
        itemId: 'reason-1',
        delta: 'considering'
      })
      vi.setSystemTime(1_250)
      target.notify('item/completed', {
        threadId: CODEX_THREAD_ID,
        turnId: turn1,
        item: { type: 'reasoning', id: 'reason-1', summary: ['considering'], content: [] }
      })
      target.notify('item/plan/delta', {
        threadId: CODEX_THREAD_ID,
        turnId: turn1,
        itemId: 'plan-1',
        delta: 'step one'
      })
      target.notify('item/completed', {
        threadId: CODEX_THREAD_ID,
        turnId: turn1,
        item: { type: 'plan', id: 'plan-1', text: 'step one' }
      })
      const beforeLate = ctx1.emit.mock.calls.filter(
        ([channel]) => channel === 'session:item-open'
      ).length
      target.notify('item/plan/delta', {
        threadId: CODEX_THREAD_ID,
        turnId: turn1,
        itemId: 'plan-1',
        delta: ' late'
      })
      expect(
        ctx1.emit.mock.calls.filter(([channel]) => channel === 'session:item-open').length
      ).toBe(beforeLate)
      target.completeTurn({ turnId: turn1, text: 'first done' })
      await first

      const ctx2 = makeCtx({ fromEngine: 'claude', toolUseId: 'codex-owner-2' })
      const second = dispatcher.dispatch(
        { engine: 'codex', prompt: 'second', sessionId: CODEX_THREAD_ID },
        ctx2
      )
      await vi.advanceTimersByTimeAsync(0)
      const turn2 = target.currentTurnId()
      vi.setSystemTime(2_000)
      target.notify('item/reasoning/textDelta', {
        threadId: CODEX_THREAD_ID,
        turnId: turn2,
        itemId: 'reason-2',
        delta: 'interrupted thought'
      })
      vi.setSystemTime(2_400)
      dispatcher.disposeFor(ctx2.fromRoutingId)
      await second

      const core = new SyncCore({ capacity: 40 })
      core.emit('session:created', ['codex-dispatch', { cwd: '/fixture', engineId: 'claude' }])
      for (const ctx of [ctx1, ctx2]) {
        for (const [channel, payload] of ctx.emit.mock.calls) {
          if (channel === 'session:item-open') core.emit(channel, ['codex-dispatch', payload])
          if (channel === 'session:item-delta') core.emit(channel, ['codex-dispatch', payload])
          if (channel === 'session:item-seal') core.emit(channel, ['codex-dispatch', payload])
        }
      }
      const session = core.getCanonicalState().sessions['codex-dispatch']
      expect(Object.keys(session.itemStreams)).toHaveLength(0)
      const owner1 = session.subagentMessages['codex-owner-1']
      expect(owner1.flatMap((message) => message.content)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'thinking', text: 'considering', durationMs: 250 }),
          expect.objectContaining({
            type: 'tool_use',
            toolName: 'plan',
            toolInput: { plan: 'step one' }
          })
        ])
      )
      expect(session.subagentMessages['codex-owner-2'][0].content[0]).toEqual({
        type: 'thinking',
        text: 'interrupted thought',
        durationMs: 400
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("streams items, deltas and tool results to the caller's subagent channels under ctx.toolUseId", async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_dispatch_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()

    target.notify('item/agentMessage/delta', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-msg-1',
      delta: 'Hel'
    })
    target.notify('item/started', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      item: codexCommandItem('ls')
    })
    target.notify('item/completed', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      item: codexCommandItem('ls', { status: 'completed', output: 'a.txt', exitCode: 0 })
    })
    // The raw command output is NOT streamed — same as every other direction.
    target.notify('item/commandExecution/outputDelta', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-cmd-1',
      delta: 'a.txt'
    })
    target.completeTurn({ text: 'all done' })
    const result = await pending

    const itemId = `codex:${JSON.stringify([CODEX_THREAD_ID, CODEX_TURN_ID, 'item-cmd-1'])}`
    expect(ctx.emit).toHaveBeenCalledWith('session:item-delta', {
      target: expect.objectContaining({ ownerToolUseId: 'toolu_dispatch_1', kind: 'text' }),
      chunk: 'Hel'
    })
    expect(ctx.emit).toHaveBeenCalledWith('session:subagent-tool-result', {
      toolUseId: 'toolu_dispatch_1',
      toolResultToolUseId: itemId,
      result: 'a.txt',
      isError: false
    })
    const toolUse = ctx.emit.mock.calls.find(
      (c) =>
        c[0] === 'session:subagent-message' &&
        (c[1] as { message: { content: Array<{ type: string }> } }).message.content.some(
          (b) => b.type === 'tool_use'
        )
    )
    expect(toolUse).toBeTruthy()
    // One command stream, and only ONE — the outputDelta above is skipped.
    const deltas = ctx.emit.mock.calls.filter((c) => c[0] === 'session:item-delta')
    expect(deltas).toHaveLength(1)
    expect(result.text).toBe('all done')
    expect(result.sessionId).toBe(CODEX_THREAD_ID)
  })

  it('drops notifications for a native CHILD thread — one dispatch is one card, and a grandchild has no home in it', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_dispatch_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    target.notify('item/completed', {
      threadId: 'some-child-thread',
      turnId: 'child-turn',
      item: codexAgentMessage('child chatter')
    })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:subagent-message')).toBe(false)
    target.completeTurn()
    await pending
  })

  it("records ONE usage row per turn: the thread's cumulative total minus the previous turn's baseline", async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_dispatch_1' })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      tokenUsage: {
        total: codexUsage({ totalTokens: 120, inputTokens: 100, outputTokens: 20 }),
        last: codexUsage({ totalTokens: 120 }),
        modelContextWindow: 400000
      }
    })
    target.completeTurn({ durationMs: 4242 })
    const firstResult = await first

    expect(recordUsageEvent).toHaveBeenCalledTimes(1)
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
      parentRoutingId: 'routing-1',
      origin: 'dispatch',
      engineId: 'codex',
      vendorId: 'openai',
      modelId: 'gpt-5.6-luna',
      sessionId: CODEX_THREAD_ID,
      messageId: expect.stringContaining('toolu_dispatch_1'),
      tokens: { input: 100, output: 20, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    })

    // A SECOND turn on the same thread reports the CUMULATIVE total; the row
    // must carry the delta, not the running total.
    const second = dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      tokenUsage: {
        total: codexUsage({ totalTokens: 200, inputTokens: 160, outputTokens: 40 }),
        last: codexUsage({ totalTokens: 200 }),
        modelContextWindow: 400000
      }
    })
    target.completeTurn()
    await second
    expect(recordUsageEvent.mock.calls[1]![0]).toMatchObject({
      tokens: { input: 60, output: 20, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    })
  })

  it('an unpriced model is never counted as free — nothing is folded into the session', async () => {
    const recordUsageEvent = vi.fn()
    const target = makeFakeCodexTarget({
      configModel: 'gpt-nonexistent-preview',
      catalog: [
        {
          model: 'gpt-nonexistent-preview',
          isDefault: true,
          supportedReasoningEfforts: [],
          inputModalities: []
        }
      ]
    })
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      recordUsageEvent
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_dispatch_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      tokenUsage: {
        total: codexUsage({ totalTokens: 10, inputTokens: 8, outputTokens: 2 }),
        last: codexUsage({ totalTokens: 10 }),
        modelContextWindow: null
      }
    })
    target.completeTurn()
    await pending
    // The row carries the SPLIT and no engine figure; the recorder prices it,
    // and a model with no price leaves both cost columns null (never 0).
    expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
      engineCostIsEquivalent: true,
      tokens: expect.objectContaining({ input: 8, output: 2 })
    })
    expect(recordUsageEvent.mock.calls[0]![0].engineCostUsd ?? null).toBeNull()
    expect(ctx.addDispatchedCost).not.toHaveBeenCalled()
  })

  it('a turn/completed carrying an error is an isError result plus a "failed" notification', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_dispatch_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    target.completeTurn({ status: 'failed', error: { message: 'model overloaded' }, items: [] })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('model overloaded')
    const notification = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')!
    expect((notification[1] as { status: string }).status).toBe('failed')
  })

  it('a turn that produced no agent message returns the placeholder rather than empty text', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, makeCtx())
    await tick()
    target.completeTurn({ items: [] })
    const result = await pending
    expect(result.text).toBe('(the dispatched agent returned no text)')
  })

  it('an app-server disconnect mid-turn settles the turn as an error instead of hanging it', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, makeCtx())
    await tick()
    target.disconnect('process-exited')
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toContain('process-exited')
  })
})

describe('CrossEngineDispatcher — codex direction (slice H): continuation, model, stop, dispose', () => {
  it('continuation: session_id reuses the live entry — no second thread/start, no second spawn', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    target.completeTurn({ text: 'first' })
    const firstResult = await first

    const second = dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    target.completeTurn({ text: 'second' })
    const secondResult = await second

    expect(secondResult.text).toBe('second')
    expect(target.spawnCodexTarget).toHaveBeenCalledTimes(1)
    expect(target.requests.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
    expect(target.requests.filter((entry) => entry.method === 'turn/start')).toHaveLength(2)
  })

  it('continuation with an unknown sessionId is an isError — NEVER a thread/resume of a caller-named thread', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'x', sessionId: 'someone-elses-thread' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Unknown dispatch session')
    expect(target.spawnCodexTarget).not.toHaveBeenCalled()
  })

  it("continuation with another session's target → isError (scoped to fromRoutingId)", async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const first = dispatcher.dispatch(
      { engine: 'codex', prompt: 'one' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-a' })
    )
    await tick()
    target.completeTurn()
    const firstResult = await first

    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-b' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Unknown dispatch session')
  })

  it('a busy target rejects a concurrent same-session_id dispatch without disturbing the running turn', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    target.completeTurn()
    const firstResult = await first

    const running = dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    await tick()
    const rejected = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'three', sessionId: firstResult.sessionId },
      ctx
    )
    expect(rejected.isError).toBe(true)
    expect(rejected.text).toContain('already running a turn')

    target.completeTurn({ text: 'second' })
    expect((await running).text).toBe('second')
  })

  it('refuses an explicitly requested model outside the allowlist BEFORE spawning anything', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      dispatch: { allowedModels: ['gpt-5.6-luna'] }
    })
    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'x', model: 'gpt-5.6-terra' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toBe(
      'Model "gpt-5.6-terra" is not in the user-configured allowlist for codex dispatch. ' +
        'Allowed models: gpt-5.6-luna'
    )
    expect(target.spawnCodexTarget).not.toHaveBeenCalled()
  })

  it('refuses the CONFIG-resolved default too when it falls outside the allowlist, and never opens a thread', async () => {
    const target = makeFakeCodexTarget({ configModel: 'gpt-5.6-terra' })
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      dispatch: { allowedModels: ['gpt-5.6-luna'] }
    })
    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not in the user-configured allowlist for codex dispatch')
    expect(target.requests.some((entry) => entry.method === 'thread/start')).toBe(false)
    expect(target.client.detach).toHaveBeenCalled()
  })

  it('a model the native catalog does not carry is refused by selectCodexModel', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'x', model: 'gpt-9-imaginary' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('unavailable in the native catalog')
  })

  it('a non-openai provider is refused before a thread exists', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: makeFakeCodexTarget({
        requestHandler: (method) =>
          method === 'config/read'
            ? { config: { model: 'x', model_provider: 'azure' } }
            : { data: [], nextCursor: null }
      }).spawnCodexTarget
    })
    void target
    const result = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude' })
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('only the native OpenAI provider')
  })

  it('stopDispatch interrupts the native turn, settles as stopped, and KEEPS the thread alive for continuation', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      codexAbortSettleGraceMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_1' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()

    expect(dispatcher.stopDispatch('toolu_stop_1', 'routing-1')).toBe(true)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.text).toBe('Dispatch stopped by user.')
    expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(true)
    expect(target.requests.find((e) => e.method === 'turn/interrupt')!.params).toEqual({
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID
    })
    expect(target.client.abortServerRequests).toHaveBeenCalledWith(CODEX_THREAD_ID, CODEX_TURN_ID)
    // Turn-scoped: the thread (and the host under it) survive for a continuation.
    expect(target.client.detach).not.toHaveBeenCalled()
    const notification = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')!
    expect((notification[1] as { status: string }).status).toBe('stopped')

    // The entry survives: a continuation runs a fresh turn on the same thread.
    const second = dispatcher.dispatch(
      { engine: 'codex', prompt: 'again', sessionId: result.sessionId },
      ctx
    )
    await tick()
    target.completeTurn({ text: 'second' })
    expect((await second).text).toBe('second')
  })

  it("a stopped turn's own late turn/completed cannot settle the NEXT turn (retired by id)", async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      codexAbortSettleGraceMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_2' })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    dispatcher.stopDispatch('toolu_stop_2', 'routing-1')
    const stopped = await first

    const second = dispatcher.dispatch(
      { engine: 'codex', prompt: 'again', sessionId: stopped.sessionId },
      ctx
    )
    await tick()
    // The ABANDONED turn's terminal event, arriving late.
    target.completeTurn({ text: 'stale', turnId: CODEX_TURN_ID })
    const sentinel = Symbol('still running')
    expect(await Promise.race([second, Promise.resolve(sentinel)])).toBe(sentinel)
    target.completeTurn({ text: 'fresh' })
    expect((await second).text).toBe('fresh')
  })

  it('a late approval request from an already stopped turn is refused, never forwarded', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      codexAbortSettleGraceMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_3' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    dispatcher.stopDispatch('toolu_stop_3', 'routing-1')
    await pending

    const decision = await target.serverRequest('item/commandExecution/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-cmd-late',
      startedAtMs: 0,
      command: 'ls',
      cwd: '/tmp/xeng-project'
    })
    expect(decision).toEqual({ decision: 'decline' })
    expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(false)
  })

  it('a stop dismisses a forwarded approval still pending for that target', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      codexAbortSettleGraceMs: 20
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_stop_4' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()
    const decisionPromise = target.serverRequest('item/commandExecution/requestApproval', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-cmd-1',
      startedAtMs: 0,
      command: 'ls',
      cwd: '/tmp/xeng-project'
    })
    await tick()
    const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
      requestId: string
    }
    dispatcher.stopDispatch('toolu_stop_4', 'routing-1')
    await pending
    expect(ctx.emit).toHaveBeenCalledWith('session:approval-dismiss', {
      requestId: approval.requestId
    })
    expect(await decisionPromise).toEqual({ decision: 'decline' })
  })

  it('disposeFor detaches the thread, unregisters the target and settles a turn in flight', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const ctx = makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-dispose' })
    const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
    await tick()

    dispatcher.disposeFor('routing-dispose')
    const result = await pending
    // ADR-069 §7: the target leaves the host, it does not kill it — and because
    // no process dies, the in-flight turn is settled explicitly (it used to ride
    // out on the client's own `onDisconnect`) and interrupted on the wire.
    expect(target.client.detach).toHaveBeenCalledTimes(1)
    expect(target.requests.some((entry) => entry.method === 'turn/interrupt')).toBe(true)
    expect(result.isError).toBe(true)

    const dead = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'again', sessionId: CODEX_THREAD_ID },
      ctx
    )
    expect(dead.isError).toBe(true)
    expect(dead.text).toContain('Unknown dispatch session')
  })

  it('disposeFor leaves ANOTHER session’s codex target alone', async () => {
    const a = makeFakeCodexTarget({ threadId: 'codex-thread-a' })
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: a.spawnCodexTarget })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', fromRoutingId: 'routing-a' })
    )
    await tick()
    a.completeTurn()
    await pending
    dispatcher.disposeFor('routing-other')
    expect(a.client.detach).not.toHaveBeenCalled()
  })

  it('the cumulative cost cap rejects a continuation once it is reached', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      dispatch: { maxCostUsd: 0.0000001 }
    })
    const ctx = makeCtx({ fromEngine: 'claude' })
    const first = dispatcher.dispatch({ engine: 'codex', prompt: 'one' }, ctx)
    await tick()
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      tokenUsage: {
        total: codexUsage({ totalTokens: 1000, inputTokens: 900, outputTokens: 100 }),
        last: codexUsage({ totalTokens: 1000 }),
        modelContextWindow: null
      }
    })
    target.completeTurn()
    const firstResult = await first
    expect(firstResult.text).toContain('dispatch cost cap reached')
    expect(ctx.addDispatchedCost).toHaveBeenCalledWith('codex', 'gpt-5.6-luna', expect.any(Number))

    const second = await dispatcher.dispatch(
      { engine: 'codex', prompt: 'two', sessionId: firstResult.sessionId },
      ctx
    )
    expect(second.isError).toBe(true)
    expect(second.text).toContain('Dispatch cost cap')
  })

  it('the configured absolute cap interrupts the turn and records a failed row', async () => {
    vi.useFakeTimers()
    try {
      const recordUsageEvent = vi.fn()
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        dispatch: { turnTimeoutMs: 60_000 },
        heartbeatMs: 30_000,
        codexAbortSettleGraceMs: 10,
        recordUsageEvent
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_timeout_1' })
      const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
      await settle()
      await advance(70_000)
      // The give-up path's bounded grace waits (codexAbortSettleGraceMs) run
      // AFTER the cap fires, so the clock has to keep moving past them.
      await advance(1_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('Dispatch timed out')
      expect(result.text).toContain('1 minutes')
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(true)
      expect(recordUsageEvent).toHaveBeenCalledTimes(1)
      expect(recordUsageEvent.mock.calls[0]![0]).toMatchObject({
        engineId: 'codex',
        origin: 'dispatch',
        sessionId: CODEX_THREAD_ID
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * Slice 2b guard 5 (target half) — a dispatch target bills the CALLER's
 * subscription (ADR-068 §2).
 *
 * `createCodexTarget` builds one hook per target from the injected factory; what
 * this pins is the ACCOUNT that factory is asked for, straight off
 * `DispatchContext.chatgptAccountId`.
 *
 * FINDING, recorded rather than worked around: today nothing can drive this end
 * to end. Only `CodexSession` sets `chatgptAccountId` (its own pin), and
 * `dispatchInner` refuses `req.engine === ctx.fromEngine`, so a Codex caller can
 * never reach a Codex target. The two halves are therefore pinned separately —
 * the caller half in `core/codex/__tests__/codex-session.test.ts` ("hands a
 * dispatch target the caller pin"), the target half here against a context that
 * carries the field. The wiring is what makes the pair correct the moment either
 * of those two facts changes; without it, a pinned session's delegated work
 * would silently bill the active account (ADR-059's rule, applied to accounts).
 */
describe('CrossEngineDispatcher — codex direction: the caller account (ADR-068 §2)', () => {
  it.each([
    ['a caller pin', 'acct-b', 'acct-b'],
    ['an explicit follow-active', null, null],
    ['a caller that carries no account at all', undefined, null]
  ])('asks for the host of %s', async (_label, chatgptAccountId, expected) => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({
      attachCodexTarget: target.spawnCodexTarget,
      codexVaultAccounts: true
    })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({
        fromEngine: 'claude',
        ...(chatgptAccountId !== undefined ? { chatgptAccountId } : {})
      })
    )
    await tick()
    target.completeTurn()
    await pending

    // One identity per PROCESS (ADR-068 §1), so the account the caller bills is
    // which HOST this thread lands on — asked for on the acquire itself.
    expect(target.spawnCalls[0]!.identity).toEqual({ accountId: expected })
  })

  it('asks for no identity at all when the vault is not wired — the hermetic default', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher } = makeCodexHarness({ attachCodexTarget: target.spawnCodexTarget })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', chatgptAccountId: 'acct-b' })
    )
    await tick()
    target.completeTurn()
    await pending

    expect(target.spawnCalls[0]!.identity).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// One liveness model for every dispatch direction (ADR-033's 2026-09-18
// amendment). A dispatched agent runs until the USER's limit: undefined or 0
// for `turnTimeoutMs`/`idleTimeoutMs` in the TARGET engine's DispatchConfig
// means unlimited, in EVERY direction — there is no built-in cap left. The
// opencode direction's own suite (above) already covers it; these cover the
// three directions that used to run on the fixed `DISPATCH_TIMEOUT_MS`.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — no built-in dispatch time limit (ADR-033 2026-09-18)', () => {
  /** Record the delay of every `setInterval` armed while a test runs, for the
   *  "no watchdog was ever armed" assertions — the progress heartbeat is an
   *  interval too, so a bare `vi.getTimerCount()` cannot tell them apart. */
  function recordIntervals(): { delays: () => number[]; restore: () => void } {
    const spy = vi.spyOn(globalThis, 'setInterval')
    return {
      delays: () => spy.mock.calls.map((call) => call[1] as number),
      restore: () => spy.mockRestore()
    }
  }

  // ── opencode direction ───────────────────────────────────────────────────
  //
  // Its own suite above already covers both caps set and both at 0; what was
  // missing is the UNSET case, which used to mean 60/15 minutes rather than
  // "no limit".

  // ── Claude direction ─────────────────────────────────────────────────────

  it('claude: with no configured caps a turn that keeps producing messages runs past 10 AND 60 minutes and completes normally', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery,
        heartbeatMs: 30_000
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_unlimited' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-sess-unlimited'
      } as SDKMessage)
      await settle()

      // 90 minutes of a working target — past the old fixed 10-minute
      // DISPATCH_TIMEOUT_MS and past the old 60-minute opencode default.
      for (let i = 0; i < 18; i++) {
        await advance(5 * 60_000)
        target.push({ type: 'assistant' } as SDKMessage)
        await settle()
      }
      expect(target.lastAbortController()?.signal.aborted).toBe(false)

      target.push(resultMsg({ result: 'finished after 90 minutes' }))
      const result = await pending
      expect(result.isError).toBeUndefined()
      expect(result.text).toBe('finished after 90 minutes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('claude: turnTimeoutMs fires as an ABSOLUTE cap naming its configured minutes, even on a continuously-active turn', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', turnTimeoutMs: 120_000 }
        })),
        spawnClaudeQuery: target.spawnClaudeQuery,
        heartbeatMs: 30_000
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_absolute' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({
        type: 'system',
        subtype: 'init',
        session_id: 'claude-sess-absolute'
      } as SDKMessage)

      for (let i = 0; i < 3; i++) {
        await advance(50_000)
        target.push({ type: 'assistant' } as SDKMessage)
        await settle()
      }
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')
      expect(result.text).toContain('2 minutes')
      expect(target.lastAbortController()?.signal.aborted).toBe(true)
      const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
      expect(notif?.[1]).toMatchObject({ status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('claude: idleTimeoutMs fires only after SILENCE — a message resets the clock, and a pending forwarded approval holds it open', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', idleTimeoutMs: 120_000, turnTimeoutMs: 0 }
        })),
        spawnClaudeQuery: target.spawnClaudeQuery,
        heartbeatMs: 30_000
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude_idle' })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await settle()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-idle' } as SDKMessage)
      await settle()

      // Four 90 s stretches (6 minutes, triple the 2-minute cap), each broken
      // by one message — the clock keeps resetting.
      for (let i = 0; i < 4; i++) {
        await advance(90_000)
        target.push({ type: 'assistant' } as SDKMessage)
        await settle()
      }
      expect(target.lastAbortController()?.signal.aborted).toBe(false)

      // Parked on a human: canUseTool forwards an approval nobody answers.
      const canUseTool = target.lastCanUseTool()!
      void canUseTool('Bash', { command: 'ls' }, {
        signal: new AbortController().signal
      } as unknown as Parameters<typeof canUseTool>[2])
      await settle()
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-request')).toBe(true)
      await advance(600_000) // ten silent minutes, five times the cap
      expect(target.lastAbortController()?.signal.aborted).toBe(false)
      expect(ctx.emit.mock.calls.some((c) => c[0] === 'session:approval-dismiss')).toBe(false)

      // Answered — ordinary silence now times the turn out, naming the cap.
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')![1] as {
        requestId: string
      }
      dispatcher.resolveApproval(approval.requestId, 'allow')
      await advance(130_000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('no activity')
      expect(result.text).toContain('2 minutes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('claude: both caps 0 → no watchdog interval is ever armed', async () => {
    vi.useFakeTimers()
    const intervals = recordIntervals()
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'haiku', turnTimeoutMs: 0, idleTimeoutMs: 0 }
        })),
        spawnClaudeQuery: target.spawnClaudeQuery,
        heartbeatMs: 30_000
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode' })
      )
      await settle()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-nowd' } as SDKMessage)
      await advance(6 * 60 * 60_000) // six silent hours
      expect(target.lastAbortController()?.signal.aborted).toBe(false)
      // The heartbeat is armed; the 10 s watchdog poll is not.
      expect(intervals.delays()).toContain(30_000)
      expect(intervals.delays()).not.toContain(DISPATCH_WATCHDOG_INTERVAL_MS)

      target.push(resultMsg({ result: 'still here' }))
      const result = await pending
      expect(result.isError).toBeUndefined()
    } finally {
      intervals.restore()
      vi.useRealTimers()
    }
  })

  // ── pi direction ─────────────────────────────────────────────────────────

  it('pi: with no configured caps a turn that keeps producing events runs past 10 AND 60 minutes and completes normally', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' }
        })),
        spawnPiTarget: target.spawnPiTarget,
        heartbeatMs: 30_000
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_pi_unlimited' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 18; i++) {
        await advance(5 * 60_000)
        target.pushEvent(piAssistantMessageEnd({ text: `chunk ${i}` }))
        await settle()
      }
      expect(target.client.request).not.toHaveBeenCalledWith({ type: 'abort' })

      target.pushEvent(piAssistantMessageEnd({ text: 'finished after 90 minutes' }))
      target.pushEvent(PI_AGENT_SETTLED)
      await settle()
      const result = await pending
      expect(result.isError).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pi: turnTimeoutMs fires as an ABSOLUTE cap naming its configured minutes, even on a continuously-active turn', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna', turnTimeoutMs: 120_000 }
        })),
        spawnPiTarget: target.spawnPiTarget,
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_pi_absolute' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 3; i++) {
        await advance(50_000)
        target.pushEvent(piAssistantMessageEnd({ text: `chunk ${i}` }))
        await settle()
      }
      await advance(1000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')
      expect(result.text).toContain('2 minutes')
      expect(target.client.request).toHaveBeenCalledWith({ type: 'abort' })
      const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
      expect(notif?.[1]).toMatchObject({ status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('pi: idleTimeoutMs fires only after SILENCE — an event resets the clock, and a pending forwarded approval holds it open', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: {
            defaultModel: 'openai-codex/gpt-5.6-luna',
            idleTimeoutMs: 120_000,
            turnTimeoutMs: 0
          }
        })),
        spawnPiTarget: target.spawnPiTarget,
        heartbeatMs: 30_000,
        piAbortSettleGraceMs: 20
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_pi_idle' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 4; i++) {
        await advance(90_000)
        target.pushEvent(piAssistantMessageEnd({ text: `chunk ${i}` }))
        await settle()
      }
      expect(target.client.request).not.toHaveBeenCalledWith({ type: 'abort' })

      void target.gateHandler()({
        toolCallId: 'pi-call-parked',
        toolName: 'bash',
        input: { command: 'ls' }
      })
      await settle()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')?.[1] as
        { requestId: string } | undefined
      expect(approval).toBeTruthy()
      await advance(600_000)
      expect(target.client.request).not.toHaveBeenCalledWith({ type: 'abort' })

      dispatcher.resolveApproval(approval!.requestId, 'allow')
      await advance(130_000)
      await advance(1000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('no activity')
      expect(result.text).toContain('2 minutes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pi: both caps 0 → no watchdog interval is ever armed', async () => {
    vi.useFakeTimers()
    const intervals = recordIntervals()
    try {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: {
            defaultModel: 'openai-codex/gpt-5.6-luna',
            turnTimeoutMs: 0,
            idleTimeoutMs: 0
          }
        })),
        spawnPiTarget: target.spawnPiTarget,
        heartbeatMs: 30_000
      })
      const pending = dispatcher.dispatch(
        { engine: 'pi', prompt: 'x' },
        makeCtx({ fromEngine: 'claude' })
      )
      await settle()
      await advance(6 * 60 * 60_000)
      expect(target.client.request).not.toHaveBeenCalledWith({ type: 'abort' })
      expect(intervals.delays()).toContain(30_000)
      expect(intervals.delays()).not.toContain(DISPATCH_WATCHDOG_INTERVAL_MS)

      target.pushEvent(piAssistantMessageEnd({ text: 'still here' }))
      target.pushEvent(PI_AGENT_SETTLED)
      await settle()
      const result = await pending
      expect(result.isError).toBeUndefined()
    } finally {
      intervals.restore()
      vi.useRealTimers()
    }
  })

  // ── Codex direction ──────────────────────────────────────────────────────

  /** One notification addressed to the target thread — the codex liveness feed. */
  const codexPing = (target: ReturnType<typeof makeFakeCodexTarget>, total: number): void => {
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: target.currentTurnId(),
      tokenUsage: {
        total: codexUsage({ totalTokens: total, inputTokens: total, outputTokens: 0 }),
        last: codexUsage({ totalTokens: total }),
        modelContextWindow: null
      }
    })
  }

  it('codex: with no configured caps a turn that keeps producing notifications runs past 10 AND 60 minutes and completes normally', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        heartbeatMs: 30_000
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_codex_unlimited' })
      const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 18; i++) {
        await advance(5 * 60_000)
        codexPing(target, 10 * (i + 1))
        await settle()
      }
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(false)

      target.completeTurn({ text: 'finished after 90 minutes' })
      await settle()
      const result = await pending
      expect(result.isError).toBeUndefined()
      expect(result.text).toBe('finished after 90 minutes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('codex: turnTimeoutMs fires as an ABSOLUTE cap naming its configured minutes, even on a continuously-active turn', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        dispatch: { turnTimeoutMs: 120_000 },
        heartbeatMs: 30_000,
        codexAbortSettleGraceMs: 10
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_codex_absolute' })
      const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 3; i++) {
        await advance(50_000)
        codexPing(target, 10 * (i + 1))
        await settle()
      }
      await advance(1000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('timed out')
      expect(result.text).toContain('2 minutes')
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(true)
      const notif = ctx.emit.mock.calls.find((c) => c[0] === 'session:task-notification')
      expect(notif?.[1]).toMatchObject({ status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('codex: idleTimeoutMs fires only after SILENCE — a notification resets the clock, and a pending forwarded approval holds it open', async () => {
    vi.useFakeTimers()
    try {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        dispatch: { idleTimeoutMs: 120_000, turnTimeoutMs: 0 },
        heartbeatMs: 30_000,
        codexAbortSettleGraceMs: 10
      })
      const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_codex_idle' })
      const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
      await settle()

      for (let i = 0; i < 4; i++) {
        await advance(90_000)
        codexPing(target, 10 * (i + 1))
        await settle()
      }
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(false)

      void target.serverRequest('item/commandExecution/requestApproval', {
        threadId: CODEX_THREAD_ID,
        turnId: target.currentTurnId(),
        itemId: 'item-cmd-parked',
        startedAtMs: 0,
        kind: 'command',
        environmentId: null,
        command: '/bin/zsh -lc "rm -rf x"',
        cwd: '/tmp/xeng-project'
      })
      await settle()
      const approval = ctx.emit.mock.calls.find((c) => c[0] === 'session:approval-request')?.[1] as
        { requestId: string } | undefined
      expect(approval).toBeTruthy()
      await advance(600_000)
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(false)

      dispatcher.resolveApproval(approval!.requestId, 'allow')
      await advance(130_000)
      await advance(1000)
      const result = await pending
      expect(result.isError).toBe(true)
      expect(result.text).toContain('no activity')
      expect(result.text).toContain('2 minutes')
    } finally {
      vi.useRealTimers()
    }
  })

  it('codex: both caps 0 → no watchdog interval is ever armed', async () => {
    vi.useFakeTimers()
    const intervals = recordIntervals()
    try {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        dispatch: { turnTimeoutMs: 0, idleTimeoutMs: 0 },
        heartbeatMs: 30_000
      })
      const pending = dispatcher.dispatch(
        { engine: 'codex', prompt: 'x' },
        makeCtx({ fromEngine: 'claude' })
      )
      await settle()
      await advance(6 * 60 * 60_000)
      expect(target.requests.some((e) => e.method === 'turn/interrupt')).toBe(false)
      expect(intervals.delays()).toContain(30_000)
      expect(intervals.delays()).not.toContain(DISPATCH_WATCHDOG_INTERVAL_MS)

      target.completeTurn({ text: 'still here' })
      await settle()
      const result = await pending
      expect(result.isError).toBeUndefined()
    } finally {
      intervals.restore()
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// ADR-071 §1 — a dispatched turn is a usage LEDGER row, and the only record of
// it. `dispatched_usage` was a second, poorer copy of the same turn; migration
// v20 dropped it, and every assertion in this file that used to read it now
// reads the ledger event the same call produces.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — the dispatched turn as a ledger row (ADR-071 §1)', () => {
  /** Frozen dispatcher clock, so a row's `message_id` is a literal to assert. */
  const LEDGER_TS = 1_700_000_000_000

  /** `dispatch:<who>:<ts>:<seq>` — the id these tests expect to see. */
  function ledgerId(who: string, seq: number, ts: number = LEDGER_TS): string {
    return `dispatch:${who}:${ts}:${seq}`
  }

  function ledgerHarness(overrides: Partial<DispatcherDeps> = {}): ReturnType<
    typeof makeHarness
  > & {
    recordUsageEvent: ReturnType<typeof vi.fn>
  } {
    const recordUsageEvent = vi.fn()
    const harness = makeHarness({
      now: () => LEDGER_TS,
      recordUsageEvent,
      ...overrides
    })
    return { ...harness, recordUsageEvent }
  }

  /** The one ledger event a call recorded. */
  function ledgerRow(recordUsageEvent: ReturnType<typeof vi.fn>): UsageTurnEvent {
    expect(recordUsageEvent).toHaveBeenCalledTimes(1)
    return recordUsageEvent.mock.calls[0]![0] as UsageTurnEvent
  }

  it("a pi target accumulates the split across the turn's several assistant messages", async () => {
    const target = makeFakePiTarget()
    const { dispatcher, recordUsageEvent } = ledgerHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const pending = dispatcher.dispatch(
      { engine: 'pi', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_pi' })
    )
    await tick()
    target.pushEvent(
      piAssistantMessageEnd({ text: 'one', input: 100, output: 20, cacheRead: 5, cacheWrite: 2 })
    )
    // A fresh `message_start` is what lets the mapper see a SECOND assistant
    // message in the same turn (a tool call splits one turn into several).
    target.pushEvent({ type: 'message_start', message: { role: 'assistant', content: [] } })
    target.pushEvent(
      piAssistantMessageEnd({
        text: 'two',
        cost: 0.04,
        input: 40,
        output: 10,
        cacheRead: 1,
        cacheWrite: 3
      })
    )
    target.pushEvent(PI_AGENT_SETTLED)
    await pending

    expect(ledgerRow(recordUsageEvent)).toMatchObject({
      engineId: 'pi',
      vendorId: 'openai-codex',
      modelId: 'gpt-5.6-luna',
      origin: 'dispatch',
      messageId: ledgerId('toolu_pi', 1),
      accountKey: 'pi:openai-codex:native',
      tokens: { input: 140, output: 30, cacheWrite: 5, cacheWrite1h: 0, cacheRead: 6 },
      // pi prices from its own catalog whatever the credential, so its figure
      // is a list price and never a bill.
      engineCostUsd: 0.04,
      engineCostIsEquivalent: true
    })
  })

  it('a pi turn pi itself prices at 0 is still counted by the cap, from its tokens', async () => {
    // The cap and the ledger read the same turn, so they must read it the same
    // way: pricing the ledger row off the tokens while the cap counted pi's
    // `0` would be one turn with two answers. `piCostInputs` only reaches for
    // the tokens when pi reported no positive charge, so a real figure still
    // wins.
    const target = makeFakePiTarget()
    const { dispatcher, recordUsageEvent } = ledgerHarness({
      loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } })),
      spawnPiTarget: target.spawnPiTarget
    })
    const ctx = makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_pi_zero' })
    const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
    await tick()
    // One million input tokens at $0.20/MTok, and pi reporting nothing for it.
    target.pushEvent(piAssistantMessageEnd({ text: 'ok', cost: 0, input: 1_000_000, output: 0 }))
    target.pushEvent(PI_AGENT_SETTLED)
    await pending

    expect(ctx.addDispatchedCost).toHaveBeenCalledWith(
      'pi',
      'openai-codex/gpt-5.6-luna',
      expect.closeTo(0.2, 6)
    )
    // And the ledger row keeps pi's raw figure, unchanged, beside the tokens.
    expect(ledgerRow(recordUsageEvent)).toMatchObject({
      engineCostUsd: 0,
      tokens: { input: 1_000_000, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 }
    })
  })

  it("a Claude target passes the result's usage split and the app's active account", async () => {
    const activeAccount = vi.spyOn(usageFetcher, 'getActiveAccount').mockReturnValue({
      uuid: 'acct-uuid-1',
      email: 'someone@example.test',
      organizationUuid: 'org-uuid-1',
      organizationName: 'Example Org',
      billingType: 'subscription'
    })
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher, recordUsageEvent } = ledgerHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_claude' })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(
        resultMsg({
          result: 'the answer',
          total_cost_usd: 0.03,
          duration_ms: 4200,
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_creation_input_tokens: 30,
            cache_read_input_tokens: 90,
            // The 1h-TTL SUBSET of the 30 written above, billed at 2× input.
            cache_creation: { ephemeral_5m_input_tokens: 18, ephemeral_1h_input_tokens: 12 }
          }
        })
      )
      await pending

      expect(ledgerRow(recordUsageEvent)).toMatchObject({
        engineId: 'claude',
        vendorId: 'anthropic',
        modelId: 'haiku',
        sessionId: 'claude-sess-1',
        origin: 'dispatch',
        parentRoutingId: 'routing-1',
        messageId: ledgerId('toolu_claude', 1),
        accountKey: 'anthropic:org-uuid-1:acct-uuid-1',
        accountLabel: 'someone@example.test (Example Org)',
        billingType: 'subscription',
        tokens: { input: 200, output: 80, cacheWrite: 30, cacheWrite1h: 12, cacheRead: 90 },
        // cli.js reports an API-equivalent whatever the plan (ADR-034).
        engineCostUsd: 0.03,
        engineCostIsEquivalent: true
      })
    } finally {
      activeAccount.mockRestore()
    }
  })

  it('a Claude turn on a usage_based account is BILLED — the row must not call it covered', async () => {
    // `oauthAccount.billingType` is the only signal that separates an OAuth
    // account billed per token from one on a plan, and `UsageFetcher` is the
    // only reader of it. Taking the billing type from the auth probe instead
    // would answer `subscription` here and write `billed_cost_usd: 0` over
    // money that really left a wallet.
    const activeAccount = vi.spyOn(usageFetcher, 'getActiveAccount').mockReturnValue({
      uuid: 'acct-uuid-1',
      email: 'someone@example.test',
      organizationUuid: 'org-uuid-1',
      billingType: 'apiKey'
    })
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher, recordUsageEvent } = ledgerHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_usage_based' })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg({ result: 'the answer', total_cost_usd: 0.03 }))
      await pending

      expect(ledgerRow(recordUsageEvent)).toMatchObject({
        accountKey: 'anthropic:org-uuid-1:acct-uuid-1',
        billingType: 'apiKey'
      })
    } finally {
      activeAccount.mockRestore()
    }
  })

  it('a Claude target resolves its account ONCE, at creation, not per turn', async () => {
    // The spawned cli.js holds the credential it was given at spawn, so a
    // sign-in change mid-target cannot move which account its turns billed —
    // and a second read would record the wrong one.
    const activeAccount = vi.spyOn(usageFetcher, 'getActiveAccount').mockReturnValue({
      uuid: 'acct-uuid-1',
      email: 'first@example.test',
      organizationUuid: 'org-uuid-1',
      billingType: 'subscription'
    })
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher, recordUsageEvent } = ledgerHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const ctx = makeCtx({ fromEngine: 'opencode', toolUseId: 'toolu_pinned' })
      const first = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg({ result: 'one', total_cost_usd: 0.01 }))
      await first

      // The user switches accounts between the two turns.
      activeAccount.mockReturnValue({
        uuid: 'acct-uuid-2',
        email: 'second@example.test',
        organizationUuid: 'org-uuid-2',
        billingType: 'apiKey'
      })
      const second = dispatcher.dispatch(
        { engine: 'claude', prompt: 'y', sessionId: 'claude-sess-1' },
        ctx
      )
      await tick()
      target.push(resultMsg({ result: 'two', total_cost_usd: 0.02 }))
      await second

      const keys = recordUsageEvent.mock.calls.map((c) => (c[0] as UsageTurnEvent).accountKey)
      expect(keys).toEqual(['anthropic:org-uuid-1:acct-uuid-1', 'anthropic:org-uuid-1:acct-uuid-1'])
    } finally {
      activeAccount.mockRestore()
    }
  })

  it('a Claude target with no known active account records the unknown one, not half a key', async () => {
    const activeAccount = vi.spyOn(usageFetcher, 'getActiveAccount').mockReturnValue(null)
    try {
      const target = makeFakeClaudeTarget()
      const { dispatcher, recordUsageEvent } = ledgerHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery
      })
      const pending = dispatcher.dispatch(
        { engine: 'claude', prompt: 'x' },
        makeCtx({ fromEngine: 'opencode' })
      )
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      target.push(resultMsg({ result: 'the answer', total_cost_usd: 0.01 }))
      await pending

      expect(ledgerRow(recordUsageEvent)).toMatchObject({
        accountKey: 'unknown',
        accountLabel: null,
        billingType: 'unknown'
      })
    } finally {
      activeAccount.mockRestore()
    }
  })

  it('a Codex target passes its turn DELTA as a disjoint split, under the native account', async () => {
    const target = makeFakeCodexTarget()
    const { dispatcher, recordUsageEvent } = ledgerHarness({
      attachCodexTarget: target.spawnCodexTarget,
      loadEngineConfig: vi.fn(() => ({ dispatch: {} }) as EngineConfig)
    })
    const pending = dispatcher.dispatch(
      { engine: 'codex', prompt: 'x' },
      makeCtx({ fromEngine: 'claude', toolUseId: 'toolu_codex' })
    )
    await tick()
    target.notify('thread/tokenUsage/updated', {
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      tokenUsage: {
        total: codexUsage({
          totalTokens: 1_000,
          inputTokens: 800,
          cachedInputTokens: 500,
          cacheWriteInputTokens: 100,
          outputTokens: 200,
          reasoningOutputTokens: 40
        }),
        last: codexUsage({ totalTokens: 1_000 }),
        modelContextWindow: 400_000
      }
    })
    target.completeTurn()
    await pending

    expect(ledgerRow(recordUsageEvent)).toMatchObject({
      engineId: 'codex',
      vendorId: 'openai',
      modelId: 'gpt-5.6-luna',
      origin: 'dispatch',
      messageId: ledgerId('toolu_codex', 1),
      // No vault accounts on this dispatcher, so the vault is never read and
      // the honest answer is Codex signed in on its own.
      accountKey: 'codex:openai:native',
      billingType: 'unknown',
      // 800 total prompt minus 500 cached minus 100 cache-written.
      tokens: { input: 200, output: 200, cacheWrite: 100, cacheWrite1h: 0, cacheRead: 500 },
      // codexTurnCostUsd is our own table's equivalent, not a charge Codex
      // reported, so the row carries no engine figure at all.
      engineCostUsd: null,
      engineCostIsEquivalent: true
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-085 §3 — dispatch targets get the user's deny/ask rules (never allow),
// opencode target children are registered, plan refusals are host-side.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — ADR-085 §3: user deny/ask rules on every target', () => {
  const FORCE_DENY = 'Bash(git push --force:*)'
  const DOCKER_ASK = 'Bash(docker run:*)'
  const RULES = userRules({
    allow: ['Bash(git:*)', 'Read'],
    deny: [FORCE_DENY],
    ask: [DOCKER_ASK],
    additionalDirectories: ['/extra']
  })
  const approvals = (ctx: ReturnType<typeof makeCtx>): unknown[] =>
    ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-request').map((c) => c[1])

  describe('(e) pi target', () => {
    // A scripted judge that ALLOWS (ADR-088): without G9 an auto-mode ask rule
    // would be judged and allowed instead of reaching the human.
    const piJudge = makeScriptedJudge()
    async function start(mode: string) {
      const target = makeFakePiTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({
          dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' },
          autoMode: { twoStageMode: 'fast' as const }
        })),
        spawnPiTarget: target.spawnPiTarget,
        loadUserRules: () => RULES,
        makeJudgeTransport: piJudge.make
      })
      const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: mode })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await tick()
      const finish = async (): Promise<void> => {
        target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
        target.pushEvent(PI_AGENT_SETTLED)
        await pending
      }
      return { target, ctx, finish }
    }

    it('a deny rule refuses with the rule, even under auto', async () => {
      const { target, ctx, finish } = await start('auto')
      const decision = await target.gateHandler()({
        toolCallId: 'pi-call-d',
        toolName: 'bash',
        input: { command: 'git push origin main --force' }
      })
      expect(decision).toEqual({
        behavior: 'deny',
        reason: `Denied by permission rule: ${FORCE_DENY}`
      })
      expect(approvals(ctx)).toHaveLength(0)
      await finish()
    })

    it('an ask rule under auto is forwarded (the ask rung precedes the mode base)', async () => {
      const before = piJudge.requests.length
      const { target, ctx, finish } = await start('auto')
      void target.gateHandler()({
        toolCallId: 'pi-call-a',
        toolName: 'bash',
        input: { command: 'docker --context x run alpine' }
      })
      for (let i = 0; i < 8; i++) await tick()
      expect(approvals(ctx)).toHaveLength(1)
      expect(piJudge.requests.length).toBe(before)
      await finish()
    })

    it('the user allow tier is not inherited: a `git` command under default still asks', async () => {
      const { target, ctx, finish } = await start('default')
      void target.gateHandler()({
        toolCallId: 'pi-call-g',
        toolName: 'bash',
        input: { command: 'git status' }
      })
      await tick()
      expect(approvals(ctx)).toHaveLength(1)
      await finish()
    })

    it('a mode-base deny keeps its own reason', async () => {
      const { target, finish } = await start('plan')
      const decision = await target.gateHandler()({
        toolCallId: 'pi-call-w',
        toolName: 'write',
        input: { path: 'a.txt', content: 'x' }
      })
      expect(decision).toEqual({ behavior: 'deny', reason: 'Denied by dispatch autonomy mode' })
      await finish()
    })
  })

  describe('(f) codex target', () => {
    async function start(mode: string) {
      const target = makeFakeCodexTarget()
      const { dispatcher } = makeCodexHarness({
        attachCodexTarget: target.spawnCodexTarget,
        loadUserRules: () => RULES
      })
      const ctx = makeCtx({
        fromEngine: 'claude',
        autonomyMode: mode,
        toolUseId: 'toolu_dispatch_1'
      })
      const pending = dispatcher.dispatch({ engine: 'codex', prompt: 'x' }, ctx)
      await tick()
      return { target, ctx, pending }
    }
    const commandRequest = (command: string): Record<string, unknown> => ({
      threadId: CODEX_THREAD_ID,
      turnId: CODEX_TURN_ID,
      itemId: 'item-cmd-1',
      startedAtMs: 0,
      kind: 'command',
      environmentId: null,
      command,
      cwd: '/tmp/xeng-project'
    })

    it('an ask rule under auto asks the caller (it no longer allows everything)', async () => {
      const { target, ctx, pending } = await start('auto')
      void target.serverRequest(
        'item/commandExecution/requestApproval',
        commandRequest('/bin/zsh -lc "docker --context x run alpine"')
      )
      await tick()
      expect(approvals(ctx)).toHaveLength(1)
      target.completeTurn()
      await pending
    })

    it('a deny rule declines and reports the rule', async () => {
      const { target, ctx, pending } = await start('auto')
      const decision = await target.serverRequest(
        'item/commandExecution/requestApproval',
        commandRequest('/bin/zsh -lc "git push origin main --force"')
      )
      expect(decision).toEqual({ decision: 'decline' })
      expect(approvals(ctx)).toHaveLength(0)
      const denial = ctx.emit.mock.calls.find(
        (c) =>
          c[0] === 'session:subagent-message' &&
          JSON.stringify((c[1] as { message: unknown }).message).includes('denied')
      )
      expect(JSON.stringify((denial![1] as { message: unknown }).message)).toContain(
        `Denied by permission rule: ${FORCE_DENY}`
      )
      target.completeTurn()
      await pending
    })

    // ADR-088 review R1: an escalation reaching the gate under `auto` gates as
    // `default` — with no matching rule, the human decides (was: accepted).
    it('without a matching rule auto gates as default — the escalation asks the human', async () => {
      const { target, ctx, pending } = await start('auto')
      void target.serverRequest(
        'item/commandExecution/requestApproval',
        commandRequest('/bin/zsh -lc "ls"')
      )
      await tick()
      expect(approvals(ctx)).toHaveLength(1)
      target.completeTurn()
      await pending
    })
  })

  describe('(g) Claude target', () => {
    async function start(
      rules: MergedClaudeRules,
      mode = 'default',
      extra: Partial<DispatchContext> = {}
    ) {
      const target = makeFakeClaudeTarget()
      const { dispatcher } = makeHarness({
        loadEngineConfig: vi.fn(() => ({ dispatch: { defaultModel: 'haiku' } })),
        spawnClaudeQuery: target.spawnClaudeQuery,
        loadUserRules: () => rules
      })
      const ctx = makeCtx({ fromEngine: 'opencode', autonomyMode: mode, ...extra })
      const pending = dispatcher.dispatch({ engine: 'claude', prompt: 'x' }, ctx)
      await tick()
      target.push({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' } as SDKMessage)
      await tick()
      const finish = async (): Promise<void> => {
        target.push(resultMsg({ result: 'ok', session_id: 'claude-sess-1' }))
        await pending
      }
      return { target, ctx, finish }
    }

    it('spawn opts carry settings.permissions.{deny, ask} — never the allow tier', async () => {
      const { target, finish } = await start(RULES, 'auto')
      expect(target.spawnCalls[0].settings).toEqual({
        permissions: { deny: [FORCE_DENY], ask: [DOCKER_ASK] }
      })
      await finish()
    })

    it("a subagent with `edit: deny` dispatching: the Claude target's settings deny every edit tool (ADR-093 S9, option a)", async () => {
      // The calling opencode agent's own rules, mapped (caller-restriction.ts).
      const callerRestriction = callerRestrictionFromAgent(
        {
          id: 'reviewer',
          permissions: [
            { action: '*', resource: '*', effect: 'allow' },
            { action: 'edit', resource: '*', effect: 'deny' }
          ]
        },
        '/tmp/xeng-project'
      )
      const { target, finish } = await start(userRules(), 'acceptEdits', { callerRestriction })
      const settings = target.spawnCalls[0].settings as { permissions: { deny: string[] } }
      expect(settings.permissions.deny).toEqual(
        expect.arrayContaining(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
      )
      // Only tighter: never an allow.
      expect(settings.permissions).not.toHaveProperty('allow')
      await finish()
    })

    it('no settings key at all when the user has no deny/ask rule', async () => {
      const { target, finish } = await start(userRules({ allow: ['Bash(git:*)'] }))
      expect('settings' in target.spawnCalls[0]).toBe(false)
      await finish()
    })

    it('a shell command a deny rule hits is refused with the rule, no card', async () => {
      const { target, ctx, finish } = await start(RULES)
      const decision = await target.lastCanUseTool()!(
        'Bash',
        { command: 'git -C . push origin main --force' },
        { signal: new AbortController().signal, toolUseId: 'toolu_c1' }
      )
      expect(decision).toEqual({
        behavior: 'deny',
        message: `Denied by permission rule: ${FORCE_DENY}`
      })
      expect(approvals(ctx)).toHaveLength(0)

      // Anything else still reaches the human.
      void target.lastCanUseTool()!(
        'Bash',
        { command: 'ls' },
        { signal: new AbortController().signal, toolUseId: 'toolu_c2' }
      )
      await tick()
      expect(approvals(ctx)).toHaveLength(1)
      await finish()
    })
  })
})

// ---------------------------------------------------------------------------
// ADR-088 — dispatch targets inherit auto mode, live, and are JUDGED: pi and
// opencode targets by ClaudeUI's own judge (the shared pipeline, scripted here
// through `makeJudgeTransport`), Claude/Codex targets by their engines' own.
// ---------------------------------------------------------------------------

describe('CrossEngineDispatcher — ADR-088: judged dispatch targets', () => {
  // ADR-091 part 6: no hold unless `blockHoldSeconds` says so. These suites
  // were written for the held card, so they run with a 2-minute window; the
  // part 6 suites below set their own.
  beforeEach(() => {
    vi.mocked(loadSharedAutoModeConfig).mockReturnValue({ blockHoldSeconds: HOLD_MS / 1000 })
  })
  afterEach(() => {
    vi.mocked(loadSharedAutoModeConfig).mockReturnValue({})
  })
  /** Enough turns of the event loop for the pipeline's awaits to settle. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await tick()
  }
  const approvals = (ctx: ReturnType<typeof makeCtx>): unknown[] =>
    ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-request').map((c) => c[1])
  const reviews = (
    ctx: ReturnType<typeof makeCtx>
  ): Array<{ toolUseId: string; review: Record<string, unknown> }> =>
    ctx.emit.mock.calls
      .filter((c) => c[0] === 'session:tool-review')
      .map((c) => c[1] as { toolUseId: string; review: Record<string, unknown> })
  const PARENT: ChatMessage[] = [
    {
      id: 'parent-1',
      role: 'user',
      content: [{ type: 'text', text: 'please clean the build output' }],
      timestamp: 0
    }
  ]

  function judgedConfig(autoMode: EngineConfig['autoMode'] = {}) {
    return (id: string): EngineConfig => ({
      dispatch: { defaultModel: id === 'pi' ? 'openai-codex/gpt-5.6-luna' : 'openai/gpt-5' },
      autoMode: { twoStageMode: 'fast', ...autoMode }
    })
  }

  describe('pi target', () => {
    async function start(
      autoMode: EngineConfig['autoMode'] = {},
      extra: Partial<DispatchContext> = {}
    ) {
      const target = makeFakePiTarget()
      const judge = makeScriptedJudge()
      const { dispatcher } = makeHarness({
        loadEngineConfig: judgedConfig(autoMode),
        spawnPiTarget: target.spawnPiTarget,
        makeJudgeTransport: judge.make
      })
      let mode = 'auto'
      const ctx = makeCtx({
        fromEngine: 'claude',
        toolUseId: 'toolu_pi_auto',
        getAutonomyMode: () => mode,
        getMessages: () => PARENT,
        ...extra
      })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'remove the build dir' }, ctx)
      await tick()
      const gate = (toolCallId: string, toolName: string, input: Record<string, unknown>) =>
        target.gateHandler()({ toolCallId, toolName, input })
      const finish = async (): Promise<void> => {
        target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
        target.pushEvent(PI_AGENT_SETTLED)
        await pending
      }
      return { target, judge, dispatcher, ctx, gate, finish, setMode: (m: string) => (mode = m) }
    }

    it('T7: bash is judged from the acceptEdits base — allow, then block; read needs no judge; the review binds to the pi call id', async () => {
      const t = await start()
      expect(await t.gate('pi-call-1', 'bash', { command: 'rm -rf x' })).toEqual({
        behavior: 'allow'
      })
      expect(t.judge.requests).toHaveLength(1)
      expect(t.judge.requests[0].user).toContain('"dispatch:pi" subagent')
      expect(t.judge.requests[0].user).toContain('User: please clean the build output')
      expect(reviews(t.ctx)[0]).toMatchObject({
        toolUseId: 'pi-call-1',
        review: { reviewer: 'auto-mode', decision: 'approved' }
      })

      // A block holds on the forwarded card (ADR-091 §3); Keep blocked answers
      // with the judge's own text.
      t.judge.replies.push('<block>yes</block><reason>destroys data</reason>')
      const blocked = t.gate('pi-call-2', 'bash', { command: 'rm -rf y' })
      await flush()
      const [card] = approvals(t.ctx) as PendingApproval[]
      expect(card).toMatchObject({
        toolUseId: 'pi-call-2',
        autoModeBlock: { expiresAt: expect.any(Number) },
        agent: { agentId: 'pi-target-1', subagentType: 'dispatch:pi' }
      })
      t.dispatcher.resolveApproval(card.requestId, 'deny')
      expect(await blocked).toEqual({
        behavior: 'deny',
        reason: 'Auto mode blocked: destroys data'
      })

      expect(await t.gate('pi-call-3', 'read', { path: 'a.txt' })).toEqual({ behavior: 'allow' })
      expect(t.judge.requests).toHaveLength(2)
      expect(approvals(t.ctx)).toHaveLength(1)
      expect(t.judge.opts[0]).toMatchObject({ engine: 'pi', routingId: 'routing-1' })
      expect(t.judge.opts[0].sessionId()).toBe('pi-target-1')
      expect(t.judge.opts[0].modelValue()).toBe('openai-codex/gpt-5.6-luna')
      await t.finish()
    })

    describe('ADR-091 §3: a held block', () => {
      const BLOCK = '<block>yes</block><reason>destroys data</reason>'
      const dismissals = (ctx: ReturnType<typeof makeCtx>): unknown[] =>
        ctx.emit.mock.calls.filter((c) => c[0] === 'session:approval-dismiss').map((c) => c[1])
      async function hold(t: Awaited<ReturnType<typeof start>>, id: string) {
        t.judge.replies.push(BLOCK)
        const decision = t.gate(id, 'bash', { command: 'rm -rf y' })
        await flush()
        const card = (approvals(t.ctx) as PendingApproval[]).at(-1)!
        expect(card.toolUseId).toBe(id)
        expect(card.autoModeBlock).toBeDefined()
        return { decision, card }
      }

      it('Approve anyway runs the exact call; Keep blocked is annotated for the next judgement', async () => {
        const t = await start()
        t.target.pushEvent(
          piAssistantMessageEnd({
            toolUse: { id: 'pi-kept', name: 'bash', input: { command: 'rm -rf y' } }
          })
        )
        await tick()
        const kept = await hold(t, 'pi-kept')
        t.dispatcher.resolveApproval(kept.card.requestId, 'deny')
        expect(await kept.decision).toEqual({
          behavior: 'deny',
          reason: 'Auto mode blocked: destroys data'
        })
        const approved = await hold(t, 'pi-approved')
        expect(t.judge.requests[1].user).toContain('{"outcome":"automode-blocked"}')
        t.dispatcher.resolveApproval(approved.card.requestId, 'allow')
        expect(await approved.decision).toEqual({ behavior: 'allow' })
        await t.finish()
      })

      it('unanswered, it resolves as Keep blocked when the hold expires, and the card is withdrawn', async () => {
        const t = await start()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          const { decision, card } = await hold(t, 'pi-timeout')
          await vi.advanceTimersByTimeAsync(HOLD_MS)
          expect(await decision).toEqual({
            behavior: 'deny',
            reason: 'Auto mode blocked: destroys data'
          })
          expect(dismissals(t.ctx)).toEqual([{ requestId: card.requestId }])
        } finally {
          vi.useRealTimers()
        }
        await t.finish()
      })

      it('a stop while held force-denies it as before and disarms the expiry', async () => {
        const t = await start()
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
          const { decision, card } = await hold(t, 'pi-stopped')
          expect(t.dispatcher.stopDispatch('toolu_pi_auto')).toBe(true)
          // The stop's own abort grace runs on the (faked) clock too.
          await vi.advanceTimersByTimeAsync(10_000)
          expect(await decision).toEqual({ behavior: 'deny', reason: 'User denied' })
          expect(dismissals(t.ctx)).toEqual([{ requestId: card.requestId }])
          await vi.advanceTimersByTimeAsync(HOLD_MS)
          expect(dismissals(t.ctx)).toHaveLength(1)
        } finally {
          vi.useRealTimers()
        }
        t.target.pushEvent(PI_AGENT_SETTLED)
      })
    })

    describe('ADR-091 part 6: no hold, and approve-after-block', () => {
      beforeEach(() => {
        vi.mocked(loadSharedAutoModeConfig).mockReturnValue({})
      })
      const delivered = (t: Awaited<ReturnType<typeof start>>): string[] =>
        t.target.client.request.mock.calls
          .map((c) => c[0] as { type: string; message?: string })
          .filter((c) => c.type === 'prompt' && String(c.message).startsWith('/cui-deliver '))
          .map((c) =>
            Buffer.from(String(c.message).slice('/cui-deliver '.length), 'base64').toString('utf8')
          )

      it('no hold: denied at once; approving while the dispatch runs nudges the TARGET, and its retry spends the grant', async () => {
        const l = new BlockedCallLedger(() => {})
        const t = await start({}, { blockedCalls: l })
        t.judge.replies.push('<block>yes</block><reason>destroys data</reason>')
        expect(await t.gate('pi-b1', 'bash', { command: 'rm -rf y' })).toEqual({
          behavior: 'deny',
          reason: 'Auto mode blocked: destroys data'
        })
        expect(approvals(t.ctx)).toHaveLength(0)
        const call = l.approve('pi-b1')!
        expect(call.deliver!(call)).toBe('"openai-codex/gpt-5.6-luna"')
        await flush()
        expect(delivered(t)).toHaveLength(1)
        expect(delivered(t)[0]).toContain(
          '[ClaudeUI] The user approved your blocked bash call: rm -rf y.'
        )
        expect(await t.gate('pi-b2', 'bash', { command: 'rm -rf y' })).toEqual({
          behavior: 'allow'
        })
        expect(t.judge.requests).toHaveLength(1)
        await t.finish()
      })

      it('once the dispatch finished, the target takes no delivery — the dispatching agent is nudged', async () => {
        const l = new BlockedCallLedger(() => {})
        const t = await start({}, { blockedCalls: l })
        t.judge.replies.push('<block>yes</block><reason>destroys data</reason>')
        await t.gate('pi-f1', 'bash', { command: 'rm -rf y' })
        await t.finish()
        const call = l.approve('pi-f1')!
        expect(call.deliver!(call)).toBeNull()
        expect(delivered(t)).toHaveLength(0)
        expect(call.dispatchSessionId).toBe('pi-target-1')
      })
    })

    it('T7: the target’s own earlier call is on the judge’s transcript (D1 trajectory)', async () => {
      const t = await start()
      t.target.pushEvent(
        piAssistantMessageEnd({
          toolUse: { id: 'pi-earlier', name: 'bash', input: { command: 'ls build' } }
        })
      )
      await tick()
      await t.gate('pi-call-1', 'bash', { command: 'rm -rf build' })
      const user = t.judge.requests[0].user
      expect(user).toContain('ls build')
      expect(user).not.toMatch(/User:[^\n]*remove the build dir/)
      await t.finish()
    })

    it('T13 (G10): the parent leaves auto while the judge runs → the verdict is discarded and the ask goes to the human', async () => {
      const t = await start()
      const held = deferred<string>()
      t.judge.replies.push(() => held.promise)
      const decision = t.gate('pi-call-1', 'bash', { command: 'rm -rf x' })
      await flush()
      t.setMode('default')
      held.resolve('<block>no</block>')
      await flush()
      expect(approvals(t.ctx)).toEqual([
        expect.objectContaining({ toolUseId: 'pi-call-1', toolName: 'bash' })
      ])
      expect(reviews(t.ctx)).toHaveLength(0)
      void decision
      await t.finish()
    })

    it('T15: a stop while the ask is judged denies it as stopped, with no card', async () => {
      const t = await start()
      const held = deferred<string>()
      t.judge.replies.push(() => held.promise)
      const decision = t.gate('pi-call-1', 'bash', { command: 'rm -rf x' })
      await flush()
      expect(t.dispatcher.stopDispatch('toolu_pi_auto')).toBe(true)
      held.resolve('<block>no</block>')
      expect(await decision).toEqual({ behavior: 'deny', reason: 'Dispatch stopped' })
      expect(approvals(t.ctx)).toHaveLength(0)
      expect(reviews(t.ctx)).toHaveLength(0)
      t.target.pushEvent(PI_AGENT_SETTLED)
    })

    it('F10: a stop during the transport await whose outcome would be human (transport fails) → deny as stopped, no card', async () => {
      const t = await start()
      const held = deferred<string>()
      t.judge.replies.push(() => held.promise.then(() => Promise.reject(new Error('HTTP 503'))))
      const decision = t.gate('pi-call-1', 'bash', { command: 'rm -rf x' })
      await flush()
      expect(t.dispatcher.stopDispatch('toolu_pi_auto')).toBe(true)
      held.resolve('')
      expect(await decision).toEqual({ behavior: 'deny', reason: 'Dispatch stopped' })
      expect(approvals(t.ctx)).toHaveLength(0)
      t.target.pushEvent(PI_AGENT_SETTLED)
    })

    it('a user ask rule (G9) reaches the human with zero judge calls', async () => {
      const target = makeFakePiTarget()
      const judge = makeScriptedJudge()
      const { dispatcher } = makeHarness({
        loadEngineConfig: judgedConfig(),
        loadUserRules: () => userRules({ ask: ['Bash(git push:*)'] }),
        spawnPiTarget: target.spawnPiTarget,
        makeJudgeTransport: judge.make
      })
      const ctx = makeCtx({ fromEngine: 'claude', autonomyMode: 'auto' })
      const pending = dispatcher.dispatch({ engine: 'pi', prompt: 'x' }, ctx)
      await tick()
      void target.gateHandler()({
        toolCallId: 'pi-push',
        toolName: 'bash',
        input: { command: 'git push origin main' }
      })
      await flush()
      expect(judge.requests).toHaveLength(0)
      expect(approvals(ctx)).toHaveLength(1)
      target.pushEvent(piAssistantMessageEnd({ text: 'done' }))
      target.pushEvent(PI_AGENT_SETTLED)
      await pending
    })
  })
})
