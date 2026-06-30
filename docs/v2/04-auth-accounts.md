# Foundation 4 — Auth & Accounts

> **Status: DRAFT for discussion.** A per-engine auth provider behind one neutral probe +
> account interface. Builds on [01-data-model.md](01-data-model.md) (`AccountRef`, the Claude-only
> account-info registry), [02-capability-model.md](02-capability-model.md) (auth traits gate the
> login UI), and [persistence.md](persistence.md) (account metadata → DB, credentials → files).
> Grounded in the real ADR-014 / ADR-015 implementation.

## 1. Current state (Claude)

- **OAuth (ADR-014)** — `AuthManager` (`auth-manager.ts`) drives login *in-app* through the
  **service session** (a credential-free cli.js subprocess) using native control subtypes
  `claudeAuthenticate` / `claudeOAuthWaitForCompletion` / `claudeOAuthCallback`
  (`service-session.ts:43`). IPC: `signIn()` / `submitOAuthCode(code)` / `cancelSignIn()`
  returning `AuthState { status, account, error }` (`types.ts:922`), broadcast via `auth:state`.
- **Detection** — we **never read the credential store** (avoids macOS Keychain prompts).
  Instead we trust cli.js's `initializationResult().account` → `reportLoginStatus()` →
  `session:auth-source` (`authenticated` | `none`) → `AuthBanner`.
- **Multi-account (ADR-015)** — `AccountManager` (`account-manager.ts`): per-account dirs
  `~/.claude/ui/accounts/<id>/.credentials.json` + a registry `accounts.json`
  (`AccountsState { enabled, activeId, accounts: AccountInfo[] }`). Switching re-points the spawn
  env (`SKIP_SECURESTORAGE=1` + `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>`, `args.ts:338`) and
  respawns sessions. IPC: `getAccounts` / `setMultiAccountEnabled` / `addAccount` / `switchAccount`
  / `deleteAccount`, all returning `AccountsState`.
