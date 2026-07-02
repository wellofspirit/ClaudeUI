/**
 * Side-effect module: registers all engine session factories.
 * Import this once during app bootstrap (e.g. from session-manager.ts).
 * Adding a new engine = add a factory registration here.
 */
import { ClaudeSession } from '../services/claude-session'
import { OpencodeSession } from '../opencode/OpencodeSession'
import { engineRegistry } from './EngineRegistry'
import { claudeSpawnPrep } from './claude-spawn-prep'
import { opencodeSpawnPrep } from '../opencode/opencode-spawn-prep'
import { spawnPrepRegistry } from './SpawnPrepRegistry'

engineRegistry.register(
  'claude',
  (routingId, win, cwd, opts) => new ClaudeSession(routingId, win, cwd, opts)
)

engineRegistry.register(
  'opencode',
  (routingId, win, cwd, opts) => new OpencodeSession(routingId, win, cwd, opts)
)

spawnPrepRegistry.register('claude', claudeSpawnPrep)
spawnPrepRegistry.register('opencode', opencodeSpawnPrep)
