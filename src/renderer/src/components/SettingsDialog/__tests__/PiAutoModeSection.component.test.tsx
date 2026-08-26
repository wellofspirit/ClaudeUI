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
 *   8. The three trust lists (trustedDomains / trustedRegistries /
 *      protectedPatterns) round-trip, and an emptied list is saved as an
 *      ABSENT key -- never `[]`, which the classifier cannot distinguish from
 *      absent (`?.length`) and which would invent a second encoding
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
    expect(
      screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))
    ).toEqual(['', 'openai-codex/gpt-5.6-luna', 'openai-codex/gpt-5.6-mini'])
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

  /**
   * Item 3e. Verbatim is not enough on its own: discovery HAS reported pi's
   * models and this value was not among them, so it is stale and will fail the
   * moment auto mode uses it. Mark it in place, keeping the value visible —
   * the fix is to change this very setting.
   */
  it('marks a configured judge model the engine no longer offers as unavailable', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({ autoMode: { judgeModel: 'local/mystery' } }))
    })
    await renderLoaded()

    const field = screen.getByTestId('PiAutoModeSection.judgeModel')
    expect(field.textContent).toContain('(unavailable)')
    const notice = screen.getByTestId('PiAutoModeSection.judgeModel.staleModel')
    expect(notice.getAttribute('data-model')).toBe('local/mystery')
  })

  it('does NOT mark an unset judge model, nor one that IS discovered', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { judgeModel: 'openai-codex/gpt-5.6-mini' }
      }))
    })
    await renderLoaded()

    expect(screen.getByTestId('PiAutoModeSection.judgeModel').textContent).not.toContain(
      '(unavailable)'
    )
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.staleModel')).toBeNull()
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

// -- Trust lists ------------------------------------------------------

/** Add a value to one of the three trust-list editors. */
function addTrustItem(field: string, value: string): void {
  const root = screen.getByTestId(`PiAutoModeSection.${field}`)
  fireEvent.change(within(root).getByTestId(`PiAutoModeSection.${field}.input`), {
    target: { value }
  })
  fireEvent.click(within(root).getByTestId(`PiAutoModeSection.${field}.add`))
}

/** Remove a value from one of the three trust-list editors, by chip data-id. */
function removeTrustItem(field: string, value: string): void {
  const root = screen.getByTestId(`PiAutoModeSection.${field}`)
  const chip = within(root)
    .getAllByTestId(`PiAutoModeSection.${field}.remove`)
    .find((b) => b.getAttribute('data-id') === value)
  if (!chip) throw new Error(`No ${field} chip for "${value}"`)
  fireEvent.click(chip)
}

/** Item values currently rendered by one of the trust-list editors. */
function trustItems(field: string): (string | null)[] {
  return within(screen.getByTestId(`PiAutoModeSection.${field}`))
    .queryAllByTestId(`PiAutoModeSection.${field}.item`)
    .map((el) => el.getAttribute('data-id'))
}

