# ADR-057 — Remote vendor OAuth: the host exchanges, the browser returns the code by paste

**Status:** **Implemented** (headless-arc series S4 backend; the renderer paste-field UI is a follow-on). Normative as-built record: [security.md](../architecture/security.md) §"The vendor-credential surface (S4, ADR-057)".
**Relates to:** ADR-014 (native Claude OAuth — cli.js owns the flow), ADR-036 (the unified Codex auth vault this drives), ADR-051 (the command registry the shared declarations ride on), ADR-056 (the admission model + the `admin`→`config` reclassification that made these verbs base-grantable).
**Scope:** the BACKEND — the flow the paste-field UI will call, and its tests. It does not build the renderer UI, the headless server (S3), or any admission/step-up change.

## Context

The last credential family S1b deferred is vendor OAuth: signing into Claude, Codex (ChatGPT), and the opencode/pi vendors from the remote UI. ADR-056 already reclassified these verbs `admin`→`config` (a vendor credential is engine configuration, not the session-security surface); what remained was to register them on the remote transport and make the FLOWS work when the operator is on a phone, not at the host.

The hard part is not the token exchange — it is the redirect. Every one of these flows is a browser OAuth handshake whose `redirect_uri` is **fixed by the vendor's client registration**, which we do not control:

- Claude (cli.js's client) uses a claude.ai page that DISPLAYS a code.
- The Codex vault's client (`app_EMoamEEZ73f0CkXaXp7hrann`, ported from opencode) is registered to `http://localhost:1455/auth/callback` — a loopback.
- opencode's vendor clients use their own loopback / paste registrations.

**We cannot redirect to a ClaudeUI-hosted page.** A redirect URI must be in the vendor client's allowlist, and that allowlist is baked into a client id we did not register and cannot amend. Our origin (a tailnet hostname, a LAN IP, `file://`) is not registrable there, and inventing our own client id per vendor is a separate, larger project (vendor-by-vendor client provisioning, review, secrets) with no headless payoff. So a remote browser completing consent lands on a `redirect_uri` the **host** owns (a loopback the phone can't reach) — a dead page — with the one thing we need sitting in its address bar: the full `?code=&state=` URL.

The invariant that makes this tractable: **the host always performs the token EXCHANGE.** It holds the PKCE verifier and writes the credential stores; the exchange is a server-to-server POST that has no reason to happen anywhere but the host. Consent, and the return of the authorization CODE, are the only parts that must work from an arbitrary browser.

## Decision

**The host exchanges; the authorization code returns from the browser by whatever path the vendor's fixed redirect allows.** Three per-flow strategies, one shared principle.

### 1. Claude — the manual URL (the path already existed)

cli.js's `claude_authenticate` already returns a `manualUrl` whose claude.ai page displays a code, and `claude_oauth_callback(code, state)` already exchanges it host-side (ADR-014's manual fallback). Remote just needed the verbs registered and `manualUrl` surfaced, plus one behavioural change: **the host must not open its own browser for a remote-initiated sign-in.**

`AuthManager.signIn({ remote })` is the whole change. `remote` is derived, not asserted: the shared handler reads `connection.identity.method` — the desktop connection is `'desktop'` (opens the host browser, byte-identical to before), any other method is remote (skips `shell.openExternal`, returns `manualUrl` on the `AuthFlowState`). This is the "origin-derived flag": ONE handler body whose behaviour follows WHO called, never a second copy. `account:add` threads the same flag (it kicks off a login for the new account). The code returns via `auth:submit-code`.

### 2. Codex vault — paste the whole callback URL

The registered redirect is `http://localhost:1455/auth/callback`. From a remote browser that lands on the CLIENT's loopback (dead page) whose address bar holds the full `?code=&state=` URL. `CodexLoginFlow.completeFromPastedInput(input)` accepts EITHER the whole pasted URL / query fragment OR a bare code (verbatim), and calls the existing `exchangeCodeForTokens` with the held `pkce`/`redirectUri`. The result flows through the same `CredentialSync` write path the loopback uses, so both engines' stores are written identically. It is wired through `PiAuthProvider.oauthCallback`'s existing `code` argument — a non-empty `code` is treated as pasted input, an empty one falls back to the loopback wait — so the `vendor-auth:oauth-callback` verb drives it with no new argument. The desktop loopback stays intact.

