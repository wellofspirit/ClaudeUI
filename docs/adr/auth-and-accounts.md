# Authentication, accounts and the credential vault

Governs: `src/core/auth/`, `src/core/services/claude-host-token.ts`, `src/core/services/claude-refresh-guard.ts`, `src/core/services/api-error.ts`, `src/core/sdk/host-token.ts`, `src/core/sdk/securestorage-env.ts`, `src/core/sdk/args.ts`, `src/core/ipc/auth-commands.ts`, `src/core/shared-providers/`, `src/main/auth/`, `src/main/services/auth-manager.ts`, `src/main/services/account-manager.ts`, `src/main/services/claude-login-backend.ts`, `src/renderer/src/components/auth/`, `src/renderer/src/components/chat/AuthPill.tsx`

How ClaudeUI signs in to vendors and holds their credentials: the engine-neutral auth interface, Claude sign-in
(cli.js's own for one account, in-app for several), the host-owned Claude token handed to every spawn, the
vault-owned ChatGPT identity that feeds pi and opencode, remote sign-in by paste-back, and the one sign-in
surface (pill, transcript row, dialog). Shared provider routing and the plaintext vault file (the second
ADR-037), provider surfaces (ADR-074) and custom endpoints (ADR-086) are in `providers-and-models.md`.
Remote-access login (passkeys, step-up: ADR-052, ADR-054, ADR-056, ADR-063) is `remote-access.md`. Account keys
in metering (ADR-071) are `metering.md`; provider Disable/Remove (ADR-044) and the engine-side credential rows
of opencode 2.x (ADR-097 §5, which applies a credential change to the next request with no server recycle) are
`opencode.md`; managed-store feed and disconnect rules of ADR-082 §8 are `harness-installs.md`.

## Auth is one neutral interface, capability-gated per engine (ADR-021)

Each engine has an `EngineAuthProvider` (`src/core/auth/EngineAuthProvider.ts`), gated by
`capabilities.auth { canDriveLogin, multiAccount }` (ADR-018): `signIn`/`submitCode`/`cancelSignIn` need
`canDriveLogin`, `addAccount`/`switchAccount`/`deleteAccount` need `multiAccount` (Claude only), and the per-vendor
methods (`oauthAuthorize`, `oauthCallback`, `setVendorApiKey`, `removeVendorAuth`, device-code start/status) are
the optional `canDriveLogin` surface of multi-vendor engines. The engine-keyed `vendor-auth:*` channels carry the
per-vendor methods; Claude's `auth:*` and `account:*` channels are separate.

- **Probe.** `probe()` returns `VendorAuthMap = Record<VendorId, AuthStatus>`; `AuthStatus` carries
  `authState`, `billingType` (subscription, apiKey or free, inferred at the probe so metering consumes it), an
  optional label and `requiresLogin`. `AuthState` is the resolved tri-state `authenticated | unauthenticated |
unknown`; the in-flight flow type is `AuthFlowState`. `unknown` never renders as signed out.
- **Trust the engine, do not read its credentials.** Login state comes from the engine (Claude's initialize
  response, opencode's probe), so a login check never touches a Keychain or a credential file of an engine that
  owns it. A 401-class error (`classifyApiError` to `authentication` for Claude, a `provider.auth` turn
  failure for opencode, a 401 or 403 from pi) raises that engine's re-login affordance; 429 and 5xx are not sign-in problems.
- **The account registry is Claude-only.** Account metadata lives in the operational database; Claude's
  credentials stay files the app owns (below).
- **Subscription OAuth is non-load-bearing.** Third-party OAuth is a moving target, so an engine whose loopback
  subscription OAuth cannot be driven reliably defaults to delegation; never advertise a flow that cannot
  complete (ADR-030).
- Where opencode 2.x keeps credentials, and what it is handed, is ADR-097 §5 (`opencode.md`), which replaced this
  ADR's opencode `auth.json` and `PUT /auth/{vendor}` description.

## Claude single-account sign-in is cli.js's own flow (ADR-014)

With multi-account off, sign-in drives cli.js's built-in subscription OAuth through its native control requests
(`claude_authenticate`, `claude_oauth_wait_for_completion`, `claude_oauth_callback`;
`docs/protocol-cc/07-control-outbound.md` §7.5) on the long-lived service session, behind `ClaudeLoginBackend`
(`CliLoginBackend` in `src/main/services/claude-login-backend.ts`). `AuthManager` owns the flow state machine. cli.js
stores the login in the user's own Claude Code credential store (Keychain on macOS, file elsewhere) and refreshes
it; the login is indistinguishable from a terminal `claude` login, which is why this path was chosen over
re-implementing OAuth in Electron (the client id, endpoints, scopes and storage format drift per cli.js version).

- **Sign-in state never comes from cli.js's credential store.** On macOS a spawned `security` process is not in the
  Keychain item's ACL and prompts on every read. Login state is the initialize response's `account` (no `account.email`
  means logged out, broadcast as `session:auth-source`); `apiKeySource` is not the signal (it is `none` for every
  subscriber). An expired-but-cached login still has an email and fails on send, which the reactive row handles.
- **`signIn()` resolves at "authorizing".** It returns the `authorizing` snapshot; the terminal `success` or
  `error` arrives on `auth:state`. A monotonic flow id plus a settled guard make the loopback wait and a manual
  paste race one flow idempotently. The flow is hosted on the service session because it exists without a project
  open (the Welcome screen).
- **The manual paste is `code#state`** (ADR-057 §sign-in). The state comes from the paste when it contains `#`; the
  state the app holds from the authorize URL is used only for a paste without `#`. A half-copied paste is reported
  without settling the flow, so the same flow accepts the next attempt.
- **The usage poll is the one reader of cli.js's store in single-account mode.** `UsageFetcher.fetchDirect` reads
  `~/.claude/.credentials.json` (and on macOS falls back to `security find-generic-password -s "Claude Code-credentials"`)
  and `authorizedOAuthGet` may refresh an expired or 401 token, writing the rotated token back to the file
  (`refreshClaudeToken`), under ADR-071 §6's guard. It never decides sign-in state. Open code question: on macOS in
  single-account mode a Keychain credential refreshed this way is written to the file, which may leave the Keychain
  copy holding a spent refresh token.
- **A login does not reach a running process.** cli.js caches its credential for the process lifetime, so a
  successful sign-in cancels every live Claude session (`invalidateLiveSessions`); the next send respawns and
  resumes under the new credential. A retry that pushed to the stale process would loop on the 401.
- **A surfaced API error is one structured transcript row on every path.** The live assistant frame carries a
  top-level `error` code (not the transcript's `isApiErrorMessage`), so the guard is `isApiErrorMessage === true ||
typeof error === 'string'`; `classifyApiError(text, errorCode)` (`api-error.ts`) lets the code win over the text
  heuristic, and `authentication` is the bucket the sign-in row keys off. The matching `result` frame is
  `success` with `is_error`, so the result handler does not double-report it.
- There is no logout control request in cli.js, so single-account mode has no in-app logout.
- Remote callers are not read-only: sign-in works remotely by paste-back (ADR-057). The banner and the in-transcript
  login card this ADR introduced are gone (ADR-068 §3, ADR-070).

## Claude multi-account credentials are host-owned (ADR-015, ADR-080)

Multi-account is an opt-in setting (`AccountManager.setEnabled`; off by default). The record of which mode is on is
`accounts.json` (`enabled`, `activeId`) beside the account dirs; account metadata (email, subscription, organization,
account and organization uuids) is in the operational database, and **credentials never enter the database**.

- **One directory per account.** `~/.claude/ui/accounts/<id>/` (mode 0700) holds only `.credentials.json`
  (0600, cli.js's `claudeAiOauth` shape), written **only by the app**, at sign-in and at every refresh. cli.js never
  reads or writes it. Settings, `projects/` history and usage stay shared in `~/.claude`. Deleting an account
  removes its row and its directory.
- **Plaintext on purpose.** The file is the explicit trade for prompt-free switching and a refresher the app
  controls, the same shape cli.js uses headless. No Keychain is in the multi-account path on any platform, so a
  macOS user re-signs in once when enabling it.
- **Switch = change the active dir and respawn.** `AccountManager.persistAndApply` publishes the active dir
  (`setSecurestorageEnv`, a name that predates the host token and now just means "the active account dir") and,
  only when the effective dir actually moved, stops the service session and cancels every live Claude session
  (`invalidateLiveSessions`). Re-saving the same pointer, or deleting a non-active account, cancels nothing.
- **Every spawn is handed the active account's token by environment, the way Claude Desktop hands it.** `buildEnv`
  (`src/core/sdk/args.ts`) sets `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`,
  `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER` and `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1` (which,
  together with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, is the gate for cli.js asking the host for a token on a 401;
  changing the entrypoint silently disables `oauth_token_refresh`), and removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS` and any inherited `ANTHROPIC_BASE_URL`, so the account's token never reaches a gateway
  named in the user's shell. An inherited `CLAUDE_CODE_OAUTH_TOKEN`, the retired `SKIP_SECURESTORAGE` /
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` pair and inherited identity variables are deleted first: the active dir is
  authoritative. cli.js keeps the token, subscription, tier and refresh variables out of its children (Bash, MCP,
  hooks).
- **Identity pair.** `CLAUDE_CODE_ACCOUNT_UUID` and `CLAUDE_CODE_ORGANIZATION_UUID` are set, both or neither, from
  the account row. Without them cli.js keys its served model-catalog cache by a hash of the access token and every
  rotation starts cold (the picker loses gated models); with them the key is the account's. Both-or-neither because
  one alone would pair the account with the shared `~/.claude.json` org. The sign-in records the pair
  (`AccountManager.noteLogin`), and the usage poll fills it for older accounts.
- **Fail closed.** A spawn that cannot be given the active account's token throws `HostTokenUnavailableError`
  (`signed-out`, `needs-sign-in` or `unavailable`, with a user-facing message); it never falls through to the
  machine's default Claude login, which belongs to whoever ran `claude` in a terminal. No keeper wired counts as no
  token. Callers that surface spawn errors show the message as it stands.
- **One keeper per account, in core** (`ClaudeHostTokenKeeper`, `src/core/services/claude-host-token.ts`; the SDK
  layer sees it only as `HostTokenSource`, `sdk/host-token.ts`). Before a spawn it refreshes a token that expires
  within 5 minutes and refuses the spawn if none is usable. While a process runs, a timer renews at
  `expiresAt - min(5 min, remaining/2)`, at most 6 h out, never sooner than 60 s after the last token write,
  retrying a transient failure after 60 s. Any rotation of the active file's token (timer, usage read, answer) is
  pushed to every live process of the active account with `update_environment_variables`.
- **`oauth_token_refresh` (sent by cli.js on a 401) is answered with a token or with none and why:**
  `identity_changed` (the process is not on the active account), `signed_out`, `refresh_failed` (refused),
  `transient`. Answers are single-flight per session. Declining fails the turn with cli.js's own 401 text.
- **Every refresh goes through the one single-flight `refreshClaudeToken`** and the refresh guard of ADR-071 §6
  (`claude-refresh-guard.ts`, keyed per file): at most one attempt per version of the credentials file, and a refusal
  marks the account as needing sign-in until the file changes. A 408, 429 or 5xx from the token endpoint is not a
  refusal. For multi-account this closes the old race over a single-use rotating refresh token between cli.js and the app; in
  single-account mode cli.js and the usage poll still both refresh the one store.
- **Login state in this mode comes from the credential, not cli.js.** Under an env token cli.js's initialize
  `account` carries no email, so `hostTokenLogin()` answers (file present and not refused on its current version).
- **Scope.** Multi-account only. Single-account mode keeps the user's own login, stored and refreshed by cli.js and
  inheriting the shell environment untouched. A custom endpoint profile brings its own credential and wins: no host
  token is handed (`hostTokenDir()`).
- **Never done:** multi-account never touches the Keychain or cli.js's store (single-account's usage poll is described above); a
  Claude subscription token is never vended to a non-Claude harness (Anthropic's terms confine it to the
  first-party harness).
- **`~/.claude.json`'s `oauthAccount` is not an identity source.** It is shared, and cli.js rewrites it at most daily
  per process, so under several accounts it names whichever process refetched last (including a terminal
  `claude`). Which account a directory holds is resolved from that directory's own credentials through the profile
  endpoint (ADR-071 §3, `metering.md`).
- **Accepted costs.** MCP OAuth tokens (`mcpOAuth`) live in cli.js's default store and are shared by all accounts
  (as between Desktop and a terminal `claude`). cli.js's managed `forceLoginMethod` / `forceLoginOrgUUID` policy is not
  enforced on this path (the app reads no managed settings). The `skip-securestorage` patch is deleted; the
  harness runs unpatched on this path. The authorize and exchange details join the CLI-bump re-check list
  (`docs/protocol-cc/12-maintenance.md` §12.1).

### In-app Claude sign-in (ADR-080 decision 2)

Why in-app: cli.js's `claude_authenticate` stores what it gets in cli.js's own store (the Keychain on macOS), so the token
never reaches the account file. Rejected, likely to come back: a per-account `CLAUDE_CONFIG_DIR` (also symlinks, or a
per-account Keychain service) fragments settings, history and usage and still needs Keychain reads, which prompt; keeping
the patch for sign-in only leaves the patch to re-anchor and works only on the patched harness; forcing a file store
without a patch is not possible on macOS (Keychain-primary, and the first Keychain write deletes the file).

Multi-account sign-in is the app's (`src/core/auth/claude-oauth.ts`, `InAppLoginBackend`): cli.js's claude.ai login
reproduced (authorize URL and scopes, PKCE, a loopback on `127.0.0.1` port 0 with a `http://localhost:<port>/callback`
redirect, or the pasted `code#state` against the manual redirect, the JSON exchange, the profile and roles reads),
writing the account dir's `.credentials.json`. The backend is chosen per flow when it starts (in-app when multi-account
has an active dir, else cli.js) and captures its dir then: a switch during the flow ends it ("The active account
changed during sign-in. Start again.") rather than moving it. A credential lacking the inference scope is refused.
`CliLoginBackend` takes only `account` from cli.js's answer; an `identity` (account and organization uuids, the slot
written) is the in-app flow's own claim and is never taken from cli.js, and never rides `auth:state`.
`AccountManager.noteLogin` stamps the slot the flow wrote, not whichever account is active when it settles.

## The ChatGPT identity is vault-owned, one per provider with N accounts (ADR-036, ADR-068)

ClaudeUI drives the ChatGPT OAuth itself, once, and feeds the engines that use it. This is the one place the app
implements a vendor OAuth in-process (pi and opencode expose no headless login channel, and their OAuth client changes
far less than cli.js's). The vault is `~/.claude/ui/auth-vault.json` (`src/core/auth/vault/AuthVault.ts`, v3 schema:
API-key records in `credentials`, OAuth subscriptions as `accounts` per provider with an active id, plus a
`disconnected` marker list); the file format and plaintext 0600 rule are the second ADR-037 (`providers-and-models.md`).
An encrypted v1 vault is never decrypted. pi's provider id for the credential is `openai-codex`, opencode's is `openai`;
the vault's own provider id is `chatgpt`.

- **Sole refresher.** `CredentialSync` refreshes every stored account on its own timer 15 minutes before expiry
  (`REFRESH_MARGIN_MS`), so pi and opencode read a still-valid access token and never rotate the shared rotating
  refresh token themselves. A revoked refresh token (`invalid_grant`, which the issuer returns as HTTP 400) sets
  `needsReauth` and halts; 5xx, 429 and network errors back off and retry. No test performs a real token exchange.
- **Vend the active account only.** pi's `~/.pi/agent/auth.json` and opencode's credential table hold one ChatGPT entry
  each, so the active account is vended and switching re-vends both (opencode 2.x picks the new row up on its next
  request; nothing is recycled, ADR-097 §5). Adoption goes
  to the account that owns the engine's entry (the one whose workspace the entry's token names), never blindly to the
  active one; no owner or an ambiguous owner adopts nothing. Accounts whose credential disagrees with its own token or
  duplicates another's are flagged needs-sign-in and never refreshed or fed.
