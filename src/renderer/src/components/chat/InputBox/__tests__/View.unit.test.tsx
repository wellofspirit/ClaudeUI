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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRef } from 'react'
import { act, render, screen, fireEvent, within } from '@testing-library/react'

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
import {
  InputBoxView,
  VOICE_NOTICE_FADE_MS,
  VOICE_NOTICE_LINGER_MS,
  type InputBoxViewProps,
  type ModelDisplay
} from '../View'
import { bootstrapPermissionMode, useSessionStore } from '../../../../stores/session-store'

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

describe('Codex under the shared permission model', () => {
  it('follows the global autonomy default, auto included', () => {
    for (const defaultPermissionMode of ['auto', 'acceptEdits', 'plan'] as const) {
      expect(
        bootstrapPermissionMode({ ...useSessionStore.getState(), defaultPermissionMode }, 'codex')
      ).toBe(defaultPermissionMode)
    }
  })
  it.each([false, true])(
    'shows the shared mode tab and no native policy pill, mobile=%s',
    (isMobile) => {
      render(
        <InputBoxView
          {...makeProps({
            isMobile,
            selectedEngineId: 'codex',
            permissionMode: 'auto',
            showModePicker: true
          })}
        />
      )
      expect(screen.queryByTestId('CodexPolicyPill')).not.toBeInTheDocument()
      if (!isMobile) expect(screen.getByText('Auto ⏵⏵')).toBeInTheDocument()
      else expect(screen.getByTestId('MobileConfigSheet.trigger')).toBeInTheDocument()
    }
  )
  it('offers the engine-native effort tiers in place of the Claude ladder', () => {
    const onSelectEffort = vi.fn()
    render(
      <InputBoxView
        {...makeProps({
          onSelectEffort,
          selectedEngineId: 'codex',
          effort: 'high',
          effortSupported: true,
          allowedEffortLevels: [],
          nativeEffortOptions: [
            { value: 'high', description: 'High' },
            { value: 'ultra', description: 'Native ultra' }
          ]
        })}
      />
    )
    const dropdown = openPickerDropdown('Effort level')
    expect(dropdown.getByRole('button', { name: /ultra/ })).not.toBeDisabled()
    expect(dropdown.getByRole('button', { name: /Native ultra/ })).toBeInTheDocument()
    // The fixed Claude ladder is gone, not merged in.
    expect(dropdown.queryByRole('button', { name: /^xhigh$/i })).not.toBeInTheDocument()
    fireEvent.click(dropdown.getByRole('button', { name: /ultra/ }))
    expect(onSelectEffort).toHaveBeenCalledWith('ultra')
  })
})

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
    // trip away (pinned in lib/voice/__tests__/browser-voice-capture.unit.test.ts:
    // "a second start() while capturing is a no-op", and the voice controller's
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

  it('leaving with the button still down stops a press that is still spawning (idle)', () => {
    const { button, onVoiceStop } = renderVoice()

    // Moved off without pressing: nothing to abandon.
    fireEvent.mouseLeave(button, { buttons: 0 })
    expect(onVoiceStop).not.toHaveBeenCalled()

    // Dragged off mid-press: the release will land elsewhere, so stop now.
    fireEvent.mouseLeave(button, { buttons: 1 })
    expect(onVoiceStop).toHaveBeenCalledTimes(1)
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

// ---------------------------------------------------------------------------
// The voice notice pill (S3a item 3) — one message above the mic, and the fade
// rule from the approved UI: held → stays; released (or arriving while not
// held) → fades and is removed 5 s later; hover holds; leaving restarts.
// ---------------------------------------------------------------------------

describe('voice notice pill — the fade rule (S3a)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const INFO = { id: 1, text: 'No speech detected', tone: 'info' as const }
  const WARN = {
    id: 2,
    text: 'Microphone disconnected — kept what you said',
    tone: 'warn' as const
  }

  function renderPill(overrides: Partial<InputBoxViewProps> = {}) {
    const onVoiceNoticeExpire = vi.fn()
    const props = makeProps({
      voiceEnabled: true,
      voiceNotice: INFO,
      voiceHeld: false,
      onVoiceNoticeExpire,
      ...overrides
    })
    const view = render(<InputBoxView {...props} />)
    const rerender = (more: Partial<InputBoxViewProps>): void =>
      view.rerender(<InputBoxView {...props} {...more} />)
    return { onVoiceNoticeExpire, rerender }
  }
  const pill = (): HTMLElement => screen.getByTestId('InputBox.voiceNotice')
  const advance = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('renders the text with its tone, as a status the screen reader announces', () => {
    renderPill({ voiceNotice: WARN })
    expect(pill()).toHaveTextContent(WARN.text)
    expect(pill()).toHaveAttribute('data-tone', 'warn')
    expect(pill()).toHaveAttribute('role', 'status')
  })

  it('renders nothing without a notice, or with the mic hidden', () => {
    renderPill({ voiceNotice: null })
    expect(screen.queryByTestId('InputBox.voiceNotice')).toBeNull()
  })

  it('stays as long as the push-to-talk is HELD', () => {
    const { onVoiceNoticeExpire } = renderPill({ voiceNotice: WARN, voiceHeld: true })
    advance(VOICE_NOTICE_LINGER_MS * 4)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()
    expect(pill()).not.toHaveAttribute('data-fading')
  })

  it('once released: fades over the last stretch and is removed 5 s after the release', () => {
    const { onVoiceNoticeExpire, rerender } = renderPill({ voiceNotice: WARN, voiceHeld: true })
    advance(10_000)
    rerender({ voiceNotice: WARN, voiceHeld: false })

    advance(VOICE_NOTICE_LINGER_MS - VOICE_NOTICE_FADE_MS - 1)
    expect(pill()).not.toHaveAttribute('data-fading')
    advance(1)
    expect(pill()).toHaveAttribute('data-fading', 'true')
    expect(pill().className).toContain('opacity-0')
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()

    advance(VOICE_NOTICE_FADE_MS)
    expect(onVoiceNoticeExpire).toHaveBeenCalledWith(WARN.id)
  })

  it('a notice that ARRIVES after the release is removed 5 s after it appears', () => {
    const { onVoiceNoticeExpire, rerender } = renderPill({ voiceNotice: null })
    advance(3000) // released long ago
    rerender({ voiceNotice: INFO })
    advance(VOICE_NOTICE_LINGER_MS - 1)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()
    advance(1)
    expect(onVoiceNoticeExpire).toHaveBeenCalledWith(INFO.id)
  })

  it('a newer notice replacing the old one restarts the 5 s', () => {
    const { onVoiceNoticeExpire, rerender } = renderPill({ voiceNotice: INFO })
    advance(4000)
    rerender({ voiceNotice: WARN })
    advance(4000)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()
    advance(1000)
    expect(onVoiceNoticeExpire).toHaveBeenCalledTimes(1)
    expect(onVoiceNoticeExpire).toHaveBeenCalledWith(WARN.id)
  })

  it('hover holds it — even mid-fade — and leaving restarts the full 5 s', () => {
    const { onVoiceNoticeExpire } = renderPill({ voiceNotice: INFO })
    advance(VOICE_NOTICE_LINGER_MS - VOICE_NOTICE_FADE_MS + 100)
    expect(pill()).toHaveAttribute('data-fading', 'true')

    fireEvent.mouseEnter(pill())
    expect(pill()).not.toHaveAttribute('data-fading')
    advance(VOICE_NOTICE_LINGER_MS * 3)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()

    fireEvent.mouseLeave(pill())
    advance(VOICE_NOTICE_LINGER_MS - 1)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()
    advance(1)
    expect(onVoiceNoticeExpire).toHaveBeenCalledWith(INFO.id)
  })

  it('pressing again while it lingers holds it again', () => {
    const { onVoiceNoticeExpire, rerender } = renderPill({ voiceNotice: INFO })
    advance(3000)
    rerender({ voiceNotice: INFO, voiceHeld: true })
    advance(VOICE_NOTICE_LINGER_MS * 2)
    expect(onVoiceNoticeExpire).not.toHaveBeenCalled()
  })

  it('reduced motion: no fade or entrance animation, the same timing', () => {
    renderPill()
    // The motion-reduce variants keep it fully visible until it is removed.
    expect(pill().className).toContain('motion-reduce:transition-none')
    expect(pill().className).toContain('motion-safe:animate-[fade-in_0.15s_ease-out]')
    expect(pill().className).not.toContain(' animate-fade-in')
    advance(VOICE_NOTICE_LINGER_MS - VOICE_NOTICE_FADE_MS)
    expect(pill().className).toContain('motion-reduce:opacity-100')
  })
})

describe('voice notice pill — alignment over the mic', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('re-measures when the input box resizes, not only the window', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {
          observers.push(() => this.callback())
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    render(
      <InputBoxView
        {...makeProps({
          voiceEnabled: true,
          voiceNotice: { id: 1, text: 'No speech detected', tone: 'info' }
        })}
      />
    )
    const pill = screen.getByTestId('InputBox.voiceNotice')
    const box = pill.parentElement!
    const mic = screen.getByTestId('InputBox.voice')
    expect(observers).toHaveLength(1)

    const rect = (r: Partial<DOMRect>) => () => ({ ...new DOMRect(), ...r }) as DOMRect
    box.getBoundingClientRect = rect({ left: 0, right: 500, width: 500 })
    mic.getBoundingClientRect = rect({ right: 440 })
    act(() => observers[0]())

    expect(pill.style.right).toBe('60px')
    expect(pill.style.maxWidth).toBe('440px')
  })

  it('centres the tail on the MEASURED mic, from where the pill actually landed', () => {
    const observers: Array<() => void> = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {
          observers.push(() => this.callback())
        }
        observe(): void {}
        disconnect(): void {}
      }
    )
    render(
      <InputBoxView
        {...makeProps({
          voiceEnabled: true,
          voiceNotice: { id: 1, text: 'No speech detected', tone: 'info' }
        })}
      />
    )
    const pill = screen.getByTestId('InputBox.voiceNotice')
    const box = pill.parentElement!
    const mic = screen.getByTestId('InputBox.voice')
    const tail = screen.getByTestId('InputBox.voiceNoticeTail')
    const rect = (r: Partial<DOMRect>) => () => ({ ...new DOMRect(), ...r }) as DOMRect
    box.getBoundingClientRect = rect({ left: 0, right: 500, width: 500 })
    // A 28 px mic, centre at 426 — and the pill landed 4 px right of the mic's
    // edge (the box's border), which a fixed 9 px offset would leave off-centre.
    mic.getBoundingClientRect = rect({ left: 412, right: 440, width: 28 })
    pill.getBoundingClientRect = rect({ right: 444 })
    act(() => observers[0]())

    // 444 − 426 − 5 (half the tail square)
    expect(tail.style.right).toBe('13px')
  })
})

