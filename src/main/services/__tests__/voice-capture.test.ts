/**
 * @vitest-environment node
 *
 * Layer 1 unit tests for the voice-capture service.
 *
 * Strategy:
 *   - voice-capture.ts lazy-requires the native .node module via `require(candidate)`.
 *     We intercept Node's `Module._load` (same pattern as pty-manager.test.ts) so the
 *     loader returns our fake NativeAudioCapture object instead of touching the real
 *     prebuilt binding (which may not exist on this arch/platform in CI).
 *   - voice-capture.ts also lazy-requires 'electron' for app.getAppPath(). We route
 *     that through the same `Module._load` hook to return a minimal { app } shim.
 *   - We force `fs.existsSync` to return true for our fake candidate path so the
 *     loader reaches the `require()` step.
 *   - Module state is captured at import time — reset via `vi.resetModules()` in
 *     beforeEach so each test re-runs loadNativeModule() fresh.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Module from 'node:module'

// Controls fs.existsSync() behavior for the mocked `fs` module. Tests flip
// this to simulate "native module not present on disk".
let existsSyncImpl: (p: unknown) => boolean = (p) => {
  const s = typeof p === 'string' ? p : String(p)
  return s.includes('audio-capture')
}

// voice-capture imports `import * as fs from 'fs'` and calls fs.existsSync().
// ESM namespace exports aren't configurable, so vi.spyOn(fs, 'existsSync')
// fails. Mock the module instead — same pattern as pty-manager.test.ts for `os`.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: (p: unknown) => existsSyncImpl(p),
    default: {
      ...actual,
      existsSync: (p: unknown) => existsSyncImpl(p),
    },
  }
})

// --- Fake native module -----------------------------------------------------

interface FakeNative {
  startRecording: ReturnType<typeof vi.fn>
  stopRecording: ReturnType<typeof vi.fn>
  isRecording: ReturnType<typeof vi.fn>
  microphoneAuthorizationStatus: ReturnType<typeof vi.fn>
  startPlayback: ReturnType<typeof vi.fn>
  writePlaybackData: ReturnType<typeof vi.fn>
  stopPlayback: ReturnType<typeof vi.fn>
  isPlaying: ReturnType<typeof vi.fn>

  // Captured callbacks from the last startRecording() call, so tests can drive
  // onData / onSilence events.
  lastOnData: ((buf: Buffer) => void) | null
  lastOnSilence: (() => void) | null
  _recording: boolean
}

function makeFakeNative(): FakeNative {
  const state: { recording: boolean } = { recording: false }

  const fake: FakeNative = {
    // Filled in below so we can capture the callbacks.
    startRecording: vi.fn(),
    stopRecording: vi.fn(() => {
      state.recording = false
    }),
    isRecording: vi.fn(() => state.recording),
    microphoneAuthorizationStatus: vi.fn(() => 3),
    startPlayback: vi.fn(() => true),
    writePlaybackData: vi.fn(),
    stopPlayback: vi.fn(),
    isPlaying: vi.fn(() => false),

    lastOnData: null,
    lastOnSilence: null,
    _recording: false,
  }

  fake.startRecording.mockImplementation(
    (onData: (buf: Buffer) => void, onSilence: () => void) => {
      fake.lastOnData = onData
      fake.lastOnSilence = onSilence
      state.recording = true
      fake._recording = true
      return true
    }
  )

  return fake
}

// --- Module._load interception ---------------------------------------------

// Module-level fake swapped in/out by each test so voice-capture picks it up
// via its lazy-require path.
let currentFake: FakeNative | null = null

const origLoad = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load
;(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = function patched(
  ...a: unknown[]
): unknown {
  const request = a[0] as string
  // Route the lazy `require('electron')` call to a minimal app shim.
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => '/test/app',
        isPackaged: false,
      },
    }
  }

  // Intercept the native module require. The candidate path always contains
  // `node_modules/@anthropic-ai/claude-agent-sdk/vendor/audio-capture` and ends
  // in `audio-capture.node`. Match loosely to work on any platform.
  if (
    request.endsWith('audio-capture.node') ||
    request.includes('audio-capture')
  ) {
    if (!currentFake) {
      throw new Error('voice-capture.test: Module._load called for native module but no fake installed')
    }
    return currentFake
  }

  return origLoad.call(this, ...a)
}

// --- Silence logger ---------------------------------------------------------

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// --- Tests ------------------------------------------------------------------

describe('voice-capture', () => {
  beforeEach(() => {
    // Reset the module registry so voice-capture's top-level module state
    // (nativeModule, loadAttempted) is re-initialized each test.
    vi.resetModules()
    currentFake = makeFakeNative()
    // Default: pretend the native module is present on disk.
    existsSyncImpl = (p) => {
      const s = typeof p === 'string' ? p : String(p)
      return s.includes('audio-capture')
    }
  })

  afterEach(() => {
    currentFake = null
  })

  it('start() initiates audio capture via the native module and wires the onData callback', async () => {
    const { startRecording } = await import('../voice-capture')

    const onData = vi.fn()
    const ok = startRecording(onData)

    expect(ok).toBe(true)
    expect(currentFake!.startRecording).toHaveBeenCalledTimes(1)
    // Native module received two callbacks (wrapped onData + onSilence).
    const args = currentFake!.startRecording.mock.calls[0]
    expect(typeof args[0]).toBe('function')
    expect(typeof args[1]).toBe('function')

    // Drive a PCM chunk through and verify the consumer receives a Buffer copy.
    const pcm = Buffer.from([1, 2, 3, 4])
    currentFake!.lastOnData!(pcm)

    expect(onData).toHaveBeenCalledTimes(1)
    const received = onData.mock.calls[0][0] as Buffer
    expect(Buffer.isBuffer(received)).toBe(true)
    expect(received.equals(pcm)).toBe(true)
  })

  it('stop() calls native stopRecording() only when a session is active', async () => {
    const { startRecording, stopRecording, isRecording } = await import('../voice-capture')

    // No active session — stop() must not throw and must not call the native.
    stopRecording()
    expect(currentFake!.stopRecording).toHaveBeenCalledTimes(0)

    // Start a session, then stop it.
    expect(startRecording(vi.fn())).toBe(true)
    expect(isRecording()).toBe(true)
    stopRecording()
    expect(currentFake!.stopRecording).toHaveBeenCalledTimes(1)
    expect(isRecording()).toBe(false)
  })

  it('propagates failures: native returns false from startRecording', async () => {
    // Simulate the native binding refusing to start (e.g., mic access denied).
    currentFake!.startRecording.mockImplementation(() => false)

    const { startRecording } = await import('../voice-capture')

    const onData = vi.fn()
    const ok = startRecording(onData)

    expect(ok).toBe(false)
    expect(onData).not.toHaveBeenCalled()
  })

  it('returns false from startRecording when the native module cannot be loaded', async () => {
    // No candidate path satisfies existsSync -> loadNativeModule() returns null.
    existsSyncImpl = () => false

    const { startRecording, isVoiceCaptureAvailable } = await import('../voice-capture')

    expect(isVoiceCaptureAvailable()).toBe(false)
    expect(startRecording(vi.fn())).toBe(false)
  })
})
