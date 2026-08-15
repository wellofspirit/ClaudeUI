# Remote security model — SyncCore

Part of [architecture/](README.md). **Status:** **implemented** (ADR-052) — server core landed 2026-08-15, client UX alongside it; companion to [sync-core.md](sync-core.md). ADR-039/042 remain in force for transport hardening throughout. Sections below describe what is BUILT unless a line says otherwise; the code of record is `src/main/services/webauthn-service.ts` (ceremony), `auth-policy.ts` (modes and grants), `remote-server.ts` (handshake), `src/main/ipc/webauthn-commands.ts` (management verbs), `src/web/connection.ts` (client state machine).

## Posture & threat model

- **Single operator.** All clients are the owner's devices; there is no per-person permissioning (non-goal).
- **Honesty about authority:** any authenticated remote client is *already* operator-level in effect — model-mediated execution (auto mode, remote approvals, full `git:*` including push) is equivalent to code execution on the host. A raw terminal adds immediacy, interactivity, and the absence of an approval gate — not new authority. The design goal is therefore not containment theater but making powerful access **deliberate** (explicit grants + step-up), **attributable** (per-connection identity), and **observable** (audit log, multi-attach visibility).
- **Transport is unchanged:** LAN token / tunnel + E2E / `tailscale serve` TLS, Host allowlist, XFF-keyed throttling, funnel reject (ADR-039), pinned HTTPS port (ADR-042).

## Identity & authentication methods

### 1. Passkeys / WebAuthn — primary

- **Mechanics:** enrollment creates a keypair in the device's authenticator (Secure Enclave / StrongBox / Windows Hello); the private key never leaves it and is gated by the device biometric (`userVerification: required` — FaceID/fingerprint *is* the UV we verify). Authentication is challenge–response: server issues a random single-use challenge (~2 min TTL, server-side state), the authenticator signs after the biometric gate, the server verifies against the stored public key. Unlike the static scrypt proof, an assertion cannot be silently replayed — which is what makes grant decay (below) actually prove human presence.
- **Storage:** `webauthn_credential` table in the operational DB (migration v11): `{credId PK, publicKeyCose, transports, nickname, createdAt, lastUsedAt, backedUp, aaguid, signCount}`. Single-operator ⇒ one fixed user handle, and **discoverable credentials** ⇒ no username step: open the page, biometric, in. A stolen DB leaks public keys only.
- **Sign counters are recorded, never enforced** — and that is a deliberate ACT, not an omission. `@simplewebauthn/server`'s `verifyAuthenticationResponse` enforces counter regression by default; `webauthn-service.ts` feeds it `counter: 0` for every credential, which is the documented way to opt out. Synced passkeys (iCloud Keychain, Google Password Manager) legitimately report 0 forever, so the default would lock out exactly the credentials this design is built around. The stored `sign_count` is updated on each assertion for forensics only.
- **Multi-device:** one row per credential. Synced passkeys make one enrollment cover an ecosystem — the `backedUp` flag is surfaced in the desktop credential list ("Synced" badge vs "Only on that device"), because revoking a synced credential removes it everywhere it syncs to. Cross-ecosystem use rides WebAuthn hybrid transport (QR + BLE) for free.
- **RP ID constraint:** passkeys bind to the serving domain, so the RP ID comes from the request `Host` the allowlist already validated — never from anything the client asserts about its own context. Exactly two origins qualify (`resolveWebauthnOrigin`): the tailnet DNS name (`<machine>.<tailnet>.ts.net`) and `localhost` for development. Machine/tailnet rename invalidates credentials → re-enroll (accepted).

### Origin × method matrix (as built)

This supersedes the earlier loose "password fallback there" line. What a connection may present depends on its ORIGIN, not only on the policy mode:

