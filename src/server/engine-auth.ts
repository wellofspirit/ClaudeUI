/**
 * Which engines the HEADLESS server can drive a sign-in for.
 *
 * Split out of `main.ts` so it can be tested without booting a server: `main.ts`
 * is an entry module with top-level side effects, and this decision is the one
 * that says whether a phone can sign in to ChatGPT at all.
 *
 * THE RULE, and why it is not "desktop only" any more (ADR-068 §3, Slice 7):
 *
 *  · `pi` — ALLOWED. Its ChatGPT sign-in is the shared auth vault's, not pi's:
 *    `PiAuthProvider` lives in `src/core` with no Electron import, and
 *    `credentialSync.start()` already runs on this process (`core/boot/core-services.ts`).
 *    Device code (`vendor-auth:device-code-start`) exists FOR this deployment —
 *    ADR-068 §3 reserved it for the headless server — and paste-back (ADR-057)
 *    works here too. Refusing it was the last thing standing between a headless
 *    user and a ChatGPT account.
 *  · `codex` — ALLOWED, as before. Its provider reads the same vault.
 *  · `claude` — refused. The flow runs INSIDE cli.js, driven by the desktop's
 *    AuthManager, and there is no headless equivalent yet.
 *  · `opencode` — refused. Its loopback lives inside the host's opencode server
 *    process, which a remote browser cannot reach (the same fact
 *    `ipc/auth-commands.ts` already refuses a remote `auto` on).
 *
 * The channels stay REGISTERED either way — the remote surface must not depend
 * on which host it is talking to, or the UI would be a different app on a server
 * than on a desktop — so a refused engine fails loudly with a message naming the
 * reason rather than going missing.
 */
import type { EngineId } from '../shared/types'
import type { EngineAuthProvider } from '../core/auth/EngineAuthProvider'
import { codexAuthProvider } from '../core/auth/CodexAuthProvider'
import { piAuthProvider } from '../core/auth/PiAuthProvider'

/** Refusal text for the two engines whose flows really are desktop-bound. */
export const DESKTOP_ONLY_SIGN_IN_MESSAGE =
  'Only Claude and opencode sign-ins are desktop-only: Claude’s runs inside cli.js and ' +
  'opencode’s inside its own server process. Sign in to those on the desktop app — the ' +
  'credential vault is shared. ChatGPT signs in here, by device code or paste-back.'

/** The headless server's `AuthCommandDeps.requireEngineAuth`. Throws for an engine it cannot drive. */
export function requireServerEngineAuth(engineId: EngineId): EngineAuthProvider {
  if (engineId === 'codex') return codexAuthProvider
  if (engineId === 'pi') return piAuthProvider
  throw new Error(DESKTOP_ONLY_SIGN_IN_MESSAGE)
}
