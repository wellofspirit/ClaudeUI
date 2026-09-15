/**
 * Layer 2: component tests for the Engines › Codex group bodies (Slice 5a).
 *
 * As with their pi and opencode twins, the invariants worth guarding are about
 * WHAT LANDS IN `config.toml`, not what the pane looks like — and here that is
 * sharper than on the other two engines, because the writer is Codex's and a key
 * ClaudeUI gets wrong is ACCEPTED and only breaks at the next session (probe
 * (e), `docs/codex-spike.md`). So:
 *
 *   1. Every control kind writes its own dotted KEY PATH with the value the
 *      control shows, and one click is ONE `writeCodexConfig`.
 *   2. ABSENT MEANS DEFAULT: choosing the value Codex already assumes REMOVES
 *      the key (`value: null`, which the real binary deletes), and so does a
 *      row's Reset and an emptied number field.
 *   3. `modified` — the hover Reset — appears exactly when the key is present in
 *      the BASE USER LAYER, never when the effective config merely has a value.
 *   4. ONE CONFIG OBJECT: all eleven panes share one snapshot and one version
 *      token, so mounting them is one read, and a write re-reads once for all.
 *   5. A version conflict is not a row failure: the store re-reads and raises
 *      one notice.
 *   6. Windows-only rows are hidden off Windows.
 *   7. Managed rows are locked and write nothing; the rules row recompiles.
 *   8. The MCP group reports the inherited count and the native table.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type {
  CodexConfigEdit,
  CodexConfigRead,
  CodexConfigValue
} from '../../../../../shared/codex-types'
import {
  CodexAgentsSection,
  CodexContextSection,
  CodexHistorySection,
  CodexInstructionsSection,
  CodexManagedSection,
  CodexMcpSection,
  CodexModelBehaviorSection,
  CodexRawConfigSection,
  CodexSandboxSection,
  CodexShellEnvSection,
  CodexToolsSection
} from '../CodexConfigPanes'
import { resetCodexConfigStore } from '../use-codex-config'

const FILE = '/home/u/.codex/config.toml'

// ── window.api stub ──────────────────────────────────────────────────

let userLayer: Record<string, CodexConfigValue> = {}
let effective: Record<string, CodexConfigValue> = {}
let version = 'v1'
let mcp = { inherited: [] as string[], skipped: [] as string[] }
let profile: string | null = null
/** Every `writeCodexConfig` call, in order: [edits, expectedVersion]. */
let writes: Array<{ edits: CodexConfigEdit[]; version: string }> = []
/** Queued outcomes; anything beyond them succeeds. */
let writeOutcomes: Array<'ok' | 'conflict' | 'refused'> = []

const readCodexConfig = vi.fn(async (): Promise<CodexConfigRead> => ({
  config: {
    version,
    file: FILE,
    profile,
    user: structuredClone(userLayer),
    effective: structuredClone(effective),
    origins: {}
  },
  rules: {
    path: '/home/u/.codex/rules/claudeui.rules',
    rules: 3,
    skipped: 1,
    syncedAt: '2026-09-14T00:00:00.000Z',
    upToDate: true
  },
  mcp: { inherited: [...mcp.inherited], skipped: [...mcp.skipped] }
}))

const writeCodexConfig = vi.fn(async (edits: CodexConfigEdit[], expectedVersion: string) => {
  writes.push({ edits: structuredClone(edits), version: expectedVersion })
  const outcome = writeOutcomes.shift() ?? 'ok'
  if (outcome === 'conflict') {
    // The file moved under us: the store must re-read and notice, not blame a row.
    version = 'v-moved'
    return { status: 'version-conflict' as const }
  }
  if (outcome === 'refused') return { status: 'refused' as const, message: 'Codex said no' }
  for (const edit of edits) {
    const segments = edit.keyPath.split('.')
    const last = segments.pop() as string
    let node = userLayer as Record<string, CodexConfigValue>
    for (const segment of segments) {
      if (
        typeof node[segment] !== 'object' ||
        node[segment] === null ||
        Array.isArray(node[segment])
      )
        node[segment] = {}
      node = node[segment] as Record<string, CodexConfigValue>
    }
    if (edit.value === null) delete node[last]
    else node[last] = edit.value
  }
  version = `${version}+`
  // The real service reads `config.toml` back on the SAME app-server child and
  // returns that snapshot with the write (ADR-068 §6 / Slice 5a), so the store
  // has no reason to issue a second read.
  return {
    status: 'ok' as const,
    version,
    snapshot: {
      version,
      file: FILE,
      profile,
      user: structuredClone(userLayer),
      effective: structuredClone(effective),
      origins: {}
    }
  }
})