- **Reconcile and watch.** On start the newest of vault and engine copies is adopted, and an empty vault is bootstrapped
  from an existing engine credential, so a terminal `/login` is picked up with no new sign-in. An fs-watch on pi's store
  adopts an engine-initiated rotation (strictly newer expiry, different refresh token) with refresh-token equality as the
  loop guard against the vault's own writes. opencode 2.x has no file: its row is vended into its credential table, with a
  pre-turn gate, a recovery after a `provider.auth` turn (cooldown one minute), a resync on resume and the slot handed
  back on quit (ADR-097 §5, `opencode.md`).
- **Disconnect removes only ClaudeUI's own copy.** A disconnect (or removing the last account) takes an engine's entry out
  only when it is ClaudeUI's (its refresh token is one of the vault's, or one ClaudeUI fed before, recognised by the
  fed-token history); a sign-in made directly in pi or opencode stays, and a `disconnected` marker stops reconcile-on-start
  from signing the vault back in from it until the user signs in through ClaudeUI again. A harness that is not installed
  is fed once when it arrives (ADR-082 §8, `harness-installs.md`).
- **The login flow.** PKCE-S256 authorize, a loopback callback on `127.0.0.1` at the registered
  `http://localhost:1455/auth/callback`, token exchange, refresh. The callback validates the CSRF `state`, escapes
  reflected error text and closes after one attempt; `originator=opencode` is kept verbatim (both keyed to the client
  id, which the app does not own). The vault holds one login slot; a second device-code start cancels the live device
  flow, a live loopback flow refuses.
