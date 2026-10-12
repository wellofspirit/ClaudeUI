/**
 * How the desktop launches the voice worker (ADR-101 §4): its own binary run as
 * Node (`ELECTRON_RUN_AS_NODE=1`) on the `out/main/voice-worker.js` entry that
 * `electron.vite.config.ts` builds beside `index.js`.
 *
 * `app.getAppPath()` is the directory that CONTAINS `out/` in both layouts — the
 * repository root in development, `…/resources/app.asar` once packaged — so one
 * join serves both. Electron's Node mode reads inside an asar like the app does,
 * so the packaged script needs no unpacking. The sherpa addon is loaded from the
 * speech pack's directory in the user's store, never from the asar.
 */

import * as path from 'node:path'
import type { VoiceWorkerLauncher } from '../core/voice/local-voice-server'

export const VOICE_WORKER_ENTRY = path.join('out', 'main', 'voice-worker.js')

export function desktopVoiceWorkerLauncher(
  appPath: string,
  execPath: string = process.execPath
): VoiceWorkerLauncher {
  const script = path.join(appPath, VOICE_WORKER_ENTRY)
  return (workerArgs) => ({
    command: execPath,
    args: [script, ...workerArgs],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  })
}