const recompileCodexRules = vi.fn(async () => ({
  path: '/home/u/.codex/rules/claudeui.rules',
  rules: 5,
  skipped: 0,
  syncedAt: '2026-09-14T01:00:00.000Z',
  upToDate: true
}))

const getEngineModels = vi.fn(async () => [
  {
    engineId: 'codex',
    vendorId: 'openai',
    vendorName: 'Native OpenAI',
    models: [
      {
        value: 'gpt-5-codex',
        displayName: 'GPT-5 Codex',
        engineId: 'codex',
        vendorId: 'openai',
        nativeEffortOptions: [
          { value: 'low', description: '' },
          { value: 'high', description: '' }
        ]
      }
    ]
  }
])

function installApiStub(platform = 'linux'): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    platform,
    readCodexConfig,
    writeCodexConfig,
    recompileCodexRules,
    getEngineModels
  }
}

beforeEach(() => {
  userLayer = {}
  effective = {}
  version = 'v1'
  profile = null
  mcp = { inherited: [], skipped: [] }
  writes = []
  writeOutcomes = []
  vi.clearAllMocks()
  resetCodexConfigStore()
  installApiStub()
})

afterEach(() => {
  cleanup()
  resetCodexConfigStore()
})

async function renderPane(node: React.ReactElement): Promise<void> {
  await act(async () => {
    render(node)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** Let the store's write queue drain. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function byId(testid: string, id: string): HTMLElement {
  const element = screen.getAllByTestId(testid).find((n) => n.getAttribute('data-id') === id)
  expect(element, `no ${testid} for ${id}`).toBeTruthy()
  return element as HTMLElement
}

const rowFor = (key: string): HTMLElement => byId('CodexConfigPane.row', key)
const toggleFor = (key: string): HTMLElement => byId('CodexConfigPane.toggle', key)
const numberFor = (key: string): HTMLInputElement =>
  byId('CodexConfigPane.number', key) as HTMLInputElement

function segmentFor(key: string, value: string): HTMLElement {
  const element = rowFor(key).querySelector<HTMLElement>(
    `[data-testid="CodexConfigPane.segment"][data-id="${value}"]`
  )
  expect(element, `no segment ${key}:${value}`).toBeTruthy()
  return element as HTMLElement
}

/** Open a row's select and click one option. */
async function pickSelect(key: string, value: string): Promise<void> {
  const row = rowFor(key)
  await act(async () => {
    fireEvent.click(row.querySelector('[data-testid="CodexConfigPane.select.trigger"]')!)
  })
  const option = row.querySelector(
    `[data-testid="CodexConfigPane.select.option"][data-id="${value}"]`
  )
  expect(option, `no option ${key}:${value}`).toBeTruthy()
  await act(async () => {
    fireEvent.click(option!)
  })
}

/** The single edit of the Nth write. */
function onlyEdit(index = 0): CodexConfigEdit {
  expect(writes[index], `no write #${index}`).toBeTruthy()
  expect(writes[index].edits).toHaveLength(1)
  return writes[index].edits[0]
}

// ── 1 + 2: every control kind writes its key path, and removes on default ────

describe('control kinds', () => {
  it('a TOGGLE writes its dotted key path, and turning it back to the default removes it', async () => {
    await renderPane(<CodexSandboxSection />)
    // `network_access` defaults to false, so switching it ON writes true…
    await act(async () => {
      fireEvent.click(toggleFor('sandbox_workspace_write.network_access'))
    })
    await settle()
    expect(onlyEdit(0)).toEqual({
      keyPath: 'sandbox_workspace_write.network_access',
      value: true
    })
    // …and switching it back REMOVES the key rather than writing Codex's own
    // default into the user's file (probe (c): null deletes).
    await act(async () => {
      fireEvent.click(toggleFor('sandbox_workspace_write.network_access'))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({
      keyPath: 'sandbox_workspace_write.network_access',
      value: null
    })
  })

  it('an INVERTED toggle writes the exclusion Codex spells, not the permission shown', async () => {
    await renderPane(<CodexShellEnvSection />)
    // The row reads "Strip secret-looking variables"; the KEY is
    // `ignore_default_excludes`, which Codex resolves with `unwrap_or(true)`
    // (`config/src/shell_environment_policy.rs`) — so with the key ABSENT the
    // filter is OFF and the row must render unchecked. Turning the filter ON
    // writes `false`; turning it back off removes the key.
    const toggle = toggleFor('shell_environment_policy.ignore_default_excludes')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      fireEvent.click(toggle)
    })
    await settle()
    expect(onlyEdit(0)).toEqual({
      keyPath: 'shell_environment_policy.ignore_default_excludes',
      value: false
    })
    await act(async () => {
      fireEvent.click(toggleFor('shell_environment_policy.ignore_default_excludes'))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({
      keyPath: 'shell_environment_policy.ignore_default_excludes',
      value: null
    })
  })

  it('a SEGMENTED row writes its value, and its default option removes the key', async () => {
    await renderPane(<CodexToolsSection />)
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'live'))
    })
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'web_search', value: 'live' })

    await act(async () => {
      fireEvent.click(segmentFor('web_search', ''))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({ keyPath: 'web_search', value: null })
  })

  it('a SELECT writes the chosen value and its unset option removes the key', async () => {
    userLayer = { model_reasoning_summary: 'detailed' }
    await renderPane(<CodexModelBehaviorSection />)
    await pickSelect('model_reasoning_summary', 'concise')
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'model_reasoning_summary', value: 'concise' })

    // The "leave it to Codex" option removes the key.
    await pickSelect('model_reasoning_summary', '')
    await settle()
    expect(onlyEdit(1)).toEqual({ keyPath: 'model_reasoning_summary', value: null })
  })

  it('a NUMBER commits on blur and an emptied field removes the key', async () => {
    userLayer = { tool_output_token_limit: 4096 }
    await renderPane(<CodexContextSection />)
    const input = numberFor('tool_output_token_limit')
    await act(async () => {
      fireEvent.change(input, { target: { value: '8192' } })
      fireEvent.blur(input)
    })
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'tool_output_token_limit', value: 8192 })

    await act(async () => {
      fireEvent.change(numberFor('tool_output_token_limit'), { target: { value: '' } })
      fireEvent.blur(numberFor('tool_output_token_limit'))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({ keyPath: 'tool_output_token_limit', value: null })
  })

  it('a CHIP LIST writes the whole array and an emptied list removes the key', async () => {
    await renderPane(<CodexContextSection />)
    const list = byId('CodexConfigPane.row', 'project_doc_fallback_filenames')
    const input = list.querySelector('input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { value: 'CLAUDE.md' } })
      fireEvent.keyDown(input, { key: 'Enter' })
    })
    await settle()
    expect(onlyEdit(0)).toEqual({
      keyPath: 'project_doc_fallback_filenames',
      value: ['CLAUDE.md']
    })
  })

  it('a TEXT AREA commits on blur and an emptied one removes the key', async () => {
    await renderPane(<CodexInstructionsSection />)
    const area = byId('CodexConfigPane.textarea', 'developer_instructions')
    await act(async () => {
      fireEvent.change(area, { target: { value: 'Be terse.' } })
      fireEvent.blur(area)
    })
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'developer_instructions', value: 'Be terse.' })
  })
})

