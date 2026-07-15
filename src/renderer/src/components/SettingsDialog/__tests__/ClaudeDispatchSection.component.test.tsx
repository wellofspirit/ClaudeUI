/**
 * Layer 2: Component tests for ClaudeDispatchSection (ADR-033 M2-C — Claude-side twin).
 *
 * Mirrors OpencodeDispatchSection.component.test.tsx. Claude itself is always
 * installed, but dispatch INTO Claude can only be called FROM opencode, so
 * (ADR-033 M4-A) this section gates on the same opencode-installed probe as
 * the opencode twin — hence the gated-states tests below, unlike the earlier
 * M2-C revision of this file.
 *
 * Tested flows:
 *   1. Gated states: loading (probes pending) and not-installed (no opencode)
 *   2. Load renders the current dispatch config (select value + row states),
 *      filtered to Claude models only (opencode models excluded)
 *   3. Editing the default model saves the FULL merged EngineConfig —
 *      sandbox / proxy / other fields must not be clobbered
 *   4. "(not set)" clears defaultModel (undefined, not '')
 *   5. Toggling an allowed model on/off; last-off drops the allowedModels key
 *   6. maxCost input round-trips through the merged save (ADR-033 M4-C)
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
    models: [
      { value: 'openai/gpt-5', displayName: 'GPT-5', description: '', engineId: 'opencode' }
    ]
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
  await waitFor(() =>
    expect(screen.getByTestId('ClaudeDispatchSection.defaultModel')).toBeTruthy()
  )
}

function allowedRow(modelValue: string): HTMLElement {
  const row = screen
    .getAllByTestId('ClaudeDispatchSection.allowedModel')
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

    const select = screen.getByTestId('ClaudeDispatchSection.defaultModel') as HTMLSelectElement
    expect(select.value).toBe('sonnet')

    // Only Claude-engine models appear (the opencode group is filtered out),
    // plus the "(not set)" empty option.
    const optionValues = [...select.options].map((o) => o.value)
    expect(optionValues).toEqual(['', 'sonnet', 'haiku'])

    // One allowed-model row per Claude model, discriminated by data-id.
    const rows = screen.getAllByTestId('ClaudeDispatchSection.allowedModel')
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['sonnet', 'haiku'])
  })
})

describe('ClaudeDispatchSection — saves merge, never clobber', () => {
  it('changing the default model saves the FULL config with sandbox/proxy and allowedModels intact', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.defaultModel'), {
      target: { value: 'haiku' }
    })

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

    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.defaultModel'), {
      target: { value: '' }
    })

    expect(savedConfigs[0].dispatch?.defaultModel).toBeUndefined()
    expect(savedConfigs[0].dispatch?.allowedModels).toEqual(['sonnet'])
    expect(savedConfigs[0].sandbox).toEqual(BASE_CONFIG.sandbox)
    expect(savedConfigs[0].proxy).toEqual(BASE_CONFIG.proxy)
  })

  it('toggling a model ON appends it to allowedModels (sandbox/proxy intact)', async () => {
    await renderLoaded()

    fireEvent.click(allowedRow('haiku'))

    expect(savedConfigs[0]).toEqual({
      sandbox: { mode: 'workspace-write' },
      proxy: { enabled: true },
      dispatch: { defaultModel: 'sonnet', allowedModels: ['sonnet', 'haiku'] }
    })
  })

  it('toggling the LAST model OFF drops the allowedModels key (empty = all allowed)', async () => {
    await renderLoaded()

    fireEvent.click(allowedRow('sonnet'))

    expect(savedConfigs[0].dispatch?.allowedModels).toBeUndefined()
    expect(savedConfigs[0].dispatch?.defaultModel).toBe('sonnet')
    expect(savedConfigs[0].sandbox).toEqual(BASE_CONFIG.sandbox)
    expect(savedConfigs[0].proxy).toEqual(BASE_CONFIG.proxy)
  })

  it('sequential edits accumulate on local state (second save includes the first edit)', async () => {
    await renderLoaded()

    fireEvent.click(allowedRow('haiku'))
    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.defaultModel'), {
      target: { value: 'haiku' }
    })

    expect(savedConfigs).toHaveLength(2)
    expect(savedConfigs[1].dispatch).toEqual({
      defaultModel: 'haiku',
      allowedModels: ['sonnet', 'haiku']
    })
  })

  it('setting maxCost saves it alongside the rest, sandbox/proxy intact (ADR-033 M4-C)', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.maxCost'), {
      target: { value: '2.5' }
    })

    expect(savedConfigs[0]).toEqual({
      sandbox: { mode: 'workspace-write' },
      proxy: { enabled: true },
      dispatch: { defaultModel: 'sonnet', allowedModels: ['sonnet'], maxCostUsd: 2.5 }
    })
  })

  it('clearing maxCost drops the key (undefined = no cap)', async () => {
    await renderLoaded()

    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.maxCost'), {
      target: { value: '2.5' }
    })
    fireEvent.change(screen.getByTestId('ClaudeDispatchSection.maxCost'), {
      target: { value: '' }
    })

    expect(savedConfigs[1].dispatch?.maxCostUsd).toBeUndefined()
    expect(savedConfigs[1].dispatch?.defaultModel).toBe('sonnet')
  })
})
