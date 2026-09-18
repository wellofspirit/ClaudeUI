/**
 * Layer 2: the three Codex segments that live on TOPIC pages, not on the Codex
 * engine page (ADR-068 §6, Slice 5b).
 *
 * Each one writes to a different store, and getting the store wrong is the
 * failure that does not show up in a screenshot:
 *
 *  1. **Default models › Codex** writes `codexConfig` into `engines/codex.json`
 *     — ClaudeUI's own default for a session it starts, NOT the `model` key on
 *     the Codex page (which is Codex's file). It shares the Dispatch page's
 *     config OBJECT for that file, because `saveEngineConfig` replaces the whole
 *     file and a settings SEARCH can mount both panes at once (ADR-065).
 *  2. **Cross-engine dispatch › Codex** writes `#dispatch` in the same file —
 *     the block `resolveAndRunCodex` has read since ADR-033 slice H.
 *  3. **Auto-mode judge › Codex** writes `auto_review.policy` in Codex's own
 *     `config.toml`, through Slice 5a's `config/batchWrite` store. The key was
 *     checked against `config/src/config_toml.rs` (`AutoReviewToml.policy:
 *     Option<String>`) because `batchWrite` accepts an unknown key silently and
 *     only breaks the next session (probe (e), `docs/codex-spike.md`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import type { EngineConfig, EngineModelGroup } from '../../../../../shared/types'
import type {
  CodexConfigEdit,
  CodexConfigRead,
  CodexConfigValue
} from '../../../../../shared/codex-types'
import {
  CodexDefaultsSection,
  CodexDispatchIntoSection,
  CodexDispatchLimitsSection,
  SECTIONS
} from '../settings-sections'
import { CodexAutoReviewSection } from '../CodexConfigPanes'
import { resetCodexConfigStore } from '../use-codex-config'
import { useSessionStore } from '../../../stores/session-store'

// ── Fixtures ─────────────────────────────────────────────────────────

const MODEL_GROUPS: EngineModelGroup[] = [
  {
    engineId: 'codex',
    vendorId: 'openai',
    vendorName: 'Native OpenAI',
    models: [
      {
        value: 'gpt-5.6-codex',
        displayName: 'GPT-5.6-Codex',
        description: '',
        engineId: 'codex',
        vendorId: 'openai',
        nativeEffortOptions: [
          { value: 'medium', description: '' },
          { value: 'high', description: '' },
          { value: 'xhigh', description: '' }
        ]
      },
      {
        value: 'gpt-5.6-codex-mini',
        displayName: 'GPT-5.6-Codex-mini',
        description: '',
        engineId: 'codex',
        vendorId: 'openai',
        nativeEffortOptions: [{ value: 'medium', description: '' }]
      }
    ]
  },
  // A pi group that must be filtered OUT of the Codex pickers.
  {
    engineId: 'pi',
    vendorId: 'openai-codex',
    vendorName: 'ChatGPT',
    models: [
      { value: 'openai-codex/gpt-5.4', displayName: 'GPT-5.4', description: '', engineId: 'pi' }
    ]
  }
]

/** Saved config with a sibling block that must survive every write. */
const BASE_CONFIG: EngineConfig = {
  autoMode: { enabled: true },
  dispatch: { defaultModel: 'gpt-5.6-codex', maxCostUsd: 2 },
  codexConfig: { defaultModel: 'gpt-5.6-codex', defaultEffort: 'high' }
}

let saved: EngineConfig[] = []
let onDisk: EngineConfig = BASE_CONFIG
const saveEngineConfig = vi.fn(async (_engineId: string, cfg: EngineConfig) => {
  saved.push(structuredClone(cfg))
})
const loadEngineConfig = vi.fn(async () => structuredClone(onDisk))
const engineIsInstalled = vi.fn(async () => true)
const getEngineModels = vi.fn(async () => MODEL_GROUPS)

// ── Codex config.toml stub (Slice 5a's store) ────────────────────────

