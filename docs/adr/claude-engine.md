# Claude engine and the cli.js harness

Governs: `src/core/sdk/`, `src/core/services/claude-session.ts`, `src/core/services/claude-item-stream.ts`, `src/core/services/claude-permission-decision.ts`, `src/core/services/claude-model-catalog.ts`, `src/core/services/claude-model-alias-migration.ts`, `src/core/services/fork-anchor.ts`, `src/core/services/session-history.ts`, `src/core/services/dispatch-claude-targets.ts`, `src/shared/model-capabilities.ts`, `patch/`, `scripts/rebundle-cli.mjs`, `src/renderer/src/hooks/useFileMention.ts`

How ClaudeUI runs Claude Code: a patched `cli.js` rebundled into Anthropic's Bun binary, driven over stream-json by
the in-house harness in `src/core/sdk/`, with the Claude adapter in `src/core/services/claude-*.ts`. The wire
manual `docs/protocol-cc/` is authoritative for shapes, flags and the build pipeline. Claude sign-in and credentials
are ADR-014, ADR-015 and ADR-080 (auth-and-accounts.md). cli.js-consumed settings (ADR-009) and worktree-relocated
transcripts (ADR-077) are in persistence-and-settings.md. Harness sources, downloads and the version selection
(ADR-082) are in harness-installs.md. Rule ladders for Auto mode are in permissions.md; the judge ClaudeUI runs for
opencode and pi is auto-mode-judge.md. Agent and run identity (ADR-073) is agents-and-tasks.md. Model catalogs
(ADR-092) and the no-silent-fallback rule (ADR-059) are providers-and-models.md.

## Claude Code runs as a rebundled Bun binary, not under Node (ADR-006)

The patched `cli.js` is re-injected into Anthropic's Bun standalone binary (`scripts/rebundle-cli.mjs`) and the
result, `vendor/claude-cli/bun-claude[.exe]`, is spawned natively. The extract, patch (`patch/apply-all.mjs`),
rebundle and boot-probe pipeline is `bun run ensure-cli`, described in `docs/protocol-cc/01-transport.md` §1.12.

- There is no Electron-as-Node (`ELECTRON_RUN_AS_NODE`), no `Module._resolveFilename` shim, no `NODE_PATH`
  injection and no separately vendored ripgrep or native addons: whatever Anthropic embeds stays embedded.
  `QueryOptions.standaloneExecutable` defaults to `true`, so no `cli.js` path is put in argv.
- Reason: running `cli.js` under Node meant remapping the CI-runner absolute `file:///` URLs Anthropic bakes in
  (per OS, changing per runner), which broke on every layout change. Bun resolves its own module graph.
- Shipping Anthropic's signed binary verbatim is not the default because the patches (below) must be in the
  embedded `cli.js`.
- Accepted costs: the rebundled binary drops the embedded JSC bytecode (Bun recompiles at first run, about 160 ms of
  cold start) and is unsigned after the edit (macOS gets an ad-hoc `codesign` from the rebundler). The extracted
  `vendor/claude-cli/cli.js` is the Bun CJS IIFE form, readable and patchable but not runnable by `node`.
- Another binary can be spawned instead: `CLAUDEUI_CLAUDE_CLI=<path>` (see the next section and ADR-082).

## The app knows which patches the binary carries, and chat works without any (ADR-079)

Chat must work on any Claude Code binary, including Anthropic's unpatched one. A surface that needs a patch lights
up only when the binary carries it.

- `patch/apply-all.mjs` records the patches a build carries in `vendor/claude-cli/version.json` (`patches`), read
  from the `/*PATCHED:…*/` markers in the patched bytes, never from intent: a patch whose fix is upstream and applied
  nothing is not listed. The registry is `patch/lib/patch-registry.mjs`; a guard test requires the patch
  directories, the registry and every marker an apply script writes to agree.
- `src/core/sdk/harness.ts` is the one reader (`readHarnessInfo`, `harnessHasPatch`, `getCliVersion`). A missing or
  malformed `version.json`, or a missing field, reads as version `unknown` with no patches: when in doubt the
  harness is unpatched, and a patch-dependent surface goes dark rather than failing on use (ADR-030's
  capability-honesty rule). Anthropic's binary ships no `version.json` and reads exactly that way.
