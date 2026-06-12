/**
 * Layer 1: Unit tests for the InputBox View — focused on the new
 * ThinkingPicker and capability-aware EffortPicker sub-components.
 *
 * Renders InputBoxView with minimal props, opens the picker dropdowns,
 * and asserts:
 *   - which options are rendered
 *   - which are disabled (with tooltips) given the capability flags
 *   - that clicking an enabled option fires the right callback
 *   - that the EffortPicker is hidden entirely when the model has no effort support
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'

/**
 * Open a picker dropdown by clicking its trigger and return a `within(dropdown)`
 * query scope. Avoids ambiguity with the trigger button (which displays the
 * currently-selected value and would otherwise collide with same-named options).
 */
 
function openPickerDropdown(triggerTitle: string) {
  const trigger = screen.getByTitle(triggerTitle)
  fireEvent.click(trigger)
  // Dropdown is rendered as an absolutely-positioned sibling of the trigger.
  const dropdown = trigger.parentElement!.querySelector('div.absolute')
  if (!dropdown) throw new Error(`Dropdown not found after opening "${triggerTitle}"`)
  return within(dropdown as HTMLElement)
}
import { InputBoxView, type InputBoxViewProps, type ModelDisplay } from '../View'
import { useSessionStore } from '../../../../stores/session-store'

const baseModel: ModelDisplay = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Latest',
  shortName: 'Opus 4.7',
}

function makeProps(overrides: Partial<InputBoxViewProps> = {}): InputBoxViewProps {
  return {
    textareaRef: createRef<HTMLTextAreaElement>(),
    fileInputRef: createRef<HTMLInputElement>(),
    isMobile: false,
    text: '',
    displayValue: '',
    isDisabled: false,
    isRunning: false,
    isVoiceActive: false,
    placeholder: 'Type a message…',
    textClassName: '',
    permissionMode: 'default',
    slashMenuOpen: false,
    slashCommands: [],
    slashFilter: '',
    slashMenuIndex: 0,
    filteredSlashCommands: [],
    fileMentionOpen: false,
    fileMentionIndex: 0,
    filteredFileMentionEntries: [],
    attachedFiles: [],
    models: [baseModel],
    selectedModel: baseModel,
    effort: 'xhigh',
    effortSupported: true,
    allowedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    thinkingMode: 'adaptive',
    adaptiveSupported: true,
    sandboxEnabled: false,
    voiceEnabled: false,
    voiceState: 'idle',
    statusLine: null,
    onSend: vi.fn(),
    onCancel: vi.fn(),
    onInput: vi.fn(),
    onKeyDown: vi.fn(),
    onKeyUp: vi.fn(),
    onPaste: vi.fn(),
    onFileChange: vi.fn(),
    onRemoveFile: vi.fn(),
    onSlashSelect: vi.fn(),
    onFileMentionConfirm: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectEffort: vi.fn(),
    onSelectThinking: vi.fn(),
    onOpenSandboxSettings: vi.fn(),
    onVoiceStart: vi.fn(),
    onVoiceStop: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  // The View renders a StatusLine sub-component that reads from the store.
  // Provide a session so it doesn't crash.
  useSessionStore.setState({
    activeSessionId: 'unit-route',
    sessions: {},
  })
  ;(globalThis as { window: { api?: unknown } }).window.api = {
    saveSessionConfig: () => {},
  }
})

