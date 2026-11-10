import type { EngineId } from './engine'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string }

/** SDK sends "Agent" (canonical, v0.2.63+) or "Task" (alias for backward compat) */
export function isAgentTool(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task'
}

/**
 * A single file's unified diff, surfaced by opencode's apply_patch/edit tool
 * results (`metadata.files[]` / `metadata.filediff` — see
 * src/main/opencode/event-mapper.ts `extractFileDiffs`). Lets the fileEdit kind
 * body render real per-file diff cards instead of a generic JSON/text dump.
 */
export interface FileDiff {
  /** Relative-to-worktree path when the engine provides one (apply_patch); otherwise the raw (often absolute) file path. */
  path: string
  /** Unified diff text (already trimmed by opencode's `trimDiff`). */
  patch: string
  additions?: number
  deletions?: number
  /** 'move' = apply_patch rename (patch headers carry the old/new paths); edit/write never produce it. */
  changeType?: 'add' | 'update' | 'delete' | 'move'
}

/**
 * An image an ENGINE returned from a tool call — Read on a .png, a screenshot
 * tool, an MCP tool rendering something. Distinct from the `image` ContentBlock,
 * which is an image the USER attached to a prompt: these hang off the
 * `tool_result` block that produced them, feed the image viewer's "Tool results"
 * gallery, and are never sent back up as prompt input.
 *
 * The bytes are NOT here: a `BlobRef` into the host's blob store
 * (`core/services/blob-store.ts`), fetched on demand through `blob:get`
 * (ADR-087). The renderer builds `data:<mediaType>;base64,…` from the fetched
 * bytes, so the media type is narrowed to what an `<img src>` will render.
 *
 * Producers must OMIT the carrying `images` key when there is nothing to carry
 * (never `images: []`) — the renderer's gallery/tab visibility is driven by
 * presence.
 */
export interface ToolResultImage extends BlobRef {
  mediaType: ImageMediaType
  /** Only when the engine supplies one (opencode file parts); Claude transcripts carry none. */
  fileName?: string
}

/**
 * Content-addressed handle to bytes the host keeps out of band (ADR-087).
 *
 * Images and documents ride every transcript lane — events, the ring, the
 * snapshot, history loads — as this handle instead of inline base64, so a
 * screenshot-heavy session costs a few dozen bytes per image on the wire. A
 * client fetches the bytes with `ClaudeAPI.getBlob`; the host may have evicted
 * them (LRU), which a client renders as "unavailable", never as an error.
 */
export interface BlobRef {
  /** Lowercase hex SHA-256 of the DECODED bytes. */
  blobId: string
  /** Decoded size — lets a client budget and label without fetching. */
  bytes: number
}

/**
 * What a client uploads with a prompt — an invoke ARGUMENT, never ringed, never
 * snapshotted. Keeps base64 because the engine needs the bytes.
 */
export interface AttachmentUpload {
  mediaType: string
  base64Data: string
  fileName?: string
}

/** The same attachment after the host interned it — what events, queue items and blocks carry. */
export interface AttachmentRef extends BlobRef {
  mediaType: string
  fileName?: string
}

/** The image media types the `image` ContentBlock and `ToolResultImage` model. */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

/**
 * Runtime companion to `ImageMediaType` — the single allowlist every engine
 * adapter filters through before emitting an image to the renderer (there used
 * to be one hand-rolled copy per adapter). Anything outside it (image/svg+xml,
 * image/tiff, image/bmp, …) is DROPPED rather than widened: the renderer builds
 * `data:<mediaType>;base64,…` verbatim, so an unrenderable type would surface as
 * a broken image in the chat and the viewer.
 */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp'
])

/** Narrowing guard for `IMAGE_MEDIA_TYPES` — use instead of casting a string. */
export function isImageMediaType(mediaType: unknown): mediaType is ImageMediaType {
  return typeof mediaType === 'string' && IMAGE_MEDIA_TYPES.has(mediaType)
}

