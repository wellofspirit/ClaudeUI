/**
 * Layer 2: Component tests for OpencodeDispatchSection (ADR-033 Slice C).
 *
 * ADR-065 split the pane into TWO group bodies over one config read — "Dispatch
 * into" (`OpencodeDispatchSection`) and "Limits"
 * (`OpencodeDispatchSection.limits`) — and moved the allowed models onto a CHIP
 * SET. This file renders the composition, so every row id it asserts is the one
 * that row carried before the split.
 *
 * Tested flows:
 *   1. Gated states: loading (probes pending) and not-installed
 *   2. Load renders the current dispatch config (select value + chip states)
 *   3. Editing the default model saves the FULL merged EngineConfig —
 *      autoMode / other dispatch fields must not be clobbered
 *   4. "(not set)" clears defaultModel (undefined, not '')
 *   5. Toggling an allowed model on/off; last-off drops the allowedModels key
 *   6. The numeric fields commit on BLUR, in minutes, stored as milliseconds
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

import { OpencodeDispatchSection } from '../settings-sections'

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL_GROUPS: EngineModelGroup[] = [
  {
    engineId: 'opencode',
    vendorId: 'openai',
    vendorName: 'OpenAI',
    models: [
      { value: 'openai/gpt-5', displayName: 'GPT-5', description: '', engineId: 'opencode' },
      {
        value: 'google/gemini-3',
        displayName: 'Gemini 3',
        description: '',
        engineId: 'opencode'
      }
    ]
  },
  // A Claude group that must be filtered OUT of the pickers.
  {
    engineId: 'claude',
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    models: [
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: '', engineId: 'claude' }
    ]
  }
]

/** Baseline saved config with a sibling block that must never be clobbered. */
const BASE_CONFIG: EngineConfig = {
  autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
  dispatch: { defaultModel: 'openai/gpt-5', allowedModels: ['openai/gpt-5'] }
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
  render(<OpencodeDispatchSection />)
  await waitFor(() =>
    expect(screen.getByTestId('OpencodeDispatchSection.defaultModel')).toBeTruthy()
  )
}

/**
 * Drive the themed default-model picker (a `ModelPicker`, not a native
 * `<select>` — 8bc26d7's Monokai fix, extended to this section): open the
 * trigger, then click the option carrying `data-value`.
 */
function pickDefaultModel(value: string): void {
  const field = screen.getByTestId('OpencodeDispatchSection.defaultModel')
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const option = within(field)
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  expect(option, `ModelPicker option for "${value}"`).toBeTruthy()
  fireEvent.click(option!)
}

/** The option values the default-model picker currently offers, in order. */
function defaultModelOptionValues(): (string | null)[] {
  const field = screen.getByTestId('OpencodeDispatchSection.defaultModel')
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
    .getAllByTestId('OpencodeDispatchSection.allowedModel')
    .find((el) => el.getAttribute('data-id') === modelValue)
  expect(chip, `allowedModel chip for ${modelValue}`).toBeTruthy()
  return chip!
}

