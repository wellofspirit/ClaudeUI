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
  shortName: 'Opus 4.7'
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
    selectedEngineId: 'claude',
    engineLocked: false,
    showEnginePicker: true,
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
    onSelectEngine: vi.fn(),
    onSelectEffort: vi.fn(),
    onSelectThinking: vi.fn(),
    onOpenSandboxSettings: vi.fn(),
    onVoiceStart: vi.fn(),
    onVoiceStop: vi.fn(),
    ...overrides
  }
}

beforeEach(() => {
  // The View renders a StatusLine sub-component that reads from the store.
  // Provide a session so it doesn't crash.
  useSessionStore.setState({
    activeSessionId: 'unit-route',
    sessions: {}
  })
  ;(globalThis as { window: { api?: unknown } }).window.api = {
    saveSessionConfig: () => {}
  }
})

describe('mobile — combined config control', () => {
  it('renders only the MobileConfigSheet trigger, no individual pickers', () => {
    render(<InputBoxView {...makeProps({ isMobile: true })} />)
    expect(screen.getByTestId('MobileConfigSheet.trigger')).toBeInTheDocument()
    expect(screen.queryByTestId('EnginePicker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ModelPicker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ThinkingPicker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('EffortPicker')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ReasoningPicker')).not.toBeInTheDocument()
  })

  it('desktop (isMobile=false) renders the individual pickers, no MobileConfigSheet', () => {
    render(<InputBoxView {...makeProps({ isMobile: false })} />)
    expect(screen.queryByTestId('MobileConfigSheet')).not.toBeInTheDocument()
    expect(screen.getByTestId('EnginePicker')).toBeInTheDocument()
    expect(screen.getByTestId('ModelPicker')).toBeInTheDocument()
  })
})

describe('engine and model controls', () => {
  it('renders the engine picker immediately before the model picker', () => {
    render(<InputBoxView {...makeProps()} />)
    const enginePicker = screen.getByTestId('EnginePicker')
    const modelPicker = screen.getByTestId('ModelPicker')
    expect(enginePicker.nextElementSibling).toBe(modelPicker)
  })

  it('hides the engine picker without hiding the model picker', () => {
    render(<InputBoxView {...makeProps({ showEnginePicker: false })} />)
    expect(screen.queryByTestId('EnginePicker')).not.toBeInTheDocument()
    expect(screen.getByTestId('ModelPicker')).toBeInTheDocument()
  })
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
    expect(adaptive).toHaveAttribute(
      'title',
      expect.stringContaining('Adaptive thinking is only supported')
    )
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
    render(
      <InputBoxView
        {...makeProps({ adaptiveSupported: false, thinkingMode: 'enabled', onSelectThinking })}
      />
    )
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
    render(
      <InputBoxView
        {...makeProps({
          effort: 'high',
          allowedEffortLevels: ['low', 'medium', 'high', 'max']
        })}
      />
    )

    const dropdown = openPickerDropdown('Effort level')
    expect(dropdown.getByRole('button', { name: /^low$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^medium$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^high$/i })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /^max$/i })).not.toBeDisabled()

    const xhigh = dropdown.getByRole('button', { name: /^xhigh$/i })
    expect(xhigh).toBeDisabled()
    expect(xhigh).toHaveAttribute(
      'title',
      expect.stringContaining('xhigh effort is only available on Opus 4.7')
    )
  })

  it('greys out max with the no-max tooltip when not in allowedEffortLevels', () => {
    render(
      <InputBoxView
        {...makeProps({
          allowedEffortLevels: ['low', 'medium', 'high', 'xhigh']
        })}
      />
    )
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
    render(
      <InputBoxView
        {...makeProps({
          allowedEffortLevels: ['low', 'medium', 'high'],
          onSelectEffort
        })}
      />
    )
    const dropdown = openPickerDropdown('Effort level')
    fireEvent.click(dropdown.getByRole('button', { name: /^xhigh$/i }))
    fireEvent.click(dropdown.getByRole('button', { name: /^max$/i }))
    expect(onSelectEffort).not.toHaveBeenCalled()
  })
})