| Origin | Initial auth | Step-up (`shell`) |
| ------ | ------------ | ----------------- |
| Tailnet HTTPS (secure context, stable RP ID) | Ceremony per policy mode; break-glass password when enabled | Passkey ceremony; password fallback when enabled |
| Tunnel (ephemeral hostname + E2E) | Fragment token + E2E. Password at initial auth stays **refused** — an E2E session needs the fragment key a password client does not have, so fragment+E2E *is* this transport's gate (`remote-auth.ts`) | Password proof **inside** E2E. The socket is already authenticated and encrypted end to end, so the tunnel edge sees only ciphertext. A passkey is impossible here (no stable RP ID) |
| LAN plain HTTP (IP; not a secure context) | Token / password, as built — the browser has no WebAuthn API to offer | Password proof, as built |
| Desktop renderer (MessagePort) | The port IS the trust — never any ceremony | Never decays (`shellGrantExpiresAt === undefined`) |

Consequence: the `passkey-always` ceremony requirement applies to connections arriving on a **WebAuthn-capable origin**. On the others the as-built methods and grants stand, and `passwordAuthAllowed` / `passwordStepUpAllowed` deliberately ignore the `passkey-only` toggle there — honouring it would silently reduce LAN and tunnel to token-only, which is not what "passkey only" means to whoever set it, and is how people lock themselves out.

### 2. Password — break-glass (scrypt, per ADR-039)

**Enabled by default** (owner decision); a "passkey-only" toggle disables it. Recorded caveat: the proof is deterministic and client-cacheable, so it authenticates the *client*, not provably the *human* — acceptable for break-glass, and exactly the gap passkeys close.

### 3. URL token — retained for bootstrap

The 256-bit fragment token remains for QR bootstrap and enrollment links; what it grants depends on the policy mode.

### 4. Tailnet identity — a signal, not a bypass

