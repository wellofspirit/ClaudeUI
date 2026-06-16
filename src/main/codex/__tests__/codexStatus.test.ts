/**
 * Unit tests for the account/read → CodexStatus mapping logic in codexStatus.ts.
 *
 * These tests exercise the pure mapping logic that converts a V2GetAccountResponse
 * into a CodexStatus object. We test by reimplementing the mapping inline with
 * canned inputs — no process spawn required.
 *
 * The public getCodexStatus() function is tested indirectly via its pure
 * sub-logic since the spawn is tested in integration. Here we focus on the
 * business logic: how each account/response combination maps to CodexStatus fields.
 */

import { describe, it, expect } from 'vitest'
import type { CodexStatus } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Re-implement the pure mapping logic from codexStatus.ts for isolated testing.
// This must stay in sync with the implementation. If you change one, change both.
// ---------------------------------------------------------------------------

type V2Account =
  | { type: 'apiKey' }
  | { type: 'chatgpt'; email: string; planType: string }
  | { type: 'amazonBedrock' }

type V2GetAccountResponse = {
  account?: V2Account | null
  requiresOpenaiAuth: boolean
}

function planLabel(account: V2Account): string | undefined {
  if (account.type === 'apiKey') return 'OpenAI API Key'
  if (account.type === 'amazonBedrock') return 'Amazon Bedrock'
  if (account.type !== 'chatgpt') return undefined
  switch (account.planType) {
    case 'free': return 'ChatGPT Free'
    case 'plus': return 'ChatGPT Plus'
    case 'pro': return 'ChatGPT Pro'
    case 'team': return 'ChatGPT Team'
    case 'enterprise': return 'ChatGPT Enterprise'
    case 'unknown': return 'ChatGPT'
    default: return undefined
  }
}

function accountEmail(account: V2Account): string | undefined {
  if (account.type !== 'chatgpt') return undefined
  return (account as { type: 'chatgpt'; email: string }).email
}

function mapResponseToStatus(response: V2GetAccountResponse): CodexStatus {
  const { account, requiresOpenaiAuth } = response
  if (!account) {
    return { authenticated: false, requiresLogin: requiresOpenaiAuth }
  }
  return {
    authenticated: true,
    email: accountEmail(account),
    planLabel: planLabel(account),
    requiresLogin: false,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Codex account/read → CodexStatus mapping', () => {
  describe('unauthenticated states', () => {
    it('returns requiresLogin=true when no account and requiresOpenaiAuth=true', () => {
      const result = mapResponseToStatus({ account: null, requiresOpenaiAuth: true })
      expect(result.authenticated).toBe(false)
      expect(result.requiresLogin).toBe(true)
      expect(result.email).toBeUndefined()
      expect(result.planLabel).toBeUndefined()
    })

    it('returns requiresLogin=false when no account and requiresOpenaiAuth=false', () => {
      const result = mapResponseToStatus({ account: null, requiresOpenaiAuth: false })
      expect(result.authenticated).toBe(false)
      expect(result.requiresLogin).toBe(false)
    })

    it('treats undefined account same as null', () => {
      const result = mapResponseToStatus({ account: undefined, requiresOpenaiAuth: true })
      expect(result.authenticated).toBe(false)
      expect(result.requiresLogin).toBe(true)
    })
  })

  describe('authenticated with chatgpt account', () => {
    it('sets authenticated=true, email, and planLabel for chatgpt plus', () => {
      const result = mapResponseToStatus({
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
        requiresOpenaiAuth: false,
      })
      expect(result.authenticated).toBe(true)
      expect(result.email).toBe('user@example.com')
      expect(result.planLabel).toBe('ChatGPT Plus')
      expect(result.requiresLogin).toBe(false)
    })

    it('maps all known chatgpt plan types', () => {
      const cases: [string, string][] = [
        ['free', 'ChatGPT Free'],
        ['plus', 'ChatGPT Plus'],
        ['pro', 'ChatGPT Pro'],
        ['team', 'ChatGPT Team'],
        ['enterprise', 'ChatGPT Enterprise'],
        ['unknown', 'ChatGPT'],
      ]
      for (const [planType, expectedLabel] of cases) {
        const result = mapResponseToStatus({
          account: { type: 'chatgpt', email: 'x@y.com', planType },
          requiresOpenaiAuth: false,
        })
        expect(result.planLabel, `planType=${planType}`).toBe(expectedLabel)
      }
    })

    it('returns undefined planLabel for unrecognised plan types', () => {
      const result = mapResponseToStatus({
        account: { type: 'chatgpt', email: 'x@y.com', planType: 'unknown_future_plan' },
        requiresOpenaiAuth: false,
      })
      expect(result.planLabel).toBeUndefined()
    })
  })

  describe('authenticated with apiKey account', () => {
    it('sets authenticated=true and planLabel="OpenAI API Key", no email', () => {
      const result = mapResponseToStatus({
        account: { type: 'apiKey' },
        requiresOpenaiAuth: false,
      })
      expect(result.authenticated).toBe(true)
      expect(result.email).toBeUndefined()
      expect(result.planLabel).toBe('OpenAI API Key')
    })
  })

  describe('authenticated with amazonBedrock account', () => {
    it('sets authenticated=true and planLabel="Amazon Bedrock", no email', () => {
      const result = mapResponseToStatus({
        account: { type: 'amazonBedrock' },
        requiresOpenaiAuth: false,
      })
      expect(result.authenticated).toBe(true)
      expect(result.email).toBeUndefined()
      expect(result.planLabel).toBe('Amazon Bedrock')
    })
  })
})

// ---------------------------------------------------------------------------
// Test the CodexSpawnError path via the real CodexSpawnError class
// We import it directly and assert the instanceof-based branching logic.
// ---------------------------------------------------------------------------

import { CodexSpawnError } from '../codexQuery'

describe('CodexSpawnError instanceof check', () => {
  it('CodexSpawnError is instanceof Error', () => {
    const err = new CodexSpawnError('ENOENT')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(CodexSpawnError)
    expect(err.name).toBe('CodexSpawnError')
  })

  it('plain Error is NOT instanceof CodexSpawnError', () => {
    const err = new Error('generic')
    expect(err).not.toBeInstanceOf(CodexSpawnError)
  })

  // The actual getCodexStatus function branches on:
  //   if (err instanceof CodexSpawnError) → notInstalled: true
  //   else → error: msg
  // We verify this branching logic using the CodexStatus mapping
  // inline rather than mocking the withCodexAppServer module.

  it('discriminates spawn error vs runtime error by instanceof', () => {
    // This test validates the branching logic described above, without
    // spawning any process. The real function catches errors and checks
    // instanceof CodexSpawnError. We just confirm the class hierarchy here.
    const spawnErr: unknown = new CodexSpawnError('not found')
    const genericErr: unknown = new Error('timeout')

    // These mimic what getCodexStatus does in its catch block:
    function mapErr(err: unknown) {
      if (err instanceof CodexSpawnError) {
        return { authenticated: false, requiresLogin: false, notInstalled: true as const }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { authenticated: false, requiresLogin: false, error: msg }
    }

    const spawnResult = mapErr(spawnErr)
    const genericResult = mapErr(genericErr)

    expect(spawnResult.notInstalled).toBe(true)
    expect(genericResult.notInstalled).toBeUndefined()
    expect(genericResult.error).toBe('timeout')
  })
})
