# ADR-104: Session tools — agents start, hand off to and message other sessions

**Status:** Accepted (2026-10-18; §6's root-agent-only rule amended by [ADR-105](adr-105_background-dispatch.md): dispatch children may use `session_message` within their own family). Implemented on branch `session-tools` (slices: registry fix, delivery and
origin, native peer messages, links, the tools on Claude, proposals, the other engines, context pressure,
grouping).
**Relates to:** [ADR-033](adr-033_cross-engine-dispatch.md) (cross-engine dispatch stays the subagent
feature), [ADR-038](adr-038_event-driven-approval-lifecycle.md), [ADR-050](adr-050_auto-mode-as-the-default-autonomy.md)
(auto availability gate on a started session's mode), [ADR-059](adr-059_no-silent-model-fallback.md) (spawn errors),
[ADR-073](adr-073_agent-roster-and-task-run-identity.md) (in-session roster),
[ADR-085](adr-085_deny-ask-rules-hold-allow-rules-skip-judge.md) and
[ADR-088](adr-088_dispatch-autonomy-inheritance.md) (auto-mode judge), [ADR-093](adr-093_zoom-trap-no-viewport-units.md),
[ADR-099](adr-099_one-ui-bundle.md), ADR-102 (session orchestrator, branch `orchestrator`: it will consume
these tools; this ADR is not built on it).

## Context

A long-running agent session often holds the context needed to start the next piece of work: an assistant
session that triages messages and tickets and could start task sessions itself, or a coding session whose
context has grown heavy and should continue in a fresh session. Today the user does this by hand: opening a
new session, pasting the old session's id, and having the new session re-read the old transcript.

Claude Desktop ships this as host-side tools rather than a Claude Code feature: two in-process MCP servers
(`ccd_session`, `ccd_session_mgmt`) let Claude start a session, propose one as a card the user starts,
hand a task off to a new session, list, read, message and stop sessions, and read a session's context use.
Children nest under their parent and report each turn's outcome back to it (in Desktop). Suggestions are driven by
system-prompt text, not by a host threshold. Claude Code itself contributes only a routing of its built-in
`SendMessage` to a host server of that name, on desktop-class entrypoints.

ClaudeUI runs four engines and two client kinds (desktop and browser, desktop width and mobile). It has
`dispatch_agent` (ADR-033) for non-interactive delegation, hosted tools on all four engines through four
transports, context-window usage per engine in core, and no link between sessions. Every host-injected prompt
today lands as a user-role turn that ClaudeUI's auto-mode judge and Claude Code's own classifier read as the
user's words.

## Decision

### 1. One engine-neutral tool family, distinct from dispatch and from SendMessage

A hosted tool family on every engine — `session_list`, `session_get`, `session_read`, `session_message`,
`session_start`, `session_dismiss_proposal`, `session_hand_off`, `session_usage`, `session_stop` — with one
description and guidance source. On Claude it is its own in-process server (`claude-ui-sessions`), outside
the auto-allowed `claude-ui` prefix; on opencode it joins the hosted `claudeui` server; on pi the bridge
registers it; on Codex it is a `dynamicTools` set on `thread/start` (a thread keeps the tool set it started
with, so Codex threads started before these tools existed do not gain them on resume or fork). Only the root
agent of an interactive session gets them: opencode subagent children, pi's host-run subagents and Codex
non-root threads are refused (opencode's are not even offered them), and a call that cannot be attributed is
refused. Requests that would ask go to the user, never to the auto-mode judge. The names never resemble Claude Code's `SendMessage` or pi's `send_message`, and the descriptions point
each at the other. ClaudeUI does not host or override Claude Code's `SendMessage` routing.

`dispatch_agent` keeps its meaning: a non-interactive background agent owned by the calling session.
`session_start` creates a session exactly as the user would: interactive at once, in every client's sidebar.

### 2. Fresh briefs only

A new session never receives a copy of the starting session's conversation; it starts from a brief (task and at
least 80 characters of background) or, for a hand-off, from a handoff written by the session handing off. The purpose is to leave
an overgrown context behind, and agent reliability degrades well before a context window is full.

### 3. Hand-off as content, file written by ClaudeUI

`session_hand_off` takes the handoff text as an argument. ClaudeUI saves it under its own data directory
(`~/.claude/ui/handoffs/`) and inlines it into the new session's first prompt. Agents get a tool, never a path the
host will read: no agent-chosen read path, no engine grant or sandbox exception, and no file in the user's
repository.

### 4. Groups of sequential work, not parent and child

The session that starts or hands off to a new one stays alive and carries on; the new session works on its
own and asks the user for anything it needs. Nothing flows back: no turn reports, no waking. (Reports and
waking belong to a separate assistant-session feature; the code for them is kept but not wired.)

The origin is recorded as a link (`started` | `handoff`, with a lifecycle `starting → live → ended | failed`)
and drives a logical grouping of sequential work. A link is grouped or standalone: a hand-off is
grouped by default, a started session is standalone unless the agent marks it the same work, and the user can
change either from the row menu ("Detach from group", "Add to group"); a proposal card offers "Start as
standalone work" next to starting it in the group. Groups are flat: the topmost grouped session is the group's
head, and every grouped session sits one level under it in start order, with a "continued from" or "started
from" hint, so a long chain of hand-offs stays one tidy group. The originating session's transcript keeps a
card for each session it started; hand-offs keep their "continued in → / continued from ←" markers.
Sessions are addressed by short refs that survive the routing-id rekey; routing ids are never shown to models.

### 5. Origin of every injected turn

Every prompt the host delivers carries an origin: `user`, `host-instruction` (the user's own setting or
click), `session-message`, `agent-note`. Session messages and agent notes become `role:'system'` note rows in
the replicated state (never user rows), so ClaudeUI's judge never reads them as consent. On Claude they use
Claude Code's own cross-session form — the `<cross-session-message>` content envelope plus a `peer` origin —
which Claude Code frames for the model as another session's message and its classifier treats as non-user;
ClaudeUI's gate is the approval surface, so the frame asserts the receiving session's mode class. A per-session taint
(`userOriginClean`) records whether anything not from the user reached the current turn.

### 6. Safety

- A session starts or hands off only on a clean user turn; otherwise the call becomes a proposal card. An
  agent-started session cannot start sessions until its user types into it (a hand-off requested by the
  user's context-pressure setting is exempt). At most 10 starts per user turn.
- A started session's permission mode is capped at the starting session's; a working directory outside the
  starting session's tree turns the start into a proposal.
- Reads are automatic within the group (or between a session and the one that directly started it) and the
  project; reading other projects needs approval. Messages and stops are automatic within the group (or that
  direct pair) when the target's permission-mode class is not above
  the sender's; otherwise they need approval. Because the scope is the whole flat group, the last session of a
  hand-off chain reaches the first without asking, and the user's "Add to group" is also a grant: it puts the
  session in every member's automatic scope. A group can span projects only through the user (a click on an
  out-of-folder proposal, or "Add to group"), and its members then read each other across those projects.
- Turns started by other sessions are bounded (10 since the last user prompt); past that, and for idle,
  closed or out-of-budget targets, items wait in a persistent per-session inbox and are delivered at the
  target's next turn. Messages never resume a closed session.
- Only a session's root agent can act; subagents, dispatch targets, automations and side questions cannot.
- Every acting call is written to the audit log with the calling session as the actor.
- Where the rules are enforced: the deny rules (root agent only, plan mode, the start gate, the caps) are
  re-checked by the tool service itself, so they hold in every permission mode. The rules that only ask
  first (reads outside the group and project, messages and stops outside the group or into a higher mode
  class) go through the engine's approval step, so a session in `bypassPermissions` skips them, as it skips
  every other prompt; these tools offer no "always allow" rule that would remove them silently.
- The caller is identified from the engine's own record of the tool call: on Claude, the frame that
  carries the tool use (subagent frames carry a parent tool-use id or an agent id); a call that cannot be
  attributed within a short wait is refused. In-process teammates write no frames in the current Claude
  Code and are refused in bypass mode for that reason.
- A session started from a proposal by the user's click is held to the same rule as an agent-started one:
  its brief was written by an agent, so it cannot start sessions until the user types into it. Proposals are
  capped per turn and per session; a proposal whose folder is outside the proposer's says so on its card,
  because the click is the only consent for it.
- Paths are stored in forward-slash form, like the web folder picker and Claude Code's POSIX cwd; the
  desktop's native picker may still produce backslash paths, so comparisons normalise separators.
- Mode classes for message parity: `plan` < `default`/`dontAsk` < `acceptEdits` < `auto` <
  `bypassPermissions`; `auto` counts as a prompting sender for Claude Code's own peer-message parity. A
  started session inherits its starter's mode as is; it can only request a mode at or below the starter's.

### 7. Context pressure is a user setting

The user picks threshold percentages and a mode: off, ask (a banner above the composer on every client) or
auto. At the first turn end past a threshold, ask shows the banner; auto, or the user's click, sends the
session a host instruction to finish the current step and call `session_hand_off`. A threshold fires once,
re-arms when usage falls below it, does not fire again after a hand-off until the user's next prompt, and
falls back to the banner when an automatic hand-off does not happen. Engines that report no window size do not
arm.

A crossing counts once: after a hand-off the old session stays above the threshold (it is kept alive), so it
fires again only after its usage has dropped below the threshold and crossed it again (compaction, a clear);
the user's next prompt there only ends the "handed off" state. Whether the hand-off happened is judged at the
end of the turn that read the instruction; a turn the user stopped is not counted as a refusal. In plan mode
the session can only be asked, never instructed. The instruction's "don't start new work here" is guidance,
not a gate: that turn is the user's standing instruction, so the start rules treat it as the user speaking.
Banner and watch state live in memory: after a restart an unanswered banner is gone and the next completed
turn above a threshold fires again.

### 8. Remote parity

All of it is renderer UI and replicated state: cards, nesting, banner and settings work in the desktop app
and the browser clients (desktop width and mobile), with client commands registered on both transports.

### 9. Native Claude cross-session messages

ClaudeUI's Claude sessions already register for Claude Code's native cross-session messaging, so another
Claude Code process on the machine can message them. Claude Code writes no user frame for such a message to
a host that does not replay user messages; ClaudeUI reads it from the transcript and shows it as a note.
Claude Code holds a peer message whose sender's permission class differs from the receiver's, with no
expiry and no host-side approval request; ClaudeUI shows the hold, and its one action, "Allow messages from
other Claude sessions here", sets Claude Code's own cross-session setting to accept for that process. Messages
ClaudeUI itself delivers assert the receiving session's class, because ClaudeUI's own gate has already
decided them.

## Consequences

- One tool surface serves the assistant use case, context-pressure hand-offs and the session orchestrator
  (ADR-102), which can call these tools instead of defining its own.
- The turn-origin field is a new shared seam across four engines, the reducer and the judge; it also closes
  the existing gap where host-injected prompts read as the user's words.
- A started session's first prompt is origin `user`: its judge treats the starter's brief as user intent.
  This is accepted because a start only follows a clean user turn and the started session's mode is capped;
  letting its judge also see the starter's consenting turn is backlog.
- Codex threads started before this change do not get the tools.
- The model-facing guidance contradicts Claude Code's own "no need to wrap up early or hand off" line when the
  user's setting asks for a hand-off; the guidance says the user's instruction wins.

## Alternatives considered

- **Build on ADR-102's `SessionControl`.** Rejected: the orchestrator solves a different problem and will
  consume these tools.
- **Host Claude Code's `ccd_session_mgmt` to capture native `SendMessage`.** Rejected: an undocumented
  internal contract, and `SendMessage` is heavily used for subagents and teammates; a distinct tool avoids
  confusion.
- **Copy the conversation into the new session (fork).** Rejected: it defeats the purpose of leaving a heavy
  context.
- **Agent-written handoff file in the repository.** Rejected: an agent-chosen path the host reads is an
  injection surface, and the file pollutes every repository's working tree.
- **A host threshold that starts sessions with no user setting.** Rejected: context pressure acts only through
  the user's own setting; otherwise the model proposes.