- **Token material never leaves the host or the vault's owner stores.** `pi:auth-status` and the probes return state,
  kind and labels, never access or refresh tokens. Tokens land in the engines' stores in plaintext 0600 because that is
  how the engines read them.
- **Trust caveat accepted.** ClaudeUI is a third application on the OpenAI client id pi and opencode already share.
- **If the vault is down** when a self-refreshing engine (pi) reaches expiry, that engine is briefly stranded until the
  fs-watch re-feeds it. Accepted residual.
- Not built: a vend route to `~/.codex/auth.json` and per-provider vend allowlists beyond ChatGPT. A future Anthropic
  provider would vend to Claude Code only; Claude credentials are handled by the section above, not this vault.

### ADR-036 amendment

The vault's encryption claim (Electron `safeStorage`) is superseded by the plaintext vault (the second ADR-037); the
sole-refresher, feed-forward and fs-watch design above is what remains. The vault gained N accounts (ADR-068 §2) and a
disconnect marker (ADR-082 §8).

### ADR-068 §1 The Codex engine route is gone

ADR-068 §1 made Codex a third consumer fed by token injection (`account/login/start chatgptAuthTokens`, answering
`account/chatgptAuthTokens/refresh` from the vault). The Codex engine was removed on 2026-10-29, so injection, the
Codex-specific settings page (ADR-068 §5 MCP inheritance, §6 config homes) and Codex rate limits are retired. What
survives from §1 is the principle: **the vault owns the ChatGPT identity and is the single refresh owner**, and what
each engine is handed is a copy, never the refresh authority. The same identity serves the Auto-mode judge's ChatGPT
backend.

