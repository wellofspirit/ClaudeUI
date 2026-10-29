/**
 * Layer 2: Component tests for the pi auto-mode settings section, plus the
 * shared `AutoModeSection` core it now has in common with opencode.
 *
 * PiSession has read `loadEngineConfig('pi').autoMode` since the phase-4
 * gatekeeper wiring; this section is the first UI that can write it. Tested
 * flows:
 *   1. Loading while the config is pending (a pi that does not run hides the
 *      judge's pi segment, never reaches here — ADR-082 §8)
 *   2. Load renders the saved autoMode block; judge options are pi models ONLY
 *   3. The judge picker is the themed ModelPicker, NOT a native <select>
 *      (native <option> lists are OS-painted — unreadable under Monokai)
 *   4. Saves merge: `piConfig` and other autoMode keys are never clobbered
 *   5. Picking the pinned default row clears judgeModel (undefined, not '')
 *   6. A configured-but-undiscovered judgeModel is shown verbatim, not
 *      collapsed to the "default" label
 *   7. The opencode twin renders from the same core with its own testids
 *   8. The three trust lists are NOT here any more: ADR-065 phase 4 moved them
 *      to the shared `automode.json` and its own Trust & protection group
 *      (TrustLists.component.test.tsx). This pane must not resurrect them.
 *   9. ClaudeUI calls the judge itself (ADR-081): the picker lists only the
 *      models `judgeModelSupport` says it can call, a saved model it can't
 *      call gets a notice with the reason, and an empty list says so
 *  10. The fallback judge can run on another ChatGPT account (Advanced fold),
 *      refuses to be the same model on the same account as the judge, and the
 *      judge row says when its route is resting after a usage limit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import type {
  AutoModeConfig,
  EngineConfig,
  EngineModelGroup,
  JudgeModelSupport
} from '../../../../../shared/types'
import type { SharedProviderAccountList } from '../../../../../shared/shared-provider'

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
  autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.6-mini' },
  piConfig: { defaultModel: 'openai-codex/gpt-5.6-luna' }
}

// ── window.api stub ──────────────────────────────────────────────────

let savedConfigs: EngineConfig[] = []
let savedEngineIds: string[] = []
const saveEngineConfig = vi.fn(async (engineId: string, cfg: EngineConfig) => {
  savedEngineIds.push(engineId)
  savedConfigs.push(structuredClone(cfg))
})

/** Two ChatGPT vault accounts; the first is the active one. */
const ACCOUNTS: SharedProviderAccountList = {
  activeId: 'acct-personal',
  accounts: [
    { id: 'acct-personal', email: 'Personal', planType: 'pro', expiresAt: 0, needsReauth: false },
    { id: 'acct-work', email: 'Work', planType: 'business', expiresAt: 0, needsReauth: false }
  ]
}

/**
 * Every value is callable, unless listed in `refused` (value → reason). Values in
 * `chatgpt` also say they route through the ChatGPT subscription.
 */
function supportFor(refused: Record<string, string> = {}, chatgpt: string[] = []) {
  return vi.fn(async (_engineId: string, values: string[]) =>
    Object.fromEntries(
      values.map((v): [string, JudgeModelSupport] => [
        v,
        v in refused
          ? { ok: false, reason: refused[v] }
          : { ok: true, ...(chatgpt.includes(v) ? { chatgpt: true } : {}) }
      ])
    )
  )
}

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    loadEngineConfig: vi.fn(async () => structuredClone(BASE_CONFIG)),
    getEngineModels: vi.fn(async () => MODEL_GROUPS),
    judgeModelSupport: supportFor(),
    listProviderAccounts: vi.fn(async () => structuredClone(ACCOUNTS)),
    judgeRouteResting: vi.fn(async () => null),
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

