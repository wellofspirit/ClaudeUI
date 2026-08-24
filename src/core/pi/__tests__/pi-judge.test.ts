/**
 * @vitest-environment node
 *
 * Unit tests for the pi auto-mode judge transport (pi-judge.ts) against a FAKE
 * PiRpcClient — no pi binary spawned. The behaviours under test are the ones
 * that make the warm-process design safe rather than merely cheap: the policy
 * rides `--system-prompt` at SPAWN, statelessness comes from `new_session`
 * between calls, and every failure retires the process and THROWS (so
 * `classify()` marks the verdict unavailable and the wiring asks the human).
 */
import { describe, it, expect } from 'vitest'
import type { PiEvent, PiRpcCommand, PiRpcResponse } from '../pi-protocol'
import { PiJudge, PI_JUDGE_BASE_ARGS, type PiJudgeClient } from '../pi-judge'

interface FakeOptions {
  /** Assistant texts returned by successive `get_last_assistant_text` calls. */
  replies?: string[]
  /** `prompt` resolves `{success:false}` instead of succeeding. */
  rejectPrompt?: boolean
  /** `new_session` resolves `{success:true,data:{cancelled:true}}`. */
  cancelReset?: boolean
  /** `start()` rejects. */
  startError?: Error
  /** Awaited inside `get_last_assistant_text`, to hold a call open. */
  hold?: Promise<void>
}

interface FakeClient extends PiJudgeClient {
  args: string[]
  calls: string[]
  disposeCalls: number
  fireExit: () => void
}

/** A fake pi RPC child: records every command, settles the agent on `prompt`. */
function makeFake(
  bin: string,
  opts: { cwd: string; args: string[] },
  cfg: FakeOptions
): FakeClient {
  const eventHandlers: Array<(ev: PiEvent) => void> = []
  const exitHandlers: Array<() => void> = []
  const replies = [...(cfg.replies ?? ['<block>no</block>'])]
  const calls: string[] = []
  const fake: FakeClient = {
    args: opts.args,
    calls,
    disposeCalls: 0,
    start: () => (cfg.startError ? Promise.reject(cfg.startError) : Promise.resolve()),
    request: (async (cmd: PiRpcCommand): Promise<PiRpcResponse<unknown>> => {
      calls.push(cmd.type)
      switch (cmd.type) {
        case 'prompt':
          // Settle asynchronously — the listener is registered before the
          // prompt is sent, exactly as the real transport requires.
          queueMicrotask(() => {
            for (const h of [...eventHandlers]) h({ type: 'agent_settled' } as PiEvent)
          })
          return { type: 'response', command: 'prompt', success: !cfg.rejectPrompt }
        case 'get_last_assistant_text': {
          if (cfg.hold) await cfg.hold
          const text = replies.shift()
          return {
            type: 'response',
            command: cmd.type,
            success: true,
            data: text === undefined ? {} : { text }
          }
        }
        case 'new_session':
          return {
            type: 'response',
            command: 'new_session',
            success: true,
            data: { cancelled: !!cfg.cancelReset }
          }
        default:
          return { type: 'response', command: cmd.type, success: true }
      }
    }) as PiJudgeClient['request'],
    onEvent: (cb) => {
      eventHandlers.push(cb)
      return () => {
        const i = eventHandlers.indexOf(cb)
        if (i >= 0) eventHandlers.splice(i, 1)
      }
    },
    onExit: (cb) => {
      exitHandlers.push(() => cb(0, null))
      return () => {}
    },
    dispose: () => {
      fake.disposeCalls++
    },
    fireExit: () => {
      for (const h of exitHandlers) h()
    }
  }
  void bin
  return fake
}

function makeJudge(
  cfg: FakeOptions = {},
  model: { vendorId: string; modelId: string } | null = {
    vendorId: 'openai-codex',
    modelId: 'gpt-5.4-mini'
  }
) {
  const spawned: FakeClient[] = []
  const judge = new PiJudge({
    cwd: '/cwd',
    resolveModel: () => model,
    locateBinary: () => '/fake/pi',
    createClient: (bin, opts) => {
      const fake = makeFake(bin, opts, cfg)
      spawned.push(fake)
      return fake
    },
    timeoutMs: 2_000
  })
  return { judge, spawned }
}

const REQ = { system: 'POLICY-A', user: 'judge this' }

