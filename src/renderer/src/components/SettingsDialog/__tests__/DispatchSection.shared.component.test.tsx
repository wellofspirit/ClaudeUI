/**
 * Layer 2: Component tests for the behaviour the Claude, opencode and pi
 * dispatch panes share (ADR-033, ADR-065).
 *
 * The three sections are one implementation (`DispatchIntoSection` +
 * `DispatchLimitsSection` in settings-sections.tsx) bound to an engine id and a
 * testid prefix, so their tests used to be three copies of the same file. They
 * are one `describe.each` here; what is specific to one engine stays beside it
 * in `<Engine>DispatchSection.component.test.tsx`.
 *
 * ADR-065 split each pane into TWO group bodies over one config read — "Dispatch
 * into" (`<Prefix>`) and "Limits" (`<Prefix>.limits`) — and put the allowed
 * models on a CHIP SET rather than a list of toggle rows.
 *
 * Tested flows, per engine:
 *   1. Loading while the config is pending
 *   2. Load renders the current dispatch config (picker value + chip states),
 *      filtered to the engine's own models
 *   3. Editing the default model saves the FULL merged EngineConfig — sibling
 *      blocks (sandbox / proxy / autoMode) must not be clobbered
 *   4. "(not set)" clears defaultModel (undefined, not '')
 *   5. Toggling an allowed model on/off; last-off drops the allowedModels key
 *   6. maxCost and the turn/inactivity timeouts round-trip through the merged save
 *   7. The two halves share ONE config object, so an edit in one survives an edit
 *      in the other
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import type { EngineConfig, EngineId, EngineModelGroup } from '../../../../../shared/types'

import {
  ClaudeDispatchSection,
  OpencodeDispatchSection,
  PiDispatchSection
} from '../settings-sections'

// ── Fixtures ─────────────────────────────────────────────────────────

interface ModelFixture {
  value: string
  displayName: string
}

interface EngineFixture {
  label: string
  Section: () => React.JSX.Element
  engineId: EngineId
  /** The testid prefix every row of the pane carries. */
  prefix: string
  /** Two models of the engine: the saved default / allowed one, then the other. */
  first: ModelFixture
  second: ModelFixture
  /** Another engine's group, which must be filtered OUT of the pickers. */
  foreign: EngineModelGroup
  /** Sibling blocks of the saved config that a dispatch edit must never clobber. */
  siblings: EngineConfig
}

const group = (engineId: EngineId, vendorId: string, models: ModelFixture[]): EngineModelGroup => ({
  engineId,
  vendorId,
  vendorName: vendorId,
  models: models.map((m) => ({ ...m, description: '', engineId }))
})

const OPENCODE_FOREIGN = group('opencode', 'openai', [
  { value: 'openai/gpt-5', displayName: 'GPT-5' }
])
const CLAUDE_FOREIGN = group('claude', 'anthropic', [
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet' }
])

const ENGINES: EngineFixture[] = [
  {
    label: 'Claude',
    Section: ClaudeDispatchSection,
    engineId: 'claude',
    prefix: 'ClaudeDispatchSection',
    first: { value: 'sonnet', displayName: 'Sonnet' },
    second: { value: 'haiku', displayName: 'Haiku' },
    foreign: OPENCODE_FOREIGN,
    siblings: { sandbox: { mode: 'workspace-write' } as never, proxy: { enabled: true } as never }
  },
  {
    label: 'Opencode',
    Section: OpencodeDispatchSection,
    engineId: 'opencode',
    prefix: 'OpencodeDispatchSection',
    first: { value: 'openai/gpt-5', displayName: 'GPT-5' },
    second: { value: 'google/gemini-3', displayName: 'Gemini 3' },
    foreign: CLAUDE_FOREIGN,
    siblings: { autoMode: { enabled: true, judgeModel: 'openai/gpt-5-mini' } }
  },
  {
    label: 'Pi',
    Section: PiDispatchSection,
    engineId: 'pi',
    prefix: 'PiDispatchSection',
    first: { value: 'openai-codex/gpt-5.4', displayName: 'GPT-5.4' },
    second: { value: 'openai-codex/gpt-5.4-mini', displayName: 'GPT-5.4 mini' },
    foreign: OPENCODE_FOREIGN,
    siblings: { autoMode: { enabled: true, judgeModel: 'openai-codex/gpt-5.4-mini' } }
  }
]