describe('mic states and the level ring (S3a item 5)', () => {
  function renderMic(overrides: Partial<InputBoxViewProps> = {}) {
    const listeners = new Set<(level: number) => void>()
    const subscribeVoiceLevel = vi.fn((listener: (level: number) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    })
    const props = makeProps({ voiceEnabled: true, subscribeVoiceLevel, ...overrides })
    const view = render(<InputBoxView {...props} />)
    return {
      listeners,
      subscribeVoiceLevel,
      rerender: (more: Partial<InputBoxViewProps>) =>
        view.rerender(<InputBoxView {...props} {...more} />)
    }
  }
  const mic = (): HTMLElement => screen.getByTestId('InputBox.voice')

  it('shows the ring only while recording, and subscribes only then', () => {
    const { subscribeVoiceLevel, listeners, rerender } = renderMic({ voiceState: 'connecting' })
    expect(screen.queryByTestId('InputBox.voiceLevel')).toBeNull()
    expect(subscribeVoiceLevel).not.toHaveBeenCalled()

    rerender({ voiceState: 'recording' })
    expect(screen.getByTestId('InputBox.voiceLevel')).toBeInTheDocument()
    expect(listeners.size).toBe(1)

    rerender({ voiceState: 'processing' })
    expect(screen.queryByTestId('InputBox.voiceLevel')).toBeNull()
    expect(listeners.size).toBe(0)
  })

  it('scales the ring with the level, without a React render per block', async () => {
    const { listeners } = renderMic({ voiceState: 'recording' })
    const ring = screen.getByTestId('InputBox.voiceLevel')
    for (const listener of listeners) {
      listener(0.2)
      listener(1)
    }
    // rAF-throttled: one write per frame, carrying the newest level.
    await vi.waitFor(() => expect(ring.style.transform).toBe('scale(1.45)'))
  })

  it('a silent microphone dims the mic and drops the ring', () => {
    const { listeners } = renderMic({ voiceState: 'recording', voiceSilent: true })
    expect(screen.queryByTestId('InputBox.voiceLevel')).toBeNull()
    expect(listeners.size).toBe(0)
    expect(mic()).toHaveAttribute('data-silent', 'true')
  })

  it('stamps the state, and a busy (processing) mic is not faded like a disabled one', () => {
    renderMic({ voiceState: 'processing' })
    expect(mic()).toHaveAttribute('data-state', 'processing')
    expect(mic()).toBeDisabled()
    expect(mic().className).not.toContain('opacity-15')
  })
})