describe('PiAutoModeSection — loading', () => {
  it('shows Loading while the config is pending', () => {
    installApiStub({ loadEngineConfig: vi.fn(() => new Promise(() => {})) })
    render(<PiAutoModeSection />)
    expect(screen.getByTestId('PiAutoModeSection').textContent).toContain('Loading')
    expect(screen.queryByTestId('PiAutoModeSection.enabled')).toBeNull()
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
  it('toggling auto mode off writes enabled:false and keeps the sibling piConfig block', async () => {
    await renderLoaded()

    fireEvent.click(screen.getByTestId('PiAutoModeSection.enabled'))

    expect(saveEngineConfig).toHaveBeenCalledTimes(1)
    expect(savedEngineIds[0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: false, judgeModel: 'openai-codex/gpt-5.6-mini' },
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
      twoStageMode: 'thinking'
    })
  })
})

// -- The trust lists are GONE from this pane (ADR-065 phase 4) -------

describe('AutoModeSection - trust lists moved out', () => {
  it('renders none of the three list editors any more', async () => {
    await renderLoaded()

    // They live in `TrustListsSection` now, saved to the shared automode.json.
    // A regression that re-added them here would write them back into
    // engines/pi.json, where nothing reads them.
    for (const field of ['trustedDomains', 'trustedRegistries', 'protectedPatterns']) {
      expect(screen.queryByTestId(`PiAutoModeSection.${field}`)).toBeNull()
    }
  })

  it('never writes a trust-list key into engines/pi.json', async () => {
    await renderLoaded()

    const fast = within(screen.getByTestId('PiAutoModeSection.twoStageMode'))
      .getAllByTestId('PiAutoModeSection.twoStageMode.option')
      .find((o) => o.getAttribute('data-id') === 'fast')!
    fireEvent.click(fast)

    const auto = savedConfigs[0].autoMode as Record<string, unknown>
    expect(Object.keys(auto).sort()).toEqual(['enabled', 'judgeModel', 'twoStageMode'])
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

    // The support query names opencode's own values, never pi's.
    const api = (window as unknown as { api: { judgeModelSupport: ReturnType<typeof vi.fn> } }).api
    expect(api.judgeModelSupport).toHaveBeenCalledWith('opencode', ['openai/gpt-5'])

    fireEvent.click(judgeOption('openai/gpt-5'))
    expect(savedEngineIds[0]).toBe('opencode')
    expect(savedConfigs[0].autoMode?.judgeModel).toBe('openai/gpt-5')
  })

  it('has no trust lists either — the shared core dropped them for BOTH engines', async () => {
    renderOpencode()
    await waitFor(() =>
      expect(screen.getByTestId('OpencodeAutoModeSection.judgeModel')).toBeTruthy()
    )
    for (const field of ['trustedDomains', 'trustedRegistries', 'protectedPatterns']) {
      expect(screen.queryByTestId(`OpencodeAutoModeSection.${field}`)).toBeNull()
    }
  })
})

// -- ADR-081: only models ClaudeUI can call for the judge are offered -------

describe('AutoModeSection - the picker offers only models ClaudeUI can call', () => {
  const MINI = 'openai-codex/gpt-5.6-mini'
  const LUNA = 'openai-codex/gpt-5.6-luna'
  const REASON =
    '"openai-codex" is set up inside pi, not in ClaudeUI, so ClaudeUI cannot call it for the judge.'

  function options(): (string | null)[] {
    return screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))
  }

  it("asks about this engine's models and lists only the supported ones", async () => {
    const judgeModelSupport = supportFor({ [LUNA]: REASON })
    installApiStub({
      judgeModelSupport,
      loadEngineConfig: vi.fn(async () => ({ autoMode: { enabled: true } }))
    })
    await renderLoaded()
    await waitFor(() => expect(judgeModelSupport).toHaveBeenCalled())
    expect(judgeModelSupport).toHaveBeenCalledWith('pi', [LUNA, MINI])

    openJudgePicker()
    await waitFor(() => expect(options()).toEqual(['', MINI]))
    // The saved value is unset, so nothing needs a notice.
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.unsupported')).toBeNull()
  })

  it("a SAVED judge model ClaudeUI can't call keeps its name and gets the reason underneath", async () => {
    installApiStub({ judgeModelSupport: supportFor({ [MINI]: REASON }) })
    await renderLoaded()

    const notice = await screen.findByTestId('PiAutoModeSection.judgeModel.unsupported')
    expect(notice.getAttribute('data-state')).toBe('unsupported')
    expect(notice.getAttribute('data-model')).toBe(MINI)
    expect(notice.textContent).toBe(REASON)
    // Still shown by its display name — not as an unknown value, not as stale.
    const field = screen.getByTestId('PiAutoModeSection.judgeModel')
    expect(field.textContent).toContain('GPT-5.6 Mini')
    expect(field.textContent).not.toContain('(unavailable)')
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.staleModel')).toBeNull()
    // …and no longer offered.
    openJudgePicker()
    expect(options()).toEqual(['', LUNA])
  })

  it('no model left → only the default row, and a notice naming Models & providers', async () => {
    installApiStub({ judgeModelSupport: supportFor({ [LUNA]: REASON, [MINI]: REASON }) })
    await renderLoaded()

    const notice = await screen.findByTestId('PiAutoModeSection.judgeModel.unsupported')
    expect(notice.getAttribute('data-state')).toBe('none')
    expect(notice.textContent).toContain('No model here can judge')
    expect(notice.textContent).toContain('Settings › Models & providers')
    openJudgePicker()
    expect(options()).toEqual([''])
  })

  it('a failed support query lists every model and shows no notice', async () => {
    installApiStub({
      judgeModelSupport: vi.fn(async () => {
        throw new Error('boom')
      })
    })
    await renderLoaded()
    openJudgePicker()
    expect(options()).toEqual(['', LUNA, MINI])
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.unsupported')).toBeNull()
  })

  it('the row says why the list is short', async () => {
    await renderLoaded()
    expect(screen.getByTestId('PiAutoModeSection.judgeModelRow').textContent).toContain(
      'ClaudeUI calls the judge itself'
    )
  })
})

