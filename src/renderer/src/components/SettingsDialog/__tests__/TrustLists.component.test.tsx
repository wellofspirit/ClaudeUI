/**
 * Layer 2: `TrustListsSection` — the Trust & protection group (ADR-065 phase 4).
 *
 * The three classifier trust lists used to be edited twice, once per engine, in
 * `engines/<engine>.json#autoMode`. They are one set of values about the user's
 * environment, so they now live in one shared file and this is the only editor.
 *
 * Tested flows:
 *   1. Loads from `loadSharedAutoMode` and seeds all three list editors
 *   2. Each row says what an EMPTY list means — the load-bearing half of the
 *      semantics, and for protectedPatterns that a value REPLACES the heuristic
 *   3. Adding an entry saves the APPENDED list through `saveSharedAutoMode`
 *   4. Emptying a list saves it with the key ABSENT, never `[]`
 *   5. A save touches only the edited list; a failed save does not throw
 *   6. It is registered as the `trust-lists` section
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { SharedAutoModeConfig } from '../../../../../shared/types'

import { SECTIONS } from '../settings-sections'
import { TrustListsSection } from '../TrustLists'

const BASE: SharedAutoModeConfig = {
  trustedDomains: ['a.dev'],
  protectedPatterns: ['acme-live-*']
}

let saved: SharedAutoModeConfig[] = []
const saveSharedAutoMode = vi.fn(async (cfg: SharedAutoModeConfig) => {
  saved.push(structuredClone(cfg))
})

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadSharedAutoMode: vi.fn(async () => structuredClone(BASE)),
    saveSharedAutoMode,
    ...overrides
  }
}

async function renderLoaded(): Promise<void> {
  render(<TrustListsSection />)
  await waitFor(() => expect(screen.getByTestId('TrustListsSection.trustedDomains')).toBeTruthy())
}

function addItem(field: string, value: string): void {
  const root = screen.getByTestId(`TrustListsSection.${field}`)
  fireEvent.change(within(root).getByTestId(`TrustListsSection.${field}.input`), {
    target: { value }
  })
  fireEvent.click(within(root).getByTestId(`TrustListsSection.${field}.add`))
}

function removeItem(field: string, value: string): void {
  const root = screen.getByTestId(`TrustListsSection.${field}`)
  const chip = within(root)
    .getAllByTestId(`TrustListsSection.${field}.remove`)
    .find((b) => b.getAttribute('data-id') === value)
  if (!chip) throw new Error(`No ${field} chip for "${value}"`)
  fireEvent.click(chip)
}

function items(field: string): (string | null)[] {
  return within(screen.getByTestId(`TrustListsSection.${field}`))
    .queryAllByTestId(`TrustListsSection.${field}.item`)
    .map((el) => el.getAttribute('data-id'))
}

beforeEach(() => {
  saved = []
  vi.clearAllMocks()
  installApiStub()
})

afterEach(() => {
  cleanup()
})

describe('TrustListsSection — registration', () => {
  it('is the trust-lists section, with one item', () => {
    const section = SECTIONS.find((s) => s.id === 'trust-lists')
    expect(section).toBeDefined()
    expect(section!.label).toBe('Trust & protection')
    expect(section!.items.map((i) => i.key)).toEqual(['trustLists'])
  })
})

describe('TrustListsSection — load', () => {
  it('carries its testid while the file is still loading', () => {
    installApiStub({ loadSharedAutoMode: vi.fn(() => new Promise(() => {})) })
    render(<TrustListsSection />)
    expect(screen.getByTestId('TrustListsSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('TrustListsSection.trustedDomains')).toBeNull()
  })

  it('renders all three lists, seeded from the shared file', async () => {
    await renderLoaded()

    expect(items('trustedDomains')).toEqual(['a.dev'])
    expect(items('trustedRegistries')).toEqual([])
    expect(items('protectedPatterns')).toEqual(['acme-live-*'])
  })

  it('renders empty lists when the read fails, rather than staying blank', async () => {
    installApiStub({ loadSharedAutoMode: vi.fn(async () => Promise.reject(new Error('EACCES'))) })
    await renderLoaded()

    expect(items('trustedDomains')).toEqual([])
    expect(items('protectedPatterns')).toEqual([])
  })

  it('states what an EMPTY list means for each of the three', async () => {
    await renderLoaded()

    expect(screen.getByTestId('TrustListsSection.trustedDomains').textContent).toContain(
      'empty means no external destination is trusted'
    )
    expect(screen.getByTestId('TrustListsSection.trustedRegistries').textContent).toContain(
      "empty means only the project manifest's default registry"
    )
    const protectedText = screen.getByTestId('TrustListsSection.protectedPatterns').textContent!
    expect(protectedText).toContain("'prod'/'production' as a whole word or segment")
    // The one behaviour a user cannot infer from the field name.
    expect(protectedText).toContain('REPLACES that heuristic')
  })
})

describe('TrustListsSection — saves', () => {
  it('adding a registry saves the appended list and leaves the others alone', async () => {
    await renderLoaded()

    addItem('trustedRegistries', 'https://npm.acme.internal')

    expect(saveSharedAutoMode).toHaveBeenCalledTimes(1)
    expect(saved[0]).toEqual({
      trustedDomains: ['a.dev'],
      trustedRegistries: ['https://npm.acme.internal'],
      protectedPatterns: ['acme-live-*']
    })
  })

  it('appends rather than replaces when the list already has entries', async () => {
    await renderLoaded()

    addItem('trustedDomains', 'files.acme.com')

    expect(saved[0].trustedDomains).toEqual(['a.dev', 'files.acme.com'])
  })

  it('emptying a list DELETES the key — never writes []', async () => {
    await renderLoaded()

    removeItem('trustedDomains', 'a.dev')

    // The sessions read these behind `?.length`, so `[]` and absent mean the
    // same thing downstream — one encoding, not two.
    expect('trustedDomains' in saved[0]).toBe(false)
    expect(JSON.parse(JSON.stringify(saved[0]))).not.toHaveProperty('trustedDomains')
    // …and the untouched list survives.
    expect(saved[0].protectedPatterns).toEqual(['acme-live-*'])
    expect(items('trustedDomains')).toEqual([])
  })

  it('a re-added value comes back as a present key (absent ↔ populated round-trip)', async () => {
    await renderLoaded()

    removeItem('protectedPatterns', 'acme-live-*')
    expect(items('protectedPatterns')).toEqual([])
    addItem('protectedPatterns', 'k8s://prod-cluster')

    expect(saved).toHaveLength(2)
    expect(saved[1].protectedPatterns).toEqual(['k8s://prod-cluster'])
    expect(items('protectedPatterns')).toEqual(['k8s://prod-cluster'])
  })

  it('a rejected save does not throw out of the row', async () => {
    installApiStub({
      saveSharedAutoMode: vi.fn(async () => Promise.reject(new Error('disk full')))
    })
    await renderLoaded()

    expect(() => addItem('trustedDomains', 'files.acme.com')).not.toThrow()
    await waitFor(() => expect(items('trustedDomains')).toEqual(['a.dev', 'files.acme.com']))
  })
})