// ---------------------------------------------------------------------------
// Status-line {cost} placeholder. `StatusLineData.totalCostUsd` is nullable:
// null = the engine could not price the session, and printing "$0.00" for it
// would read as "this turn was free".
// ---------------------------------------------------------------------------

describe('StatusLine — {cost} placeholder', () => {
  function renderWithCost(totalCostUsd: number | null) {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, statusLineTemplate: 'Cost: {cost}' }
    }))
    render(
      <InputBoxView
        {...makeProps({
          statusLine: {
            totalCostUsd,
            totalDurationMs: 0,
            totalApiDurationMs: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            contextWindow: { used: 0, size: 0 },
            usedPercentage: null,
            remainingPercentage: null
          }
        })}
      />
    )
    return screen.getByTestId('InputBox.statusLine')
  }

  it('renders the unknown placeholder for a null cost, not a dollar figure', () => {
    const line = renderWithCost(null)
    expect(line).toHaveTextContent('Cost: unknown')
    expect(line.textContent).not.toContain('$')
  })

  it('renders a real $0.00 for a known-zero cost', () => {
    expect(renderWithCost(0)).toHaveTextContent('Cost: $0.00')
  })

  it('renders a priced figure unchanged', () => {
    expect(renderWithCost(1.5)).toHaveTextContent('Cost: $1.50')
  })
})