### ADR-068 §2 Accounts: N per provider, one global active

The vault stores a list of accounts per provider, `{id, email, accountId (workspace), planType, credential, addedAt}`,
plus the active id. The vault `id` is its own stable handle (minted by the vault, not the provider's) because a re-login
rotates every token on the record; the workspace `accountId` read off the JWT is the identity `upsertAccount` matches on.
Accounts are a subscription concept: `provider-account:*` (list, switch, remove) is the ChatGPT vault's; there is no add command, adding is the PKCE sign-in whose completion upserts, and a
custom API-key provider has nothing to switch, so asking for its accounts is an error, not an empty list. Removing the active one promotes another and re-vends; removing the last one is a disconnect.
Accounts are managed on each subscription's card (ADR-074 §7, `providers-and-models.md`). Per-session account pinning
(`capabilities.auth.perSessionAccount`) went with the Codex engine and no longer exists. Claude's account switch is
ADR-015's respawn above and is deliberately not unified with ChatGPT's.

### ADR-068 §3 One SignInDialog for every provider and entry point

A single `SignInDialog` (`src/renderer/src/components/auth/`) serves every provider and every entry point (pill, transcript
row, model picker, Settings rows, welcome tile). It has a provider header, an account chooser (re-authorize the expired
one, switch, add) and a flow panel whose **driver** is per provider: the vault's PKCE for ChatGPT (loopback on the
desktop, paste-back or device code remotely), cli.js's control requests for Claude single-account or the in-app flow for
Claude multi-account. The **host variant** (desktop browser versus remote paste) is derived from the connection, never
chosen by the user. It is dismissible while waiting; the flow continues. The four flow UIs it replaced stay gone and
their testids are pinned absent. Device code is for the headless server and remote clients (the web client's default
ChatGPT sign-in; flow detail in `docs/architecture/security.md`), not a general desktop fallback. Entry points carry no
flow UI of their own.

