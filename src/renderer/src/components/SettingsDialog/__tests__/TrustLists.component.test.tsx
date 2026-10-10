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
 *   7. The two judge guidance rows (ADR-083 §4) render below the trust lists and
 *      save through the same path, alongside the other lists, absent when emptied
 *   8. The guidance rows refuse what the IPC perimeter would (tabs/line breaks,
 *      over 300 characters, past 50 entries) BEFORE saving, with an inline error
 *   9. A failed save is surfaced inline and the section reloads the file, so it
 *      never shows an entry that is not on disk
 *  10. The read-only bypass switch (ADR-084 §1) sits above the lists, is ON when
 *      the key is absent, and saves only an explicit `false`
 *  11. The block hold window (ADR-091 part 6) sits beside it: No hold when
 *      absent, saves the chosen seconds, and No hold as an absent key
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

describe('TrustListsSection — judge guidance rows (ADR-083 §4)', () => {
  it('renders both rows after the three trust lists, with their copy', async () => {
    await renderLoaded()

    const rows = screen
      .getAllByTestId(/^TrustListsSection\.[A-Za-z]+$/)
      .map((el) => el.getAttribute('data-testid'))
    expect(rows).toEqual([
      'TrustListsSection.readOnlyBypass',
      'TrustListsSection.blockHold',
      'TrustListsSection.trustedDomains',
      'TrustListsSection.trustedRegistries',
      'TrustListsSection.protectedPatterns',
      'TrustListsSection.judgeAllow',
      'TrustListsSection.judgeBlock'
    ])

    const allow = screen.getByTestId('TrustListsSection.judgeAllow')
    expect(allow.textContent).toContain('Routine for me')
    expect(allow.textContent).toContain('It still blocks data leaving your trust boundary')
    expect(
      within(allow).getByTestId('TrustListsSection.judgeAllow.input').getAttribute('placeholder')
    ).toBe('creating and switching git branches')

    const block = screen.getByTestId('TrustListsSection.judgeBlock')
    expect(block.textContent).toContain('Ask me first')
    expect(block.textContent).toContain('your reply clears it')
    expect(
      within(block).getByTestId('TrustListsSection.judgeBlock.input').getAttribute('placeholder')
    ).toBe('running database migrations')
  })

  it('seeds both rows from the shared file', async () => {
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({
        ...structuredClone(BASE),
        judgeAllow: ['creating git branches'],
        judgeBlock: ['running database migrations']
      }))
    })
    await renderLoaded()

    expect(items('judgeAllow')).toEqual(['creating git branches'])
    expect(items('judgeBlock')).toEqual(['running database migrations'])
  })

  it('adding guidance saves it ALONGSIDE the existing lists', async () => {
    await renderLoaded()

    addItem('judgeAllow', 'creating and switching git branches')
    addItem('judgeBlock', 'running database migrations')

    expect(saveSharedAutoMode).toHaveBeenCalledTimes(2)
    expect(saved[1]).toEqual({
      trustedDomains: ['a.dev'],
      protectedPatterns: ['acme-live-*'],
      judgeAllow: ['creating and switching git branches'],
      judgeBlock: ['running database migrations']
    })
  })

  it('removing the last guidance entry saves the key ABSENT', async () => {
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({
        ...structuredClone(BASE),
        judgeBlock: ['running database migrations']
      }))
    })
    await renderLoaded()

    removeItem('judgeBlock', 'running database migrations')

    expect(JSON.parse(JSON.stringify(saved[0]))).not.toHaveProperty('judgeBlock')
    expect(saved[0]).toEqual({ trustedDomains: ['a.dev'], protectedPatterns: ['acme-live-*'] })
    expect(items('judgeBlock')).toEqual([])
  })
})