// ---------------------------------------------------------------------------
// Status-line context placeholders. An engine with no known window used to
// have `{used}` STRIPPED, leaving the default template's bare `%` — a third
// spelling of "unknown" beside the em-dash a null percentage already renders.
// ---------------------------------------------------------------------------

describe('StatusLine — {used} with no context meter', () => {
  function renderContext(showContextMeter: boolean, usedPercentage: number | null) {
    useSessionStore.setState((s) => ({
      settings: { ...s.settings, statusLineTemplate: '{used}% context used' }
    }))
    render(
      <InputBoxView
        {...makeProps({
          showContextMeter,
          statusLine: {
            totalCostUsd: 0,
            totalDurationMs: 0,
            totalApiDurationMs: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            cachedTokens: 0,
            totalTokens: 0,
            contextWindow: { used: 0, size: 0 },
            usedPercentage,
            remainingPercentage: usedPercentage !== null ? 100 - usedPercentage : null
          }
        })}
      />
    )
    return screen.getByTestId('InputBox.statusLine')
  }

  it('renders the em-dash, not a bare percent sign, when the meter is unavailable', () => {
    expect(renderContext(false, null)).toHaveTextContent('–% context used')
  })

  it('renders the percentage when the meter is available', () => {
    expect(renderContext(true, 42)).toHaveTextContent('42% context used')
  })
})
