// @vitest-environment node
/**
 * accountIdentityFromAuthEntry: the shapes opencode 2.x stores, as far as the
 * `external` entry (opencode 2.0.25+) is concerned. Keys here are invented.
 */
import { describe, expect, it } from 'vitest'
import { accountIdentityFromAuthEntry } from '../account-identity'

const identity = (entry: unknown, vendorId = 'azure') =>
  accountIdentityFromAuthEntry({
    engineId: 'opencode',
    vendorId,
    isChatgptVendor: vendorId === 'openai',
    entry
  })

describe('accountIdentityFromAuthEntry: external entries', () => {
  it('is the vendor’s native account, labelled with the credential source', () => {
    expect(identity({ type: 'external', methodId: 'azure-cli' })).toEqual({
      accountKey: 'opencode:azure:native',
      accountLabel: 'azure (azure-cli)'
    })
  })

  it('is never an API-key identity, even if the entry somehow carried a key', () => {
    const external = identity({ type: 'external', methodId: 'azure-cli', key: 'sk-invented' })
    expect(external.accountKey).toBe('opencode:azure:native')
    expect(external.accountKey).not.toBe(identity({ type: 'api', key: 'sk-invented' }).accountKey)
  })

  it('falls back to the bare vendor label without a method id', () => {
    expect(identity({ type: 'external' })).toEqual({
      accountKey: 'opencode:azure:native',
      accountLabel: 'azure'
    })
  })

  it('leaves the api and oauth shapes as they were', () => {
    expect(identity({ type: 'api', key: 'sk-invented' }).accountKey).toMatch(/^azure:key:/)
    expect(identity({ type: 'oauth', access: 'x' }).accountKey).toBe('opencode:azure:native')
  })
})
