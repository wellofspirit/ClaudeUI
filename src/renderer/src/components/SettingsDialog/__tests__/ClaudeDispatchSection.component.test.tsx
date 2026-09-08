/**
 * Layer 2: Component tests for ClaudeDispatchSection (ADR-033 M2-C — Claude-side twin).
 *
 * Mirrors OpencodeDispatchSection.component.test.tsx. Claude itself is always
 * installed, but dispatch INTO Claude can only be called FROM opencode, so
 * (ADR-033 M4-A) this section gates on the same opencode-installed probe as
 * the opencode twin — hence the gated-states tests below, unlike the earlier
 * M2-C revision of this file.
 *
 * ADR-065 split the pane into TWO group bodies over one config read — "Dispatch
 * into" (`ClaudeDispatchSection`) and "Limits" (`ClaudeDispatchSection.limits`)
 * — and put the allowed models on a CHIP SET rather than a list of toggle rows.
 * This file renders the composition, so it still drives one thing, and every row
 * id it asserts is the id that row carried before the split.
 *
 * Tested flows:
 *   1. Gated states: loading (probes pending) and not-installed (no opencode)
 *   2. Load renders the current dispatch config (select value + chip states),
 *      filtered to Claude models only (opencode models excluded)
 *   3. Editing the default model saves the FULL merged EngineConfig —
 *      sandbox / proxy / other fields must not be clobbered
 *   4. "(not set)" clears defaultModel (undefined, not '')
 *   5. Toggling an allowed model on/off; last-off drops the allowedModels key
 *   6. maxCost round-trips through the merged save (ADR-033 M4-C) and commits on
 *      BLUR, so a half-typed number never reaches the file
 *   7. A long model list collapses behind "Show all N"
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

import { ClaudeDispatchSection } from '../settings-sections'

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL_GROUPS: EngineModelGroup[] = [
  {
    engineId: 'claude',
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    models: [
      { value: 'sonnet', displayName: 'Sonnet', description: '', engineId: 'claude' },
      { value: 'haiku', displayName: 'Haiku', description: '', engineId: 'claude' }
    ]
  },
  // An opencode group that must be filtered OUT of the pickers.
  {
    engineId: 'opencode',
    vendorId: 'openai',
    vendorName: 'OpenAI',
    models: [{ value: 'openai/gpt-5', displayName: 'GPT-5', description: '', engineId: 'opencode' }]
  }
]

/** Baseline saved config with sibling blocks that must never be clobbered. */
const BASE_CONFIG: EngineConfig = {
  sandbox: { mode: 'workspace-write' } as never,
  proxy: { enabled: true } as never,
  dispatch: { defaultModel: 'sonnet', allowedModels: ['sonnet'] }
}

// ── window.api stub ──────────────────────────────────────────────────

let savedConfigs: EngineConfig[] = []
const saveEngineConfig = vi.fn(async (_engineId: string, cfg: EngineConfig) => {
  savedConfigs.push(structuredClone(cfg))
})

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    loadEngineConfig: vi.fn(async () => structuredClone(BASE_CONFIG)),
    getEngineModels: vi.fn(async () => MODEL_GROUPS),
    saveEngineConfig,
    ...overrides
  }
}

async function renderLoaded(): Promise<void> {
  render(<ClaudeDispatchSection />)
  await waitFor(() => expect(screen.getByTestId('ClaudeDispatchSection.defaultModel')).toBeTruthy())
}

/**
 * Drive the themed default-model picker (a `ModelPicker`, not a native
 * `<select>` — 8bc26d7's Monokai fix, extended to this section): open the
 * trigger, then click the option carrying `data-value`.
 */
function pickDefaultModel(value: string): void {
  const field = screen.getByTestId('ClaudeDispatchSection.defaultModel')
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const option = within(field)
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  expect(option, `ModelPicker option for "${value}"`).toBeTruthy()
  fireEvent.click(option!)
}

/** The option values the default-model picker currently offers, in order. */
function defaultModelOptionValues(): (string | null)[] {
  const field = screen.getByTestId('ClaudeDispatchSection.defaultModel')
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const values = within(field)
    .getAllByTestId('ModelPicker.option')
    .map((o) => o.getAttribute('data-value'))
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  return values
}

