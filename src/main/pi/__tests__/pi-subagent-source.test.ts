/**
 * @vitest-environment node
 *
 * Tests for the PI_SUBAGENT_EXTENSION_SOURCE string constant (M5b).
 *
 * String tripwires (cheap, no execution) guard against accidental edits that
 * would break pi's loader (e.g. adding a non-`node:` import) or leak the
 * approval-bridge secrets into a file that has no business referencing them.
 *
 * Behavioral harness — TEST-SEAM CHOICE (see kickoff spec): unlike
 * pi-bridge-source.ts (import-free, testable via `new Function(...)`), this
 * extension genuinely needs real ESM `import` statements
 * (`node:child_process`/`node:fs`/`node:os`/`node:path`) — `new Function()`
 * cannot parse `import`/`export` syntax. Instead: (1) write
 * PI_SUBAGENT_EXTENSION_SOURCE to a real temp `.ts` file on disk (exactly
 * what `writeSubagentExtension()` does in product code), (2) hoisted
 * `vi.mock('node:child_process', ...)` replaces `spawn` for the whole test
 * module graph — Vitest's module runner intercepts every `import` specifier
 * during a test file's run, including ones resolved via a dynamic
 * `import(absolutePath)` of a file outside the project tree, so the
 * dynamically-imported extension module's own `import { spawn } from
 * 'node:child_process'` binds to the SAME mock this file configures — (3)
 * `await import(tempFilePath)` loads the real source (transformed by
 * Vitest's own esbuild/vite-node pipeline, not pi's jiti — a close enough
 * proxy since the source is plain ES2015-ish JS/TS with no advanced-TS
 * syntax) and its `.default` is the `(pi) => void` factory, called directly
 * against a fake `pi` object. This is NOT a substitute for the gated
 * integration test (spawns the REAL binary) — it proves the extension's OWN
 * logic (discovery, delta streaming, abort, cleanup), not the wire.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PI_SUBAGENT_EXTENSION_SOURCE, PI_SUBAGENT_VERSION } from '../pi-subagent-source'

// ---------------------------------------------------------------------------
// String tripwires
// ---------------------------------------------------------------------------

describe('PI_SUBAGENT_EXTENSION_SOURCE — string tripwires', () => {
  it('has a non-empty version string', () => {
    expect(typeof PI_SUBAGENT_VERSION).toBe('string')
    expect(PI_SUBAGENT_VERSION.length).toBeGreaterThan(0)
  })

  it('exports a default function', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toMatch(/export default function/)
  })

  it('is inert (returns early) when CLAUDEUI_PI_SUBAGENTS is not "1"', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toMatch(/if \(process\.env\.CLAUDEUI_PI_SUBAGENTS !== '1'\) return/)
  })

  it('does not register when zero agents are discovered', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toMatch(/if \(agents\.length === 0\) return/)
  })

  it('imports ONLY node: builtins — no npm deps, no relative imports (tripwire)', () => {
    const importLines = PI_SUBAGENT_EXTENSION_SOURCE.split('\n').filter((l) => /^\s*import\s/.test(l))
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line).toMatch(/from 'node:[a-z_]+';?$/)
    }
  })

  it('never references the approval-bridge URL/token env vars (security tripwire)', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain('CLAUDEUI_PI_BRIDGE_URL')
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain('CLAUDEUI_PI_BRIDGE_TOKEN')
  })

  it('never references the OTHER capability-gate env vars either (this extension is fully independent)', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain('CLAUDEUI_PI_HOSTED_TOOLS')
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain('CLAUDEUI_PI_DISPATCH_ENABLED')
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain('CLAUDEUI_PI_PLAN_TOOLS')
  })

  it('references its own two env vars', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_SUBAGENTS')
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_AGENTS_DIR')
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toContain('CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL')
  })

  it('spawns children with NO -e flag of its own (recursion tripwire)', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toMatch(/args\.push\(\s*['"]-e['"]/)
    expect(PI_SUBAGENT_EXTENSION_SOURCE).not.toContain("'-e'")
  })

  it('registers exactly the "subagent" tool name', () => {
    expect(PI_SUBAGENT_EXTENSION_SOURCE).toMatch(/name:\s*'subagent'/)
  })
})

// ---------------------------------------------------------------------------
// Behavioral harness
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

// fs is mocked as a PASSTHROUGH with a per-test existsSync override seam —
// needed by the getPiInvocation bun-virtual tests below: on the REAL vendored
// pi.exe, bun patches fs so `fs.existsSync('B:/~BUN/root/pi.exe')` returns
// TRUE for its virtual filesystem (probed on this machine — see the source's
// getPiInvocation comment), which is exactly why an existsSync check alone
// cannot filter the virtual path out and the tests must reproduce that
// behavior. Every other fs call (discovery readdir/readFile, temp-prompt
// mkdtemp/write/unlink, this file's own fixture helpers) passes through to
// the real implementation, so all other tests are unaffected.
const fsCtl = vi.hoisted(() => ({ existsTrueFor: new Set<string>() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: actual,
    existsSync: (p: unknown) => (fsCtl.existsTrueFor.has(String(p)) ? true : actual.existsSync(p as never))
  }
})

// Imported AFTER the mock declaration (hoisted anyway) so this binding is
// the SAME mocked function the dynamically-imported extension module uses.
import { spawn } from 'node:child_process'
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>

/** Minimal fake ChildProcess double — stdout/stderr are plain EventEmitters (the extension only calls `.on('data', ...)` on them), `proc` itself is an EventEmitter for 'close'/'error'. */
class FakeChildProcess extends EventEmitter {
  pid = 4242
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill(_signal?: string): boolean {
    this.killed = true
    return true
  }
}