// -- The fallback judge: a second picker, same narrowing, merges like the rest ----

describe('AutoModeSection - the fallback judge model', () => {
  const MINI = 'openai-codex/gpt-5.6-mini'
  const LUNA = 'openai-codex/gpt-5.6-luna'
  const REASON =
    '"openai-codex" is set up inside pi, not in ClaudeUI, so ClaudeUI cannot call it for the judge.'
  const ID = 'PiAutoModeSection.fallbackJudgeModel'

  function options(): (string | null)[] {
    return screen.getAllByTestId('ModelPicker.option').map((o) => o.getAttribute('data-value'))
  }
  function openFallbackPicker(): void {
    fireEvent.click(within(screen.getByTestId(ID)).getByTestId('ModelPicker.trigger'))
  }

  it('is a themed picker with its own row, unset by default, and the hint says what unset does', async () => {
    await renderLoaded()

    const field = screen.getByTestId(ID)
    expect(field.getAttribute('data-value')).toBe('')
    expect(field.querySelector('select')).toBeNull()
    expect(field.textContent).toContain('None (ask me instead)')
    const row = screen.getByTestId('PiAutoModeSection.fallbackJudgeModelRow').textContent
    expect(row).toContain('Fallback judge model')
    expect(row).toContain("Judges when the judge model can't answer (rate limit, outage).")
    expect(row).toContain('Leave empty to ask you instead.')
  })

  it('lists the same models the judge picker does: only the ones ClaudeUI can call', async () => {
    const judgeModelSupport = supportFor({ [LUNA]: REASON })
    installApiStub({
      judgeModelSupport,
      loadEngineConfig: vi.fn(async () => ({ autoMode: { enabled: true } }))
    })
    await renderLoaded()
    await waitFor(() => expect(judgeModelSupport).toHaveBeenCalled())

    // One query serves both pickers; no desktop-only API is involved (remote web parity).
    expect(judgeModelSupport).toHaveBeenCalledTimes(1)
    openFallbackPicker()
    await waitFor(() => expect(options()).toEqual(['', MINI]))
  })

  it('picking a model saves it beside the judge model, merging into the block', async () => {
    await renderLoaded()
    openFallbackPicker()
    fireEvent.click(judgeOption(LUNA))

    expect(savedEngineIds[0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA },
      piConfig: BASE_CONFIG.piConfig
    })
    expect(screen.getByTestId(ID).getAttribute('data-value')).toBe(LUNA)
  })

  it('picking a model known NOT to route through ChatGPT clears a saved fallback account', async () => {
    const judgeModelSupport = supportFor({}, [MINI])
    installApiStub({
      judgeModelSupport,
      loadEngineConfig: vi.fn(async () => ({
        autoMode: {
          enabled: true,
          judgeModel: MINI,
          fallbackJudgeModel: MINI,
          fallbackJudgeAccount: 'acct-work'
        }
      }))
    })
    await renderLoaded()
    await waitFor(() => expect(judgeModelSupport).toHaveBeenCalled())
    openFallbackPicker()
    fireEvent.click(judgeOption(LUNA))

    expect(savedConfigs[0].autoMode).toEqual({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: undefined
    })
  })

  it('picking a ChatGPT-routed model keeps the saved fallback account', async () => {
    const judgeModelSupport = supportFor({}, [MINI, LUNA])
    installApiStub({
      judgeModelSupport,
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { enabled: true, judgeModel: MINI, fallbackJudgeAccount: 'acct-work' }
      }))
    })
    await renderLoaded()
    await waitFor(() => expect(judgeModelSupport).toHaveBeenCalled())
    openFallbackPicker()
    fireEvent.click(judgeOption(LUNA))

    expect(savedConfigs[0].autoMode?.fallbackJudgeAccount).toBe('acct-work')
    expect(savedConfigs[0].autoMode?.fallbackJudgeModel).toBe(LUNA)
  })

  it('the empty row clears it (undefined, not an empty string) and keeps the judge model', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA }
      }))
    })
    await renderLoaded()
    expect(screen.getByTestId(ID).getAttribute('data-value')).toBe(LUNA)

    openFallbackPicker()
    fireEvent.click(judgeOption(''))

    expect(savedConfigs[0].autoMode).toHaveProperty('fallbackJudgeModel', undefined)
    expect(savedConfigs[0].autoMode?.judgeModel).toBe(MINI)
  })

  it('editing another setting never drops a saved fallback', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA }
      }))
    })
    await renderLoaded()

    openJudgePicker()
    fireEvent.click(judgeOption(LUNA))

    expect(savedConfigs[0].autoMode).toEqual({
      enabled: true,
      judgeModel: LUNA,
      fallbackJudgeModel: LUNA
    })
  })

  it('a saved fallback the engine no longer offers is shown by name, marked, and not a judge notice', async () => {
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { enabled: true, fallbackJudgeModel: 'local/mystery' }
      }))
    })
    await renderLoaded()

    expect(screen.getByTestId(ID).textContent).toContain('local/mystery')
    expect(screen.getByTestId(ID).textContent).toContain('(unavailable)')
    expect(screen.getByTestId(`${ID}.staleModel`).getAttribute('data-model')).toBe('local/mystery')
    // The judge picker is unset and shows nothing of it.
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.staleModel')).toBeNull()
  })

  it("a saved fallback ClaudeUI can't call gets the reason under its own picker only", async () => {
    installApiStub({
      judgeModelSupport: supportFor({ [LUNA]: REASON }),
      loadEngineConfig: vi.fn(async () => ({
        autoMode: { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA }
      }))
    })
    await renderLoaded()

    const notice = await screen.findByTestId(`${ID}.unsupported`)
    expect(notice.getAttribute('data-state')).toBe('unsupported')
    expect(notice.textContent).toBe(REASON)
    expect(screen.queryByTestId('PiAutoModeSection.judgeModel.unsupported')).toBeNull()
  })

  it('"no model can judge" is said once, under the judge picker', async () => {
    installApiStub({ judgeModelSupport: supportFor({ [LUNA]: REASON, [MINI]: REASON }) })
    await renderLoaded()

    await screen.findByTestId('PiAutoModeSection.judgeModel.unsupported')
    expect(screen.queryByTestId(`${ID}.unsupported`)).toBeNull()
  })

  it('collapses with the rest when auto mode is off', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId('PiAutoModeSection.enabled'))
    expect(screen.queryByTestId(ID)).toBeNull()
  })

  it('the opencode twin has its own picker and saves to the opencode config', async () => {
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
    const field = await screen.findByTestId('OpencodeAutoModeSection.fallbackJudgeModel')
    fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
    fireEvent.click(judgeOption('openai/gpt-5'))

    expect(savedEngineIds[0]).toBe('opencode')
    expect(savedConfigs[0].autoMode?.fallbackJudgeModel).toBe('openai/gpt-5')
  })
})

