/**
 * Component tests for the `/remote` password login (Phase 2) plus the
 * sessionStorage proof cache that lets a same-tab reconnect skip the form.
 *
 * `derivePasswordProof` is mocked: real scrypt at N=32768 costs ~100ms+ per call
 * and this file is about the UI states (idle → deriving → error), not the KDF.
 * Cross-library KDF agreement is pinned by
 * `src/main/services/__tests__/remote-auth-kdf.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react'
import { PasswordLogin } from '../components/PasswordLogin'
import {
  proofCacheKey,
  readCachedProof,
  writeCachedProof,
  clearCachedProof
} from '../password-proof'
import type { RemoteKdfParams } from '../../shared/remote-protocol'

const { deriveMock } = vi.hoisted(() => ({ deriveMock: vi.fn() }))
vi.mock('../password-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../password-proof')>()
  return { ...actual, derivePasswordProof: deriveMock }
})

const SALT = 'ab'.repeat(16)
const KDF: RemoteKdfParams = { algo: 'scrypt', N: 32768, r: 8, p: 1, dkLen: 32 }
const PROOF = 'cd'.repeat(32)

function type(value: string): void {
  fireEvent.change(screen.getByTestId('PasswordLogin.input'), { target: { value } })
}

describe('PasswordLogin', () => {
  beforeEach(() => {
    deriveMock.mockReset()
    sessionStorage.clear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the form with the submit disabled until a password is typed', () => {
    render(<PasswordLogin saltHex={SALT} kdf={KDF} onProof={vi.fn()} />)
    expect(screen.getByTestId('PasswordLogin')).toBeInTheDocument()
    expect(screen.getByTestId('PasswordLogin.submit')).toBeDisabled()
    expect(screen.queryByTestId('PasswordLogin.error')).toBeNull()

    type('hunter2hunter2')
    expect(screen.getByTestId('PasswordLogin.submit')).toBeEnabled()
  })

  it('shows the deriving state while scrypt runs, then hands the proof up', async () => {
    let release!: (proof: string) => void
    deriveMock.mockImplementation(() => new Promise<string>((resolve) => (release = resolve)))
    const onProof = vi.fn()
    render(<PasswordLogin saltHex={SALT} kdf={KDF} onProof={onProof} />)

    type('hunter2hunter2')
    const submit = screen.getByTestId('PasswordLogin.submit')
    fireEvent.click(submit)

    // Busy: label flips, controls lock, nothing handed up yet.
    await waitFor(() => expect(submit).toHaveTextContent('Deriving key…'))
    expect(screen.getByTestId('PasswordLogin.input')).toBeDisabled()
    expect(onProof).not.toHaveBeenCalled()

    // The params advertised by auth-info are what we derive from — never constants.
    expect(deriveMock).toHaveBeenCalledWith('hunter2hunter2', SALT, KDF)

    await act(async () => {
      release(PROOF)
    })
    expect(onProof).toHaveBeenCalledWith(PROOF)
  })

  it('surfaces a derivation failure inline and re-enables the form', async () => {
    deriveMock.mockRejectedValue(new Error('Unsupported password KDF: argon2id'))
    const onProof = vi.fn()
    render(<PasswordLogin saltHex={SALT} kdf={KDF} onProof={onProof} />)

    type('hunter2hunter2')
    await act(async () => {
      fireEvent.click(screen.getByTestId('PasswordLogin.submit'))
    })

    expect(screen.getByTestId('PasswordLogin.error')).toHaveTextContent(
      'Unsupported password KDF: argon2id'
    )
    expect(onProof).not.toHaveBeenCalled()
    expect(screen.getByTestId('PasswordLogin.submit')).toBeEnabled()
  })

  it('renders the rejection error handed down by the auth flow', () => {
    render(<PasswordLogin saltHex={SALT} kdf={KDF} error="Invalid password" onProof={vi.fn()} />)
    expect(screen.getByTestId('PasswordLogin.error')).toHaveTextContent('Invalid password')
  })
})

describe('proof cache (sessionStorage)', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('round-trips a proof under a salt-scoped key', () => {
    expect(readCachedProof(SALT)).toBeNull()
    writeCachedProof(SALT, PROOF)
    expect(sessionStorage.getItem(proofCacheKey(SALT))).toBe(PROOF)
    expect(readCachedProof(SALT)).toBe(PROOF)
  })

  // A password change rotates the salt, so the old entry can never be read back
  // — the cache self-invalidates without any explicit eviction.
  it("a different salt does not see the previous salt's proof", () => {
    writeCachedProof(SALT, PROOF)
    expect(readCachedProof('ef'.repeat(16))).toBeNull()
  })

  it('ignores a malformed cached value instead of sending it', () => {
    sessionStorage.setItem(proofCacheKey(SALT), 'not-a-proof')
    expect(readCachedProof(SALT)).toBeNull()
    sessionStorage.setItem(proofCacheKey(SALT), 'ab'.repeat(20))
    expect(readCachedProof(SALT)).toBeNull()
  })

  it('clears on a definitive rejection', () => {
    writeCachedProof(SALT, PROOF)
    clearCachedProof(SALT)
    expect(readCachedProof(SALT)).toBeNull()
  })

  it('never stores the password itself', () => {
    writeCachedProof(SALT, PROOF)
    const dump = JSON.stringify(
      Object.fromEntries(
        Array.from({ length: sessionStorage.length }, (_, i) => {
          const key = sessionStorage.key(i)!
          return [key, sessionStorage.getItem(key)]
        })
      )
    )
    expect(dump).not.toContain('hunter2hunter2')
    expect(dump).toContain(PROOF)
  })
})
