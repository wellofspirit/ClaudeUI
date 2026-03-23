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
 * Attempt to load the native audio capture module from the SDK vendor directory.
 * Returns null if the module is not available for this platform/arch.
 */
function loadNativeModule(): NativeAudioCapture | null {
  if (loadAttempted) return nativeModule
  loadAttempted = true

  const platform = process.platform
  const arch = process.arch
  const triple = `${arch}-${platform}`

  // Lazy-require to avoid accessing electron.app before it's ready.
  // Top-level import of 'electron' triggers @electron-toolkit/utils which
  // reads app.isPackaged at module evaluation time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')

  // In production, the SDK is in app.asar.unpacked
  const appPath = app.getAppPath()
  const basePath = appPath.includes('app.asar')
    ? appPath.replace('app.asar', 'app.asar.unpacked')
    : appPath

  const candidates = [
    path.join(
      basePath,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'vendor',
      'audio-capture',
      triple,
      'audio-capture.node'
    ),
    // Dev mode — resolve from project root
    path.join(
      process.cwd(),
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
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
 * Start recording audio from the default microphone.
 * @param onData Called with raw PCM chunks (~342 bytes each, ~11ms intervals)
 * @param onSilence Called when silence is detected (optional, depends on platform)
 * @returns true if recording started successfully
 */
export function startRecording(onData: (buffer: Buffer) => void, onSilence?: () => void): boolean {
  const mod = loadNativeModule()
  if (!mod) {
    logger.error('VoiceCapture', 'Cannot start recording — native module not loaded')
    return false
  }

  if (mod.isRecording()) {
    mod.stopRecording()
  }

  return mod.startRecording((data) => onData(Buffer.from(data)), onSilence ?? (() => {}))
}

/** Stop recording */
export function stopRecording(): void {
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
