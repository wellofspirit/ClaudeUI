/**
 * Layer 2: Component tests for the curated pi Configuration panes.
 *
 * As with their opencode twins, the invariants worth guarding are all about
 * WHAT LANDS IN THE FILE, not what the pane looks like:
 *
 *   1. Absent-default toggles: absent reads as pi's default; leaving it writes
 *      the value; returning to it DELETES the key.
 *   2. Numbers/text commit on blur and on Enter; an emptied field deletes.
 *   3. Nested keys (`retry.provider.*`, `compaction.*`, `images.*`) are patched
 *      as LEAVES — a whole-object write would erase pi's sibling keys.
 *   4. `defaultTools` has three distinct states: ABSENT (pi's standard defaults
 *      apply), an explicit array, and an explicit `[]` (no built-ins). The
 *      first chip click seeds the array from the probed default set; all-off
 *      writes `[]`; "Use pi defaults" deletes the key.
 *   5. `thinkingBudgets` is per-level, and clearing the LAST level removes the
 *      whole object rather than leaving `{}` behind.
 *   6. Segmented rows delete when the chosen value is the one pi already
 *      assumes (`defaultThinkingLevel` unset, `defaultProjectTrust: ask`).
 *   7. `packages` object-form entries survive an edit of the string entries.
 *   8. The Raw pane refuses to save invalid JSON and writes the text verbatim.
 *   9. `trackingId` is never surfaced (pi generates it).
 *  10. Every pane self-gates on pi being installed.
 *  11. A rejected patch surfaces inline instead of being swallowed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type { RawConfigPatch } from '../../../../../shared/types'
import {
  PiSessionBehaviorSection,
  PiModelsSection,
  PiToolsSection,
  PiImagesSection,
  PiWorkspaceSection,
  PiNetworkSection,
  PiRawConfigSection
} from '../PiConfigPanes'

// ── window.api stub ──────────────────────────────────────────────────

const SETTINGS_PATH = '/home/u/.pi/agent/settings.json'

let captured: RawConfigPatch[][] = []
let currentConfig: Record<string, unknown> = {}
let currentText = ''

const patchPiNative = vi.fn(async (patches: RawConfigPatch[]) => {
  captured.push(structuredClone(patches))
})
const readPiNativeRaw = vi.fn(async () => ({
  config: structuredClone(currentConfig),
  path: SETTINGS_PATH,
  text: currentText
}))
const writePiNativeText = vi.fn(async () => {})
const loadEngineConfig = vi.fn(async () => ({}))
const saveEngineConfig = vi.fn(async () => {})
const getEngineModels = vi.fn(async () => [])

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    readPiNativeRaw,
    patchPiNative,
    writePiNativeText,
    loadEngineConfig,
    saveEngineConfig,
    getEngineModels,
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

function byId(testid: string, id: string): HTMLElement {
  const el = screen.getAllByTestId(testid).find((n) => n.getAttribute('data-id') === id)
  expect(el, `no ${testid} for ${id}`).toBeTruthy()
  return el as HTMLElement
}

const toggleFor = (key: string): HTMLElement => byId('PiConfigPane.toggle', key)
const numberFor = (key: string): HTMLInputElement =>
  byId('PiConfigPane.number', key) as HTMLInputElement
const textFor = (key: string): HTMLInputElement =>
  byId('PiConfigPane.text', key) as HTMLInputElement
const chipFor = (id: string): HTMLElement => byId('PiConfigPane.chip', id)
const segmentFor = (key: string, value: string): HTMLElement =>
  byId('PiConfigPane.segment', `${key}:${value}`)
const rowFor = (key: string): HTMLElement => byId('PiConfigPane.row', key)

describe('pi Configuration panes', () => {
  beforeEach(() => {
    captured = []
    currentConfig = {}
    currentText = ''
    patchPiNative.mockClear()
    readPiNativeRaw.mockClear()
    writePiNativeText.mockClear()
    installApiStub()
  })

  afterEach(() => cleanup())

  // ── 1. Absent-default toggles ──────────────────────────────────────

  describe('absent-default toggles', () => {
    it('reads ON when the key is absent and pi defaults it on', async () => {
      await renderPane(<PiSessionBehaviorSection />)
      expect(toggleFor('compaction.enabled').getAttribute('aria-pressed')).toBe('true')
      expect(toggleFor('retry.enabled').getAttribute('aria-pressed')).toBe('true')
    })

    it('reads OFF when the key is absent and pi defaults it off', async () => {
      await renderPane(<PiNetworkSection />)
      expect(toggleFor('enableAnalytics').getAttribute('aria-pressed')).toBe('false')
      expect(toggleFor('enableInstallTelemetry').getAttribute('aria-pressed')).toBe('true')
    })

    it('turning OFF a default-on key writes false at its NESTED leaf path', async () => {
      await renderPane(<PiSessionBehaviorSection />)
      await act(async () => {
        fireEvent.click(toggleFor('compaction.enabled'))
      })
      expect(onlyPatch()).toEqual({ path: ['compaction', 'enabled'], value: false })
    })

    it('turning a default-on key back ON DELETES the key rather than writing true', async () => {
      currentConfig = { images: { autoResize: false } }
      await renderPane(<PiImagesSection />)
      expect(toggleFor('images.autoResize').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('images.autoResize'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['images', 'autoResize'])
      expect('value' in patch).toBe(false)
    })

    it('turning a default-off key ON writes true; turning it back off deletes', async () => {
      await renderPane(<PiImagesSection />)
      await act(async () => {
        fireEvent.click(toggleFor('images.blockImages'))
      })
      expect(onlyPatch()).toEqual({ path: ['images', 'blockImages'], value: true })

      cleanup()
      captured = []
      currentConfig = { images: { blockImages: true } }
      await renderPane(<PiImagesSection />)
      await act(async () => {
        fireEvent.click(toggleFor('images.blockImages'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['images', 'blockImages'])
      expect('value' in patch).toBe(false)
    })

    it('enableSkillCommands defaults on and deletes when switched back', async () => {
      currentConfig = { enableSkillCommands: false }
      await renderPane(<PiWorkspaceSection />)
      expect(toggleFor('enableSkillCommands').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(toggleFor('enableSkillCommands'))
      })
      expect('value' in onlyPatch()).toBe(false)
    })
  })

  // ── 2. Numbers ─────────────────────────────────────────────────────

  describe('number inputs', () => {
    it('commits on blur as a leaf patch', async () => {
      await renderPane(<PiSessionBehaviorSection />)
      const input = numberFor('compaction.reserveTokens')
      await act(async () => {
        fireEvent.change(input, { target: { value: '8192' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({ path: ['compaction', 'reserveTokens'], value: 8192 })
    })

    it('commits on Enter', async () => {
      await renderPane(<PiSessionBehaviorSection />)
      const input = numberFor('branchSummary.reserveTokens')
      await act(async () => {
        fireEvent.change(input, { target: { value: '4096' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['branchSummary', 'reserveTokens'], value: 4096 })
    })

    it('clearing the field DELETES the key', async () => {
      currentConfig = { compaction: { keepRecentTokens: 20000 } }
      await renderPane(<PiSessionBehaviorSection />)
      const input = numberFor('compaction.keepRecentTokens')
      expect(input.value).toBe('20000')
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['compaction', 'keepRecentTokens'])
      expect('value' in patch).toBe(false)
    })

    it('a blur with no edit writes nothing', async () => {
      currentConfig = { retry: { maxRetries: 3 } }
      await renderPane(<PiSessionBehaviorSection />)
      await act(async () => {
        fireEvent.blur(numberFor('retry.maxRetries'))
      })
      expect(patchPiNative).not.toHaveBeenCalled()
    })

    it('retry.provider.* patches THREE segments, never the whole retry object', async () => {
      currentConfig = { retry: { enabled: true, provider: { maxRetryDelayMs: 60000 } } }
      await renderPane(<PiSessionBehaviorSection />)
      const input = numberFor('retry.provider.maxRetries')
      await act(async () => {
        fireEvent.change(input, { target: { value: '2' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['retry', 'provider', 'maxRetries'])
      expect(patch.value).toBe(2)
    })

    it('an absent number renders empty with pi\u2019s default as the placeholder', async () => {
      await renderPane(<PiNetworkSection />)
      expect(numberFor('httpIdleTimeoutMs').value).toBe('')
      expect(numberFor('httpIdleTimeoutMs').placeholder).toBe('300000')
      expect(numberFor('websocketConnectTimeoutMs').placeholder).toBe('15000')
    })
  })

  // ── 3. Text ────────────────────────────────────────────────────────

  describe('text inputs', () => {
    it('commits on blur and deletes when emptied', async () => {
      await renderPane(<PiToolsSection />)
      const input = textFor('shellPath')
      await act(async () => {
        fireEvent.change(input, { target: { value: 'C:/Program Files/Git/bin/bash.exe' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({
        path: ['shellPath'],
        value: 'C:/Program Files/Git/bin/bash.exe'
      })

      cleanup()
      captured = []
      currentConfig = { shellPath: '/bin/zsh' }
      await renderPane(<PiToolsSection />)
      const second = textFor('shellPath')
      await act(async () => {
        fireEvent.change(second, { target: { value: '   ' } })
        fireEvent.keyDown(second, { key: 'Enter' })
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['shellPath'])
      expect('value' in patch).toBe(false)
    })

    it('the pi fallback provider/model are top-level leaves', async () => {
      await renderPane(<PiModelsSection />)
      const provider = textFor('defaultProvider')
      await act(async () => {
        fireEvent.change(provider, { target: { value: 'anthropic' } })
        fireEvent.blur(provider)
      })
      expect(onlyPatch()).toEqual({ path: ['defaultProvider'], value: 'anthropic' })
    })
  })

  // ── 4. defaultTools: absent / seeded / [] / reset ──────────────────

  describe('defaultTools chips', () => {
    it('renders pi\u2019s eight built-in tool ids', async () => {
      await renderPane(<PiToolsSection />)
      const ids = screen.getAllByTestId('PiConfigPane.chip').map((n) => n.getAttribute('data-id'))
      expect(ids).toEqual(['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls'])
    })

    it('ABSENT shows every chip unselected plus the standard-defaults caption', async () => {
      await renderPane(<PiToolsSection />)
      for (const id of ['read', 'bash', 'edit', 'write', 'grep']) {
        expect(chipFor(id).getAttribute('aria-pressed'), id).toBe('false')
      }
      expect(screen.getByTestId('PiConfigPane.toolsDefaultCaption').textContent).toContain(
        'pi standard defaults active (read, bash, edit, write)'
      )
      // No reset link while there is nothing explicit to reset.
      expect(screen.queryByTestId('PiConfigPane.toolsUseDefaults')).toBeNull()
    })

    it('the FIRST chip click seeds the probed default set, then applies the click', async () => {
      await renderPane(<PiToolsSection />)
      await act(async () => {
        fireEvent.click(chipFor('grep'))
      })
      expect(onlyPatch()).toEqual({
        path: ['defaultTools'],
        value: ['read', 'bash', 'edit', 'write', 'grep']
      })
    })

    it('the first click on an ALREADY-DEFAULT tool seeds and removes it', async () => {
      await renderPane(<PiToolsSection />)
      await act(async () => {
        fireEvent.click(chipFor('bash'))
      })
      expect(onlyPatch()).toEqual({
        path: ['defaultTools'],
        value: ['read', 'edit', 'write']
      })
    })

    it('an explicit array drives the chips and is edited in place', async () => {
      currentConfig = { defaultTools: ['read', 'powershell'] }
      await renderPane(<PiToolsSection />)
      expect(chipFor('powershell').getAttribute('aria-pressed')).toBe('true')
      expect(chipFor('bash').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(chipFor('write'))
      })
      expect(onlyPatch()).toEqual({
        path: ['defaultTools'],
        value: ['read', 'powershell', 'write']
      })
    })

    it('turning the LAST chip off writes an explicit [], NOT a delete', async () => {
      currentConfig = { defaultTools: ['read'] }
      await renderPane(<PiToolsSection />)
      await act(async () => {
        fireEvent.click(chipFor('read'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['defaultTools'])
      expect('value' in patch).toBe(true)
      expect(patch.value).toEqual([])
    })

    it('an explicit [] reads as all-off and still offers the reset link', async () => {
      currentConfig = { defaultTools: [] }
      await renderPane(<PiToolsSection />)
      expect(screen.queryByTestId('PiConfigPane.toolsDefaultCaption')).toBeNull()
      expect(chipFor('read').getAttribute('aria-pressed')).toBe('false')
      await act(async () => {
        fireEvent.click(screen.getByTestId('PiConfigPane.toolsUseDefaults'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['defaultTools'])
      expect('value' in patch).toBe(false)
    })

    it('"Use pi defaults" deletes the key', async () => {
      currentConfig = { defaultTools: ['read', 'bash'] }
      await renderPane(<PiToolsSection />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('PiConfigPane.toolsUseDefaults'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['defaultTools'])
      expect('value' in patch).toBe(false)
    })
  })

  // ── 5. thinkingBudgets ─────────────────────────────────────────────

  describe('thinkingBudgets', () => {
    it('writes one leaf per level', async () => {
      await renderPane(<PiModelsSection />)
      const input = numberFor('thinkingBudgets.low')
      await act(async () => {
        fireEvent.change(input, { target: { value: '4096' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch()).toEqual({ path: ['thinkingBudgets', 'low'], value: 4096 })
    })

    it('clearing ONE level with siblings deletes just that level', async () => {
      currentConfig = { thinkingBudgets: { low: 4096, high: 32768 } }
      await renderPane(<PiModelsSection />)
      const input = numberFor('thinkingBudgets.low')
      expect(input.value).toBe('4096')
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['thinkingBudgets', 'low'])
      expect('value' in patch).toBe(false)
    })

    it('clearing the LAST level deletes the thinkingBudgets object itself', async () => {
      currentConfig = { thinkingBudgets: { high: 32768 } }
      await renderPane(<PiModelsSection />)
      const input = numberFor('thinkingBudgets.high')
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.blur(input)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['thinkingBudgets'])
      expect('value' in patch).toBe(false)
    })

    it('a level this grid does not render still counts as a sibling', async () => {
      // `xhigh` has no input here, but deleting the object would take it with it.
      currentConfig = { thinkingBudgets: { high: 32768, xhigh: 60000 } }
      await renderPane(<PiModelsSection />)
      const input = numberFor('thinkingBudgets.high')
      await act(async () => {
        fireEvent.change(input, { target: { value: '' } })
        fireEvent.blur(input)
      })
      expect(onlyPatch().path).toEqual(['thinkingBudgets', 'high'])
    })
  })

  // ── 6. Segmented rows ──────────────────────────────────────────────

  describe('segmented rows', () => {
    it('defaultThinkingLevel writes the chosen level and deletes on "default"', async () => {
      await renderPane(<PiModelsSection />)
      expect(segmentFor('defaultThinkingLevel', '').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(segmentFor('defaultThinkingLevel', 'high'))
      })
      expect(onlyPatch()).toEqual({ path: ['defaultThinkingLevel'], value: 'high' })

      cleanup()
      captured = []
      currentConfig = { defaultThinkingLevel: 'high' }
      await renderPane(<PiModelsSection />)
      expect(segmentFor('defaultThinkingLevel', 'high').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(segmentFor('defaultThinkingLevel', ''))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['defaultThinkingLevel'])
      expect('value' in patch).toBe(false)
    })

    it('"off" is a real value, distinct from absent', async () => {
      await renderPane(<PiModelsSection />)
      await act(async () => {
        fireEvent.click(segmentFor('defaultThinkingLevel', 'off'))
      })
      expect(onlyPatch()).toEqual({ path: ['defaultThinkingLevel'], value: 'off' })
    })

    it('defaultProjectTrust reads ask when absent and DELETES when set back to ask', async () => {
      currentConfig = { defaultProjectTrust: 'always' }
      await renderPane(<PiWorkspaceSection />)
      expect(segmentFor('defaultProjectTrust', 'always').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(segmentFor('defaultProjectTrust', 'ask'))
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['defaultProjectTrust'])
      expect('value' in patch).toBe(false)
    })

    it('defaultProjectTrust writes a non-default choice', async () => {
      await renderPane(<PiWorkspaceSection />)
      expect(segmentFor('defaultProjectTrust', 'ask').getAttribute('aria-pressed')).toBe('true')
      await act(async () => {
        fireEvent.click(segmentFor('defaultProjectTrust', 'never'))
      })
      expect(onlyPatch()).toEqual({ path: ['defaultProjectTrust'], value: 'never' })
    })
  })

  // ── 7. Lists + record-ish keys ─────────────────────────────────────

  describe('resource lists', () => {
    function listInput(configKey: string): HTMLInputElement {
      return rowFor(configKey).querySelector<HTMLInputElement>(
        '[data-testid="PiConfigPane.list.input"]'
      )!
    }

    it('adding a package writes the whole array at its leaf path', async () => {
      await renderPane(<PiWorkspaceSection />)
      const input = listInput('packages')
      await act(async () => {
        fireEvent.change(input, { target: { value: 'pi-skills' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['packages'], value: ['pi-skills'] })
    })

    it('emptying a list DELETES the key', async () => {
      currentConfig = { skills: ['/opt/skills'] }
      await renderPane(<PiWorkspaceSection />)
      const remove = rowFor('skills').querySelector<HTMLElement>(
        '[data-testid="PiConfigPane.list.remove"]'
      )!
      await act(async () => {
        fireEvent.click(remove)
      })
      const patch = onlyPatch()
      expect(patch.path).toEqual(['skills'])
      expect('value' in patch).toBe(false)
    })

    it('object-form package entries are preserved, not dropped, and are called out', async () => {
      currentConfig = {
        packages: ['pi-skills', { source: 'pi-extras', skills: ['brave-search'] }]
      }
      await renderPane(<PiWorkspaceSection />)
      const chips = rowFor('packages').querySelectorAll('[data-testid="PiConfigPane.list.item"]')
      expect(Array.from(chips).map((c) => c.getAttribute('data-id'))).toEqual(['pi-skills'])
      expect(byId('PiConfigPane.opaqueNote', 'packages').textContent).toContain('Raw config')

      const input = listInput('packages')
      await act(async () => {
        fireEvent.change(input, { target: { value: '@org/more' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({
        path: ['packages'],
        value: ['pi-skills', '@org/more', { source: 'pi-extras', skills: ['brave-search'] }]
      })
    })

    it('extensions / skills / prompts each patch their own key', async () => {
      await renderPane(<PiWorkspaceSection />)
      for (const key of ['extensions', 'skills', 'prompts']) {
        expect(rowFor(key)).toBeTruthy()
      }
      const input = listInput('prompts')
      await act(async () => {
        fireEvent.change(input, { target: { value: '/opt/prompts' } })
        fireEvent.keyDown(input, { key: 'Enter' })
      })
      expect(onlyPatch()).toEqual({ path: ['prompts'], value: ['/opt/prompts'] })
    })

    it('npmCommand commits the edited JSON array as the whole value', async () => {
      await renderPane(<PiToolsSection />)
      const textarea = byId('OpencodeSchemaForm.rawJson', 'npmCommand').querySelector('textarea')!
      await act(async () => {
        fireEvent.change(textarea, { target: { value: '["mise","exec","node@20","--","npm"]' } })
        fireEvent.blur(textarea)
      })
      expect(onlyPatch()).toEqual({
        path: ['npmCommand'],
        value: ['mise', 'exec', 'node@20', '--', 'npm']
      })
    })
  })

  // ── 8. transport select ────────────────────────────────────────────

  describe('transport select', () => {
    async function pick(value: string): Promise<void> {
      const select = byId('PiConfigPane.select', 'transport')
      await act(async () => {
        fireEvent.click(select.querySelector('[data-testid$=".trigger"]')!)
      })
      await act(async () => {
        fireEvent.click(byId('PiConfigPane.select.option', value))
      })
    }

    it('writes the chosen transport', async () => {
      await renderPane(<PiNetworkSection />)
      await pick('websocket-cached')
      expect(onlyPatch()).toEqual({ path: ['transport'], value: 'websocket-cached' })
    })

    it('choosing auto (pi\u2019s default) deletes the key', async () => {
      currentConfig = { transport: 'sse' }
      await renderPane(<PiNetworkSection />)
      await pick('')
      const patch = onlyPatch()
      expect(patch.path).toEqual(['transport'])
      expect('value' in patch).toBe(false)
    })
  })

  // ── 9. trackingId is never a control ───────────────────────────────

  it('never surfaces trackingId — pi generates it, so Raw config is its only home', async () => {
    currentConfig = { enableAnalytics: true, trackingId: 'abc-123' }
    await renderPane(<PiNetworkSection />)
    expect(
      screen.queryAllByTestId('PiConfigPane.row').map((n) => n.getAttribute('data-id'))
    ).not.toContain('trackingId')
    expect(screen.getByTestId('PiNetworkSection').textContent).not.toContain('abc-123')
  })

  // ── 10. Raw config pane ────────────────────────────────────────────

  describe('Raw config pane', () => {
    const textarea = (): HTMLTextAreaElement =>
      screen.getByTestId('PiConfigPane.rawText') as HTMLTextAreaElement
    const saveButton = (): HTMLButtonElement =>
      screen.getByTestId('PiConfigPane.rawSave') as HTMLButtonElement

    it('shows the file text verbatim', async () => {
      currentText = '{\n  // hand-written\n  "theme": "dark"\n}\n'
      currentConfig = { theme: 'dark' }
      await renderPane(<PiRawConfigSection />)
      expect(textarea().value).toBe(currentText)
    })

    it('invalid JSON blocks Save and shows the parser error', async () => {
      currentText = '{"theme":"dark"}'
      await renderPane(<PiRawConfigSection />)
      await act(async () => {
        fireEvent.change(textarea(), { target: { value: '{"theme": ' } })
      })
      expect(saveButton().disabled).toBe(true)
      expect(screen.getByTestId('PiConfigPane.rawError').textContent).toBeTruthy()
      expect(writePiNativeText).not.toHaveBeenCalled()
    })

    it('a valid JSON document that is not an object is refused too', async () => {
      currentText = '{"theme":"dark"}'
      await renderPane(<PiRawConfigSection />)
      await act(async () => {
        fireEvent.change(textarea(), { target: { value: '[1, 2, 3]' } })
      })
      expect(saveButton().disabled).toBe(true)
      expect(screen.getByTestId('PiConfigPane.rawError').textContent).toContain(
        'top level must be a JSON object'
      )
    })

    it('saving writes the text VERBATIM and re-reads afterwards', async () => {
      currentText = '{"theme":"dark"}'
      await renderPane(<PiRawConfigSection />)
      const next = '{\n  "theme": "light",\n  "quietStartup": true\n}\n'
      await act(async () => {
        fireEvent.change(textarea(), { target: { value: next } })
      })
      expect(saveButton().disabled).toBe(false)
      const readsBefore = readPiNativeRaw.mock.calls.length
      await act(async () => {
        fireEvent.click(saveButton())
      })
      expect(writePiNativeText).toHaveBeenCalledWith(next)
      await waitFor(() => expect(readPiNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore))
    })

    it('Save is disabled until the text actually differs from the file', async () => {
      currentText = '{"theme":"dark"}'
      await renderPane(<PiRawConfigSection />)
      expect(saveButton().disabled).toBe(true)
    })

    it('a rejected write surfaces inline and leaves the draft alone', async () => {
      currentText = '{"theme":"dark"}'
      installApiStub({
        writePiNativeText: vi.fn(async () => {
          throw new Error('Refusing to overwrite unreadable pi settings file')
        })
      })
      await renderPane(<PiRawConfigSection />)
      await act(async () => {
        fireEvent.change(textarea(), { target: { value: '{"theme":"light"}' } })
      })
      await act(async () => {
        fireEvent.click(saveButton())
      })
      await waitFor(() =>
        expect(screen.getByTestId('PiConfigPane.rawError').textContent).toContain(
          'Refusing to overwrite'
        )
      )
      expect(textarea().value).toBe('{"theme":"light"}')
    })
  })

  // ── 11. Install gate ───────────────────────────────────────────────

  describe('not-installed gate', () => {
    const panes: [string, React.ReactElement][] = [
      ['PiSessionBehaviorSection', <PiSessionBehaviorSection key="a" />],
      ['PiModelsSection', <PiModelsSection key="b" />],
      ['PiToolsSection', <PiToolsSection key="c" />],
      ['PiImagesSection', <PiImagesSection key="d" />],
      ['PiWorkspaceSection', <PiWorkspaceSection key="e" />],
      ['PiNetworkSection', <PiNetworkSection key="f" />],
      ['PiRawConfigSection', <PiRawConfigSection key="g" />]
    ]

    it.each(panes)('%s renders the not-installed copy and no controls', async (testid, node) => {
      installApiStub({ engineIsInstalled: vi.fn(async () => false) })
      await renderPane(node)
      expect(screen.getByTestId(testid).textContent).toContain('pi is not installed')
      expect(screen.queryAllByTestId('PiConfigPane.toggle')).toHaveLength(0)
      expect(screen.queryAllByTestId('PiConfigPane.number')).toHaveLength(0)
      expect(screen.queryAllByTestId('PiConfigPane.rawText')).toHaveLength(0)
    })
  })

  // ── 12. Patch failures ─────────────────────────────────────────────

  describe('patch errors', () => {
    it('shows a rejected patch inline under its row', async () => {
      installApiStub({
        patchPiNative: vi.fn(async () => {
          throw new Error('Refusing to overwrite unreadable pi settings file')
        })
      })
      await renderPane(<PiImagesSection />)
      await act(async () => {
        fireEvent.click(toggleFor('images.blockImages'))
      })
      await waitFor(() => {
        expect(byId('PiConfigPane.error', 'images.blockImages').textContent).toContain(
          'Refusing to overwrite'
        )
      })
    })

    it('re-reads the config after a successful patch', async () => {
      await renderPane(<PiImagesSection />)
      const readsBefore = readPiNativeRaw.mock.calls.length
      await act(async () => {
        fireEvent.click(toggleFor('images.blockImages'))
      })
      await waitFor(() => {
        expect(readPiNativeRaw.mock.calls.length).toBeGreaterThan(readsBefore)
      })
    })
  })
})
