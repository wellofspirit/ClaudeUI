# ADR-021: Neutral auth/account model — EngineAuthProvider, per-vendor probe

**Status:** Accepted (V2 design; sequenced in `docs/v2/implementation-plan.md`)
**Date:** 2026-06-19
**Amends:** [ADR-014](adr-014_native-anthropic-oauth.md), [ADR-015](adr-015_multi-account-file-credentials.md)

## Context

Auth differs by engine at the mechanism level: ClaudeUI *drives* Claude's OAuth (service session +
control requests, ADR-014) and manages multi-account file credentials (ADR-015); opencode *delegates*
(owns `auth.json`, multi-vendor) but exposes auth-setting endpoints. V2 needs one neutral interface
over both. Detail: `docs/v2/04-auth-accounts.md`.

## Decision

- **`EngineAuthProvider` per engine**, capability-gated by `capabilities.auth { canDriveLogin,
  multiAccount }` (ADR-018):
  - **`ClaudeAuthProvider`** — full: probe + in-app OAuth + multi-account; wraps today's `AuthManager`
    + `AccountManager` + service session **unchanged** (ADR-014/015 internals preserved).
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
- **ToS posture:** in-app *subscription* OAuth is **non-load-bearing** (third-party OAuth is a moving
  target); loopback subscription OAuth defaults to delegation.
- **Naming:** rename the existing `AuthState { status, account, error }` → `AuthFlowState`; `AuthState`
  becomes the resolved tri-state (`authenticated | unauthenticated | unknown`).

## Consequences

- `AuthManager`/`AccountManager` repackaged as `ClaudeAuthProvider` (no behavior change); `CodexStatus`
  deleted; new `OpencodeAuthProvider`; account metadata migrates file → DB.
- The model picker grays out models whose vendor is `unauthenticated` (from the per-vendor probe).

## Relation to existing ADRs

- **Amends ADR-014** — Claude's native OAuth becomes one `EngineAuthProvider` implementation;
  mechanism unchanged.
- **Amends ADR-015** — multi-account becomes a capability (`auth.multiAccount`) gated to Claude;
  account metadata moves to the DB while credentials stay file-based per ADR-015.
- Implements **ADR-018** (foundation 4); billing type feeds **ADR-020** metering.
