# Remote security model — SyncCore

Part of [architecture/](README.md). **Status:** design accepted 2026-08-13 (ADR-052); companion to [sync-core.md](sync-core.md). Until implemented, the as-built auth stack is ADR-039/042 (which remain in force for transport hardening throughout).

## Posture & threat model

- **Single operator.** All clients are the owner's devices; there is no per-person permissioning (non-goal).
- **Honesty about authority:** any authenticated remote client is *already* operator-level in effect — model-mediated execution (auto mode, remote approvals, full `git:*` including push) is equivalent to code execution on the host. A raw terminal adds immediacy, interactivity, and the absence of an approval gate — not new authority. The design goal is therefore not containment theater but making powerful access **deliberate** (explicit grants + step-up), **attributable** (per-connection identity), and **observable** (audit log, multi-attach visibility).
- **Transport is unchanged:** LAN token / tunnel + E2E / `tailscale serve` TLS, Host allowlist, XFF-keyed throttling, funnel reject (ADR-039), pinned HTTPS port (ADR-042).

## Identity & authentication methods

### 1. Passkeys / WebAuthn — primary

- **Mechanics:** enrollment creates a keypair in the device's authenticator (Secure Enclave / StrongBox / Windows Hello); the private key never leaves it and is gated by the device biometric (`userVerification: required` — FaceID/fingerprint *is* the UV we verify). Authentication is challenge–response: server issues a random single-use challenge (~2 min TTL, server-side state), the authenticator signs after the biometric gate, the server verifies against the stored public key. Unlike the static scrypt proof, an assertion cannot be silently replayed — which is what makes grant decay (below) actually prove human presence.
- **Storage:** `webauthn_credential` table in the operational DB: `{credId PK, publicKeyCose, transports, nickname, createdAt, lastUsedAt, backedUp, aaguid}`. Single-operator ⇒ one fixed user handle, and **discoverable credentials** ⇒ no username step: open the page, biometric, in. A stolen DB leaks public keys only. Sign counters are recorded but not enforced (synced passkeys legitimately zero them).
- **Multi-device:** one row per credential. Synced passkeys (iCloud Keychain / Google Password Manager) make one enrollment cover an ecosystem — surface the `backedUp` flag in the management UI so synced vs device-bound is visible. Cross-ecosystem use rides WebAuthn hybrid transport (QR + BLE) for free.
- **RP ID constraint:** passkeys bind to the serving domain. Stable HTTPS is required — the tailnet DNS name (`<machine>.<tailnet>.ts.net`) is ideal, on desktop and headless alike. Plain-LAN IPs are not a secure context and ephemeral tunnel domains break the binding → password fallback there. Machine/tailnet rename invalidates credentials → re-enroll (accepted).

### 2. Password — break-glass (scrypt, per ADR-039)

**Enabled by default** (owner decision); a "passkey-only" toggle disables it. Recorded caveat: the proof is deterministic and client-cacheable, so it authenticates the *client*, not provably the *human* — acceptable for break-glass, and exactly the gap passkeys close.

### 3. URL token — retained for bootstrap

The 256-bit fragment token remains for QR bootstrap and enrollment links; what it grants depends on the policy mode.

### 4. Tailnet identity — a signal, not a bypass

Logged and used as a username hint. **Under `passkey-always` it does not skip the ceremony** (owner decision: device theft is the threat ambient identity doesn't cover) — configurable for those who want tailnet-only convenience.

## Policy modes (`remoteAuthPolicy`)

| Mode | Behavior |
| ---- | -------- |
| `passkey-always` (default once ≥1 credential is enrolled) | Every connection performs the WebAuthn ceremony — including tailnet-identified ones (configurable). |
| `passkey-for-grants` | Base connection rides transport auth (token/password/tailnet); the ceremony is required only to hold decaying grants (`shell`). |
| `legacy` | The as-built ADR-039 stack, unchanged. |
| `off` — **master switch** | All authentication disabled (owner decision: "if a user didn't want any auth, just disable all auth"). Hard requirements: (1) explicit desktop-side opt-in with a typed confirmation; (2) a **persistent, prominent warning banner** on the desktop settings surface *and* on every connected web client for as long as the mode is active; (3) audit-log entries on enable/disable; (4) a startup log warning. Never reachable from a remote client (`remote:set-config` stays off the remote surface), never silently enabled. |

## Capability grants

Every command in the registry **declares** a capability; undeclared commands fail to register (fail-closed — inverts the as-built denylist, whose failure mode was "forgot to blocklist ⇒ exposed"). Connections hold a grant set derived from auth method × policy × settings; the desktop renderer's connection holds all grants.

Capabilities: `chat`, `session-config`, `config`, `git`, `fs-read`, `shell`, `admin`, `host` (desktop shell only). Per-connection **identity** (method, login/credential nickname, connect time) is attached to every command — enabling the audit log and per-client subscriptions (retiring the collective-owner git-watch workaround).

## Grant decay (sudo semantics)

- **Scope: `shell` only** for now (owner decision; the list is a setting-shaped seam if it grows).
- Idle means *no shell-bearing commands* for `shellGrantIdleMinutes` (default 10, configurable) — reading chat does not keep a shell grant warm.
- On expiry the next shell command returns `needs-step-up`; the client runs a **fresh passkey ceremony** (password fallback where passkeys are unavailable). **Decay applies in `passkey-always` mode too** (owner-ratified: connection auth ages; shells demand freshness).
- Enforced **server-side** (grant table + timers). Client credential caching is irrelevant to enforcement — this is the property that makes the whole scheme real.

## Audit

Append-only SQLite (typed repo enforces append-only):

- **Commands:** `{ts, connectionId, identity, capability, commandType, sessionId?, outcome}`.
- **Auth events:** successes/failures, step-ups, policy changes (master-switch flips prominently included), credential enroll/revoke.
- **Terminal sessions:** spawn/attach/detach/exit with identity, cwd, duration — **never PTY content or keystrokes** (they capture secrets).
- Retention: keep-all by default, configurable.

## Terminal posture

Off by default; a desktop-side "Allow remote terminal" toggle arms the `shell` capability at all. Using it requires the (decaying) `shell` grant + step-up per above. Multi-attach doubles as an audit feature — the owner can watch any remote shell live from the desktop. This supersedes the audit-era `terminal:*` denylist and ADR-048 Decision 5 (terminal-on-mobile declined), both of which were scoped to the pre-SyncCore trust model.

## Enrollment & recovery

- **First device:** from an authenticated desktop session (QR / one-time link, short TTL). **Headless first boot:** console-printed one-time enrollment URL.
- **More devices:** "Add device" from any authenticated admin-capable client mints a one-time enrollment token.
- **Management:** list credentials (nickname, created, last-used, backedUp), revoke individually.
- **Recovery:** all passkeys lost ⇒ re-enroll from local desktop access or the server console; break-glass password if enabled.

## Implementation notes

- Use **`@simplewebauthn/server`** (+ `@simplewebauthn/browser`) — mature, popular, TypeScript, no native deps; never hand-roll CBOR/COSE (supply-chain and correctness posture).
- WebAuthn requires a secure context; `localhost` qualifies for development.

## Relations

Supersedes in part: ADR-039 (methods & policy layer; its transport hardening, throttling, and identity-header trust predicate carry forward). Supersedes: ADR-048 Decision 5 and the audit-era terminal denylist posture. Companion: [sync-core.md](sync-core.md); decision record: ADR-052.