// -- Advanced: the fallback judge on another ChatGPT account, resting, same-model -----

const P = 'PiAutoModeSection'
const LUNA = 'openai-codex/gpt-5.6-luna'
const MINI = 'openai-codex/gpt-5.6-mini'
/** Not a ChatGPT model: one account only. */
const ROUTER = 'openrouter/deepseek-v4'
const ROUTER_GROUP: EngineModelGroup = {
  engineId: 'pi',
  vendorId: 'openrouter',
  vendorName: 'OpenRouter',
  models: [
    {
      value: ROUTER,
      displayName: 'DeepSeek V4',
      description: '',
      engineId: 'pi',
      vendorId: 'openrouter'
    }
  ]
}
const NOT_CHATGPT_NOTE =
  "The fallback model isn't a ChatGPT model, so there is only one account to use — this setting does nothing until you pick a ChatGPT fallback."
const SAME_JUDGE_WARNING =
  'Same model on the same account as the judge — it would hit the same limit. Pick another model, or another account under Advanced.'

type ApiFn = ReturnType<typeof vi.fn>

/** Render the section over `autoMode`, with the ChatGPT-routed models marked as such. */
async function renderWith(
  autoMode: AutoModeConfig,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  installApiStub({
    getEngineModels: vi.fn(async () => [...MODEL_GROUPS, ROUTER_GROUP]),
    judgeModelSupport: supportFor({}, [LUNA, MINI]),
    loadEngineConfig: vi.fn(async () => ({ autoMode, piConfig: BASE_CONFIG.piConfig })),
    ...overrides
  })
  await renderLoaded()
}

