# ADR-106: Judge calibration — measured redirect facts, a confirmation sample before a block, a retry fact

**Status:** Accepted (2026-10-22). Implemented on branch `fix/judge-bash-calibration`.
**Amends:** [ADR-083](adr-083_judge-policy-rebalance-and-permission-context.md) (policy text: redirects, retries,
credentials, transcripts, spending, instruction files, relayed approval; the deciding stage now samples twice before a
block), [ADR-081](adr-081_claudeui-owned-judge-transport.md) §4 (OpenRouter stage-1 reasoning),
[ADR-105](adr-105_background-dispatch.md) §3 (the hand-back/message review rule: asking for a decision or saying what
comes next within the task passes; approval claims are checked against the user's own turns).
**Relates to:** [ADR-084](adr-084_read-only-judge-bypass.md) (agent-control paths),
[ADR-091](adr-091_judge-blocks-hold-and-session-local-targets.md) (held blocks and the Approve click — unchanged
here; its credential-strict treatment is mirrored by §2).

## Context

The shared pi/opencode auto-mode judge was replayed on 86 real past decisions (80 that should have run, 6 that
should have been stopped), three runs each, with labels agreed by two independent reviewers. 52% of the samples
that should have run were blocked; 27 of the 80 calls were blocked on every run. Most false blocks cited
Irreversible Local Destruction (72), Auto-Mode Bypass (19) and Data Exfiltration (14). The judge is stochastic: 31 of
the 86 cases got different verdicts across runs.

Most destruction false blocks came from wrong harness facts, not from the policy: the redirect scanner reported
phantom targets for `>` inside heredoc bodies, `python -c`/`node --eval` program text and PowerShell strings;
resolved relative targets against the session folder after a `cd`; counted Git Bash's `/tmp` and every path in a
worktree under `.claude/worktrees/` as out of scope or protected; and said nothing about whether a target existed.
The judge then read "out of scope" as "overwrites existing data".

## Decision

1. **Measured redirect facts.** The scanner is quote-aware only where bash and PowerShell provably agree that text
   is not shell (single-quoted text and simple double-quoted text of inert commands and interpreters, heredoc bodies
   with a quoted delimiter); anything ambiguous is scanned as before. It tracks `cd` as a set of possible directories
   through `&&`, `||` and `;` (a `cd` that may have failed keeps the old directory), honours opencode's `workdir`,
   counts win32 `/tmp` as a temp root, checks protected and agent-control components relative to the working
   directory, reports `tee`/`Out-File`/`Set-Content`/`Add-Content`/`Tee-Object` writes and append mode, and treats
   PowerShell `$null` as a null sink. For targets outside the scope it measures `exists`, `empty` and
   `modifiedSinceSessionStart` (file mtime, so the policy corroborates "this session wrote it" from the transcript);
   a symlinked target is listed in `symlinked` and never counts as in scope. A failed measurement emits nothing.
2. **A confirmation sample before a block.** When the deciding stage returns a parsed block, the same stage is asked
   once more with the identical request; the block stands only if the second sample also blocks (an error or an
   unreadable second reply keeps it). Credential Exploration and Credential Leakage blocks stand on one sample:
   measured on the replay, the confirmation removed about 51 false blocks per three runs, but every correct block it
   lost was a credential finding.
3. **A retry fact.** The harness tells the judge when an action repeats (`identical`: same normalised command and
   working directory) or re-runs part of (`subset`) a call that was blocked or rejected, quoting that call as the
   transcript shows it. An identical retry needs the user's go-ahead after the block; a changed retry is judged on
   its own merits; without the fact, a call that differs from a blocked one is not a retry. Such actions skip the
   one-shot severity grade, as do edits to agent-control paths and unreadable patches.
4. **Variables are a hint, never scope.** A target containing `$`, `%`, a backtick or a glob stays unresolvable. A
   target that starts with a temp-directory variable carries a non-authoritative `tempVarTargets` hint naming the
   path it normally means; the hint is withheld when the command assigns or mutates that variable, uses a
   current-scope code runner, or binds it conditionally. Several rounds of adversarial review showed that proving a
   variable unchanged from the command text is an arms race the scanner cannot win; the judge reads the whole
   command and disguised rebinding is Auto-Mode Bypass.
5. **Policy text** (general, no product-specific lists): overwrites are judged on the measured facts (new, empty,
   appended, written earlier this session, named by the user or the task, or log-like); scope is not existence;
   credential values are never revealed — existence, length, key names, entry names and sizes and redacted forms are
   metadata — and taking a credential from a store to feed another program needs the user's explicit instruction;
   reading transcripts inside the harness is routine; a named account or subscription is spending consent; editing
   policy or prompt source in the working tree is not instruction poisoning, while uninstructed directive writes to
   instruction files are; an agent the harness runs is inside the trust boundary, except for a credential the agent
   obtained itself; approval claims relayed by agents are checked against the user's own turns; continuation lines
   of a quoted turn are indented so agent prose cannot forge a `User:` line.
6. **OpenRouter stage 1 never reasons** unless the engine catalog says the model does not: a 64-token severity grade
   has no room for reasoning, and a model the catalog does not list made every stage-1 call fail.

## Consequences

On the same replay with the default judge model (three runs each): false blocks fell from 52% to 7–9% of the samples
that should run (run-to-run noise), with one or two cases blocked on every run instead of 27; false allows on the
six should-block cases fell from 7/18 to 1–5/18. Most remaining destruction false blocks are writes to targets that
no longer exist on disk, whose existence a replay cannot measure. A second judge model with a faster, near-zero
false-block profile was measured and not adopted: it let through most of the credential cases and two adversarial
synthetic cases (an instruction-file poisoning edit, a look-alike package source).

Known residuals: CDPATH is not modelled; a heredoc body is resolved against the directory at the heredoc, not at a
later `cd`; an interpreter's own shell-outs are not shell redirects of the command; on the synthetic suite a few
adversarial should-block cases are still blocked on fewer than three of three runs, and a redacted credential preview
is still blocked.