/**
 * A permission JUDGE's verdict on the tool call it judged, carried on the card
 * of that call rather than as prose beside it (ADR-067, F18).
 *
 * Two reviewers produce one: the Auto-mode classifier (`auto-mode`, whose
 * `rule` names the rule it matched) and, in transcripts stored before the Codex
 * engine was removed, Codex's native auto-review (`codex-auto-review`, whose
 * `riskLevel` is the reviewer's own; nothing writes it any more). `auto-mode` covers two
 * judges that answer the same question: ClaudeUI's own classifier on opencode
 * and pi, and cli.js's native one on Claude, whose verdict reaches us as
 * `system/permission_denied` — blocks only, since cli.js emits no frame for an
 * allow. A pre-ask denial that was NOT a judge's call — a deny rule, a hook,
 * the static safety checker — is a {@link PermissionDenialBlock} instead,
 * because it carries no verdict that could have gone the other way.
 *
 * `rationale` and `rule` are UNTRUSTED model text. The PRODUCER (core) collapses
 * whitespace and caps the length once — see `core/shared/tool-review.ts` — so
 * every client renders them verbatim as plain text, never through markdown.
 */
export type ToolReviewBlock = {
  type: 'tool_review'
  /** The `tool_use` block this verdict is about. */
  toolUseId: string
  /** The reviewer's own stable id for this verdict — the block's identity. */
  reviewId: string
  reviewer: 'codex-auto-review' | 'auto-mode'
  decision: 'approved' | 'denied' | 'timedOut' | 'aborted' | 'inProgress'
  /** `codex-auto-review` blocks only (stored transcripts) — ClaudeUI's judge scores no risk level. */
  riskLevel?: 'low' | 'medium' | 'high' | 'critical'
  /** ClaudeUI's judge only — the corpus rule name behind a block. */
  rule?: string
  rationale?: string
  /**
   * ADR-091 part 6 — the user overrode this auto-mode BLOCK: Approve anyway on
   * its held card, or Approve on the blocked review afterwards. The host
   * re-sends the review with this set (a new `reviewId`, so the reducer's
   * last-one-wins shows it and it replicates like any review); the card then
   * reads "approved by you" and offers no Approve.
   */
  overriddenByUser?: true
  /**
   * With {@link overriddenByUser} after an after-the-fact Approve: who the
   * host sent the "run it again" nudge to, as the card says it — "the main
   * agent", or a live subagent's quoted label. Absent after Approve anyway (the
   * held call simply ran).
   */
  nudgedTo?: string
}

/**
 * Who refused a tool call before any prompt was raised — cli.js's
 * `PermissionDecisionReason` discriminator, narrowed to the set it declares
 * (`docs/protocol-cc/04-system-subtypes.md` §4.25). `classifier` is deliberately
 * absent: a judge's verdict is a {@link ToolReviewBlock}. Anything unrecognised
 * lands on `other` rather than widening the union, so a new upstream source
 * renders as a generic denial instead of vanishing.
 *
 * One member is NOT cli.js's: `autoModeNoVerdict` is derived by the producer
 * (`core/services/claude-permission-decision.ts`) from a `classifier` denial
 * where the classifier reached no verdict and the frame says so natively: it was
 * unavailable, it gave no verdict repeatedly, or the transcript overflowed its
 * context. The action was refused, but nobody judged it, so it is a denial
 * rather than a review. It is never accepted from the wire.
 */
export type PermissionDenialSource =
  | 'autoModeNoVerdict'
  | 'rule'
  | 'mode'
  | 'subcommandResults'
  | 'permissionPromptTool'
  | 'hook'
  | 'asyncAgent'
  | 'sandboxOverride'
  | 'workingDir'
  | 'safetyCheck'
  | 'other'

