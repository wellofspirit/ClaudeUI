# ADR-043: SendUserFile client integration — Files widget, preview, remote download

**Status:** Accepted (2026-07-30)

## Context

cli.js ships a `SendUserFile` tool that delivers files to the harness client. Its
`isEnabled()` requires: first-party API, non-essential traffic not disabled, the
`tengu_send_user_file` statsig gate, and boot entrypoint ∈ {`claude-desktop`,
`claude-desktop-3p`, `local-agent`} (not a child session). ClaudeUI satisfies all
four (`CLAUDE_CODE_ENTRYPOINT=claude-desktop` in `src/main/sdk/args.ts`), verified
empirically via the system-init `tools` array. Locally no upload occurs
(`uploadBriefAttachment` no-ops without a REPL bridge): the tool validates paths
and the wire carries an assistant `tool_use` with
`{files[], caption?, status, display?}` plus a paired `tool_result` (text on
success, error result on validation failure). The tool is read-only → never
prompts for permission.

## Decisions

### 1. Transcript-derived state (no separate persistence)

`SentFile[]` is derived purely from session messages
(`buildSentFilesFromMessages`, mirroring `buildTodosFromMessages`), so session
resumption rebuilds it for free. Divergences from todos: cumulative for the whole
session, never auto-cleared on turn end, latest-send-wins per path (a re-send
replaces the entry and moves it to the end). In-flight calls (no tool_result yet)
are listed; the result rebuild fills in `error`.

### 2. Floating Files widget

`SentFilesWidget` is a visual sibling of `TodoWidget`; positioning is owned by a
single stack container in `ChatPanel` so the two widgets remain one layout
decision. Rows are individually expandable (caption, full path, error, actions).
Widgets are draggable by their header (pointer-event drag with a click
threshold); a dragged widget leaves the stack for a viewport-fixed position
persisted in `localStorage`, clamped to the viewport, and returns to the stack on
double-click.

### 3. Desktop open — guarded shell IPC

`shell:open-path` / `shell:show-in-folder` wrap `shell.openPath` /
`shell.showItemInFolder` behind `validateLocalFilePath`
(`src/main/shell-security.ts`): non-empty, no control chars, **no UNC** (an SMB
open would leak NTLM credentials to an attacker-named host), absolute, existing
regular file. Paths are model-controlled text; the renderer resolves relative
paths against the session cwd, main re-validates. These API members are
**optional** on `FileAPI` — the web adapter omits them and the widget hides the
affordances (capability probe, not platform sniffing).

### 4. Image preview — one optional API member, two transports

The widget consumes a single optional
`window.api.getSentFilePreview?(sessionKey, path)` returning an image `src`
(`sessionKey` is the session routingId — the remote transport needs it for the
server-side allowlist lookup; the desktop transport ignores it):

- **Desktop (preload):** IPC reads the file and returns a `data:` URL, guarded by
  `validateLocalFilePath` + image-extension allowlist + size cap.
- **Remote (web adapter):** returns an authenticated same-origin HTTP URL to the
  download endpoint (inline disposition), following `getMockupPreviewUrl`'s
  shape.

SVG previews render via `<img>` only (scripts inert). Non-image `display:render`
files (HTML, PDF) are **not** inline-rendered — deliberate: rendering
model-authored HTML inside the app is a sandboxing project of its own; those
files open externally (desktop) or download (remote).

### 5. Remote download — scoped token + renderer-authoritative allowlist

A new authenticated HTTP route on the remote server serves delivered files to
remote clients (mobile browser download + inline preview). Design follows the
mockup-preview precedent:

- **Third scoped token** (`fileToken`, `crypto.randomBytes(32)`), minted alongside
  the mockup token, delivered over the authenticated WS in `sync-full`, published
  to the web client, and passed as a query parameter. The primary WS token is
  never placed in URLs; a URL-borne token stays low-privilege and independently
  revocable.
- **Allowlist, not just path validation:** on each request the server calls
  `EventLog.getFullState()` (the existing renderer round-trip) and requires the
  requested path to match an entry in that session's `sentFiles` (resolved
  against the session cwd). The renderer store is the single source of truth;
  main stays a pure relay (no parallel ledger to drift). Downloads are
  user-click-frequency, so the round-trip cost is irrelevant.
- `validateLocalFilePath` still applies on top, plus the existing Host allowlist,
  security headers, and constant-time token compare. Responses stream with a
  correct Content-Type, `nosniff`, and `Content-Disposition: attachment` unless
  inline preview is requested.

## Consequences

- Resumption, remote resync, and watched sessions inherit correctness from the
  transcript-derivation contract — there is no second persistence path to break.
- The allowlist inherits the renderer's lifecycle: files are downloadable only
  while their session (and its `sentFiles` state) exists.
- `display` intent is honored for images only; revisit if/when a sandboxed HTML
  preview surface exists.
- A compromised-renderer threat model is unchanged: the shell IPC and file route
  never widen beyond files that were explicitly delivered or that pass the
  local-file guard.

## Cross-references

- ADR-027 (testids — widget assertions), ADR-039/042 (remote auth/serving),
  ADR-041 (remote resync semantics the snapshot field rides on).
