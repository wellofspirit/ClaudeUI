/**
 * Side-effect module: registers all engine auth providers.
 * Import this once during app bootstrap (from main/index.ts or session.ipc.ts).
 * Adding a new engine = add a provider registration here.
 */
import { engineAuthRegistry } from './EngineAuthRegistry'
import { claudeAuthProvider } from './ClaudeAuthProvider'

engineAuthRegistry.register('claude', claudeAuthProvider)