describe('AutoModeSection - trust lists', () => {
  it('renders all three lists, seeded from the saved config', async () => {
    await renderLoaded()

    expect(trustItems('trustedDomains')).toEqual(['a.dev'])
    expect(trustItems('trustedRegistries')).toEqual([])
    expect(trustItems('protectedPatterns')).toEqual([])
  })

  it('states what an EMPTY list means - the load-bearing half of the semantics', async () => {
    await renderLoaded()

    expect(screen.getByTestId('PiAutoModeSection.trustedDomains').textContent).toContain(
      'Empty = no external destination is trusted.'
    )
    expect(screen.getByTestId('PiAutoModeSection.trustedRegistries').textContent).toContain(
      "Empty = only the project manifest's default registry."
    )
    const protectedText = screen.getByTestId('PiAutoModeSection.protectedPatterns').textContent!
    expect(protectedText).toContain("'prod'/'production' as a whole word or segment")
    // A non-empty list REPLACES the heuristic rather than adding to it -
    // the one behavior a user cannot infer from the field name.
    expect(protectedText).toContain('REPLACES the heuristic')
  })

  it('hides the lists when auto mode is off (they only feed the judge)', async () => {
    installApiStub({ loadEngineConfig: vi.fn(async () => ({ autoMode: { enabled: false } })) })
    render(<PiAutoModeSection />)
    await waitFor(() => expect(screen.getByTestId('PiAutoModeSection.enabled')).toBeTruthy())

    expect(screen.queryByTestId('PiAutoModeSection.trustedDomains')).toBeNull()
    expect(screen.queryByTestId('PiAutoModeSection.trustedRegistries')).toBeNull()
    expect(screen.queryByTestId('PiAutoModeSection.protectedPatterns')).toBeNull()
  })

  it('adding a registry saves it and keeps every sibling key intact', async () => {
    await renderLoaded()

    addTrustItem('trustedRegistries', 'https://npm.acme.internal')

    expect(savedEngineIds[0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: {
        enabled: true,
        judgeModel: 'openai-codex/gpt-5.6-mini',
        trustedDomains: ['a.dev'],
        trustedRegistries: ['https://npm.acme.internal']
      },
      piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
    })
  })

  it('emptying a list DELETES the key - never writes [] (absent = the restrictive default)', async () => {
    await renderLoaded()

    removeTrustItem('trustedDomains', 'a.dev')

    const auto = savedConfigs[0].autoMode!
    // The distinction matters: the classifier reads these behind `?.length`,
    // so `[]` and absent mean the same thing - one encoding, not two.
    expect('trustedDomains' in auto).toBe(false)
    expect(JSON.parse(JSON.stringify(savedConfigs[0])).autoMode).not.toHaveProperty(
      'trustedDomains'
    )
    // ...and the rest of the block survives.
    expect(auto.enabled).toBe(true)
    expect(auto.judgeModel).toBe('openai-codex/gpt-5.6-mini')
    expect(savedConfigs[0].piConfig).toEqual({ defaultModel: 'openai-codex/gpt-5.6-luna' })
  })

  it('a re-added value comes back as a present key (absent <-> populated round-trip)', async () => {
    await renderLoaded()

    removeTrustItem('trustedDomains', 'a.dev')
    expect(trustItems('trustedDomains')).toEqual([])
    addTrustItem('trustedDomains', 'files.acme.com')

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].autoMode?.trustedDomains).toEqual(['files.acme.com'])
    expect(trustItems('trustedDomains')).toEqual(['files.acme.com'])
  })

  it('protectedPatterns edits never touch the other two lists', async () => {
    await renderLoaded()

    addTrustItem('protectedPatterns', 'acme-live-*')

    expect(savedConfigs[0].autoMode?.protectedPatterns).toEqual(['acme-live-*'])
    expect(savedConfigs[0].autoMode?.trustedDomains).toEqual(['a.dev'])
    expect('trustedRegistries' in savedConfigs[0].autoMode!).toBe(false)
  })
})

describe('OpencodeAutoModeSection - same core, own engine + testids', () => {
  function renderOpencode(): void {
    const item = SECTIONS.find((s) => s.id === 'opencode-automode')!.items.find(
      (i) => i.key === 'opencodeAutoMode'
    )!
    render(
      item.render(
        {} as never,
        () => {},
        {} as never,
        () => {},
        {} as never,
        () => {}
      )
    )
  }

  it('renders opencode models in a themed picker and saves to the opencode config', async () => {
    renderOpencode()
    await waitFor(() =>
      expect(screen.getByTestId('OpencodeAutoModeSection.judgeModel')).toBeTruthy()
    )

    const field = screen.getByTestId('OpencodeAutoModeSection.judgeModel')
    expect(field.querySelector('select')).toBeNull()

    fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
    expect(
      screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))
    ).toEqual(['', 'openai/gpt-5'])

    fireEvent.click(judgeOption('openai/gpt-5'))
    expect(savedEngineIds[0]).toBe('opencode')
    expect(savedConfigs[0].autoMode?.judgeModel).toBe('openai/gpt-5')
  })

  it('gets the trust lists from the shared core, under its own testids', async () => {
    renderOpencode()
    await waitFor(() =>
      expect(screen.getByTestId('OpencodeAutoModeSection.trustedDomains')).toBeTruthy()
    )
    expect(screen.getByTestId('OpencodeAutoModeSection.trustedRegistries')).toBeTruthy()
    expect(screen.getByTestId('OpencodeAutoModeSection.protectedPatterns')).toBeTruthy()

    const root = screen.getByTestId('OpencodeAutoModeSection.trustedDomains')
    fireEvent.change(within(root).getByTestId('OpencodeAutoModeSection.trustedDomains.input'), {
      target: { value: 'files.acme.com' }
    })
    fireEvent.click(within(root).getByTestId('OpencodeAutoModeSection.trustedDomains.add'))

    expect(savedEngineIds[0]).toBe('opencode')
    expect(savedConfigs[0].autoMode?.trustedDomains).toEqual(['a.dev', 'files.acme.com'])
  })
})
