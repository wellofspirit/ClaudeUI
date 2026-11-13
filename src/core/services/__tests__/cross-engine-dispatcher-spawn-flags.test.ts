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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { QueryHandle, QueryOptions, SDKMessage } from '../../sdk'
import { buildArgs } from '../../sdk/args'
import { CrossEngineDispatcher } from '../cross-engine-dispatcher'
import type { DispatchContext } from '../cross-engine-dispatcher'
import type { DispatcherDeps } from '../dispatch-target-types'
import { defaultClaudeTargetEffort } from '../dispatch-claude-targets'
import { resetCachedClaudeModels, setCachedClaudeModels } from '../claude-model-catalog'
import { emitEvent } from '../sync-host'
import type { EngineConfig, ModelInfo } from '../../../shared/types'
import { makeFakeDispatchLedger } from '../../../test/helpers/fake-dispatch-ledger'
import { withDefaultDescription } from '../../../test/helpers/default-dispatch-description'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../../sdk', async (importActual) => ({
  ...(await importActual<typeof import('../../sdk')>()),
  query: mocks.query
}))
vi.mock('../../providers/claude-spawn-prep', () => ({ claudeSpawnPrep: vi.fn() }))
vi.mock('../../sdk/host-token', async (importActual) => ({
  ...(await importActual<typeof import('../../sdk/host-token')>()),
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

function ctx(mode = 'default'): DispatchContext {
  return {
    fromEngine: 'opencode',
    fromRoutingId: 'parent-A',
    cwd: '/tmp/proj',
    getAutonomyMode: () => mode,
    getMessages: () => [],
    emit: vi.fn()
  }
}

function makeDispatcher(
  ledger: ReturnType<typeof makeFakeDispatchLedger>,
  over: Partial<DispatcherDeps> = {}
): CrossEngineDispatcher {
  return withDefaultDescription(
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
      targetCwdExists: () => true,
      ...over
    })
  )
}

/** Set the app settings as core reads them: canonical state, which every client save feeds. */
const saveSettings = (settings: Record<string, unknown>): void =>
  emitEvent('config:settings-changed', [settings])

/** The argv cli.js is spawned with for the n-th `query` call, and its options. */
function spawnOf(call: number): { args: string[]; options: QueryOptions } {
  const { options } = mocks.query.mock.calls[call][0] as { options: QueryOptions }
  return { args: buildArgs(options), options }
}

/** The one `--settings` JSON of an argv, parsed. */
function flagSettings(args: string[]): Record<string, unknown> {
  const at = args.indexOf('--settings')
  expect(at).toBeGreaterThan(-1)
  expect(args.lastIndexOf('--settings')).toBe(at)
  return JSON.parse(args[at + 1]) as Record<string, unknown>
}

/** The value after `flag`, or undefined when the flag is not in the argv. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

/** The shared setting: a `sandbox` block as Claude Code's user settings file holds it. */
function sandboxOn(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: ['docker'],
    enableWeakerNestedSandbox: true,
    network: { allowedDomains: ['example.com'], allowLocalBinding: false },
    filesystem: { allowWrite: ['/data'], denyRead: ['~/.ssh'] },
    ...over
  }
}

describe('the real Claude dispatch spawn (ADR-105)', () => {
  it('persists the session under the recorded uuid, and --resume-s it after the process is gone', async () => {
    mocks.query.mockReset()
    const ledger = makeFakeDispatchLedger()
    const dispatcher = makeDispatcher(ledger)

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

  // A target spawned without `--thinking-display summarized` streamed its Opus 4.7+ thinking as a
  // bare signature: the card showed nothing for minutes while the X-Agent was thinking.
  it('asks for summarized thinking, like a root session, when created and when resumed', async () => {
    mocks.query.mockReset()
    const dispatcher = makeDispatcher(makeFakeDispatchLedger())
    mocks.query.mockImplementation(() => oneTurnProcess('claude-sess-2'))

    const first = await dispatcher.dispatch(
      { engine: 'claude', prompt: 'one', model: 'opus' },
      ctx()
    )
    dispatcher.disposeFor('parent-A')
    await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: first.sessionId },
      ctx()
    )

    expect(mocks.query).toHaveBeenCalledTimes(2)
    for (const [input] of mocks.query.mock.calls) {
      const args = buildArgs((input as { options: QueryOptions }).options)
      const at = args.indexOf('--thinking-display')
      expect(at).toBeGreaterThan(-1)
      expect(args[at + 1]).toBe('summarized')
      expect(args[args.indexOf('--thinking') + 1]).toBe('adaptive')
    }
  })
})

