# ADR-077 — Claude Code harness: capability gating on the patches a binary carries, and the reduced patch set

**Status:** Accepted (2026-09-25). Owner ruling: chat must work on any Claude Code harness;
streaming (subagent token deltas, live Bash output) and voice light up only when the harness
carries the patch; voice is disabled on an unpatched harness.
**Relates to:** [ADR-006](adr-006_rebundle-bun-binary.md) (the rebundled `bun-claude`),
[ADR-030](adr-030_capability-honesty.md) (a capability is true only when the full path works),
[ADR-037](adr-037_engine-fork-patch-policy.md) (patch policy and per-bump verification),
[ADR-040](adr-040_engine-neutral-task-lifecycle-events.md) / [ADR-073](adr-073_agent-roster-and-task-run-identity.md)
(task lifecycle — both amended below), [ADR-053](adr-053_queue-item-identity-cc-parity.md) (queue
identity — amended below), [ADR-015](adr-015_multi-account-file-credentials.md) (why
`skip-securestorage` stays).

## Context

ClaudeUI ran Claude Code only as `bun-claude`: Anthropic's binary with fourteen content-regex
patches re-injected (ADR-006). Every Claude Code bump re-anchored the patches, and every release
re-shipped the binary. The owner wants the harnesses split out of the installer so a harness can
be bumped on its own, with Anthropic's official, unpatched binary as one of the things the app
can run — which means the app has to work without any patch.

A live A/B on 2026-09-24 (Claude Code 2.1.280, Windows, Haiku 4.5; official binary against our
patched build, same wire probes on both; the real app driven on the official binary) established
what each patch was still worth:

| Patch                                                                        | Finding                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usage-relay`                                                                | Dead code: upstream's routed control-handler table answers `get_usage` before the injected branch on BOTH builds.                                                                                                                                                                             |
| `request-usage`                                                              | Fed a log nothing read; `stream_event` `message_start`/`message_delta` carry the same usage, matched field for field.                                                                                                                                                                         |
| `mcp-tool-refresh`, `taskstop-notification`, `incomplete-session-resume-fix` | Upstream; the apply scripts had been no-ops.                                                                                                                                                                                                                                                  |
| `background-task`                                                            | Its subtype is rejected by the official binary (button silently dead) AND the patch was broken on 2.1.280: after backgrounding, cli.js never saw the command finish. Native `background_tasks` works for Bash and Agent and reports completion.                                               |
| `rate-limit-relay`                                                           | The app read only the patch's field and dropped every native `rate_limit_event`; the native event carries every window under `rate_limit_info.unifiedWindows`, same values.                                                                                                                   |
| `mcp-status`                                                                 | Settings-enabled plugin MCP servers never load in a headless session (12 s+, cold and warm); the patch loaded them as a side effect of `mcp_status`, which the app sends only when the MCP dialog opens. Native `reload_plugins` connects them in ~2 s.                                       |
| `queue-control`                                                              | Recall silently failed and cards mis-stated consumption on the official binary. Native `command_lifecycle` frames and `cancel_async_message`, keyed by a client-supplied message uuid, cover both paths; a cancelled message provably never reaches the model.                                |
| `subagent-streaming`                                                         | No upstream token-level subagent streaming (every `stream_event` hardcodes `parent_tool_use_id: null`); `--forward-subagent-text` gives complete messages only.                                                                                                                               |
| `bash-output-streaming`                                                      | No upstream live Bash output; the output file grows on disk but is deleted at completion and only matched to its call after ~2–5 s.                                                                                                                                                           |
| `voice-server`                                                               | No upstream equivalent; the control request is rejected.                                                                                                                                                                                                                                      |
| `subprocess-proxy-strip`                                                     | Without it the in-app proxy — credentials included — reaches every Bash/MCP/LSP child (`env` puts them in the transcript). `CLAUDE_ENV_FILE` covers Bash only. The patch also had a regression of its own: it stripped an INHERITED env proxy from children whenever no in-app proxy was set. |
| `skip-securestorage`                                                         | Windows: no effect while `tengu_windows_credman` is off. macOS 2.1.280 (source): the Keychain is primary and the first successful write deletes the per-account `.credentials.json` the app reads; multi-account breaks. Linux: none.                                                         |

Raw wire logs and the real-app screenshots are in the 2026-09-24 session's scratchpad; the
decisive lines are cited in `docs/protocol-cc/` where each surface is documented.

## Decision

### 1. The app knows what the binary it spawns carries

`patch/apply-all.mjs` records the patches a build carries in `vendor/claude-cli/version.json`
(`patches`), computed from the `/*PATCHED:…*/` markers found in the patched `cli.js` bytes after
every patch ran — never from intent, so a patch whose fix is upstream and applied nothing is not
listed. The registry lives in `patch/lib/patch-registry.mjs` (`{name, apply, marker}`), and a
vitest guard requires the patch directories on disk, the registry and every marker an apply
script writes to agree.

`src/core/sdk/harness.ts` is the one reader: `readHarnessInfo(binaryPath)`,
`harnessHasPatch(name)`, `getCliVersion()`. A missing or malformed `version.json`, or a missing
field, reads as version `unknown` with no patches — **when in doubt the harness is unpatched**, so
a surface that needs a patch goes dark rather than failing on use (ADR-030). Anthropic's binary
ships no `version.json` and reads exactly that way.

`CLAUDEUI_CLAUDE_CLI=<path>` makes `locateBunClaude()` spawn that binary instead of the bundled
one. It is how the app is verified against the official binary today and the seam the harness
split will use; the user-facing chooser and download channel are a later ADR.

### 2. Patch-dependent surfaces are capability-gated, streaming degrades on its own

- **Voice** is `capabilities.voice = static AND harnessHasPatch('voice-server')` in
  `ClaudeSession.capabilities` — ADR-030's runtime-AND pattern, the same shape as
  `crossEngineDispatch`. Every way into a capture reads that one value: the mic and its Tab
  shortcut, the `voice:start-*` IPC verbs and the remote `voice:start` verb. A Claude session on an
  unpatched binary is refused with a message naming the missing patch.
- **Streaming needs no gate.** Subagent `stream_event`s and `bash_output` frames either arrive or
  they do not; the cards render what arrives and fall back to complete messages / the final
  result. `--forward-subagent-text` is passed on every spawn so a foreground subagent's text and
  thinking reach the app as complete messages on any binary (on the patched binary the patch had
  already removed the same filter, so nothing arrives twice).

### 3. Four patches are replaced by cli.js's own surfaces

- `background-task` → `background_tasks {tool_use_id}`. Its `{backgrounded:false}` is a success
  answer meaning "no registered foreground task with that id" — a foreground Bash registers only
  once it has run for 2 s (`task_started`, `is_backgrounded:false`). `is_backgrounded` rides
  `session:task-started` into `activeTasks`; the cards offer "Send to background" only for a
  registered foreground task (the old gate showed the button before registration, when it could
  not work, and hid it once it could); the flip follows cli.js's own
  `task_updated {is_backgrounded:true}`, re-armed as the same run.
- `rate-limit-relay` → `rate_limit_event.rate_limit_info.unifiedWindows` (fraction + epoch
  seconds; fires when a window's rounded percentage or reset time moves).
- `mcp-status` → one `reload_plugins` after the initialize response, fire-and-forget, before the
  first turn has a prompt cache to invalidate. For a local spawn the handler reaches the network
  only for an enabled plugin missing from its cache.
- `queue-control` → every user frame carries a client `uuid` (a queued item's `itemId`);
  `command_lifecycle` `started` is the consumption signal (positions the steer bubble at the true
  injection point), `cancel_async_message` is the take-back, `discarded`/`refused` return the item
  with a warning. ADR-053 §3's claude bullet — "correlate per item by text" — is retired for the
  claude engine; text correlation stays for opencode/pi, which carry no id.

### 4. Five patches are deleted

`usage-relay`, `request-usage`, `mcp-tool-refresh`, `taskstop-notification`,
`incomplete-session-resume-fix`, for the reasons in the table. `get_usage` now sends
`skip_behaviors: true` (the transcript scan it skips only filled a section nothing reads).

### 5. Five patches stay, each for a reason the owner ratified

| Patch                    | Why it stays                                                                                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subagent-streaming`     | Token-level streaming inside subagent cards; upstream has none.                                                                                                                                                                                  |
| `bash-output-streaming`  | Live Bash output; upstream has none on the wire, and a file tail is fragile.                                                                                                                                                                     |
| `voice-server`           | Voice input; the only terms-of-service-safe route is through cli.js's own voice pipeline.                                                                                                                                                        |
| `subprocess-proxy-strip` | Keeps a credential-bearing in-app proxy out of child processes. Its inherited-proxy regression is fixed: with no in-app proxy the marker is set and children keep the user's own proxy, as the unpatched binary does.                            |
| `skip-securestorage`     | Per-account plaintext credential files (ADR-015) on macOS, where the Keychain is otherwise primary and deletes the file on first write. A host-owned token path exists upstream (`oauth_token_refresh`) and is a spike, not a decision, for now. |

