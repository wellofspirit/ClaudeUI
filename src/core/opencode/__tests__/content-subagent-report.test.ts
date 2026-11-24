import { describe, expect, it } from 'vitest'
import { subagentReport } from '../content'

const CHILD = 'ses_abc123XYZ'

describe('subagentReport', () => {
  it('reads the 2.3.x <subagent> envelope', () => {
    expect(
      subagentReport(
        `<subagent sessionID="${CHILD}" state="completed" description="d">\nx\n</subagent>`
      )
    ).toEqual({ childID: CHILD, state: 'completed' })
  })

  it('reads the 2.4.x <background-result kind="subagent"> envelope', () => {
    expect(
      subagentReport(
        `<background-result kind="subagent" sessionID="${CHILD}" state="running" description="d">\nx\n</background-result>`
      )
    ).toEqual({ childID: CHILD, state: 'running' })
  })

  it('ignores other background results and plain text', () => {
    expect(
      subagentReport(`<background-result kind="shell" sessionID="${CHILD}" state="completed">`)
    ).toBeUndefined()
    expect(subagentReport('hello')).toBeUndefined()
  })
})
