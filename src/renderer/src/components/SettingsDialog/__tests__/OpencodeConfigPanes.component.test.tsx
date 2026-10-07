/**
 * Layer 2: Component tests for the curated opencode Configuration panes.
 *
 * The invariants worth guarding are all about WHAT LANDS IN THE FILE, not what
 * the pane looks like:
 *
 *   1. Absent-default toggles: absent reads as the default; leaving the default
 *      writes the value; returning to it DELETES the key.
 *   2. Numbers commit on blur and on Enter; an emptied field deletes the key.
 *   3. The built-in tool chips go through their own writer (top-level
 *      `permissions`, opencode 2.x), never a raw patch.
 *   4. The `formatter`/`lsp` boolean|object union: an object value still reads
 *      as ON; OFF writes false; ON deletes.
 *   5. 2.x keys only (ADR-093 S8): a 1.x key 2.x still reads shows as the value
 *      and moves to its 2.x key in the same write; `mcp` is patched as leaves.
 *   6. `default_agent` offers only agents opencode would accept as a default.
 *   7. The Managed pane is static: FORCED rows, no IPC.
 *   8. No pane asks whether opencode is installed: the file is ClaudeUI's own
 *      read, and the page cannot be opened while it is not (ADR-082 §8).
 *   9. A rejected patch surfaces inline instead of being swallowed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor, within } from '@testing-library/react'
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
const toolSwitches: [string, boolean][] = []
const setOpencodeToolDisabled = vi.fn(async (action: string, disabled: boolean) => {
  toolSwitches.push([action, disabled])
})

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    readOpencodeNativeRaw,
    patchOpencodeNative,
    listOpencodeAgents,
    setOpencodeToolDisabled,
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

function rowFor(configKey: string): HTMLElement {
  const el = screen
    .getAllByTestId('OpencodeConfigPane.row')
    .find((n) => n.getAttribute('data-id') === configKey)
  expect(el, `no row for ${configKey}`).toBeTruthy()
  return el as HTMLElement
}

function managedRow(configKey: string): HTMLElement {
  const el = screen
    .getAllByTestId('OpencodeConfigPane.managedRow')
    .find((n) => n.getAttribute('data-id') === configKey)
  expect(el, `no managed row for ${configKey}`).toBeTruthy()
  return el as HTMLElement
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
    setOpencodeToolDisabled.mockClear()
    toolSwitches.length = 0
    installApiStub()
  })

  afterEach(() => cleanup())

  // ── 1. Absent-default toggle semantics ─────────────────────────────

  describe('absent-default toggles', () => {
    it('reads ON when the key is absent and its default is on', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('compaction.auto').getAttribute('aria-pressed')).toBe('true')
      expect(toggleFor('snapshots').getAttribute('aria-pressed')).toBe('true')
    })

    it('reads OFF when the key is absent and its default is off', async () => {
      await renderPane(<OpencodeAttachmentsSection />)
      // media.image.auto_resize defaults ON; flip the reading through the 1.x key.
      cleanup()
      currentConfig = { attachment: { image: { auto_resize: false } } }
      await renderPane(<OpencodeAttachmentsSection />)
      expect(toggleFor('media.image.auto_resize').getAttribute('aria-pressed')).toBe('false')
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

    it('a 1.x key 2.x also reads shows as the value, and a commit moves it (one write)', async () => {
      currentConfig = { snapshot: false }
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('snapshots').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('snapshots'))
      })
      // Back to the default: the 2.x key is already absent, so only the 1.x one goes.
      expect(captured).toHaveLength(1)
      expect(captured[0]).toEqual([{ path: ['snapshot'] }])
    })

    it('an explicit value equal to the default still deletes on the next toggle back', async () => {
      currentConfig = { snapshots: true }
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(toggleFor('snapshots').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(toggleFor('snapshots'))
      })
      expect(onlyPatch()).toEqual({ path: ['snapshots'], value: false })
    })

    it('has no rows for the 1.x compaction keys 2.x dropped (prune, tail_turns)', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.row')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual([
        'compaction.auto',
        'compaction.keep.tokens',
        'compaction.buffer',
        'experimental.subagent_depth',
        'snapshots'
      ])
    })

    it('a 1.x compaction number commits to its 2.x leaf and deletes the 1.x one', async () => {
      currentConfig = { compaction: { reserved: 4000 } }
      await renderPane(<OpencodeSessionBehaviorSection />)
      const input = numberFor('compaction.buffer')
      expect(input.value).toBe('4000')
      await act(async () => {
        fireEvent.change(input, { target: { value: '5000' } })
        fireEvent.blur(input)
      })
      expect(captured[0]).toEqual([
        { path: ['compaction', 'buffer'], value: 5000 },
        { path: ['compaction', 'reserved'] }
      ])
    })
  })

  // ── 1b. The row vocabulary (ADR-065) ───────────────────────────────

  describe('row anatomy', () => {
    it('prints the raw config key on its own mono line under the description', async () => {
      // The old form appended the key to the end of the helper sentence at 10px
      // muted/60 — 1.6:1 on the dark theme, and unreadable next to the prose.
      await renderPane(<OpencodeSessionBehaviorSection />)
      const row = rowFor('compaction.keep.tokens')
      const key = within(row).getByText('compaction.keep.tokens')
      expect(key.className).toContain('font-mono')
      expect(key.className).toContain('text-text-muted')
      // …and the number carries its unit, so the placeholder is free to say
      // what an EMPTY field means.
      expect(row.textContent).toContain('tokens')
    })

    it('marks a row whose key is PRESENT as changed, and its Reset deletes the key', async () => {
      currentConfig = { tool_output: { max_lines: 500 } }
      await renderPane(<OpencodeToolOutputSection />)
      // The accent dot is gone (2026-09-08); the hover Reset IS the marker, and
      // it is in the DOM (at opacity-0) exactly when the row is modified.
      const reset = (key: string): Element | null =>
        rowFor(key).querySelector('[data-testid="OpencodeConfigPane.row.reset"]')
      expect(reset('tool_output.max_lines')).toBeTruthy()
      expect(reset('tool_output.max_bytes')).toBeNull()

      await act(async () => {
        fireEvent.click(
          rowFor('tool_output.max_lines').querySelector(
            '[data-testid="OpencodeConfigPane.row.reset"]'
          )!
        )
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['tool_output', 'max_lines'])
      expect('value' in patch).toBe(false)
    })

    it('a toggle is unmarked while its key is absent, marked once it is written', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      const reset = (): Element | null =>
        toggleFor('snapshots').querySelector('[data-testid="OpencodeConfigPane.toggle.reset"]')
      expect(reset()).toBeNull()

      cleanup()
      currentConfig = { snapshots: true }
      await renderPane(<OpencodeSessionBehaviorSection />)
      expect(reset()).toBeTruthy()
    })

    it('resetting the image dimensions deletes BOTH keys in one write', async () => {
      // Two `patch` calls in the same tick would be two concurrent
      // read-modify-write cycles over the same file — one of them would lose.
      currentConfig = { media: { image: { max_width: 1200, max_height: 900 } } }
      await renderPane(<OpencodeAttachmentsSection />)
      await act(async () => {
        fireEvent.click(
          rowFor('media.image.max_width').querySelector(
            '[data-testid="OpencodeConfigPane.row.reset"]'
          )!
        )
      })
      expect(captured).toHaveLength(1)
      // (the 1.x `attachment` twins are absent here, so they are no part of it)
      expect(captured[0].map((p) => p.path)).toEqual([
        ['media', 'image', 'max_width'],
        ['media', 'image', 'max_height']
      ])
      expect(captured[0].every((p) => !('value' in p))).toBe(true)
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
      const input = numberFor('media.image.max_base64_bytes')
      expect(input.value).toBe('')
      expect(input.placeholder).toBe('5242880')
    })

    it('the width/height pair patches each dimension separately', async () => {
      await renderPane(<OpencodeAttachmentsSection />)
      await act(async () => {
        const w = numberFor('media.image.max_width')
        fireEvent.change(w, { target: { value: '1200' } })
        fireEvent.blur(w)
      })
      expect(onlyPatch()).toEqual({
        path: ['media', 'image', 'max_width'],
        value: 1200
      })
    })
  })

  // ── 3. tools chips ─────────────────────────────────────────────────

  describe('built-in tool chips (top-level permissions)', () => {
    it('renders the 2.x built-in tool actions', async () => {
      await renderPane(<OpencodeToolsSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.chip')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual([
        'shell',
        'read',
        'glob',
        'grep',
        'edit',
        'webfetch',
        'websearch',
        'subagent',
        'skill',
        'question'
      ])
    })

    it('a tool with no deny reads ON; clicking it switches it off through its own writer', async () => {
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('websearch').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(chipFor('websearch'))
      })
      expect(toolSwitches).toEqual([['websearch', true]])
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('a `{action,*,deny}` rule (or a 1.x tools:false) reads OFF; clicking switches it back on', async () => {
      currentConfig = {
        tools: { bash: false },
        permissions: [{ action: 'websearch', resource: '*', effect: 'deny' }]
      }
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('websearch').getAttribute('aria-pressed')).toBe('false')
      expect(chipFor('shell').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(chipFor('websearch'))
      })
      expect(toolSwitches).toEqual([['websearch', false]])
    })

    it('"off" is upstream whollyDisabled: a later narrower allow keeps the tool ON (F3)', async () => {
      currentConfig = {
        permissions: [
          { action: 'shell', resource: '*', effect: 'deny' },
          { action: 'shell', resource: 'git *', effect: 'allow' }
        ]
      }
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('shell').getAttribute('aria-pressed')).toBe('true')
    })

    it('names the agents whose own rules still offer a switched-off tool (F3)', async () => {
      currentConfig = {
        permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
        agent: { rev: { permission: { '*': 'allow' } } }
      }
      installApiStub({
        listOpencodeAgents: vi.fn(async () => [
          {
            name: 'md-agent',
            kind: 'custom',
            mode: 'all',
            scope: 'global',
            rules: [{ action: 'shell', resource: 'git *', effect: 'allow' }]
          },
          { name: 'strict', kind: 'custom', mode: 'all', scope: 'global' }
        ])
      })
      await renderPane(<OpencodeToolsSection />)
      const row = rowFor('permissions')
      expect(row.textContent).toContain('Still offered by: shell: rev, md-agent')
      expect(row.textContent).not.toContain('every agent')
    })

    it("a refused switch (the user's own rule) shows the reason inline", async () => {
      currentConfig = { permissions: [{ action: 'read', resource: '*', effect: 'deny' }] }
      installApiStub({
        setOpencodeToolDisabled: vi.fn(async () => {
          throw new Error('read is switched off by your own permission rules')
        })
      })
      await renderPane(<OpencodeToolsSection />)
      await act(async () => {
        fireEvent.click(chipFor('read'))
      })
      await waitFor(() => expect(rowFor('permissions').textContent).toContain('your own'))
    })

    it('a narrow rule does not switch a tool off', async () => {
      currentConfig = { permissions: [{ action: 'shell', resource: 'rm *', effect: 'deny' }] }
      await renderPane(<OpencodeToolsSection />)
      expect(chipFor('shell').getAttribute('aria-pressed')).toBe('true')
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

  describe('MCP timeouts (Diagnostics)', () => {
    it('writes mcp.timeout leaves, never the whole mcp object (ClaudeUI injects servers)', async () => {
      await renderPane(<OpencodeDiagnosticsSection />)
      const input = numberFor('mcp.timeout.execution')
      await act(async () => {
        fireEvent.change(input, { target: { value: '30000' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({ path: ['mcp', 'timeout', 'execution'], value: 30000 })
    })

    it('reads the 1.x experimental.mcp_timeout and moves it on commit', async () => {
      currentConfig = { experimental: { mcp_timeout: 9000, batch_tool: true } }
      await renderPane(<OpencodeDiagnosticsSection />)
      const input = numberFor('mcp.timeout.execution')
      expect(input.value).toBe('9000')
      await act(async () => {
        fireEvent.change(input, { target: { value: '10000' } })
        fireEvent.blur(input)
      })
      expect(captured[0]).toEqual([
        { path: ['mcp', 'timeout', 'execution'], value: 10000 },
        { path: ['experimental', 'mcp_timeout'] }
      ])
    })

    it('has no log-level or batch-tool rows (opencode 2.x has neither key)', async () => {
      await renderPane(<OpencodeDiagnosticsSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.row')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual(['mcp.timeout.execution', 'mcp.timeout.catalog', 'mcp.timeout.startup'])
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

    it('plugins: the 1.x list moves into the 2.x one on an edit (tuples become entries)', async () => {
      currentConfig = { plugin: ['plain-plugin', ['tuple-plugin', { opt: 1 }]], plugins: ['two'] }
      await renderPane(<OpencodeToolsSection />)
      const row = listRow('plugins')
      const chips = row.querySelectorAll('[data-testid="OpencodeConfigPane.list.item"]')
      expect(Array.from(chips).map((c) => c.getAttribute('data-id'))).toEqual([
        'plain-plugin',
        'two'
      ])
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      await act(async () => {
        fireEvent.change(input, { target: { value: 'new-plugin' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(captured[0]).toEqual([
        {
          path: ['plugins'],
          value: [
            'plain-plugin',
            'two',
            'new-plugin',
            { package: 'tuple-plugin', options: { opt: 1 } }
          ]
        },
        { path: ['plugin'] }
      ])
    })

    it('skills is a 2.x list; the 1.x {paths, urls} object reads as one', async () => {
      currentConfig = { skills: { paths: ['/a'], urls: ['https://b'] } }
      await renderPane(<OpencodeToolsSection />)
      const row = listRow('skills')
      const input = row.querySelector<HTMLInputElement>(
        '[data-testid="OpencodeConfigPane.list.input"]'
      )!
      await act(async () => {
        fireEvent.change(input, { target: { value: '/opt/skills' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['skills'], value: ['/a', 'https://b', '/opt/skills'] })
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
    it('renders the forced rows and issues no IPC', async () => {
      await renderPane(<OpencodeManagedKeysSection />)
      const ids = screen
        .getAllByTestId('OpencodeConfigPane.managedRow')
        .map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual(['update', 'share'])
      expect(readOpencodeNativeRaw).not.toHaveBeenCalled()
      expect(patchOpencodeNative).not.toHaveBeenCalled()
    })

    it('badges update/share as forced off, a switch the user cannot move', async () => {
      await renderPane(<OpencodeManagedKeysSection />)
      const badge = (id: string): string =>
        managedRow(id)
          .querySelector('[data-testid="OpencodeConfigPane.managedRow.locked"]')!
          .textContent!.trim()
      expect(badge('update')).toBe('Forced off')
      expect(badge('share')).toBe('Forced off')
      expect((managedRow('share') as HTMLButtonElement).disabled).toBe(true)
    })

    it('points at the keys that live on other pages, as one explanatory row', async () => {
      await renderPane(<OpencodeManagedKeysSection />)
      const row = screen.getByTestId('OpencodeConfigPane.elsewhere')
      expect(row.textContent).toContain('agents.title')
      expect(row.textContent).toContain('providers')
    })
  })

  // ── 8. Not installed (ADR-082 §8) ─────────────────────────────────

  describe('not installed', () => {
    // The file is ClaudeUI's own read and the page cannot be opened while
    // opencode is not installed (SettingsDialogView's rail test), so no pane
    // asks: each shows the file's values.
    const panes: [string, React.ReactElement, string][] = [
      [
        'OpencodeSessionBehaviorSection',
        <OpencodeSessionBehaviorSection key="a" />,
        'compaction.auto'
      ],
      ['OpencodeToolOutputSection', <OpencodeToolOutputSection key="b" />, 'tool_output.max_lines'],
      [
        'OpencodeAttachmentsSection',
        <OpencodeAttachmentsSection key="c" />,
        'media.image.max_width'
      ],
      ['OpencodeWorkspaceSection', <OpencodeWorkspaceSection key="d" />, 'instructions'],
      ['OpencodeToolsSection', <OpencodeToolsSection key="e" />, 'permissions'],
      [
        'OpencodeDiagnosticsSection',
        <OpencodeDiagnosticsSection key="f" />,
        'mcp.timeout.execution'
      ]
    ]

    it.each(panes)(
      '%s renders its rows without asking whether opencode is installed',
      async (testid, node, key) => {
        const engineIsInstalled = vi.fn(async () => false)
        installApiStub({ engineIsInstalled })
        await renderPane(node)
        expect(screen.getByTestId(testid).textContent).not.toContain('Loading')
        expect(rowFor(key)).toBeInTheDocument()
        expect(engineIsInstalled).not.toHaveBeenCalled()
      }
    )
  })

  // ── 9. Patch failures surface ──────────────────────────────────────

  describe('patch errors', () => {
    it('shows a rejected patch inline under its row', async () => {
      installApiStub({
        patchOpencodeNative: vi.fn(async () => {
          throw new Error('opencode config would be invalid: /snapshots must be boolean')
        })
      })
      await renderPane(<OpencodeSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('snapshots'))
      })
      await waitFor(() => {
        const err = screen
          .getAllByTestId('OpencodeConfigPane.error')
          .find((n) => n.getAttribute('data-id') === 'snapshots')
        expect(err?.textContent).toContain('must be boolean')
      })
    })

    it('re-reads the config after a successful patch', async () => {
      await renderPane(<OpencodeSessionBehaviorSection />)
      const readsBefore = readOpencodeNativeRaw.mock.calls.length
      await act(async () => {
        fireEvent.click(toggleFor('snapshots'))
      })
      await waitFor(() => {
        expect(readOpencodeNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore)
      })
    })
  })
})