/** One allowed-models CHIP. The id is the one the toggle rows carried. */
function allowedChip(modelValue: string): HTMLElement {
  const chip = screen
    .getAllByTestId('ClaudeDispatchSection.allowedModel')
    .find((el) => el.getAttribute('data-id') === modelValue)
  expect(chip, `allowedModel chip for ${modelValue}`).toBeTruthy()
  return chip!
}

/**
 * `NumberField` commits on blur and on Enter, not on every keystroke, so a
 * half-typed number never reaches the store. Every numeric edit below goes
 * through this rather than a bare `fireEvent.change`.
 */
function commitNumber(testid: string, value: string): void {
  const input = screen.getByTestId(testid)
  fireEvent.change(input, { target: { value } })
  fireEvent.blur(input)
}

beforeEach(() => {
  savedConfigs = []
  vi.clearAllMocks()
  installApiStub()
})

afterEach(() => {
  cleanup()
})

// ── Tests ────────────────────────────────────────────────────────────

describe('ClaudeDispatchSection — gated states', () => {
  it('shows Loading while probes are pending', () => {
    installApiStub({
      engineIsInstalled: vi.fn(() => new Promise(() => {})),
      loadEngineConfig: vi.fn(() => new Promise(() => {}))
    })
    render(<ClaudeDispatchSection />)
    expect(screen.getByTestId('ClaudeDispatchSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('ClaudeDispatchSection.defaultModel')).toBeNull()
  })

  it('shows the not-installed message (no controls) when opencode is absent — no possible caller', async () => {
    installApiStub({ engineIsInstalled: vi.fn(async () => false) })
    render(<ClaudeDispatchSection />)
    await waitFor(() =>
      expect(screen.getByTestId('ClaudeDispatchSection').textContent).toContain('not installed')
    )
    expect(screen.queryByTestId('ClaudeDispatchSection.defaultModel')).toBeNull()
    expect(screen.queryAllByTestId('ClaudeDispatchSection.allowedModel')).toHaveLength(0)
  })
})

describe('ClaudeDispatchSection — load', () => {
  it('renders the saved dispatch config: default model selected, Claude models only', async () => {
    await renderLoaded()

    const field = screen.getByTestId('ClaudeDispatchSection.defaultModel')
    expect(field.getAttribute('data-value')).toBe('sonnet')
    // The trigger reads the display name, not the raw value.
    expect(field.textContent).toContain('Sonnet')
    // Themed picker, never a native select (the Monokai fix from 8bc26d7).
    expect(field.querySelector('select')).toBeNull()
    expect(within(field).getByTestId('ModelPicker')).toBeTruthy()

    // Only Claude-engine models appear (the opencode group is filtered out),
    // plus the pinned "(not set)" empty option.
    expect(defaultModelOptionValues()).toEqual(['', 'sonnet', 'haiku'])

    // One allowed-model CHIP per Claude model, discriminated by data-id.
    const chips = screen.getAllByTestId('ClaudeDispatchSection.allowedModel')
    expect(chips.map((r) => r.getAttribute('data-id'))).toEqual(['sonnet', 'haiku'])
  })

  it('renders the allowlist as a chip set whose pressed chips ARE the saved list', async () => {
    await renderLoaded()

    // ADR-065: a chip set, not the 13-row toggle list the audit called out.
    expect(screen.getByTestId('ClaudeDispatchSection.allowedModels')).toBeTruthy()
    expect(allowedChip('sonnet').getAttribute('aria-pressed')).toBe('true')
    expect(allowedChip('haiku').getAttribute('aria-pressed')).toBe('false')
  })

  it('splits into two roots over one config read, with the row ids unmoved', async () => {
    await renderLoaded()

    // "Dispatch into" keeps the pre-split root; "Limits" is its own.
    expect(screen.getByTestId('ClaudeDispatchSection')).toBeTruthy()
    expect(screen.getByTestId('ClaudeDispatchSection.limits')).toBeTruthy()
    expect(screen.getByTestId('ClaudeDispatchSection.maxCost')).toBeTruthy()
  })
})

describe('ClaudeDispatchSection — saves merge, never clobber', () => {
  it('changing the default model saves the FULL config with sandbox/proxy and allowedModels intact', async () => {
    await renderLoaded()

    pickDefaultModel('haiku')

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(saveEngineConfig.mock.calls[0][0]).toBe('claude')
    expect(savedConfigs[0]).toEqual({
      sandbox: { mode: 'workspace-write' },
      proxy: { enabled: true },
      dispatch: { defaultModel: 'haiku', allowedModels: ['sonnet'] }
    })
  })

  it('"(not set)" clears defaultModel without touching the rest', async () => {
    await renderLoaded()

    pickDefaultModel('')

    expect(savedConfigs[0].dispatch?.defaultModel).toBeUndefined()
    expect(savedConfigs[0].dispatch?.allowedModels).toEqual(['sonnet'])
    expect(savedConfigs[0].sandbox).toEqual(BASE_CONFIG.sandbox)
    expect(savedConfigs[0].proxy).toEqual(BASE_CONFIG.proxy)
  })

  it('toggling a model ON appends it to allowedModels (sandbox/proxy intact)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('haiku'))

    expect(savedConfigs[0]).toEqual({
      sandbox: { mode: 'workspace-write' },
      proxy: { enabled: true },
      dispatch: { defaultModel: 'sonnet', allowedModels: ['sonnet', 'haiku'] }
    })
  })

  it('toggling the LAST model OFF drops the allowedModels key (empty = all allowed)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('sonnet'))

    expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('sonnet')
    expect(savedConfigs[0].sandbox).toEqual(BASE_CONFIG.sandbox)
    expect(savedConfigs[0].proxy).toEqual(BASE_CONFIG.proxy)
  })

  it('sequential edits accumulate on local state (second save includes the first edit)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('haiku'))
    pickDefaultModel('haiku')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'haiku',
      allowedModels: ['sonnet', 'haiku']
    })
  })

  it('setting maxCost saves it alongside the rest, sandbox/proxy intact (ADR-033 M4-C)', async () => {
    await renderLoaded()

    commitNumber('ClaudeDispatchSection.maxCost', '2.5')

    expect(savedConfigs[0]).toEqual({
      sandbox: { mode: 'workspace-write' },
      proxy: { enabled: true },
      dispatch: { defaultModel: 'sonnet', allowedModels: ['sonnet'], maxCostUsd: 2.5 }
    })
  })

  it('clearing maxCost drops the key (undefined = no cap)', async () => {
    await renderLoaded()

    commitNumber('ClaudeDispatchSection.maxCost', '2.5')
    commitNumber('ClaudeDispatchSection.maxCost', '')

    expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('sonnet')
  })

  it('a half-typed maxCost never reaches the file — the field commits on blur', async () => {
    await renderLoaded()

    // "2." is exactly what a commit-on-change input hands the store mid-edit.
    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.maxCost'), {
      target: { value: '2.' }
    })
    expect(saveEngineConfig).not.toHaveBeenCalled()

    fireEvent.blur(screen.getByTestId('ClaudeDispatchSection.maxCost'))
    expect(savedConfigs[0].dispatch?.maxCostUsd).toBe(2)
  })

  it('shows the cost cap in USD, with "no cap" as what EMPTY means', async () => {
    await renderLoaded()

    const input = screen.getByTestId('ClaudeDispatchSection.maxCost') as HTMLInputElement
    expect(input.placeholder).toBe('no cap')
    expect(screen.getByTestId('ClaudeDispatchSection.maxCostRow').textContent).toContain('USD')
  })

  it('does NOT offer the turn/inactivity timeouts — they govern the opencode direction only', async () => {
    // The Claude direction still runs on the fixed 10-minute DISPATCH_TIMEOUT_MS
    // (ADR-033's 2026-09-01 amendment); rendering the editors here would write
    // config nothing reads.
    await renderLoaded()
    expect(screen.queryByTestId('ClaudeDispatchSection.turnTimeout')).toBeNull()
    expect(screen.queryByTestId('ClaudeDispatchSection.idleTimeout')).toBeNull()
  })
})

