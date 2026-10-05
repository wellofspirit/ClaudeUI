import { describe, expect, it } from 'vitest'
import {
  classifyPiAgentFailure,
  failureSummary,
  parsePiAgentFailure,
  type PiAgentFailureInput
} from '../pi-agent-failure'
import { isPiAuthStatus, piErrorStatusCode } from '../pi-error-status'

const turn = (message: string): PiAgentFailureInput => ({ kind: 'turn-error', message })
const classify = (message: string) => classifyPiAgentFailure(turn(message))

describe('classifyPiAgentFailure (ADR-089 S1b) — one case per rule, first match wins', () => {
  it('1. a context overflow is permanent (several providers)', () => {
    for (const m of [
      'prompt is too long: 213462 tokens > 200000 maximum',
      '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      'Your input exceeds the context window of this model',
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
      'The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)',
      'context_length_exceeded',
      '400 status code (no body)'
    ]) {
      expect(classify(m), m).toBe('permanent')
    }
  })

  it('1. overflow beats retryable: an overflow that also names a retryable status stays permanent', () => {
    // "500" would match the retryable pattern; the overflow check runs first.
    expect(classify('500 prompt is too long: 213462 tokens > 200000 maximum')).toBe('permanent')
    expect(classify('503 {"error":"Your input exceeds the context window of this model"}')).toBe(
      'permanent'
    )
  })

  it('1. throttling that mentions tokens is NOT an overflow (pi NON_OVERFLOW_PATTERNS) and stays retryable', () => {
    expect(classify('Rate limit reached: too many tokens per minute')).toBe('transient')
    expect(classify('429 Too many requests, too many tokens')).toBe('transient')
  })

  it('2. a rejected credential (anchored 401/403) is transient', () => {
    expect(classify('401 {"type":"error","error":{"type":"authentication_error"}}')).toBe(
      'transient'
    )
    expect(classify('OpenAI API error (401): {"error":{"message":"bad key"}}')).toBe('transient')
    expect(classify('OpenAI API error (403): 403 status code (no body)')).toBe('transient')
  })

  it('2. the status is anchored: prose that merely contains 401 is not auth (and, matching nothing, is permanent)', () => {
    expect(classify('the previous 401 has been cleared, but the tool failed')).toBe('permanent')
    // And a 4-digit number or a trailing 401 is not a status either.
    expect(classify('code 4011 returned by the tool')).toBe('permanent')
    expect(piErrorStatusCode('the previous 401 has been cleared')).toBeNull()
  })

  it('3. quota and usage limits are transient', () => {
    for (const m of [
      'insufficient_quota: You exceeded your current quota',
      'GoUsageLimitError: limit reached',
      'Monthly usage limit reached',
      'quota exceeded for this project',
      'Your credit balance is too low; check billing'
    ]) {
      expect(classify(m), m).toBe('transient')
    }
  })

  it("4. pi's retryable provider and transport errors are transient", () => {
    for (const m of [
      '529 {"type":"error","error":{"type":"overloaded_error"}}',
      'Provider returned error',
      'fetch failed',
      'The operation timed out',
      'connection lost',
      '503 Service Unavailable',
      'stream ended before message_stop',
      'ECONNRESET: socket hang up',
      'Too many requests'
    ]) {
      expect(classify(m), m).toBe('transient')
    }
  })

  it('5. a crashed child process is transient', () => {
    expect(classifyPiAgentFailure({ kind: 'process-exit' })).toBe('transient')
  })

  it('6. a launch failure is transient for a resume and permanent for the first run', () => {
    expect(classifyPiAgentFailure({ kind: 'launch-failure', firstRun: false })).toBe('transient')
    expect(classifyPiAgentFailure({ kind: 'launch-failure', firstRun: true })).toBe('permanent')
  })

  it('7. a refused /cui- prompt and anything unmatched are permanent', () => {
    expect(classifyPiAgentFailure({ kind: 'refused-command' })).toBe('permanent')
    expect(classify('The model returned something we do not understand')).toBe('permanent')
    expect(classify('')).toBe('permanent')
  })
})

describe('the shared status parse', () => {
  it('reads the anchored status of both adapter shapes; only 401/403 are auth', () => {
    expect(piErrorStatusCode('401 {"a":1}')).toBe(401)
    expect(piErrorStatusCode('OpenAI API error (403): x')).toBe(403)
    expect(isPiAuthStatus(401)).toBe(true)
    expect(isPiAuthStatus(403)).toBe(true)
    expect(isPiAuthStatus(429)).toBe(false)
    expect(isPiAuthStatus(null)).toBe(false)
  })
})

describe('failureSummary / parsePiAgentFailure', () => {
  it('keeps the first line, at most 200 characters', () => {
    expect(failureSummary('first\nsecond')).toBe('first')
    expect(failureSummary('x'.repeat(500))).toHaveLength(200)
    expect(failureSummary('')).toBe('')
  })

  it('accepts only the two known values (history is untrusted data)', () => {
    expect(parsePiAgentFailure('transient')).toBe('transient')
    expect(parsePiAgentFailure('permanent')).toBe('permanent')
    expect(parsePiAgentFailure('bogus')).toBeUndefined()
    expect(parsePiAgentFailure(undefined)).toBeUndefined()
    expect(parsePiAgentFailure(1)).toBeUndefined()
  })
})
