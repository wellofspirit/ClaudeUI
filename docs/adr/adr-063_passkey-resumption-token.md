# ADR-063 — Passkey resumption token: a reconnect is not a re-authentication

**Status:** **Accepted** (2026-08-26) — design ratified by the owner in session (in-memory store, 24 h TTL, multi-use, no localStorage).
**Relates to:** ADR-052 (passkeys — the ceremony this token derives from), ADR-054 (step-up tiers — the arming and max-age rules this must not weaken), ADR-056 (admission model — this adds an admission credential and keeps its grant collapse intact), [security.md](../architecture/security.md).
**Amends:** ADR-054 — under the `strong` tier, `sessionMaxAgeHours` is now measured from the last **ceremony**, not from the last connect (see §Strong tier).

## Context

Identity is per-WebSocket-connection (ADR-056): decided once at the handshake, held as socket state, gone when the socket is. That is the right shape for grants and step-up windows — but it makes the _login_ only as durable as the browser's tab lifecycle, and mobile tab lifecycles are brutal. Edge on Android kills backgrounded tabs within minutes; desktop Edge's sleeping tabs freeze the client's pings (the server's 30-minute idle sweep then cuts the socket) and escalate to full discards under memory pressure. Every one of those deaths forces a fresh handshake.

For a **password** client the fresh handshake is silent: the scrypt proof is cached in `sessionStorage` (`password-proof.ts`) and replayed. For a **passkey** client there is nothing to replay — an assertion is challenge-response by design — so every socket death is a tap-plus-biometric. The user holding the _stronger_ credential gets the strictly worse experience, and the security argument for that asymmetry does not hold up: under the default `medium` tier, connection auth already lives for the connection's arbitrary lifetime, so "session length" was never a enforced property — it was an accident of the browser's tab policy. Mobile users were being taxed by a property that is not load-bearing.

## Decision

After every **accepted WebAuthn assertion** — the handshake ceremony and the enroll→webauthn upgrade — the server mints a **resumption token**: 32 random bytes, returned once on the `auth-response`, held by the client in `sessionStorage`, and accepted on a later handshake as a login. It is the passkey's analogue of the cached password proof, with the same trust reading: it authenticates the **browser**, never the human.

### Semantics

- **Mint.** Only a real ceremony mints (handshake assertion, enroll-upgrade assertion, each re-mint replacing nothing — multiple devices hold independent tokens). A resume does **not** re-mint: the token's age is always "time since the last biometric", and a sliding token would be ambient forever-auth wearing a countdown — the exact shape ADR-054's settings-session amendment retired.
- **Store: in-memory, hashed.** The server keeps `sha256(token) → {credId, webauthnOrigin, mintedAt}` in `webauthn-service.ts`, beside the challenge state that already lives there. Nothing is persisted: a host restart logs every passkey device out once, which is an acceptable and _visible_ event, and it means no new stored secret class in the DB. Entries are pruned lazily on access and capped (oldest evicted) so the store cannot grow without bound.
- **TTL: 24 hours, a constant.** Not a config dial — the auth surface has enough dials, and a dial would have to join the auth-surface sweep. If an operator turns out to want it configurable, that is a follow-on.
- **Multi-use within TTL.** No rotate-on-use: refresh-token rotation buys theft _detection_ at the price of a lost-ack race on exactly the flaky mobile reconnects this feature exists for, and the failure mode of multi-use is bounded by the TTL and the transports (TLS / E2E — the token never rides a URL).
- **Accept.** A valid resume comes back as method **`webauthn-resumed`**: `FULL_REMOTE_GRANTS` (a new `grantsFor` arm — same bundle the cached password proof already gets, so this widens nothing), attributed to the bound credential's label, and **never armed**. Terminal acts, the settings session, and strong-tier mutation windows still demand a live ceremony — ADR-054's presence-proof semantics are untouched; only login stickiness changes.
- **Refusal falls through as bare auth.** An unknown, expired, origin-mismatched, or credential-orphaned token is treated exactly as `{type:'auth'}` with no credential: under `passkey-always` the answer is `passkey-required` on the same open socket, and the tap screen is the recovery. No new error code, and **no failure-budget spend** — the budget exists for low-entropy passwords; a 256-bit token is not brute-forceable, and the routine invalidations (host restart, revocation) must not throttle a legitimate phone into lockout. The refusal is audited, so probing is still visible.
- **Origin-bound.** The token records the WebAuthn origin it was minted on and verifies only there. It can only ever exist on a WebAuthn-capable origin (tailnet HTTPS / localhost) — the E2E origins never run a ceremony, so they never mint.
- **The client half mirrors the password proof.** One `sessionStorage` key (origin-scoped by the browser), written on every accept that carries a token, cleared whenever a presented token is not accepted. `sessionStorage` survives the tab discard/restore that causes the reported pain and never outlives the browser session; there is deliberately **no localStorage "stay signed in"** — the owner ruled the session-scoped token sufficient.

### Invalidation

A token dies with: its **TTL**; its **bound credential** (revoking a passkey sweeps its tokens — revoking a synced credential was already documented as revoking it everywhere, and its tokens go with it); a **policy flip to `off`** (re-enabling auth demands fresh ceremonies — nothing minted before the anchor-guarded flip survives it); and a **host restart** (in-memory). An ordinary 4009 auth-surface change deliberately does _not_ invalidate: the fresh handshake presents the token and the rules in force judge it, the same as every other credential.

### Strong tier (the ADR-054 amendment)

If a resume satisfied the 4010 cut naively, `sessionMaxAgeHours` would become decorative — cut, reconnect with the token, repeat. Instead: under `strong`, a resume is accepted only while `now − mintedAt < sessionMaxAgeHours`, and the resumed connection's max-age cut is armed **from `mintedAt`, not from connect**. Max-age now means exactly what its name claims — hours since the last real biometric — which is a strictly more honest reading than the per-socket clock it replaces (24 h TTL > the 4 h default, so the strong tier's check binds first there).

## Consequences

- A passkey phone that round-trips through tab discard, app switch, or an idle cut signs back in silently for 24 h per biometric. The tap screen still appears on: TTL expiry, host restart, credential revocation, the `off` round-trip, a new browser session, and strong-tier max-age.
- **Trust posture is unchanged in substance:** the token is granted exactly what the client-cacheable password proof already had, arms nothing, and cannot reach anything a step-up guards. The one genuinely new exposure is a stolen-from-memory token on the host — bounded by the hash-keyed store — and a stolen `sessionStorage` value on a device, which is the same exposure the password proof has carried since ADR-039.
- `RemoteAuthMethod` gains `webauthn-resumed`; every client/UI site that branches on `'webauthn'` must decide whether it means "the method" or "a passkey identity" — the step-up offer and attribution surfaces mean the latter and include the new method.
- An older server ignores the unknown `resumeToken` field (bare-auth fallthrough → `passkey-required`); an older bundle never sends one. No compatibility lane needed.
- Deferred, deliberately: a TTL dial; localStorage opt-in; step-up ceremonies refreshing the mint (today only login ceremonies mint — a strong-tier session doing regular step-ups is still cut at max-age, matching pre-ADR behavior).
