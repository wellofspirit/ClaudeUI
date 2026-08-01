/**
 * Layer 2: Component tests for the pi auto-mode settings section, plus the
 * shared `AutoModeSection` core it now has in common with opencode.
 *
 * PiSession has read `loadEngineConfig('pi').autoMode` since the phase-4
 * gatekeeper wiring; this section is the first UI that can write it. Tested
 * flows:
 *   1. Gated states: loading (probes pending) and pi-not-installed
 *   2. Load renders the saved autoMode block; judge options are pi models ONLY
 *   3. The judge picker is the themed ModelPicker, NOT a native <select>
 *      (native <option> lists are OS-painted — unreadable under Monokai)
 *   4. Saves merge: `piConfig` and other autoMode keys are never clobbered
 *   5. Picking the pinned default row clears judgeModel (undefined, not '')
 *   6. A configured-but-undiscovered judgeModel is shown verbatim, not
 *      collapsed to the "default" label
 *   7. The opencode twin renders from the same core with its own testids
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'

import { SECTIONS, PiAutoModeSection } from '../settings-sections'

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL_GROUPS: EngineModelGroup[] = [
  {
    engineId: 'pi',
    vendorId: 'openai-codex',
    vendorName: 'OpenAI',
    models: [
      {
        value: 'openai-codex/gpt-5.6-luna',
        displayName: 'GPT-5.6 Luna',
        description: '',
        engineId: 'pi',
        vendorId: 'openai-codex'
      },
      {
        value: 'openai-codex/gpt-5.6-mini',
        displayName: 'GPT-5.6 Mini',
        description: '',
        engineId: 'pi',
        vendorId: 'openai-codex'
      }
    ]
  },
  // Other engines' groups must be filtered OUT of pi's judge picker.
  {
    engineId: 'opencode',
    vendorId: 'openai',
    vendorName: 'OpenAI',
    models: [
      {
        value: 'openai/gpt-5',
        displayName: 'GPT-5',
        description: '',
        engineId: 'opencode',
        vendorId: 'openai'
      }
    ]
  }
]

/** Baseline saved config with a sibling block that must never be clobbered. */
const BASE_CONFIG: EngineConfig = {
  autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.6-mini', trustedDomains: ['a.dev'] },
  piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
}

// ── window.api stub ──────────────────────────────────────────────────

let savedConfigs: EngineConfig[] = []
let savedEngineIds: string[] = []
const saveEngineConfig = vi.fn(async (engineId: string, cfg: EngineConfig) => {
  savedEngineIds.push(engineId)
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
  render(<PiAutoModeSection />)
  await waitFor(() => expect(screen.getByTestId('PiAutoModeSection.judgeModel')).toBeTruthy())
}

function openJudgePicker(): void {
  fireEvent.click(
    within(screen.getByTestId('PiAutoModeSection.judgeModel')).getByTestId('ModelPicker.trigger')
  )
}

function judgeOption(value: string): HTMLElement {
  const match = screen
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  if (!match) throw new Error(`No ModelPicker.option with data-value="${value}"`)
  return match
}

beforeEach(() => {
  savedConfigs = []
  savedEngineIds = []
  vi.clearAllMocks()
  installApiStub()
})

afterEach(() => {
  cleanup()
})

// ── Tests ────────────────────────────────────────────────────────────

describe('PiAutoModeSection — registration', () => {
  it('is registered as the pi-automode section', () => {
    const section = SECTIONS.find((s) => s.id === 'pi-automode')
    expect(section).toBeDefined()
    expect(section!.items.map((i) => i.key)).toEqual(['piAutoMode'])
  })
})

describe('PiAutoModeSection — gated states', () => {
  it('shows Loading while probes are pending', () => {
    installApiStub({
      engineIsInstalled: vi.fn(() => new Promise(() => {})),
      loadEngineConfig: vi.fn(() => new Promise(() => {}))
    })
    render(<PiAutoModeSection />)
    expect(screen.getByTestId('PiAutoModeSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('PiAutoModeSection.enabled')).toBeNull()
  })

  it('shows the not-installed message (no controls) when pi is absent', async () => {
    installApiStub({ engineIsInstalled: vi.fn(async () => false) })
    render(<PiAutoModeSection />)
    await waitFor(() =>
      expect(screen.getByTestId('PiAutoModeSection').textContent).toContain('not installed')
    )
    expect(screen.queryByTestId('PiAutoModeSection.enabled')).toBeNull()
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel')).toBeNull()
    expect(screen.queryByTestId('PiAutoModeSection.twoStageMode')).toBeNull()
  })
})

describe('PiAutoModeSection — load', () => {
  it('renders the saved autoMode block with pi models only', async () => {
    await renderLoaded()

    expect(screen.getByTestId('PiAutoModeSection.judgeModel').getAttribute('data-value')).toBe(
      'openai-codex/gpt-5.6-mini'
    )
    openJudgePicker()

    // Pinned "inherit" row + pi models; the opencode group is filtered out.
    expect(screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))).toEqual([
      '',
      'openai-codex/gpt-5.6-luna',
      'openai-codex/gpt-5.6-mini'
    ])
  })

  it('uses the themed ModelPicker, never a native <select>, for the judge model', async () => {
    await renderLoaded()
    const field = screen.getByTestId('PiAutoModeSection.judgeModel')
    expect(field.querySelector('select')).toBeNull()
    expect(within(field).getByTestId('ModelPicker')).toBeTruthy()

    // Options are real DOM buttons carrying theme-token classes, so they are
    // legible under every theme (the Monokai regression that motivated this).
    openJudgePicker()
    const option = judgeOption('openai-codex/gpt-5.6-luna')
    expect(option.tagName).toBe('BUTTON')
    expect(option.className).toContain('text-text-secondary')
  })

  it('defaults an absent autoMode block to enabled + inherit + both', async () => {
    installApiStub({ loadEngineConfig: vi.fn(async () => ({}) as EngineConfig) })
    await renderLoaded()

    expect(screen.getByTestId('PiAutoModeSection.judgeModel').getAttribute('data-value')).toBe('')
    expect(screen.getByTestId('PiAutoModeSection.judgeModel').textContent).toContain(
      'Same as session model (default)'
    )
    const both = within(screen.getByTestId('PiAutoModeSection.twoStageMode'))
      .getAllByTestId('PiAutoModeSection.twoStageMode.option')
      .find((o) => o.getAttribute('data-id') === 'both')!
    expect(both.className).toContain('text-accent')
  })

  it('shows a configured-but-undiscovered judge model verbatim', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({ autoMode: { judgeModel: 'local/mystery' } }))
    })
    await renderLoaded()

    const field = screen.getByTestId('PiAutoModeSection.judgeModel')
    expect(field.getAttribute('data-value')).toBe('local/mystery')
    expect(field.textContent).toContain('local/mystery')
    expect(field.textContent).not.toContain('Same as session model')
  })
})

