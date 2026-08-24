# ADR-054 — Step-up policy tiers: separating login auth from presence freshness

**Status:** **Implemented** (owner-ratified 2026-08-15; §6 amended and implemented 2026-08-16). Server core landed in `8a4b28d`; client UX, the `authcfg:*` read verb, the read/act client state and the docs amendment landed in the follow-on series; the settings-editing SESSION that replaced the mutation window for that area (§6 amendment) landed after it. As-built detail lives in [security.md](../architecture/security.md) — this ADR keeps the decisions and the reasoning, including the ordering clarifications ratified during implementation (§3/§6 below).
**Relates to:** ADR-051 (command registry — the `kind` field becomes security-load-bearing here), ADR-053, and **ADR-056** (the admission model), which leaves this ADR's host anchor and settings-editing session UNCHANGED and touches it in exactly three places: the auth-mode vocabulary loses `legacy` (Decision text and the §6 amendment's mode list), `authcfg:*` gains two LAN-channel verbs on the gated side of the classifier, and Decision 2's list of "weaker logins that arm nothing" shrinks to the break-glass password now that the token and ambient tailnet identity are retired.
**Supersedes in part:** ADR-052 — its Decision 3 (`passkey-for-grants` as a mode), Decision 5 (grant-decay scope and what feeds it), and the "never reachable remotely" wording of its Decision 3 `off` clause (generalized, not weakened — see Decision 6). Everything else in ADR-052 stands.

## Context

ADR-052 conflated two questions in one knob: **how a connection gets in** (the ceremony at login) and **how fresh its presence proof must stay afterwards** (step-up, decay). Live use immediately surfaced the seams:

- A fresh passkey login followed by a terminal open demanded a _second_ ceremony seconds after the first — the login already proved presence; re-proving it gates nothing (owner live-test, 2026-08-15).
- Under the `off` master switch, the terminal still demanded a passkey/password — while unauthenticated model-mediated execution stood wide open. Incoherent by the design's own "honesty about authority" posture.
- A UI hint query (`terminal:pool`, re-asked on window focus) silently slid the shell grant's decay deadline — ambient _reads_ were feeding a timer that exists to prove _acting_ presence (found in adversarial review; fixed in d1c6e4e ahead of this ADR).
- The owner also wants a stronger posture available ("nothing stays alive forever") without paying for it on every surface, and a coherent story for the headless deployment (no desktop = no "desktop-only" trust anchor).

## Decision

Two independent axes, both persisted in `remote_config`:

- **Auth mode** (existing `remoteAuthPolicy`): `AUTO` / `passkey-always` / `legacy` / `off` — governs the login ceremony. `passkey-for-grants` is **removed as a mode** (it was "legacy login + medium tier" written as one knob); existing stored values migrate to that pair.
- **Step-up tier** (new `stepUpTier`): `strong` / `medium` (default) / `off` — governs post-login freshness.

### 1. The tiers

| Tier     | Semantics                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `strong` | Reads and the sync stream are free. Every **mutating** command requires a presence proof no older than its idle window: `shell` acts 10 min, all other mutations 60 min (both configurable). The session itself has an absolute max-age, default **4 h** (configurable): at expiry the connection is cut — stream included — and reconnecting requires a full ceremony. |
| `medium` | Today's shipped behavior, named: step-up gates exactly two areas — the **terminal** (with decay) and the **remote-settings surface** (Decision 6). Everything else rides connection auth for the connection's lifetime.                                                                                                                                                 |
| `off`    | Nothing is gated post-login; an authenticated session lives until disconnect.                                                                                                                                                                                                                                                                                           |

The dispatch layer decides "mutating" by the registry's declared `kind` (`command` = mutating, `query` = read) — ADR-051's CQRS split becomes security-load-bearing, and `kind` declarations are pinned by tests accordingly.

### 2. Arm-on-auth (kills the double ceremony)

