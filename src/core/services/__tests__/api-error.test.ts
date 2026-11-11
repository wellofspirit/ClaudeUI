/**
 * @vitest-environment node
 *
 * Unit tests for API-error classification (ADR-014). The `'authentication'`
 * bucket is the one with behavioural weight — it drives the renderer's inline
 * Login action — so the 401 / expired-token phrasings cli.js emits must all
 * land there.
 */
import { describe, it, expect } from 'vitest'
import { classifyApiError } from '../api-error'

describe('classifyApiError', () => {
  it('classifies the live 401 wording as authentication', () => {
    expect(
      classifyApiError('Failed to authenticate. API Error: 401 Invalid authentication credentials')
    ).toBe('authentication')
  })

  it('classifies expired-token / login phrasings as authentication', () => {
    expect(classifyApiError('OAuth token has expired')).toBe('authentication')
    expect(classifyApiError('Please run /login')).toBe('authentication')
    expect(classifyApiError('authentication_error: unauthenticated')).toBe('authentication')
  })

  it('uses the wire error code as the authoritative signal', () => {
    // The live SDK frame for a 401 carries error="authentication_failed" with a
    // generic text; the code must win.
    expect(
      classifyApiError(
        'Failed to authenticate. API Error: 401 Invalid bearer token',
        'authentication_failed'
      )
    ).toBe('authentication')
    // Code present but non-auth → still classify (text drives the rest).
    expect(classifyApiError('overloaded', 'overloaded_error')).toBe('overloaded')
  })

  it('classifies other API error families', () => {
    expect(classifyApiError('API Error: 429 rate_limit_exceeded')).toBe('rate_limit')
    expect(classifyApiError('Error 529: Overloaded')).toBe('overloaded')
    expect(classifyApiError('400 invalid_request_error')).toBe('invalid_request')
  })

  it('falls back to api_error for unrecognized text', () => {
    expect(classifyApiError('Something unexpected went wrong')).toBe('api_error')
  })
})
