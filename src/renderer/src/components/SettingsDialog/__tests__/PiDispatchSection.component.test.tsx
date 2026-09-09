/**
 * Layer 2: Component tests for PiDispatchSection (ADR-065 § Cross-engine
 * dispatch into pi).
 *
 * pi has been an accepted dispatch TARGET since M4c — `resolveAndRunPi` in
 * `cross-engine-dispatcher.ts` reads `engines/pi.json#dispatch` and its refusal
 * text already points the user at this pane — but the settings UI never had one,
 * so `defaultModel` / `allowedModels` / `maxCostUsd` were live and unreachable.
 *
 * The opencode twin, minus the timeouts: the turn/inactivity watchdog belongs to
 * the opencode target path (ADR-033's 2026-09-01 amendment), so rendering it
 * here would write config nothing reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

import { PiDispatchSection } from '../settings-sections'

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL_GROUPS: EngineModelGroup[] = [
  {
    engineId: 'pi',
    vendorId: 'openai-codex',
    vendorName: 'ChatGPT',
    models: [
      { value: 'openai-codex/gpt-5.4', displayName: 'GPT-5.4', description: '', engineId: 'pi' },
      {
        value: 'openai-codex/gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        description: '',
        engineId: 'pi'
      }
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

/** Baseline saved config with a sibling block that must never be clobbered. */
const BASE_CONFIG: EngineConfig = {
  autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.4-mini' },
  dispatch: { defaultModel: 'openai-codex/gpt-5.4', allowedModels: ['openai-codex/gpt-5.4'] }
}

// ── window.api stub ──────────────────────────────────────────────────

let savedConfigs: EngineConfig[] = []
const saveEngineConfig = vi.fn(async (_engineId: string, cfg: EngineConfig) => {
  savedConfigs.push(structuredClone(cfg))
})
const engineIsInstalled = vi.fn(async () => true)

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled,
    loadEngineConfig: vi.fn(async () => structuredClone(BASE_CONFIG)),
    getEngineModels: vi.fn(async () => MODEL_GROUPS),
    saveEngineConfig,
    ...overrides
  }
}

async function renderLoaded(): Promise<void> {
  render(<PiDispatchSection />)
  await waitFor(() => expect(screen.getByTestId('PiDispatchSection.defaultModel')).toBeTruthy())
}

function pickDefaultModel(value: string): void {
  const field = screen.getByTestId('PiDispatchSection.defaultModel')
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const option = within(field)
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  expect(option, `ModelPicker option for "${value}"`).toBeTruthy()
  fireEvent.click(option!)
}

function defaultModelOptionValues(): (string | null)[] {
  const field = screen.getByTestId('PiDispatchSection.defaultModel')
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const values = within(field)
    .getAllByTestId('ModelPicker.option')
    .map((o) => o.getAttribute('data-value'))
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  return values
}

function allowedChip(modelValue: string): HTMLElement {
  const chip = screen
    .getAllByTestId('PiDispatchSection.allowedModel')
    .find((el) => el.getAttribute('data-id') === modelValue)
  expect(chip, `allowedModel chip for ${modelValue}`).toBeTruthy()
  return chip!
}

/** `NumberField` commits on blur, never per keystroke. */
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

