# ChatGPT identity, accounts and Codex injection: implementation spec

Realizes [ADR-068](adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md). Five reviewed slices under [ADR-026](adr/adr-026_development-workflow.md): the main model writes the kickoff, an Opus implementing agent builds it, the main model reads every changed line, re-runs gates, drives the real app and commits. Mockups reviewed by the owner on 2026-09-13 are the visual target (five screens: providers and accounts, Engines › Codex, Codex on topic pages, per-session account picker, sign-in dialog).

Standing rules for every implementing agent on this spec:

- No `git add`, `commit`, `stash`, `checkout`, `reset`, `branch`, `push`. No `bun install`/`add`/`remove`. No `bun run format` over the repo (format only the files you created or changed, by path). Do not delete or revert any file you did not create. Report the exact file list you touched; the reviewer diffs it against `git status`.
- No real credentials. Never read `~/.claude/ui/auth-vault.json`, `~/.codex/*`, `~/.pi/agent/auth.json` or opencode's `auth.json`. Every test uses temp directories and mocked HTTP; no test may call `auth.openai.com`. Token material never appears in logs, IPC results, test names or fixtures that look real.
- Every behaviour change ships with a guard test the agent proves fails before the fix and passes after. Report both runs.
- Report results and deviations; never self-certify.

## Slice 1: vault accounts (this kickoff)

### Goal

The vault holds N ChatGPT accounts with one active account. `CredentialSync` refreshes every account and vends the active one to pi and opencode exactly as today. The provider registry projects the accounts onto the ChatGPT row, and the Manage sheet shows an Accounts card (radio for active, Remove, Add) and a Per-session accounts toggle. No Codex behaviour changes in this slice.

### Read first

`docs/adr/adr-068_chatgpt-identity-vault-owned-codex-injection.md` §1–2, `docs/adr/adr-036_unified-auth-vault.md`, `docs/adr/adr-037_shared-provider-routing-and-plaintext-vault.md`, `src/core/auth/vault/AuthVault.ts`, `src/core/auth/vault/codex-oauth.ts` (the `VaultCredential` and `JwtClaims` shapes, `exchangeCodeForTokens`), `src/core/auth/vault/CredentialSync.ts` (all of it; the scheduler, reconcile, feed and watcher sections), `src/core/shared-providers/SharedProviderRepository.ts`, `SharedProviderService.ts`, `provider-registry.ts`, `src/shared/shared-provider.ts`, `src/shared/provider-registry.ts`, `src/core/ipc/auth-commands.ts`, `src/renderer/src/components/SettingsDialog/ProviderSheet.tsx` (`credentialRows` and the Enabled-for group), `ProviderList.tsx`, and the existing tests under `src/main/auth/vault/__tests__/`, `src/core/shared-providers/__tests__/`, `src/renderer/src/components/SettingsDialog/__tests__/ProviderSheet.component.test.tsx`, `src/main/ipc/__tests__/remote-handlers.ipc.test.ts` (the pinned remote channel set).

### Design (decided; do not reopen)

**Vault file v3.** `{ v: 3, credentials: Record<providerId, {type:'api_key', key}>, accounts: Record<providerId, { activeId: string | null, list: VaultAccount[] }> }`. `credentials` keeps only API-key records for custom providers; OAuth subscriptions live in `accounts`. `VaultAccount = { id: string (random, stable), email?: string, accountId?: string (ChatGPT workspace id from the JWT), planType?: string, credential: VaultCredential, addedAt: number }`. Read-time migration: a v2 file with a `chatgpt` OAuth credential becomes one account (id minted, `email`/`accountId` copied) that is active; a v1 plaintext file goes through the existing v1→v2 path first. Malformed entries are dropped as today. Write is the same atomic 0600 rename.

`VaultCredential` gains optional `planType`, parsed at exchange and refresh from the id_token claim `https://api.openai.com/auth`.`chatgpt_plan_type` (same claim sources and order `parseJwtClaims` / `accountIdFromClaims` already use for the account id). Do not change the OAuth constants.

**AuthVault API.** Keep `load()`/`save()` as the ACTIVE account's credential (compatibility for `CredentialSync` feed targets and `getStatus`). Add `listAccounts(providerId)`, `getActiveAccountId(providerId)`, `setActiveAccount(providerId, id)`, `upsertAccount(providerId, credential)` (match by `accountId`: same workspace updates the stored account in place and keeps its id; a new workspace appends; the first account ever becomes active; a re-login of the active account keeps it active), `removeAccount(providerId, id)` (removing the active account promotes the most recently added remaining one, or leaves `activeId` null), `saveAccountCredential(providerId, id, credential)` for the refresher. Existing `loadCredential`/`saveCredential`/`removeCredential` keep working for API-key providers; `saveCredential` with an OAuth record under a subscription provider must route to `upsertAccount` so no caller can silently write the old single-slot shape.