describe('PiAutoModeSection — saves merge into engines/pi.json, never clobber', () => {
  it('toggling auto mode off writes enabled:false and keeps piConfig + trust lists', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByTestId('PiAutoModeSection.enabled'))

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(savedEngineIds[0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: {
        enabled: false,
        judgeModel: 'openai-codex/gpt-5.6-mini',
        trustedDomains: ['a.dev']
      },
      piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
    })

    // The sub-controls collapse when auto mode is off.
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel')).toBeNull()
  })

  it('picking a judge model saves the picker VALUE (provider/model-id)', async () => {
    await renderLoaded()
    openJudgePicker()
    fireEvent.click(judgeOption('openai-codex/gpt-5.6-luna'))

    expect(savedConfigs[0].autoMode?.judgeModel).toBe('openai-codex/gpt-5.6-luna')
    expect(savedConfigs[0].autoMode?.trustedDomains).toEqual(['a.dev'])
    expect(savedConfigs[0].piConfig).toEqual(BASE_CONFIG.piConfig)
  })

  it('picking the pinned default row clears judgeModel (undefined, not empty string)', async () => {
    await renderLoaded()
    openJudgePicker()
    fireEvent.click(judgeOption(''))

    expect(savedConfigs[0].autoMode).toHaveProperty('judgeModel', undefined)
    expect(savedConfigs[0].autoMode?.enabled).toBe(true)
    expect(savedConfigs[0].piConfig).toEqual(BASE_CONFIG.piConfig)
  })

  it('choosing a two-stage mode saves it alongside the rest', async () => {
    await renderLoaded()

    const fast = within(screen.getByTestId('PiAutoModeSection.twoStageMode'))
      .getAllByTestId('PiAutoModeSection.twoStageMode.option')
      .find((o) => o.getAttribute('data-id') === 'fast')!
    fireEvent.click(fast)

    expect(savedConfigs[0].autoMode).toEqual({
      enabled: true,
      judgeModel: 'openai-codex/gpt-5.6-mini',
      trustedDomains: ['a.dev'],
      twoStageMode: 'fast'
    })
  })

  it('sequential edits accumulate on local state', async () => {
    await renderLoaded()

    const thinking = within(screen.getByTestId('PiAutoModeSection.twoStageMode'))
      .getAllByTestId('PiAutoModeSection.twoStageMode.option')
      .find((o) => o.getAttribute('data-id') === 'thinking')!
    fireEvent.click(thinking)
    openJudgePicker()
    fireEvent.click(judgeOption('openai-codex/gpt-5.6-luna'))

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].autoMode).toEqual({
      enabled: true,
      judgeModel: 'openai-codex/gpt-5.6-luna',
      trustedDomains: ['a.dev'],
      twoStageMode: 'thinking'
    })
  })
})

describe('OpencodeAutoModeSection — same core, own engine + testids', () => {
  function renderOpencode(): void {
    const item = SECTIONS.find((s) => s.id === 'opencode-automode')!.items.find(
      (i) => i.key === 'opencodeAutoMode'
    )!
    render(
      item.render({} as never, () => {}, {} as never, () => {}, {} as never, () => {})
    )
  }

  it('renders opencode models in a themed picker and saves to the opencode config', async () => {
    renderOpencode()
    await waitFor(() => expect(screen.getByTestId('OpencodeAutoModeSection.judgeModel')).toBeTruthy())

    const field = screen.getByTestId('OpencodeAutoModeSection.judgeModel')
    expect(field.querySelector('select')).toBeNull()

    fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
    expect(screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))).toEqual([
      '',
      'openai/gpt-5'
    ])

    fireEvent.click(judgeOption('openai/gpt-5'))
    expect(savedEngineIds[0]).toBe('opencode')
    expect(savedConfigs[0].autoMode?.judgeModel).toBe('openai/gpt-5')
  })
})
