/**
 * Layer 2: Component tests for OpencodeDispatchSection (ADR-033 Slice C).
 *
 * Only the numeric-field edge cases live here. Loading, the merged saves, the
 * chip set and the two halves sharing one config are the same implementation as
 * the Claude and pi panes and are tested once, for all three, in
 * `DispatchSection.shared.component.test.tsx`.
 *
 * ADR-082 §8: an opencode that does not run is greyed in the page's segment,
 * never in this section.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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

/**
 * The turn/inactivity watchdog knobs (ADR-033's 2026-09-01 amendment). Edited
 * in MINUTES, stored in MILLISECONDS; blank = no limit, 0 = disabled. That
 * a commit writes milliseconds into the merged config is asserted for every
 * engine in DispatchSection.shared.component.test.tsx.
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
    // The placeholder is what an EMPTY field means (ADR-065's number-with-unit)
    // — and since ADR-033's 2026-09-18 amendment that is NO LIMIT, in every
    // direction, rather than a built-in 60/15 minutes.
    expect(turn.placeholder).toBe('no limit')
    expect(idle.placeholder).toBe('no limit')
    expect(screen.getByTestId('OpencodeDispatchSection.turnTimeoutRow').textContent).toContain(
      'min'
    )
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
