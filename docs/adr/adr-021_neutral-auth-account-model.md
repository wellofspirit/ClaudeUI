# ADR-021: Neutral auth/account model — EngineAuthProvider, per-vendor probe

**Status:** Accepted (V2 design; implementation complete. The detailed `docs/v2/` design docs were removed after V2 shipped — recoverable from git history.)
**Date:** 2026-06-19
**Amends:** [ADR-014](adr-014_native-anthropic-oauth.md), [ADR-015](adr-015_multi-account-file-credentials.md)

## Context

Auth differs by engine at the mechanism level: ClaudeUI _drives_ Claude's OAuth (service session +
control requests, ADR-014) and manages multi-account file credentials (ADR-015); opencode _delegates_
(owns `auth.json`, multi-vendor) but exposes auth-setting endpoints. V2 needs one neutral interface
over both. (The implemented model is documented in `docs/architecture/engines.md` § "Auth / accounts".)

## Decision

- **`EngineAuthProvider` per engine**, capability-gated by `capabilities.auth { canDriveLogin,
multiAccount }` (ADR-018):
  - **`ClaudeAuthProvider`** — full: probe + in-app OAuth + multi-account; wraps today's `AuthManager`
    - `AccountManager` + service session **unchanged** (ADR-014/015 internals preserved).
  - **`OpencodeAuthProvider`** — `probe()` + in-app `signIn(vendorId)`: **API-key** via
    `PUT /auth/{vendor}` (opencode stores the secret; ClaudeUI holds nothing); **OAuth paste-code**
    in-app; **OAuth loopback delegated** (open browser / `opencode auth login`, poll
    `GET /provider/auth`). No account registry (`multiAccount: false`).
- **Neutral per-vendor probe** → `VendorAuthMap = Record<VendorId, AuthStatus>` where
  `AuthStatus { authState, billingType, label?, requiresLogin? }`. **`billingType` is inferred here**
  (subscription/apiKey/free) so metering (ADR-020/foundation 5) just consumes it. Generalizes the
  removed `CodexStatus` one-off.
- **Account registry stays Claude-only** (the only `multiAccount` engine): metadata → operational DB
  (ADR-020), **credentials stay file-based** (ADR-015); the env-switch + respawn mechanism stays
  Claude-internal.
- **Detection:** keep "trust the engine, don't read creds" (Claude init response; opencode probe — no
  Keychain prompts). A 401-class error (`classifyApiError → authentication` for Claude;
  `ProviderAuthError` for opencode) surfaces that engine's re-login affordance.
- **ToS posture:** in-app _subscription_ OAuth is **non-load-bearing** (third-party OAuth is a moving
  target); loopback subscription OAuth defaults to delegation.
- **Naming:** rename the existing `AuthState { status, account, error }` → `AuthFlowState`; `AuthState`
  becomes the resolved tri-state (`authenticated | unauthenticated | unknown`).

## Consequences

- `AuthManager`/`AccountManager` repackaged as `ClaudeAuthProvider` (no behavior change); `CodexStatus`
  deleted; new `OpencodeAuthProvider`; account metadata migrates file → DB.
- The model picker grays out models whose vendor is `unauthenticated` (from the per-vendor probe).

## Implementation note (Phase 5c)

The design above modeled opencode login as `signIn(vendorId)` / `submitCode(code)` (Claude's shape). In
implementation that shape didn't fit opencode's **per-vendor, method-indexed** flow, so
`EngineAuthProvider` gained explicit optional, `canDriveLogin`-gated **per-vendor** methods (Claude does
not implement them; it keeps `signIn`/`submitCode`):

- `listVendorAuthOptions(): Record<VendorId, VendorAuthOption[]>` (`GET /provider/auth`)
- `setVendorApiKey(vendorId, key)` (`PUT /auth/{vendor} {type:'api',key}`)
- `oauthAuthorize(vendorId, method, inputs?) → {url, method:'auto'|'code', instructions}` and
  `oauthCallback(vendorId, method, code)` (`POST /provider/{vendor}/oauth/{authorize,callback}`)
- `removeVendorAuth(vendorId)` (`DELETE /auth/{vendor}`)

Routed by new engine-keyed `vendor-auth:*` IPC channels (the Claude `auth:*`/`account:*` channels are
untouched). `OpencodeAuthProvider` runs these against a transient server (acquire/release
`PERSISTED_SESSIONS_DIR`, like model discovery) since opencode auth is global, and invalidates the model
cache after mutations. Settings › Vendors gained a per-vendor opencode section (API-key forms +
paste-code OAuth; loopback OAuth = delegated hint). **Hosted tools** (ADR-019's "MCP injection") shipped
as an **opencode plugin** (`~/.config/opencode/plugin/`, auto-loaded in opencode's process) registering
`render_mermaid`/`create_mockup`/`show_mockup`, name-normalized to the canonical `mcp__claude-ui*` forms
in the event mapper — `config.plugin` paths don't load and in-process MCP servers can't cross the process
boundary, so a plugin is the in-process mechanism.

## Relation to existing ADRs

- **Amends ADR-014** — Claude's native OAuth becomes one `EngineAuthProvider` implementation;
  mechanism unchanged.
- **Amends ADR-015** — multi-account becomes a capability (`auth.multiAccount`) gated to Claude;
  account metadata moves to the DB while credentials stay file-based per ADR-015.
- Implements **ADR-018** (foundation 4); billing type feeds **ADR-020** metering.