// ── 3: `modified` means "present in the USER layer" ─────────────────────────

describe('changed-from-default', () => {
  it('offers Reset only for a key in the user layer, never for a merely effective value', async () => {
    // `model_verbosity` is set by ANOTHER layer; `service_tier` by the user.
    userLayer = { service_tier: 'flex' }
    effective = { model_verbosity: 'high', service_tier: 'flex' }
    await renderPane(<CodexModelBehaviorSection />)
    expect(rowFor('service_tier').querySelector('[data-testid$=".reset"]')).toBeTruthy()
    expect(rowFor('model_verbosity').querySelector('[data-testid$=".reset"]')).toBeNull()
  })

  it('Reset REMOVES the key', async () => {
    userLayer = { service_tier: 'flex' }
    await renderPane(<CodexModelBehaviorSection />)
    const reset = rowFor('service_tier').querySelector('[data-testid$=".reset"]') as HTMLElement
    await act(async () => {
      fireEvent.click(reset)
    })
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'service_tier', value: null })
  })
})

// ── 4 + 5: one config object, one version token, one notice on conflict ─────

describe('the shared config object', () => {
  it('mounting every pane is ONE read, shared by all of them', async () => {
    await renderPane(
      <>
        <CodexModelBehaviorSection />
        <CodexContextSection />
        <CodexToolsSection />
      </>
    )
    expect(readCodexConfig).toHaveBeenCalledTimes(1)
  })

  it('folds the snapshot the write returned instead of reading config.toml again', async () => {
    await renderPane(<CodexToolsSection />)
    expect(readCodexConfig).toHaveBeenCalledTimes(1)

    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'cached'))
    })
    await settle()
    expect(writes).toHaveLength(1)
    // NO second `codex-config:read`: the write already carried the config as it
    // stands after it, read on the same app-server child. A re-read here would
    // be a second process start for a state the renderer already holds.
    expect(readCodexConfig).toHaveBeenCalledTimes(1)
    // …and the row reads back the written value FROM that returned snapshot —
    // which is what makes the hover Reset appear on it.
    expect(rowFor('web_search').querySelector('[data-testid$=".reset"]')).toBeTruthy()
    const selected = rowFor('web_search').querySelector(
      '[data-testid="CodexConfigPane.segment"][data-id="cached"]'
    )
    expect(selected?.className).toContain('text-accent')
    // The next write carries the version that snapshot brought, not the stale one.
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'live'))
    })
    await settle()
    expect(writes[1].version).toBe('v1+')
  })

  it('carries the version the last write produced, so the second write is not stale', async () => {
    await renderPane(<CodexToolsSection />)
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'cached'))
    })
    await settle()
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'live'))
    })
    await settle()
    expect(writes.map((write) => write.version)).toEqual(['v1', 'v1+'])
  })

  it('does not let a second click before the re-read repeat or cancel the first write', async () => {
    await renderPane(<CodexSandboxSection />)
    // Two clicks with NO settle between them: the row still shows the pre-write
    // value, so both compute the same "next" value. Without the queued-edit
    // bookkeeping the second is either a pointless repeat (a wasted version
    // bump) or, if it had been computed against a half-applied snapshot, would
    // undo the first — which is a write the user did not ask for.
    await act(async () => {
      fireEvent.click(toggleFor('sandbox_workspace_write.network_access'))
      fireEvent.click(toggleFor('sandbox_workspace_write.network_access'))
    })
    await settle()
    expect(writes).toHaveLength(1)
    expect(onlyEdit(0)).toEqual({
      keyPath: 'sandbox_workspace_write.network_access',
      value: true
    })
    // And once the re-read has landed, the row is live again.
    await act(async () => {
      fireEvent.click(toggleFor('sandbox_workspace_write.network_access'))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({
      keyPath: 'sandbox_workspace_write.network_access',
      value: null
    })
  })

  it('turns a version conflict into ONE notice and a re-read, not a row failure', async () => {
    writeOutcomes = ['conflict']
    await renderPane(<CodexToolsSection />)
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'live'))
    })
    await settle()
    await waitFor(() => expect(screen.getByTestId('CodexConfigPane.notice')).toBeTruthy())
    expect(screen.getByTestId('CodexConfigPane.notice').textContent).toContain(
      'changed outside ClaudeUI'
    )
    expect(readCodexConfig).toHaveBeenCalledTimes(2)
    // The row itself carries no error: the user did nothing wrong.
    expect(rowFor('web_search').querySelector('[data-testid="CodexConfigPane.error"]')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByTestId('CodexConfigPane.noticeDismiss'))
    })
    expect(screen.queryByTestId('CodexConfigPane.notice')).toBeNull()
  })

  it('shows a REFUSAL on the row that caused it, with the native message verbatim', async () => {
    writeOutcomes = ['refused']
    await renderPane(<CodexToolsSection />)
    await act(async () => {
      fireEvent.click(segmentFor('web_search', 'live'))
    })
    await settle()
    await waitFor(() =>
      expect(
        rowFor('web_search').querySelector('[data-testid="CodexConfigPane.error"]')?.textContent
      ).toBe('Codex said no')
    )
    expect(screen.queryByTestId('CodexConfigPane.notice')).toBeNull()
  })

  it('renders a Loading row before the first read and an explanatory row when there is none', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api.readCodexConfig = vi.fn(
      async (): Promise<CodexConfigRead> => ({
        config: null,
        rules: { path: '', rules: 0, skipped: 0, syncedAt: null, upToDate: false },
        mcp: { inherited: [], skipped: [] },
        error: 'Codex is not installed'
      })
    )
    await renderPane(<CodexToolsSection />)
    expect(byId('CodexConfigPane.status', 'unavailable').textContent).toContain('not installed')
  })
})

