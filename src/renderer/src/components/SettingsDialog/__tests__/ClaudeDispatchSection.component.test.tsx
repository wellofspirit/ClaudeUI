/**
 * Layer 2: Component tests for ClaudeDispatchSection (ADR-033 M2-C — Claude-side twin).
 *
 * Only what is specific to the Claude pane lives here. The behaviour it shares
 * with the opencode and pi panes (load, merged saves, the two halves sharing one
 * config, the numeric fields) is `DispatchSection.shared.component.test.tsx`.
 *
 * Claude itself is always installed, but dispatch INTO Claude can only be called
 * FROM another harness, so (ADR-033 M4-A) the dispatch page offers this target
 * only while one of opencode, pi or Codex runs (ADR-082 §8; SettingsDialogView's
 * page test). The section itself never asks.
 *
 * Tested flows:
 *   1. A half-typed maxCost never reaches the file — the field commits on BLUR
 *   2. A long model list collapses behind "Show all N"
 *   3. A fresh mount re-reads the file
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
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

describe('ClaudeDispatchSection — numeric fields', () => {
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

describe('ClaudeDispatchSection — remount', () => {
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