describe('PiJudge — spawn shape', () => {
  it('carries the classifier system prompt on --system-prompt, with tools and every discovery source off', async () => {
    const { judge, spawned } = makeJudge()

    await expect(judge.transport(REQ)).resolves.toBe('<block>no</block>')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toEqual([...PI_JUDGE_BASE_ARGS, '--system-prompt', 'POLICY-A'])
    // The flags that make the judge un-injectable and un-armed. `--no-tools`
    // means no tool is ever registered; `--no-context-files` keeps the repo's
    // own AGENTS.md/CLAUDE.md — writable by the agent under judgement — out of
    // the judge's system prompt (pi appends them to --system-prompt otherwise).
    expect(spawned[0].args).toEqual(
      expect.arrayContaining([
        '--no-tools',
        '--no-session',
        '--no-context-files',
        '--no-skills',
        '--no-extensions'
      ])
    )
  })

  it('applies the resolved judge model, best-effort (a set_model failure never fails the call)', async () => {
    const { judge, spawned } = makeJudge()
    await judge.transport(REQ)
    expect(spawned[0].calls).toContain('set_model')

    const boom = new PiJudge({
      cwd: '/cwd',
      resolveModel: () => ({ vendorId: 'v', modelId: 'm' }),
      locateBinary: () => '/fake/pi',
      createClient: (bin, opts) => {
        const fake = makeFake(bin, opts, {})
        const inner = fake.request
        fake.request = ((cmd: PiRpcCommand) =>
          cmd.type === 'set_model'
            ? Promise.reject(new Error('nope'))
            : inner(cmd)) as PiJudgeClient['request']
        return fake
      }
    })
    await expect(boom.transport(REQ)).resolves.toBe('<block>no</block>')
  })

  it('throws when the pi binary cannot be located (→ unavailable → the human decides)', async () => {
    const judge = new PiJudge({ cwd: '/cwd', resolveModel: () => null, locateBinary: () => null })
    await expect(judge.transport(REQ)).rejects.toThrow(/binary not found/)
  })
})

describe('PiJudge — warm reuse and statelessness', () => {
  it('reuses ONE process across calls, resetting with new_session between them but not before the first', async () => {
    const { judge, spawned } = makeJudge({ replies: ['<block>no</block>', '<block>yes</block>'] })

    await expect(judge.transport(REQ)).resolves.toBe('<block>no</block>')
    // Nothing to reset on a freshly spawned process.
    expect(spawned[0].calls.filter((c) => c === 'new_session')).toHaveLength(0)

    await expect(judge.transport(REQ)).resolves.toBe('<block>yes</block>')
    expect(spawned).toHaveLength(1)
    // The reset precedes the second prompt — the judge must never see call 1.
    expect(spawned[0].calls).toEqual([
      'set_model',
      'prompt',
      'get_last_assistant_text',
      'new_session',
      'prompt',
      'get_last_assistant_text'
    ])
  })

  it('respawns when the system prompt changes (an environment update rewrites the policy)', async () => {
    const { judge, spawned } = makeJudge({ replies: ['<block>no</block>', '<block>no</block>'] })

    await judge.transport({ system: 'POLICY-A', user: 'u1' })
    await judge.transport({ system: 'POLICY-B', user: 'u2' })

    expect(spawned).toHaveLength(2)
    expect(spawned[0].disposeCalls).toBe(1)
    expect(spawned[1].args.at(-1)).toBe('POLICY-B')
  })

  it('respawns rather than reuses when new_session reports the reset was cancelled', async () => {
    const { judge, spawned } = makeJudge({ cancelReset: true, replies: ['a', 'b'] })

    await judge.transport(REQ)
    await judge.transport(REQ)

    expect(spawned).toHaveLength(2)
    expect(spawned[0].disposeCalls).toBe(1)
    expect(spawned[1].calls).toEqual(['set_model', 'prompt', 'get_last_assistant_text'])
  })

  it('forgets a process that exited on its own — the next call spawns instead of writing to a dead child', async () => {
    const { judge, spawned } = makeJudge({ replies: ['a', 'b'] })
    await judge.transport(REQ)
    spawned[0].fireExit()

    await judge.transport(REQ)
    expect(spawned).toHaveLength(2)
  })
})