/**
 * A dispatch target can offer far more models than a card should show — the
 * board has opencode at 13 — so the chip set previews the first eight and puts
 * the rest behind one link.
 */
describe('ClaudeDispatchSection — long model lists', () => {
  const MANY = Array.from({ length: 11 }, (_, i) => ({
    value: `m${i}`,
    displayName: `Model ${i}`,
    description: '',
    engineId: 'claude' as const
  }))

  it('previews eight chips and reveals the rest on "Show all N"', async () => {
    installApiStub({
      getEngineModels: vi.fn(async () => [
        { engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: MANY }
      ]),
      loadEngineConfig: vi.fn(async () => ({ dispatch: {} }))
    })
    await renderLoaded()

    expect(screen.getAllByTestId('ClaudeDispatchSection.allowedModel')).toHaveLength(8)
    const showAll = screen.getByTestId('ClaudeDispatchSection.showAllModels')
    expect(showAll.textContent).toContain('11')

    fireEvent.click(showAll)

    expect(screen.getAllByTestId('ClaudeDispatchSection.allowedModel')).toHaveLength(11)
    expect(screen.queryByTestId('ClaudeDispatchSection.showAllModels')).toBeNull()
  })

  it('does not collapse a list that already fits', async () => {
    await renderLoaded()
    expect(screen.queryByTestId('ClaudeDispatchSection.showAllModels')).toBeNull()
  })
})