describe('ThinkingPicker', () => {
  it('renders the current thinking mode label and three options', () => {
    render(<InputBoxView {...makeProps({ thinkingMode: 'adaptive' })} />)
    const trigger = screen.getByTitle('Thinking mode')
    expect(trigger).toHaveTextContent('adaptive')

    const dropdown = openPickerDropdown('Thinking mode')
    expect(dropdown.getByRole('button', { name: /^adaptive$/i })).toBeInTheDocument()
    expect(dropdown.getByRole('button', { name: /^enabled$/i })).toBeInTheDocument()
    expect(dropdown.getByRole('button', { name: /^disabled$/i })).toBeInTheDocument()
  })

  it('greys out Adaptive with a tooltip when adaptiveSupported=false', () => {
    render(<InputBoxView {...makeProps({ adaptiveSupported: false, thinkingMode: 'enabled' })} />)
    const dropdown = openPickerDropdown('Thinking mode')
    const adaptive = dropdown.getByRole('button', { name: /^adaptive$/i })
    expect(adaptive).toBeDisabled()
    expect(adaptive).toHaveAttribute('title', expect.stringContaining('Adaptive thinking is only supported'))
    expect(dropdown.getByRole('button', { name: /^enabled$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^disabled$/i })).not.toBeDisabled()
  })

  it('clicking an enabled mode fires onSelectThinking with that mode', () => {
    const onSelectThinking = vi.fn()
    render(<InputBoxView {...makeProps({ onSelectThinking })} />)
    const dropdown = openPickerDropdown('Thinking mode')
    fireEvent.click(dropdown.getByRole('button', { name: /^disabled$/i }))
    expect(onSelectThinking).toHaveBeenCalledTimes(1)
    expect(onSelectThinking).toHaveBeenCalledWith('disabled')
  })

  it('clicking a disabled mode does not fire the callback', () => {
    const onSelectThinking = vi.fn()
    render(<InputBoxView {...makeProps({ adaptiveSupported: false, thinkingMode: 'enabled', onSelectThinking })} />)
    const dropdown = openPickerDropdown('Thinking mode')
    fireEvent.click(dropdown.getByRole('button', { name: /^adaptive$/i }))
    expect(onSelectThinking).not.toHaveBeenCalled()
  })

  it('clicking outside the picker closes the dropdown', () => {
    render(<InputBoxView {...makeProps()} />)
    openPickerDropdown('Thinking mode')
    expect(screen.queryByRole('button', { name: /^enabled$/i })).toBeInTheDocument()
    // Simulate clicking outside — mousedown on the body
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('button', { name: /^enabled$/i })).not.toBeInTheDocument()
  })
})

describe('EffortPicker', () => {
  it('renders nothing when supported=false', () => {
    render(<InputBoxView {...makeProps({ effortSupported: false, allowedEffortLevels: [] })} />)
    expect(screen.queryByTitle('Effort level')).not.toBeInTheDocument()
  })

  it('renders all 5 levels and greys out unsupported ones (sonnet-4-6 shape)', () => {
    render(<InputBoxView {...makeProps({
      effort: 'high',
      allowedEffortLevels: ['low', 'medium', 'high', 'max'],
    })} />)

    const dropdown = openPickerDropdown('Effort level')
    expect(dropdown.getByRole('button', { name: /^low$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^medium$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^high$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^max$/i })).not.toBeDisabled()

    const xhigh = dropdown.getByRole('button', { name: /^xhigh$/i })
    expect(xhigh).toBeDisabled()
    expect(xhigh).toHaveAttribute('title', expect.stringContaining('xhigh effort is only available on Opus 4.7'))
  })

  it('greys out max with the no-max tooltip when not in allowedEffortLevels', () => {
    render(<InputBoxView {...makeProps({
      allowedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
    })} />)
    const dropdown = openPickerDropdown('Effort level')
    const max = dropdown.getByRole('button', { name: /^max$/i })
    expect(max).toBeDisabled()
    expect(max).toHaveAttribute('title', expect.stringContaining('max effort is not supported'))
  })

  it('clicking an enabled level fires onSelectEffort', () => {
    const onSelectEffort = vi.fn()
    render(<InputBoxView {...makeProps({ onSelectEffort })} />)
    const dropdown = openPickerDropdown('Effort level')
    fireEvent.click(dropdown.getByRole('button', { name: /^max$/i }))
    expect(onSelectEffort).toHaveBeenCalledWith('max')
  })

  it('clicking a disabled level does not fire the callback', () => {
    const onSelectEffort = vi.fn()
    render(<InputBoxView {...makeProps({
      allowedEffortLevels: ['low', 'medium', 'high'],
      onSelectEffort,
    })} />)
    const dropdown = openPickerDropdown('Effort level')
    fireEvent.click(dropdown.getByRole('button', { name: /^xhigh$/i }))
    fireEvent.click(dropdown.getByRole('button', { name: /^max$/i }))
    expect(onSelectEffort).not.toHaveBeenCalled()
  })
})