function toggle(): HTMLButtonElement {
  return screen.getByTestId(`${P}.fallbackAccountToggle`) as HTMLButtonElement
}

/** The toggle is usable once the account list has arrived. */
async function toggleReady(): Promise<HTMLButtonElement> {
  await waitFor(() => expect(toggle().disabled).toBe(false))
  return toggle()
}

function api(): Record<string, ApiFn> {
  return (window as unknown as { api: Record<string, ApiFn> }).api
}

const lastSaved = (): AutoModeConfig | undefined => savedConfigs.at(-1)?.autoMode

function accountTrigger(): HTMLButtonElement {
  return within(screen.getByTestId(`${P}.fallbackAccount`)).getByTestId(
    `${P}.fallbackAccount.trigger`
  ) as HTMLButtonElement
}

describe('AutoModeSection - Advanced fold', () => {
  it('is collapsed by default and holds the account toggle, off, with no account row', async () => {
    await renderWith({ enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA })

    const advanced = screen.getByTestId(`${P}.advanced`) as HTMLDetailsElement
    expect(advanced.tagName).toBe('DETAILS')
    expect(advanced.open).toBe(false)
    expect(advanced.querySelector('summary')?.textContent).toBe('▸ Advanced')
    expect(within(advanced).getByTestId(`${P}.fallbackAccountToggle`)).toBeTruthy()
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(toggle().textContent).toContain('Fallback on a different account')
    expect(screen.queryByTestId(`${P}.fallbackAccount`)).toBeNull()
  })

  it('the caret follows the fold', async () => {
    await renderWith({ enabled: true })
    const advanced = screen.getByTestId(`${P}.advanced`) as HTMLDetailsElement

    advanced.open = true
    fireEvent(advanced, new Event('toggle'))

    expect(advanced.querySelector('summary')?.textContent).toBe('▾ Advanced')
  })

  it('is gone with the rest of the judge rows when auto mode is off', async () => {
    await renderWith({ enabled: true })
    fireEvent.click(screen.getByTestId(`${P}.enabled`))
    expect(screen.queryByTestId(`${P}.advanced`)).toBeNull()
  })
})