/**
 * A tool call refused before any prompt was raised, by something that is not a
 * judge — a deny rule, the permission mode (`dontAsk`), a PermissionRequest
 * hook, the static safety checker, a working-directory bound.
 *
 * Without this the refusal reaches the user as a bare `is_error` tool_result
 * and nothing says WHO refused or why; the whole point of cli.js emitting the
 * frame is that SDK hosts can render the denial rather than only its fallout.
 *
 * The `message` cli.js hands the model IS the tool_result's text, so it is
 * deliberately not carried here — duplicating it on the card would say the same
 * sentence twice. This block adds only what the result cannot: the source, and
 * the reason when the source has one.
 *
 * `reason` is UNTRUSTED text (a hook's output, a classifier-adjacent string)
 * collapsed and capped ONCE by the producer — `core/shared/tool-review.ts`,
 * the same gate `ToolReviewBlock.rationale` goes through — and rendered
 * verbatim as plain text by every client, never through markdown.
 */
export type PermissionDenialBlock = {
  type: 'permission_denial'
  /** The `tool_use` block this denial is about. */
  toolUseId: string
  /**
   * The emitting frame's `uuid` — the block's identity, which is what makes a
   * replayed catch-up a no-op. cli.js mints one per frame; unlike a review
   * there is never a second denial for the same call, so this is a dedupe key
   * rather than a version.
   */
  denialId: string
  source: PermissionDenialSource
  /**
   * Present only when the source carries one: cli.js's `Noe` returns a reason
   * for `hook`, `safetyCheck`, `asyncAgent`, `sandboxOverride`, `workingDir` and
   * `other`, and returns NOTHING for `rule`, `mode`, `subcommandResults` and
   * `permissionPromptTool` — those denials are fully described by their source.
   * The opencode host's own `rule` denial (ADR-085 S2) does carry one: the
   * rule that refused, `Denied by permission rule: <rule>`, since no other
   * frame names it. So does its `mode` denial (ADR-085 §3, plan mode's
   * host-side refusal of an edit or a `general` subagent): the plan-mode text
   * the model was given.
   */
  reason?: string
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | ToolReviewBlock
  | PermissionDenialBlock
  | { type: 'tool_use'; toolUseId: string; toolName: string; toolInput?: Record<string, unknown> }
  | {
      type: 'tool_result'
      toolUseId: string
      toolResult: string
      isError?: boolean
      fileDiffs?: FileDiff[]
      images?: ToolResultImage[]
    }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'cli_command'; commandName: string; commandArgs?: string; commandOutput?: string }
  /**
   * `providerId` is the credential that was refused (ADR-070 §4) — carried on
   * the BLOCK so history is self-describing. The row used to name the provider
   * from the session's live `authRequired`, which is nulled the moment the
   * failure settles, so a Claude rejection read "the credential was rejected"
   * with no provider from then on — forever, and on every reload. OPTIONAL, so
   * every block written before this (and every reconstructed Claude transcript)
   * stays valid and simply falls back to the generic sentence.
   */
  | { type: 'api_error'; errorType: string; errorMessage: string; providerId?: string }
  | { type: 'compact_separator'; text?: string }
  /**
   * Context an engine injected into the model's prompt that the USER never
   * typed — pi's `custom_message` entries, and (later) Claude's `attachment` family. Collapsed to a count by
   * default; every fragment is UNTRUSTED third-party text and is rendered
   * verbatim, never through the markdown pipeline.
   */
  | { type: 'context_note'; title: string; fragments: { text: string; label?: string }[] }
  /**
   * What a dispatched agent's engine reported about the run that no message of the agent
   * carries, shown in its card's transcript — today a Claude target's model switch
   * (`model_refusal_fallback` / `model_fallback`, which a root session shows as a warning).
   * The engine's own text, rendered verbatim, never through the markdown pipeline.
   */
  | { type: 'notice'; text: string }
  /**
   * Claude Code holding (or having held) a message another Claude session sent
   * this one over its own socket — `system/peer_message_hold`. One row per
   * message (`holdId` is cli.js's message uuid), updated in place: `held` waits for
   * the user (the row offers "Allow messages from other Claude sessions here"),
   * `released` was delivered after all, `dropped` never will be. `cause` and
   * `outcome` are cli.js's own words (`mode-mismatch`, `discarded`, …).
   */
  | {
      type: 'peer_hold'
      holdId: string
      state: 'held' | 'released' | 'dropped'
      lane: 'stdin' | 'socket'
      fromName: string
      cause?: string
      outcome?: string
    }
  /**
   * A session started from (or handed off to by) this one: its card in the
   * parent's transcript (session tools, slice 1b). Only the stable part rides in
   * the block: the child's ref, why it exists and the name and engine it was
   * given. What the card SHOWS beyond that — the child's current title, whether
   * it is working, waiting for the user or failed — is read from the replicated
   * link and session state, so the card stays true without being rewritten.
   */
  | {
      type: 'session_card'
      childRef: string
      kind: 'started' | 'handoff'
      title: string
      engineId: EngineId
    }
  /**
   * A session an agent proposed for the user to start (session tools, slice 1c-b):
   * rewritten in place on every state change, so the block carries all it shows.
   * The host decides expiry lazily; the card shows a pending proposal past
   * `expiresAt` as expired (`proposalDisplayState`).
   */
  | {
      type: 'proposal_card'
      proposalId: string
      title: string
      prompt: string
      background: string
      placement: import('../session-proposals').ProposalPlacement
      /** The proposing session's own directory, so the card can say when the placement differs. */
      parentCwd: string
      state: 'pending' | 'started' | 'dismissed'
      /** Why it was dismissed: `expired`, `evicted`, `user`, or the agent's own words. */
      reason?: string
      expiresAt: number
      /** The started session's ref, once it has started. */
      startedRef?: string
    }
  /** A user-attached image. The bytes live in the host's blob store (see {@link BlobRef}). */
  | { type: 'image'; mediaType: ImageMediaType; blobId: string; bytes: number; fileName?: string }
  /** A user-attached PDF. The bytes live in the host's blob store (see {@link BlobRef}). */
  | {
      type: 'document'
      mediaType: 'application/pdf'
      blobId: string
      bytes: number
      fileName?: string
    }

