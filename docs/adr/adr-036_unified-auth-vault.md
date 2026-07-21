# ADR-036: Unified auth vault — ClaudeUI drives Codex OAuth once, feeds pi + opencode

**Status:** Accepted (implemented on branch `pi`, M6a–M6c)
**Date:** 2026-07-21
**Relates to:** ADR-021 (neutral auth), ADR-014 (Claude OAuth over cli.js — the deliberately-different
precedent), ADR-019 (opencode backend), ADR-035 (pi backend), ADR-030 (capability honesty)

## Context

pi and opencode both authenticate ChatGPT/Codex through the **same** OpenAI OAuth client id
(`app_EMoamEEZ73f0CkXaXp7hrann`) and store structurally-identical `{type:'oauth', access, refresh,
expires}` credentials — pi under `~/.pi/agent/auth.json` key `openai-codex`, opencode under
`$XDG_DATA_HOME/opencode/auth.json` key `openai`. Before this ADR the user had to log in **per
engine** (and pi's OAuth `/login` was TUI-only, so ClaudeUI couldn't drive it at all — ADR-035 shipped
only a "run /login in a terminal" hint). Two costs: redundant logins, and a live hazard — each engine
auto-refreshes in place and the OAuth **refresh token rotates**, so one engine refreshing silently
invalidates the other's stored copy (this nearly stranded opencode during ADR-035 M3 testing).

For the **Codex** credential specifically, Claude Code is **not** a consumer (it doesn't use OpenAI),
and cli.js owns its own Anthropic OAuth end to end (ADR-014) — so v1 feeds only pi + opencode. This
is NOT a blanket "never touch Claude Code" rule, though: the design generalizes to a **per-provider
vend allowlist** (see Consequences) where each credential is fed only to the harness(es) permitted to
use it — a future **Anthropic** provider would vend to **Claude Code only** (Anthropic ToS: their
subscription tokens run only on their own first-party harness), never to pi/opencode.

## Decision

ClaudeUI owns a small **auth vault** and becomes the single point of login + refresh for the shared
Codex credential, feeding both engines' native stores.

- **Vault (M6a, `src/main/auth/vault/AuthVault.ts`):** an encrypted-at-rest credential store at
  `~/.claude/ui/auth-vault.json` (Electron `safeStorage` when available; 0600-plaintext fallback with
  a logged warning — parity with the engines' own unencrypted 0600 stores, not a new regression).
  `safeStorage` is resolved **lazily** off a namespace import so merely importing the module (which
  `session.ipc.ts` does transitively) never requires the Electron `safeStorage` API to exist — a
  partial `electron` test mock can't break unrelated suites.
- **Codex OAuth flow (M6a, `codex-oauth.ts`):** the PKCE-S256 authorize → loopback-callback →
  token-exchange → refresh flow, ported from the vendored opencode source. The loopback callback
  server binds **127.0.0.1** only (matching PiBridgeHost), validates the CSRF `state`, HTML-escapes
  reflected error params, and self-closes after one attempt. The redirect URI stays the registered
  `http://localhost:1455/auth/callback` and the `originator=opencode` param is kept verbatim (both
  are keyed to the client id and cannot be live-tested from here).
- **Feed-forward + sole-refresher + resync (M6b, `CredentialSync.ts`):** on login/refresh/adopt the
  vault writes BOTH engine stores in their exact shapes (RMW, preserving other keys). It refreshes
  **15 minutes before expiry** so it always beats the engines (which refresh only at expiry with no
  margin) — meaning pi/opencode read a still-valid access token off disk and never rotate the shared
  refresh token themselves. Belt-and-braces for the cases the timer can't cover: (1) **reconcile on
  start** adopts the newest of {vault, pi store, opencode store} before scheduling — and bootstraps an
  empty vault from an existing engine credential, so a user's pre-existing (e.g. terminal-`/login` or
  transplanted) token is picked up and kept fresh with no new login; (2) an **fs-watch** on both
  stores adopts an engine-initiated rotation (strictly-newer expiry, different refresh token) and
  re-feeds the sibling, with refresh-token equality as the loop guard against the vault's own writes.
  A revoked refresh token (HTTP 400 `invalid_grant` / 4xx) sets `needsReauth` and halts; 5xx/429/
  network errors back off and retry.
- **Delegation + UI (M6c):** `PiAuthProvider` implements `oauthAuthorize`/`oauthCallback`/
  `cancelVendorOauth` for `openai-codex` only, delegating to `credentialSync`, so the **existing**
  `vendorAuth*` OAuth IPC drives the vault with zero protocol changes. Settings › pi › Providers shows
  a real "Connect ChatGPT (log in once — shared with opencode)" button for `openai-codex`, its
  connection status (via a read-only `pi:auth-status` IPC that never returns token material), a
  `needsReauth` reconnect banner, and disconnect; pi's other subscription vendors keep the terminal
  hint. `PI_ENGINE_CAPABILITIES.auth.canDriveLogin` flips **true** (ADR-030 — the full driven path now
  works for the one vendor).

## Why not reuse ADR-014's cli.js-driven pattern

ADR-014 drives Claude login through cli.js control requests and deliberately does NOT reimplement
OAuth in-process. That option doesn't exist here: pi/opencode expose no headless login control
channel, and their OAuth client changes far less often than cli.js's, so a maintained in-process PKCE
port is the pragmatic choice. This is the one place ClaudeUI implements OAuth itself.

## Consequences

- New `src/main/auth/vault/` (AuthVault, codex-oauth, CredentialSync) + `openai-codex` OAuth
  delegation on `PiAuthProvider`; `OpencodeAuthProvider` gains a direct-file feed/read for its store.
  `credentialSync.start()/stop()` run non-blocking at boot / before-quit.
- **v1 scope: `openai-codex` only.** The vault key + flow are provider-specific; other providers
  are a follow-up. The intended generalization is a **per-provider vend allowlist** — the vault is the
  single central credential manager, and each provider declares which harness stores it feeds:
  `openai-codex → {pi, opencode}`; a future `anthropic → {claude-code}` ONLY (Anthropic ToS bars
  vending subscription tokens to non-Anthropic harnesses). **Open question for the Anthropic case
  (tension with ADR-014):** cli.js currently self-manages its Anthropic OAuth; "vend to Claude Code"
  means the vault writes/refreshes wherever cli.js reads its credential, replacing or coexisting with
  that self-management — verify how cli.js consumes an externally-provided OAuth credential before
  building it.
- A **live opencode server** observes a fed/rotated credential only on its next start (opencode caches
  auth in-process); the refresh-before-expiry timer keeps the on-disk copy valid so a fresh start
  always works.
- **Residual race:** if both engines run and both hit expiry in the same instant while the vault is
  down, one rotation wins and the other engine is briefly stranded until the fs-watch resync re-feeds
  it — bounded, and the reconcile-on-start / watch machinery converges it.
- **Security:** tokens still land in the engines' plaintext 0600 stores regardless of the vault's
  encryption (that's how the engines read them) — the vault's encryption protects only ClaudeUI's own
  copy. The loopback is 127.0.0.1 + CSRF-state-validated. No automated test ever performs a real token
  exchange/refresh (it would rotate and strand the user's real credential) — all token HTTP is mocked;
  the live browser-consent step is verified manually.
- **Trust caveat:** ClaudeUI becomes a third application using pi/opencode's registered OAuth client id
  — already the de-facto situation between those two tools.