A login that _is_ a presence proof arms the relevant grants at accept: a **passkey ceremony** (handshake assertion or the enroll→webauthn upgrade) arms everything its tier would later step-up-gate, fresh. Weaker logins arm nothing and meet the step-up as their **first** presence proof: token (bookmark possession), ambient tailnet identity (network admission), tunnel (fragment possession). The **password never arms at login** — its proof is client-cacheable, so it authenticates the browser, not the human (ADR-052's recorded caveat); it remains the step-up _fallback_ where passkeys are unavailable.

### 3. Auth-mode `off` implies tier `off`

Flat — no origin carve-outs. You cannot demand a ceremony from an identity that was never established, and gating a pty while unauthenticated model-mediated execution is open is theater. The `off` banners, typed opt-in, startup warning and audit rows (ADR-052) carry the posture unchanged.

**Ordering clarification (owner-RATIFIED during implementation).** Read literally, this decision and Decision 6 collide on an explicitly-`off` tier: one says nothing is gated, the other says the settings verbs carry strong-tier freshness "regardless of tier". The order is resolved **in favour of Decision 6** — the settings verbs demand a fresh presence proof on EVERY tier, `off` included. An operator choosing "don't nag me post-login" is choosing it for their chat and their shell, not for the surface that decides who may connect at all; a session that can silently rewrite the auth mode is the one thing tier `off` must not buy.

This does not weaken Decision 3 in substance: under auth-MODE `off` a connection holds the as-built grant set and never `admin`, so it can never actually administer the settings surface. Note the order precisely, because the obvious statement of it is wrong — the transport checks freshness BEFORE capability, so such a connection meets `needs-step-up` first and only reaches `Permission denied` if it goes on to complete a ceremony. Both walls hold; the freshness one is simply in front.

### 4. The shell read/act split (applies in `medium` AND `strong`)

Owner-designed, borrowing the strong-tier principle into the terminal itself:

- **Reads stay free after decay**: an attached view keeps streaming (a `logcat` session runs indefinitely), `terminal:pool` answers, re-`attach`/`detach` to _watch_ costs nothing, and `resize` is classified read (display geometry; writes SIGWINCH but cannot execute).
- **Acts demand freshness**: `terminal:create`, input (`terminal:write` / `term-input` frames), `terminal:kill`, `terminal:kill-by-cwd` require the grant within its decay window; the keystroke after an idle gap is what prompts.
- **First access ever still requires one arming proof** per connection (scrollback is sensitive): a connection that has never stepped up (and wasn't armed by a passkey login) cannot attach or read terminals at all. One proof unlocks reads for the connection's lifetime and acts for the decay window.
- **Queries never slide the decay deadline** (landed d1c6e4e): only `command`-kind dispatches and input frames refresh it.

### 5. Audit v12: explicit intent + retention

- New nullable `detail` TEXT column on `audit_log` (migration; same single writer). Auth-event rows carry explicit intent ("passkey login accepted; conferred admin+enroll", "shell grant armed via step-up", "effective policy legacy→passkey-always via first enrollment"); command rows leave it NULL. The `capability` column keeps its conferred-set convention; `detail` removes the need to know it.
- **Retention: uniform moving purge**, default **365 days**, configurable with a **30-day floor**; runs periodically and best-effort (the M-DB3 usage-prune pattern). Uniform means auth rows purge on the same window as command rows — the owner considered and declined an auth-rows-forever exception.

### 6. The host anchor (replaces "desktop-only", ready for headless)

"Desktop-only" was standing in for _"a surface that requires being on the host"_ — which the headless deployment (no desktop) forces us to name properly:

- **Auth-disabling operations** — the `off` master switch and anything else that disables authentication — are **host-anchor only, forever**: the desktop renderer today; the server's own console/config file (reached via SSH) on headless. Never the web, even behind a fresh ceremony: a stolen stepped-up session must not be able to turn auth off, on either form factor.
- **Routine remote-access settings** — step-up tier selection, password rotation, credential list/rename/revoke, auth-mode changes **among the non-off modes** — become web-reachable behind a **fresh passkey step-up** (strong-tier freshness for this area regardless of tier). This is what makes headless administrable day-to-day without SSH.
- The structural guard survives intact: no `remote:*`-namespace channel is ever registered on the remote transport; the newly web-reachable settings verbs get their own namespace and declarations, and the `off` writer stays out of them.

**Which factor may administer the settings area (owner-RATIFIED during implementation).** The decision text above says "behind a fresh **passkey** step-up". As built, the settings area accepts either factor the ordinary step-up accepts: **a password step-up may administer the settings area.** Two reasons, and the owner ratified both:

- The break-glass password is the owner's own secret and already carries `admin` + `enroll` under the passkey modes (ADR-052's grant bundles). Refusing it _here_ while accepting it for the terminal would be a distinction with no threat behind it.
- It is what makes the surface recoverable. On a plain-LAN IP or a tunnel hostname no passkey ceremony is possible at all, and a passkey-only settings area would be unreachable from exactly the transports an operator falls back to when something is wrong.

What the password may **never** reach is the `off` switch — that is host-anchor only on every transport and behind no ceremony at all. The line is not "which factor", it is "which operation".

**Headless bootstrap chain (owner-RATIFIED during implementation).** Decision 6 makes a headless box administrable, but "the first passkey comes from the desktop" needed a second answer for a deployment with no desktop. The chain: **(1)** first boot prints a one-time enrollment URL on the console — same single-use short-TTL mint as the desktop's, necessarily at the tailnet HTTPS name because that hostname IS the RP ID; **(2)** the first passkey ceremony arms the settings window through arm-on-auth, so that device reaches `authcfg:*` with no second ceremony; **(3)** `authcfg:*` then covers day-to-day administration, including `authcfg:set-password` to provision break-glass; **(4)** an operator who wants password-only headless provisions the credential through the host's own config/CLI — a password login arms nothing, so the first settings write meets a step-up the password itself may satisfy; **(5)** all-passkeys-lost recovery is a console re-mint, i.e. step 1 again. There is deliberately no network-reachable recovery, because a network-reachable recovery is a network-reachable bypass.

**The read verb.** `authcfg:get` (a `query`, `admin`, no freshness demand) was added during implementation because the decision is unimplementable without it: a settings pane cannot administer a surface it cannot render, and demanding a ceremony before the tier can be DISPLAYED would put the ceremony in front of its own explanation. It answers the same sanitized object `remote:get-config` does — one sanitizer, so no field can be exposed on one transport and forgotten on the other.

**Amendment (2026-08-16, owner-directed): the settings session replaces the mutation window for this area.** The as-shipped gating (each `authcfg` mutation checks the 60-minute mutation window) left administering as a long-lived _ambient_ capability — invisible while held, wide open to accidental exposure, and it forced the timing dials to stay desktop-only as a compensating restriction. Replaced by an explicit, bounded **settings-editing session**:

- The pane is **read-only by default** (a clean view state — the knob sprawl collapses into a summary). One "Edit settings" action; on the web it runs the standard step-up ceremony carrying a `settings` intent; on success the server marks _that connection_ as holding a live settings session, **TTL 5 minutes** — server-side connection state, deliberately not a wire token (the connection is already authenticated and the ceremony just ran on it; a bearer string adds leakable surface without adding proof).
- Every `authcfg` **mutation requires the live session** (the mutation-window check for this class is retired). Save applies the edited set as **one batch** (`authcfg:apply`) — validated together, one audit row whose `detail` carries the diff, one 4009 re-admission sweep (except-actor, actor re-snapshots in place). Save, Cancel, pane close, disconnect, or TTL expiry **revokes the session immediately** — no residue.
- **Every auth-settings change is gated, regardless of direction** — tier upgrades included. Deliberateness is the property; direction special-casing added nothing.
- The **timing dials (re-check idle, session max-age) and retention become web-editable** inside a session — the ambient-exposure argument that kept them desktop-only is void once administering is a bounded mode.
- The **desktop** pane has the same view/edit states but unlocks without a ceremony and without a TTL (host anchor); the `off` master switch and its typed confirm remain desktop-only inside the edit mode.
- **Tier `off` and the session:** opening the editor always costs the ceremony on the web — the pane is the only path to these settings, so the §3/§6 ordering ratification stands, re-mechanized: the ceremony moved from "every verb" to "the door."
- **Headless bootstrap, step 2 revised:** the first passkey ceremony signs the device in; opening the settings editor then runs one deliberate unlock ceremony (rather than riding arm-on-auth's ambient window). One extra tap, and the chain's other steps stand unchanged.

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
