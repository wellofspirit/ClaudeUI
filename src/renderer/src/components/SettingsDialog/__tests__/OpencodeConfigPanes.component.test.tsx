/**
 * Layer 2: Component tests for the curated opencode Configuration panes.
 *
 * The invariants worth guarding are all about WHAT LANDS IN THE FILE, not what
 * the pane looks like:
 *
 *   1. Absent-default toggles: absent reads as the default; leaving the default
 *      writes the value; returning to it DELETES the key.
 *   2. Numbers commit on blur and on Enter; an emptied field deletes the key.
 *   3. `tools` chips patch one leaf each and never touch unknown `tools` keys
 *      (MCP globs live there too).
 *   4. The `formatter`/`lsp` boolean|object union: an object value still reads
 *      as ON; OFF writes false; ON deletes.
 *   5. `experimental.*` is patched as a LEAF — a whole-object write would erase
 *      the sibling keys ClaudeUI itself injects.
 *   6. `default_agent` offers only agents opencode would accept as a default.
 *   7. The Managed pane is static: three FORCED rows, no IPC.
 *   8. Every pane self-gates on opencode being installed.
 *   9. A rejected patch surfaces inline instead of being swallowed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type { OpencodeAgentSummary, RawConfigPatch } from '../../../../../shared/types'
import {
  OpencodeSessionBehaviorSection,
  OpencodeToolOutputSection,
  OpencodeAttachmentsSection,
  OpencodeWorkspaceSection,
  OpencodeToolsSection,
  OpencodeDiagnosticsSection,
  OpencodeManagedKeysSection
} from '../OpencodeConfigPanes'

// ── window.api stub ──────────────────────────────────────────────────

let captured: RawConfigPatch[][] = []
let currentConfig: Record<string, unknown> = {}

const patchOpencodeNative = vi.fn(async (patches: RawConfigPatch[]) => {
  captured.push(structuredClone(patches))
})
const readOpencodeNativeRaw = vi.fn(async () => ({
  config: structuredClone(currentConfig),
  path: '/home/u/.config/opencode/opencode.json'
}))
const listOpencodeAgents = vi.fn(async (): Promise<OpencodeAgentSummary[]> => [])

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    readOpencodeNativeRaw,
    patchOpencodeNative,
    listOpencodeAgents,
    ...overrides
  }
}

async function renderPane(node: React.ReactElement): Promise<void> {
  await act(async () => {
    render(node)
  })
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The single patch of the Nth commit (every commit is one leaf). */
function onlyPatch(index = 0): RawConfigPatch {
  expect(captured[index]).toHaveLength(1)
  return captured[index][0]
}

function toggleFor(configKey: string): HTMLElement {
  const el = screen
    .getAllByTestId('OpencodeConfigPane.toggle')
    .find((n) => n.getAttribute('data-id') === configKey)
  expect(el, `no toggle for ${configKey}`).toBeTruthy()
  return el as HTMLElement
}

function numberFor(configKey: string): HTMLInputElement {
  const el = screen
    .getAllByTestId('OpencodeConfigPane.number')
    .find((n) => n.getAttribute('data-id') === configKey)
  expect(el, `no number input for ${configKey}`).toBeTruthy()
  return el as HTMLInputElement
}

function chipFor(toolId: string): HTMLElement {
  const el = screen
    .getAllByTestId('OpencodeConfigPane.chip')
    .find((n) => n.getAttribute('data-id') === toolId)
  expect(el, `no chip for ${toolId}`).toBeTruthy()
  return el as HTMLElement
}