let userLayer: Record<string, CodexConfigValue> = {}
let writes: Array<{ edits: CodexConfigEdit[]; version: string }> = []
const readCodexConfig = vi.fn(async (): Promise<CodexConfigRead> => ({
  config: {
    version: 'v1',
    file: '/home/u/.codex/config.toml',
    profile: null,
    user: structuredClone(userLayer),
    effective: {},
    origins: {}
  },
  rules: { path: '', rules: 0, skipped: 0, syncedAt: null, upToDate: true },
  mcp: { inherited: [], skipped: [] }
}))
const writeCodexConfig = vi.fn(async (edits: CodexConfigEdit[], expectedVersion: string) => {
  writes.push({ edits: structuredClone(edits), version: expectedVersion })
  return {
    status: 'ok' as const,
    version: 'v2',
    snapshot: {
      version: 'v2',
      file: '/home/u/.codex/config.toml',
      profile: null,
      user: {},
      effective: {},
      origins: {}
    }
  }
})

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform: 'linux',
    engineIsInstalled,
    loadEngineConfig,
    saveEngineConfig,
    getEngineModels,
    readCodexConfig,
    writeCodexConfig,
    recompileCodexRules: vi.fn(),
    ...overrides
  }
}

beforeEach(() => {
  saved = []
  writes = []
  userLayer = {}
  onDisk = structuredClone(BASE_CONFIG)
  vi.clearAllMocks()
  resetCodexConfigStore()
  installApiStub()
  useSessionStore.setState({
    codexDefaultModel: '',
    codexDefaultModelConfigured: false,
    codexDefaultEffort: ''
  })
})

afterEach(() => {
  cleanup()
  resetCodexConfigStore()
})

function pickModel(fieldTestid: string, value: string): void {
  const field = screen.getByTestId(fieldTestid)
  fireEvent.click(within(field).getByTestId('ModelPicker.trigger'))
  const option = within(field)
    .getAllByTestId('ModelPicker.option')
    .find((o) => o.getAttribute('data-value') === value)
  expect(option, `ModelPicker option "${value}"`).toBeTruthy()
  fireEvent.click(option!)
}

// ── 1. Default models › Codex ────────────────────────────────────────

describe('CodexDefaultsSection — engines/codex.json#codexConfig', () => {
  it('writes the picked model into codexConfig and keeps every sibling block', async () => {
    render(<CodexDefaultsSection />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexDefaultsSection.defaultModel')).toBeTruthy()
    )
    pickModel('CodexDefaultsSection.defaultModel', 'gpt-5.6-codex-mini')
    await waitFor(() => expect(saved.length).toBe(1))
    expect(saveEngineConfig.mock.calls[0][0]).toBe('codex')
    expect(saved[0].codexConfig).toEqual({
      defaultModel: 'gpt-5.6-codex-mini',
      defaultEffort: 'high'
    })
    expect(saved[0].dispatch).toEqual(BASE_CONFIG.dispatch)
    expect(saved[0].autoMode).toEqual(BASE_CONFIG.autoMode)
  })

  it('mirrors the pick into the store so the NEXT session picks it up (no restart)', async () => {
    render(<CodexDefaultsSection />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexDefaultsSection.defaultModel')).toBeTruthy()
    )
    pickModel('CodexDefaultsSection.defaultModel', 'gpt-5.6-codex-mini')
    await waitFor(() =>
      expect(useSessionStore.getState().codexDefaultModel).toBe('gpt-5.6-codex-mini')
    )
    expect(useSessionStore.getState().codexDefaultModelConfigured).toBe(true)
  })

  it('offers only the tiers the CHOSEN model publishes, and removes the key on Reset', async () => {
    render(<CodexDefaultsSection />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexDefaultsSection.defaultEffort')).toBeTruthy()
    )
    const select = screen.getByTestId('CodexDefaultsSection.defaultEffort')
    // gpt-5.6-codex publishes medium/high/xhigh. `gpt-5.6-codex-mini`'s tiers
    // must not appear just because the catalog holds them.
    fireEvent.click(
      select.querySelector('[data-testid="CodexDefaultsSection.defaultEffort.trigger"]')!
    )
    const options = Array.from(
      select.querySelectorAll('[data-testid="CodexDefaultsSection.defaultEffort.option"]')
    )
    expect(options.map((o) => o.getAttribute('data-id'))).toEqual(['', 'medium', 'high', 'xhigh'])
    fireEvent.click(options[0])
    await waitFor(() => expect(saved.length).toBe(1))
    // Blank is a REMOVAL, not `defaultEffort: ''`.
    expect(saved[0].codexConfig).toEqual({ defaultModel: 'gpt-5.6-codex' })
  })

  it('warns when the saved tier is not one the chosen model publishes', async () => {
    onDisk = { codexConfig: { defaultModel: 'gpt-5.6-codex-mini', defaultEffort: 'xhigh' } }
    render(<CodexDefaultsSection />)
    await waitFor(() => expect(screen.getByTestId('CodexDefaultsSection.staleEffort')).toBeTruthy())
    expect(screen.getByTestId('CodexDefaultsSection.staleEffort').textContent).toContain('xhigh')
  })

  it('renders the not-installed row instead of a picker when Codex is absent', async () => {
    installApiStub({ engineIsInstalled: vi.fn(async () => false) })
    render(<CodexDefaultsSection />)
    await waitFor(() =>
      expect(screen.getByTestId('CodexDefaultsSection.status').getAttribute('data-id')).toBe(
        'not-installed'
      )
    )
    expect(screen.queryByTestId('CodexDefaultsSection.defaultModel')).toBeNull()
  })
})