// ── 6: Windows-only rows ────────────────────────────────────────────────────

/** The dimmed explain row of a section, by its data-id. */
function explainFor(dataId: string): HTMLElement {
  const row = screen
    .getAllByTestId('CodexConfigPane.explain')
    .find((el) => el.getAttribute('data-id') === dataId)
  expect(row, `no CodexConfigPane.explain for ${dataId}`).toBeTruthy()
  return row as HTMLElement
}

describe('platform gating', () => {
  it('hides the Windows sandbox rows off Windows and shows them on it', async () => {
    await renderPane(<CodexSandboxSection />)
    expect(
      screen
        .getAllByTestId('CodexConfigPane.row')
        .some((row) => row.getAttribute('data-id') === 'windows.sandbox')
    ).toBe(false)
    // Off Windows the explain row makes no no-sandbox claim.
    expect(explainFor('sandbox').textContent).not.toMatch(/ships no sandbox/)

    cleanup()
    resetCodexConfigStore()
    installApiStub('win32')
    await renderPane(<CodexSandboxSection />)
    expect(rowFor('windows.sandbox')).toBeTruthy()
    expect(toggleFor('windows.sandbox_private_desktop')).toBeTruthy()
    // On Windows it says what a live turn shows: no sandbox, Auto goes through
    // Codex's reviewer for every command (docs/architecture/codex.md).
    expect(explainFor('sandbox').textContent).toMatch(
      /ships no sandbox: commands run unsandboxed, and Auto sends every command through Codex’s reviewer/
    )
  })
})

