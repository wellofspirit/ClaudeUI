/**
 * Side-effect module: registers all engine session factories.
 * Import this once during app bootstrap (e.g. from session-manager.ts).
 * Adding a new engine = add a factory registration here.
 */
import { ClaudeSession } from '../services/claude-session'
import { engineRegistry } from './EngineRegistry'

engineRegistry.register(
  'claude',
  (
    routingId,
    win,
    cwd,
    effort,
    resumeSessionId,
    permissionMode,
    model,
    sandboxConfig,
    thinkingMode,
    resumeSessionAt,
    forkSession
  ) =>
    new ClaudeSession(
      routingId,
      win,
      cwd,
      effort,
      resumeSessionId,
      permissionMode,
      model,
      sandboxConfig,
      thinkingMode,
      resumeSessionAt,
      forkSession
    )
)
