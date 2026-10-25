/**
 * @vitest-environment node
 *
 * The per-child judge records (S1): resolved from the owner CALL id the mapper
 * stamps on a child's outputs, kept by child SESSION id.
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../shared/types'
import { TARGET_TRAJECTORY_MAX } from '../../automode/trajectory'
import { ChildJudgeStates } from '../child-judge-state'

const assistant = (id: string, content: ChatMessage['content'], timestamp = 1): ChatMessage => ({
  id,
  role: 'assistant',
  content,
  timestamp
})

describe('ChildJudgeStates', () => {
  it('records under the child a call linked, never an unlinked call', () => {
    const states = new ChildJudgeStates()
    states.recordMessage('call_x', assistant('m0', [{ type: 'text', text: 'lost' }]))
    states.linkCall('call_a', 'ses_a')
    states.recordMessage('call_a', assistant('m1', [{ type: 'text', text: 'hi' }]))
    expect([...states.state('ses_a').trajectory.keys()]).toEqual(['m1'])
    expect(states.state('ses_b').trajectory.size).toBe(0)
  })

  it('a resumed child (two calls) and a grandchild resolve to their own sessions', () => {
    const states = new ChildJudgeStates()
    states.linkCall('call_a', 'ses_a')
    states.linkCall('call_a2', 'ses_a')
    states.linkCall('call_g', 'ses_g')
    states.recordMessage('call_a', assistant('m1', []))
    states.recordMessage('call_a2', assistant('m2', []))
    states.recordMessage('call_g', assistant('m3', []))
    expect([...states.state('ses_a').trajectory.keys()]).toEqual(['m1', 'm2'])
    expect([...states.state('ses_g').trajectory.keys()]).toEqual(['m3'])
  })

  it('strips thinking blocks, keeps everything else, and upserts a re-emitted step by id', () => {
    const states = new ChildJudgeStates()
    states.linkCall('call_a', 'ses_a')
    const text = { type: 'text', text: 'ok' } as const
    states.recordMessage(
      'call_a',
      assistant('m1', [{ type: 'thinking', text: 'secret musings' }, text])
    )
    expect(states.state('ses_a').trajectory.get('m1')?.content).toEqual([text])
    states.recordMessage('call_a', assistant('m1', [text, text]))
    expect(states.state('ses_a').trajectory.size).toBe(1)
    expect(states.state('ses_a').trajectory.get('m1')?.content).toHaveLength(2)
  })

  it('ignores user-role messages and bounds the trajectory', () => {
    const states = new ChildJudgeStates()
    states.linkCall('call_a', 'ses_a')
    states.recordMessage('call_a', { ...assistant('u', []), role: 'user' })
    for (let i = 0; i < TARGET_TRAJECTORY_MAX + 5; i++)
      states.recordMessage('call_a', assistant(`m${i}`, []))
    const keys = [...states.state('ses_a').trajectory.keys()]
    expect(keys).toHaveLength(TARGET_TRAJECTORY_MAX)
    expect(keys[0]).toBe('m5')
  })

  it('outcomes and denial caps are per child session', () => {
    const states = new ChildJudgeStates()
    states.linkCall('call_a', 'ses_a')
    states.recordOutcomeByOwner('call_a', 't1', 'error')
    states.recordOutcomeByOwner('call_unlinked', 't2', 'error')
    states.recordOutcome('ses_a', 't3', 'automode-blocked')
    expect([...states.state('ses_a').outcomes]).toEqual([
      ['t1', 'error'],
      ['t3', 'automode-blocked']
    ])
    expect(states.state('ses_b').outcomes.size).toBe(0)
    expect(states.state('ses_a').denials).not.toBe(states.state('ses_b').denials)
    expect(states.state('ses_a')).toBe(states.state('ses_a'))
  })

  it('seeds a reopened chat from the children’s stored steps: assistant content, results as outcomes', () => {
    const states = new ChildJudgeStates()
    const tokens = { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }
    states.seedFromHistory(
      new Map([
        [
          'ses_a',
          [
            { id: 'msg_u', type: 'user', text: 'the prompt', time: { created: 1 } },
            {
              id: 'msg_a1',
              type: 'assistant',
              agent: 'explore',
              model: { providerID: 'p', id: 'm' },
              content: [
                { type: 'reasoning', text: 'secret musings' },
                {
                  type: 'tool',
                  id: 't1',
                  name: 'shell',
                  state: {
                    status: 'error',
                    input: { command: 'ls' },
                    error: { type: 'x', message: 'boom' }
                  },
                  time: { created: 2 }
                }
              ],
              cost: 0.01,
              tokens,
              time: { created: 2, completed: 3 }
            }
          ]
        ]
      ] as never)
    )
    const seeded = states.state('ses_a')
    expect([...seeded.trajectory.keys()]).toEqual(['msg_a1'])
    // No thinking and no tool_result block: the live snapshots carry neither.
    expect(seeded.trajectory.get('msg_a1')?.content.map((b) => b.type)).toEqual(['tool_use'])
    expect([...seeded.outcomes]).toEqual([['t1', 'error']])
  })
})