// ── 2. Cross-engine dispatch › Codex ─────────────────────────────────

describe('CodexDispatchIntoSection / Limits — engines/codex.json#dispatch', () => {
  it('writes the dispatch block and leaves codexConfig alone', async () => {
    render(
      <>
        <CodexDispatchIntoSection />
        <CodexDispatchLimitsSection />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('CodexDispatchSection.defaultModel')).toBeTruthy()
    )
    pickModel('CodexDispatchSection.defaultModel', 'gpt-5.6-codex-mini')
    await waitFor(() => expect(saved.length).toBe(1))
    expect(saved[0].dispatch?.defaultModel).toBe('gpt-5.6-codex-mini')
    expect(saved[0].codexConfig).toEqual(BASE_CONFIG.codexConfig)

    const cost = screen.getByTestId('CodexDispatchSection.maxCost')
    fireEvent.change(cost, { target: { value: '7' } })
    fireEvent.blur(cost)
    await waitFor(() => expect(saved.length).toBe(2))
    // Computed against the FIRST edit, not against the on-disk snapshot.
    expect(saved[1].dispatch).toEqual({ defaultModel: 'gpt-5.6-codex-mini', maxCostUsd: 7 })
  })

  it('draws the turn/idle timeouts with "no limit" placeholders (ADR-033 2026-09-18)', async () => {
    render(<CodexDispatchLimitsSection />)
    await waitFor(() => expect(screen.getByTestId('CodexDispatchSection.maxCost')).toBeTruthy())
    expect(
      (screen.getByTestId('CodexDispatchSection.turnTimeout') as HTMLInputElement).placeholder
    ).toBe('no limit')
    expect(
      (screen.getByTestId('CodexDispatchSection.idleTimeout') as HTMLInputElement).placeholder
    ).toBe('no limit')
  })

  it('shares ONE config object with the Default-models segment', async () => {
    // Both panes over one file: mounting them is one read, and the second save
    // must carry the first's block. With per-pane copies the model pick below
    // would be erased by the dispatch save that follows it.
    render(
      <>
        <CodexDefaultsSection />
        <CodexDispatchIntoSection />
      </>
    )
    await waitFor(() =>
      expect(screen.getByTestId('CodexDefaultsSection.defaultModel')).toBeTruthy()
    )
    expect(loadEngineConfig).toHaveBeenCalledTimes(1)
    pickModel('CodexDefaultsSection.defaultModel', 'gpt-5.6-codex-mini')
    await waitFor(() => expect(saved.length).toBe(1))
    pickModel('CodexDispatchSection.defaultModel', 'gpt-5.6-codex-mini')
    await waitFor(() => expect(saved.length).toBe(2))
    expect(saved[1].codexConfig?.defaultModel).toBe('gpt-5.6-codex-mini')
    expect(saved[1].dispatch?.defaultModel).toBe('gpt-5.6-codex-mini')
  })
})

