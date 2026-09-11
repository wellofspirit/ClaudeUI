/**
 * Side-effect module: registers all engine session factories.
 * Import this once during app bootstrap (e.g. from session-manager.ts).
 * Adding a new engine = add a factory registration here.
 */
import { ClaudeSession } from '../services/claude-session'
import { OpencodeSession } from '../opencode/OpencodeSession'
import { PiSession } from '../pi/PiSession'
import { CodexSession } from '../codex/CodexSession'
import { codexBinaryAvailable } from '../codex/codex-locate'
import { engineRegistry } from './EngineRegistry'
import { claudeSpawnPrep } from './claude-spawn-prep'
import { opencodeSpawnPrep } from '../opencode/opencode-spawn-prep'
import { piSpawnPrep } from '../pi/pi-spawn-prep'
import { spawnPrepRegistry } from './SpawnPrepRegistry'

engineRegistry.register(
  'claude',
  (routingId, win, cwd, opts) => new ClaudeSession(routingId, win, cwd, opts)
)

engineRegistry.register(
  'opencode',
  (routingId, win, cwd, opts) => new OpencodeSession(routingId, win, cwd, opts)
)

engineRegistry.register(
  'pi',
  (routingId, win, cwd, opts) => new PiSession(routingId, win, cwd, opts)
)

spawnPrepRegistry.register('claude', claudeSpawnPrep)
spawnPrepRegistry.register('opencode', opencodeSpawnPrep)
spawnPrepRegistry.register('pi', piSpawnPrep)
engineRegistry.register('codex', (routingId, win, cwd, opts) => {
  if (!codexBinaryAvailable())
    throw new Error('Codex is not installed for this platform; run ensure-codex on macOS arm64')
  return new CodexSession(routingId, win, cwd, opts)
})
spawnPrepRegistry.register('codex', async (model) => {
  if (!codexBinaryAvailable()) throw new Error('Codex is not installed for this platform')
  return { resolvedModel: model || undefined }
})
