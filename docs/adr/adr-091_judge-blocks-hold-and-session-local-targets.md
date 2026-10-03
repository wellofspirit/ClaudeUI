# ADR-091: Judge blocks hold for the user; session-booted targets are local

**Status:** Accepted (2026-10-03). Parts 1–2 built (`1aca99e8`, `1a6ee251`); parts 3–4 in progress.
**Amends:** [ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) (rule corpus),
[ADR-088](adr-088_dispatch-autonomy-inheritance.md) and [ADR-089](adr-089_pi-subagents-host-run.md)
(what a delegated call's judge reads). **Relates to:** [ADR-067](adr-067_codex-shared-permission-model.md)
(Codex's own Approve anyway), [ADR-076](adr-076_claude-automode-verdict-on-the-wire.md) (no Claude override),
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md).

## Context

A long pi session in auto mode (macOS, provisioning and testing a local `tart` VM) hit nine judge
blocks. Several recurred after the user had authorized the action in chat, and one was unreachable
in auto mode whatever the user said. The full case list is in `docs/automode-judge-tuning-handoff.md`.
The causes fall into four groups:

1. **Mis-measured redirects.** On macOS every temp-dir env spelling points at `/var/folders/…/T`, so
   `> /tmp/x` always measured out of scope. The quote-blind redirect scan turned `>` inside a
   `sed`/`grep` program into phantom out-of-scope targets.
2. **No notion of a session-local target.** A VM the agent booted this session was judged as a live
   remote host (`remote_host_writes`), its host-only bridge as a public interface, and its own
   egress allow list as exposure (`network_exposure`). "Use tart" did not name tart's own Homebrew
   tap as a source (`untrusted_code_integration`).
3. **The HARD wall.** A throwaway credential the user typed into the chat, put into a subagent
   prompt, matched `data_exfiltration`. Nothing clears a hard block, so the user's explicit
   authorization had no effect.
4. **No override.** On pi, opencode and their dispatch targets, a judge block was final: a deny
   went straight back to the engine and the card showed a chip with no buttons. A card appeared
   only once a denial cap tripped. For delegated calls, chat consent could not reach the judge
   either:
   - a message typed while the parent waited on a foreground child stayed queued;
   - the child's judge read `[...parent transcript, ...child trajectory]`, so a later "go ahead"
     sorted _before_ the block it answered, and post-block consent inheritance never applied.

## Decision

### 1. Redirect measurement (built, `1aca99e8`)

- `tempDirRoots()` adds `/tmp` on POSIX and `/private/tmp` on darwin. Scope matching compares
  spellings and does not resolve symlinks, so both are needed.
- The redirect scan stays quote-blind by default. Single-quoted spans are skipped only when both
  hold:
  - the segment is led by an inert text command (`sed`, `grep`, `rg`, `jq`, `echo`, `printf`, …);
  - nothing in the command re-reads text as shell. That covers shells, `eval`, `ssh`, `sudo`,
    `xargs` and interpreters, plus `awk`, whose own `>` writes a file.

  This is an allowlist rather than a list of re-readers, because the re-reader list would never be
  complete (`git submodule foreach '…'`, `python -c '…'`). Double quotes are never skipped, since
  they host live `$(…)`. Every imprecision falls back to today's over-report.

### 2. Rule corpus (built, `1a6ee251`)

- **Remote Host Writes / Local Operations.** A VM or container this session itself created or
  booted is local scratch infrastructure, like a dev container. One that pre-dates the session
  stays in scope.
- **Network Exposure.** Binding to a host-only virtual network that only the session's guests can
  reach is not exposure, and neither is a guest's own NAT or egress allow list.
- **Untrusted Code Integration.** When the user names a tool, that project's canonical channel
  (documented install method, official tap, its own releases, its registry package) is a routine
  parameter. Mirrors, forks and look-alike names are not.
- **Data Exfiltration (HARD).** A second exception that routes the case to a soft rule, alongside
  the existing provenance one. A credential _the user typed into this conversation_, carried in a
  delegation payload to a harness-run engine, routes to the soft Credential Leakage rule.
  - Handing it to the delegate for use on the target the user named is normal use.
  - Credentials the agent obtained itself never qualify, and neither does any other destination.
  - The HARD rule stays consent-proof: this exception is about where the credential came from and
    where it goes, not about consent. The value is already in the model context, and the user's
    own message, which an injected agent cannot forge, establishes where it came from.

### 3. A judge block holds the call and asks (pi, opencode, their dispatch targets)

- When the judge blocks and no denial cap trips, the pipeline no longer returns `deny`. It returns
  a held block. The engine's existing human path (pi `askHuman`, opencode `fallbackToHuman`, the
  dispatcher's forwarded ask) raises the permission card, flagged as an auto-mode block, under the
  judge's review.
- The card offers **Keep blocked / Approve anyway**:
  - **Approve anyway** runs the exact held call. No outcome annotation is recorded, and the denial
    streak resets.
  - **Keep blocked** answers the model with the judge's own deny text (not "User denied") and
    records `automode-blocked`, as an unheld block does today.
- **Unanswered blocks time out.** After `AUTO_MODE_BLOCK_HOLD_MS` (2 minutes) the hold resolves
  exactly as Keep blocked, and the card is withdrawn. A watched session gets an override; an
  unattended one keeps moving as before.
- **Interrupts and abandonment** force-deny, as for any held ask.
- **HARD blocks are holdable too.** A click on the card is the user reviewing the permission prompt
  directly, which is where the HARD rule's own text sends them. Text in the transcript still never
  clears it.
- **Caps keep their indefinite card.** When a cap trips, today's un-timed human card is raised.
- **Delegated calls** (pi children, dispatch targets) raise the agent-labelled card, so the user can
  approve a subagent's call in place, without relying on transcript order.
- **Not covered:**
  - Claude's judge runs inside cli.js; ADR-076 stands.
  - Codex keeps its native, after-the-fact Approve anyway (ADR-067).

### 4. Delegated judges read the transcript in time order

The judge transcript for a pi child or a pi/opencode dispatch target becomes:

- the parent transcript;
- the parent's still-queued user turns;
- the child's assistant trajectory.

These are merged in timestamp order (a stable sort). A "go ahead" typed after a child's block then
follows the block, so post-block consent inheritance applies. A queued turn renders as a `User:`
line: it is the user's own text, merely not yet delivered to the parent model.

## Consequences

- An unattended auto-mode run pauses up to two minutes at each non-capped block. That is the price
  of a usable override. The constant is the knob if it proves too long.
- An agent can no longer reword its way around a block while the card is up. The hold also closes
  the window that the Auto-Mode Bypass rule exists to police.
- The corpus carve-outs (part 2) rely on the judge model recognising a session-booted VM and a
  canonical install channel. Both are judged from the transcript, which shows the boot and the
  user's naming of the tool.
