# ADR-014: Native Anthropic OAuth via cli.js control requests, hosted on the service session

**Status:** Accepted
**Date:** 2026-06-15

## Context

ClaudeUI did no authentication of its own. It spawned `bun-claude` (cli.js) and
inherited whatever credentials cli.js already had; the README listed "a valid
API key or Max subscription" as a _prerequisite_, i.e. the user was expected to
have run `claude` in a terminal and logged in there first. There was no sign-in
UI, no token storage, no OAuth code in the app.

Two concrete pain points motivated native login (subscription / "Log in with
Claude" only — API-key auth is out of scope):

1. **No way to log in from the app.** A logged-out or fully-expired user had to
   drop to a terminal, run `claude`, and authenticate there.

2. **Expired-token errors were nearly invisible.** When the subscription token
   was dead, the first prompt produced
   `Failed to authenticate. API Error: 401 Invalid authentication credentials`,
   rendered as a **bare grey line** under the user's bubble — no card, easy to
   miss. The root cause: cli.js flags these frames with a top-level
   `isApiErrorMessage`, and `session-history.ts` honoured it on reload (building
   a styled `api_error` block), but the **live** path in
   `claude-session.ts#transformAssistantMessage` only read `message.content` and
   dropped the flag — so the same message rendered as a card after reload but as
   plain text live.

### What cli.js already provides

cli.js owns the entire subscription OAuth flow — PKCE, opening the browser, the
`127.0.0.1` loopback listener, the token exchange against
`platform.claude.com/v1/oauth/token`, and credential storage (macOS Keychain
service `Claude Code-credentials`, plaintext fallback `~/.claude/.credentials.json`,
wrapped under the `claudeAiOauth` key). It exposes this through three **native**
control-request subtypes (no patch required; see
`docs/protocol/07-control-outbound.md §7.5`), already surfaced on our QueryHandle
(`src/main/sdk/query.ts`):

| QueryHandle method               | control subtype                    | returns                          |
| -------------------------------- | ---------------------------------- | -------------------------------- |
| `claudeAuthenticate(true)`       | `claude_authenticate`              | `{ manualUrl, automaticUrl }`    |
| `claudeOAuthWaitForCompletion()` | `claude_oauth_wait_for_completion` | `{ account }` (loopback auto)    |
| `claudeOAuthCallback(code,state)`| `claude_oauth_callback`            | `{ account }` (manual paste)     |

## Decision

Drive cli.js's built-in flow rather than re-implementing OAuth in the Electron
main process.

1. **Host the flow on the long-lived `serviceSession`.** It is the genuine
   persistent control-message session (a hanging-input cli.js process that
   consumes zero API tokens), already used for usage polling, and it works
   without a project open (covers the Welcome screen). The model-detection query
   was rejected as a host because it is spawned-and-aborted immediately after
   reading `supportedModels()`. `serviceSession` gains a typed
   `getControlHandle()`; a new `auth-manager.ts` owns the orchestration (SRP).

2. **`signIn()` resolves at "authorizing"; the result arrives via broadcast.**
   It calls `claudeAuthenticate`, parses `state` from the returned `manualUrl`,
   `shell.openExternal(automaticUrl)`, then awaits
   `claudeOAuthWaitForCompletion()` **in the background**. The IPC call returns
   the `authorizing` snapshot; the terminal `success`/`error` transition is
   pushed over the `auth:state` event. A monotonic `flowId` + `settled` guard
   make the loopback wait and an optional manual paste race the same flow
   idempotently.

3. **Manual paste is code-only.** `state` is recovered from the login URL we
   already hold, so the fallback asks the user for the authorization code alone,
   then calls `claudeOAuthCallback(code, state)`.

4. **Converge the live and history `api_error` paths.** `handleAssistantMessage`
   detects surfaced API-error frames (main channel only) and emits a
   `role:'system'` message with an `api_error` block — identical to the history
   path. This fixes the bare-text bug for **all** on-the-fly API errors, not just
   auth. **Detection signal:** the SDK stdout assistant frame does **not** carry
   the disk transcript's `isApiErrorMessage` / `apiErrorStatus` fields — it
   carries a top-level **`error`** code (e.g. `"authentication_failed"`) instead,
   while benign synthetic frames (`"No response requested."`) have no `error`. So
   the live guard is `isApiErrorMessage === true || typeof error === 'string'`.
   `classifyApiError(text, errorCode)` (extracted to a pure `api-error.ts` for
   testability) maps the frame to a stable `errorType` — the `error` code wins
   over the text heuristic; `'authentication'` is the bucket the renderer keys
   off. The matching `result` frame arrives as `subtype:'success'` with
   `is_error:true`, so `handleResultMessage`'s non-success branch correctly does
   not double-report it.

5. **Inline auth card, not a modal.** The renderer's `ApiErrorBlock` gains an
   `AuthErrorBlock` variant (FloatingApproval-styled) for `errorType ===
   'authentication'`: Log in / Dismiss → authorizing spinner (with a manual-paste
   fallback) → signed-in + Retry. **Only the card that initiated the login follows
   the global flow state** (a local `initiated` flag); other and newly-arrived
   error cards stay in the error state, so a retry that re-fails does not inherit
   a stale "success" and loop.

   **Retry must respawn the session.** The cli.js process is persistent (spawned
   once per session, prompts pushed to a channel) and caches its credential for
   its lifetime — it does **not** re-read after a login completes in the separate
   `serviceSession` process. So `store.retrySend` calls `createSession` (which
   `session-manager` recreates: it cancels the stale process and spawns a fresh
   one that re-reads the new credential, resuming history) and only then
   `sendPrompt`. Plain `sendPrompt` would push to the stale, still-401ing process
   — the cause of an observed retry loop. On login success the active session is
   also marked `sdkInactive` so a normal (non-Retry) send respawns the same way.

6. **Proactive banner is scoped to "logged out", driven by the initialize
   response `account`.** `AuthBanner` shows only when cli.js's initialize response
   carries no `account.email` (broadcast as `session:auth-source` = `'none'`).
   Note `apiKeySource` is **not** the signal: it reports the *API-key* source and
   is legitimately `"none"` for every logged-in *subscription* (OAuth-token) user,
   so keying off it falsely flags subscribers as logged out. A logged-out cli.js
   returns an account with no email (`tokenSource:"none"`); an expired-but-cached
   login still has an email — that 401s on send and is handled by the reactive
   card, not this banner. We do **not** read the credential store ourselves:
   doing so via the `security` CLI spawns a process whose code signature is not in
   the Keychain item's ACL (the item was created by Claude), so macOS shows a
   "**security** wants to use your confidential information" prompt on **every**
   read. Sourcing login state from the init response avoids the Keychain entirely
   — zero prompts.

7. **Remote: read-only.** `auth:status` is forwarded to remote clients;
   `auth:sign-in` / `submit-code` / `cancel` are blocklisted on the remote
   dispatcher — they open a local browser + loopback listener on the desktop
   host and are a credential vector over the wire. The web `api-adapter` throws
   for the mutating methods.

### Rejected alternative

**Re-implement OAuth in the Electron main process** (PKCE + loopback + token
exchange + `claudeAiOauth` Keychain write). Rejected: it duplicates cli.js's
client_id, endpoints, scopes, and storage format — all of which change across
cli.js versions — making us own a parallel copy that silently drifts. Driving
the native control requests keeps a login from the app indistinguishable from a
`claude` CLI login, and `/logout` + refresh keep working.

## Consequences

- **We never touch cli.js's credential store.** All credential reads/writes stay
  inside cli.js (it owns the Keychain ACL trust). Login state comes from the
  initialize response `account`; flow results from the OAuth control-request
  response. This
  eliminates the macOS `security` trust prompts an earlier iteration caused by
  shelling out to `security find-generic-password`.
- The api_error convergence is a behavioural change for **all** API errors:
  previously-bare live error text now renders as the structured card.
- **Deferred:** multi-account support (the flow is single-credential), and a
  dedicated logout action (cli.js exposes no logout control subtype).

## Touch points

- `src/main/services/service-session.ts` — `ServiceControlHandle`, `getControlHandle()`
- `src/main/services/auth-manager.ts` — flow orchestration (new)
- `src/main/services/api-error.ts` — `classifyApiError` (new, pure)
- `src/main/services/claude-session.ts` — `isApiErrorMessage` interception
- `src/main/ipc/session.ipc.ts`, `src/preload/index.ts`, `src/shared/types.ts` — IPC + `AuthState`
- `src/main/services/remote-dispatcher.ts` — blocklist; `src/web/api-adapter.ts` — stubs
- `src/renderer/.../MessageBubble.tsx` (`AuthErrorBlock`), `AuthBanner.tsx`,
  `stores/session-store.ts`, `hooks/useClaudeEvents.ts`
