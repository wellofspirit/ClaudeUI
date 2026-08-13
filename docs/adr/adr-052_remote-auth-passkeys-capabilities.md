# ADR-052 — Remote auth v2: passkeys, capability grants with decay, audited no-auth switch, terminal unblocked

**Status:** Accepted (2026-08-13) — design; implemented with SyncCore phases 1–2 per `docs/architecture/security.md`
**Relates to:** ADR-042 (pinned HTTPS port — unchanged), ADR-046 (remote surface posture), ADR-051 (command registry this rides on)
**Supersedes in part:** ADR-039 (auth *methods & policy* layer; its transport hardening — Host allowlist, throttling, funnel reject, identity-header trust predicate — carries forward unchanged)
**Supersedes:** ADR-048 Decision 5 (terminal-on-mobile declined) and the audit-era `terminal:*` denylist posture

## Context

The remote surface is operator-level in effect (model-mediated execution, remote approvals, full git). The owner wants remote terminals — accepting that raw shell adds immediacy rather than new authority — plus biometric-grade auth. The as-built stack (ADR-039) authenticates *clients* (static replayable password proof, cached tokens), not provably *humans*, and gates the surface with a fail-open denylist. Single-operator scope is confirmed.

## Decision

Normative spec: `docs/architecture/security.md`. The decisions:

1. **WebAuthn passkeys are the primary factor.** Enclave-held keys, `userVerification: required` (FaceID/fingerprint is the UV), server-side single-use challenges — assertions cannot be silently replayed, which is what makes decay (below) prove human presence. Single fixed user handle + discoverable credentials (single-operator ⇒ no username step). Public keys in a `webauthn_credential` table; synced-passkey (`backedUp`) surfaced; hybrid transport for cross-ecosystem. RP ID requires stable HTTPS (tailnet DNS ideal); password fallback where that's unavailable. Implementation via `@simplewebauthn/*`, never hand-rolled COSE.
2. **Password stays as break-glass, enabled by default**, with a passkey-only toggle. Its replayable-proof nature is recorded as accepted for break-glass only.
3. **Policy modes:** `passkey-always` (default once enrolled — ceremony on every connection, **including tailnet-identified ones**, configurable), `passkey-for-grants`, `legacy`, and **`off`** — a master no-auth switch (owner decision) requiring typed desktop-side opt-in, a **persistent warning banner on desktop and every web client**, audit entries, and a startup log warning; never reachable remotely.
4. **Capability grants, fail-closed.** Every command declares a capability (`chat`, `session-config`, `config`, `git`, `fs-read`, `shell`, `admin`, `host`); undeclared commands don't register — inverting the denylist's failure mode. Connections carry identity (attached to every command; feeds the audit log and per-client subscriptions).
5. **Grant decay — `shell` only** (for now): idle = no shell-bearing commands for `shellGrantIdleMinutes` (default 10); expiry ⇒ `needs-step-up` ⇒ fresh passkey ceremony. **Applies in `passkey-always` mode too.** Enforced server-side; client caching is irrelevant.
6. **Terminal unblocked** behind: desktop-side opt-in toggle (off by default) + `shell` grant + step-up. Multi-attach makes remote shells observable from the desktop. Audit records terminal lifecycle metadata — never keystrokes/PTY content.
7. **Append-only audit log** (SQLite): commands with identity, auth events (master-switch flips included), terminal sessions.

## Consequences

- Biometric step-up gives sudo-grade friction (~2 s) instead of password fatigue; grant decay is real because the server owns the timers.
- The denylist's silent-exposure failure mode is gone; new commands are unreachable until classified.
- ADR-048's mobile-terminal decline and the audit's `terminal:*` denylist are formally revisited as intended ("revisiting this means revisiting that audit decision") — the trust model they assumed is replaced.
- `off` mode makes the no-auth trade explicit and loud instead of impossible — the owner's call, with the blast radius stated on-screen while active.
- Enrollment/recovery flows (QR from an authenticated session; headless first-boot console URL; per-credential revoke) are part of the spec.