**CredentialSync.** Refresh is per account: one timer per stored account (15 min before its expiry, the existing retry/give-up chain per account, `needsReauth` becomes per account id). `feedAll` writes the ACTIVE account only; `completeLogin` upserts, and feeds only when the upserted account is the active one. Add `switchActiveAccount(id)`: set active, feed both engine stores from the new active credential, then call the injected `onActiveAccountChanged()` hook (Slice 2 wires it; Slice 1 leaves the default a no-op) so the boot seam can recycle opencode per ADR-047 (`opencodeServerManager.recycleAll()` is what `OpencodeAuthProvider` already calls after every auth-store mutation; the hook lets the boot seam do the same without `CredentialSync` importing opencode). `removeAccount(id)`: stop its timer, remove it; if it was active, feed the promoted account or, if none remains, remove both engine copies (the existing `disconnectChatgpt` cleanup). The reconcile-on-start and fs-watch adoption logic keeps operating on the ACTIVE account only: an engine-rotated token is adopted into the active account when it strictly beats it, never into another account. `getStatus()` gains `accounts: Array<{id, email?, accountId?, planType?, expiresAt, needsReauth}>`, `activeId`, and keeps its existing fields for the active account; still never returns token material.

**Shared provider definition.** `SharedProviderDefinition` gains optional `accounts?: { perSession: boolean }` (default false), persisted in `~/.claude/ui/providers/chatgpt.json` by the repository's `normalizeChatgpt` path. Only meaningful for `kind: 'subscription'`.

**Commands** (in `auth-commands.ts`, capability `config`, registered for both transports; add them to the pinned remote channel set): `provider-account:list` → `{ activeId, perSession, accounts: [...] }` from `credentialSync.getStatus()` plus the definition; `provider-account:switch (providerId, id)`; `provider-account:remove (providerId, id)`; `provider-account:set-per-session (providerId, enabled)`. Adding an account reuses the EXISTING sign-in path untouched (`vendor-auth:oauth-authorize` / `oauth-callback` on engine `pi`, vendor `openai-codex`, which delegates to `credentialSync.beginLogin/completeLogin`) — its completion now upserts. Slice 3 replaces the entry point, not the flow. Every handler is token-free; pin that with a test like the existing `probe`/`list-keys` one.

**Registry projection.** `ProviderEntry` gains optional `accounts?: { activeId: string | null, perSession: boolean, list: Array<{ id, email?, planType?, accountId? }> }`, set on the shared subscription row from a new `ProviderRegistrySources.chatgptAccounts` source (filled by `listProviderRegistry` from `credentialSync.getStatus()`). `credential` stays `'connected'` when at least one account exists. The row `detail` reads `"2 accounts · daniel@example.com active"` when more than one account exists.

**Manage sheet.** For a shared subscription row, the Credential group becomes an **Accounts** card: one `SettingRow` per account (`as="label"`, radio `leading`, label = email or "Account", description = plan and a shortened workspace id, active row tinted, a danger `Remove` button), a header action `+ Add account` that calls the existing `onAddProvider(entry.id)` path, and below the list a `Per-session accounts` toggle row (description per the mockup; hidden when fewer than two accounts). The existing `Disconnect` moves to the sheet footer as `Disconnect all accounts` with the same confirm. `ProviderList`'s `CredentialChip` for a multi-account row says `N accounts`. Follow ADR-027 testids: `ProviderSheet.account` with `dataId` = account id, `ProviderSheet.accountRemove`, `ProviderSheet.addAccount`, `ProviderSheet.perSession`, `ProviderSheet.disconnect`.

Mobile: the sheet already renders inside the mobile settings view; verify the new rows read at 390px in the component test (no new mobile code expected).

### Guards (each a test that fails before the change)

1. v2 → v3 migration: a v2 chatgpt credential becomes one active account with email/accountId preserved; a v2 API-key custom provider stays under `credentials`.
2. `upsertAccount`: same workspace updates in place and keeps id and active flag; new workspace appends and does not steal active; first account becomes active.
3. `removeAccount` of the active account promotes the newest remaining and feeds it; removing the last removes both engine copies.
4. Two accounts, two expiries: each is refreshed on its own schedule; only the active one is fed; a revoked refresh sets `needsReauth` for that account only.
5. fs-watch adoption updates the active account only.
6. `getStatus`, `provider-account:list` and the registry snapshot contain no `access`/`refresh` strings.
7. Registry: the ChatGPT row carries `accounts` with the right active id and `detail`.
8. ProviderSheet: renders N account rows, radio switch calls `provider-account:switch`, Remove calls remove, toggle calls set-per-session and is hidden with one account.
9. The pinned remote channel set includes the four new channels.

