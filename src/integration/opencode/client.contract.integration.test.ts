/**
 * opencode 2.x contract for the PRODUCTION client (`core/opencode/OpencodeClient`
 * + `opencode-event-stream`), not the harness's: directory routing by header,
 * a turn followed on the client's own feed, history, the directory-filtered
 * session list, delete with its typed error, and the reconnect contract after
 * a server-side drop (ADR-097 §2, §7; S3).
 *
 *   OPENCODE_V2_INTEGRATION=1 [OPENCODE_V2_BIN=/path/to/opencode] \
 *     bun run test:integration src/integration/opencode
 */
import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { OpencodeClient, isOpencodeApiError } from '../../core/opencode/OpencodeClient'
import type { Session_Message_Info } from '../../core/opencode/protocol-v2/openapi'
import { basic, startFeed, startRelay } from './harness/client-feed'
import { describeV2, nonce, SHELL_ASKS, useRig } from './harness/host'

const assistantText = (rows: readonly Session_Message_Info[]) =>
  rows
    .flatMap((row) => (row.type === 'assistant' ? row.content : []))
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('')

describeV2('opencode 2.x contract: the production client', () => {
  const rig = useRig('client')

  const clientFor = (directory: string, baseUrl = rig().server.url) =>
    new OpencodeClient({ baseUrl, authHeader: basic(rig().server.password), directory })

  it('directory → prompt → streamed turn on the client feed → history → listed by directory → delete', async () => {
    // A directory that is NOT the server's cwd: only the header can put the session there.
    const directory = rig().home.workspace('client-ws')
    const client = clientFor(directory)
    const feed = startFeed(client)
    try {
      await feed.until(
        () => (feed.items[0]?.kind === 'connected' ? feed.items[0] : undefined),
        'connected'
      )
      expect(feed.items[0]).toMatchObject({ kind: 'connected', reconnected: false })

      // Location-scoped routes answer for the header's directory, not the server's cwd.
      const skills = await client.call('skill.list')
      expect(skills.location.directory).toBe(directory)
      // session.create is the exception: it ignores the header and falls back
      // to the SERVER's cwd without a body `location`
      // (packages/server/src/handlers/session.ts) — why createSession always
      // sends one.
      const headerOnly = await client.call('session.create', { body: {} })
      expect(headerOnly.data.location.directory).toBe(rig().cwd)
      await client.deleteSession(headerOnly.data.id)

      const created = await client.createSession(SHELL_ASKS)
      const sessionID = created.id
      expect(created.location.directory).toBe(directory)
      expect((await client.getSession(sessionID)).location.directory).toBe(directory)

      const tag = nonce('client')
      const inboxID = `msg_claudeui_${randomBytes(6).toString('hex')}`
      const from = feed.items.length
      const accepted = await client.prompt(sessionID, { id: inboxID, text: `hello ${tag}` })
      expect(accepted).toMatchObject({ id: inboxID, sessionID, type: 'user' })

      const end = await feed.turnEnd(sessionID, from)
      expect(end.type).toBe('session.execution.succeeded')
      const streamed = feed
        .events(sessionID, from)
        .flatMap((event) => (event.type === 'session.text.delta' ? [event.data.delta] : []))
        .join('')
      expect(streamed).toBe(`echo: hello ${tag}`)
      // The feed is server-wide but every event of this session carries its location.
      for (const event of feed.events(sessionID, from))
        if (event.location) expect(event.location.directory).toBe(directory)

      // A client-chosen id is the item's identity. Re-posting it is idempotent
      // (the first admission wins, nothing new runs)…
      const again = await client.prompt(sessionID, { id: inboxID, text: 'again' })
      expect(again).toMatchObject({ id: inboxID, payload: { text: `hello ${tag}` } })
      // …while the same id in another session is a typed 409.
      const otherID = (await client.createSession(SHELL_ASKS)).id
      const conflict = await client
        .prompt(otherID, { id: inboxID, text: 'elsewhere', resume: false })
        .catch((e: unknown) => e)
      expect(isOpencodeApiError(conflict, 'session.prompt') && conflict.is('ConflictError')).toBe(
        true
      )
      await client.deleteSession(otherID)

      const history = await client.listMessages(sessionID)
      expect(history[0]).toMatchObject({ type: 'user', id: inboxID, text: `hello ${tag}` })
      expect(history.filter((row) => row.type === 'user')).toHaveLength(1)
      expect(assistantText(history)).toBe(`echo: hello ${tag}`)
      const assistants = await client.listMessages(sessionID, { type: 'assistant' })
      expect(assistants.length).toBeGreaterThan(0)
      expect(assistants.every((row) => row.type === 'assistant')).toBe(true)

      expect((await client.listRootSessions()).map((s) => s.id)).toContain(sessionID)
      expect((await client.listRootSessions(rig().cwd)).map((s) => s.id)).not.toContain(sessionID)

      await client.deleteSession(sessionID)
      const gone = await client.getSession(sessionID).catch((e: unknown) => e)
      expect(isOpencodeApiError(gone, 'session.get')).toBe(true)
      if (isOpencodeApiError(gone, 'session.get')) {
        expect(gone.status).toBe(404)
        expect(gone.is('SessionNotFoundError')).toBe(true)
      }
      expect((await client.listRootSessions()).map((s) => s.id)).not.toContain(sessionID)
    } finally {
      await feed.close()
    }
  })

  it('a server-side drop: the feed reconnects, says so, and a re-read recovers the missed turn', async () => {
    const directory = rig().home.workspace('client-reconnect')
    const relay = await startRelay(rig().server.url)
    // Everything except the feed goes direct; only the feed rides the relay.
    const direct = clientFor(directory)
    const feed = startFeed(clientFor(directory, relay.url), {
      initialRetryDelayMs: 50,
      maxRetryDelayMs: 200,
      maxConsecutiveFailures: Infinity
    })
    try {
      await feed.until(() => feed.items.find((i) => i.kind === 'connected'), 'first connect')
      const sessionID = (await direct.createSession(SHELL_ASKS)).id

      // Cut every relayed socket and hold the client off.
      relay.cut({ refuse: true })
      await feed.until(() => feed.items.find((i) => i.kind === 'disconnected'), 'the drop')

      // A whole turn runs while the client feed is down (the harness feed sees it).
      const tag = nonce('gap')
      const mark = rig().feed.mark()
      await direct.prompt(sessionID, { text: `missed ${tag}` })
      const gapEnd = await rig().feed.waitForTurnEnd(sessionID, mark)
      expect(gapEnd.type).toBe('session.execution.succeeded')

      relay.allow()
      const reconnected = await feed.until(
        () => feed.items.find((i) => i.kind === 'connected' && i.reconnected),
        'the reconnect'
      )
      expect(reconnected).toMatchObject({ kind: 'connected', reconnected: true, connection: 2 })
      // No replay: none of the gap turn's events ever reached the client feed…
      expect(
        feed
          .events(sessionID)
          .filter(
            (event) =>
              event.type.startsWith('session.execution.') || event.type === 'session.text.delta'
          )
      ).toEqual([])
      // …so the consumer re-reads state on `reconnected`, and that recovers it.
      expect(assistantText(await direct.listMessages(sessionID))).toBe(`echo: missed ${tag}`)
      expect(await direct.activeSessions()).not.toHaveProperty(sessionID)

      // The new subscription is live: the next turn streams on it.
      const from = feed.items.length
      const next = nonce('after')
      await direct.prompt(sessionID, { text: `seen ${next}` })
      expect((await feed.turnEnd(sessionID, from)).type).toBe('session.execution.succeeded')
    } finally {
      await feed.close()
      await relay.close()
    }
  })

  it('approvals: the reject message reaches the model; inbox/permission/form state reads back', async () => {
    const directory = rig().home.workspace('client-approval')
    const client = clientFor(directory)
    const feed = startFeed(client)
    try {
      await feed.until(() => feed.items.find((i) => i.kind === 'connected'), 'connected')
      const sessionID = (await client.createSession(SHELL_ASKS)).id
      const tag = nonce('deny')
      const from = feed.items.length
      await client.prompt(sessionID, { text: `[tool] ${tag}` })
      const asked = await feed.until(
        () => feed.events(sessionID, from).find((event) => event.type === 'permission.asked'),
        'permission.asked'
      )
      // State a reconnecting consumer re-reads: the pending ask is listed.
      const pending = await client.listPermissionRequests(sessionID)
      expect(pending.map((request) => request.id)).toEqual([asked.data.id])
      expect(await client.activeSessions()).toHaveProperty(sessionID)
      expect(await client.listForms(sessionID)).toEqual([])
      expect(await client.listInbox(sessionID)).toEqual([])

      const denial = `ClaudeUI denied ${tag}`
      await client.replyPermission(sessionID, asked.data.id, {
        decision: 'reject',
        message: denial
      })
      const end = await feed.turnEnd(sessionID, from)
      expect(end.type).toBe('session.execution.succeeded')
      const failed = feed
        .events(sessionID, from)
        .find((event) => event.type === 'session.tool.failed')
      expect(failed?.type === 'session.tool.failed' && failed.data.error).toEqual({
        type: 'permission.rejected',
        message: denial
      })
      expect(rig().fixture.mentioning(denial).length).toBeGreaterThan(0)
      expect(await client.listPermissionRequests(sessionID)).toEqual([])
      expect(await client.interrupt(sessionID)).toBe(false)
    } finally {
      await feed.close()
    }
  })

  it('catalog, credential and config reads decode against the real server', async () => {
    const client = clientFor(rig().home.workspace('client-catalog'))
    // A fresh directory is a cold location: without the client's activation
    // barrier every catalog read here answers empty.
    expect((await client.agents()).map((agent) => agent.id)).toEqual(
      expect.arrayContaining(['build'])
    )
    expect((await client.commands()).length).toBeGreaterThan(0)
    expect((await client.skills()).length).toBeGreaterThan(0)
    expect(Array.isArray(await client.mcpServers())).toBe(true)
    expect((await client.providers()).map((provider) => provider.id)).toContain('fixture')
    expect(
      (await client.models()).some(
        (model) => model.providerID === 'fixture' && model.id === 'fixture-model'
      )
    ).toBe(true)
    expect((await client.integrations()).length).toBeGreaterThan(0)
    // Values are secrets: only ids are looked at.
    expect(Array.isArray((await client.listCredentials()).map((entry) => entry.id))).toBe(true)
    expect(Array.isArray(await client.getConfig())).toBe(true)
    // A reload rebuilds the location; the barrier is taken again, so reads stay whole.
    await client.reloadLocation()
    expect((await client.agents()).map((agent) => agent.id)).toContain('build')
  })
})
