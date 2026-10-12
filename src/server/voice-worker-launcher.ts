/**
 * How `claudeui-server` launches the voice worker (ADR-101 §4): its own
 * executable, with the `voice-worker` subcommand. No system Node is needed.
 *
 *  - a `bun build --compile` executable: the program IS the executable, and its
 *    user arguments follow it directly — `claudeui-server voice-worker …`;
 *  - from source (`bun src/server/main.ts`) or the pure-asset bundle
 *    (`bun claudeui-server.js`): the runtime is `process.execPath` and the script
 *    is `process.argv[1]`, which must be passed back.
 *
 * A compiled bun executable reports its entry as a path inside bun's virtual
 * filesystem (`/$bunfs/root/…`, `B:\~BUN\root\…` on Windows), which is how the two
 * are told apart without sniffing the runtime's name.
 */

import type { VoiceWorkerLauncher } from '../core/voice/local-voice-server'

/** The subcommand `src/server/cli.ts` dispatches to `runVoiceWorker`. */
export const VOICE_WORKER_SUBCOMMAND = 'voice-worker'

export function isCompiledBunEntry(entry: string | undefined): boolean {
  return entry !== undefined && /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(entry)
}

export function serverVoiceWorkerLauncher(
  execPath: string = process.execPath,
  entry: string | undefined = process.argv[1]
): VoiceWorkerLauncher {
  const prefix = isCompiledBunEntry(entry) || entry === undefined ? [] : [entry]
  return (workerArgs) => ({
    command: execPath,
    args: [...prefix, VOICE_WORKER_SUBCOMMAND, ...workerArgs]
  })
}