### ADR-068 §4 One auth-required event from every engine

Every engine emits `session:auth-required {providerId, accountId?, message?}` when a credential is rejected (opencode, pi,
Claude; the Codex emitter is gone), and Claude's own `auth-source` signal feeds the same indicator. ADR-070 §1 finished
"one event, one card" (below).

## Remote vendor sign-in: the host exchanges, the browser returns the code by paste (ADR-057)

Every vendor OAuth `redirect_uri` is fixed by a client registration the app does not own, so a remote browser's redirect
lands on a loopback the phone cannot reach, with the `?code=&state=` URL in its address bar. A ClaudeUI-hosted redirect is
not possible unless the app registers its own vendor clients. The invariant: **the host always performs the token
exchange** (it holds the PKCE verifier and writes the credential stores); only consent and the return of the code happen
in the remote browser. The normative as-built description is `docs/architecture/security.md` ("The vendor-credential
surface").

**§sign-in.** The origin-derived flag: one shared handler body (`src/core/ipc/auth-commands.ts`, used by the desktop and
remote registrars alike) reads `connection.identity.method`; the host's own connection (`'host'`) opens the host browser,
any other method skips `shell.openExternal` and returns `manualUrl` on the `AuthFlowState`. `auth:sign-in`,
`auth:submit-code`, `auth:cancel` and `account:add` are `config` verbs registered on the remote transport deliberately; a
future desktop-only auth verb must be a decision.

- **Claude (remote).** cli.js's manual URL page displays a code; the pasted string is **`code#state`** and is split on the
  first `#` by `AuthManager.submitOAuthCode` (claude.ai joins them; cli.js's control path does not split, so posting the
  blob as the code is a 400). A paste with no `#` is the whole string as the code.
- **The loopback wait is armed on the desktop only.** A remote browser redirects to `localhost` on the user's own device, so
  the host's listener cannot be hit, and arming it races the paste: cli.js serves `claude_oauth_callback` and
  `claude_oauth_wait_for_completion` from one branch on one promise, so the wait settled the flow first and the paste's
  result read `IDLE`.
- **A flow's terminal state is replayed with its result.** `finalize` and `fail` cache the terminal state under the flow id
  and replay it when the same flow settles twice (no side effects re-run); a settle of a different, stale flow reads `IDLE`.
  The `submitOAuthCode` invoke return is a remote caller's **only** outcome channel, because `auth:state` is host-local
  (it carries the flow's CSRF `state` in `manualUrl`, and `AuthManager` holds one pending flow, so a broadcast would let
  any admitted connection complete it with its own account) and there is no auth-state query. `account:add` returns
  `pendingSignIn` on its own invoke for the same reason. A settled flow carries no `manualUrl` forward. This race was on
  the desktop's manual fallback too.
- **ChatGPT vault (remote).** `ChatgptLoginFlow.completeFromPastedInput` accepts the whole pasted callback URL, a query
  fragment, or a bare code, wired through `PiAuthProvider.oauthCallback`'s `code` argument (non-empty is pasted input, empty
  falls back to the loopback wait). **CSRF by shape:** a URL or query paste is state-bearing and gets the loopback's exact
  check (a missing or mismatched `state` is rejected, so a URL with `state` stripped is refused); a bare code cannot carry
  `state` and proceeds on PKCE alone (the verifier is the per-request binding; the `structured` flag from
  `parsePastedCallback` decides the branch, not whether a state happened to be present).
