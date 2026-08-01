/**
 * Layer 2: Component tests for OpencodeDispatchSection (ADR-033 Slice C).
 *
 * Tested flows:
 *   1. Gated states: loading (probes pending) and not-installed
 *   2. Load renders the current dispatch config (select value + row states)
 *   3. Editing the default model saves the FULL merged EngineConfig —
 *      autoMode / other dispatch fields must not be clobbered
 *   4. "(not set)" clears defaultModel (undefined, not '')
 *   5. Toggling an allowed model on/off; last-off drops the allowedModels key
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

function allowedRow(modelValue: string): HTMLElement {
  const row = screen
    .getAllByTestId('OpencodeDispatchSection.allowedModel')
    .find((el) => el.getAttribute('data-id') === modelValue)
  expect(row, `allowedModel row for ${modelValue}`).toBeTruthy()
  return row!
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

    // One allowed-model row per opencode model, discriminated by data-id.
    const rows = screen.getAllByTestId('OpencodeDispatchSection.allowedModel')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual([
      'openai/gpt-5',
      'google/gemini-3'
    ])
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

    fireEvent.click(allowedRow('google/gemini-3'))

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

    fireEvent.click(allowedRow('openai/gpt-5'))

    expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('openai/gpt-5')
    expect(savedConfigs[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('sequential edits accumulate on local state (second save includes the first edit)', async () => {
    await renderLoaded()

    fireEvent.click(allowedRow('google/gemini-3'))
    pickDefaultModel('google/gemini-3')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'google/gemini-3',
      allowedModels: ['openai/gpt-5', 'google/gemini-3']
    })
  })

  it('setting maxCost saves it alongside the rest, autoMode intact (ADR-033 M4-C)', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByTestId('OpencodeDispatchSection.maxCost'), {
      target: { value: '1' }
    })

    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' },
      dispatch: { defaultModel: 'openai/gpt-5', allowedModels: ['openai/gpt-5'], maxCostUsd: 1 }
    })
  })

  it('clearing maxCost drops the key (undefined = no cap)', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByTestId('OpencodeDispatchSection.maxCost'), {
      target: { value: '1' }
    })
    fireEvent.change(screen.getByTestId('OpencodeDispatchSection.maxCost'), {
      target: { value: '' }
    })

    expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('openai/gpt-5')
  })
})