/**
 * `NumberField` commits on blur and on Enter, not on every keystroke, so a
 * half-typed number never reaches the store.
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

describe('OpencodeDispatchSection — gated states', () => {
  it('shows Loading while probes are pending', () => {
    installApiStub({
      engineIsInstalled: vi.fn(() => new Promise(() => {})),
      loadEngineConfig: vi.fn(() => new Promise(() => {}))
    })
    render(<OpencodeDispatchSection />)
    expect(screen.getByTestId('OpencodeDispatchSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('OpencodeDispatchSection.defaultModel')).toBeNull()
  })

  it('shows the not-installed message (no controls) when opencode is absent', async () => {
    installApiStub({ engineIsInstalled: vi.fn(async () => false) })
    render(<OpencodeDispatchSection />)
    await waitFor(() =>
      expect(screen.getByTestId('OpencodeDispatchSection').textContent).toContain('not installed')
    )
    expect(screen.queryByTestId('OpencodeDispatchSection.defaultModel')).toBeNull()
    expect(screen.queryAllByTestId('OpencodeDispatchSection.allowedModel')).toHaveLength(0)
  })
})

describe('OpencodeDispatchSection — load', () => {
  it('renders the saved dispatch config: default model selected, opencode models only', async () => {
    await renderLoaded()

    const field = screen.getByTestId('OpencodeDispatchSection.defaultModel')
    expect(field.getAttribute('data-value')).toBe('openai/gpt-5')
    // The trigger reads the display name, not the raw value.
    expect(field.textContent).toContain('GPT-5')
    // Themed picker, never a native select (the Monokai fix from 8bc26d7).
    expect(field.querySelector('select')).toBeNull()
    expect(within(field).getByTestId('ModelPicker')).toBeTruthy()

    // Only opencode-engine models appear (the Claude group is filtered out),
    // plus the pinned "(not set)" empty option.
    expect(defaultModelOptionValues()).toEqual(['', 'openai/gpt-5', 'google/gemini-3'])

    // One allowed-model CHIP per opencode model, discriminated by data-id.
    const chips = screen.getAllByTestId('OpencodeDispatchSection.allowedModel')
    expect(chips.map((r) => r.getAttribute('data-id'))).toEqual(['openai/gpt-5', 'google/gemini-3'])
  })

  it('renders the allowlist as a chip set whose pressed chips ARE the saved list', async () => {
    await renderLoaded()

    expect(screen.getByTestId('OpencodeDispatchSection.allowedModels')).toBeTruthy()
    expect(allowedChip('openai/gpt-5').getAttribute('aria-pressed')).toBe('true')
    expect(allowedChip('google/gemini-3').getAttribute('aria-pressed')).toBe('false')
  })

  it('splits into two roots over one config read, with the row ids unmoved', async () => {
    await renderLoaded()

    expect(screen.getByTestId('OpencodeDispatchSection')).toBeTruthy()
    expect(screen.getByTestId('OpencodeDispatchSection.limits')).toBeTruthy()
    // Every limit row still answers to its pre-split id.
    expect(screen.getByTestId('OpencodeDispatchSection.maxCost')).toBeTruthy()
    expect(screen.getByTestId('OpencodeDispatchSection.turnTimeout')).toBeTruthy()
    expect(screen.getByTestId('OpencodeDispatchSection.idleTimeout')).toBeTruthy()
  })
})

describe('OpencodeDispatchSection — saves merge, never clobber', () => {
  it('changing the default model saves the FULL config with autoMode and allowedModels intact', async () => {
    await renderLoaded()

    pickDefaultModel('google/gemini-3')

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(saveEngineConfig.mock.calls[0][0]).toBe('opencode')
    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
      dispatch: { defaultModel: 'google/gemini-3', allowedModels: ['openai/gpt-5'] }
    })
  })

  it('"(not set)" clears defaultModel without touching the rest', async () => {
    await renderLoaded()

    pickDefaultModel('')

    expect(savedConfigs[0].dispatch?.defaultModel).toBeUndefined()
    expect(savedConfigs[0].dispatch?.allowedModels).toEqual(['openai/gpt-5'])
    expect(savedConfigs[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('toggling a model ON appends it to allowedModels (autoMode intact)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('google/gemini-3'))

    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
      dispatch: {
        defaultModel: 'openai/gpt-5',
        allowedModels: ['openai/gpt-5', 'google/gemini-3']
      }
    })
  })

  it('toggling the LAST model OFF drops the allowedModels key (empty = all allowed)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('openai/gpt-5'))

    expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('openai/gpt-5')
    expect(savedConfigs[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('sequential edits accumulate on local state (second save includes the first edit)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('google/gemini-3'))
    pickDefaultModel('google/gemini-3')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'google/gemini-3',
      allowedModels: ['openai/gpt-5', 'google/gemini-3']
    })
  })

  it('setting maxCost saves it alongside the rest, autoMode intact (ADR-033 M4-C)', async () => {
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.maxCost', '1')

    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
      dispatch: { defaultModel: 'openai/gpt-5', allowedModels: ['openai/gpt-5'], maxCostUsd: 1 }
    })
  })

  it('clearing maxCost drops the key (undefined = no cap)', async () => {
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.maxCost', '1')
    commitNumber('OpencodeDispatchSection.maxCost', '')

    expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('openai/gpt-5')
  })

  it('shows the cost cap in USD, with "no cap" as what EMPTY means', async () => {
    await renderLoaded()

    const input = screen.getByTestId('OpencodeDispatchSection.maxCost') as HTMLInputElement
    expect(input.placeholder).toBe('no cap')
    expect(screen.getByTestId('OpencodeDispatchSection.maxCostRow').textContent).toContain('USD')
  })
})

/**
 * The turn/inactivity watchdog knobs (ADR-033's 2026-09-01 amendment). Edited
 * in MINUTES, stored in MILLISECONDS; blank = the built-in default, 0 =
 * disabled. Opencode-only — the Claude direction still runs on the fixed
 * 10-minute cap, so its section must not offer them (asserted in
 * ClaudeDispatchSection.component.test.tsx).
 */
