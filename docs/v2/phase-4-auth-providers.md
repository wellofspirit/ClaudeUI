# Phase 4 — Auth providers (implementation kickoff)

> Implements [04-auth-accounts.md](04-auth-accounts.md) + ADR-021. Extract a per-engine auth
> abstraction, repackage Claude's auth behind it, add the neutral probe, rename
> `AuthState`→`AuthFlowState`, move account metadata to the DB. **AUTH IS CRITICAL AND IN ACTIVE USE
> (the user is logged in with accounts) — login / account-switch / re-auth behavior MUST be preserved.**

## Scope decisions (chosen — do exactly this)

1. **Rewire detection through the probe** (user's call) — `ClaudeAuthProvider.probe()` becomes the
   source of Claude's auth detection. The probe MUST derive from the **same signal** used today
   (cli.js init → `session:auth-source`), so the result is **behavior-equivalent** — no credential
   reads (preserve the ADR-014 Keychain-prompt avoidance). The `AuthBanner` consumes the probe instead
   of the raw `authSource` string.
2. **Wire `session.account: AccountRef` now** (user's call) — add `account` to `SessionStatus`,
   resolved = `probe()[session.model.vendorId]` (+ active `accountId` for multi-account), re-emitted on
   model switch. For Claude: `{ engineId:'claude', vendorId:'anthropic', billingType, authState, label, accountId }`.
3. **Behavior-preserving repackage** — `ClaudeAuthProvider` wraps today's `AuthManager` +
   `AccountManager` + service-session; the `auth:*`/`account:*` IPC routes through it; login, OAuth
   paste-code, multi-account add/switch/delete all behave identically.
4. **`AuthState` → `AuthFlowState` rename** — the existing login-flow object `{status, account, error}`
   becomes `AuthFlowState`; free `AuthState` for the resolved tri-state `'authenticated' |
   'unauthenticated' | 'unknown'` (foundation 1). Update `AccountRef.authState` to the named type.
5. **Account metadata `accounts.json` → DB** — `AccountInfo[]` → a DB table (v2 migration via the 3a
   framework; one-time import; keep `accounts.json` as a one-release fallback). `enabled`/`activeId`
   pointer may stay in the file or a small DB meta row (your call — note it). **Credentials stay
   file-based per-account dirs (ADR-015) — never in the DB.**
6. **`billingType` inferred in the probe** — Claude: `OAuthAccount.subscriptionType` (max/pro) →
   `subscription`; `apiKeySource`/`apiProvider` set → `apiKey`; else `unknown`.

## Out of scope
opencode's `OpencodeAuthProvider` (Phase 5), per-vendor multi-vendor probe beyond Claude's single
`anthropic` entry, metering math (Phase 7 consumes `billingType`).

## EngineAuthProvider + ClaudeAuthProvider

```ts
// shared/types.ts (new)
interface AuthStatus { authState: AuthState; billingType: BillingType; label?: string
                       requiresLogin?: boolean; notInstalled?: boolean; error?: string }
type VendorAuthMap = Record<VendorId, AuthStatus>

// main/auth (new) — one per engine, capability-gated
interface EngineAuthProvider {
  probe(): Promise<VendorAuthMap>
  signIn?(vendorId?: VendorId): Promise<AuthFlowState>         // capabilities.auth.canDriveLogin
  submitCode?(code: string): Promise<AuthFlowState>
  cancelSignIn?(): Promise<void>
  addAccount?(): Promise<AccountsState>                        // capabilities.auth.multiAccount
  switchAccount?(id: string): Promise<AccountsState>
  deleteAccount?(id: string): Promise<AccountsState>
}
```

- `ClaudeAuthProvider` (e.g. `src/main/auth/ClaudeAuthProvider.ts`) holds/wraps the existing
  `AuthManager` + `AccountManager`. `signIn/submitCode/cancelSignIn` delegate to AuthManager;
  `addAccount/switchAccount/deleteAccount` to AccountManager; `probe()` builds
  `{ anthropic: AuthStatus }` from the cached auth-source/init signal + the active account's
  `OAuthAccount` (billingType + label).
- A tiny `engineAuthRegistry` (mirror `EngineRegistry`) maps `EngineId → EngineAuthProvider`; register
  `'claude'`. IPC handlers (`auth:sign-in`, `auth:submit-code`, `auth:cancel`, `account:*`,
  `account:get`, `account:set-multi`) route through `engineAuthRegistry.get(engineId)` (default
  `'claude'`) — preserving the current channels + payloads.

## Detection rewire (BEHAVIOR-CRITICAL)

Today: `claude-session`/`session.ipc` emit `session:auth-source` → store `authSource: string|null` →
`AuthBanner`. Rewire **without changing observed behavior**:
- The auth-source signal (and the active `OAuthAccount`) feed `ClaudeAuthProvider`'s cached probe state.
- Expose the probe to the renderer (e.g. an `auth:probe`/`auth:vendor-map` event + a store
  `vendorAuth: VendorAuthMap`), refreshed whenever auth-source / account state changes.
- `AuthBanner` reads `vendorAuth.anthropic.authState` (map `'authenticated'`→signed-in,
  `'unauthenticated'`→show login) instead of the raw `authSource` string. **Keep the same banner
  states + actions.** If keeping `authSource` in the store as a derived mirror is simpler/safer, fine —
  but the probe must be the source of truth and the banner behavior identical.
- Verify: signed-in shows no banner; signed-out shows the login affordance; post-login the banner
  clears — exactly as today.

## session.account on SessionStatus

- Add `account: AccountRef | null` to `SessionStatus` (`shared/types.ts`). `ClaudeSession` builds it
  from `ClaudeAuthProvider.probe()['anthropic']` + the active accountId; re-emit on model switch (with
  capabilities). For Claude it's stable across models.
- Renderer may consume it (optional); the key requirement is it's populated + re-emitted, type-correct.

## accounts.json → DB

- DB v2 migration: `account(id TEXT PRIMARY KEY, email, subscription_type, organization, created_at)`.
- `AccountManager` reads/writes account metadata via the DB repo (add to `db.ts`); one-time import
  from `accounts.json` if the table is empty; keep the file (one-release fallback). `enabled`/`activeId`
  stays where simplest (file or a `kv`/meta row) — note your choice. Switch mechanism (env re-point +
  respawn, `SKIP_SECURESTORAGE`/`CLAUDE_SECURESTORAGE_CONFIG_DIR`) unchanged.
- Tests use the 3a node:sqlite stub — the account repo is exercised there (no native load).

## Rename `AuthState` → `AuthFlowState`

7 files reference `AuthState` (auth-manager, preload, useClaudeEvents, session-store, types,
boot-test-app, web-adapter). Rename the login-flow object + its `auth:state` event payload type to
`AuthFlowState`; introduce `AuthState = 'authenticated'|'unauthenticated'|'unknown'` (used by
`AuthStatus`/`AccountRef`). Type-checker drives the sites.

## Step-by-step
1. Branch `v2-phase-4-auth-providers` (created off 3b). Don't commit; leave for review.
2. `shared/types.ts`: `AuthState`→`AuthFlowState` rename + new `AuthState` tri-state, `AuthStatus`,
   `VendorAuthMap`; `SessionStatus.account: AccountRef|null`. Typecheck → fix sites.
3. `EngineAuthProvider` + `ClaudeAuthProvider` + `engineAuthRegistry`; route `auth:*`/`account:*` IPC through it.
4. Detection rewire (probe feeds AuthBanner, behavior-equivalent).
5. `session.account` on status (+ re-emit on model switch).
6. accounts.json → DB (v2 migration + import + fallback).
7. CLAUDE.md: an Auth/Accounts note (EngineAuthProvider, probe, account table, AuthFlowState).
8. Tests + sweep (`rg "AuthState"` → only the new tri-state + AuthFlowState; no stale).

## Verify
```
bun run typecheck && bun run test && bun run test:ci && bun run lint && bun run build
```
**Runtime smoke (verifier-electron) — auth is the headline risk:** launch the real app (uses the real
`~/.claude` creds — the user is logged in). Confirm: **no login banner appears for the signed-in
account** (detection via the probe works), the Accounts UI lists the account(s), and 0 console errors.
A spurious "please log in" banner = the probe rewire is wrong. (Do NOT drive an actual logout/login —
that mutates real credentials.) Read the screenshot.

## Gotchas
- **Do NOT break login/detection.** The probe must derive from the same cli.js-init signal; no
  credential-file reads (Keychain avoidance). The signed-in user must NOT see a login prompt.
- **Account-switch behavior unchanged** — env re-point + respawn stays in ClaudeAuthProvider/AccountManager.
- **DB native module** — don't `bun install` (reverts ABI); the node:sqlite test stub covers the new
  account repo.
- **Rename is wide but mechanical** — lean on the type-checker; watch the `auth:state` event payload.

## Commit
Branch off `v2-phase-3b-config-plane`; no AI attribution. Suggested:
`refactor(v2): EngineAuthProvider + ClaudeAuthProvider, neutral auth probe, account metadata→DB (Phase 4)`.