- **Probe one-off** — `CodexStatus { authenticated, email?, planLabel?, requiresLogin, notInstalled?, error? }`
  (`codexStatus.ts:59`) is the existing "auth probe result" shape (being removed with Codex, but
  it's the template for the neutral probe below).
- **Live 401** — cli.js surfaces auth failures as error frames → `classifyApiError` →
  `AuthErrorBlock` with a "Log in" action (`claude-session.ts:887`).

## 2. The fundamental split: driven vs delegated

| | **Claude** | **opencode** |
| --- | --- | --- |
| Who runs login | **ClaudeUI drives it** (in-app OAuth) | **ClaudeUI can drive it too** — API-key form now (`PUT /auth/{vendor}`); OAuth-sub flow via opencode's OAuth endpoints (callback TBV). Delegated `opencode auth login` stays as fallback |
| Credential store | per-account dirs (ClaudeUI-managed, ADR-015) | opencode's own `auth.json` (per vendor) |
| Granularity | per-engine (single vendor: anthropic) | **per-vendor** (anthropic, openai, … each authed separately) |
| Multi-account | yes, user-selectable | no — implicit per vendor |
| Probe source | cli.js init response | `GET /config/providers` / `GET /provider/auth` |

**Revised from the earlier "delegated-only" lean:** opencode exposes auth-setting endpoints, so
ClaudeUI *can* drive opencode login in-app — trivially for **API-key** vendors
(`PUT /auth/{vendor}`), and via opencode's OAuth endpoints for **subscription** vendors
(ChatGPT/Claude subs; callback mechanism being verified). The neutral layer therefore supports
in-app login for *both* engines; only the *login method* varies per vendor. The delegated
`opencode auth login` path stays as a fallback for any method we don't yet drive.

## 3. Neutral probe shape

Generalizes `CodexStatus` + the Claude auth-source signal. Keyed **by vendor**, because that's
opencode's granularity (Claude returns a single `anthropic` entry):

```ts
interface AuthStatus {                 // per (engine, vendor)
  authState: AuthState                 // 'authenticated' | 'unauthenticated' | 'unknown'  (01)
  billingType: BillingType             // inferred — feeds metering (05): subscription | apiKey | free | unknown
  label?: string                       // email / org / 'ChatGPT Plus'
  requiresLogin?: boolean              // delegated engines: surface "run `<engine> login`"
  notInstalled?: boolean               // engine binary missing
  error?: string
}

type VendorAuthMap = Record<VendorId, AuthStatus>
```

> **Naming reconciliation:** foundation 1's `AuthState` is the resolved tri-state enum. The
> *existing* Claude `AuthState { status, account, error }` is the in-progress **login flow**
> object — rename it `AuthFlowState` in V2 to avoid the collision.

## 4. The `EngineAuthProvider` interface

One per engine, capability-gated exactly like `ISession` optional methods:

```ts
interface EngineAuthProvider {
  probe(): Promise<VendorAuthMap>                       // always

  // driven login — only when capabilities.auth.canDriveLogin
  signIn?(vendorId?: VendorId): Promise<AuthFlowState>
  submitCode?(code: string): Promise<AuthFlowState>
  cancelSignIn?(): Promise<void>

  // multi-account — only when capabilities.auth.multiAccount
  addAccount?(): Promise<AccountsState>
  switchAccount?(id: string): Promise<AccountsState>
  deleteAccount?(id: string): Promise<AccountsState>
}
```

- **`ClaudeAuthProvider`** — implements everything; wraps today's `AuthManager` + `AccountManager`
  + service session. No behavior change for Claude.
- **`OpencodeAuthProvider`** — `probe()` (via `GET /config/providers` + `GET /provider/auth`)
  **plus in-app `signIn(vendorId)`**. Methods are discovered from `GET /provider/auth` →
  `{vendor: ProviderAuthMethod[]}` (each `{type:'api'|'oauth', label, prompts[]}`; the array index
  is the `method` arg). Dispatch:
  - **API-key vendors** (`type:'api'`) → render `prompts[]` as a form → `PUT /auth/{vendor}
    {type:'api', key}`. opencode stores it; ClaudeUI holds no secret. **Trivial; v1.**
  - **OAuth vendors** (`type:'oauth'`) → `POST /provider/{vendor}/oauth/authorize {method:idx}` →
    `{url, method:'auto'|'code', instructions}`; open `url`, then branch:
    - `method:'code'` (paste/device-code) → collect code → `POST .../oauth/callback {method:idx,
      code}`. **Deterministic, fully API-driven — in-app, v1.**
    - `method:'auto'` (loopback, e.g. Claude Pro/Max, ChatGPT) → opencode's listener completes it,
      but **no documented port or completion event** → open browser + **poll `GET /provider/auth`
      with a timeout**, or **delegate** to `opencode auth login`. See the caveat.
  No account *registry* (one credential per vendor — `multiAccount: false`); "login" = add/replace
  a vendor credential. Delegated `opencode auth login` remains the fallback.

> **ToS / longevity caveat (subscription OAuth):** driving Claude Pro/Max or ChatGPT *subscription*
> OAuth through opencode is a moving target — Anthropic is actively restricting third-party OAuth,
> and a token-exchange `429` failure is already observed. opencode ships this flow itself, so we're
> not doing anything its CLI doesn't, but **don't make in-app subscription-OAuth load-bearing.**
> Default to delegation for the `auto`/loopback subscription case; reserve in-app for API-key and
> paste-code methods.

New auth traits on the capability model (feeds [02](02-capability-model.md) §3.1):

```ts
// added to EngineCapabilities
auth: { canDriveLogin: boolean; multiAccount: boolean }
// claude:  { canDriveLogin: true, multiAccount: true }
// opencode:{ canDriveLogin: true, multiAccount: false }   // can log in in-app; no multi-account
```

`canDriveLogin` gates the in-app login affordance (button/form) vs the delegated card;
`multiAccount` gates the account switcher (Claude only).

## 5. Account registry — Claude-only, metadata in DB, creds in files

Per foundation 1 §3.4 + persistence: the registry pattern stays but is **engine-scoped to
`multiAccount` engines** (Claude in practice):

- **Account metadata** (`AccountInfo { id, email, subscriptionType, organization, createdAt }`)
  → moves into the **operational DB** (was `accounts.json`).
- **Credentials** → stay file-based per-account dirs (ADR-015 unchanged) — never in the DB.
- **Switch mechanism** (env re-point + respawn) stays in `ClaudeAuthProvider` (Claude-specific).
- opencode has **no** registry — its accounts are whatever's in `auth.json`, surfaced read-only
  from the probe.

## 6. `billingType` inference (feeds metering 05)

The probe derives `billingType` so metering doesn't have to:

- **Claude**: `OAuthAccount.subscriptionType` (`max`/`pro`) → `subscription`; `apiKeySource`/
  `apiProvider` set → `apiKey`.
- **opencode**: per vendor, from the `auth.json` entry type (OAuth → `subscription`; API key →
  `apiKey`; local/none → `free`).

## 7. Detection & the session `AccountRef`

- **opencode refreshes tokens server-side** (provider transform layer, lazy-on-use) — ClaudeUI
  does **not** manage refresh. So "expired" is rare (only refresh-token expiry); when it happens,
  opencode emits `session.error` with `error.name === 'ProviderAuthError'` — the re-login trigger.
- **Keep "trust the engine, don't read creds"**: Claude from init response; opencode from the
  probe. No credential-file reads (preserves the ADR-014 Keychain-prompt avoidance).
- **401-driven affordance generalizes**: an auth-class error from any engine surfaces *that
  engine's* login affordance — in-app re-login (`AuthErrorBlock` for Claude via
  `classifyApiError → authentication`; the API-key form or paste-code OAuth for opencode via
  `ProviderAuthError`), falling back to the delegated card. This is the "re-auth without leaving
  the app on expiry" path you flagged.
