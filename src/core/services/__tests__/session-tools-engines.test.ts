/**
 * @vitest-environment node
 *
 * The session service as the opencode and pi adapters call it (slice 2):
 * a caller with each engine's id and a `callOwner` that reflects the engine's
 * root-only facts. The adapters' own suites cover how they BUILD that caller;
 * this one pins what the shared service does with it — root acts, anything else is
 * refused and audited — so the two halves of "main agent only" cannot drift apart.
 *
 * Real: canonical state, the ref and link tables, the held inbox and the audit log
 * (the suite's sqlite driver, in a throwaway home). Doubles: the sessions and the
 * manager that holds them, and the host's create/send functions.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineId } from '../../../shared/types'
import { ACTING_SESSION_TOOLS } from '../../../shared/session-tools-description'
import { TurnOriginLedger } from '../../providers/turn-origin-ledger'
import type { CreateSessionArgs } from '../../ipc/create-session'
import type { SessionManager } from '../session-manager'
import { listAuditLog } from '../db'
import { emitEvent, syncCore } from '../sync-host'
import { refFor, resetSessionLinksForTests } from '../session-links'
import {
  configureSessionTools,
  runSessionTool,
  sessionToolsGate,
  type SessionToolCaller
} from '../session-tools'

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tools-engines-'))
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }))

class Fake {
  willQueue = false
  readonly originLedger = new TurnOriginLedger()
  deliverNonUser = vi.fn(async (_item: unknown): Promise<'started' | 'queued' | 'unavailable'> => {
    this.willQueue = true
    return 'started'
  })
  interrupt = vi.fn(async () => {})
  constructor(
    public routingId: string,
    readonly engineId: EngineId
  ) {}
  getSessionId = (): string | null => null
}

const live = new Map<string, Fake>()
const manager = {
  get: (id: string) => live.get(id),
  has: (id: string) => live.has(id),
  getMessages: vi.fn(async () => [])
} as unknown as SessionManager
const created: CreateSessionArgs[] = []
const createSession = vi.fn(async (args: CreateSessionArgs) => {
  created.push(args)
})
const sendPrompt = vi.fn()

beforeEach(() => {
  syncCore.resetCanonicalForTests()
  resetSessionLinksForTests()
  live.clear()
  created.length = 0
  vi.clearAllMocks()
  configureSessionTools({ manager, createSession, sendPrompt })
})

function born(label: string, engine: EngineId, mode = 'default') {
  const routingId = `${label}-${randomUUID()}`
  const cwd = path.join(ROOT, 'proj')
  fs.mkdirSync(cwd, { recursive: true })
  emitEvent('session:created', [routingId, { cwd, engineId: engine, permissionMode: mode }])
  const fake = new Fake(routingId, engine)
  live.set(routingId, fake)
  return { routingId, cwd, fake, ref: refFor(engine, routingId), engine, mode }
}

type Owner = 'root' | 'subagent' | 'unknown'
const callerOf = (s: ReturnType<typeof born>, owner: Owner): SessionToolCaller => ({
  routingId: s.routingId,
  engine: s.engine,
  cwd: s.cwd,
  permissionMode: s.mode,
  callOwner: async () => owner
})

const auditFor = (ref: string): ReturnType<typeof listAuditLog> =>
  listAuditLog({ limit: 500 }).filter((r) => r.connectionId === `session:${ref}`)

const ENGINES = ['opencode', 'pi'] as const
const ACTING_INPUTS = {
  session_message: (target: string) => ({ session: target, message: 'hi' }),
  session_stop: (target: string) => ({ session: target }),
  session_start: () => ({
    title: 'Child',
    prompt: 'Do the thing',
    background: 'x'.repeat(100)
  }),
  session_hand_off: () => ({ title: 'Next', handoff: 'Everything about the work.' }),
  session_dismiss_proposal: () => ({ proposal_id: 'p-none' })
} as const

describe.each(ENGINES)('%s caller', (engine) => {
  it("the root agent acts: a message is delivered to a session of another engine, and audited as this engine's agent", async () => {
    const me = born('root', engine, 'auto')
    const other = born('other', 'claude')
    const out = await runSessionTool(callerOf(me, 'root'), 'session_message', {
      session: other.ref,
      message: 'ping'
    })
    expect(out.isError).toBeUndefined()
    expect(out.text).toMatch(/^delivered/)
    expect(other.fake.deliverNonUser).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'session-message',
        text: 'ping',
        from: expect.objectContaining({ key: me.ref }),
        // No engine but Claude has a bypass mode: its senders are all "prompting".
        senderModeClass: 'prompting'
      })
    )
    const rows = auditFor(me.ref)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      method: 'agent',
      label: `${me.ref} (${engine})`,
      channel: 'session-tools:session_message',
      outcome: 'ok'
    })
  })

  it.each(Object.keys(ACTING_INPUTS) as Array<keyof typeof ACTING_INPUTS>)(
    'a subagent calling %s is refused, nothing happens, and the refusal is audited',
    async (tool) => {
      expect(ACTING_SESSION_TOOLS.has(tool)).toBe(true)
      const me = born('chat', engine)
      const other = born('target', 'claude')
      const out = await runSessionTool(
        callerOf(me, 'subagent'),
        tool,
        ACTING_INPUTS[tool](other.ref)
      )
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/^Refused: .*main agent, not by a subagent/)
      expect(other.fake.deliverNonUser).not.toHaveBeenCalled()
      expect(other.fake.interrupt).not.toHaveBeenCalled()
      expect(created).toHaveLength(0)
      expect(auditFor(me.ref).map((row) => [row.channel, row.outcome])).toEqual([
        [`session-tools:${tool}`, 'error']
      ])
    }
  )

  it.each(Object.keys(ACTING_INPUTS) as Array<keyof typeof ACTING_INPUTS>)(
    "a call the engine cannot attribute (%s) is refused like a subagent's",
    async (tool) => {
      const me = born('chat', engine)
      const other = born('target', 'claude')
      const out = await runSessionTool(
        callerOf(me, 'unknown'),
        tool,
        ACTING_INPUTS[tool](other.ref)
      )
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/could not be attributed to the session's main agent/)
      expect(other.fake.deliverNonUser).not.toHaveBeenCalled()
      expect(created).toHaveLength(0)
      expect(auditFor(me.ref)).toHaveLength(1)
    }
  )

  it('a subagent may still read, judged by the same scope rules (reads are not root-only)', async () => {
    const me = born('chat', engine)
    const out = await runSessionTool(callerOf(me, 'subagent'), 'session_list', {})
    expect(out.isError).toBeUndefined()
    expect(sessionToolsGate(callerOf(me, 'subagent'), 'session_list', {}, {}).behavior).toBe(
      'allow'
    )
  })

  it('plan mode: the gate and the service both refuse an acting tool, so no mode skips the rule', async () => {
    const me = born('planner', engine, 'plan')
    const input = ACTING_INPUTS.session_start()
    const gate = sessionToolsGate(callerOf(me, 'root'), 'session_start', input, {})
    expect(gate).toMatchObject({ behavior: 'deny' })
    const out = await runSessionTool(callerOf(me, 'root'), 'session_start', input)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('plan mode')
    expect(created).toHaveLength(0)
  })

  it("a started session gets this engine's own mode ceiling: it cannot be given a mode above the caller's", async () => {
    const me = born('chat', engine, 'default')
    const out = await runSessionTool(callerOf(me, 'root'), 'session_start', {
      ...ACTING_INPUTS.session_start(),
      permission_mode: 'auto'
    })
    expect(out.isError).toBe(true)
    expect(out.text).toContain("above this session's own mode")
    expect(created).toHaveLength(0)
  })
})