// ── 3. Auto-mode judge › Codex ───────────────────────────────────────

describe('CodexAutoReviewSection — config.toml auto_review.policy', () => {
  async function renderPane(): Promise<void> {
    await act(async () => {
      render(<CodexAutoReviewSection />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }

  it('writes ONE batchWrite at keyPath auto_review.policy', async () => {
    await renderPane()
    const area = screen
      .getAllByTestId('CodexConfigPane.textarea')
      .find((n) => n.getAttribute('data-id') === 'auto_review.policy') as HTMLTextAreaElement
    expect(area).toBeTruthy()
    fireEvent.change(area, { target: { value: 'Never approve rm -rf.' } })
    fireEvent.blur(area)
    await settle()
    expect(writes).toHaveLength(1)
    expect(writes[0].edits).toEqual([
      { keyPath: 'auto_review.policy', value: 'Never approve rm -rf.' }
    ])
    expect(writes[0].version).toBe('v1')
  })

  it('emptying the field REMOVES the key (value: null)', async () => {
    userLayer = { auto_review: { policy: 'Old policy.' } }
    await renderPane()
    const area = screen
      .getAllByTestId('CodexConfigPane.textarea')
      .find((n) => n.getAttribute('data-id') === 'auto_review.policy') as HTMLTextAreaElement
    expect(area.value).toBe('Old policy.')
    fireEvent.change(area, { target: { value: '   ' } })
    fireEvent.blur(area)
    await settle()
    expect(writes[0].edits).toEqual([{ keyPath: 'auto_review.policy', value: null }])
  })

  it('shows the guardian as a locked NATIVE row with no judge-model picker', async () => {
    await renderPane()
    const managed = screen
      .getAllByTestId('CodexConfigPane.managedRow')
      .find((n) => n.getAttribute('data-id') === 'approvals_reviewer')
    expect(managed).toBeTruthy()
    expect(managed!.textContent).toContain('Guardian')
    expect(within(managed!).getByTestId('CodexConfigPane.managedRow.locked').textContent).toContain(
      'Native'
    )
    expect(screen.queryByTestId('ModelPicker.trigger')).toBeNull()
  })
})

// ── 4. Sessions & autonomy › Permissions ─────────────────────────────

describe('Permission rules row — the Codex chip and the compiled-rules sentence', () => {
  /** The `globalPermissions` item, rendered exactly as the page mounts it. */
  function renderRow(): React.JSX.Element {
    const item = SECTIONS.find((s) => s.id === 'permissions')!.items.find(
      (i) => i.key === 'globalPermissions'
    )!
    return item.render(
      {} as never,
      () => {},
      {},
      () => {},
      {} as never,
      () => {}
    ) as React.JSX.Element
  }

  it('names Codex alongside Claude and says where the rules are compiled', async () => {
    installApiStub({ loadClaudePermissions: vi.fn(async () => null) })
    render(renderRow())
    await waitFor(() =>
      expect(screen.getAllByTestId('GlobalPermissionsSummary.engine')).toHaveLength(2)
    )
    expect(
      screen.getAllByTestId('GlobalPermissionsSummary.engine').map((c) => c.getAttribute('data-id'))
    ).toEqual(['claude', 'codex'])
    expect(screen.getByTestId('GlobalPermissionsSummary.codexRules').textContent).toContain(
      '~/.codex/rules/claudeui.rules'
    )
  })

  it('stays Claude-only when Codex is not installed — the file is never written then', async () => {
    // `syncCodexRulesFile` refuses to compile without the binary
    // (`codexBinaryAvailable()`), so the chip would advertise a file that does
    // not exist.
    installApiStub({
      loadClaudePermissions: vi.fn(async () => null),
      engineIsInstalled: vi.fn(async () => false)
    })
    render(renderRow())
    await waitFor(() =>
      expect(screen.getAllByTestId('GlobalPermissionsSummary.engine')).toHaveLength(1)
    )
    expect(screen.queryByTestId('GlobalPermissionsSummary.codexRules')).toBeNull()
  })
})