**CSRF, by input SHAPE — not blanket equivalence with the loopback.** The two paths are NOT identically strict, and the difference is deliberate and bounded:

- A **URL / query paste is state-bearing**, so it gets the loopback's EXACT check — `handleCallback`'s `!this.state || state !== this.state`, i.e. a MISSING or mismatched `state` is rejected. A full callback URL with the `state` param stripped is refused, exactly as the loopback would refuse it (this is the guard the tightening added; it was the one divergence).
- A **bare pasted code cannot carry `state`** (the user copied only the code), so it necessarily proceeds on **PKCE alone** — the host-held, flow-bound `code_verifier` is the CSRF defense there, which is the sanctioned fallback of OAuth 2.0 Security BCP §2.1 (PKCE substitutes for `state` as the per-request binding). This is the only shape that skips the state check, and it skips it by necessity, not by leniency.

`parsePastedCallback` returns a `structured` flag so the caller branches on shape rather than on "did a state value happen to be present" — which is what let a stripped-state URL slip through before.

### 3. opencode — `code` works as-is, `auto` is refused remotely

opencode's `code` method is already paste-based and completes remotely unchanged. Its `auto` method drives a loopback **inside the host's opencode server process**, which a remote browser cannot reach — the same problem as Codex, but the loopback and PKCE state live in a process we relay to over HTTP, so we cannot inject a pasted URL into it cheaply. So `auto` is **refused from a remote caller** with an actionable message (use the `code` method, or sign in from the desktop): the shared `vendor-auth:oauth-authorize` handler tears the just-started flow down (`cancelVendorOauth`) and throws when `isRemote(connection) && engineId === 'opencode' && result.method === 'auto'`. pi's Codex `auto` is deliberately NOT refused — it has the paste-back path above.

### 4. pi's other vendors — unchanged

anthropic / github-copilot / xai / radius stay terminal-hint `/login`, which works over the remote terminal already. No new code.

### 5. Token material never crosses the wire

`probe` / `list-keys` / `pi:auth-status` return `authState` / credential-kind / labels / booleans only; the mutations return void. No handler returns `access` / `refresh` / a key. This is a pinned test, not a convention.

## Consequences

- **One shared declaration, both transports.** `ipc/auth-commands.ts` is a factory (like `config-commands.ts`) that `session.ipc.ts` (desktop) and `remote-handlers.ts` (remote) both spread. The desktop-auth subsystem (`engineAuthRegistry`, `account-manager`) stays in `src/main` because it opens the host browser, so the factory takes `requireEngineAuth` / `setAccountEnabled` INJECTED at the boot seam — the Electron-free core registrar never imports the `src/main` singletons. Absent deps (tests), the channels still register but each handler throws, so the remote surface is the same shape in tests as in production (the `enrollTokens` precedent).
- **The registration is the guarantee, not the capability.** These are `config`, which is base-grantable; what kept them desktop-only was always the absence of a remote registration, and S4 adds it deliberately. `remote-handlers.ipc.test.ts` pins the exact remote channel set; a future desktop-only auth verb must be written as a decision.
- **The paste-field UI landed as S4-UI** (2026-08-18): one shared `OAuthPasteBackFlow` component mounted by both entry areas — chat (`AuthBanner`, `VendorAuthRequiredCard`) and settings (accounts, provider panes) — web-only, with the desktop auto-flow untouched. The `auth:state` event was deliberately NOT wired to remote connections: an in-flight flow belongs to the one client that started it (`manualUrl` carries the flow's CSRF `state`, and `AuthManager` holds a single `pendingState`, so a broadcast would let any admitted connection complete the flow with its own account). Instead `account:add` returns `pendingSignIn: AuthFlowState` on its own invoke — the same per-caller delivery `auth:sign-in` always had.
- **No ClaudeUI-hosted redirect, ever, unless we register our own vendor clients.** If that project is undertaken later, the paste-back path remains the correct fallback for any vendor whose client we do not own.