- **opencode (remote).** `code` method works as is. `auto` drives a loopback inside the host's opencode server, which a
  remote browser cannot reach and a pasted URL cannot be injected into, so it is **refused from a remote caller** with an
  actionable message (the shared `vendor-auth:oauth-authorize` handler cancels the just-started flow and throws). pi's
  ChatGPT `auto` is not refused: it has the paste-back path. The Codex callback form of this ADR went with the engine.
- **pi's other vendors** (anthropic, github-copilot, xai, radius) stay terminal-hint `/login`, which works over the remote
  terminal.
- **Token material never crosses the wire.** `probe`, `list-keys` and `pi:auth-status` return state, kind, labels and
  booleans; mutations return void. A pinned test, not a convention.
- **The headless server** serves the pi (vault) auth provider and refuses Claude and opencode sign-in
  (`DESKTOP_ONLY_SIGN_IN_MESSAGE`, `src/server/engine-auth.ts`) and account switching (`setAccountEnabled` throws,
  `src/server/main.ts`). The channels stay registered and fail loudly with the reason, so the remote surface has the
  same shape on every host. ChatGPT signs in there by device code or paste-back.
- The factory takes `requireEngineAuth` and `setAccountEnabled` injected at the boot seam so the Electron-free core never
  imports the `src/main` singletons; absent them (tests) the channels register and throw. The paste UI is one shared
  `OAuthPasteBackFlow` mounted by chat and settings entry points.

