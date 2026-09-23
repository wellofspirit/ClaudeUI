/**
 * @vitest-environment node
 *
 * The `<task-notification>` reader shared by the history loader and
 * ClaudeSession's user-message path. Fixtures follow what cli.js 2.1.280 writes
 * (probed 2026-09-23) plus the older `key: N` usage form.
 */
import { describe, it, expect } from 'vitest'
import { parseNotificationUsage, parseTaskNotificationXml } from '../task-notification-xml'

const CURRENT =
  '<task-notification>\n<task-id>a63d5f10b49aadaff</task-id>\n' +
  '<tool-use-id>toolu_01NYVUkgGupR264LhrUXu1Dp</tool-use-id>\n' +
  '<output-file>/tmp/tasks/a63d5f10b49aadaff.output</output-file>\n' +
  '<status>completed</status>\n<summary>Agent "regression done" finished</summary>\n' +
  '<note>A task-notification fires each time this agent stops.</note>\n<result>ONE</result>\n' +
  '<usage><subagent_tokens>22020</subagent_tokens><tool_uses>0</tool_uses><duration_ms>1191</duration_ms></usage>\n' +
  '</task-notification>'

describe('parseTaskNotificationXml', () => {
  it('reads every field of the 2.1.280 shape', () => {
    expect(parseTaskNotificationXml(CURRENT)).toEqual({
      taskId: 'a63d5f10b49aadaff',
      status: 'completed',
      summary: 'Agent "regression done" finished',
      outputFile: '/tmp/tasks/a63d5f10b49aadaff.output',
      usage: { totalTokens: 22020, toolUses: 0, durationMs: 1191 },
      runToolUseId: 'toolu_01NYVUkgGupR264LhrUXu1Dp',
      raw: CURRENT
    })
  })

  it('finds the block inside surrounding text, and dedups on the block alone', () => {
    const parsed = parseTaskNotificationXml(`prefix ${CURRENT} suffix`)
    expect(parsed?.raw).toBe(CURRENT)
  })

  it('has no run id for the --resume reap, which carries none', () => {
    const reap =
      '<task-notification>\n<task-id>acb38d350312a25c3</task-id>\n<status>stopped</status>\n' +
      '<summary>…didn’t finish before the previous session ended</summary>\n</task-notification>'
    const parsed = parseTaskNotificationXml(reap)
    expect(parsed?.status).toBe('stopped')
    expect(parsed).not.toHaveProperty('runToolUseId')
    expect(parsed).not.toHaveProperty('usage')
  })

  it("normalizes cli.js's `killed` to `stopped` and drops a status it does not know", () => {
    const withStatus = (status: string): string =>
      `<task-notification><task-id>t1</task-id><status>${status}</status></task-notification>`
    expect(parseTaskNotificationXml(withStatus('killed'))?.status).toBe('stopped')
    expect(parseTaskNotificationXml(withStatus('pondering'))).not.toHaveProperty('status')
  })

  it('is null without a notification block or a task id', () => {
    expect(parseTaskNotificationXml('just a prompt')).toBeNull()
    expect(
      parseTaskNotificationXml('<task-notification><status>completed</status></task-notification>')
    ).toBeNull()
  })
})

describe('parseNotificationUsage', () => {
  it('reads the child-element form', () => {
    expect(
      parseNotificationUsage(
        '<subagent_tokens>22020</subagent_tokens><tool_uses>3</tool_uses><duration_ms>1191</duration_ms>'
      )
    ).toEqual({ totalTokens: 22020, toolUses: 3, durationMs: 1191 })
  })

  it('still reads the older `key: N` form', () => {
    expect(parseNotificationUsage('total_tokens: 1234\ntool_uses: 5\nduration_ms: 6789')).toEqual({
      totalTokens: 1234,
      toolUses: 5,
      durationMs: 6789
    })
  })

  it('never invents a usage of zeros from a block it cannot read', () => {
    expect(parseNotificationUsage('')).toBeUndefined()
    expect(parseNotificationUsage('<cost_usd>0.4</cost_usd>')).toBeUndefined()
  })
})
