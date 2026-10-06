/**
 * opencode 2.x contract: non-fatal denial (ADR-093 §3, spike blocker 1).
 * A reject WITH a message fails only the tool — the model reads the message as
 * the tool result and the turn goes on. A reject WITHOUT one ends the turn,
 * which is why every ClaudeUI reject must carry a message.
 */
import { expect, it } from 'vitest'
import { messageText, SHELL_COMMAND } from './harness/fixture-provider'
import { describeV2, nonce, useRig } from './harness/host'

const DENIAL = 'ClaudeUI denied: use a read-only command instead'

describeV2('opencode 2.x contract: permission replies', () => {
  const rig = useRig('permission')

  /** Prompts a shell call and answers its ask with `reply`. */
  async function askAndReply(reply: { decision: 'once' | 'reject'; message?: string }) {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    const tag = nonce('perm')
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: `[tool] ${tag}` } })
    const asked = await feed.waitFor('permission.asked', { sessionID, after: from })
    expect(asked.data).toMatchObject({ action: 'shell', resources: [SHELL_COMMAND] })
    expect(asked.data.source).toMatchObject({ type: 'tool' })
    await api.ok('session.permission.reply', {
      params: { sessionID, requestID: asked.data.id },
      body: reply
    })
    const end = await feed.waitForTurnEnd(sessionID, from)
    const replied = feed.select('permission.replied', { sessionID, after: from })
    const failed = feed.select('session.tool.failed', { sessionID, after: from })
    return { end, replied, failed, requests: fixture.mentioning(tag) }
  }

  it('(b1) reject WITH a message: the model sees the message and the turn succeeds', async () => {
    const { end, replied, failed, requests } = await askAndReply({
      decision: 'reject',
      message: DENIAL
    })
    expect(replied.map((event) => event.data.reply)).toEqual(['reject'])
    expect(failed).toHaveLength(1)
    expect(failed[0].data.error).toEqual({ type: 'permission.rejected', message: DENIAL })
    // Request 1 asked for the tool; request 2 carries the denial as its tool result.
    expect(requests).toHaveLength(2)
    const toolResult = requests[1].messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(messageText(toolResult?.content)).toContain(DENIAL)
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(b2) reject WITHOUT a message: the tool aborts and the turn is interrupted', async () => {
    const { end, failed, requests } = await askAndReply({ decision: 'reject' })
    expect(failed).toHaveLength(1)
    expect(failed[0].data.error.type).toBe('aborted')
    // The model is never asked again.
    expect(requests).toHaveLength(1)
    expect(end.type).toBe('session.execution.interrupted')
    // Not 'user': a mapper must not read this reason as "the server shut down".
    if (end.type === 'session.execution.interrupted') expect(end.data.reason).toBe('shutdown')
  })

  it('once: the shell runs and the model sees its output', async () => {
    const { end, failed, requests } = await askAndReply({ decision: 'once' })
    expect(failed).toHaveLength(0)
    expect(requests).toHaveLength(2)
    expect(messageText(requests[1].messages.at(-1)?.content)).toContain('contract-tool-ran')
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('a deny rule is non-fatal too, with opencode’s own message', async () => {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    await api.ok('session.update', {
      params: { sessionID },
      body: {
        permissions: [
          { action: '*', resource: '*', effect: 'allow' },
          { action: 'shell', resource: 'echo *', effect: 'deny' }
        ]
      }
    })
    const tag = nonce('rule')
    const { end, from } = await rig().turn(sessionID, `[tool] ${tag}`)
    expect(feed.select('permission.asked', { sessionID, after: from })).toHaveLength(0)
    const failed = feed.select('session.tool.failed', { sessionID, after: from })
    expect(failed.map((event) => event.data.error.type)).toEqual(['permission.rejected'])
    expect(fixture.mentioning(tag)).toHaveLength(2)
    expect(end.type).toBe('session.execution.succeeded')
  })
})
