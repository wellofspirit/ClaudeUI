# ADR-049 — Image viewer overlay and the engine-neutral image-content pipeline

**Status:** Accepted (2026-08-04)
**Relates to:** ADR-018 (engine-neutral model), ADR-027 (test ids), ADR-048 (mobile surface pattern — deliberately NOT followed here, see Decision 1)

Shipped in `bfe380a` (viewer), `3834cb2` (attachment rehydration), `da4b984`
(tool-result images).

## Context

Attached images rendered as inert 200px thumbnails; images in *historical*
sessions vanished entirely (all three engines persist them — cli.js as base64
content blocks in the jsonl, opencode as data-URI file parts in its sqlite,
pi natively — but the Claude and opencode history loaders discarded them);
and images *returned by tools* (Read on a .png, screenshot tools, MCP tools)
were dropped at every process boundary — the Claude-side text collapse
(`(c.text)||''` joined) turned an image-only tool result into `''`, which
`FileReadBody` then hid completely, so an image Read rendered as nothing.

The requirement: click-to-enlarge with zoom and prev/next on desktop and
mobile, historical images included, with tool-result images as a separate tab
in the viewer.

## Decision

1. **One `ImageViewerOverlay` for both surfaces — a portalled modal, not an
   ADR-048 content-slot takeover.** ADR-048's takeover pattern exists for
   *pane-sized workflows* that need a navigation contract; a media viewer is
   transient modal chrome with an identical interaction model on both surfaces
   (the only divergence is input modality, which Pointer Events unify). It
   portals to `<body>` at `z-[300]` (above the `z-50`–`z-[200]` dialog/sheet
   stack), locks body scroll, and seals synthetic events at its root so chat
   gestures (e.g. the double-tap fullscreen of e70cdd6) never fire through it.
   All gesture math (anchor-pinned `zoomAt`, `clampPan`, pinch/swipe/double-tap
   classification) lives in `ImageViewer/transform.ts` as pure functions —
   jsdom cannot synthesize real gestures, so the math layer is where zoom
   behavior is actually unit-tested; the component only wires DOM events to it.

2. **Backdrop dismissal is decided in the pointer state machine — `click` is
   sealed but never acted on.** The obvious implementation (`click` +
   `e.target === e.currentTarget`) is unsound: once `setPointerCapture` is
   taken on the viewport for an image-originated gesture, Chromium retargets
   the trailing `click` to the *capturing element*, so a plain click on the
   image arrives as `target === viewport` and closes the viewer. jsdom
   implements no capture retargeting, which is exactly why the naive version
   passed its tests — the defect was proven in a live Chromium repro.
   `pointerdown` records `onBackdrop`/`onImage`/movement; a tap (no slop
   exceeded) on the backdrop closes on the final `pointerup`. The regression
   guard fires the retargeted `click(viewport)` explicitly after an
   image-originated pointer pair. **Any future overlay that combines pointer
   capture with click-outside dismissal must follow this pattern.**

3. **Gallery scoping via `ImageGalleryProvider`, one per message list.**
   ChatPanel, AutomationRunHistory, and SubagentMessages each mount their own
   provider around their own `ChatMessage[]`; a nested provider (subagents)
   shadows the outer one, so paging never walks out of the transcript the
   thumbnail belongs to. Thumbnails call `openAttachment(messageId, i)` /
   `openToolResult(toolUseId, i)` from context and know nothing about the
   viewer or their gallery position. The context value is identity-stable
   (galleries read through a ref inside `useCallback(…,[])`) because
   `MessageBubble` is memo-wrapped and a per-partial identity change would
   re-render every bubble during streaming; the unwrapped default is a no-op
   with `enabled: false`, so hosts without a provider render inert thumbnails
   rather than crashing. Data-URI strings are cached in `WeakMap`s keyed on
   the block object — galleries re-derive on every streaming partial, and
   re-encoding multi-MB base64 each time would be an allocation storm.

4. **Two galleries, surfaced as tabs: Attachments (image blocks on *user*
   messages) and Tool results (`tool_result.images`).** The tab bar renders
   only when 2+ galleries are non-empty, so the common attachments-only case
   shows no tab chrome and the Tool results tab lights up exactly when there
   is something in it.