describe('AutoModeSection - fallback on a different account', () => {
  it('turning it on picks the first account that is not the active one, and merges the save', async () => {
    await renderWith({ enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA })

    fireEvent.click(await toggleReady())

    expect(savedEngineIds[0]).toBe('pi')
    expect(savedConfigs[0]).toEqual({
      autoMode: {
        enabled: true,
        judgeModel: MINI,
        fallbackJudgeModel: LUNA,
        fallbackJudgeAccount: 'acct-work'
      },
      piConfig: BASE_CONFIG.piConfig
    })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    const picker = screen.getByTestId(`${P}.fallbackAccount`)
    expect(picker.getAttribute('data-value')).toBe('acct-work')
    expect(picker.textContent).toContain('Work · business')
  })

  it.each([
    ['a', 'b'],
    ['b', 'a'],
    ['c', 'a']
  ])(
    'skips the active account wherever it sits in the list (active %s -> %s)',
    async (active, want) => {
      const three: SharedProviderAccountList = {
        activeId: active,
        accounts: ['a', 'b', 'c'].map((id) => ({
          id,
          email: id.toUpperCase(),
          planType: 'plus',
          expiresAt: 0,
          needsReauth: false
        }))
      }
      await renderWith(
        { enabled: true, judgeModel: MINI },
        { listProviderAccounts: vi.fn(async () => three) }
      )

      fireEvent.click(await toggleReady())
      expect(lastSaved()?.fallbackJudgeAccount).toBe(want)
    }
  )

  it('with only the active account, it takes that one rather than nothing', async () => {
    const one: SharedProviderAccountList = { ...ACCOUNTS, accounts: [ACCOUNTS.accounts[0]] }
    await renderWith(
      { enabled: true, judgeModel: MINI },
      { listProviderAccounts: vi.fn(async () => one) }
    )

    fireEvent.click(await toggleReady())

    expect(lastSaved()?.fallbackJudgeAccount).toBe('acct-personal')
  })

  it('turning it off clears the account (undefined, not an empty string) and keeps the rest', async () => {
    await renderWith({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId(`${P}.fallbackAccount`)).toBeTruthy()

    fireEvent.click(await toggleReady())

    expect(lastSaved()).toHaveProperty('fallbackJudgeAccount', undefined)
    expect(lastSaved()?.fallbackJudgeModel).toBe(LUNA)
    expect(savedConfigs[0].piConfig).toEqual(BASE_CONFIG.piConfig)
    expect(screen.queryByTestId(`${P}.fallbackAccount`)).toBeNull()
  })

  it('lists every ChatGPT account as "label · plan", marks the active one, and saves a pick', async () => {
    await renderWith({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    const picker = screen.getByTestId(`${P}.fallbackAccount`)
    await waitFor(() => expect(picker.textContent).toContain('Work · business'))

    fireEvent.click(accountTrigger())
    const options = within(picker).getAllByTestId(`${P}.fallbackAccount.option`)

    expect(options.map((o) => [o.getAttribute('data-id'), o.textContent])).toEqual([
      ['acct-personal', 'Personal · pro (active)'],
      ['acct-work', 'Work · business']
    ])
    fireEvent.click(options[0])
    expect(lastSaved()?.fallbackJudgeAccount).toBe('acct-personal')
    expect(screen.getByTestId(`${P}.fallbackAccount`).getAttribute('data-value')).toBe(
      'acct-personal'
    )
  })

  it('a saved account that is no longer signed in is named as such, and can still be cleared', async () => {
    await renderWith({ enabled: true, judgeModel: MINI, fallbackJudgeAccount: 'acct-gone' })
    const picker = screen.getByTestId(`${P}.fallbackAccount`)
    await waitFor(() => expect(picker.textContent).toContain('Account no longer signed in'))

    fireEvent.click(await toggleReady())
    expect(lastSaved()).toHaveProperty('fallbackJudgeAccount', undefined)
  })

  describe('with no ChatGPT account to offer', () => {
    const NONE: SharedProviderAccountList = { activeId: null, accounts: [] }

    it('the toggle is disabled and says to sign in', async () => {
      await renderWith(
        { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA },
        { listProviderAccounts: vi.fn(async () => NONE) }
      )
      await waitFor(() => expect(api().listProviderAccounts).toHaveBeenCalledWith('chatgpt'))

      expect(toggle().disabled).toBe(true)
      expect(toggle().textContent).toContain('Sign in to a second ChatGPT account to use this.')
      expect(toggle().textContent).not.toContain('Run the fallback judge on another')
      fireEvent.click(toggle())
      expect(savedConfigs).toEqual([])
    })

    it('an unreadable account list reads the same, without crashing', async () => {
      await renderWith(
        { enabled: true, judgeModel: MINI },
        {
          listProviderAccounts: vi.fn(async () => {
            throw new Error('vault unavailable')
          })
        }
      )
      await waitFor(() => expect(api().listProviderAccounts).toHaveBeenCalled())

      expect(toggle().disabled).toBe(true)
    })

    it('a toggle that is already on stays clickable, so the setting can always be cleared', async () => {
      await renderWith(
        { enabled: true, judgeModel: MINI, fallbackJudgeAccount: 'acct-work' },
        { listProviderAccounts: vi.fn(async () => NONE) }
      )
      await waitFor(() => expect(api().listProviderAccounts).toHaveBeenCalled())

      expect(toggle().disabled).toBe(false)
      fireEvent.click(toggle())
      expect(lastSaved()).toHaveProperty('fallbackJudgeAccount', undefined)
    })
  })
})

describe('AutoModeSection - the account picker needs a ChatGPT fallback', () => {
  it('is disabled, with the note, when the fallback model is not a ChatGPT model', async () => {
    await renderWith({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: ROUTER,
      fallbackJudgeAccount: 'acct-work'
    })

    const note = await screen.findByTestId(`${P}.fallbackAccount.notChatgpt`)
    expect(note.textContent).toBe(NOT_CHATGPT_NOTE)
    expect(accountTrigger().disabled).toBe(true)
  })

  it('is enabled, with no note, for a ChatGPT fallback', async () => {
    await renderWith({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())

    expect(screen.queryByTestId(`${P}.fallbackAccount.notChatgpt`)).toBeNull()
    expect(accountTrigger().disabled).toBe(false)
  })

  it('follows the fallback picker: switching to a non-ChatGPT model clears the account', async () => {
    await renderWith({
      enabled: true,
      judgeModel: MINI,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId(`${P}.fallbackAccount.notChatgpt`)).toBeNull())
    expect(accountTrigger().disabled).toBe(false)

    fireEvent.click(
      within(screen.getByTestId(`${P}.fallbackJudgeModel`)).getByTestId('ModelPicker.trigger')
    )
    fireEvent.click(judgeOption(ROUTER))

    // A model with one account has nothing to pick: the saved account would only mislabel the
    // fallback (and keep a same-model fallback that repeats the judge's failure), so it goes.
    expect(lastSaved()?.fallbackJudgeAccount).toBeUndefined()
    expect(screen.queryByTestId(`${P}.fallbackAccount`)).toBeNull()
  })

  it('stays usable until judgeModelSupport has answered, rather than flashing disabled', async () => {
    await renderWith(
      {
        enabled: true,
        judgeModel: MINI,
        fallbackJudgeModel: ROUTER,
        fallbackJudgeAccount: 'acct-work'
      },
      { judgeModelSupport: vi.fn(() => new Promise(() => {})) }
    )

    expect(accountTrigger().disabled).toBe(false)
    expect(screen.queryByTestId(`${P}.fallbackAccount.notChatgpt`)).toBeNull()
  })
})

describe('AutoModeSection - same model on the same account as the judge', () => {
  const warning = (): HTMLElement | null => screen.queryByTestId(`${P}.sameJudgeWarning`)

  it('shows when the fallback is the judge model and no other account is set', async () => {
    await renderWith({ enabled: true, judgeModel: LUNA, fallbackJudgeModel: LUNA })

    expect(warning()?.textContent).toBe(SAME_JUDGE_WARNING)
  })

  it('shows when the chosen account is the active one', async () => {
    await renderWith({
      enabled: true,
      judgeModel: LUNA,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-personal'
    })
    await waitFor(() => expect(api().listProviderAccounts).toHaveBeenCalled())
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())

    expect(warning()).not.toBeNull()
  })

  it('is absent for the same model on another account', async () => {
    await renderWith({
      enabled: true,
      judgeModel: LUNA,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())
    await waitFor(() => expect(warning()).toBeNull())
  })

  it('is absent for a different model, and with no fallback at all', async () => {
    await renderWith({ enabled: true, judgeModel: LUNA, fallbackJudgeModel: MINI })
    expect(warning()).toBeNull()
    cleanup()

    await renderWith({ enabled: true, judgeModel: LUNA })
    expect(warning()).toBeNull()
  })

  it('stays when the model has no second account to use (not a ChatGPT model)', async () => {
    await renderWith({
      enabled: true,
      judgeModel: ROUTER,
      fallbackJudgeModel: ROUTER,
      fallbackJudgeAccount: 'acct-work'
    })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())

    expect(warning()).not.toBeNull()
  })

  it('goes away when another account is chosen, and comes back when it is switched off', async () => {
    await renderWith({ enabled: true, judgeModel: LUNA, fallbackJudgeModel: LUNA })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())
    expect(warning()).not.toBeNull()

    fireEvent.click(await toggleReady())
    await waitFor(() => expect(warning()).toBeNull())

    fireEvent.click(toggle())
    expect(warning()).not.toBeNull()
  })

  it('comes back when the active account is picked in the account picker', async () => {
    await renderWith({
      enabled: true,
      judgeModel: LUNA,
      fallbackJudgeModel: LUNA,
      fallbackJudgeAccount: 'acct-work'
    })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())
    await waitFor(() => expect(warning()).toBeNull())

    fireEvent.click(accountTrigger())
    fireEvent.click(
      within(screen.getByTestId(`${P}.fallbackAccount`))
        .getAllByTestId(`${P}.fallbackAccount.option`)
        .find((o) => o.getAttribute('data-id') === 'acct-personal')!
    )

    expect(warning()).not.toBeNull()
  })
})

describe('AutoModeSection - the judge route is resting', () => {
  /** Same call the component makes, so the assertion does not depend on the machine's locale. */
  const formatted = (ms: number): string =>
    new Date(ms).toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  const UNTIL = new Date(2026, 9, 28, 13, 34).getTime()
  const notice = (): HTMLElement | null => screen.queryByTestId(`${P}.judgeResting`)

  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks about the judge model on mount, and shows nothing when it is not resting', async () => {
    await renderWith({ enabled: true, judgeModel: MINI })
    await waitFor(() => expect(api().judgeRouteResting).toHaveBeenCalledWith('pi', MINI))

    expect(notice()).toBeNull()
  })

  it('names the model and the local time, and says the fallback is deciding when one is usable', async () => {
    await renderWith(
      { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA },
      { judgeRouteResting: vi.fn(async () => ({ until: UNTIL })) }
    )

    const el = await screen.findByTestId(`${P}.judgeResting`)
    expect(el.textContent).toContain('GPT-5.6 Mini has hit its usage limit and rests until ')
    expect(el.querySelector('b')?.textContent).toBe(formatted(UNTIL))
    expect(el.textContent).toMatch(/The fallback judge is deciding meanwhile\.$/)
    expect(el.getAttribute('data-until')).toBe(String(UNTIL))
    // It sits under the judge row, above the fallback row.
    const judgeRow = screen.getByTestId(`${P}.judgeModelRow`)
    const fallbackRow = screen.getByTestId(`${P}.fallbackJudgeModelRow`)
    expect(judgeRow.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(fallbackRow.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('says every gated action asks the user when there is no usable fallback', async () => {
    const resting = { judgeRouteResting: vi.fn(async () => ({ until: UNTIL })) }
    const tail = /Every gated action asks you meanwhile\.$/

    // No fallback set.
    await renderWith({ enabled: true, judgeModel: MINI }, resting)
    expect((await screen.findByTestId(`${P}.judgeResting`)).textContent).toMatch(tail)
    cleanup()

    // The fallback is the same model on the same account: it would be resting too.
    await renderWith({ enabled: true, judgeModel: MINI, fallbackJudgeModel: MINI }, resting)
    expect((await screen.findByTestId(`${P}.judgeResting`)).textContent).toMatch(tail)
    cleanup()

    // The fallback is a model ClaudeUI cannot call.
    await renderWith(
      { enabled: true, judgeModel: MINI, fallbackJudgeModel: LUNA },
      { ...resting, judgeModelSupport: supportFor({ [LUNA]: 'no route' }) }
    )
    await waitFor(() => expect(notice()?.textContent).toMatch(tail))
  })

  it('the same model on another account is a usable fallback', async () => {
    await renderWith(
      {
        enabled: true,
        judgeModel: MINI,
        fallbackJudgeModel: MINI,
        fallbackJudgeAccount: 'acct-work'
      },
      { judgeRouteResting: vi.fn(async () => ({ until: UNTIL })) }
    )

    await waitFor(() =>
      expect(notice()?.textContent).toMatch(/The fallback judge is deciding meanwhile\.$/)
    )
  })

  it('asks nothing while there is no judge model, or while auto mode is off', async () => {
    await renderWith({ enabled: true })
    await waitFor(() => expect(api().judgeModelSupport).toHaveBeenCalled())
    expect(api().judgeRouteResting).not.toHaveBeenCalled()
    cleanup()

    await renderWith(
      { enabled: true, judgeModel: MINI },
      { judgeRouteResting: vi.fn(async () => ({ until: UNTIL })) }
    )
    await screen.findByTestId(`${P}.judgeResting`)
    fireEvent.click(screen.getByTestId(`${P}.enabled`))
    expect(notice()).toBeNull()
  })

  it('an unreadable answer shows nothing and breaks nothing', async () => {
    await renderWith(
      { enabled: true, judgeModel: MINI },
      {
        judgeRouteResting: vi.fn(async () => {
          throw new Error('host unavailable')
        })
      }
    )
    await waitFor(() => expect(api().judgeRouteResting).toHaveBeenCalled())

    expect(notice()).toBeNull()
    expect(screen.getByTestId(`${P}.judgeModel`)).toBeTruthy()
  })

  it('re-asks every minute (the notice clears when the limit lifts) and stops on unmount', async () => {
    // Only the interval is faked: the testing library's own waiting rides on setTimeout.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const judgeRouteResting = vi
      .fn()
      .mockResolvedValueOnce({ until: UNTIL })
      .mockResolvedValue(null)
    installApiStub({
      loadEngineConfig: vi.fn(async () => ({ autoMode: { enabled: true, judgeModel: MINI } })),
      judgeRouteResting
    })
    const { unmount } = render(<PiAutoModeSection />)

    await screen.findByTestId(`${P}.judgeResting`)
    expect(judgeRouteResting).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(judgeRouteResting).toHaveBeenCalledTimes(2)
    expect(judgeRouteResting).toHaveBeenLastCalledWith('pi', MINI)
    expect(notice()).toBeNull()

    unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10 * 60_000)
    expect(judgeRouteResting).toHaveBeenCalledTimes(2)
  })

  it("the old model's cooldown is not shown once the judge model changes", async () => {
    await renderWith(
      { enabled: true, judgeModel: MINI },
      { judgeRouteResting: vi.fn(async () => ({ until: UNTIL })) }
    )
    await screen.findByTestId(`${P}.judgeResting`)

    openJudgePicker()
    fireEvent.click(judgeOption(''))

    expect(notice()).toBeNull()
  })
})
