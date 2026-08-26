/**
 * Safe working directory for persisted SDK sessions (title gen, commit msg, model fetch, service session).
 *
 * On macOS, Electron apps launched from Finder have process.cwd() = ~, so the SDK's CLI
 * subprocess would scan the entire home directory for config files, triggering TCC privacy
 * prompts. We use a dedicated directory under ~/.claude/ui/ instead.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

export const PERSISTED_SESSIONS_DIR = path.join(os.homedir(), '.claude', 'ui', 'persisted-sessions')

// Ensure the directory exists at import time
if (!fs.existsSync(PERSISTED_SESSIONS_DIR)) {
  fs.mkdirSync(PERSISTED_SESSIONS_DIR, { recursive: true, mode: 0o700 })
}