describe('PiJudge — failure handling (fail to the human, never a fabricated verdict)', () => {
  it('throws and retires the process when the prompt is rejected', async () => {
    const { judge, spawned } = makeJudge({ rejectPrompt: true })

    await expect(judge.transport(REQ)).rejects.toThrow(/prompt was rejected/)
    expect(spawned[0].disposeCalls).toBe(1)
  })

  it('throws and retires the process when no assistant text comes back', async () => {
    const { judge, spawned } = makeJudge({ replies: [] })

    await expect(judge.transport(REQ)).rejects.toThrow(/no assistant text/)
    expect(spawned[0].disposeCalls).toBe(1)
  })

  it('a failed call does not poison the queue — the next call spawns fresh and succeeds', async () => {
    const spawned: FakeClient[] = []
    let first = true
    const judge = new PiJudge({
      cwd: '/cwd',
      resolveModel: () => null,
      locateBinary: () => '/fake/pi',
      createClient: (bin, opts) => {
        const fake = makeFake(
          bin,
          opts,
          first ? { rejectPrompt: true } : { replies: ['<block>no</block>'] }
        )
        first = false
        spawned.push(fake)
        return fake
      }
    })

    await expect(judge.transport(REQ)).rejects.toThrow()
    await expect(judge.transport(REQ)).resolves.toBe('<block>no</block>')
    expect(spawned).toHaveLength(2)
  })

  it('times out a wedged call, retires the process, and throws', async () => {
    let release = (): void => {}
    const hold = new Promise<void>((r) => {
      release = r
    })
    const spawned: FakeClient[] = []
    const judge = new PiJudge({
      cwd: '/cwd',
      resolveModel: () => null,
      locateBinary: () => '/fake/pi',
      createClient: (bin, opts) => {
        const fake = makeFake(bin, opts, { hold })
        spawned.push(fake)
        return fake
      },
      timeoutMs: 20
    })

    await expect(judge.transport(REQ)).rejects.toThrow(/timed out/)
    expect(spawned[0].disposeCalls).toBe(1)
    release()
  })

  it('rejects every call after dispose()', async () => {
    const { judge, spawned } = makeJudge()
    await judge.transport(REQ)
    judge.dispose()

    await expect(judge.transport(REQ)).rejects.toThrow(/disposed/)
    expect(spawned[0].disposeCalls).toBe(1)
  })
})

describe('PiJudge — concurrency', () => {
  it('serializes overlapping calls so two approvals never share one conversation', async () => {
    const order: string[] = []
    const spawned: FakeClient[] = []
    const judge = new PiJudge({
      cwd: '/cwd',
      resolveModel: () => null,
      locateBinary: () => '/fake/pi',
      createClient: (bin, opts) => {
        const fake = makeFake(bin, opts, { replies: ['one', 'two'] })
        const inner = fake.request
        fake.request = (async (cmd: PiRpcCommand) => {
          if (cmd.type === 'prompt') order.push(`start:${String(cmd.message)}`)
          const r = await inner(cmd)
          if (cmd.type === 'get_last_assistant_text') order.push('end')
          return r
        }) as PiJudgeClient['request']
        spawned.push(fake)
        return fake
      }
    })

    const [a, b] = await Promise.all([
      judge.transport({ system: 'POLICY-A', user: 'first' }),
      judge.transport({ system: 'POLICY-A', user: 'second' })
    ])

    expect([a, b]).toEqual(['one', 'two'])
    // Strictly interleaved would be start,start,end,end — this asserts the
    // second prompt only goes out after the first call has fully finished.
    expect(order).toEqual(['start:first', 'end', 'start:second', 'end'])
    expect(spawned).toHaveLength(1)
  })
})

describe('PiJudge — advisory request fields', () => {
  it("ignores maxTokens/stopSequences (pi's prompt RPC exposes neither) without failing", async () => {
    const { judge, spawned } = makeJudge()
    await expect(
      judge.transport({ ...REQ, maxTokens: 64, stopSequences: ['</block>'] })
    ).resolves.toBe('<block>no</block>')
    const promptCmd = spawned[0].calls.filter((c) => c === 'prompt')
    expect(promptCmd).toHaveLength(1)
  })
})

describe('PiJudge — the judge process is never given a tool', () => {
  it('spawn args contain no -e extension and no --tools allowlist', async () => {
    const { judge, spawned } = makeJudge()
    await judge.transport(REQ)
    expect(spawned[0].args).not.toContain('-e')
    expect(spawned[0].args).not.toContain('--tools')
  })
})