/**
 * The two halves edit ONE engine config file, and `saveEngineConfig` REPLACES
 * it — unlike the Remote panes' `setRemoteConfig`, which takes a partial that
 * main merges. So the halves must share one config object, or the second edit
 * is computed against a pre-first-edit copy and silently reverts it on disk.
 *
 * These are the regression pins for that: both halves are on screen together on
 * the real page, so an edit in one must be visible to the other before it saves.
 */
describe('ClaudeDispatchSection — the two halves share one config', () => {
  it('reads the engine config ONCE for the whole composition', async () => {
    await renderLoaded()
    expect(window.api.loadEngineConfig).toHaveBeenCalledTimes(1)
    expect(window.api.loadEngineConfig).toHaveBeenCalledWith('claude')
  })

  it('a Limits edit after an into edit keeps the new default model', async () => {
    await renderLoaded()

    pickDefaultModel('haiku')
    commitNumber('ClaudeDispatchSection.maxCost', '4')

    expect(savedConfigs).toHaveLength(2)
    // Without a shared config the limits half would still hold the pre-edit
    // copy and write `defaultModel: 'sonnet'` straight back over the choice.
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'haiku',
      allowedModels: ['sonnet'],
      maxCostUsd: 4
    })
    expect(savedConfigs[1].sandbox).toEqual(BASE_CONFIG.sandbox)
  })

  it('an into edit after a Limits edit keeps the cost cap', async () => {
    await renderLoaded()

    commitNumber('ClaudeDispatchSection.maxCost', '4')
    pickDefaultModel('haiku')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'haiku',
      allowedModels: ['sonnet'],
      maxCostUsd: 4
    })
  })

  it('a chip toggle and a cost cap accumulate in either order', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('haiku'))
    commitNumber('ClaudeDispatchSection.maxCost', '9')

    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'sonnet',
      allowedModels: ['sonnet', 'haiku'],
      maxCostUsd: 9
    })
  })

  it('re-reads the file on a fresh mount (the store is dropped with the pane)', async () => {
    await renderLoaded()
    commitNumber('ClaudeDispatchSection.maxCost', '4')
    cleanup()

    await renderLoaded()
    // A second mount is a second read — the shared entry is reference-counted,
    // not a process-lifetime cache, so a hand-edited file is picked up.
    expect(window.api.loadEngineConfig).toHaveBeenCalledTimes(2)
    expect((screen.getByTestId('ClaudeDispatchSection.maxCost') as HTMLInputElement).value).toBe('')
  })
})