describe('TrustListsSection — read-only bypass switch (ADR-084 §1)', () => {
  const toggle = (): HTMLElement => screen.getByTestId('TrustListsSection.readOnlyBypass')

  it('is the first row, ON when the file has no key, with its copy', async () => {
    await renderLoaded()

    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(toggle().textContent).toContain('Skip the judge for read-only commands')
    expect(toggle().textContent).toContain(
      'Plainly read-only commands in your workspace (git status, ls, reading source files) run without a judge call.'
    )
    expect(toggle().textContent).toContain('to review a read yourself, add an Ask rule.')
  })

  it('turning it off saves readOnlyBypass: false alongside the lists', async () => {
    await renderLoaded()

    fireEvent.click(toggle())

    expect(saved).toEqual([
      { trustedDomains: ['a.dev'], protectedPatterns: ['acme-live-*'], readOnlyBypass: false }
    ])
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
  })

  it('turning it back on saves the key ABSENT, never true', async () => {
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({ ...structuredClone(BASE), readOnlyBypass: false }))
    })
    await renderLoaded()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(toggle())

    expect('readOnlyBypass' in saved[0]).toBe(false)
    expect(saved[0]).toEqual({ trustedDomains: ['a.dev'], protectedPatterns: ['acme-live-*'] })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
  })

  it('a list edit keeps the switch off', async () => {
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({ ...structuredClone(BASE), readOnlyBypass: false }))
    })
    await renderLoaded()

    addItem('trustedDomains', 'files.acme.com')

    expect(saved[0].readOnlyBypass).toBe(false)
  })
})

describe('TrustListsSection — the block hold window (ADR-091 part 6)', () => {
  const SELECT = 'TrustListsSection.blockHold.select'
  const choose = (value: string): void => {
    fireEvent.click(screen.getByTestId(`${SELECT}.trigger`))
    const option = screen
      .getAllByTestId(`${SELECT}.option`)
      .find((o) => o.getAttribute('data-id') === value)
    if (!option) throw new Error(`no option ${value}`)
    fireEvent.click(option)
  }

  it('renders with its label and help, reading No hold when the key is absent', async () => {
    await renderLoaded()
    const row = screen.getByTestId('TrustListsSection.blockHold')
    expect(row.textContent).toContain('Hold blocked actions for')
    expect(row.textContent).toContain(
      'No hold: a blocked action is denied at once and the agent carries on; approve it afterwards from the blocked summary.'
    )
    expect(screen.getByTestId(SELECT).getAttribute('data-value')).toBe('0')
    expect(screen.getByTestId(`${SELECT}.trigger`).textContent).toContain('No hold')
    fireEvent.click(screen.getByTestId(`${SELECT}.trigger`))
    expect(
      screen
        .getAllByTestId(`${SELECT}.option`)
        .map((o) => [o.getAttribute('data-id'), o.textContent])
    ).toEqual([
      ['0', 'No hold'],
      ['30', '30 s'],
      ['60', '1 min'],
      ['120', '2 min'],
      ['300', '5 min']
    ])
  })

  it('saves the chosen seconds alongside the lists, and No hold as an absent key', async () => {
    await renderLoaded()
    choose('120')
    expect(saved[0]).toEqual({ ...BASE, blockHoldSeconds: 120 })
    expect(screen.getByTestId(SELECT).getAttribute('data-value')).toBe('120')
    choose('0')
    expect('blockHoldSeconds' in saved[1]).toBe(false)
  })

  it('shows a hand-edited value that is not on the menu', async () => {
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({ ...structuredClone(BASE), blockHoldSeconds: 45 }))
    })
    await renderLoaded()
    expect(screen.getByTestId(`${SELECT}.trigger`).textContent).toContain('45 s')
  })
})

