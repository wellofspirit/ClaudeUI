/**
 * The verifier-hooks opt-in (real-app harness, ADR-027's runtime companion).
 *
 * `scripts/app-shot.mjs` can click, type and inventory `data-testid`s, but it
 * cannot read the renderer's state — so a bug that lives in the gap between
 * canonical state and what the store projected (a turn whose assistant messages
 * never render) is invisible to it. With this flag on, the renderer publishes a
 * read-only `window.__claudeuiVerifier` handle the harness can `page.evaluate()`.
 *
 * It is OFF unless asked for, in both directions and in every process: the handle
 * pins the store and the replica's canonical state on `window`, which is exactly
 * the shape a hostile page (or a plugin webview that escaped its origin guard)
 * would want. Verifier runs are ephemeral and local; normal launches are not.
 *
 * Two switches because two processes ask the question differently:
 * - MAIN reads its own argv, so `--claudeui-verifier-hooks` works on the command
 *   line, and passes the switch on to the preload via `additionalArguments`.
 * - PRELOAD runs in the renderer process, whose argv is Chromium's — the env var
 *   is inherited, the CLI switch only arrives through `additionalArguments`.
 *
 * Mirrors how `CLAUDEUI_HEADLESS` / `--claudeui-headless` are handled in
 * `src/main/index.ts`. The web client never opts in: `src/web/api-adapter.ts`
 * hardcodes false, because a remote browser is not a local harness.
 */

/** CLI switch form. Also what main forwards to the preload. */
export const VERIFIER_HOOKS_SWITCH = '--claudeui-verifier-hooks'

/** Env-var form. `'1'` and nothing else enables it. */
export const VERIFIER_HOOKS_ENV = 'CLAUDEUI_VERIFIER_HOOKS'

/**
 * True when this process was launched with the verifier hooks opt-in.
 *
 * Arguments are injectable so the decision is testable without mutating the real
 * `process`; the defaults are what main and preload actually pass.
 */
export function verifierHooksEnabled(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv
): boolean {
  return env[VERIFIER_HOOKS_ENV] === '1' || argv.includes(VERIFIER_HOOKS_SWITCH)
}
