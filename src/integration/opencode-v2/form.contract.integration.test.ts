/**
 * opencode 2.x contract: the `question` tool becomes a form (ADR-093 / spike
 * §5 → AskUserQuestion). A single-choice question is a `string` field with
 * options, and its answer is a STRING keyed by the field key — an array is
 * rejected.
 */
import { expect, it } from 'vitest'
import type { Form_Field } from '../../core/opencode/protocol-v2/openapi'
import { messageText } from './harness/fixture-provider'
import { describeV2, nonce, useRig } from './harness/host'

describeV2('opencode 2.x contract: question form', () => {
  const rig = useRig('form')

  it('(e) form.created shape; a single choice is answered with a string, not an array', async () => {
    const { api, feed, fixture } = rig()
    const sessionID = await rig().createSession()
    const tag = nonce('form')
    const from = feed.mark()
    await api.ok('session.prompt', { params: { sessionID }, body: { text: `[question] ${tag}` } })
    const created = await feed.waitFor('form.created', {
      after: from,
      where: (event) => event.data.form.sessionID === sessionID
    })
    const { form } = created.data
    expect(form.metadata).toMatchObject({ kind: 'question', tool: { id: expect.any(String) } })
    expect(form.fields).toHaveLength(1)
    const field: Form_Field = form.fields[0]
    expect(field).toMatchObject({
      key: 'q0',
      type: 'string',
      title: 'Fruit',
      description: 'Pick a fruit?',
      custom: true
    })
    if (field.type !== 'string') throw new Error('expected a string field')
    expect(field.options?.map((option) => option.value)).toEqual(['Apple', 'Banana'])

    const asArray = await api.call('session.form.reply', {
      params: { sessionID, formID: form.id },
      body: { answer: { [field.key]: ['Banana'] } }
    })
    expect(asArray.ok).toBe(false)
    expect(asArray.status).toBe(400)
    if (!asArray.ok) expect(asArray.error).toMatchObject({ _tag: 'FormInvalidAnswerError' })

    await api.ok('session.form.reply', {
      params: { sessionID, formID: form.id },
      body: { answer: { [field.key]: 'Banana' } }
    })
    const replied = await feed.waitFor('form.replied', { sessionID, after: from })
    expect(replied.data).toEqual({ id: form.id, sessionID, answer: { q0: 'Banana' } })
    const end = await feed.waitForTurnEnd(sessionID, from)
    expect(end.type).toBe('session.execution.succeeded')
    const toolResult = fixture.mentioning(tag).at(-1)?.messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(messageText(toolResult?.content)).toContain('"Pick a fruit?"="Banana"')
  })
})
