# ADR-062 — Closing a terminal tab kills the shell; detaching is the modified action

**Status:** **Proposed** (2026-08-25) — owner to ratify.
**Relates to:** ADR-003 (per-cwd terminal groups — the store actions this leaves alone), ADR-052 / [security.md](../architecture/security.md) §Terminal posture (the `shell` capability), ADR-054 (the read/act split the kill is gated by), ADR-060 (the phone's takeover chrome — amended by this), ADR-048 (presentation forks, machinery is shared).
**Supersedes:** the "the safe action stays the unmodified one" stance recorded in [sync-core.md](../architecture/sync-core.md) §Terminal subsystem, whose two close/kill bullets are rewritten to this contract.
**Scope:** the renderer's close affordances and the panel handler behind them. No main-process, pty, IPC, capability or gate change.

## Context

Terminals became a shared per-cwd pool: one pty, several attached viewers. Closing a tab was made **detach-only** on the reasoning that closing a viewer must never take a shell away from another viewer — and the kill moved behind two deliberate gestures, Shift-click on the × and a right-click menu item with an in-menu confirm.

Both halves of that turned out to be wrong in practice:

- **Nobody could find the stop.** The menu was added precisely because the Shift shortcut was invisible, but the underlying problem is that closing a terminal _means_ stopping it. An operator who wants a dev server gone closes its tab and walks away believing it is gone. The cold sweep does not save them: it only reaps cwds with **no live session**, i.e. never the directory being worked in.
- **The phone had no kill at all.** The mobile takeover's tab chip is one always-visible × — no modifier, no right-click, nowhere to hide a second action (ADR-060). Detach-only there is not a conservative default; it is the absence of the verb.

The safety argument that produced the old ordering is real but narrower than it looked. The multi-viewer case is the _uncommon_ one (a second surface attached to the same slot); the common one is a single operator, on one surface, meaning exactly what they clicked.

## Decision

**The unmodified close kills. The modifier guards the safe half.**

### 1. Desktop strip

- × plain click → kill the pty, then close the tab. Tooltip: `Close (kill) — Shift-click to detach, right-click for more`.
- × Shift-click → detach only (the shell keeps running).
- Right-click menu: **"Kill shell"** first (danger), separator, **"Detach (keep shell running)"**.

The menu's **confirm step is deleted**. It guarded the exact action one unmodified click now performs; keeping it would make the discoverable path stricter than the accidental one, which is incoherent and teaches the wrong thing. What the menu still does is _name_ both outcomes for what they do to the shell — which is the job it was actually added for.

### 2. Mobile chip

The chip kills. On a **read-only** surface (ADR-054: reads allowed, act window decayed) it falls back to a detach and keeps the "the shell keeps running" title — the act gate would refuse the kill, and firing a request we know is refused teaches the operator nothing.

### 3. The kill is SEQUENCED, and a refusal keeps the tab

`terminal:kill` first; the tab is dropped only once it resolves. On rejection the tab **stays**:

- `needs-step-up` on the web surface flips the panel into the same decayed-grant state a refused `terminal:create` produces, so the ceremony opens and the operator can retry;
- anything else is logged and the tab is left alone.

There is deliberately **no fallback to a detach**. A tab that vanished while the process kept running is the one outcome this inversion must not produce: it converts "I stopped it" from a true statement into a false one. (`PtyManager.kill` of an already-gone id resolves without error, so "the pty died on its own" still closes the tab cleanly.)

### 4. What does not move

The pool/attach/replay machinery, the `+` re-attach badge and `terminal:pool`, the cold sweep, window-close `killAll`, the panel-level dismissal (back button / panel ×, which hides the surface and kills nothing), every main-process and IPC path, and every capability/step-up verb class. `closeTerminalTab` in the store stays a **pure tab-state drop** — the kill lives in the panel handler, because a store action that killed would also fire on the detach path and on every non-user caller of that reducer.

## Consequences

- **The safety property is now sequencing, not modifiers.** "A close never lies" replaces "a close never kills": the destructive action is one click away, and the price is paid by making it impossible for the tab to disappear when the shell did not.
- **A second attached viewer can lose its shell to somebody else's plain click.** Accepted: the multi-viewer case is the rare one, the pty's own `exit` already propagates to every attached surface, and the operator issuing the click is by construction the person who wanted it stopped.
- **The kill is an act-class verb, so remote terminals inherit the decay behaviour.** A phone whose act window has lapsed detaches instead of killing, which is visible in the tooltip; the desktop is never in that state (`DESKTOP_AVAILABILITY`).
- **Docs amended, not contradicted:** the two `sync-core.md` §Terminal bullets are rewritten, `security.md` §Terminal posture gains the act-class close, and ADR-060 carries a dated note about the chip. ADR-003 needed no change — it states the grouping and the sweep, never close semantics.