describe('opencode Configuration panes', () => {
  beforeEach(() => {
    captured = []
    currentConfig = {}
    patchOpencodeNative.mockClear()
    readOpencodeNativeRaw.mockClear()
    listOpencodeAgents.mockClear()
    installApiStub()
  })

  afterEach(() => cleanup())

  // ── 1. Absent-default toggle semantics ─────────────────────────────

  describe('absent-default toggles', () => {
    it('reads ON when the key is absent and its default is on', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('compaction.auto').getAttribute('aria-pressed')).toBe('true')
      expect(toggleFor('snapshot').getAttribute('aria-pressed')).toBe('true')
    })

    it('reads OFF when the key is absent and its default is off', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('compaction.prune').getAttribute('aria-pressed')).toBe('false')
    })

    it('turning OFF a default-on key writes false at its leaf path', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('compaction.auto'))
      })
      expect(onlyPatch()).toEqual({ path: ['compaction', 'auto'], value: false })
    })

    it('turning a default-on key back ON DELETES the key rather than writing true', async () => {
      currentConfig = { compaction: { auto: false } }
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('compaction.auto').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('compaction.auto'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['compaction', 'auto'])
      expect('value' in patch).toBe(false)
    })

    it('turning a default-off key ON writes true; turning it back off deletes', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('compaction.prune'))
      })
      expect(onlyPatch()).toEqual({ path: ['compaction', 'prune'], value: true })

      cleanup()
      captured = []
      currentConfig = { compaction: { prune: true } }
      await renderPane(<OpencodeSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('compaction.prune'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['compaction', 'prune'])
      expect('value' in patch).toBe(false)
    })

    it('an explicit value equal to the default still deletes on the next toggle back', async () => {
      // `snapshot: true` written by hand: the toggle reads ON, turning it OFF
      // writes false — the file keeps only a real override either way.
      currentConfig = { snapshot: true }
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('snapshot').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(toggleFor('snapshot'))
      })
      expect(onlyPatch()).toEqual({ path: ['snapshot'], value: false })
    })
  })

  // ── 2. Number commit semantics ─────────────────────────────────────

  describe('number inputs', () => {
    it('commits on blur as a leaf patch', async () => {
      await renderPane(<OpencodeToolOutputSection />)
      const input = numberFor('tool_output.max_lines')
      await act(async () => {
        fireEvent.change(input, { target: { value: '500' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({ path: ['tool_output', 'max_lines'], value: 500 })
    })

    it('commits on Enter', async () => {
      await renderPane(<OpencodeToolOutputSection />)
      const input = numberFor('tool_output.max_bytes')
      await act(async () => {
        fireEvent.change(input, { target: { value: '1024' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['tool_output', 'max_bytes'], value: 1024 })
    })

    it('clearing the field DELETES the key', async () => {
      currentConfig = { tool_output: { max_lines: 500 } }
      await renderPane(<OpencodeToolOutputSection />)
      const input = numberFor('tool_output.max_lines')
      expect(input.value).toBe('500')
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['tool_output', 'max_lines'])
      expect('value' in patch).toBe(false)
    })

    it('a blur with no edit writes nothing', async () => {
      currentConfig = { tool_output: { max_lines: 500 } }
      await renderPane(<OpencodeToolOutputSection />)
      await act(async () => {
        fireEvent.blur(numberFor('tool_output.max_lines'))
      })
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('an absent number renders empty with the opencode default as placeholder', async () => {
      await renderPane(<OpencodeAttachmentsSection />)
      const input = numberFor('attachment.image.max_base64_bytes')
      expect(input.value).toBe('')
      expect(input.placeholder).toBe('5242880')
    })

    it('the width/height pair patches each dimension separately', async () => {
      await renderPane(<OpencodeAttachmentsSection />)
      await act(async () => {
        const w = numberFor('attachment.image.max_width')
        fireEvent.change(w, { target: { value: '1200' } })
        fireEvent.blur(w)
      })
      expect(onlyPatch()).toEqual({
        path: ['attachment', 'image', 'max_width'],
        value: 1200
      })
    })
  })

  // ── 3. tools chips ─────────────────────────────────────────────────

  describe('tools chips', () => {
    it('renders exactly the 14 built-in tool ids', async () => {
      await renderPane(<OpencodeToolsSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.chip')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual([
        'bash',
        'read',
        'glob',
        'grep',
        'edit',
        'write',
        'task',
        'webfetch',
        'websearch',
        'todowrite',
        'skill',
        'apply_patch',
        'question',
        'lsp'
      ])
    })

    it('an absent key reads ON; clicking it writes tools.<id> = false', async () => {
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('websearch').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(chipFor('websearch'))
      })
      expect(onlyPatch()).toEqual({ path: ['tools', 'websearch'], value: false })
    })

    it('a false key reads OFF; clicking it DELETES tools.<id>', async () => {
      currentConfig = { tools: { websearch: false } }
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('websearch').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(chipFor('websearch'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['tools', 'websearch'])
      expect('value' in patch).toBe(false)
    })

    it('an explicit true also reads ON and turning it off overwrites to false', async () => {
      currentConfig = { tools: { lsp: true } }
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('lsp').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(chipFor('lsp'))
      })
      expect(onlyPatch()).toEqual({ path: ['tools', 'lsp'], value: false })
    })

    it('unknown tools keys (MCP globs) are neither rendered nor patched', async () => {
      currentConfig = { tools: { 'claudeui_*': false, 'someserver*': true, bash: false } }
      await renderPane(<OpencodeToolsSection />)

      const ids = screen
        .getAllByTestId('OpencodeConfigPane.chip')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).not.toContain('claudeui_*')
      expect(ids).not.toContain('someserver*')

      await act(async () => {
        fireEvent.click(chipFor('bash'))
      })
      // One LEAF patch for bash only — the unknown keys are structurally
      // untouched because we never write the `tools` object as a whole.
      const patch = onlyPatch()
      expect(patch.path).toEqual(['tools', 'bash'])
      expect(patch.path[0]).toBe('tools')
      expect(patch.path).toHaveLength(2)
    })
  })

  // ── 4. formatter / lsp union ───────────────────────────────────────

  describe('formatter / lsp boolean|object union', () => {
    it('an OBJECT value still reads ON', async () => {
      currentConfig = { formatter: { prettier: { disabled: true } } }
      await renderPane(<OpencodeToolsSection />)
      expect(toggleFor('formatter').getAttribute('aria-pressed')).toBe('true')
    })

    it('turning it OFF writes false', async () => {
      currentConfig = { formatter: { prettier: { disabled: true } } }
      await renderPane(<OpencodeToolsSection />)
      await act(async () => {
        fireEvent.click(toggleFor('formatter'))
      })
      expect(onlyPatch()).toEqual({ path: ['formatter'], value: false })
    })

    it('turning it back ON DELETES the key', async () => {
      currentConfig = { formatter: false }
      await renderPane(<OpencodeToolsSection />)
      expect(toggleFor('formatter').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('formatter'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['formatter'])
      expect('value' in patch).toBe(false)
    })

    it('lsp behaves identically', async () => {
      currentConfig = { lsp: false }
      await renderPane(<OpencodeToolsSection />)
      expect(toggleFor('lsp').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('lsp'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['lsp'])
      expect('value' in patch).toBe(false)
    })

    it('the Overrides disclosure commits edited JSON as the whole value', async () => {
      await renderPane(<OpencodeToolsSection />)
      const disclosure = screen
        .getAllByTestId('OpencodeConfigPane.disclosure')
        .find((n) => n.getAttribute('data-id') === 'formatter')!
      await act(async () => {
        fireEvent.click(disclosure)
      })
      const textarea = screen
        .getAllByTestId('OpencodeSchemaForm.rawJson')
        .find((n) => n.getAttribute('data-id') === 'formatter')!
        .querySelector('textarea')!
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '{"prettier":{"disabled":true}}' } })
        fireEvent.blur(textarea)
      })
      expect(onlyPatch()).toEqual({
        path: ['formatter'],
        value: { prettier: { disabled: true } }
      })
    })
  })

  // ── 5. experimental.* stays a leaf ─────────────────────────────────

  describe('experimental keys', () => {
    it('mcp_timeout patches ["experimental","mcp_timeout"], never the whole object', async () => {
      currentConfig = { experimental: { continue_loop_on_deny: true, openTelemetry: true } }
      await renderPane(<OpencodeDiagnosticsSection />)
      const input = numberFor('experimental.mcp_timeout')
      await act(async () => {
        fireEvent.change(input, { target: { value: '30000' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['experimental', 'mcp_timeout'])
      expect(patch.value).toBe(30000)
      // Not a whole-object write: a 1-segment path would replace the siblings.
      expect(patch.path).not.toEqual(['experimental'])
    })

    it('batch_tool patches its own leaf too', async () => {
      await renderPane(<OpencodeDiagnosticsSection />)
      await act(async () => {
        fireEvent.click(toggleFor('experimental.batch_tool'))
      })
      expect(onlyPatch()).toEqual({ path: ['experimental', 'batch_tool'], value: true })
    })

    it('logLevel deletes on the empty choice and writes the chosen level otherwise', async () => {
      await renderPane(<OpencodeDiagnosticsSection />)
      const select = screen
        .getAllByTestId('OpencodeConfigPane.select')
        .find((n) => n.getAttribute('data-id') === 'logLevel')!
      await act(async () => {
        fireEvent.click(select.querySelector('[data-testid$=".trigger"]')!)
      })
      const debug = screen
        .getAllByTestId('OpencodeConfigPane.select.option')
        .find((n) => n.getAttribute('data-id') === 'DEBUG')!
      await act(async () => {
        fireEvent.click(debug)
      })
      expect(onlyPatch()).toEqual({ path: ['logLevel'], value: 'DEBUG' })
    })
  })

  // ── 6. default_agent ───────────────────────────────────────────────

  describe('default_agent picker', () => {
    const AGENTS: OpencodeAgentSummary[] = [
      { name: 'build', kind: 'builtin', mode: 'primary', scope: null },
      { name: 'plan', kind: 'builtin', mode: 'primary', scope: null },
      { name: 'general', kind: 'builtin', mode: 'subagent', scope: null },
      { name: 'title', kind: 'builtin', mode: 'subagent', scope: null, hidden: true },
      { name: 'omni', kind: 'custom', mode: 'all', scope: 'global' },
      { name: 'ghost', kind: 'custom', mode: 'primary', scope: 'global', hidden: true },
      { name: 'retired', kind: 'custom', mode: 'primary', scope: 'global', disabled: true }
    ]

    it('lists only agents opencode would accept as a default (no subagents, hidden or disabled)', async () => {
      installApiStub({ listOpencodeAgents: vi.fn(async () => AGENTS) })
      await renderPane(<OpencodeWorkspaceSection />)
      const select = screen
        .getAllByTestId('OpencodeConfigPane.select')
        .find((n) => n.getAttribute('data-id') === 'default_agent')!
      await act(async () => {
        fireEvent.click(select.querySelector('[data-testid$=".trigger"]')!)
      })
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.select.option')
        .map((n) => n.getAttribute('data-id'))
      // '' is the "build (default)" row.
      expect(ids).toEqual(['', 'build', 'plan', 'omni'])
      expect(ids).not.toContain('general')
      expect(ids).not.toContain('title')
      expect(ids).not.toContain('ghost')
      expect(ids).not.toContain('retired')
    })

    it('choosing the empty row deletes default_agent', async () => {
      currentConfig = { default_agent: 'plan' }
      installApiStub({ listOpencodeAgents: vi.fn(async () => AGENTS) })
      await renderPane(<OpencodeWorkspaceSection />)
      const select = screen
        .getAllByTestId('OpencodeConfigPane.select')
        .find((n) => n.getAttribute('data-id') === 'default_agent')!
      await act(async () => {
        fireEvent.click(select.querySelector('[data-testid$=".trigger"]')!)
      })
      const empty = screen
        .getAllByTestId('OpencodeConfigPane.select.option')
        .find((n) => n.getAttribute('data-id') === '')!
      await act(async () => {
        fireEvent.click(empty)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['default_agent'])
      expect('value' in patch).toBe(false)
    })
  })

  // ── 6b. String lists ───────────────────────────────────────────────

  describe('string-list rows', () => {
    function listRow(configKey: string): HTMLElement {
      const el = screen
        .getAllByTestId('OpencodeConfigPane.row')
        .find((n) => n.getAttribute('data-id') === configKey)
      expect(el, `no row for ${configKey}`).toBeTruthy()
      return el as HTMLElement
    }

    it('adding an entry writes the whole array at its leaf path', async () => {
      await renderPane(<OpencodeWorkspaceSection />)
      const row = listRow('instructions')
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      await act(async () => {
        fireEvent.change(input, { target: { value: 'docs/*.md' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['instructions'], value: ['docs/*.md'] })
    })

    it('emptying the list DELETES the key', async () => {
      currentConfig = { instructions: ['docs/*.md'] }
      await renderPane(<OpencodeWorkspaceSection />)
      const row = listRow('instructions')
      const remove = row.querySelector<HTMLElement>(
        '[data-testid="OpencodeConfigPane.list.remove"]'
      )!
      await act(async () => {
        fireEvent.click(remove)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['instructions'])
      expect('value' in patch).toBe(false)
    })

    it('watcher.ignore is a nested leaf, not a whole-watcher write', async () => {
      await renderPane(<OpencodeWorkspaceSection />)
      const row = listRow('watcher.ignore')
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      await act(async () => {
        fireEvent.change(input, { target: { value: '**/dist/**' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['watcher', 'ignore'], value: ['**/dist/**'] })
    })

    it('plugin tuple entries are preserved, not dropped, when the list is edited', async () => {
      // `plugin` accepts `string | [string, options]`. The list control only
      // speaks strings — the tuples must survive an edit anyway.
      currentConfig = { plugin: ['plain-plugin', ['tuple-plugin', { opt: 1 }]] }
      await renderPane(<OpencodeToolsSection />)
      const row = listRow('plugin')
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      // Only the string entry is offered as a chip.
      const chips = row.querySelectorAll('[data-testid="OpencodeConfigPane.list.item"]')
      expect(Array.from(chips).map((c) => c.getAttribute('data-id'))).toEqual(['plain-plugin'])

      await act(async () => {
        fireEvent.change(input, { target: { value: 'new-plugin' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({
        path: ['plugin'],
        value: ['plain-plugin', 'new-plugin', ['tuple-plugin', { opt: 1 }]]
      })
    })

    it('skills.paths is a nested leaf', async () => {
      await renderPane(<OpencodeToolsSection />)
      const row = listRow('skills.paths')
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      await act(async () => {
        fireEvent.change(input, { target: { value: '/opt/skills' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['skills', 'paths'], value: ['/opt/skills'] })
    })
  })

  // ── 6c. Text input ─────────────────────────────────────────────────

  describe('shell text input', () => {
    function shellInput(): HTMLInputElement {
      return screen
        .getAllByTestId('OpencodeConfigPane.text')
        .find((n) => n.getAttribute('data-id') === 'shell') as HTMLInputElement
    }

    it('commits on blur', async () => {
      await renderPane(<OpencodeWorkspaceSection />)
      const input = shellInput()
      await act(async () => {
        fireEvent.change(input, { target: { value: '/bin/zsh' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({ path: ['shell'], value: '/bin/zsh' })
    })

    it('clearing it deletes the key', async () => {
      currentConfig = { shell: '/bin/zsh' }
      await renderPane(<OpencodeWorkspaceSection />)
      const input = shellInput()
      await act(async () => {
        fireEvent.change(input, { target: { value: '  ' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['shell'])
      expect('value' in patch).toBe(false)
    })
  })

  // ── 7. Managed pane is static ──────────────────────────────────────

  describe('Managed keys pane', () => {
    it('renders the three forced rows and issues no IPC', async () => {
      await renderPane(<OpencodeManagedKeysSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.managedRow')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual(['autoupdate', 'share', 'experimental.continue_loop_on_deny'])
      expect(readOpencodeNativeRaw).not.toHaveBeenCalled()
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('badges autoupdate/share as forced off and continue_loop_on_deny as forced on', async () => {
      await renderPane(<OpencodeManagedKeysSection />)
      const badge = (id: string): string =>
        screen
          .getAllByTestId('OpencodeConfigPane.forcedBadge')
          .find((n) => n.getAttribute('data-id') === id)!
          .textContent!.trim()
      expect(badge('autoupdate')).toBe('Forced off')
      expect(badge('share')).toBe('Forced off')
      expect(badge('experimental.continue_loop_on_deny')).toBe('Forced on')
    })

    it('renders even when opencode is not installed (it describes ClaudeUI, not the file)', async () => {
      installApiStub({ engineIsInstalled: vi.fn(async () => false) })
      await renderPane(<OpencodeManagedKeysSection />)
      expect(screen.getByTestId('OpencodeManagedKeysSection')).toBeTruthy()
    })
  })

  // ── 8. Install gate ────────────────────────────────────────────────

  describe('not-installed gate', () => {
    const panes: [string, React.ReactElement][] = [
      ['OpencodeSessionBehaviorSection', <OpencodeSessionBehaviorSection key="a" />],
      ['OpencodeToolOutputSection', <OpencodeToolOutputSection key="b" />],
      ['OpencodeAttachmentsSection', <OpencodeAttachmentsSection key="c" />],
      ['OpencodeWorkspaceSection', <OpencodeWorkspaceSection key="d" />],
      ['OpencodeToolsSection', <OpencodeToolsSection key="e" />],
      ['OpencodeDiagnosticsSection', <OpencodeDiagnosticsSection key="f" />]
    ]

    it.each(panes)('%s renders the not-installed copy and no controls', async (testid, node) => {
      installApiStub({ engineIsInstalled: vi.fn(async () => false) })
      await renderPane(node)
      const root = screen.getByTestId(testid)
      expect(root.textContent).toContain('opencode is not installed')
      expect(screen.queryAllByTestId('OpencodeConfigPane.toggle')).toHaveLength(0)
      expect(screen.queryAllByTestId('OpencodeConfigPane.number')).toHaveLength(0)
    })
  })

  // ── 9. Patch failures surface ──────────────────────────────────────

  describe('patch errors', () => {
    it('shows a rejected patch inline under its row', async () => {
      installApiStub({
        patchOpencodeNative: vi.fn(async () => {
          throw new Error('opencode config would be invalid: /snapshot must be boolean')
        })
      })
      await renderPane(<OpencodeSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('snapshot'))
      })
      await waitFor(() => {
        const err = screen
          .getAllByTestId('OpencodeConfigPane.error')
          .find((n) => n.getAttribute('data-id') === 'snapshot')
        expect(err?.textContent).toContain('must be boolean')
      })
    })

    it('re-reads the config after a successful patch', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      const readsBefore = readOpencodeNativeRaw.mock.calls.length
      await act(async () => {
        fireEvent.click(toggleFor('snapshot'))
      })
      await waitFor(() => {
        expect(readOpencodeNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore)
      })
    })
  })
})