describe('VoiceButton — hold-to-talk on touch (phase 5 S3)', () => {
  /**
   * The bug this pins: the button was mouse-only, and a mobile browser
   * synthesizes the compatibility mouse pair only AFTER `touchend`. A
   * press-and-hold on a phone therefore produced mousedown+mouseup back to back
   * — a zero-length capture — which made remote voice input, whose stated
   * purpose is speaking into a phone, unusable. `onMouseLeave` never fired
   * either, so the mouse-only escape hatch was gone too.
   *
   * jsdom does not synthesize compatibility mouse events itself, so the
   * suppression cannot be observed directly. What CAN be pinned, and is what
   * actually matters, is the two halves of the contract: touchstart calls
   * `preventDefault` (which is what suppresses them in a real browser), and the
   * handlers are wired so that even if a synthesized pair DID arrive, the
   * observable effect stays one start and one stop per gesture.
   *
   * The preventDefault assertion is load-bearing and NOT ceremony: React
   * registers `touchstart` as a PASSIVE root listener, so the obvious
   * implementation — a React `onTouchStart` calling `e.preventDefault()` — is
   * silently ignored by the browser. The first version of this button did
   * exactly that and this test failed (`expected true to be false`), which is
   * how the trap was found. The button now binds a native listener with
   * `{ passive: false }`; anyone who "simplifies" it back to the React handler
   * fails here.
   */
  function renderVoice(overrides: Partial<InputBoxViewProps> = {}) {
    const onVoiceStart = vi.fn()
    const onVoiceStop = vi.fn()
    render(
      <InputBoxView
        {...makeProps({ voiceEnabled: true, onVoiceStart, onVoiceStop, ...overrides })}
      />
    )
    return { button: screen.getByTestId('InputBox.voice'), onVoiceStart, onVoiceStop }
  }

  it('a touch press-and-release produces exactly one start and one stop', () => {
    const { button, onVoiceStart, onVoiceStop } = renderVoice()

    fireEvent.touchStart(button)
    expect(onVoiceStart).toHaveBeenCalledTimes(1)
    expect(onVoiceStop).not.toHaveBeenCalled()

    fireEvent.touchEnd(button)
    expect(onVoiceStart).toHaveBeenCalledTimes(1)
    expect(onVoiceStop).toHaveBeenCalledTimes(1)
  })

  it('touchstart calls preventDefault — the thing that suppresses the synthesized mouse pair', () => {
    const { button } = renderVoice()
    // `fireEvent` returns false when a handler called preventDefault.
    expect(fireEvent.touchStart(button)).toBe(false)
  })

  it('a synthesized mouse pair arriving after touchend starts no second capture', () => {
    // The belt to preventDefault's braces: this is what a browser that ignored
    // the preventDefault would deliver. The button must not begin a second
    // capture — and the CONTROLLER is the backstop that guarantees it, since the
    // renderer's own `voiceState` guard cannot see a state that is still a round
    // trip away (pinned in web/__tests__/voice-capture.unit.test.ts:
    // "a second start() while capturing is a no-op", and api-adapter's
    // `isActive()` short-circuit).
    //
    // Here the button is already in the state the first press put it in, which
    // is what a real second press would meet.
    const { button, onVoiceStart, onVoiceStop } = renderVoice({ voiceState: 'recording' })

    fireEvent.touchStart(button)
    fireEvent.touchEnd(button)
    expect(onVoiceStart).toHaveBeenCalledTimes(1)
    expect(onVoiceStop).toHaveBeenCalledTimes(1)

    // …now the compatibility events a non-conforming browser would fire.
    fireEvent.mouseDown(button)
    fireEvent.mouseUp(button)
    // The handlers ran (the DOM cannot refuse them), so the guard that matters
    // is downstream: `handleVoiceStart` returns early on a non-idle state, and
    // the capture controller no-ops a start while active. What this pins is that
    // the touch wiring adds no EXTRA path — the counts move by exactly the one
    // synthesized pair, never by two.
    expect(onVoiceStart).toHaveBeenCalledTimes(2)
    expect(onVoiceStop).toHaveBeenCalledTimes(2)
  })

  it('a cancelled gesture (incoming call, system swipe) still stops the capture', () => {
    const { button, onVoiceStart, onVoiceStop } = renderVoice()

    fireEvent.touchStart(button)
    // No touchend ever arrives for a cancelled gesture.
    fireEvent.touchCancel(button)
    expect(onVoiceStart).toHaveBeenCalledTimes(1)
    expect(onVoiceStop).toHaveBeenCalledTimes(1)
  })

  it('keeps the mouse path working, and the DOM shape unchanged', () => {
    const { button, onVoiceStart, onVoiceStop } = renderVoice()

    fireEvent.mouseDown(button)
    fireEvent.mouseUp(button)
    expect(onVoiceStart).toHaveBeenCalledTimes(1)
    expect(onVoiceStop).toHaveBeenCalledTimes(1)

    // No design change: same testid, same affordance text.
    expect(button).toHaveAttribute('title', 'Hold to record')
  })

  it('mouseleave mid-recording still stops (the desktop escape hatch)', () => {
    const { button, onVoiceStop } = renderVoice({ voiceState: 'recording' })
    fireEvent.mouseLeave(button)
    expect(onVoiceStop).toHaveBeenCalledTimes(1)
  })
})
