/**
 * Voice capture service — loads the SDK's native audio-capture.node NAPI module
 * and provides a typed interface for microphone recording.
 *
 * The native module outputs 16kHz, 16-bit signed LE, mono PCM — exactly the
 * format expected by the Deepgram speech-to-text API (via Anthropic's proxy).
 *
 * The module ships prebuilt for all platforms:
 *   vendor/audio-capture/{arch}-{platform}/audio-capture.node
 */

import * as path from 'path'
import * as fs from 'fs'
import { logger } from './logger'
import { getAppPath } from '../host'

interface NativeAudioCapture {
  startRecording(onData: (buffer: Buffer) => void, onSilence: () => void): boolean
  stopRecording(): void
  isRecording(): boolean
  microphoneAuthorizationStatus(): number // 0=notDetermined, 1=denied, 2=restricted, 3=authorized
  startPlayback(onReady: () => void, onFinish: () => void): boolean
  writePlaybackData(data: Buffer): void
  stopPlayback(): void
  isPlaying(): boolean
}

let nativeModule: NativeAudioCapture | null = null
let loadAttempted = false

/**
 * Attempt to load the native audio capture module from the vendored CLI
 * directory. Returns null if the module is not available for this
 * platform/arch.
 */
function loadNativeModule(): NativeAudioCapture | null {
  if (loadAttempted) return nativeModule
  loadAttempted = true

  const platform = process.platform
  const arch = process.arch
  const triple = `${arch}-${platform}`

  // Production: vendor/claude-cli is shipped as extraResources → <Resources>/claude-cli.
  // Dev mode: vendor/claude-cli/ at project root (populated by scripts/extract-cli.mjs).
  // `getAppPath()` is the core HostPaths seam — the desktop wires it to
  // `app.getAppPath()`; outside Electron it falls back to `process.cwd()`.
  const appPath = getAppPath()
  const candidates = [
    // Production extraResources
    path.join(
      path.dirname(appPath),
      'claude-cli',
      'vendor',
      'audio-capture',
      triple,
      'audio-capture.node'
    ),
    // Dev
    path.join(
      process.cwd(),
      'vendor',
      'claude-cli',
      'vendor',
      'audio-capture',
      triple,
      'audio-capture.node'
    )
  ]

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      nativeModule = require(candidate) as NativeAudioCapture
      logger.info('VoiceCapture', `Loaded native audio module from ${candidate}`)
      return nativeModule
    } catch (err) {
      logger.error('VoiceCapture', `Failed to load native audio module from ${candidate}: ${err}`)
    }
  }

  logger.warn('VoiceCapture', `Native audio module not found for ${triple}`)
  return null
}

/** Check if native audio capture is available on this platform */
export function isVoiceCaptureAvailable(): boolean {
  return loadNativeModule() !== null
}

/** Get microphone authorization status (macOS). 0=notDetermined, 3=authorized */
export function getMicrophoneStatus(): number {
  const mod = loadNativeModule()
  if (!mod) return 0
  return mod.microphoneAuthorizationStatus()
}

/**
 * Who holds the microphone. The native module is ONE process-wide recorder, so
 * an unscoped stop — a second session's release, a cancelled start — would cut
 * off whoever is recording now. Stops are therefore owner-scoped; a start by a
 * new owner is a takeover (the newest press wins).
 */
let currentOwner: object | null = null

/**
 * Start recording audio from the default microphone.
 * @param onData Called with raw PCM chunks (~342 bytes each, ~11ms intervals)
 * @param owner Who this capture belongs to; only it can {@link stopRecording} it
 * @param onSilence Called when silence is detected (optional, depends on platform)
 * @returns true if recording started successfully
 */
export function startRecording(
  onData: (buffer: Buffer) => void,
  owner: object,
  onSilence?: () => void
): boolean {
  const mod = loadNativeModule()
  if (!mod) {
    logger.error('VoiceCapture', 'Cannot start recording — native module not loaded')
    return false
  }

  if (mod.isRecording()) {
    mod.stopRecording()
  }

  const started = mod.startRecording((data) => onData(Buffer.from(data)), onSilence ?? (() => {}))
  currentOwner = started ? owner : null
  return started
}

/** Stop recording — only if `owner` still holds the microphone. */
export function stopRecording(owner: object): void {
  if (owner !== currentOwner) return
  currentOwner = null
  const mod = loadNativeModule()
  if (!mod) return
  if (mod.isRecording()) {
    mod.stopRecording()
  }
}

/** Check if currently recording */
export function isRecording(): boolean {
  const mod = loadNativeModule()
  if (!mod) return false
  return mod.isRecording()
}