// ── window.api stub ──────────────────────────────────────────────────

let savedConfigs: EngineConfig[] = []
const saveEngineConfig = vi.fn(async (_engineId: string, cfg: EngineConfig) => {
  savedConfigs.push(structuredClone(cfg))
})

beforeEach(() => {
  savedConfigs = []
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

// ── Tests ────────────────────────────────────────────────────────────

describe.each(ENGINES)('$label dispatch section — shared behaviour', (e) => {
  const { first, second } = e
  const id = (suffix: string): string => `${e.prefix}.${suffix}`
  const baseConfig = (): EngineConfig => ({
    ...e.siblings,
    dispatch: { defaultModel: first.value, allowedModels: [first.value] }
  })
  /** The saved config after an edit: siblings intact, dispatch as given. */
  const withDispatch = (dispatch: NonNullable<EngineConfig['dispatch']>): EngineConfig => ({
    ...e.siblings,
    dispatch
  })

  function installApiStub(overrides: Record<string, unknown> = {}): void {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      loadEngineConfig: vi.fn(async () => structuredClone(baseConfig())),
      getEngineModels: vi.fn(async () => [group(e.engineId, 'vendor', [first, second]), e.foreign]),
      saveEngineConfig,
      ...overrides
    }
  }

  async function renderLoaded(): Promise<void> {
    render(<e.Section />)
    await waitFor(() => expect(screen.getByTestId(id('defaultModel'))).toBeTruthy())
  }

  /**
   * Drive the themed default-model picker (a `ModelPicker`, not a native
   * `<select>` — 8bc26d7's Monokai fix, extended to this section): open the
   * trigger, then click the option carrying `data-value`.
   */
  function pickDefaultModel(value: string): void {
    const field = screen.getByTestId(id('defaultModel'))
    fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
    const option = within(field)
      .getAllByTestId('ModelPicker.option')
      .find((o) => o.getAttribute('data-value') === value)
    expect(option, `ModelPicker option for "${value}"`).toBeTruthy()
    fireEvent.click(option!)
  }

  /** The option values the default-model picker currently offers, in order. */
  function defaultModelOptionValues(): (string | null)[] {
    const field = screen.getByTestId(id('defaultModel'))
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
      .getAllByTestId(id('allowedModel'))
      .find((el) => el.getAttribute('data-id') === modelValue)
    expect(chip, `allowedModel chip for ${modelValue}`).toBeTruthy()
    return chip!
  }

  /**
   * `NumberField` commits on blur and on Enter, not on every keystroke, so a
   * half-typed number never reaches the store. Every numeric edit below goes
   * through this rather than a bare `fireEvent.change`.
   */
  function commitNumber(suffix: string, value: string): void {
    const input = screen.getByTestId(id(suffix))
    fireEvent.change(input, { target: { value } })
    fireEvent.blur(input)
  }

  beforeEach(() => {
    installApiStub()
  })

  describe('loading and load', () => {
    it('shows Loading while the config is pending', () => {
      installApiStub({ loadEngineConfig: vi.fn(() => new Promise(() => {})) })
      render(<e.Section />)
      expect(screen.getByTestId(e.prefix).textContent).toContain('Loading')
      expect(screen.queryByTestId(id('defaultModel'))).toBeNull()
    })

    it("renders the saved dispatch config: default model selected, this engine's models only", async () => {
      await renderLoaded()

      const field = screen.getByTestId(id('defaultModel'))
      expect(field.getAttribute('data-value')).toBe(first.value)
      // The trigger reads the display name, not the raw value.
      expect(field.textContent).toContain(first.displayName)
      // Themed picker, never a native select (the Monokai fix from 8bc26d7).
      expect(field.querySelector('select')).toBeNull()
      expect(within(field).getByTestId('ModelPicker')).toBeTruthy()

      // Only this engine's models appear (the other group is filtered out),
      // plus the pinned "(not set)" empty option.
      expect(defaultModelOptionValues()).toEqual(['', first.value, second.value])

      // One allowed-model CHIP per model, discriminated by data-id.
      const chips = screen.getAllByTestId(id('allowedModel'))
      expect(chips.map((c) => c.getAttribute('data-id'))).toEqual([first.value, second.value])
    })

    it('renders the allowlist as a chip set whose pressed chips ARE the saved list', async () => {
      await renderLoaded()

      // ADR-065: a chip set, not the 13-row toggle list the audit called out.
      expect(screen.getByTestId(id('allowedModels'))).toBeTruthy()
      expect(allowedChip(first.value).getAttribute('aria-pressed')).toBe('true')
      expect(allowedChip(second.value).getAttribute('aria-pressed')).toBe('false')
    })

    it('splits into two roots over one config read, with the row ids unmoved', async () => {
      await renderLoaded()

      // "Dispatch into" keeps the pre-split root; "Limits" is its own.
      expect(screen.getByTestId(e.prefix)).toBeTruthy()
      expect(screen.getByTestId(id('limits'))).toBeTruthy()
      // Every limit row still answers to its pre-split id.
      expect(screen.getByTestId(id('maxCost'))).toBeTruthy()
      expect(screen.getByTestId(id('turnTimeout'))).toBeTruthy()
      expect(screen.getByTestId(id('idleTimeout'))).toBeTruthy()
    })
  })

  describe('saves merge, never clobber', () => {
    it('changing the default model saves the FULL config with siblings and allowedModels intact', async () => {
      await renderLoaded()

      pickDefaultModel(second.value)

      expect(saveEngineConfig).toHaveBeenCalledTimes(1)
      expect(saveEngineConfig.mock.calls[0][0]).toBe(e.engineId)
      expect(savedConfigs[0]).toEqual(
        withDispatch({ defaultModel: second.value, allowedModels: [first.value] })
      )
    })

    it('"(not set)" clears defaultModel without touching the rest', async () => {
      await renderLoaded()

      pickDefaultModel('')

      expect(savedConfigs[0].dispatch?.defaultModel).toBeUndefined()
      expect(savedConfigs[0].dispatch?.allowedModels).toEqual([first.value])
      expect({ ...savedConfigs[0], dispatch: undefined }).toEqual({
        ...e.siblings,
        dispatch: undefined
      })
    })

    it('toggling a model ON appends it to allowedModels (siblings intact)', async () => {
      await renderLoaded()

      fireEvent.click(allowedChip(second.value))

      expect(savedConfigs[0]).toEqual(
        withDispatch({
          defaultModel: first.value,
          allowedModels: [first.value, second.value]
        })
      )
    })

    it('toggling the LAST model OFF drops the allowedModels key (empty = all allowed)', async () => {
      await renderLoaded()

      fireEvent.click(allowedChip(first.value))

      expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
      expect(savedConfigs[0].dispatch?.defaultModel).toBe(first.value)
      expect({ ...savedConfigs[0], dispatch: undefined }).toEqual({
        ...e.siblings,
        dispatch: undefined
      })
    })

    it('sequential edits accumulate on local state (second save includes the first edit)', async () => {
      await renderLoaded()

      fireEvent.click(allowedChip(second.value))
      pickDefaultModel(second.value)

      expect(savedConfigs).toHaveLength(2)
      expect(savedConfigs[1].dispatch).toEqual({
        defaultModel: second.value,
        allowedModels: [first.value, second.value]
      })
    })

    it('setting maxCost saves it alongside the rest, siblings intact (ADR-033 M4-C)', async () => {
      await renderLoaded()

      commitNumber('maxCost', '2.5')

      expect(savedConfigs[0]).toEqual(
        withDispatch({
          defaultModel: first.value,
          allowedModels: [first.value],
          maxCostUsd: 2.5
        })
      )
    })

    it('clearing maxCost drops the key (undefined = no cap)', async () => {
      await renderLoaded()

      commitNumber('maxCost', '2.5')
      commitNumber('maxCost', '')

      expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
      expect(savedConfigs[1].dispatch?.defaultModel).toBe(first.value)
    })

    it('shows the cost cap in USD, with "no cap" as what EMPTY means', async () => {
      await renderLoaded()

      const input = screen.getByTestId(id('maxCost')) as HTMLInputElement
      expect(input.placeholder).toBe('no cap')
      expect(screen.getByTestId(id('maxCostRow')).textContent).toContain('USD')
    })

    it('offers the turn/inactivity timeouts, with "no limit" as what EMPTY means', async () => {
      // ADR-033's 2026-09-18 amendment: the two caps govern EVERY dispatch
      // direction and have no built-in default, so every section draws them and
      // an empty field is honestly "no limit".
      await renderLoaded()

      const turn = screen.getByTestId(id('turnTimeout')) as HTMLInputElement
      const idle = screen.getByTestId(id('idleTimeout')) as HTMLInputElement
      expect(turn.placeholder).toBe('no limit')
      expect(idle.placeholder).toBe('no limit')
      expect(screen.getByTestId(id('turnTimeoutRow')).textContent).toContain('min')
      expect(screen.getByTestId(id('idleTimeoutRow')).textContent).toContain(
        'Empty or 0 means no limit.'
      )
    })

    it('writes the turn/inactivity caps in MILLISECONDS, merged into the rest of the config', async () => {
      await renderLoaded()

      commitNumber('turnTimeout', '90')
      commitNumber('idleTimeout', '5')

      expect(savedConfigs[1]).toEqual(
        withDispatch({
          defaultModel: first.value,
          allowedModels: [first.value],
          turnTimeoutMs: 5_400_000,
          idleTimeoutMs: 300_000
        })
      )
    })
  })

  /**
   * The two halves edit ONE engine config file, and `saveEngineConfig` REPLACES
   * it — unlike the Remote panes' `setRemoteConfig`, which takes a partial that
   * main merges. So the halves must share one config object, or the second edit
   * is computed against a pre-first-edit copy and silently reverts it on disk.
   *
   * These are the regression pins for that: both halves are on screen together
   * on the real page, so an edit in one must be visible to the other before it
   * saves.
   */
  describe('the two halves share one config', () => {
    it('reads the engine config ONCE for the whole composition', async () => {
      await renderLoaded()
      expect(window.api.loadEngineConfig).toHaveBeenCalledTimes(1)
      expect(window.api.loadEngineConfig).toHaveBeenCalledWith(e.engineId)
    })

    it('a Limits edit after an into edit keeps the new default model', async () => {
      await renderLoaded()

      pickDefaultModel(second.value)
      commitNumber('maxCost', '4')

      expect(savedConfigs).toHaveLength(2)
      // Without a shared config the limits half would still hold the pre-edit
      // copy and write the old default straight back over the choice.
      expect(savedConfigs[1]).toEqual(
        withDispatch({
          defaultModel: second.value,
          allowedModels: [first.value],
          maxCostUsd: 4
        })
      )
    })

    it('an into edit after a Limits edit keeps the cost cap', async () => {
      await renderLoaded()

      commitNumber('maxCost', '4')
      pickDefaultModel(second.value)

      expect(savedConfigs).toHaveLength(2)
      expect(savedConfigs[1].dispatch).toEqual({
        defaultModel: second.value,
        allowedModels: [first.value],
        maxCostUsd: 4
      })
    })

    it('an into edit after Limits edits keeps the timeouts', async () => {
      await renderLoaded()

      commitNumber('turnTimeout', '90')
      commitNumber('idleTimeout', '5')
      fireEvent.click(allowedChip(second.value))

      expect(savedConfigs).toHaveLength(3)
      expect(savedConfigs[2].dispatch).toEqual({
        defaultModel: first.value,
        allowedModels: [first.value, second.value],
        turnTimeoutMs: 5_400_000,
        idleTimeoutMs: 300_000
      })
    })

    it('a chip toggle and a cost cap accumulate in either order', async () => {
      await renderLoaded()

      fireEvent.click(allowedChip(second.value))
      commitNumber('maxCost', '9')

      expect(savedConfigs[1].dispatch).toEqual({
        defaultModel: first.value,
        allowedModels: [first.value, second.value],
        maxCostUsd: 9
      })
    })
  })
})