interface FakeToolDef {
  name: string
  label: string
  description: string
  parameters: unknown
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: { content: unknown; details: unknown }) => void) | undefined
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>
}

interface FakePi {
  registerTool: (def: FakeToolDef) => void
}

function makeFakePi(): { pi: FakePi; tools: Map<string, FakeToolDef> } {
  const tools = new Map<string, FakeToolDef>()
  return { pi: { registerTool: (def) => tools.set(def.name, def) }, tools }
}

/** Write PI_SUBAGENT_EXTENSION_SOURCE to a fresh temp .ts file and dynamically import it — see file header for why this is the chosen seam. Cached across the whole suite (the factory itself is stateless; per-call state lives in the function body, re-created fresh on every `factory(pi)` invocation). */
let factory: (pi: FakePi) => void
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-source-test-'))
  const file = join(dir, 'claudeui-subagent.ts')
  writeFileSync(file, PI_SUBAGENT_EXTENSION_SOURCE, 'utf-8')
  const mod = (await import(/* @vite-ignore */ file)) as { default: (pi: FakePi) => void }
  factory = mod.default
})

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) prev[k] = process.env[k]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function writeAgentFixture(dir: string, filename: string, frontmatter: Record<string, string>, body: string): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n${body}\n`, 'utf-8')
}

function assistantMsg(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 }
    },
    stopReason: 'stop',
    timestamp: 1000,
    ...overrides
  }
}

function toolResultMsg(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'toolResult',
    toolCallId: 'child-call-1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: 1000,
    ...overrides
  }
}

function jsonLine(event: Record<string, unknown>): string {
  return JSON.stringify(event) + '\n'
}

beforeAll(() => {
  // Ensures a clean, deterministic mock across the whole behavioral suite —
  // each `it` configures its own spawn implementation.
})

afterEach(() => {
  mockSpawn.mockReset()
})

describe('discovery', () => {
  it('CLAUDEUI_PI_SUBAGENTS unset → registers nothing at all (fully inert)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes the task' }, 'You echo tasks.')
    withEnv({ CLAUDEUI_PI_SUBAGENTS: undefined, CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      expect(tools.size).toBe(0)
    })
  })

  it('zero .md agents in the dir → does not register the subagent tool (no prompt pollution)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-empty-'))
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      expect(tools.has('subagent')).toBe(false)
    })
  })

  it('a nonexistent agents dir behaves like zero agents (no throw)', () => {
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: join(tmpdir(), 'does-not-exist-' + Date.now()) }, () => {
      const { pi, tools } = makeFakePi()
      expect(() => factory(pi)).not.toThrow()
      expect(tools.has('subagent')).toBe(false)
    })
  })

  it('discovers agents and lists them (name + description) in the tool description', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-list-'))
    writeAgentFixture(dir, 'scout.md', { name: 'scout', description: 'Fast recon' }, 'Body A')
    writeAgentFixture(
      dir,
      'planner.md',
      { name: 'planner', description: 'Makes plans', model: 'anthropic/claude-sonnet-5', tools: 'read, grep' },
      'Body B'
    )
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const tool = tools.get('subagent')!
      expect(tool.description).toContain('scout')
      expect(tool.description).toContain('Fast recon')
      expect(tool.description).toContain('planner')
      expect(tool.description).toContain('Makes plans')
    })
  })

  it('an agent .md with missing optional fields (no model, no tools) is still discovered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-bare-'))
    writeAgentFixture(dir, 'bare.md', { name: 'bare', description: 'A bare agent' }, 'Bare system prompt.')
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      expect(tools.get('subagent')!.description).toContain('bare')
    })
  })

  it('an .md file missing "name" or "description" is skipped (not counted as a discovered agent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-invalid-'))
    writeFileSync(join(dir, 'no-name.md'), '---\ndescription: missing name\n---\nbody\n', 'utf-8')
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      // Only the invalid file present -> zero VALID agents -> no registration.
      expect(tools.has('subagent')).toBe(false)
    })
  })
})

describe('schema shape', () => {
  it('parameters is a plain JSON-schema object literal with agent/task/tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-schema-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Echo body')
    withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const tool = tools.get('subagent')!
      expect(tool.parameters).toMatchObject({
        type: 'object',
        properties: {
          agent: { type: 'string' },
          task: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { agent: { type: 'string' }, task: { type: 'string' } },
              required: ['agent', 'task']
            }
          }
        }
      })
    })
  })
})

describe('single-task flow — delta-correct cuiSubagent streaming', () => {
  it('emits ONLY the newly-arrived message on each update (delta, not cumulative), then a final done result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-single-'))
    writeAgentFixture(
      dir,
      'echoer.md',
      { name: 'echoer', description: 'Echoes', model: 'anthropic/claude-haiku-4-5', tools: 'read' },
      'You echo the task.'
    )

    let capturedArgs: string[] = []
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args
      return fakeProc
    })

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const tool = tools.get('subagent')!

      const updates: Array<{ content: unknown; details: unknown }> = []
      const onUpdate = vi.fn((partial: { content: unknown; details: unknown }) => updates.push(partial))

      const execPromise = tool.execute('call-1', { agent: 'echoer', task: 'say hi' }, undefined, onUpdate)

      // spawn() runs synchronously inside execute()'s pre-await portion.
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      expect(capturedArgs).toContain('--model')
      expect(capturedArgs).toContain('anthropic/claude-haiku-4-5')
      expect(capturedArgs).toContain('--tools')
      expect(capturedArgs).toContain('read')
      expect(capturedArgs).toContain('Task: say hi')

      const assistant1 = assistantMsg('thinking...')
      fakeProc.stdout.emit('data', Buffer.from(jsonLine({ type: 'message_end', message: assistant1 })))

      // First update: exactly ONE new message (the assistant one), status running.
      expect(updates).toHaveLength(1)
      const firstAgents = (updates[0].details as { cuiSubagent: { agents: Array<Record<string, unknown>> } })
        .cuiSubagent.agents
      expect(firstAgents).toHaveLength(1)
      expect(firstAgents[0].status).toBe('running')
      expect(firstAgents[0].newMessages).toEqual([assistant1])

      const toolResult1 = toolResultMsg('file contents')
      fakeProc.stdout.emit('data', Buffer.from(jsonLine({ type: 'tool_result_end', message: toolResult1 })))

      // Second update: DELTA — only the tool result, NOT the assistant message again.
      expect(updates).toHaveLength(2)
      const secondAgents = (updates[1].details as { cuiSubagent: { agents: Array<Record<string, unknown>> } })
        .cuiSubagent.agents
      expect(secondAgents[0].newMessages).toEqual([toolResult1])
      expect(secondAgents[0].newMessages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'assistant' })])
      )

      const assistant2 = assistantMsg('final answer', {
        usage: {
          input: 20,
          output: 15,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0.002, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.006 }
        }
      })
      fakeProc.stdout.emit('data', Buffer.from(jsonLine({ type: 'message_end', message: assistant2 })))
      expect(updates).toHaveLength(3)
      const thirdAgents = (updates[2].details as { cuiSubagent: { agents: Array<Record<string, unknown>> } })
        .cuiSubagent.agents
      expect(thirdAgents[0].newMessages).toEqual([assistant2])

      fakeProc.emit('close', 0)
      const result = await execPromise

      expect(result.isError).toBeFalsy()
      expect(result.content[0].text).toContain('final answer')
      const finalAgents = (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } }).cuiSubagent
        .agents
      expect(finalAgents).toHaveLength(1)
      expect(finalAgents[0].status).toBe('done')
      // Final return's newMessages are empty — everything was already
      // delta-streamed through onUpdate; usage is the FULL accumulated total.
      expect(finalAgents[0].newMessages).toEqual([])
      expect(finalAgents[0].usage).toMatchObject({ input: 30, output: 20, turns: 2 })
      expect(finalAgents[0].usage).toHaveProperty('cost')
      expect((finalAgents[0].usage as { cost: number }).cost).toBeCloseTo(0.009, 5)
    })
  })

  it('an unknown agent name resolves to a single error-status agent slot with no spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-unknown-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Echo body')

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const tool = tools.get('subagent')!
      const result = await tool.execute('call-2', { agent: 'ghost', task: 'x' }, undefined, undefined)
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(result.isError).toBe(true)
      const agents = (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } }).cuiSubagent
        .agents
      expect(agents[0]).toMatchObject({ agent: 'ghost', status: 'error' })
    })
  })

  it('provides neither {agent,task} nor {tasks} -> isError, no spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-neither-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Echo body')
    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const result = await tools.get('subagent')!.execute('call-3', {}, undefined, undefined)
      expect(result.isError).toBe(true)
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  it('provides BOTH {agent,task} AND {tasks} -> isError (mirrors the example\'s "exactly one mode" rule)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-both-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Echo body')
    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const result = await tools
        .get('subagent')!
        .execute('call-4', { agent: 'echoer', task: 'x', tasks: [{ agent: 'echoer', task: 'y' }] }, undefined, undefined)
      expect(result.isError).toBe(true)
      expect(mockSpawn).not.toHaveBeenCalled()
    })
  })

  it('an agent with no model/tools frontmatter omits --model/--tools unless CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL is set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-bare-args-'))
    writeAgentFixture(dir, 'bare.md', { name: 'bare', description: 'Bare' }, '')
    let capturedArgs: string[] = []
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args
      return fakeProc
    })

    await withEnv(
      { CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir, CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL: undefined },
      async () => {
        const { pi, tools } = makeFakePi()
        factory(pi)
        const execPromise = tools.get('subagent')!.execute('call-5', { agent: 'bare', task: 'x' }, undefined, undefined)
        expect(capturedArgs).not.toContain('--model')
        expect(capturedArgs).not.toContain('--tools')
        // No systemPrompt body (empty) -> no --append-system-prompt either.
        expect(capturedArgs).not.toContain('--append-system-prompt')
        fakeProc.emit('close', 0)
        await execPromise
      }
    )
  })

  it('falls back to CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL when the agent has no model of its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-default-model-'))
    writeAgentFixture(dir, 'bare.md', { name: 'bare', description: 'Bare' }, '')
    let capturedArgs: string[] = []
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args
      return fakeProc
    })

    await withEnv(
      { CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir, CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL: 'openai/gpt-5' },
      async () => {
        const { pi, tools } = makeFakePi()
        factory(pi)
        const execPromise = tools.get('subagent')!.execute('call-6', { agent: 'bare', task: 'x' }, undefined, undefined)
        expect(capturedArgs).toContain('--model')
        expect(capturedArgs).toContain('openai/gpt-5')
        fakeProc.emit('close', 0)
        await execPromise
      }
    )
  })
})

describe('parallel tasks — interleaving', () => {
  it('two agents update independently — each newMessages delta stays scoped to its OWN slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-parallel-'))
    writeAgentFixture(dir, 'scout.md', { name: 'scout', description: 'Scout' }, 'Scout body')
    writeAgentFixture(dir, 'planner.md', { name: 'planner', description: 'Planner' }, 'Planner body')

    const procs: FakeChildProcess[] = []
    mockSpawn.mockImplementation(() => {
      const p = new FakeChildProcess()
      procs.push(p)
      return p
    })

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const updates: Array<{ details: { cuiSubagent: { agents: Array<Record<string, unknown>> } } }> = []
      const onUpdate = vi.fn((partial: unknown) => updates.push(partial as (typeof updates)[number]))

      const execPromise = tools.get('subagent')!.execute(
        'call-7',
        { tasks: [{ agent: 'scout', task: 'find X' }, { agent: 'planner', task: 'plan Y' }] },
        undefined,
        onUpdate
      )

      expect(procs).toHaveLength(2)
      const [scoutProc, plannerProc] = procs

      // planner reports first — its slot (index 1) should carry the delta,
      // scout's slot (index 0) must stay empty.
      const plannerMsg = assistantMsg('planner thinking')
      plannerProc.stdout.emit('data', Buffer.from(jsonLine({ type: 'message_end', message: plannerMsg })))
      expect(updates.length).toBeGreaterThan(0)
      let lastAgents = updates[updates.length - 1].details.cuiSubagent.agents
      expect(lastAgents[0].newMessages).toEqual([]) // scout: nothing yet
      expect(lastAgents[1].newMessages).toEqual([plannerMsg]) // planner: its own delta

      const scoutMsg = assistantMsg('scout thinking')
      scoutProc.stdout.emit('data', Buffer.from(jsonLine({ type: 'message_end', message: scoutMsg })))
      lastAgents = updates[updates.length - 1].details.cuiSubagent.agents
      expect(lastAgents[0].newMessages).toEqual([scoutMsg]) // scout's own delta now
      expect(lastAgents[1].newMessages).toEqual([]) // planner's delta already flushed

      scoutProc.emit('close', 0)
      plannerProc.emit('close', 0)
      const result = await execPromise

      const finalAgents = result.details && (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } })
        .cuiSubagent.agents
      expect(finalAgents).toHaveLength(2)
      expect(finalAgents![0]).toMatchObject({ agent: 'scout', status: 'done' })
      expect(finalAgents![1]).toMatchObject({ agent: 'planner', status: 'done' })
    })
  })
})

describe('abort', () => {
  it('aborting the signal kills the child (taskkill on win32, SIGTERM elsewhere) and the agent settles as error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-abort-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Echo body')
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((cmd: string) => {
      // taskkill invocations also flow through the SAME mocked spawn — return
      // a throwaway double for those so killTree's own spawn() call doesn't
      // reuse (and confuse) the real child's fakeProc instance.
      if (cmd === 'taskkill') return new FakeChildProcess()
      return fakeProc
    })

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const controller = new AbortController()
      const execPromise = tools
        .get('subagent')!
        .execute('call-8', { agent: 'echoer', task: 'x' }, controller.signal, undefined)

      controller.abort()

      if (process.platform === 'win32') {
        expect(mockSpawn).toHaveBeenCalledWith('taskkill', expect.arrayContaining(['/pid', '4242', '/T', '/F']))
      } else {
        expect(fakeProc.killed).toBe(true)
      }

      // The child process still has to report its own exit for the Promise to
      // settle — killing it doesn't synthesize a 'close' event.
      fakeProc.emit('close', 1)
      const result = await execPromise
      const agents = (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } }).cuiSubagent.agents
      expect(agents[0].status).toBe('error')
    })
  })
})

describe('final result shape + temp-prompt-file cleanup', () => {
  it('an agent WITH a non-empty systemPrompt body writes a temp prompt file and cleans it up on completion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-cleanup-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'You are an echo agent.')

    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('pi-subagent-')))

    let capturedArgs: string[] = []
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      capturedArgs = args
      return fakeProc
    })

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const execPromise = tools.get('subagent')!.execute('call-9', { agent: 'echoer', task: 'x' }, undefined, undefined)

      expect(capturedArgs).toContain('--append-system-prompt')
      // A NEW pi-subagent-* tmpdir must exist WHILE the child is "running" —
      // proves writePromptToTempFile actually ran (not asserting the exact
      // path, which is random by design).
      const during = readdirSync(tmpdir()).filter((n) => n.startsWith('pi-subagent-') && !before.has(n))
      expect(during.length).toBeGreaterThan(0)

      fakeProc.emit('close', 0)
      const result = await execPromise

      expect(result.content[0].text).toBeTruthy()
      const finalAgents = (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } }).cuiSubagent
        .agents
      expect(finalAgents[0].status).toBe('done')

      // Cleanup: no leftover pi-subagent-* dirs beyond what existed before this test.
      const after = readdirSync(tmpdir()).filter((n) => n.startsWith('pi-subagent-') && !before.has(n))
      expect(after).toEqual([])
    })

    rmSync(dir, { recursive: true, force: true })
  })

  it('a FAILED child (non-zero exit) resolves the agent as error and STILL cleans up its temp prompt file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-cleanup-fail-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, 'Non-empty system prompt.')

    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('pi-subagent-')))
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation(() => fakeProc)

    await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
      const { pi, tools } = makeFakePi()
      factory(pi)
      const execPromise = tools.get('subagent')!.execute('call-10', { agent: 'echoer', task: 'x' }, undefined, undefined)

      fakeProc.emit('close', 1)
      const result = await execPromise
      expect(result.isError).toBe(true)
      const finalAgents = (result.details as { cuiSubagent: { agents: Array<Record<string, unknown>> } }).cuiSubagent
        .agents
      expect(finalAgents[0].status).toBe('error')

      const after = readdirSync(tmpdir()).filter((n) => n.startsWith('pi-subagent-') && !before.has(n))
      expect(after).toEqual([])
    })

    rmSync(dir, { recursive: true, force: true })
  })
})

describe('getPiInvocation — bun-virtual script detection (review fix, probed against the real pi.exe)', () => {
  /**
   * Run a single-agent execute with process.argv[1]/process.execPath swapped
   * out (restored in finally), capturing the spawn invocation. `existsTrueFor`
   * entries emulate bun's patched fs, where the VIRTUAL script path passes
   * existsSync (probed: `fs.existsSync('B:/~BUN/root/pi.exe') === true` on
   * the real vendored binary).
   */
  async function runWithProcessIdentity(
    argv1: string,
    execPath: string,
    existsTrueFor: string[]
  ): Promise<{ command: string; args: string[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'pi-subagent-agents-invoke-'))
    writeAgentFixture(dir, 'echoer.md', { name: 'echoer', description: 'Echoes' }, '')

    let captured: { command: string; args: string[] } | null = null
    const fakeProc = new FakeChildProcess()
    mockSpawn.mockImplementation((command: string, args: string[]) => {
      captured = { command, args }
      return fakeProc
    })

    const prevArgv1 = process.argv[1]
    const prevExecPath = process.execPath
    for (const p of existsTrueFor) fsCtl.existsTrueFor.add(p)
    try {
      process.argv[1] = argv1
      process.execPath = execPath
      await withEnv({ CLAUDEUI_PI_SUBAGENTS: '1', CLAUDEUI_PI_AGENTS_DIR: dir }, async () => {
        const { pi, tools } = makeFakePi()
        factory(pi)
        const execPromise = tools.get('subagent')!.execute('call-invoke', { agent: 'echoer', task: 'x' }, undefined, undefined)
        fakeProc.emit('close', 0)
        await execPromise
      })
    } finally {
      process.argv[1] = prevArgv1
      process.execPath = prevExecPath
      fsCtl.existsTrueFor.clear()
      rmSync(dir, { recursive: true, force: true })
    }

    if (!captured) throw new Error('spawn was never called')
    return captured
  }

  it('Windows bun-virtual argv[1] (X:/~BUN/... — the PROBED real pi.exe shape) never leaks into child args: command is process.execPath, args start with --mode', async () => {
    // Probed on this machine: process.argv[1] === 'B:/~BUN/root/pi.exe',
    // fs.existsSync of that path is TRUE (bun's virtual fs), process.execPath
    // is the real vendored pi.exe. The example's upstream '/$bunfs/'-only
    // check misclassifies this as a real script and spawns
    // `pi.exe B:/~BUN/root/pi.exe --mode json ...` — the virtual path lands
    // as a positional prompt arg.
    const virtual = 'B:/~BUN/root/pi.exe'
    const exec = 'D:\\WorkPlace\\ClaudeUI\\vendor\\pi-cli\\pi.exe'
    const { command, args } = await runWithProcessIdentity(virtual, exec, [virtual])
    expect(command).toBe(exec)
    expect(args[0]).toBe('--mode')
    expect(args).not.toContain(virtual)
  })

  it('Windows bun-virtual with BACKSLASHES (X:\\~BUN\\...) is detected too', async () => {
    const virtual = 'B:\\~BUN\\root\\pi.exe'
    const exec = 'D:\\WorkPlace\\ClaudeUI\\vendor\\pi-cli\\pi.exe'
    const { command, args } = await runWithProcessIdentity(virtual, exec, [virtual])
    expect(command).toBe(exec)
    expect(args[0]).toBe('--mode')
    expect(args).not.toContain(virtual)
  })

  it('POSIX bun-virtual argv[1] (/$bunfs/root/...) falls through the same way: command is process.execPath, args start with --mode', async () => {
    const virtual = '/$bunfs/root/cli.ts'
    const exec = '/opt/pi/pi' // basename 'pi' — not a generic node/bun runtime
    const { command, args } = await runWithProcessIdentity(virtual, exec, [virtual])
    expect(command).toBe(exec)
    expect(args[0]).toBe('--mode')
    expect(args).not.toContain(virtual)
  })

  it('plain interpreted script (a REAL existing argv[1], execPath node): command is node, args start with the script path', async () => {
    // A genuinely-existing script path — the agents fixture dir trick can't be
    // used (cleaned per-call), so mint a real file for argv[1].
    const scriptDir = mkdtempSync(join(tmpdir(), 'pi-subagent-script-'))
    const script = join(scriptDir, 'cli.js')
    writeFileSync(script, '// fake pi entry\n', 'utf-8')
    try {
      const exec = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node'
      const { command, args } = await runWithProcessIdentity(script, exec, [])
      expect(command).toBe(exec)
      expect(args[0]).toBe(script)
      expect(args[1]).toBe('--mode')
    } finally {
      rmSync(scriptDir, { recursive: true, force: true })
    }
  })
})