### 6. What a user on an unpatched harness gets

Chat, tools, approvals, MCP, plugins, queueing and take-back, background tasks, the usage meter —
all working through native surfaces. Foreground subagents show complete messages instead of a
token stream; Bash output appears when the command finishes; the mic is hidden and voice verbs
refuse with a message naming the missing patch.

## Consequences

- Patch maintenance drops from fourteen READMEs and apply scripts to five; the guard test and
  `version.json` make "which build is this" a fact the app reads rather than an assumption.
- A Claude Code bump that touches only patches can, once the split lands, ship as a harness
  release with no UI change; the UI already tolerates a harness missing any patch.
- Two upstream behaviours the UI now designs around: a foreground Bash cannot be backgrounded
  during its first 2 s (the button waits for registration), and `rate_limit_event` fires at most
  once per turn, often not at all (the meter still has its 30-minute poll).
- **ADR-040** ("Send to background is suppressed for tasks with an `activeTasks` record") is
  superseded by §3: the button now requires a record with `isBackgrounded === false`.
- **ADR-073** ("a non-terminal `task_updated` does not re-arm `activeTasks`") is amended: a
  `task_updated` carrying `is_backgrounded: true` re-arms the same run as backgrounded, and only
  while the task is live.
- **ADR-053** §3 claude bullet amended as in §3 above.
- `docs/protocol-cc/` documents each native surface with its 2.1.280 anchors; the patch registry
  section lists the current five.
- Follow-ups, not decided here: the harness download/chooser channel (official vs patched);
  reading the version of an override binary (`getCliVersion()` is `unknown` for one); the
  host-owned token path for macOS multi-account; a credential-free bridge for HTTP proxies.
