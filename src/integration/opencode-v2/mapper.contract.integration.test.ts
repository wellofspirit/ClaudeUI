/**
 * opencode 2.x contract for the S4 mapper (ADR-093 S4): the PRODUCTION client
 * and feed, the live mapper consuming it as `OpencodeSession` will (a
 * reconnect pauses the feed while `reconcileAfterReconnect` runs), against
 * the real engine — and the cold converter on the stored history, which must
 * equal what streamed live.
 *
 *   OPENCODE_V2_INTEGRATION=1 [OPENCODE_V2_BIN=/path/to/opencode] \
 *     bun run test:integration src/integration/opencode-v2
 *
 * `OPENCODE_V2_CAPTURE=1` also writes each scenario's events and stored rows
 * (paths redacted) to `core/opencode/__tests__/fixtures/opencode-v2/`, which
 * the unit parity suite replays (`v2-parity.test.ts`).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { OpencodeClient } from '../../core/opencode/OpencodeClient'
import type { OpencodeEvent } from '../../core/opencode/protocol-v2/events'
import type {
  Config_InfoEncoded,
  Operations,
  Session_Message_Info
} from '../../core/opencode/protocol-v2/openapi'
import type { SubscribeOptions } from '../../core/opencode/opencode-event-stream'
import { OpencodeEventMapper, type OpencodeMapperOutput } from '../../core/opencode/v2-event-mapper'
import { convertOpencodeHistory, readOpencodeHistory } from '../../core/opencode/v2-history'
import { reconcileAfterReconnect, type OpencodeStateReader } from '../../core/opencode/v2-reconnect'
import {
  foldOutputs,
  normalizeTranscript,
  type Transcript
} from '../../test/helpers/opencode-v2-transcript'
import { basic, startRelay } from './harness/client-feed'
import {
  COMPACTION_SUMMARY,
  NOTES_FILE,
  REASONING_TEXT,
  SHELL_COMMAND,
  type FixtureProvider
} from './harness/fixture-provider'
import {
  describeV2,
  FIXTURES_DIR,
  fixtureConfig,
  nonce,
  SHELL_ASKS,
  type TestHome,
  useRig
} from './harness/host'

const CAPTURE = process.env.OPENCODE_V2_CAPTURE === '1'
const CAPTURE_DIR = resolve(__dirname, '../../core/opencode/__tests__/fixtures/opencode-v2')
/** A model id opencode offers the `patch` tool to (`core/src/tool/plugin/patch.ts`: `gpt-`, not 4/oss). */
const PATCH_MODEL = 'gpt-5-fixture'

function mapperConfig(fixture: FixtureProvider, home: TestHome): Config_InfoEncoded {
  const base = fixtureConfig(fixture)
  const fixtureProvider = base.providers!.fixture!
  return {
    ...base,
    providers: {
      fixture: {
        ...fixtureProvider,
        models: {
          ...fixtureProvider.models,
          [PATCH_MODEL]: {
            name: 'Fixture GPT',
            limit: { context: 100_000, output: 4096 },
            cost: { input: 1, output: 2 }
          }
        }
      }
    },
    mcp: {
      servers: {
        fx: {
          type: 'local',
          command: [process.execPath, join(FIXTURES_DIR, 'mcp-stdio-server.mjs')],
          environment: { MCP_CALL_LOG: join(home.root, 'mcp-calls.jsonl') },
          codemode: false
        }
      }
    }
  }
}

/**
 * The production feed driving a mapper exactly as the session will: events
 * are mapped as they arrive, and a reconnect is reconciled BEFORE the next
 * event is applied (the `for await` pauses the feed meanwhile).
 */
