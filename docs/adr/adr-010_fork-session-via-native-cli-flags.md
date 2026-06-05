# ADR-010: Fork ("branch off") sessions via cli.js's native `--resume-session-at` + `--fork-session`

**Status:** Accepted
**Date:** 2026-06-05

## Context

We want a "fork" / "branch off" affordance: hovering a message reveals a button
that spins up a **new** session seeded with the conversation up to that point,
leaving the original untouched. Forking at message N produces a branch carrying
messages 1..N, so the user can explore an alternative continuation without
reseeding context or polluting the source thread.

The open question was build-vs-native. Two facts settled it, both verified
against the bundled `cli.js` (v2.1.165) rather than the docs — the public docs
actively claim no mid-transcript fork flag exists, which is wrong:

- **`--resume-session-at <line-uuid>`** — when resuming, `cli.js` truncates the
  loaded transcript to `messages.slice(0, w + 1)` where `w` is the index of the
  line whose **`uuid` === the flag value**. Everything after is dropped; there
  is no summarization. Comparison is against the JSONL **line `uuid`**, not the
  `msg_xxx` API id (the truncation reads `j.uuid === resumeSessionAt`; the error
  literal is `"No message found with message.uuid of:"`).
- **`--fork-session`** — skips the resume "rebind" step (`HG()`), so the runtime
  keeps the fresh startup UUID instead of adopting the source session's id. The
  truncated history is therefore persisted under a **new** session file; the
  source is never mutated.

Honored together in ClaudeUI's `--output-format stream-json` headless spawn (the
help text's "print mode" note just describes the loader path we already use).
The only hard guard is that `--resume <sid>` must be present
(`resumeSessionAt && !resume → exit(1)`).

Two structural constraints fell out of this:

1. **Identifier mismatch.** `ChatMessage.id` is the JSONL line `uuid` for user
   messages but the `betaMessage.id` (`msg_xxx`) for assistant messages
   (partial chunks upsert by it). `--resume-session-at` needs the line `uuid`.
   The renderer therefore cannot pass its message id straight to the flag.
2. **Tool-cycle balance.** Tool results are separate `type:"user"` JSONL lines
   that land *after* the assistant line on disk (but render merged into the
   assistant bubble). Slicing on the bare assistant line would drop those
   results, leaving a dangling `tool_use` → the Anthropic API rejects the next
   turn with a 400.

## Decision

**Fork by passing `--resume <source> --resume-session-at <anchor> --fork-session`
to `cli.js`. Do not hand-copy or splice JSONL transcripts ourselves.** The
anchor is resolved from the on-disk transcript in the main process, and forks
are seeded lazily on first send.

Resolution & balancing (`src/main/services/fork-anchor.ts`, a pure,
dependency-free module wrapped by `resolveForkAnchor` in `session-history.ts`):

- Find the target assistant line by `message.id === messageId` (fallback: a raw
  line-uuid match). If it issued no tools, the anchor is that line's `uuid`.
- Otherwise walk **forward** over the immediate `tool_result` user-lines that
  resolve its `tool_use` ids, stopping at the next assistant turn, and anchor on
  the **last** such line. The resulting prefix is always tool-cycle balanced.
- Resolving from disk (not from the renderer's in-memory ids) means it works
  identically for historical and live sessions and only offers anchors that are
  actually flushed.

Spawn plumbing (`QueryOptions` already declared `forkSession`/`resumeSessionAt`;
`args.ts` already emitted both flags):

- `ClaudeSession` gains `resumeSessionAt`/`forkSession`. The fork flags are
  gated to the **first run only** (`!this.sessionId`); the resume target then
  flips to the new branch id once `system/init` mints it. Resume precedence in
  `run()` becomes `sessionId ?? resumeSessionId` (was `resumeSessionId ??
  sessionId`) — equivalent for plain historical resume (where they're the same
  id), correct for forks (where the source id must not be re-resumed after the
  branch is born).
- Threaded through `SessionManager.create`, the `session:create` IPC, the new
  `session:resolve-fork-anchor` IPC, preload, `ClaudeAPI`, the remote dispatcher
  handlers, and the web `api-adapter.ts`.

Renderer:

- A `forkOrigin: { sourceSessionId, anchorUuid } | null` field on
  `PerSessionState`. `forkFromMessage()` resolves the anchor, optimistically
  seeds the branch with a deep-copied slice of messages 1..N, sets `forkOrigin`,
  and switches to the new (temporary) routingId.
- The fork **materializes lazily**: `InputBox` reads `forkOrigin` on first send
  and spawns with the three flags. An unused branch never touches disk.
  `cli.js` emits `system/init` with the new UUID and the existing rekey path
  adopts it.
- A hidden-until-hover "Branch" button sits at the bottom-left of **assistant**
  message bubbles only (the natural turn-end boundary).

## Consequences

- **No bespoke transcript surgery.** `cli.js` owns the slice, the new-id mint,
  and the snapshot/file-history binding. Branches also group under their root in
  Claude's native `/resume` picker for free, and we stay forward-compatible.
- **Forks are free until used.** Lazy materialization means clicking Branch and
  not sending leaves no on-disk session — it matches the app's existing
  lazy-spawn model and avoids orphan transcripts.
- **Balanced anchors only.** The forward-walk guarantees no dangling `tool_use`,
  so a branched session's first prompt can never 400 on an unmatched tool call.
- **Permissions don't carry over.** Per upstream, "allow for this session"
  grants are not inherited by a fork — expected and consistent with the CLI.
- **Coupling to `cli.js` internals.** We rely on `--resume-session-at` matching
  the line `uuid` and on `--fork-session` skipping the rebind. If a future
  `claudeCliVersion` changes either, the resolver/flags need re-verification —
  this lives alongside the patch/protocol maintenance surface, not in a patch.
- **A balanced prefix may end on a tool_result (`user`) line.** The subsequent
  user prompt then forms two consecutive user turns; the API concatenates these
  and `cli.js` handles it — no special-casing needed.

## Alternatives considered

- **Copy/splice the JSONL ourselves and start a plain session on the new file.**
  Rejected: re-implements snapshot/file-history binding and new-id generation
  that `cli.js` already does, and would drift from upstream session semantics.
- **Pass the renderer's `ChatMessage.id` directly as `--resume-session-at`.**
  Rejected: it's the `msg_xxx` id for assistant messages, which the flag does
  not match, and it ignores the tool-cycle balance problem.
- **Thread the line `uuid` onto every `ChatMessage` during parsing.** Rejected:
  touches the hot parse path and the shared type, and still wouldn't help live
  sessions whose in-memory ids aren't disk uuids. Disk resolution at fork time
  is localized and covers both cases.
- **Restrict the button to user messages** (where `ChatMessage.id` already is
  the line uuid). Rejected on UX grounds: a branch ending on an unanswered user
  prompt is semantically odd; assistant turn-ends are the natural fork points.
