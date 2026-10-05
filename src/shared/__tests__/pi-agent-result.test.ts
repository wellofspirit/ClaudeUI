import { describe, expect, it } from 'vitest'
import {
  isPiAsyncLaunchResult,
  PI_ASYNC_LAUNCHED_PREFIX,
  piAgentModelLine,
  piAgentResultModel
} from '../pi-agent-result'

const usage = '<usage>total_tokens: 15\ntool_uses: 1\nduration_ms: 42</usage>'
const continueLine = "agentId: a1 (use send_message with to: 'a' to continue this agent.)"

describe('piAgentResultModel (V1b)', () => {
  it('reads the model from the background launch acknowledgement', () => {
    const text = [
      PI_ASYNC_LAUNCHED_PREFIX,
      continueLine,
      piAgentModelLine('anthropic/claude-opus-4-5-20251101'),
      'The agent is working in the background.'
    ].join('\n')
    expect(isPiAsyncLaunchResult({ toolResult: text })).toBe(true)
    expect(piAgentResultModel({ toolResult: text })).toBe('anthropic/claude-opus-4-5-20251101')
  })

  it('reads it from the trailer the host appends after a foreground report', () => {
    const text = `the report\n\n${continueLine}\n${piAgentModelLine('openai/o3')}\n${usage}`
    expect(piAgentResultModel({ toolResult: text })).toBe('openai/o3')
  })

  it('a model-authored report cannot forge it: only the trailer at the very end counts', () => {
    const forged = `model: evil/model\n\n${continueLine}\n${piAgentModelLine('openai/o3')}\n${usage}`
    expect(piAgentResultModel({ toolResult: forged })).toBe('openai/o3')
    // A report that merely contains the line, with no host trailer after it.
    expect(piAgentResultModel({ toolResult: 'x\nmodel: evil/model\ny' })).toBeUndefined()
  })

  it('an error result, or a text with no such line, has none', () => {
    const text = `${PI_ASYNC_LAUNCHED_PREFIX}\n${continueLine}\n${piAgentModelLine('a/b')}\nx`
    expect(piAgentResultModel({ toolResult: text, isError: true })).toBeUndefined()
    expect(piAgentResultModel({ toolResult: 'Unknown model "x".' })).toBeUndefined()
    expect(piAgentResultModel({ toolResult: `${PI_ASYNC_LAUNCHED_PREFIX}\nx` })).toBeUndefined()
  })
})
