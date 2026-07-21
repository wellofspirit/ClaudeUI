/**
 * Side-effect module: registers all engine auth providers.
 * Import this once during app bootstrap (from main/index.ts or session.ipc.ts).
 * Adding a new engine = add a provider registration here.
 */
import { engineAuthRegistry } from './EngineAuthRegistry'
import { claudeAuthProvider } from './ClaudeAuthProvider'
import { opencodeAuthProvider } from './OpencodeAuthProvider'
import { piAuthProvider } from './PiAuthProvider'
import { credentialSync } from './vault/CredentialSync'

engineAuthRegistry.register('claude', claudeAuthProvider)
engineAuthRegistry.register('opencode', opencodeAuthProvider)
engineAuthRegistry.register('pi', piAuthProvider)

// M6b: wire CredentialSync's two engine feed targets here — the composition
// root. This is the ONLY place that imports both piAuthProvider/
// opencodeAuthProvider AND credentialSync together, which is what breaks the
// PiAuthProvider.ts <-> CredentialSync.ts cycle that would otherwise exist
// (PiAuthProvider drives credentialSync.beginLogin/completeLogin;
// credentialSync feeds INTO piAuthProvider/opencodeAuthProvider). Mirrors
// OpencodeServerManager.setCallerSessionLookup's dependency-injection wiring
// in main/index.ts for an analogous cycle.
credentialSync.configure({ pi: piAuthProvider, opencode: opencodeAuthProvider })
