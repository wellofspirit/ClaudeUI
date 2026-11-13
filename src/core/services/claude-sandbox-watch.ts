/**
 * Watches the user settings file Claude Code shares with ClaudeUI for an outside change to its
 * `sandbox` block (the terminal, a hand edit, a synced dotfile) and announces it, so every
 * client shows the shared switch without a restart (ADR-009).
 *
 * Same approach as `startConfigWatcher`: `fs.watchFile` stat polling, which tolerates atomic
 * writes and reads current content. The file is never created here.
 */

import * as fs from 'node:fs'
import { claudeUserSettingsPath, readClaudeSandboxState } from './claude-sandbox-settings'
import { emitEvent, syncCore } from './sync-host'
import { deepEqual } from '../../shared/opencode-config-diff'

const POLL_MS = 1000

export function startClaudeSandboxWatcher(): () => void {
  const filePath = claudeUserSettingsPath()
  fs.watchFile(filePath, { interval: POLL_MS }, () => {
    // null: the file is mid-write or unparsable; keep the last good state.
    const state = readClaudeSandboxState()
    if (!state) return
    // Equal to canonical: an edit that left the block alone, or ClaudeUI's own save (its
    // handler's event already updated canonical).
    if (deepEqual(syncCore.getCanonicalState().claudeSandbox, state)) return
    emitEvent('config:claude-sandbox-changed', [state])
  })
  return () => fs.unwatchFile(filePath)
}