## One authentication surface: a pill, a transcript row, one resolution signal (ADR-070)

Remote-access authentication (passkeys, sessions) is a different axis with a different audience and is not merged here; it
must never contend for the same slot.

### ADR-070 §1 One fact on the wire, carrying the engine's own words

`session:auth-required` carries `message?`. Every engine puts its verbatim vendor text **on the event** and does **not**
send a companion `session:error` (a guard test pins the absence); the duplicate was why one credential failure produced
four prompts. Every engine also writes the engine-neutral transcript block (`api_error`, `errorType: 'authentication'`, with
`providerId`) through one builder (`authErrorTranscriptMessage`, `api-error.ts`). Accepted limitation: a reloaded session does not reconstruct the
row on any engine (Claude history writes the raw wire code, not the classified `authentication`), so the row lives for the live
session; the pill derives from the snapshot-carried `authRequired` and survives a resync.

### ADR-070 §2 One resolution signal, three lifetimes

`provider:auth-resolved {providerId, accountId?}` is a replicated, **canonical** channel (the reducer folds it) emitted by the
host whenever a credential for that provider is stored (Claude's success transition, the vault's account upsert). It carries no
token, URL or flow state, which is why it can fan out where `auth:state` cannot, and it must (a desktop sign-in clears the owed
sign-in on the phone). `authRequired` is `{ providerId, accountId?, message?, retryPrompt?, resolved? }` with three lifetimes:
**broken** (set by the event); **resolved, retry owed** (`provider:auth-resolved` for a matching provider sets `resolved`, keeps
`retryPrompt`); **settled** (the status turning `running`, or performing the retry, nulls it). The reducer is the only writer.
The resolution skips a session only when both sides name an account and they differ (so adding account B does not mark account
A's broken sessions "Signed in"); an internal slot key (`__active__`) is never put on the wire as an account. It does not replace
the invoke return of ADR-057: it says a credential was stored, not which flow succeeded.

### ADR-070 §3 The retry belongs to the session

`retryPrompt` is captured by the reducer at failure time from the session's own last user message, **only while the session's
status is `running`** (a turn that died; a fan-out to an idle session must not offer a retry of a prompt that finished hours
ago). Every emitter therefore sends `session:auth-required` before the status that ends the turn, and that ordering is
load-bearing. The retry then survives closing the dialog and is offered from every entry point. The event still reaches idle
sessions, because their credential is genuinely broken.

### ADR-070 §4 One pill, one row, no cards over the chat

- **The pill** (`AuthPill`) is one indicator for every provider and session, in the top bar's left group after the session
  info. The engine and model are not added to the bar; they stay in the composer. States: amber "Sign-in needed" (will fail), red "Sign-in expired" or "N sign-ins needed" (has failed), accent "Signing
  in..." (a flow is alive with the dialog closed), green transient "Signed in · Retry" (sticks while a retry is owed), and
  **nothing** when healthy or unprobed (an unprobed host is not a signed-out one, so a cold boot shows no pill). A provider
  counts proactively only when some open session routes to it (`signInProviderFor`); a turn that died on a credential is reported
  unconditionally. The pill yields width to the session title and collapses into a dot by container query (the title keeps a hard
  reservation; the reservation is charged only while a pill renders). Top-bar tiers for the other controls are in
  `top-bar-tiers.ts`.
- **The row** (`AuthTranscriptRow`, replacing `AuthErrorBlock`) has exactly two hit areas: **Sign in** (the same `openSignIn()`
  the pill calls, so they cannot drift) and a disclosure of what the engine said (the event's `message`, preferring the block's
  own text). The sentence is inert, selectable text. In the settled state the row has **no action at all**. It renders the
  session's current lifetime (per session, not per block; matching per block would need the failing message id on the wire and
  is deliberately not done) and only when the block names the same provider as the session's fact. It reads its session from
  `TranscriptSessionContext`; automation-run history, with no session, renders settled.
