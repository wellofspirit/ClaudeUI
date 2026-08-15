# ADR-054 — Step-up policy tiers: separating login auth from presence freshness

**Status:** **Accepted** (owner-ratified 2026-08-15; implementation pending — this ADR is the kickoff's normative source).
**Relates to:** ADR-051 (command registry — the `kind` field becomes security-load-bearing here), ADR-053.
**Supersedes in part:** ADR-052 — its Decision 3 (`passkey-for-grants` as a mode), Decision 5 (grant-decay scope and what feeds it), and the "never reachable remotely" wording of its Decision 3 `off` clause (generalized, not weakened — see Decision 6). Everything else in ADR-052 stands.

## Context

ADR-052 conflated two questions in one knob: **how a connection gets in** (the ceremony at login) and **how fresh its presence proof must stay afterwards** (step-up, decay). Live use immediately surfaced the seams:

- A fresh passkey login followed by a terminal open demanded a *second* ceremony seconds after the first — the login already proved presence; re-proving it gates nothing (owner live-test, 2026-08-15).
- Under the `off` master switch, the terminal still demanded a passkey/password — while unauthenticated model-mediated execution stood wide open. Incoherent by the design's own "honesty about authority" posture.
- A UI hint query (`terminal:pool`, re-asked on window focus) silently slid the shell grant's decay deadline — ambient *reads* were feeding a timer that exists to prove *acting* presence (found in adversarial review; fixed in d1c6e4e ahead of this ADR).
- The owner also wants a stronger posture available ("nothing stays alive forever") without paying for it on every surface, and a coherent story for the headless deployment (no desktop = no "desktop-only" trust anchor).

## Decision

Two independent axes, both persisted in `remote_config`:

- **Auth mode** (existing `remoteAuthPolicy`): `AUTO` / `passkey-always` / `legacy` / `off` — governs the login ceremony. `passkey-for-grants` is **removed as a mode** (it was "legacy login + medium tier" written as one knob); existing stored values migrate to that pair.
- **Step-up tier** (new `stepUpTier`): `strong` / `medium` (default) / `off` — governs post-login freshness.

### 1. The tiers

| Tier | Semantics |
| --- | --- |
| `strong` | Reads and the sync stream are free. Every **mutating** command requires a presence proof no older than its idle window: `shell` acts 10 min, all other mutations 60 min (both configurable). The session itself has an absolute max-age, default **4 h** (configurable): at expiry the connection is cut — stream included — and reconnecting requires a full ceremony. |
| `medium` | Today's shipped behavior, named: step-up gates exactly two areas — the **terminal** (with decay) and the **remote-settings surface** (Decision 6). Everything else rides connection auth for the connection's lifetime. |
| `off` | Nothing is gated post-login; an authenticated session lives until disconnect. |

The dispatch layer decides "mutating" by the registry's declared `kind` (`command` = mutating, `query` = read) — ADR-051's CQRS split becomes security-load-bearing, and `kind` declarations are pinned by tests accordingly.

### 2. Arm-on-auth (kills the double ceremony)

A login that *is* a presence proof arms the relevant grants at accept: a **passkey ceremony** (handshake assertion or the enroll→webauthn upgrade) arms everything its tier would later step-up-gate, fresh. Weaker logins arm nothing and meet the step-up as their **first** presence proof: token (bookmark possession), ambient tailnet identity (network admission), tunnel (fragment possession). The **password never arms at login** — its proof is client-cacheable, so it authenticates the browser, not the human (ADR-052's recorded caveat); it remains the step-up *fallback* where passkeys are unavailable.

### 3. Auth-mode `off` implies tier `off`

Flat — no origin carve-outs. You cannot demand a ceremony from an identity that was never established, and gating a pty while unauthenticated model-mediated execution is open is theater. The `off` banners, typed opt-in, startup warning and audit rows (ADR-052) carry the posture unchanged.

### 4. The shell read/act split (applies in `medium` AND `strong`)

Owner-designed, borrowing the strong-tier principle into the terminal itself:

- **Reads stay free after decay**: an attached view keeps streaming (a `logcat` session runs indefinitely), `terminal:pool` answers, re-`attach`/`detach` to *watch* costs nothing, and `resize` is classified read (display geometry; writes SIGWINCH but cannot execute).
- **Acts demand freshness**: `terminal:create`, input (`terminal:write` / `term-input` frames), `terminal:kill`, `terminal:kill-by-cwd` require the grant within its decay window; the keystroke after an idle gap is what prompts.
- **First access ever still requires one arming proof** per connection (scrollback is sensitive): a connection that has never stepped up (and wasn't armed by a passkey login) cannot attach or read terminals at all. One proof unlocks reads for the connection's lifetime and acts for the decay window.
- **Queries never slide the decay deadline** (landed d1c6e4e): only `command`-kind dispatches and input frames refresh it.

### 5. Audit v12: explicit intent + retention

- New nullable `detail` TEXT column on `audit_log` (migration; same single writer). Auth-event rows carry explicit intent ("passkey login accepted; conferred admin+enroll", "shell grant armed via step-up", "effective policy legacy→passkey-always via first enrollment"); command rows leave it NULL. The `capability` column keeps its conferred-set convention; `detail` removes the need to know it.
- **Retention: uniform moving purge**, default **365 days**, configurable with a **30-day floor**; runs periodically and best-effort (the M-DB3 usage-prune pattern). Uniform means auth rows purge on the same window as command rows — the owner considered and declined an auth-rows-forever exception.

### 6. The host anchor (replaces "desktop-only", ready for headless)

"Desktop-only" was standing in for *"a surface that requires being on the host"* — which the headless deployment (no desktop) forces us to name properly:

- **Auth-disabling operations** — the `off` master switch and anything else that disables authentication — are **host-anchor only, forever**: the desktop renderer today; the server's own console/config file (reached via SSH) on headless. Never the web, even behind a fresh ceremony: a stolen stepped-up session must not be able to turn auth off, on either form factor.
- **Routine remote-access settings** — step-up tier selection, password rotation, credential list/rename/revoke, auth-mode changes **among the non-off modes** — become web-reachable behind a **fresh passkey step-up** (strong-tier freshness for this area regardless of tier). This is what makes headless administrable day-to-day without SSH.
- The structural guard survives intact: no `remote:*`-namespace channel is ever registered on the remote transport; the newly web-reachable settings verbs get their own namespace and declarations, and the `off` writer stays out of them.

## Consequences

- `passkey-for-grants` disappears from the mode UI; stored values migrate to `legacy` + `medium` (one-time, in the same migration as `stepUpTier` and audit v12).
- The step-up prompt generalizes from terminal-flavored to a generic "confirm it's you" surface (strong tier prompts on chat/config/git mutations too).
- Strong tier's stream-cut at max-age lands **before** phase 5 reshapes stream plumbing, deliberately.
- The dispatch path gains a per-tier freshness check keyed on declared `kind` — mislabeling a mutating verb as `query` becomes a security bug, so kind declarations join the pinned parity tests.
- security.md is amended as-built during implementation (tiers, arm-on-auth, read/act split, host anchor, audit v12); ADR-052 gains the cross-reference.

## Rejected alternatives

- **No step-up at all once authenticated** (owner-floated): writes off the stolen-unlocked-device posture the owner set for tailnet exemption; rejected in favor of arm-on-auth + decay.
- **Origin-aware off-mode step-up** (assistant-proposed): retained a password gate on unauthenticated origins under `off`; owner overrode — flat waiver, banners carry the posture.
- **Auth-rows-forever retention exception** (assistant-proposed): declined for a uniform window.
- **Gating reads/stream in strong tier below max-age**: a true read-lock requires stream stop + client state wipe + resync; deferred as a possible privacy-veil follow-on.