describe('PiDispatchSection — gated states', () => {
  it('shows Loading while probes are pending', () => {
    installApiStub({
      engineIsInstalled: vi.fn(() => new Promise(() => {})),
      loadEngineConfig: vi.fn(() => new Promise(() => {}))
    })
    render(<PiDispatchSection />)
    expect(screen.getByTestId('PiDispatchSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('PiDispatchSection.defaultModel')).toBeNull()
  })

  it('gates on PI being installed, not on opencode', async () => {
    installApiStub({ engineIsInstalled: vi.fn(async (id: string) => id !== 'pi') })
    render(<PiDispatchSection />)
    await waitFor(() =>
      expect(screen.getByTestId('PiDispatchSection').textContent).toContain('not installed')
    )
    expect(screen.queryByTestId('PiDispatchSection.defaultModel')).toBeNull()
    expect(screen.queryAllByTestId('PiDispatchSection.allowedModel')).toHaveLength(0)
  })
})

describe('PiDispatchSection — load', () => {
  it('renders the saved dispatch config: default model selected, pi models only', async () => {
    await renderLoaded()

    const field = screen.getByTestId('PiDispatchSection.defaultModel')
    expect(field.getAttribute('data-value')).toBe('openai-codex/gpt-5.4')
    expect(field.textContent).toContain('GPT-5.4')
    expect(within(field).getByTestId('ModelPicker')).toBeTruthy()

    // Only pi-engine models appear, plus the pinned "(not set)" empty option.
    expect(defaultModelOptionValues()).toEqual([
      '',
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.4-mini'
    ])

    const chips = screen.getAllByTestId('PiDispatchSection.allowedModel')
    expect(chips.map((c) => c.getAttribute('data-id'))).toEqual([
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.4-mini'
    ])
    expect(allowedChip('openai-codex/gpt-5.4').getAttribute('aria-pressed')).toBe('true')
    expect(allowedChip('openai-codex/gpt-5.4-mini').getAttribute('aria-pressed')).toBe('false')
  })

  it('has both halves, and reads/writes the PI engine config', async () => {
    await renderLoaded()

    expect(screen.getByTestId('PiDispatchSection')).toBeTruthy()
    expect(screen.getByTestId('PiDispatchSection.limits')).toBeTruthy()
    expect(window.api.loadEngineConfig).toHaveBeenCalledWith('pi')
  })
})

describe('PiDispatchSection — saves merge, never clobber', () => {
  it('changing the default model saves the FULL config with autoMode intact', async () => {
    await renderLoaded()

    pickDefaultModel('openai-codex/gpt-5.4-mini')

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(saveEngineConfig.mock.calls[0][0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.4-mini' },
      dispatch: {
        defaultModel: 'openai-codex/gpt-5.4-mini',
        allowedModels: ['openai-codex/gpt-5.4']
      }
    })
  })

  it('"(not set)" clears defaultModel without touching the rest', async () => {
    await renderLoaded()

    pickDefaultModel('')

    expect(savedConfigs[0].dispatch?.defaultModel).toBeUndefined()
    expect(savedConfigs[0].dispatch?.allowedModels).toEqual(['openai-codex/gpt-5.4'])
    expect(savedConfigs[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('toggling a chip ON appends it to allowedModels (autoMode intact)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('openai-codex/gpt-5.4-mini'))

    expect(savedConfigs[0].dispatch?.allowedModels).toEqual([
      'openai-codex/gpt-5.4',
      'openai-codex/gpt-5.4-mini'
    ])
    expect(savedConfigs[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('toggling the LAST chip OFF drops the allowedModels key (empty = all allowed)', async () => {
    await renderLoaded()

    fireEvent.click(allowedChip('openai-codex/gpt-5.4'))

    expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('openai-codex/gpt-5.4')
  })

  it('setting maxCost saves it alongside the rest (ADR-033 M4-C)', async () => {
    await renderLoaded()

    commitNumber('PiDispatchSection.maxCost', '3')

    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.4-mini' },
      dispatch: {
        defaultModel: 'openai-codex/gpt-5.4',
        allowedModels: ['openai-codex/gpt-5.4'],
        maxCostUsd: 3
      }
    })
  })

  it('clearing maxCost drops the key (undefined = no cap)', async () => {
    await renderLoaded()

    commitNumber('PiDispatchSection.maxCost', '3')
    commitNumber('PiDispatchSection.maxCost', '')

    expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('openai-codex/gpt-5.4')
  })

  it('does NOT offer the turn/inactivity timeouts — the watchdog is opencode-only', async () => {
    await renderLoaded()
    expect(screen.queryByTestId('PiDispatchSection.turnTimeout')).toBeNull()
    expect(screen.queryByTestId('PiDispatchSection.idleTimeout')).toBeNull()
  })
})