Logged and used as a username hint. **Under `passkey-always` it does not skip the ceremony** (owner decision: device theft is the threat ambient identity doesn't cover) — configurable via `passkeyTailnetExempt` for those who want tailnet-only convenience, and an exempted connection gets the LEGACY grants, never the passkey ones.

## Policy modes (`remoteAuthPolicy`)

Stored in `remote_config.auth_policy`, a **nullable** column where **NULL means AUTO**. AUTO is resolved per connection (`resolveAuthPolicy`): ≥1 enrolled credential ⇒ `passkey-always`, otherwise `legacy`. An explicitly stored value always wins. That is how "default once a credential is enrolled" holds without any code ever WRITING a policy behind the operator's back — enrolling the first passkey turns the mode on and revoking the last one turns it back off, and neither is a config mutation that could surprise someone reading the settings row.

| Mode | Behavior |
| ---- | -------- |
| AUTO (the `NULL` default) | `legacy` until the first passkey is enrolled, then `passkey-always`. |
| `passkey-always` | Every connection on a WebAuthn-capable origin performs the ceremony — including tailnet-identified ones, unless `passkeyTailnetExempt` is set. The exemption yields the LEGACY grant set, never the passkey one: ambient network identity is not evidence of device possession, so it must not buy `admin`/`enroll`. |
| `passkey-for-grants` | Base connection rides transport auth (token/password/tailnet); the ceremony is required only to hold decaying grants (`shell`). |
| `legacy` | The as-built ADR-039 stack, unchanged. |
| `off` — **master switch** | All authentication disabled (owner decision: "if a user didn't want any auth, just disable all auth"). Hard requirements, all built: (1) explicit desktop-side opt-in with a typed confirmation — the operator types `disable remote authentication` verbatim before the write is enabled (`RemotePasskeySettings.tsx`); (2) a **persistent, non-dismissible warning banner** on the desktop settings surface *and* on every connected web client for as long as the mode is active. The web client keys that banner on `auth-response.authDisabled`, which the server sets on EVERY accept while the effective policy is `off` — deliberately not on `method === 'none'`, because ambient tailnet identity is still evaluated under `off` (it is worth keeping in the audit trail), so the owner's own phone is admitted as `tailnet-identity` and would never have seen the warning. `method === 'none'` remains a compatibility fallback for a server built before the field. A mid-session flip needs no push: the auth-surface disconnect (4009) already makes every live client reconnect and read a fresh `auth-response`; (3) audit-log entries on enable/disable; (4) a startup log warning. Never reachable from a remote client — `remote:set-config` has no remote registration at all, which is the structural reason and not merely a capability check (a passkey connection DOES hold `admin`). |

An **auth-surface change** — a `remote:set-config` write that moves any of `authPolicy` / `effectiveAuthPolicy` / `passwordBreakGlass` / `passkeyTailnetExempt`, *including* the AUTO flips caused by enrolling the first credential or revoking the last — does two things together (`authSurfaceChanged`): appends one `auth:policy-change` audit row, and drops every live remote client with close code **4009** so they re-authenticate under the new rules. The ACTOR is spared the disconnect. Clients treat 4009 as "reconnect and re-decide", never as a credential rejection.

## Capability grants

Every command in the registry **declares** a capability; undeclared commands fail to register (fail-closed — inverts the as-built denylist, whose failure mode was "forgot to blocklist ⇒ exposed"). Connections hold a grant set derived from auth method × policy × settings; the desktop renderer's connection holds all grants.

Capabilities: `chat`, `session-config`, `config`, `git`, `fs-read`, `shell`, `admin`, `enroll`, `host` (desktop shell only). `enroll` is ADR-052's addition and exists to be *separable* from `admin`: a one-time enrollment link must be able to register a credential and reach nothing else — not chat, not config, not git. Per-connection **identity** (method, login/credential nickname, connect time) is attached to every command — enabling the audit log and per-client subscriptions (retiring the collective-owner git-watch workaround).

Grant bundles by method (`grantsFor`): `webauthn` and break-glass `password` get the full remote set **plus `admin` and `enroll`** (under `legacy`/`off` the password keeps the as-built set, so opting out of passkeys is not a silent privilege increase); `enroll-token` gets `enroll` ONLY, and does not widen after a successful registration — it re-runs the assertion on the same socket and comes back as `webauthn`; `token` / `tailnet-identity` get the as-built set unless a ceremony is owed, in which case the connection is never accepted at all; `none` (`off`) gets the as-built remote set and deliberately NOT `admin`/`enroll`, because enrolling a credential while authentication is disabled would let any reachable client mint itself a permanent one.

**N6 — shared slot pool: RATIFIED as designed.** Terminals stay an ordered per-cwd pool shared by every surface (see §Terminal posture); naming a slot is not a capability, and the three gates run identically whichever surface opens it.

## Grant decay (sudo semantics)

- **Scope: `shell` only** for now (owner decision; the list is a setting-shaped seam if it grows).
- Idle means *no shell-bearing commands* for `shellGrantIdleMinutes` (default 10, configurable) — reading chat does not keep a shell grant warm.
- On expiry the next shell command returns `needs-step-up`; the client runs a **fresh passkey ceremony** — `step-up-challenge-request` → sign → `step-up {assertion}` — with the password as fallback where passkeys are unavailable or break-glass is on. The step-up challenge is bound to its own `step-up` KIND, so a handshake challenge cannot be replayed into a grant (nor the reverse), and both factors spend the SAME per-key failure budget: an assertion brute force gets no fresh allowance for arriving in a different frame field. **Decay applies in `passkey-always` mode too** (owner-ratified: connection auth ages; shells demand freshness).
- **Under `off`, step-up still demands a factor** (as-built): the master switch disables *authentication*, and the shell grant is an authorization ceremony on an already-admitted socket. `passwordStepUpAllowed` returns true under `off`, so a password proof arms it — an `off`-mode server with no password provisioned answers `no-password` and the terminal stays locked.
- Enforced **server-side** (grant table + timers). Client credential caching is irrelevant to enforcement — this is the property that makes the whole scheme real.

## Audit

Append-only SQLite (typed repo enforces append-only):

- **Commands:** `{ts, connectionId, identity, capability, commandType, sessionId?, outcome}`.
- **Auth events:** successes/failures, step-ups, policy changes (master-switch flips prominently included), credential enroll/revoke. ADR-052 adds three `auth:*` channels, written through `appendAuditLog` with the same row shape: `auth:webauthn-assert` (every handshake, enroll-upgrade and step-up assertion, `outcome` ok/error), `auth:enroll-token` (a one-time link consumed, or refused), and `auth:policy-change` (one row per auth-surface change, from either the config path or the credential path — `auditAuthPolicyChange` is the single writer so an audit reader never has to know which path produced it). Credential enroll/revoke additionally ride the ordinary `command`-kind dispatch rows for `webauthn:*`.
- The `capability` column is TEXT, not an enum, and these `auth:*` rows carry the capability the event is ABOUT (`admin` for handshake/policy events, `enroll` for enrollment-token events, `shell` for step-up) rather than one the connection held at the time — the connection frequently held nothing. Recorded here because it is a convention a reader has to know; it is not enforced anywhere.
- **Terminal sessions:** spawn/attach/detach/exit with identity, cwd, duration — **never PTY content or keystrokes** (they capture secrets).
- Retention: keep-all by default, configurable.

## Terminal posture

Off by default; a desktop-side "Allow remote terminal" toggle arms the `shell` capability at all. Using it requires the (decaying) `shell` grant + step-up per above. Multi-attach doubles as an audit feature — the owner can watch any remote shell live from the desktop. Terminals are an ordered per-cwd pool ([sync-core.md](sync-core.md) §Terminal), so an open names a SLOT and may resolve to a pty another surface spawned: that changes which pty an open lands on, never who may open one. Naming a slot is not a capability — `terminal:create`/`attach` run the same three gates either way, so an unauthenticated or un-stepped-up client cannot reach the operator's shell by guessing an index. The index is nonetheless attacker-controlled data on a granted socket, and claiming a slot pads the pool array up to it, so it is **bounded** (`MAX_POOL_INDEX`, 64) and refused past that with the malformed-index error: without the clamp a single `terminal:create(cwd, 2**31-1)` frame hangs or OOMs the main process before any pty is spawned — availability, not authority. `terminal:attach` is registered for the desktop transport too (it is how a desktop tab replays a pty it did not spawn) and is audited there on the same `command`-kind dispatch. This supersedes the audit-era `terminal:*` denylist and ADR-048 Decision 5 (terminal-on-mobile declined), both of which were scoped to the pre-SyncCore trust model.

## Enrollment & recovery

- **The first device requires the desktop path, BY CONSTRUCTION.** Under effective-`legacy` (AUTO with nothing enrolled) a break-glass password connection holds the as-built grant set and therefore no `enroll` — so the server refuses `webauthn:register-*` on it. That is the stolen-password hardening, not a gap: a password is a static, client-cacheable proof, and letting one mint a permanent credential would make the theft permanent too. The first passkey comes from an authenticated desktop session (QR / copied link / "open in browser", short TTL), or from the console-printed URL on a headless first boot.
- **Inline self-enroll works once a passkey mode is effective.** With ≥1 credential enrolled, a break-glass password connection carries `admin` + `enroll`, so the web client's post-password offer ("Enroll this device") registers on the connection it is already on. The offer is non-blocking and its dismissal is remembered per device; when the server refuses it, the client renders the desktop guidance above rather than an error.
- **More devices:** "Add device" from any `admin`-capable client mints a one-time token. Minting requires `tailscale serve` to be UP and fails with `enroll-unavailable` otherwise — not as a convenience check: the URL's hostname IS the RP ID the credential binds to, so a link pointing at a LAN IP or a tunnel would produce either a failed ceremony or a credential bound to a name that will not exist tomorrow. **Enrollment therefore always happens at the tailnet origin.** Tokens are single-use with a short TTL and live in an in-memory map, so a process restart invalidates them; each UI action mints a fresh one.
- **The enrollment socket never widens silently.** A `#enroll=<token>` link authenticates an `enroll`-only connection; after `webauthn:register-verify` succeeds the client runs the assertion ceremony *on the same socket* and is upgraded in place to `webauthn` (same connection id, one thread in the audit log). A registration that half-completed leaves an `enroll`-only socket, not an admin one.
- **Enrollment has to say so, or ambient identity preempts it (`?intent=enroll`).** Enrollment can only happen at the tailnet origin — that hostname *is* the RP ID — and that is exactly the origin where `tailscale serve` attaches an owner identity the server accepts at CONNECTION time, before any client frame. For the FIRST device nothing is enrolled, so the policy is effective-`legacy`, so no ceremony is owed, so the unsolicited tailnet accept always wins the race: the phone lands in the app as an ordinary session with its enrollment token unspent and no biometric ever requested. The client therefore opens the WebSocket with a `?intent=enroll` query parameter whenever the credential it is about to present is an enrollment link, and the server skips the unsolicited accept for that socket and authenticates from the `auth` frame instead. The **token never rides the query string** — only the non-secret intent does. Declining ambient identity is fail-closed: a socket that sets the flag and then presents no token, or a bad one, is refused like any other bad credential. The flag is derived per-connect from the credential, so the "sign in normally instead" escape drops it and ambient identity works again on the next socket.
- **A failed UPGRADE keeps that socket.** The server does not close on a refused upgrade assertion, and the client must not either: the token was consumed to authenticate the socket, so reconnecting would present a burned credential — a dead end reached *with* a perfectly good passkey already registered. The retry re-runs the assertion only; asking for registration options again would hand the authenticator an `excludeCredentials` list containing the key it just made. Once the upgrade lands, the client strips `#enroll=` from the address bar so a reload or a bookmark cannot re-present a spent secret, and a definitively refused link offers "sign in normally" rather than dead-ending.
- **The desktop renderer never runs a ceremony.** It loads from `file://` (or the vite dev origin), so it has no RP ID and its connection's `webauthnOrigin` is null. Only the four management verbs are registered for the desktop transport (`webauthn.ipc.ts`); the two register verbs are remote-only.
- **Management:** list credentials (nickname, created, last-used, `backedUp`), rename inline, revoke individually. Revoking the LAST credential is refused (`last-credential-lockout`) only when the policy is *explicitly* `passkey-always` and no usable break-glass password exists — under AUTO it simply reverts to `legacy`, which is what AUTO means. The guard demands the password actually EXISTS, not merely that the toggle is on.
- **Recovery:** all passkeys lost ⇒ re-enroll from local desktop access or the server console; break-glass password if enabled.

## Implementation notes

- Use **`@simplewebauthn/server`** (+ `@simplewebauthn/browser`) — mature, popular, TypeScript, no native deps; never hand-roll CBOR/COSE (supply-chain and correctness posture).
- WebAuthn requires a secure context; `localhost` qualifies for development.
- **Client channel family:** `webauthn:register-options`, `webauthn:register-verify` (capability `enroll`, remote transport only), `webauthn:credentials`, `webauthn:rename`, `webauthn:revoke`, `webauthn:mint-enroll-token` (capability `admin`, both transports). The web `api-adapter` mirrors all six per ADR-008; the desktop preload mirrors the four that exist there and rejects the other two locally.
- **Every ceremony starts from a tap.** `navigator.credentials.get()` needs a transient user activation on Safari/iOS, so a `passkey-required` answer on a page nobody has touched only ever renders the one-tap screen. Within a tap the client *auto-continues*: the socket it needs may be down, so the tap connects, and the `passkey-required` that comes back on the fresh socket starts the ceremony without a second tap. That arming lives and dies with the attempt — any settled failure (socket lost, 120 s budget spent, prompt dismissed) returns the user to the tap screen rather than leaving a later reconnect free to raise a biometric prompt nobody asked for.

## Relations

Supersedes in part: ADR-039 (methods & policy layer; its transport hardening, throttling, and identity-header trust predicate carry forward). Supersedes: ADR-048 Decision 5 and the audit-era terminal denylist posture. Companion: [sync-core.md](sync-core.md); decision record: ADR-052.