describe('OpencodeDispatchSection — dispatch turn timeouts', () => {
  it('renders stored millisecond values as minutes', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({
        dispatch: { defaultModel: 'openai/gpt-5', turnTimeoutMs: 5_400_000, idleTimeoutMs: 300_000 }
      }))
    })
    await renderLoaded()

    expect(
      (screen.getByTestId('OpencodeDispatchSection.turnTimeout') as HTMLInputElement).value
    ).toBe('90')
    expect(
      (screen.getByTestId('OpencodeDispatchSection.idleTimeout') as HTMLInputElement).value
    ).toBe('5')
  })

  it('an unset timeout renders blank, with the default in the placeholder', async () => {
    await renderLoaded()
    const turn = screen.getByTestId('OpencodeDispatchSection.turnTimeout') as HTMLInputElement
    const idle = screen.getByTestId('OpencodeDispatchSection.idleTimeout') as HTMLInputElement
    expect(turn.value).toBe('')
    expect(idle.value).toBe('')
    // The placeholder is what an EMPTY field means (ADR-065's number-with-unit).
    expect(turn.placeholder).toBe('60')
    expect(idle.placeholder).toBe('15')
    expect(screen.getByTestId('OpencodeDispatchSection.turnTimeoutRow').textContent).toContain(
      'min'
    )
  })

  it('saves minutes as milliseconds, merging into the rest of the config', async () => {
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.turnTimeout', '90')
    commitNumber('OpencodeDispatchSection.idleTimeout', '5')

    expect(savedConfigs[1]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
      dispatch: {
        defaultModel: 'openai/gpt-5',
        allowedModels: ['openai/gpt-5'],
        turnTimeoutMs: 5_400_000,
        idleTimeoutMs: 300_000
      }
    })
  })

  it('a negative value drops the key rather than persisting a negative duration', async () => {
    // `type="number"` still hands us "-5" (and mid-edit garbage like "-" or
    // "e"); the watchdog's `> 0` gates would read a persisted negative as
    // "cap disabled" — a silent surprise, not a usable duration.
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.turnTimeout', '-5')

    expect(savedConfigs[0].dispatch?.turnTimeoutMs).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('openai/gpt-5')
  })

  it('0 minutes saves 0 (disabled), and clearing drops the key (back to the default)', async () => {
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.idleTimeout', '0')
    expect(savedConfigs[0].dispatch?.idleTimeoutMs).toBe(0)

    commitNumber('OpencodeDispatchSection.idleTimeout', '')
    expect(savedConfigs[1].dispatch?.idleTimeoutMs).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('openai/gpt-5')
  })
})

/**
 * The shared-config pin, opencode side — where it matters most, because this is
 * the only direction whose Limits card carries three fields.
 */
describe('OpencodeDispatchSection — the two halves share one config', () => {
  it('reads the engine config ONCE for the whole composition', async () => {
    await renderLoaded()
    expect(window.api.loadEngineConfig).toHaveBeenCalledTimes(1)
    expect(window.api.loadEngineConfig).toHaveBeenCalledWith('opencode')
  })

  it('a Limits edit after an into edit keeps the new default model', async () => {
    await renderLoaded()

    pickDefaultModel('google/gemini-3')
    commitNumber('OpencodeDispatchSection.maxCost', '2')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'google/gemini-3',
      allowedModels: ['openai/gpt-5'],
      maxCostUsd: 2
    })
    expect(savedConfigs[1].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('an into edit after a Limits edit keeps the timeouts', async () => {
    await renderLoaded()

    commitNumber('OpencodeDispatchSection.turnTimeout', '90')
    commitNumber('OpencodeDispatchSection.idleTimeout', '5')
    fireEvent.click(allowedChip('google/gemini-3'))

    expect(savedConfigs).toHaveLength(3)
    expect(savedConfigs[2].dispatch).toEqual({
      defaultModel: 'openai/gpt-5',
      allowedModels: ['openai/gpt-5', 'google/gemini-3'],
      turnTimeoutMs: 5_400_000,
      idleTimeoutMs: 300_000
    })
  })
})