function startMapperFeed(
  client: OpencodeClient,
  mapper: OpencodeEventMapper,
  options: SubscribeOptions & { reader?: OpencodeStateReader } = {}
) {
  const reader = options.reader ?? client
  const controller = new AbortController()
  const outputs: OpencodeMapperOutput[] = []
  const events: OpencodeEvent[] = []
  const marks: { reconnectAt: number[] } = { reconnectAt: [] }
  const waiters = new Set<() => void>()
  let failure: unknown = null
  let connected = 0
  const wake = () => {
    for (const waiter of [...waiters]) waiter()
  }
  const done = (async () => {
    try {
      for await (const item of client.subscribeEvents({ ...options, signal: controller.signal })) {
        if (item.kind === 'connected') {
          connected++
          if (item.reconnected) {
            marks.reconnectAt.push(outputs.length)
            outputs.push(...(await reconcileAfterReconnect(reader, mapper)))
          }
        } else if (item.kind === 'event') {
          events.push(item.event)
          outputs.push(...mapper.map(item.event))
        }
        wake()
      }
    } catch (error) {
      failure = error
      wake()
    }
  })()
  const until = <R>(probe: () => R | undefined, label: string, timeoutMs = 30_000): Promise<R> =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(
          new Error(
            `timed out waiting for ${label}; outputs: ${outputs
              .slice(-30)
              .map((o) => o.kind)
              .join(', ')}`
          )
        )
      }, timeoutMs)
      const check = () => {
        const hit = probe()
        if (hit !== undefined || failure) {
          clearTimeout(timer)
          waiters.delete(check)
          if (hit !== undefined) resolvePromise(hit)
          else reject(new Error(`feed failed: ${String(failure)}`))
        }
      }
      waiters.add(check)
      check()
    })
  const output = <K extends OpencodeMapperOutput['kind']>(
    kind: K,
    from = 0,
    where: (o: Extract<OpencodeMapperOutput, { kind: K }>) => boolean = () => true
  ) =>
    until(
      () =>
        outputs
          .slice(from)
          .find(
            (o): o is Extract<OpencodeMapperOutput, { kind: K }> =>
              o.kind === kind && where(o as Extract<OpencodeMapperOutput, { kind: K }>)
          ),
      kind
    )
  /** The own session's next turn end (result / stopped / error / auth-required) from `from`. */
  const turnEnd = (from: number) =>
    until(
      () =>
        outputs
          .slice(from)
          .find(
            (o) =>
              o.kind === 'result' ||
              o.kind === 'stopped' ||
              o.kind === 'error' ||
              o.kind === 'auth-required'
          ),
      'the turn end'
    )
  return {
    outputs,
    events,
    marks,
    until,
    output,
    turnEnd,
    connectedOnce: () => until(() => (connected > 0 ? true : undefined), 'connected'),
    close: async () => {
      controller.abort()
      await done
    }
  }
}

/** The cold transcript of a session, children included, normalized. */
async function coldTranscript(
  client: OpencodeClient,
  sessionID: string
): Promise<{
  transcript: Transcript
  rows: Session_Message_Info[]
  children: Map<string, Session_Message_Info[]>
}> {
  const { rows, children } = await readOpencodeHistory((id) => client.listMessages(id), sessionID)
  return { transcript: normalizeTranscript(convertOpencodeHistory(rows, children)), rows, children }
}

