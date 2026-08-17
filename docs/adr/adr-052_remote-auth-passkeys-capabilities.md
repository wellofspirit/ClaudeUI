# ADR-052 — Remote auth v2: passkeys, capability grants with decay, audited no-auth switch, terminal unblocked

**Status:** **Implemented** (2026-08-15). Capability grants, the audit log and the terminal step-up landed with SyncCore phases 1–2; the passkey layer landed in two series — **server core** (WebAuthn ceremony, policy modes, enrollment tokens, passkey step-up, auth-surface disconnect, migration v11) and **client UX** (web login/enrollment/banner, desktop credential management and the policy switch, passkey-first step-up). Normative as-built record: `docs/architecture/security.md`.
**Relates to:** ADR-042 (pinned HTTPS port — unchanged), ADR-046 (remote surface posture), ADR-051 (command registry this rides on)
**Supersedes in part:** ADR-039 (auth *methods & policy* layer; its transport hardening — Host allowlist, throttling, funnel reject, identity-header trust predicate — carries forward unchanged)
**Supersedes:** ADR-048 Decision 5 (terminal-on-mobile declined) and the audit-era `terminal:*` denylist posture
**Superseded in part by:** ADR-054 (step-up policy tiers) — Decision 3's `passkey-for-grants` mode (folds into `legacy` login + `medium` tier), Decision 5's decay scope and feeding rules (read/act split; queries never refresh), and the `off` clause's "never reachable remotely" (generalized to the host-anchor rule). ADR-055 fulfilled the git-watch prediction: the collective-owner workaround this ADR said per-client subscriptions would retire is retired (`git:watch` per-connection interest sets).
**Superseded in part by:** ADR-056 (the admission model) — Decision 3's `legacy` mode is RETIRED (migration v13 rewrites stored rows to AUTO) along with the `passkeyTailnetExempt` toggle and the ambient tailnet admission it exempted from; Decision 4's grant bundles collapse to three outcomes keyed on the METHOD alone, which means the break-glass password now carries `admin`+`enroll` under every policy rather than keeping the base set under `legacy`. The passkey layer itself, the `enroll` capability, the enrollment flow (link, upgrade-in-place, failed-upgrade-keeps-socket) and the audit contract all stand — and the first-device property Decision 4 protected survives, relocated from a grant carve-out to the policy default (see ADR-056 §4).
All other decisions stand.

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

## As-built deviations from this record

Two, both recorded rather than re-litigated; `security.md` carries the detail.

1. **Verb naming.** Decision 4's registry verbs shipped under a `webauthn:*` family rather than the mixed `webauthn:*` / `remote:mint-enroll-token` naming first sketched: minting is a credential operation, and putting it beside `remote:get-config` would have implied it shares that family's desktop-only pinning, which it does not (it is registered for both transports behind `admin`).
2. **`enroll` capability added.** Decision 4's vocabulary grew by one. A one-time enrollment link has to be able to register a credential and reach *nothing else*; expressing that with `admin` would have handed a link the whole management surface, and expressing it with no capability at all would have put the verbs in the base grant set. `enroll` is what makes "this socket may create a credential and only that" representable.

Also worth carrying forward: decision 1's "password fallback where stable HTTPS is unavailable" turned out to be too loose against the as-built transports — the tunnel refuses password at initial auth (its fragment+E2E gate is the transport-native one) while accepting it as the step-up factor inside E2E. The corrected origin × method matrix is in `security.md`.