- **Deleted and pinned absent** (testids): `AuthBanner`, `AuthRequiredRow`, `InputBox.signInHint`. `FloatingError` and
  `SandboxViolationToast` share one ordered stack container so they cannot paint over each other.
- **Kept:** the model picker's and mobile sheet's dimmed groups with an inline Sign in, and the Settings provider rows. They
  answer "why can I not pick this?" and deleting them would recreate a dead affordance (ADR-030).

### ADR-070 §5 The dialog: presentation trimmed, drivers untouched

`signIn`, `authorizeVendorOAuth`, `authorizeVendorDeviceCode`, the paste submit and `classifyOAuthError` are not part of
presentation changes. Rules for the copy: render sets as chips (which engines a credential feeds), no sentence restating its
own button or state, one verb per step row, one row of chips for a fan-out, and **one primary action per screen** (no footer
Close or Done; `×` closes, and the primary slot is **Retry**, naming the prompt, in the body). Provider-list mode (the pill's
entry point) shows one primary per actionable row. **A confirm stage** precedes every auto-started flow (including
`mode: 'add'`): it names the provider, the account when known, and one primary saying what will actually happen (`Open
browser` on the desktop; `Get a sign-in link` or `Get a code` on web, because the host never opens a browser for a remote
caller). Kept deliberately: the line that the redirect page fails to load (expected), the device-code to paste-back escape
hatch (a server with device code off still needs a path), the code expiry, and the engine's verbatim error text, never
paraphrased. The dialog shows one copy of the account list (a pure mapping over the store's own fields), refreshed by
`provider:auth-resolved` for remote clients because `account:changed` is host-local.

Rejected: a single card in one slot (still a dismissible card over the transcript, recurs per session); an Accounts hub in the
sidebar (duplicates Settings, and send-blocking on a stale probe would block a working engine; revisit); merging remote-access
auth into this surface; suppressing the duplicate `session:error` in the renderer by string match (fix it at the emitter);
clearing `authRequired` on dialog close (not evidence of a sign-in, and not replicated).
