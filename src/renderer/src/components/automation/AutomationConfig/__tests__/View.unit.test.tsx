/**
 * Layer 1 — View unit tests for AutomationConfig.
 *
 * Focus is on the controls added for parity with the InputBox: the shared
 * ModelPicker / EffortPicker / ThinkingPicker. Picker mechanics themselves
 * (option rendering, disabled states, tooltips) are covered by the InputBox
 * View tests — this file only asserts the automation-specific wiring:
 *   - initial values source from `automation.effort` / `automation.thinkingMode`
 *   - `onSave` receives the explicit picks in the payload
 *   - switching models coerces unsupported effort back to the model default
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { AutomationConfigView, type AutomationConfigViewProps, type ModelOption } from '../View'
import type { Automation } from '../../../../../../shared/types'

const opus47: ModelOption = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Latest',
  shortName: 'Opus 4.7'
}

const legacySonnet: ModelOption = {
  value: 'claude-3-5-sonnet',
  displayName: 'Sonnet 3.5',
  description: 'Sonnet 3.5 · Legacy',
  shortName: 'Sonnet 3.5'
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a1',
    name: 'Test',
    prompt: 'do the thing',
    cwd: '/tmp',
    schedule: { type: 'interval', intervalMs: 60_000 },
    permissions: { allow: [], deny: [] },
    enabled: false,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: Date.now(),
    ...overrides
  }
}

function makeProps(overrides: Partial<AutomationConfigViewProps> = {}): AutomationConfigViewProps {
  return {
    automation: makeAutomation({ model: 'claude-opus-4-7' }),
    models: [opus47, legacySonnet],
    globalPerms: null,
    hasRunningRun: false,
    runs: [],
    detailTab: 'configure',
    loadDirPerms: vi.fn(async () => null),
    onSave: vi.fn(),
    onToggleEnabled: vi.fn(),
    onDelete: vi.fn(),
    onRunNow: vi.fn(),
    onStopRun: vi.fn(),
    onPickFolder: vi.fn(async () => null),
    onSelectRun: vi.fn(),
    onSetDetailTab: vi.fn(),
    ...overrides
  }
}

// The pickers share the same dropdown structure as InputBox — trigger has a
// title, dropdown is an absolutely-positioned sibling. Mirror the helper so
// we don't collide with same-named option buttons elsewhere in the form.

function openPickerDropdown(triggerTitle: string) {
  const trigger = screen.getByTitle(triggerTitle)
  fireEvent.click(trigger)
  const dropdown = trigger.parentElement!.querySelector('div.absolute')
  if (!dropdown) throw new Error(`Dropdown not found after opening "${triggerTitle}"`)
  return within(dropdown as HTMLElement)
}

describe('AutomationConfigView — model / thinking / effort pickers', () => {
  beforeEach(() => {
    // Satisfy a click-outside listener in any picker if it fires on unmount.
  })

  it('initialises pickers from automation.model/effort/thinkingMode', () => {
    const automation = makeAutomation({
      model: 'claude-opus-4-7',
      effort: 'xhigh',
      thinkingMode: 'adaptive'
    })
    render(<AutomationConfigView {...makeProps({ automation })} />)
    expect(screen.getByTitle('Model')).toHaveTextContent('Opus 4.7')
    expect(screen.getByTitle('Thinking mode')).toHaveTextContent('adaptive')
    expect(screen.getByTitle('Effort level')).toHaveTextContent('xhigh')
  })

  it('shows the first model as a fallback label when automation.model is blank', () => {
    const automation = makeAutomation({ model: undefined })
    render(<AutomationConfigView {...makeProps({ automation })} />)
    // Falls back to models[0] so the trigger is never blank — the InputBox
    // parity the bug report asked for.
    expect(screen.getByTitle('Model')).toHaveTextContent('Opus 4.7')
  })

  it('shows enabled thinking mode when no thinkingMode is saved but model supports adaptive', () => {
    const automation = makeAutomation({
      model: 'claude-opus-4-7',
      thinkingMode: undefined
    })
    render(<AutomationConfigView {...makeProps({ automation })} />)
    // modelDefaultThinkingMode = 'adaptive' for opus-4-7.
    expect(screen.getByTitle('Thinking mode')).toHaveTextContent('adaptive')
  })

  it('hides the effort picker entirely for models without effort support', () => {
    const automation = makeAutomation({ model: 'claude-3-5-sonnet' })
    render(<AutomationConfigView {...makeProps({ automation })} />)
    expect(screen.queryByTitle('Effort level')).toBeNull()
  })

  it('greys out adaptive thinking on a legacy model', () => {
    const automation = makeAutomation({ model: 'claude-3-5-sonnet' })
    render(<AutomationConfigView {...makeProps({ automation })} />)
    const dropdown = openPickerDropdown('Thinking mode')
    expect(dropdown.getByRole('button', { name: /^adaptive$/i })).toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^enabled$/i })).not.toBeDisabled()
  })

  it('Save passes thinkingMode + effort alongside the other fields', () => {
    const onSave = vi.fn()
    const automation = makeAutomation({ model: 'claude-opus-4-7' })
    render(<AutomationConfigView {...makeProps({ automation, onSave })} />)

    // Pick a thinking mode explicitly.
    const tDropdown = openPickerDropdown('Thinking mode')
    fireEvent.click(tDropdown.getByRole('button', { name: /^disabled$/i }))

    // Pick an effort explicitly.
    const eDropdown = openPickerDropdown('Effort level')
    fireEvent.click(eDropdown.getByRole('button', { name: /^high$/i }))

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0][0]).toMatchObject({
      id: 'a1',
      model: 'claude-opus-4-7',
      effort: 'high',
      thinkingMode: 'disabled'
    })
  })

  it('keeps the native folder dialog when no host listing is injected (desktop)', async () => {
    const onPickFolder = vi.fn(async () => 'D:/picked/by/dialog')
    render(<AutomationConfigView {...makeProps({ onPickFolder })} />)

    fireEvent.click(screen.getByTestId('AutomationConfig.browseFolder'))

    expect(onPickFolder).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId('AutomationConfig.cwd')).toHaveValue('D:/picked/by/dialog')
    )
  })

  it('browses the host in a dialog when a listing is injected (web — ADR-046 decision 3)', async () => {
    const onPickFolder = vi.fn(async () => null)
    const listDir = vi.fn(async () => ({
      entries: [],
      isRoot: false,
      resolvedPath: 'D:/work/ClaudeUI'
    }))
    render(<AutomationConfigView {...makeProps({ onPickFolder, listDir })} />)

    fireEvent.click(screen.getByTestId('AutomationConfig.browseFolder'))
    // pickFolder() resolves to null on web — the row must never reach it.
    expect(onPickFolder).not.toHaveBeenCalled()

    const input = screen.getByTestId('DirectoryBrowserDialog.path')
    fireEvent.change(input, { target: { value: 'D:/work/ClaudeUI' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() =>
      expect(screen.getByTestId('AutomationConfig.cwd')).toHaveValue('D:/work/ClaudeUI')
    )
    expect(screen.queryByTestId('DirectoryBrowserDialog')).toBeNull()
  })

  it("opens the browser on the automation's own cwd, not the host home", async () => {
    // The ADR-046 residual: the browse used to seed `listDir('')` (home) and
    // ignore the directory the automation already names.
    const listDir = vi.fn(async (dirPath: string) => ({
      entries: [],
      isRoot: false,
      resolvedPath: dirPath === '' ? 'C:/Users/dev' : dirPath.replace(/\\/g, '/')
    }))
    const automation = makeAutomation({ cwd: 'D:/work/ClaudeUI' })
    render(<AutomationConfigView {...makeProps({ automation, listDir })} />)

    fireEvent.click(screen.getByTestId('AutomationConfig.browseFolder'))
    const input = screen.getByTestId('DirectoryBrowserDialog.path') as HTMLInputElement
    expect(input.value).toBe('D:/work/ClaudeUI/')

    // The home seed resolves afterwards and must not clobber it.
    await waitFor(() => expect(listDir).toHaveBeenCalledWith(''))
    expect(input.value).toBe('D:/work/ClaudeUI/')
  })

  it('offers the injected recents in the browser rail', () => {
    const listDir = vi.fn(async () => ({ entries: [], isRoot: false, resolvedPath: '' }))
    const listPlaces = vi.fn(async () => ({ home: '', hostname: '', drives: [] }))
    render(
      <AutomationConfigView
        {...makeProps({
          listDir,
          listPlaces,
          recents: [{ cwd: 'D:/work/ClaudeUI', folderName: 'ClaudeUI' }]
        })}
      />
    )

    fireEvent.click(screen.getByTestId('AutomationConfig.browseFolder'))
    expect(screen.getByTestId('DirectoryBrowserDialog.recent')).toHaveAttribute(
      'data-id',
      'D:/work/ClaudeUI'
    )
    expect(listPlaces).toHaveBeenCalledTimes(1)
  })

  it('switching to a model without adaptive support coerces thinkingMode down', () => {
    const onSave = vi.fn()
    const automation = makeAutomation({
      model: 'claude-opus-4-7',
      thinkingMode: 'adaptive'
    })
    render(<AutomationConfigView {...makeProps({ automation, onSave })} />)

    // Switch to the legacy model.
    const mDropdown = openPickerDropdown('Model')
    fireEvent.click(mDropdown.getByRole('button', { name: /Sonnet 3\.5/ }))

    // Trigger label reflects the coercion — adaptive is not available on legacy.
    expect(screen.getByTitle('Thinking mode')).toHaveTextContent('enabled')

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))
    expect(onSave.mock.calls[0][0]).toMatchObject({
      model: 'claude-3-5-sonnet',
      thinkingMode: 'enabled'
    })
  })
})