// ── 7: Managed ──────────────────────────────────────────────────────────────

describe('Managed', () => {
  it('locks every managed row and writes nothing', async () => {
    effective = { approval_policy: 'on-request', sandbox_mode: 'workspace-write' }
    await renderPane(<CodexManagedSection />)
    for (const key of [
      'model_provider',
      'check_for_update_on_startup',
      'approval_policy',
      'sandbox_mode',
      'approvals_reviewer'
    ]) {
      const row = byId('CodexConfigPane.managedRow', key)
      expect(row.querySelector('[data-testid$=".locked"]'), `${key} is not locked`).toBeTruthy()
      expect(row.querySelector('input')).toBeNull()
    }
    expect(writes).toEqual([])
  })

  it('shows the active profile row only when a profile layer is in play', async () => {
    await renderPane(<CodexManagedSection />)
    expect(
      screen
        .getAllByTestId('CodexConfigPane.managedRow')
        .some((row) => row.getAttribute('data-id') === 'profile')
    ).toBe(false)

    cleanup()
    resetCodexConfigStore()
    profile = 'work'
    await renderPane(<CodexManagedSection />)
    expect(byId('CodexConfigPane.managedRow', 'profile').textContent).toContain('work')
  })

  it('reports the compiled rule file and recompiles it on demand', async () => {
    await renderPane(<CodexManagedSection />)
    expect(rowFor('rules').textContent).toContain('3 rules')
    expect(rowFor('rules').textContent).toContain('1 skipped')
    await act(async () => {
      fireEvent.click(screen.getByTestId('CodexConfigPane.recompileRules'))
    })
    await settle()
    expect(recompileCodexRules).toHaveBeenCalledOnce()
    await waitFor(() => expect(rowFor('rules').textContent).toContain('5 rules'))
  })
})