/**
 * ADR-116: a dispatched Claude agent is spawned with the Claude engine's sandbox settings and
 * at a new session's starting effort for its model, both read when the process is spawned.
 * Seen on the argv the REAL spawn builds, since that is all cli.js gets: the process loads no
 * settings source, so a sandbox that is not in `--settings` does not exist for it.
 */
describe('the shared sandbox and effort on the real Claude dispatch spawn (ADR-116)', () => {
  /** `engines/claude.json`, as the dispatcher reads it at each spawn. */
  let claudeConfig: EngineConfig
  /** CLAUDE_CONFIG_DIR: the user settings file the sandbox flags are read from at each spawn. */
  let configDir: string
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR
  const writeSandbox = (sandbox: Record<string, unknown> | undefined): void => {
    const file = path.join(configDir, 'settings.json')
    if (sandbox) fs.writeFileSync(file, JSON.stringify({ sandbox }))
    else fs.rmSync(file, { force: true })
  }
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sandbox-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })
  const deps = (over: Partial<DispatcherDeps> = {}): Partial<DispatcherDeps> => ({
    loadEngineConfig: (engine) => (engine === 'claude' ? claudeConfig : {}),
    ...over
  })

  afterEach(() => {
    saveSettings({})
    resetCachedClaudeModels()
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir
    fs.rmSync(configDir, { recursive: true, force: true })
  })

  it('sandbox on: one --settings JSON carries it, required to start, beside the switches and the rules', async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-sbx-1'))
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    writeSandbox(sandboxOn())
    const dispatcher = makeDispatcher(
      makeFakeDispatchLedger(),
      deps({
        loadUserRules: () => ({
          allow: ['Bash(npm test:*)'],
          deny: ['Bash(rm -rf:*)'],
          ask: ['Bash(git push:*)'],
          additionalDirectories: [],
          defaultMode: undefined
        })
      })
    )

    await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())

    const { args, options } = spawnOf(0)
    const settings = flagSettings(args)
    expect(settings.sandbox).toStrictEqual({
      // The validated user block at flag priority (a key the page does not know is not carried;
      // a switch the block does not state stays absent)...
      enabled: true,
      excludedCommands: ['docker'],
      network: { allowedDomains: ['example.com'], allowLocalBinding: false },
      filesystem: { allowWrite: ['/data'], denyRead: ['~/.ssh'] },
      // ...required to start where the sandbox cannot run, instead of running the agent's
      // commands unsandboxed, and never auto-approved.
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false
    })
    // The same flag block the spawn option carries, not a second copy of it.
    expect(options.sandbox).toStrictEqual(settings.sandbox)
    // Nothing else moved: the switches, the deny and ask rules (never the allow rules), no
    // settings source, and no server of the host's tools.
    expect(settings.idleCompaction).toBe(false)
    expect(settings.enabledPlugins).toEqual({ 'cc-plugin-privacy@builtin': true })
    expect(settings.permissions).toEqual({ deny: ['Bash(rm -rf:*)'], ask: ['Bash(git push:*)'] })
    expect(args).toContain('--setting-sources=')
    expect(flagValue(args, '--permission-mode')).toBe('default')
    expect(Object.keys(options.mcpServers ?? {})).toEqual([])
  })

  // cli.js lets a sandboxed command run unasked when this switch is on, and reads an ABSENT
  // key as on. A target's Bash would then pass by its approval card, cli.js's classifier
  // and the host's deny/ask matcher; and cli.js suspends the switch in plan mode, which a
  // target never runs in, so a plan-mode parent's agent would run what a plan-mode session asks.
  it('never auto-approves sandboxed commands, whatever the engine setting and the parent mode', async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-sbx-2'))
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    writeSandbox(sandboxOn({ autoAllowBashIfSandboxed: true }))

    for (const mode of ['default', 'plan', 'acceptEdits', 'auto', 'bypassPermissions']) {
      const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())
      await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx(mode))
      const { args } = spawnOf(mocks.query.mock.calls.length - 1)
      const sandbox = flagSettings(args).sandbox as Record<string, unknown>
      expect(sandbox, mode).toHaveProperty('autoAllowBashIfSandboxed', false)
      expect(sandbox.enabled, mode).toBe(true)
    }
    // A plan-mode parent's agent asks for everything (`plan` maps to `default`).
    expect(flagValue(spawnOf(1).args, '--permission-mode')).toBe('default')
  })

  it('switch off or never set: no sandbox reaches cli.js, and never an explicit enabled false', async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-sbx-3'))

    for (const sandbox of [undefined, sandboxOn({ enabled: false })]) {
      claudeConfig = { dispatch: { defaultModel: 'haiku' } }
      writeSandbox(sandbox)
      const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())
      await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())
      const { args, options } = spawnOf(mocks.query.mock.calls.length - 1)
      expect(options).not.toHaveProperty('sandbox')
      expect(flagSettings(args)).not.toHaveProperty('sandbox')
    }
  })

  it('a target resumed after the setting changed runs under the setting of that moment', async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-sbx-4'))
    const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())
    const resume = async (sessionId: string): Promise<Record<string, unknown>> => {
      dispatcher.disposeFor('parent-A')
      await dispatcher.dispatch({ engine: 'claude', prompt: 'again', sessionId }, ctx())
      const { args, options } = spawnOf(mocks.query.mock.calls.length - 1)
      expect(options.resume).toBe('claude-sbx-4')
      return flagSettings(args)
    }

    // Created with the sandbox off…
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    const first = await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())
    expect(flagSettings(spawnOf(0).args)).not.toHaveProperty('sandbox')

    // …switched on before its next run: the resumed process is sandboxed…
    writeSandbox(sandboxOn())
    expect((await resume(first.sessionId)).sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true
    })

    // …and switched off again: the next one is not.
    writeSandbox(sandboxOn({ enabled: false }))
    expect(await resume(first.sessionId)).not.toHaveProperty('sandbox')
  })

  it("starts at the user's saved starting effort for the model, re-read at a resume", async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-eff-1'))
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    // No `claudeTargetEffort` injected: the real resolver, on the settings core reads.
    const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())

    saveSettings({ modelEffortDefaults: { haiku: 'low' } })
    const first = await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())
    expect(flagValue(spawnOf(0).args, '--effort')).toBe('low')

    saveSettings({ modelEffortDefaults: { haiku: 'high' } })
    dispatcher.disposeFor('parent-A')
    await dispatcher.dispatch(
      { engine: 'claude', prompt: 'two', sessionId: first.sessionId },
      ctx()
    )
    expect(flagValue(spawnOf(1).args, '--effort')).toBe('high')
  })

  it('sends no --effort when the resolver has none, and the one it is given otherwise', async () => {
    mocks.query.mockReset()
    mocks.query.mockImplementation(() => oneTurnProcess('claude-eff-2'))
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    const claudeTargetEffort = vi.fn((): 'xhigh' | undefined => undefined)
    const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps({ claudeTargetEffort }))

    await dispatcher.dispatch({ engine: 'claude', prompt: 'one', model: 'sonnet' }, ctx())
    expect(claudeTargetEffort).toHaveBeenCalledWith('sonnet')
    expect(spawnOf(0).args).not.toContain('--effort')

    claudeTargetEffort.mockReturnValue('xhigh')
    await dispatcher.dispatch({ engine: 'claude', prompt: 'two', model: 'sonnet' }, ctx())
    expect(flagValue(spawnOf(1).args, '--effort')).toBe('xhigh')
  })

  // Where the sandbox cannot run, cli.js refuses to start and says why on stderr only. The
  // run must report that reason: "exited with code=1" alone reads as a crash to retry.
  it('a process that refuses to start fails the dispatch with what it wrote to stderr', async () => {
    mocks.query.mockReset()
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    writeSandbox(sandboxOn())
    mocks.query.mockImplementation((input: { options: QueryOptions }) => {
      input.options.stderr?.(
        Buffer.from('[Voice:Patch] ready\nError: sandbox required but unavailable: bubblewrap\n')
      )
      const iterator: AsyncIterator<SDKMessage> = {
        next: () => Promise.reject(new Error('cli.js exited with code=1 signal=null')),
        return: async () => ({ value: undefined, done: true })
      }
      return { [Symbol.asyncIterator]: () => iterator } as unknown as QueryHandle
    })
    const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())

    const result = await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())

    expect(result.isError).toBe(true)
    expect(result.text).toContain('cli.js exited with code=1')
    expect(result.text).toContain('sandbox required but unavailable: bubblewrap')
    expect(result.text).not.toContain('Voice:Patch')
  })

  it('a process that just ends is reported the same way, with only its last stderr lines, cut short', async () => {
    mocks.query.mockReset()
    claudeConfig = { dispatch: { defaultModel: 'haiku' } }
    mocks.query.mockImplementation((input: { options: QueryOptions }) => {
      const lines = Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, '0')} noise`)
      lines[19] += 'x'.repeat(600)
      input.options.stderr?.(Buffer.from(lines.join('\n')))
      const iterator: AsyncIterator<SDKMessage> = {
        next: () => Promise.resolve({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true })
      }
      return { [Symbol.asyncIterator]: () => iterator } as unknown as QueryHandle
    })
    const dispatcher = makeDispatcher(makeFakeDispatchLedger(), deps())

    const result = await dispatcher.dispatch({ engine: 'claude', prompt: 'one' }, ctx())

    expect(result.isError).toBe(true)
    expect(result.text).toContain('ended unexpectedly')
    // Twelve lines of at most 400 characters: enough to say why, bounded whatever it wrote.
    expect(result.text).not.toContain('L08 noise')
    expect(result.text).toContain('L09 noise')
    expect(result.text).toContain('L20 noise')
    expect(result.text).not.toContain('x'.repeat(400))
  })
})

/** The real resolver behind `--effort` (ADR-116): a new Claude session's starting effort. */
describe('defaultClaudeTargetEffort', () => {
  const row = (value: string, resolvedModel: string): ModelInfo => ({
    value,
    resolvedModel,
    displayName: value,
    description: '',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  })

  afterEach(() => {
    saveSettings({})
    resetCachedClaudeModels()
  })

  it("is the saved starting effort for the model, else the model's own default", () => {
    expect(defaultClaudeTargetEffort('haiku')).toBe('medium')
    saveSettings({ modelEffortDefaults: { haiku: 'low' } })
    expect(defaultClaudeTargetEffort('haiku')).toBe('low')
    // Another model's saved effort is not this one's.
    expect(defaultClaudeTargetEffort('sonnet')).toBe('medium')
  })

  it('is clamped to what the model accepts, and nothing for a model that takes no effort', () => {
    saveSettings({
      modelEffortDefaults: { 'claude-sonnet-4-6': 'xhigh', 'claude-haiku-4-5': 'high' }
    })
    // Sonnet 4.6 has no xhigh: its own default instead of a level cli.js would reject.
    expect(defaultClaudeTargetEffort('claude-sonnet-4-6')).toBe('high')
    expect(defaultClaudeTargetEffort('claude-haiku-4-5')).toBeUndefined()
  })

  it('`default` is judged only on the row cli.js reported for it: none without the catalog', () => {
    saveSettings({ modelEffortDefaults: { opus: 'high' } })
    // No catalog yet: which model `default` runs on is unknown, so cli.js's own default stands.
    expect(defaultClaudeTargetEffort('default')).toBeUndefined()

    setCachedClaudeModels([row('default', 'claude-opus-5-5'), row('opus', 'claude-opus-5-5')])
    // With it, `default` shares the saved effort of the alias it resolves to.
    expect(defaultClaudeTargetEffort('default')).toBe('high')
  })
})
