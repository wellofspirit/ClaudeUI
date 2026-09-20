/**
 * @vitest-environment node
 *
 * ADR-071 §3 — the account key's exact strings. A key names a SUBSCRIPTION, so
 * the subscription's id leads; and every stored row is keyed by these strings,
 * so a later refactor that changes one silently re-keys the whole ledger. That
 * is what this file exists to stop.
 */

import { describe, it, expect } from 'vitest'
import {
  API_KEY_DIGEST_LENGTH,
  API_KEY_DIGEST_PREFIX,
  UNKNOWN_ACCOUNT_KEY,
  anthropicAccountKey,
  apiKeyAccountKeyFromDigest,
  apiKeyAccountLabel,
  chatgptAccountKey,
  nativeAccountKey
} from '../account-key'

describe('anthropicAccountKey', () => {
  it('leads with the organization, because that is what separates two plans', () => {
    expect(anthropicAccountKey('org-uuid-1', 'acct-uuid-2')).toBe(
      'anthropic:org-uuid-1:acct-uuid-2'
    )
  })

  it('keeps two accounts inside one organization apart', () => {
    expect(anthropicAccountKey('org-1', 'acct-a')).not.toBe(anthropicAccountKey('org-1', 'acct-b'))
  })
})

describe('chatgptAccountKey', () => {
  it('is the workspace id and the user claim', () => {
    expect(chatgptAccountKey('acct_123', 'user_abc')).toBe('chatgpt:acct_123:user_abc')
  })

  it('keeps a personal and a business plan under one user apart', () => {
    expect(chatgptAccountKey('acct_personal', 'user_abc')).not.toBe(
      chatgptAccountKey('acct_business', 'user_abc')
    )
  })

  it('still names the subscription when the token carries no user claim', () => {
    expect(chatgptAccountKey('acct_123', undefined)).toBe('chatgpt:acct_123:unknown')
    expect(chatgptAccountKey('acct_123', '')).toBe('chatgpt:acct_123:unknown')
  })
})

describe('nativeAccountKey', () => {
  it('names the engine and the vendor, for credentials we cannot identify', () => {
    expect(nativeAccountKey('opencode', 'anthropic')).toBe('opencode:anthropic:native')
    expect(nativeAccountKey('pi', 'openai-codex')).toBe('pi:openai-codex:native')
  })
})

describe('the API-key key shape', () => {
  it('is <vendor>:key:<digest>', () => {
    expect(apiKeyAccountKeyFromDigest('openrouter', 'f6b9eb5c99cab124')).toBe(
      'openrouter:key:f6b9eb5c99cab124'
    )
  })

  it('pins the digest input and width — changing either re-keys every stored row', () => {
    expect(API_KEY_DIGEST_PREFIX).toBe('claudeui-account-key-v1:')
    expect(API_KEY_DIGEST_LENGTH).toBe(16)
  })
})

describe('apiKeyAccountLabel', () => {
  it('shows the last four characters, as a provider console does', () => {
    expect(apiKeyAccountLabel('openrouter', 'sk-or-v1-test-key-0000a41f')).toBe(
      'openrouter key …a41f'
    )
  })

  it('shows no suffix at all on a key short enough for four characters to matter', () => {
    // The label is stored on every row and travels to the hub, so a short key
    // gets none of itself in it. The digest still separates the accounts.
    expect(apiKeyAccountLabel('vendor', '123456789')).toBe('vendor key …6789')
    expect(apiKeyAccountLabel('vendor', '12345678')).toBe('vendor key')
    expect(apiKeyAccountLabel('vendor', 'ab')).toBe('vendor key')
    expect(apiKeyAccountLabel('vendor', '')).toBe('vendor key')
  })
})

describe('UNKNOWN_ACCOUNT_KEY', () => {
  it('is the literal the v18 column defaults to', () => {
    expect(UNKNOWN_ACCOUNT_KEY).toBe('unknown')
  })
})