/** Redact machine paths, keeping the fixture self-consistent. */
function redactPaths(json: string, home: TestHome, cwd: string): string {
  return json
    .split(cwd)
    .join('/ws/main')
    .split(home.root)
    .join('/home-root')
    .replace(/\.cache\/opencode-v2-it\/[^/"]+\//g, '.cache/opencode-v2-it/home/')
}

async function capture(
  name: string,
  home: TestHome,
  cwd: string,
  data: {
    client: OpencodeClient
    sessionID: string
    events: readonly OpencodeEvent[]
    rows: readonly Session_Message_Info[]
    children: ReadonlyMap<string, readonly Session_Message_Info[]>
  }
): Promise<void> {
  if (!CAPTURE) return
  // opencode's cumulative for the session: what the cold status line seeds from.
  const session = await data.client.getSession(data.sessionID)
  const followed = new Set([data.sessionID, ...data.children.keys()])
  const events = data.events.filter((event) => {
    const sessionID =
      event.type === 'form.created'
        ? event.data.form.sessionID
        : (event.data as { sessionID?: string }).sessionID
    return sessionID !== undefined && followed.has(sessionID)
  })
  mkdirSync(CAPTURE_DIR, { recursive: true })
  const body = JSON.stringify(
    {
      scenario: name,
      opencode: '2.0.24',
      sessionID: data.sessionID,
      events,
      messages: data.rows,
      children: Object.fromEntries(data.children),
      sessionTotals: { cost: session.cost, tokens: session.tokens }
    },
    null,
    1
  )
  writeFileSync(join(CAPTURE_DIR, `${name}.json`), redactPaths(body, home, cwd) + '\n')
}

const ALLOW_ALL: Operations['session.create']['body'] = {
  permissions: [{ action: '*', resource: '*', effect: 'allow' }]
}

describeV2('opencode 2.x contract: the S4 mapper on the production client', () => {
  const rig = useRig('mapper', { config: mapperConfig })

  const clientFor = (baseUrl = rig().server.url) =>
    new OpencodeClient({ baseUrl, authHeader: basic(rig().server.password), directory: rig().cwd })

  /** Waits until the MCP fixture's `fx_echo` is offered to the model (see mcp-identity). */
  async function mcpReady(): Promise<void> {
    const { api, fixture } = rig()
    const deadline = Date.now() + 20_000
    for (;;) {
      const servers = await api.ok('mcp.list')
      if (servers.data.some((server) => server.status.status === 'connected')) break
      if (Date.now() > deadline) throw new Error('MCP fixture never connected')
      await new Promise((done) => setTimeout(done, 100))
    }
    const warmup = await rig().createSession(ALLOW_ALL)
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = nonce('warmup')
      await rig().turn(warmup, probe)
      if (fixture.mentioning(probe).every((request) => request.tools.includes('fx_echo'))) return
      await new Promise((done) => setTimeout(done, 200))
    }
    throw new Error('fx_echo never offered')
  }

  it('a multi-tool session streams the neutral stream, and cold history equals live', async () => {
    await mcpReady()
    writeFileSync(join(rig().cwd, NOTES_FILE), 'alpha\n')
    const client = clientFor()
    const sessionID = (await client.createSession(SHELL_ASKS)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      const turn = async (text: string, during?: (from: number) => Promise<void>) => {
        const from = feed.outputs.length
        await client.prompt(sessionID, { text })
        await during?.(from)
        const end = await feed.turnEnd(from)
        expect(end).toMatchObject({ kind: 'result', sessionId: sessionID })
        return from
      }
      // Reasoning, then text.
      const reasoned = await turn(`[reason] ${nonce('think')}`)
      const thinkingOpen = feed.outputs
        .slice(reasoned)
        .find((o) => o.kind === 'item-open' && o.open.target.kind === 'thinking')
      expect(thinkingOpen).toBeDefined()
      // A shell call that asks; the ask carries the call's real input.
      const shelled = await turn(`[tool] ${nonce('shell')}`, async (from) => {
        const ask = await feed.output('approval', from)
        expect(ask.approval).toMatchObject({
          toolName: 'shell',
          input: { command: SHELL_COMMAND },
          patterns: [SHELL_COMMAND]
        })
        expect(ask.route).toEqual({ sessionID })
        await client.replyPermission(sessionID, ask.approval.requestId, { decision: 'once' })
      })
      expect(feed.outputs.slice(shelled).map((o) => o.kind)).toEqual(
        expect.arrayContaining(['shell-started', 'approval-resolved', 'tool-result'])
      )
      // File tools: real diffs on the edit card.
      const edited = await turn(`[edit] ${nonce('edit')}`)
      const editResult = feed.outputs
        .slice(edited)
        .find((o) => o.kind === 'tool-result' && !o.result.isError)
      expect(editResult?.kind === 'tool-result' && editResult.result.fileDiffs?.[0]).toMatchObject({
        path: NOTES_FILE,
        changeType: 'update',
        additions: 1,
        deletions: 1
      })
      await turn(`[write] ${nonce('write')}`)
      // ONE response with two calls: the neutral stream, in order (repeats of
      // a message snapshot or a delta collapsed; bookkeeping kinds left out).
      const multi = await turn(`[multi] ${nonce('multi')}`)
      expect(
        feed.outputs
          .slice(multi)
          .map((o) => o.kind)
          .filter((kind) => !['inbox', 'session-usage', 'session-renamed'].includes(kind))
          .filter(
            (kind, i, all) =>
              !(kind === all[i - 1] && (kind === 'message' || kind === 'item-delta'))
          )
      ).toEqual([
        'turn-start',
        'user-message',
        'message',
        'tool-result',
        'tool-result',
        'step-usage',
        'item-open',
        'item-delta',
        'item-seal',
        'step-usage',
        'result'
      ])
      // MCP, by its sanitized name.
      const mcp = await turn(`[mcp] ${nonce('mcp')}`)
      expect(
        feed.outputs
          .slice(mcp)
          .some(
            (o) =>
              o.kind === 'message' &&
              o.message.content.some((b) => b.type === 'tool_use' && b.toolName === 'fx_echo')
          )
      ).toBe(true)
      // A subagent whose child runs a tool: child items/results route under the call.
      const sub = await turn(`[subread] ${nonce('sub')}`)
      const started = feed.outputs.slice(sub).find((o) => o.kind === 'subagent-started')
      expect(started).toBeDefined()
      const callID = started?.kind === 'subagent-started' ? started.toolUseId : ''
      expect(
        feed.outputs
          .slice(sub)
          .some((o) => o.kind === 'tool-result' && o.ownerToolUseId === callID && !o.result.isError)
      ).toBe(true)
      expect(feed.outputs.slice(sub).filter((o) => o.kind === 'task-notification')).toEqual([
        {
          kind: 'task-notification',
          notification: expect.objectContaining({ toolUseId: callID, status: 'completed' })
        }
      ])
      // Every step was metered once.
      const steps = feed.outputs.filter((o) => o.kind === 'step-usage')
      expect(new Set(steps.map((o) => o.kind === 'step-usage' && o.usage.messageId)).size).toBe(
        steps.length
      )

      const live = normalizeTranscript(foldOutputs(feed.outputs))
      const cold = await coldTranscript(client, sessionID)
      expect(live).toEqual(cold.transcript)
      // Sanity on what was compared: reasoning, every tool, the child.
      const blocks = live.messages.flatMap((m) => m.content)
      expect(blocks.some((b) => b.type === 'thinking' && b.text.includes(REASONING_TEXT))).toBe(
        true
      )
      expect(blocks.flatMap((b) => (b.type === 'tool_use' ? [b.toolName] : [])).sort()).toEqual([
        'edit',
        'fx_echo',
        'read',
        'shell',
        'subagent',
        'write',
        'write'
      ])
      expect(Object.keys(live.subagentMessages)).toEqual([callID])
      await capture('multi-tool', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('patch (offered to gpt- models) renders per-file diffs live and cold', async () => {
    writeFileSync(join(rig().cwd, NOTES_FILE), 'beta\n')
    const client = clientFor()
    const sessionID = (
      await client.createSession({
        ...ALLOW_ALL,
        model: { providerID: 'fixture', id: PATCH_MODEL }
      })
    ).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      const from = feed.outputs.length
      await client.prompt(sessionID, { text: `[patch] ${nonce('patch')}` })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      const patched = feed.outputs.find(
        (o) => o.kind === 'tool-result' && o.result.fileDiffs !== undefined
      )
      expect(patched?.kind === 'tool-result' && patched.result.fileDiffs).toEqual([
        expect.objectContaining({ path: NOTES_FILE, changeType: 'update' })
      ])
      const cold = await coldTranscript(client, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
      await capture('patch', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('stops: a user interrupt is `stopped/user`; a messageless reject is `stopped/denied`', async () => {
    const client = clientFor()
    const sessionID = (await client.createSession(SHELL_ASKS)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      let from = feed.outputs.length
      await client.prompt(sessionID, { text: `[slow] ${nonce('stop')}` })
      await feed.output('item-delta', from)
      expect(await client.interrupt(sessionID)).toBe(true)
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'stopped', reason: 'user' })

      // A Stop while an ask is pending: opencode drops the request with no
      // `permission.replied`; the card must still go.
      from = feed.outputs.length
      await client.prompt(sessionID, { text: `[tool] ${nonce('stop-ask')}` })
      const pending = await feed.output('approval', from)
      expect(await client.interrupt(sessionID)).toBe(true)
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'stopped', reason: 'user' })
      expect(
        feed.events
          .slice(0)
          .some(
            (e) =>
              e.type === 'permission.replied' && e.data.requestID === pending.approval.requestId
          )
      ).toBe(false)
      const kindsAfter = feed.outputs.slice(from).map((o) => o.kind)
      expect(kindsAfter.indexOf('approval-resolved')).toBeGreaterThan(
        kindsAfter.indexOf('approval')
      )
      expect(kindsAfter.indexOf('approval-resolved')).toBeLessThan(kindsAfter.indexOf('stopped'))
      expect(await client.listPermissionRequests(sessionID)).toEqual([])

      from = feed.outputs.length
      await client.prompt(sessionID, { text: `[tool] ${nonce('declined')}` })
      const ask = await feed.output('approval', from)
      // The production client refuses a messageless reject (ADR-093 §3); the
      // harness's raw API sends one, as an older or foreign client could.
      await rig().api.ok('session.permission.reply', {
        params: { sessionID, requestID: ask.approval.requestId },
        body: { decision: 'reject' }
      })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'stopped', reason: 'denied' })
      const aborted = feed.outputs
        .slice(from)
        .find((o) => o.kind === 'tool-result' && o.result.errorType === 'aborted')
      expect(aborted).toBeDefined()
      // The host asked, so no rule-denial block of the mapper's own.
      expect(feed.outputs.slice(from).some((o) => o.kind === 'permission-denial')).toBe(false)

      const cold = await coldTranscript(client, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
      await capture('stops', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('forms: a cancel WITH a message continues; one WITHOUT ends the turn `stopped/form-cancelled`', async () => {
    const client = clientFor()
    const sessionID = (await client.createSession(ALLOW_ALL)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      let from = feed.outputs.length
      await client.prompt(sessionID, { text: `[question] ${nonce('skip')}` })
      let asked = await feed.output('approval', from)
      await client.cancelForm(sessionID, asked.route.form!.formID, 'The user skipped the question')
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      expect(feed.outputs.slice(from).find((o) => o.kind === 'tool-result')).toMatchObject({
        result: { isError: true, result: 'The user skipped the question' }
      })

      from = feed.outputs.length
      await client.prompt(sessionID, { text: `[question] ${nonce('dismiss')}` })
      asked = await feed.output('approval', from)
      // Raw call: the production client refuses a messageless cancel (S5).
      await client.call('session.form.cancel', {
        params: { sessionID, formID: asked.route.form!.formID },
        query: {}
      })
      expect(await feed.turnEnd(from)).toMatchObject({
        kind: 'stopped',
        reason: 'form-cancelled'
      })

      const cold = await coldTranscript(client, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
      await capture('form-cancel', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('a subagent RESUMED by a second call streams under that call, live and cold', async () => {
    writeFileSync(join(rig().cwd, NOTES_FILE), 'alpha\n')
    const client = clientFor()
    const sessionID = (await client.createSession(ALLOW_ALL)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      let from = feed.outputs.length
      await client.prompt(sessionID, { text: `[subread] ${nonce('first')}` })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      const first = await feed.output('subagent-started', from)
      from = feed.outputs.length
      await client.prompt(sessionID, { text: `[subresume] ${nonce('again')}` })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      const second = await feed.output('subagent-started', from)
      expect(second.childSessionId).toBe(first.childSessionId)
      expect(second.toolUseId).not.toBe(first.toolUseId)

      const live = normalizeTranscript(foldOutputs(feed.outputs))
      const cold = await coldTranscript(client, sessionID)
      expect(live).toEqual(cold.transcript)
      // Each call shows its own run of the one child.
      expect(Object.keys(live.subagentMessages).sort()).toEqual(
        [first.toolUseId, second.toolUseId].sort()
      )
      expect(live.taskNotifications.map((n) => n.toolUseId).sort()).toEqual(
        [first.toolUseId, second.toolUseId].sort()
      )
      await capture('resume', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('denials: a reject with a message continues; a deny rule adds the rule-denial block', async () => {
    const client = clientFor()
    const sessionID = (await client.createSession(SHELL_ASKS)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      let from = feed.outputs.length
      await client.prompt(sessionID, { text: `[tool] ${nonce('deny')}` })
      const ask = await feed.output('approval', from)
      await client.replyPermission(sessionID, ask.approval.requestId, {
        decision: 'reject',
        message: 'ClaudeUI denied: contract'
      })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      expect(feed.outputs.slice(from).find((o) => o.kind === 'tool-result')).toMatchObject({
        result: {
          isError: true,
          errorType: 'permission.rejected',
          result: 'ClaudeUI denied: contract'
        }
      })
      expect(feed.outputs.slice(from).some((o) => o.kind === 'permission-denial')).toBe(false)

      await client.setSessionPermissions(sessionID, [
        { action: '*', resource: '*', effect: 'allow' },
        { action: 'shell', resource: 'echo *', effect: 'deny' }
      ])
      from = feed.outputs.length
      await client.prompt(sessionID, { text: `[tool] ${nonce('rule')}` })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      const denial = feed.outputs.slice(from).find((o) => o.kind === 'permission-denial')
      expect(denial).toMatchObject({ denial: { source: 'rule', type: 'permission_denial' } })

      const cold = await coldTranscript(client, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
      await capture('denials', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('a question form becomes an AskUserQuestion approval; a compaction a separator row', async () => {
    const client = clientFor()
    const sessionID = (await client.createSession(ALLOW_ALL)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    const feed = startMapperFeed(client, mapper)
    try {
      await feed.connectedOnce()
      let from = feed.outputs.length
      await client.prompt(sessionID, { text: `[question] ${nonce('form')}` })
      const asked = await feed.output('approval', from)
      expect(asked.approval).toMatchObject({
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Pick a fruit?',
              header: 'Fruit',
              multiSelect: false,
              options: [
                { label: 'Apple', description: 'red' },
                { label: 'Banana', description: 'yellow' }
              ]
            }
          ]
        }
      })
      expect(asked.route.form?.fields).toEqual([
        { key: 'q0', multiSelect: false, values: { Apple: 'Apple', Banana: 'Banana' } }
      ])
      await client.replyForm(sessionID, asked.route.form!.formID, { q0: 'Banana' })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      expect(feed.outputs.slice(from).map((o) => o.kind)).toContain('approval-resolved')

      from = feed.outputs.length
      await rig().api.ok('session.compact', { params: { sessionID }, body: {} })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      const separator = feed.outputs
        .slice(from)
        .find((o) => o.kind === 'message' && o.message.content[0]?.type === 'compact_separator')
      expect(separator?.kind === 'message' && separator.message.content[0]).toEqual({
        type: 'compact_separator',
        text: COMPACTION_SUMMARY
      })
      expect(
        feed.outputs.slice(from).find((o) => o.kind === 'compaction' && o.phase === 'ended')
      ).toMatchObject({ usage: { cost: expect.any(Number) } })

      const cold = await coldTranscript(client, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
      await capture('form-compaction', rig().home, rig().cwd, {
        client,
        sessionID,
        events: feed.events,
        rows: cold.rows,
        children: cold.children
      })
    } finally {
      await feed.close()
    }
  })

  it('reconnect: a drop mid-stream and a whole turn in the gap are recovered, once', async () => {
    const relay = await startRelay(rig().server.url)
    const direct = clientFor()
    const sessionID = (await direct.createSession(ALLOW_ALL)).id
    const mapper = new OpencodeEventMapper({ sessionID })
    // Only the feed rides the relay; the reconcile reads go direct.
    const feed = startMapperFeed(clientFor(relay.url), mapper, {
      reader: direct,
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 200,
      maxConsecutiveFailures: Infinity
    })
    try {
      await feed.connectedOnce()
      // 1) Drop in the middle of a streamed answer.
      let from = feed.outputs.length
      const mark = rig().feed.mark()
      await direct.prompt(sessionID, { text: `[slow] ${nonce('gap')}` })
      await feed.output('item-delta', from)
      relay.cut({ refuse: true })
      await new Promise((done) => setTimeout(done, 600))
      relay.allow()
      await rig().feed.waitForTurnEnd(sessionID, mark)
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })
      expect(feed.marks.reconnectAt.length).toBeGreaterThanOrEqual(1)

      // 2) A whole turn while the feed is down.
      const before = feed.marks.reconnectAt.length
      relay.cut({ refuse: true })
      from = feed.outputs.length
      const mark2 = rig().feed.mark()
      await direct.prompt(sessionID, { text: `[read] ${nonce('missed')}` })
      await rig().feed.waitForTurnEnd(sessionID, mark2)
      relay.allow()
      await feed.until(
        () => (feed.marks.reconnectAt.length > before ? true : undefined),
        'the second reconnect'
      )
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })

      // 3) The feed is live again: one more turn, mapped as it streams.
      from = feed.outputs.length
      await direct.prompt(sessionID, { text: `after ${nonce('after')}` })
      expect(await feed.turnEnd(from)).toMatchObject({ kind: 'result' })

      // Nothing doubled: one end per turn, one result per call, one metering per step.
      const ends = feed.outputs.filter((o) => o.kind === 'result')
      expect(ends).toHaveLength(3)
      const results = feed.outputs.flatMap((o) =>
        o.kind === 'tool-result' ? [o.result.toolUseId] : []
      )
      expect(new Set(results).size).toBe(results.length)
      const steps = feed.outputs.flatMap((o) =>
        o.kind === 'step-usage' ? [o.usage.messageId] : []
      )
      expect(new Set(steps).size).toBe(steps.length)

      const cold = await coldTranscript(direct, sessionID)
      expect(normalizeTranscript(foldOutputs(feed.outputs))).toEqual(cold.transcript)
    } finally {
      await feed.close()
      await relay.close()
    }
  })
})
