/**
 * Layer 2b: the voice notice pill with its buttons on a phone — real Chromium,
 * real Tailwind, the owner's S25 Ultra size, under the app's `uiFontScale` zoom
 * (docs/testing-strategy.md).
 *
 * What jsdom cannot see: the speech-model offer is the longest voice message
 * ("Voice input for this engine needs the on-device speech model (~700 MB)") and
 * now carries an inline button, so it has to WRAP inside the space the mic leaves
 * rather than run off the screen, and the button (12 px text) must still be a
 * finger-sized target (>= 32 px) without growing the pill.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { InputBoxView, type InputBoxViewProps, type ModelDisplay } from '../View'
import {
  FONT_SCALES,
  PROFILE,
  ZoomFrame,
  byTestId,
  hasNoHorizontalOverflow,
  isInside,
  isInsideViewportX,
  rectOf,
  settle
} from '@test/helpers/mobile-layout'

const model: ModelDisplay = {
  value: 'claude-opus-4-7',
  displayName: 'Opus 4.7',
  description: 'Opus 4.7 · Latest',
  shortName: 'Opus 4.7'
}

function props(overrides: Partial<InputBoxViewProps>): InputBoxViewProps {
  return {
    textareaRef: createRef<HTMLTextAreaElement>(),
    fileInputRef: createRef<HTMLInputElement>(),
    isMobile: true,
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
    models: [model],
    selectedModel: model,
    selectedEngineId: 'opencode',
    engineLocked: false,
    showEnginePicker: true,
    effort: 'xhigh',
    effortSupported: false,
    allowedEffortLevels: [],
    thinkingMode: 'adaptive',
    adaptiveSupported: false,
    sandboxEnabled: false,
    voiceEnabled: true,
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

const OFFER = {
  id: 1,
  text: 'Voice input for this engine needs the on-device speech model (~700 MB)',
  tone: 'warn' as const,
  button: 'download' as const,
  phase: 'offer',
  lingerMs: 30_000,
  dismissible: true
}
const RUNNING = {
  id: 1,
  text: 'Downloading speech model… 42%',
  tone: 'info' as const,
  button: 'cancel' as const,
  phase: 'installing',
  lingerMs: null,
  dismissible: true,
  liveText: 'Downloading speech model…'
}

async function mount(scale: number, notice: typeof OFFER | typeof RUNNING) {
  const view = render(
    <ZoomFrame scale={scale}>
      <InputBoxView {...props({ voiceNotice: notice, voiceHeld: true })} />
    </ZoomFrame>
  )
  await settle()
  return view.container
}

afterEach(() => cleanup())

describe('voice notice pill with a button, on the phone', () => {
  for (const scale of FONT_SCALES) {
    for (const [name, notice, testid] of [
      ['the offer (Download)', OFFER, 'InputBox.voiceNoticeAction'],
      ['a running download (Cancel)', RUNNING, 'InputBox.voiceNoticeCancel']
    ] as const) {
      it(`uiFontScale ${scale}: ${name} stays on screen, wraps its text and keeps a 32 px target`, async () => {
        expect(window.innerWidth).toBe(PROFILE.width)
        const root = await mount(scale, notice)
        const pill = byTestId(root, 'InputBox.voiceNotice')
        const button = byTestId(root, testid)
        const mic = byTestId(root, 'InputBox.voice')

        // Nothing runs off the phone, or past the mic it points at.
        expect(isInsideViewportX(pill)).toBe(true)
        expect(rectOf(pill).right).toBeLessThanOrEqual(rectOf(mic).right + 1)
        expect(hasNoHorizontalOverflow(pill)).toBe(true)
        expect(isInside(button, pill.firstElementChild!, 12 * scale)).toBe(true)

        // The tail points at the middle of the mic, at every zoom.
        const tail = rectOf(byTestId(root, 'InputBox.voiceNoticeTail'))
        const mid = (r: DOMRect): number => r.left + r.width / 2
        expect(Math.abs(mid(tail) - mid(rectOf(mic)))).toBeLessThanOrEqual(2)

        // The label is whole on one line (a wrapped label would be taller than its
        // 32 px target); the text beside it wraps instead of clipping.
        expect(rectOf(button).height).toBeLessThanOrEqual(32 * scale + 1)
        expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1)
        const text = pill.querySelector<HTMLElement>('div > span.min-w-0')!
        expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth + 1)

        // The dismiss control beside it: finger-sized, on screen, and its hit area
        // does not run over the button's.
        const dismiss = byTestId(root, 'InputBox.voiceNoticeDismiss')
        expect(isInsideViewportX(dismiss)).toBe(true)
        expect(rectOf(dismiss).height).toBeGreaterThanOrEqual(32 * scale - 1)
        expect(rectOf(dismiss).width).toBeGreaterThanOrEqual(32 * scale - 1)
        expect(rectOf(dismiss).left).toBeGreaterThanOrEqual(rectOf(button).right - 1)
        expect(isInside(dismiss, pill.firstElementChild!, 12 * scale)).toBe(true)
        expect(rectOf(pill).right).toBeGreaterThanOrEqual(rectOf(dismiss).right - 12 * scale)

        // A finger-sized hit area (the pill's own height is ~26 px).
        expect(rectOf(button).height).toBeGreaterThanOrEqual(32 * scale - 1)
        expect(rectOf(button).width).toBeGreaterThanOrEqual(32 * scale - 1)
      })
    }
  }
})