describe('TrustListsSection — guidance entry rules (ADR-083 §4)', () => {
  it('refuses an entry over 300 characters, inline, without saving', async () => {
    await renderLoaded()

    addItem('judgeAllow', 'x'.repeat(301))

    expect(saveSharedAutoMode).not.toHaveBeenCalled()
    expect(items('judgeAllow')).toEqual([])
    expect(screen.getByTestId('TrustListsSection.judgeAllow.error').textContent).toContain(
      '300 characters or fewer'
    )
  })

  it('accepts an entry of exactly 300 characters', async () => {
    await renderLoaded()

    addItem('judgeBlock', 'x'.repeat(300))

    expect(saved[0].judgeBlock).toEqual(['x'.repeat(300)])
    expect(screen.queryByTestId('TrustListsSection.judgeBlock.error')).toBeNull()
  })

  it('refuses a tab inside an entry (an input cannot hold a line break)', async () => {
    await renderLoaded()

    addItem('judgeBlock', 'running\tmigrations')

    expect(saveSharedAutoMode).not.toHaveBeenCalled()
    expect(screen.getByTestId('TrustListsSection.judgeBlock.error').textContent).toContain(
      'no tabs or line breaks'
    )
  })

  it('refuses a 51st entry', async () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `action ${i}`)
    installApiStub({
      loadSharedAutoMode: vi.fn(async () => ({ ...structuredClone(BASE), judgeAllow: fifty }))
    })
    await renderLoaded()

    addItem('judgeAllow', 'one more')

    expect(saveSharedAutoMode).not.toHaveBeenCalled()
    expect(items('judgeAllow')).toHaveLength(50)
    expect(screen.getByTestId('TrustListsSection.judgeAllow.error').textContent).toContain(
      'At most 50 entries'
    )
  })

  it('leaves the trust lists without the guidance caps', async () => {
    await renderLoaded()

    const long = `${'x'.repeat(301)}.example`
    addItem('trustedDomains', long)

    expect(saved[0].trustedDomains).toEqual(['a.dev', long])
    expect(screen.queryByTestId('TrustListsSection.trustedDomains.error')).toBeNull()
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

  it('a rejected save says so and reloads what is on disk', async () => {
    const load = vi.fn(async () => structuredClone(BASE))
    installApiStub({
      loadSharedAutoMode: load,
      saveSharedAutoMode: vi.fn(async () => Promise.reject(new Error('disk full')))
    })
    await renderLoaded()
    expect(screen.queryByTestId('TrustListsSection.saveError')).toBeNull()

    expect(() => addItem('trustedDomains', 'files.acme.com')).not.toThrow()

    // The error is inline, and the list goes back to the file's contents — the
    // entry never reached disk, so showing it would be a lie.
    await waitFor(() =>
      expect(screen.getByTestId('TrustListsSection.saveError').textContent).toContain(
        "Couldn't save"
      )
    )
    await waitFor(() => expect(items('trustedDomains')).toEqual(['a.dev']))
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a later successful save clears the error', async () => {
    const save = vi
      .fn<(cfg: SharedAutoModeConfig) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    installApiStub({ saveSharedAutoMode: save })
    await renderLoaded()

    addItem('trustedDomains', 'files.acme.com')
    await waitFor(() => expect(screen.getByTestId('TrustListsSection.saveError')).toBeTruthy())

    addItem('protectedPatterns', 'k8s://prod-cluster')
    expect(screen.queryByTestId('TrustListsSection.saveError')).toBeNull()
  })

  it('a stale reload never paints over a newer edit', async () => {
    // Save #1 fails; its reload resolves only AFTER save #2 was issued. The
    // reload's (pre-edit) file must not replace the newer edit on screen.
    let resolveReload: (cfg: SharedAutoModeConfig) => void = () => {}
    const load = vi
      .fn<() => Promise<SharedAutoModeConfig>>()
      .mockResolvedValueOnce(structuredClone(BASE))
      .mockImplementationOnce(() => new Promise((r) => (resolveReload = r)))
    const save = vi
      .fn<(cfg: SharedAutoModeConfig) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined)
    installApiStub({ loadSharedAutoMode: load, saveSharedAutoMode: save })
    await renderLoaded()

    addItem('trustedDomains', 'files.acme.com')
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2))
    addItem('protectedPatterns', 'k8s://prod-cluster')

    resolveReload(structuredClone(BASE))
    await new Promise((r) => setTimeout(r, 0))
    expect(items('protectedPatterns')).toEqual(['acme-live-*', 'k8s://prod-cluster'])
  })
})