5. **Tool-returned images are a first-class field on the engine-neutral
   block: `tool_result.images?: ToolResultImage[]`** (`{mediaType, base64Data,
   fileName?}` — following the `fileDiffs` precedent for enriching
   `tool_result`, not a new block type, so existing text/diff handling is
   untouched). Producers omit the key when empty; presence drives UI. The
   four previously hand-rolled media-type allowlists consolidated into
   `IMAGE_MEDIA_TYPES`/`isImageMediaType` (shared/types.ts) — anything outside
   jpeg/png/gif/webp is dropped, never widened, because the renderer builds
   `data:` URLs from `mediaType` verbatim. Per-engine sources:
   - **Claude:** ordinary `{type:'image', source:{type:'base64',…}}` blocks
     inside tool_result content. One shared `extractToolResultContent()`
     (main-process `tool-result-content.ts`) replaced eight duplicated
     collapse sites (live session, history ×4, assistant-message,
     subagent-watcher, automation-manager, cross-engine-dispatcher); the text
     collapse is preserved byte-for-byte so the change is purely additive.
   - **opencode:** attachments ride on the tool part's own
     `state.attachments` (`FilePart[]`, data-URI) — verified against the
     pinned vendor source (`session/processor.ts` `completeToolCall`). They
     are NOT separate assistant-message file parts, so no part-ordering
     heuristic exists anywhere. Assistant-role `file` parts stay skipped.
   - **pi:** `PiImageContent` blocks in toolResult content; `piToolResultText`
     / `piToolResultImages` are shared by the live mapper, stored replay, and
     the subagent path so all three agree. In-flight partial results stay
     text-only by design (the image appears on completion).

6. **History rehydration mirrors the live echo, not storage order.** Both
   Claude jsonl user-line parsers emit attachment blocks *before* the text
   block, and opencode's `convertStoredMessage` hoists user attachments ahead
   of other parts (opencode persists `[text, …files]` while the live echo puts
   attachments first — replay must not render the same message differently).
   Attachment-only user messages are real messages and are no longer dropped.
   `file://` @-mention parts (`text/plain` / `application/x-directory`, and
   even image mimes with no inline data) are never rehydrated; data-URI
   decoding requires the header to match the declared mime exactly (stored
   parts are untrusted input).

7. **The thumbnail strip renders in `ToolCard`'s shared result area, outside
   the collapse gate.** One kind-agnostic `<ToolResultImages>` placement
   covers every standard tool kind with zero per-kind edits and bypasses
   `FileReadBody`'s `showResult` gate (which hides the whole section when
   `toolResult` is `''` — exactly the image-only Read shape). Not gating on
   `expanded` is deliberate: the image IS the result, and a collapsed card
   gives no hint one exists — same posture as the bash streaming/background
   footers. Custom-layout kinds (diagram/mockup) render their own card and
   get no strip; they synthesize visuals from tool *input* and never return
   images (pinned by test).

## Consequences

- Images survive reload on all three engines, and every image in a session is
  reachable from any thumbnail via the viewer's galleries.
- The `tool_result.images` field is the extension point for any future media
  a tool returns; PDFs returned by tools are deliberately not modeled (no
  thumbnail affordance; the gallery is images-only).
- Renderer memory for image-heavy historical sessions grows by the decoded
  transcript size — the same cost a live session already paid; no cap was
  added. If it bites, the lever is lazy-loading history images, not dropping
  them.
- The Chromium click-retargeting hazard (Decision 2) is documented here and
  guard-tested; it will silently reappear in any new overlay that reintroduces
  click-based dismissal under pointer capture.
- Android's double-tap word-selection vs the overlay's `select-none` is an
  untested CSS assumption pending a real-device check (same caveat family as
  ADR-048's iOS keyboard notes).

## Alternatives considered

- **Per-message lightbox (no cross-message gallery)** — rejected: "previous/
  next image" across the session was the requirement; a per-message viewer
  makes single-image messages a dead end.
- **Store-based viewer state (zustand slice) instead of a context provider** —
  rejected: the viewer would need per-list scoping anyway (chat vs automation
  run vs subagent transcript); a provider *is* the scope, and keeps the viewer
  mountable in tests without the session store.
- **Rendering tool images per kind body (FileReadBody etc.)** — rejected: any
  kind can return an image (MCP), and N per-kind edits would drift; one shared
  placement can't.
- **A `screenshot`/`image` ToolKind** — rejected: kind classification is by
  tool *name*; whether a result contains an image is a per-invocation runtime
  fact, so it belongs on the result block, not the kind.
- **Deleting SentFilesWidget's lightbox but keeping it single-image** —
  superseded by reusing the shared viewer with its own single-tab gallery,
  which added paging across sent files for free.