- **Session resolution**: `session.account: AccountRef` = `probe()[session.model.vendorId]`
  (+ active `accountId` for Claude multi-account). Re-resolves on model switch (01 §3.5) — a
  cross-vendor switch on opencode may flip `authState`/`billingType`.

## 8. Migration

- `AuthManager` + `AccountManager` + service-session OAuth → repackaged as `ClaudeAuthProvider`
  (no behavior change). Existing IPC channels kept or routed through the provider.
- `accounts.json` → DB table (one-time import; keep file as fallback for a release).
- `CodexStatus` deleted; its shape lives on as `AuthStatus`.
- Rename `AuthState { status, account, error }` → `AuthFlowState`; free `AuthState` for the
  resolved tri-state.
- Add `capabilities.auth` to the engine descriptors.

## 9. Decisions / open questions

1. **`EngineAuthProvider` abstraction** ✓ — per-engine provider, capability-gated
   (`canDriveLogin`, `multiAccount`). Claude = full driver. **opencode also drives login in-app**
   (revised): API-key vendors via `PUT /auth`, OAuth vendors via opencode's OAuth endpoints.
   `capabilities.auth` added to foundation 2.
2. **Per-vendor probe** (`VendorAuthMap`, §3) — confirm vendor-keyed (Claude returns one
   `anthropic` entry; opencode one per configured vendor). The model picker grays out models
   whose vendor is `unauthenticated`.
3. **Account registry Claude-only; metadata→DB; creds→files** (§5) — reaffirms foundation 1.
   Confirm the env-switch+respawn mechanism stays Claude-internal.
4. **`billingType` inferred in the probe** (§6) — confirm the probe owns this (vs metering
   computing it), so foundation 5 just consumes it.
5. **opencode in-app login** ✓ (revised from delegated-only; OAuth mechanism now verified) —
   **API-key + paste-code (`method:'code'`) OAuth in-app (v1)**; **loopback (`method:'auto'`) OAuth
   → delegate + poll `GET /provider/auth`**, since opencode exposes no port/completion contract.
   Subscription OAuth (Claude/ChatGPT) carries a ToS/longevity risk (Anthropic restricting
   third-party OAuth) — **not load-bearing; delegation is the default there.** Token refresh is
   opencode's (server-side); re-login is triggered by `ProviderAuthError` on `session.error`.
6. **`AuthState` → `AuthFlowState` rename** (§3) — confirm the naming reconciliation.
