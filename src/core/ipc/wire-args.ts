/**
 * `opt` — the one place a JSON-null optional argument becomes `undefined` again.
 *
 * It lived in `remote-handlers.ts` until the command modules were swept for the
 * same defect class, which is where it stopped being a remote-transport concern:
 * the channels `config-commands.ts` / `auth-commands.ts` / `ide-commands.ts` and
 * their siblings expose are registered from ONE transport-agnostic declaration
 * that BOTH `session.ipc.ts` and `remote-handlers.ts` spread, so the
 * normalisation has to come from a module neither registrar owns. Behaviour is
 * unchanged — the move is a move.
 *
 * ---------------------------------------------------------------------------
 *
 * Normalise an OMITTED optional argument back to `undefined`.
 *
 * The web client marshals `invoke` arguments as JSON (`src/web/connection.ts`
 * sends `{ type: 'invoke', id, channel, args }`), and a JSON array cannot carry
 * a hole: an argument the caller left out arrives here as an explicit `null`.
 * Electron IPC preserves `undefined`, which is why only the remote transport
 * ever sees this. It is NOT limited to call sites that pass `undefined` on
 * purpose — `src/web/api-adapter.ts` forwards every DECLARED parameter
 * positionally, so a renderer call that simply stops short of the last argument
 * still puts a `null` on the wire.
 *
 * `null` is not "unset" to the shared code behind these handlers — several
 * places distinguish unset with `=== undefined` (`CodexSession.validateEffort`
 * threw "Codex reasoning effort is unavailable for the selected model" on every
 * fresh web-client Codex session because of exactly this), and the rest declare
 * the parameter `?: T`, which `null` does not satisfy. So every optional
 * argument is put back through here at the handler boundary rather than
 * teaching each service to accept two spellings of "nothing".
 *
 * Two further shapes were found in the command modules, and they are worth
 * naming because neither announces itself at the call site:
 *
 *  - **A `null` that PERSISTS.** `{ ...previous, defaultModel: modelId }` keeps
 *    the key when `modelId` is `null` and drops it when it is `undefined`, so
 *    the value reaches a config file. `shared-provider:set-default`'s did worse
 *    than corrupt one: `SharedProviderRepository.isRoute` accepts
 *    `defaultModel === undefined` or a non-empty string and nothing else, and
 *    `save()` validates before writing — so clearing a shared provider's default
 *    model from the web client threw "Invalid shared provider routes" and
 *    cleared nothing.
 *  - **A `!== undefined` that builds a request BODY.**
 *    `OpencodeClient.oauthCallback` spreads `code` into the POST payload when it
 *    is not `undefined`; opencode types that field `Schema.optional(Schema.String)`,
 *    which rejects an explicit `null`.
 *
 * Deliberately NOT applied where `null` is a MEANINGFUL value the caller sent
 * on purpose — `session:set-account`, `session:set-reasoning-variant`,
 * `usage:set-account-filter`, `webauthn:rename` all declare `T | null` and mean
 * "clear it" by it — nor where the parameter is only tested for truthiness and
 * `null` already reads as the omitted case (`session:stop-task`'s `isDispatch`,
 * `usage:chatgpt-limits`' `refresh`, `terminal:create`'s `index`, which the
 * terminal service already types `number | null`, and the whole `cwd?: string`
 * family behind `opencode-agents:*` / `mcp:save-servers` / `mcp:remove-server`,
 * whose consumers all branch on `cwd ? … : …` or `if (!cwd) throw`).
 *
 * Note `??`, not a `=== null` test: `opt` must not swallow a falsy value the
 * caller really sent (`forkSession: false` is pinned by a test for exactly
 * this).
 *
 * An argument the transport delivers inside an OBJECT payload needs none of
 * this — `JSON.stringify` omits an object key whose value is `undefined`, so
 * `ide:mint-entry`'s `{ folder, themeKind? }` and `authcfg:apply`'s patch arrive
 * with the key absent rather than null. Positional arguments are the whole of
 * the problem.
 */
export function opt<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined
}
