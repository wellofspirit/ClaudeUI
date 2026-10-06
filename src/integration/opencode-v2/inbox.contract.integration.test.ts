/**
 * opencode 2.x contract: the native inbox replaces ClaudeUI's host-held queue
 * (ADR-093 §9). Inbox items carry ClaudeUI-chosen ids; a steer lands inside the
 * running turn, queued items after it, in order; a cancelled item never
 * reaches the model; re-posting an id is idempotent.
 */
import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { messageText, type ChatRequest } from './harness/fixture-provider'
import { describeV2, nonce, useRig } from './harness/host'

const userTexts = (request: ChatRequest) =>
  request.messages.filter((m) => m.role === 'user').map((m) => messageText(m.content))

describeV2('opencode 2.x contract: inbox steer / queue / cancel', () => {
  const rig = useRig('inbox')

  it('(c) steer + two queued + cancel one: delivery order, the cancelled never reaches the model', async () => {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    const tag = nonce('inbox')
    // ClaudeUI-chosen ids, deliberately in REVERSE lexical order of enqueueing:
    // delivery must follow the enqueue order, not the id order.
    const suffix = randomBytes(4).toString('hex')
    const ids = {
      steer: `msg_claudeui_c_${suffix}`,
      queued: `msg_claudeui_b_${suffix}`,
      cancelled: `msg_claudeui_a_${suffix}`
    }
    const texts = {
      steer: `STEER ${tag}`,
      queued: `QUEUED ${tag}`,
      cancelled: `CANCELLED ${tag}`
    }
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: `[slow] ${tag}` } })
    await feed.waitFor('session.text.delta', { sessionID, after: from })

    const steer = await api.ok('session.prompt', {
      params: { sessionID },
      body: { id: ids.steer, text: texts.steer, delivery: 'steer' }
    })
    expect(steer.data).toMatchObject({ id: ids.steer, delivery: 'steer' })
    for (const key of ['queued', 'cancelled'] as const) {
      const queued = await api.ok('session.prompt', {
        params: { sessionID },
        body: { id: ids[key], text: texts[key], delivery: 'queue' }
      })
      expect(queued.data).toMatchObject({ id: ids[key], delivery: 'queue' })
    }
    // Idempotent: the same id again is the same item, not a second one.
    const again = await api.call('session.prompt', {
      params: { sessionID },
      body: { id: ids.queued, text: texts.queued, delivery: 'queue' }
    })
    expect(again.ok ? again.data.data.id : again.status).toBe(ids.queued)

    const inbox = await api.ok('session.inbox.list', { params: { sessionID } })
    expect(inbox.data.map((item) => item.id)).toEqual(
      expect.arrayContaining([ids.queued, ids.cancelled])
    )
    await api.ok('session.inbox.cancel', { params: { sessionID, inboxID: ids.cancelled } })
    await feed.waitFor('session.inbox.cancelled', {
      sessionID,
      after: from,
      where: (event) => event.data.inboxID === ids.cancelled
    })

    // The queued item runs after the steered turn; wait for ITS turn to end.
    const delivered = await feed.waitFor('session.inbox.delivered', {
      sessionID,
      after: from,
      where: (event) => event.data.inboxID === ids.queued
    })
    const end = await feed.waitForTurnEnd(sessionID, feed.events.indexOf(delivered))
    expect(end.type).toBe('session.execution.succeeded')

    const enqueued = feed.select('session.inbox.enqueued', { sessionID, after: from })
    expect(enqueued.map((event) => event.data.inboxID).slice(1)).toEqual([
      ids.steer,
      ids.queued,
      ids.cancelled
    ])
    expect(enqueued[1].data.item).toMatchObject({ type: 'user', delivery: 'steer' })
    const deliveredIDs = feed
      .select('session.inbox.delivered', { sessionID, after: from })
      .map((event) => event.data.inboxID)
    expect(deliveredIDs.slice(1)).toEqual([ids.steer, ids.queued])

    // What the MODEL saw, in request order.
    const requests = fixture.mentioning(tag)
    const firstSteer = requests.findIndex((r) => userTexts(r).includes(texts.steer))
    const firstQueued = requests.findIndex((r) => userTexts(r).includes(texts.queued))
    expect(firstSteer).toBeGreaterThan(0)
    expect(userTexts(requests[firstSteer])).not.toContain(texts.queued)
    expect(firstQueued).toBeGreaterThan(firstSteer)
    expect(userTexts(requests[firstQueued]).slice(-3)).toEqual([
      `[slow] ${tag}`,
      texts.steer,
      texts.queued
    ])
    expect(requests.some((r) => JSON.stringify(r.messages).includes(texts.cancelled))).toBe(false)
  })

  it('a queued item can be promoted to steer (delivery.changed)', async () => {
    const { api, feed } = rig()
    const sessionID = await rig().createSession()
    const tag = nonce('promote')
    const id = `msg_claudeui_${randomBytes(6).toString('hex')}`
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: `[slow] ${tag}` } })
    await feed.waitFor('session.text.delta', { sessionID, after: from })
    await api.ok('session.prompt', {
      params: { sessionID },
      body: { id, text: `PROMOTED ${tag}`, delivery: 'queue' }
    })
    await api.ok('session.inbox.update', {
      params: { sessionID, inboxID: id },
      body: { delivery: 'steer' }
    })
    const changed = await feed.waitFor('session.inbox.delivery.changed', {
      sessionID,
      after: from
    })
    expect(changed.data).toEqual({ sessionID, inboxID: id, delivery: 'steer' })
    await feed.waitFor('session.inbox.delivered', {
      sessionID,
      after: from,
      where: (event) => event.data.inboxID === id
    })
    const end = await feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.succeeded')
  })
})