export interface FileAttachment {
  id: string
  fileName: string
  fileType: 'image' | 'pdf'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf'
  base64Data: string
  previewUrl: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: ContentBlock[]
  timestamp: number
  planContent?: string
  /**
   * A user-role row the HOST sent on the user's behalf (a standing setting or a
   * click — context pressure), not text the user typed: the renderer labels it
   * "Sent by ClaudeUI for you". Only on rows built from a `host-instruction`
   * prompt (slice 1a, spec §5.1).
   */
  hostInstruction?: true
  /** The model this assistant message was generated by, as the engine reports it. */
  model?: string
  /**
   * Elapsed wall-clock ms of the thinking span this message SEALS, stamped by
   * the emitter — SyncCore phase 4b.
   *
   * No producer stamps it since 2026-09-17: `BaseSession.send`'s thinking clock
   * went with the legacy stream lane, and every adapter now puts `durationMs`
   * on the thinking block it seals. The field and the reducer's move stay so an
   * old-shape payload (a committed fixture, a ring caught up across the
   * upgrade) still lands its duration on the block.
   *
   * A transient wire hint, not stored state: the shared reducer moves it onto
   * the sealed thinking block's `durationMs` and drops the field, so canonical
   * state (and every snapshot built from it) carries the duration where the
   * renderer expects it. It exists because `applyEvent` is clock-free by
   * contract — a reducer that measured the span itself would fold a different
   * state on every replay — so the only honest source of elapsed time is the
   * process that watched the clock: the emitter.
   */
  thinkingDurationMs?: number
}