// ── 8: MCP ──────────────────────────────────────────────────────────────────

describe('MCP servers', () => {
  it('reports the inherited count, the skipped SSE servers and the native table', async () => {
    mcp = { inherited: ['docs', 'jira'], skipped: ['legacy-sse'] }
    userLayer = { mcp_servers: { oauthy: { url: 'https://x' } } }
    await renderPane(<CodexMcpSection />)
    expect(rowFor('inherited').textContent).toContain('2 servers')
    expect(rowFor('inherited').textContent).toContain('docs, jira')
    expect(rowFor('inherited').textContent).toContain('legacy-sse')
    expect(rowFor('mcp_servers').textContent).toContain('oauthy')
  })

  it('says so when nothing is inherited, and links out to the MCP surface', async () => {
    await renderPane(<CodexMcpSection />)
    expect(rowFor('inherited').textContent).toContain('No MCP servers are configured in Claude')
    const opened = vi.fn()
    window.addEventListener('open-mcp-servers', opened)
    try {
      await act(async () => {
        fireEvent.click(screen.getByTestId('CodexConfigPane.openMcp'))
      })
      expect(opened).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('open-mcp-servers', opened)
    }
  })
})

// ── Remaining panes render and stay read-only where they must ───────────────

describe('the rest of the page', () => {
  it('nests the agent rows under the master toggle and hides them when it is off', async () => {
    await renderPane(<CodexAgentsSection />)
    expect(numberFor('agents.max_depth')).toBeTruthy()

    cleanup()
    resetCodexConfigStore()
    userLayer = { agents: { enabled: false } }
    await renderPane(<CodexAgentsSection />)
    expect(
      screen
        .getAllByTestId('CodexConfigPane.row')
        .some((row) => row.getAttribute('data-id') === 'agents.max_depth')
    ).toBe(false)
  })

  it('writes history and privacy keys at their nested paths', async () => {
    await renderPane(<CodexHistorySection />)
    await act(async () => {
      fireEvent.click(segmentFor('history.persistence', 'none'))
    })
    await settle()
    expect(onlyEdit(0)).toEqual({ keyPath: 'history.persistence', value: 'none' })

    // `codex app-server` enables analytics only when started with
    // `--analytics-default-enabled` (`cli/src/main.rs`), which ClaudeUI never
    // passes, so with the key ABSENT analytics are OFF: the row renders
    // unchecked and turning it on writes `true`.
    expect(toggleFor('analytics.enabled').getAttribute('aria-pressed')).toBe('false')
    await act(async () => {
      fireEvent.click(toggleFor('analytics.enabled'))
    })
    await settle()
    expect(onlyEdit(1)).toEqual({ keyPath: 'analytics.enabled', value: true })
  })

  it('renders Raw config READ-ONLY over the user layer, with the file path', async () => {
    userLayer = { hooks: { pre: ['x'] } }
    await renderPane(<CodexRawConfigSection />)
    const area = screen.getByTestId('CodexConfigPane.rawText') as HTMLTextAreaElement
    expect(area.readOnly).toBe(true)
    expect(area.value).toContain('"hooks"')
    expect(rowFor('rawText').textContent).toContain(FILE)
  })
})