- The patch set is three: `subagent-streaming` (token-level streaming inside subagent cards), `bash-output-streaming`
  (live Bash output) and `voice-server` (voice input, the only route through cli.js's own voice pipeline). A patch is
  kept only when cli.js has no native surface for the same thing; everything else uses cli.js's own surfaces.
- Voice is `capabilities.voice = static AND harnessHasPatch('voice-server')` in `ClaudeSession.capabilities`. Every
  way into a capture (mic, shortcut, `voice:start-*` IPC, remote `voice:start`) reads that one value; an unpatched
  binary is refused with a message naming the missing patch. Streaming needs no gate: subagent `stream_event`s and
  `bash_output` frames arrive or they do not, and the cards fall back to complete messages and the final result.
- `--forward-subagent-text` is passed on every spawn, so a foreground subagent's text and thinking reach the app as
  complete messages on any binary.
- On an unpatched binary a user gets chat, tools, approvals, MCP, plugins, queueing and take-back, background tasks
  and the usage meter. Missing: token streaming in subagent cards, live Bash output, and voice.
- Native surfaces the app uses instead of the old patches (shapes in `docs/protocol-cc/`):
  - `background_tasks {tool_use_id}` for "Send to background". `{backgrounded:false}` is a success answer meaning
    "no registered foreground task with that id". A foreground Bash registers only after it has run about 2 s
    (`task_started`, `is_backgrounded:false`), so the card offers the button only for a registered foreground task
    and flips on cli.js's own `task_updated {is_backgrounded:true}`.
  - `rate_limit_event.rate_limit_info.unifiedWindows` for rate limits. It fires at most once per turn, often not at
    all; the meter keeps its 30-minute poll.
  - One `reload_plugins` after the initialize response (fire and forget) to connect enabled plugin MCP servers.
  - Every user frame carries a client `uuid` (a queued item's `itemId`). `command_lifecycle` `started` is the
    consumption signal, `cancel_async_message` is take-back, `discarded` and `refused` return the item with a
    warning. Text correlation of queue items stays only for opencode and pi, which carry no id.
  - `get_usage` is sent with `skip_behaviors: true`.
- `subprocess-proxy-strip` is not a patch: the in-app proxy reaches cli.js's children just as a shell-set proxy does
  on the unpatched binary. Per-account credential files are host-owned (ADR-080), so no `skip-securestorage` patch.

Rejected: a patch for auto-mode ALLOW verdicts (see "A Claude card shows the judge's verdict on a block only").

## A Claude card shows the judge's verdict on a block only, and a policy denial is not a verdict (ADR-076)

Claude's Auto mode runs inside cli.js; ClaudeUI reads its decision off the wire and does not call a judge for Claude.
The one frame is `system/permission_denied` (`docs/protocol-cc/04-system-subtypes.md` §4.25), emitted for every
pre-ask denial: a classifier block, a deny rule, the permission mode, a hook, the static safety check, a
working-directory bound. `claude-permission-decision.ts` owns all the routing (`permissionDecisionBlock`);
`claude-session.ts` only narrows, logs and sends.

### §1 Two block types

- `decision_reason_type: "classifier"` becomes the same `ToolReviewBlock` that pi and opencode build
  (`reviewer: 'auto-mode'`, the rule name in `rule`, no risk level), so one chip and strip serve every engine.
- Every other source becomes a `permission_denial` block with a deliberately different icon (a barred circle, not
  the judge's shield). Rendering a deny-rule lookup in the reviewer's vocabulary would claim a judge deliberated
  when none did.
- The denial block carries no `message`: cli.js's rejection text is already the `tool_result` body. A
  `subcommandResults` denial shares the `rule` wording rather than claiming "part of this command", because cli.js
  reports it for every Bash decision, one subcommand or ten. An unrecognised `decision_reason_type` degrades to
  `other`; the union is ClaudeUI's, the wire field is cli.js's.

### §2 There is no allow verdict

The `automode-verdict` patch is deleted and no `permission_allowed` frame exists. cli.js emits nothing when the
classifier allows, so a Claude card shows a verdict on a BLOCK only. This is decided, not a gap. An "approve anyway"
override for a blocked Claude call was not built (cli.js has no host surface for it): the Approve button sends the
user's authorising message (ADR-091 part 6, auto-mode-judge.md).

### §3 Identity is the frame's own uuid

`reviewId` and `denialId` are the frame's `uuid`, so replayed catch-up is idempotent. cli.js decides each call once
and never revises it, so a denial block is first-one-wins (a design that re-reviews a call would be last-one-wins). A frame
without `tool_use_id` or `uuid` is not bound to anything: a block with nowhere to render is never invented.

### §4 The rule name is parsed out of the reason, under a bound

The classifier's reason arrives as `[Exact Rule Name] one short sentence`. The prefix is split into the badge only
if it is at most 48 characters of `[A-Za-z0-9 _/-]` (`/` because rule names such as `Logging/Audit Tampering`
exist). The reason is model text reachable by attacker-influenced transcript content, so an unbounded prefix would
be a free-form badge. A reason without a bracket is all rationale. Content-free fallbacks (`Blocked by classifier`,
`No reason provided`) are dropped as rationale by exact match.

### §5 Live only

Both frames are outside cli.js's persisted-message predicate, so a reopened session shows no verdicts. That is
parity, not a gap: no engine reconstructs a `tool_review` on reload.

### §6 Subagent decisions bind

A frame with `agent_id` is not dropped. `attachToToolUse` (shared by `session:tool-review` and
`session:permission-denial`) searches the top-level transcript first, then every `subagentMessages` bucket; tool-use
ids are unique across a session, so no owner hint is needed. This applies to every engine.

### §7 A classifier block with no verdict is a denial

cli.js also tags its no-verdict fallbacks `classifier` and blocks anyway. Three are recognisable on the wire and
become a `permission_denial` with the derived source `autoModeNoVerdict` ("Blocked · no verdict"): the reason
`Classifier unavailable`, the reason `Auto mode unavailable — stopped after repeated responses with no safety
verdict`, and `decision_reason_code: "classifier_transcript_too_long"`. `autoModeNoVerdict` is ClaudeUI's: it is
never accepted from `decision_reason_type`. The other no-verdict fallbacks (a safeguard refusal, an empty
classifier-only action) have free-form reasons and render as a denied review with cli.js's text. This mirrors
opencode and pi, which hand an unavailable judge to the user rather than showing a verdict.

Consequences that look like bugs but are decided:

- ClaudeUI passes `settingSources: ['user','project','local']`, so a developer's broad allow rules pre-empt the
  classifier entirely (the decision comes back as `subcommandResults` and the judge never runs). On such a machine
  Claude verdict rows are sparse. The classifier trigger also drifts between cli.js versions; confirm with
  `--debug-to-stderr` (`[auto-mode] new action being classified`) before reporting "no verdict frames".
- There are two `permission_denied` emitters in cli.js and only the control-channel one reaches stdout; see
  `docs/protocol-cc/04-system-subtypes.md` §4.25 and `14-auto-mode-classifier.md`.

## Every Claude stream frame has one owner, and a call that never ran is taken back (ADR-078)

An item-lane `tool_use` is shown when its `content_block_start` arrives and only a completed per-block `assistant`
snapshot fills its input. When that snapshot never reaches the owner that opened the scaffold, the card spins
forever with `{}` input. Two rules prevent it.

### §1 The owner comes from the wire; a sub-agent frame never falls back to the main transcript

- The `subagent-streaming` patch stamps `agent_id` (the background runner's `taskId`, equal to
  `task_started.task_id`) on every stream event it writes, next to `parent_tool_use_id`. If the patch is already in
  the file without `agent_id`, the apply step fails instead of skipping.
- Owner resolution, in order: `parent_tool_use_id` through `resolveTaskOwner`; else `agent_id` through the agent id
  to origin Agent call maps (`originByTaskId`, then `taskIdMap`), the same owner the relay's snapshots resolve to,
  so a partial and its snapshot meet in one item-lane state; else a frame carrying an `agent_id` nothing can place is
  dropped, never routed to the main transcript (a lost partial costs some live typing, a leaked one a spinner nothing
  clears; look for `dropping stream events of unknown agent` in the debug log); a frame with neither field belongs
  to the main agent.
- The rule applies wherever a Claude item lane is fed, including the cross-engine dispatcher's Claude-target lane
  (`dispatch-claude-targets.ts`), which learns agent id to origin from that target's own `task_started` frames and
  aliases a SendMessage-resumed run onto its origin.
- After a restart the transcript seed of ADR-073 §5 fills `originByTaskId` before the first frame is handled. An
  agent the seed does not know (a nested agent whose spawn lives in a subagent transcript) gets its origin once,
  from its `.meta.json` sidecar (`readAgentSidecar`); fresh sessions never read the disk. A run placed this way
  reports `runIndex` 2 even if the agent had earlier resumes: nothing records those.

### §2 Only the main agent's frames start a main turn

A frame with `parent_tool_use_id` or `agent_id` belongs to a sub-agent and must not flip the session to
processing, start the turn clock or push the status line. A background agent working while the main agent is idle is
roster state (ADR-073), not a main turn. Consequence: a session whose only activity is a background agent reads idle
everywhere the main-turn flag is read, the sidebar spinner included; a spinner for that belongs on the roster
(`activeTasks`).

### §3 A streamed call no snapshot confirmed, in a message that did not stop for `tool_use`, is retracted

- `ClaudeItemStreamLifecycle` records `message_delta.stop_reason` and every `tool_use` id any snapshot of the
  message carried (including one that fell through to the ordinary upsert).
- When the message finishes with any stop reason other than `"tool_use"` (including none, for an interrupt or
  abort), each unconfirmed `tool_use` is removed. It is reported before the final seal on the replicated channel
  `session:tool-uses-retracted { messageId, toolUseIds, ownerToolUseId? }`.
- The reducer removes the call and every block keyed to it (`tool_result`, `tool_review`, `permission_denial`) from
  the main transcript or the owner's sub-agent bucket, drops a message left empty, retires any item stream at or
  after the first removed slot, and treats a replay as a no-op that keeps object identity. `ClaudeSession` trims its
  kept history the same way. The retraction is block-level, unlike `session:messages-retracted`.
- A message that stopped for `"tool_use"` never retracts anything: every call in it runs, and a sub-agent snapshot can
  arrive after `message_stop` because the patch's stream events and the relay's snapshots take different paths.
- Accepted: a sub-agent call can be retracted if an interrupt or terminal `sealOwner(owner, true)` lands between its
  `content_block_start` and `message_delta` while its snapshot is in flight; the late snapshot restores it, and a
  result that arrived inside that window finds nothing to attach to. Reload from JSONL needs no change: cli.js never
  persists a truncated call.

Rejected: stamping the origin id in the patch (async sidecar I/O in the runner's hot loop); routing parentless,
idless frames by "the main agent is idle" (it guesses, and a queued prompt looks the same); stopping the reducer
merges from preserving an absent `tool_use` (that preservation keeps separately attached blocks alive across
upserts, ADR-055); retracting at seal time whatever the stop reason, or only on `max_tokens` (the snapshot-lag race,
and an interrupt leaves the same phantom).

## Fork a session with cli.js's own flags, anchored on a balanced line (ADR-010)

"Branch off" a message is `--resume <source> --resume-session-at <anchor> --fork-session`. cli.js owns the
truncation, the new session id and the snapshot and file-history binding; ClaudeUI never copies or splices JSONL
transcripts. Rejected: splicing the JSONL itself (re-implements what cli.js does and drifts), passing the renderer's
`ChatMessage.id` (the `msg_xxx` id for assistant messages, which the flag does not match), threading line uuids onto
every `ChatMessage` (hot parse path, and live ids are not disk uuids), and restricting the button to user messages.

- `--resume-session-at` matches the JSONL line `uuid`, not the API message id. The anchor is resolved from the
  on-disk transcript in the main process (`findForkAnchorUuid` in `fork-anchor.ts`, wrapped by `resolveForkAnchor`
  in `session-history.ts`; IPC `session:resolve-fork-anchor`), so it works for live and historical sessions and
  offers only flushed lines. `--resume <sid>` must accompany it.
- The anchor is tool-cycle balanced: if the target assistant line issued tools, the anchor is the last immediate
  `tool_result` user line before the next assistant turn, so a branch never starts with a dangling `tool_use` (a
  400 on its first prompt). A prefix ending on a `tool_result` line is fine; cli.js handles two consecutive user
  turns.
- The anchor also extends past agent completions cli.js delivered right after the chosen turn (a
  `<task-notification>` user line, or a `queued_command` attachment carrying one), passing over bookkeeping and
  `isMeta` lines and stopping at the next assistant line, real prompt, tool_result or steer. Otherwise cli.js's
  resume scan finds the agent launched but never delivered and reaps it as failed on the fork's first send.
- Fork flags go on the first run only (`!this.sessionId`); after `system/init` mints the new id the session resumes
  that id in place, with no re-fork and no re-truncate. Resume precedence is `sessionId ?? resumeSessionId`.
- A fork materializes lazily: the first send spawns with the three flags (`forkOrigin` in `PerSessionState`), so an
  unused branch leaves no session on disk. The Branch button shows on assistant bubbles only, gated on
  `capabilities.forkFromMessage`.
- A Claude fork is seeded from the disk loader (`loadSessionHistory(source, projectKey, anchorUuid)`), not from the
  renderer's in-memory slice: messages, task notifications and status line truncated at the anchor the way cli.js
  truncates, so an agent whose completion came after the anchor reads `unfinished`, never "running" forever. If the
  loader cannot be used, and for the other engines, the in-memory slice stays with the source's notifications for
  agents spawned inside the slice.
- "Allow for this session" permission grants are not inherited by a fork (same as the CLI). The coupling to cli.js
  internals (line-uuid match, `--fork-session` skipping the rebind) is re-verified on a `claudeCliVersion` bump. pi
  and the other engines implement the same capability by their own means (`ISession.forkFromMessage`).

## Claude models are picked by alias only, and ClaudeUI follows the model cli.js resolves (ADR-100)

cli.js resolves `opus`, `sonnet`, `haiku` and `fable` against a model catalog the server serves per account, so
which model an alias runs can change overnight with no release. ClaudeUI's mirror of the baked catalog cannot
predict it.

1. **Aliases only.** Every Claude model list offers `default`, the family aliases and their `[1m]` variants, plus any
   non-`claude-` value cli.js offers (a gateway's custom model option). Concrete ids (values starting with
   `claude-`, `isConcreteClaudeModel`) are dropped once, in `queryClaudeModels`, so the composer, settings,
   automations, remote and the headless server see the same list. Each alias row shows the model it resolves to
   today as cli.js reports it.
2. **Saved concrete picks move to their alias** (`migrateSavedClaudeModels`, run on every non-empty catalog fetch,
   idempotent): the default model, dispatch default and allowlist, the last pick, every automation's model, and
   starting-effort keys (`claudeAliasForModel`, `claudeLegacyEffortKey`). A concrete pick maps to the family alias
   that currently resolves to it, never to `default` (which means "follow the recommendation", a different
   intent). An id no alias reaches is left unchanged and surfaces through the stale-model path (ADR-059). Existing
   sessions' stored models and transcripts are not rewritten.
3. **The session follows cli.js.** Once `system/init` reports the resolved model, a session on `default` or any
   family alias takes its context window, capabilities and price from that model, not from ClaudeUI's alias table
   (`effectiveModel`, `resolvedModelId`). The built-in mirrors (`model-capabilities.ts`, `pricing.ts`) remain as
   fallbacks for the moments before cli.js answers and must be re-checked on each cli.js bump.
4. **ClaudeUI's own one-shot calls use aliases** too: the commit-message generator asks for `haiku`, not a pinned id.

Consequences: an alias moving needs no ClaudeUI release, and its starting effort moves with it (ADR-074 §8,
providers-and-models.md). A user can no longer pin an older Anthropic model from the picker; pinning stays available
through Claude › Endpoint's model mapping (the `pin` override) and `ANTHROPIC_DEFAULT_*_MODEL`-style overrides, which
apply before alias resolution. A session's first moments, and a third-party provider whose alias targets differ, can
briefly show the mirror's answer. Rejected: keeping every row and fixing the mirrors (chasing a server-side
decision), and leaving saved concrete picks stale.

## `@` file mentions reach cli.js verbatim (ADR-001)

cli.js extracts `@path` mentions from the raw prompt text on every turn, reads each file through its own Read tool
(with permission checks) and injects synthetic `tool_use`/`tool_result` pairs; the `@` text in the user message is
the anchor that makes them coherent. So the composer sends `@` references as typed.

- Never strip or transform `@path` references before `sendPrompt`, and never read mentioned files client-side.
- File-picker UI inserts the exact format cli.js parses: `@relative/path` or `@"path with spaces"` (optionally a
  `#L<n>-<m>` suffix). The inserting code is `src/renderer/src/hooks/useFileMention.ts`.
- This is not the same as CLAUDE.md `@` includes, which cli.js inlines at startup and consumes.