### Gates before handing back

`bun run typecheck`, `bun run lint`, `bun run test` (full default run, not filtered), and the format check on changed files only. Report each command's exact result. Then the reviewer drives the real app: Settings › Models & providers › ChatGPT › Manage shows the Accounts card against a temp `HOME` with a fabricated v2 vault (the reviewer prepares that; the agent does not touch the real vault).

### Out of scope for Slice 1

Codex injection, the account picker in the input bar, `capabilities.auth.perSessionAccount`, the sign-in dialog, removing the device-code UI, rate limits. Do not add `codex` to `ConfigurableHarnessId` yet.

## Slice 2: Codex injection

`ConfigurableHarnessId` gains `codex`; the ChatGPT definition gets `routes.codex { enabled: true }` with no `providerId`. `CodexClient.start` accepts an `auth` hook; `CodexSession`, `CodexService` and the dispatch target's client call it after `initialize` to send `account/login/start { type: 'chatgptAuthTokens', accessToken, chatgptAccountId, chatgptPlanType }` from the vault (the session's pinned account when set, else the active one). Register the server request `account/chatgptAuthTokens/refresh` in the session's and service's `serverMethods`; the handler answers from the vault's cached credential for `previousAccountId` (else the pin, else active), refreshing over the network only when that credential is already expired; a failed refresh answers a JSON-RPC error and the session emits `session:auth-required { providerId: 'chatgpt', accountId }`. Add the generated types for the refresh params/response, `account/rateLimits/read`, `account/rateLimits/updated` and `account/updated` to the typed method map (regenerate, do not hand-write). `SessionStatus.account.accountId` carries the vault account id; `codex_session_overrides` gains `accountId` (migration) and `session:set-account` is a new engine-neutral command gated by `capabilities.auth.perSessionAccount`; the input bar shows the account picker when the toggle is on and the capability is true; forks and resumes re-inject the pin; a missing pinned account falls back to active with a `session:error`. `CodexAuthProvider.probe` reads the vault; the device-code `loginStart/loginStatus/loginCancel`, the `codex:login-*` channels and `CodexAccount.tsx` are removed; the Codex page's Account group becomes the compact status row with a cross-link. Usage: `account/rateLimits/read` per account through the service and `rateLimits/updated` from live sessions into the sidebar usage panel. Live gate: a real turn on the owner's account under injection, a forced 401 answered by the handler (expire the cached token in a probe build), and a per-session switch between two accounts.

## Slice 3: sign-in dialog and one auth-required event

`SignInDialog` (provider header, account chooser, flow panel; drivers: vault PKCE for `chatgpt`, `AuthManager` for `anthropic`; host variant from `window.api.platform` and the connection), `session:auth-required` replacing `session:vendor-auth-required` on opencode and added to pi and Codex, the one-line banner and the transcript row, entry points rewired (banner, transcript row, provider rows, greyed picker entries, welcome tile, session account picker "Add account…"), `OAuthPasteBackFlow` retained inside the dialog's remote panel, `AuthErrorBlock` and `VendorAuthRequiredCard` deleted. Done state reports fan-out and offers Retry.

## Slice 4: MCP inheritance

Probe first (`src/integration/codex/`, real binary, mock-model fixture): does a `thread/start.config.mcp_servers` override reach the thread's tool list? Record the result in `docs/codex-spike.md`. If yes: `claude-mcp-bridge` gains a Codex translation (stdio → `{command, args, env}`; remote → `{url, bearer_token_env_var, http_headers, env_http_headers}`), delivered on `thread/start` and `thread/resume`, respecting the per-directory disabled list and filtering ClaudeUI's own hosted-tool names. If no: stop and report; the fallback is a design decision.

## Slice 5: settings

Typed `config/value/write` and `config/batchWrite`; a `codex-config` core service that reads through `config/read` and writes through `batchWrite` with `expected_version` and `reload_user_config` where hot-reloadable; the Codex engine page groups exactly as ADR-068 §6 lists them, on `SettingRow`; Codex segments on Default models (`engines/codex.json` default model and effort), Cross-engine dispatch and the Auto-mode judge (`auto_review.policy`); `ENGINE_ORDER` gains `codex`; the stale strings fixed; the inventory guard extended so every new item key has exactly one home.
