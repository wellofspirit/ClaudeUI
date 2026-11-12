# User interface

Governs: `src/renderer/src/components/`, `src/renderer/src/hooks/`, `src/renderer/src/assets/`, `src/web/`, `src/shared/agent-type-colors.ts`, `src/shared/sent-file-url.ts`, `src/core/sent-file-security.ts`, `src/core/shell-security.ts`, `eslint.config.mjs`

Renderer rules shared by the desktop app and the web client (one UI build, ADR-099): the mobile surface pattern,
the image viewer and tool-returned images, the zoom trap, Mermaid sanitisation, the Files widget for
`SendUserFile`, find-in-chat markers, the agent type tile and the sidebar status dot. Every rule applies to both
surfaces unless its section says otherwise. Related decisions in other records: settings information
architecture ADR-065 (persistence-and-settings.md); the agent roster and run identity ADR-073
(agents-and-tasks.md); `data-testid` conventions ADR-027 (development-workflow.md); the mobile terminal ADR-060
and terminal tabs ADR-002/ADR-003 (terminals-and-worktrees.md); mockup previews ADR-007 and the remote terminal
ADR-052 (remote-access.md); the auth pill ADR-070 (auth-and-accounts.md); transcript blobs ADR-087 and the
SyncCore snapshot ADR-051 (sync-core.md); cross-engine dispatch ADR-033 and background dispatch ADR-105
(dispatch.md).

## Mobile surfaces are content-slot takeovers; selection is navigation; inputs never sit mid-scroll (ADR-048)

The mobile view is a viewport of 768px or less, in practice the remote web client on a phone. Two platform facts
shape the rules: Android Chromium shrinks the layout viewport under the soft keyboard
(`interactive-widget=resizes-content`, set in `web.html`), so bottom-pinned flex footers track the visible area;
iOS ignores the keyword, the keyboard overlays an unshrunk viewport, and only scroll-into-view keeps a focused
input visible. A phone also fits exactly one pane.

- **Top bar.** One glanceable status pill (`GitChangesPill`, which toggles the git panel and hides outside a
  repo) plus one "more" overflow menu. Every other entry lives in the menu, an item array gated per item and
  hidden when empty. A menu entry carries character-for-character the gate its desktop button uses, so the two
  surfaces cannot disagree about a session's capabilities. The Terminal entry inherits the menu's `cwd`
  precondition on purpose: without a cwd the panel would open empty and its `+` would spawn an invisible pty in
  the `'.'` fallback, with no second entry point on a phone.
- **Right panels are content-slot takeovers.** When `isMobile && rightPanel === '<x>'`, the ChatPanel slot is
  replaced wholesale by a fullscreen component with a back-button header that drives the same store action as
  the desktop panel's close (`MobileTaskView`, `MobileGitView`). Panel state never forks between layouts. `plan`
  and `mockup` are desktop-only and adopt the same pattern if they get mobile surfaces.
- **Presentation fork, shared container.** Every dialog follows `const View = isMobile ? MobileView :
DesktopView` with state, channels and mutations shared verbatim (PermissionsDialog, SettingsDialog, McpDialog,
  SkillsDialog, TerminalPanel). The desktop View stays untouched; each fork has a two-direction fork-guard
  test. Mobile forks carry distinct test roots (`SettingsMobileView`, `McpMobileView`, `SkillsMobileView`,
  `TerminalMobileView`) so a verifier asserting a desktop id cannot silently no-op on a phone;
  PermissionsDialog keeps its shared root as the grandfathered exception.
- **A host drops its state on its wrong side of 768px**, so a breakpoint crossing neither double-mounts nor
  resurrects a takeover. Mobile settings are hosted by SessionView (the sidebar drawer unmounts its children).
- **Master/detail dialogs are list-to-detail drill-downs, and selection IS the navigation.** There is no local
  navigation state: MobileGitView shows the list when `gitSelectedFile === null` and the diff otherwise; MCP
  derives its screen from the container's `selected`. Mobile always lands on the list: mount does not
  auto-select the first file and clears stale selections. `GitCommitBox` takes `autoSelectNext` (default true;
  mobile passes false) because the desktop post-commit select-first-remaining would teleport the list into an
  unrequested diff. Any new code that writes `gitSelectedFile` implicitly navigates the mobile view: treat it
  as a navigation API.
- **Destructive actions are two-tap** with a 3s disarm, on a stable testid with a `data-armed` discriminator.
  Forms that need a mid-scroll multi-field editor (MCP Add Server) are deliberately omitted on mobile.

### Decision 4 Keyboard-safe input placement

A text input on mobile is either (a) a bottom-pinned flex footer inside the viewport-sized layout (the chat
composer, `GitCommitBox`), or (b) top-anchored in a fullscreen sheet, safe on both platforms because the input can
never be where the keyboard is. **Never mid-scroll.** PermissionsDialog is the reference: an input-free browse
layer (scope tabs, tap-to-edit rows, a pinned Save footer) plus an entry sheet with exactly one top-anchored
input, template chips as a tap row, and tap-driven directory autocomplete (`useDirSuggestions` in
`PermissionsDialog/shared.ts`) instead of the desktop's Tab/arrow flow. If iOS bottom-pinned inputs prove
janky, the escape hatch is a top-anchored sheet, not per-platform viewport hacks. Rejected: a responsive pass
over the desktop permissions dialog (keeps mid-scroll inputs and keyboard-only autocomplete) and git as a
segmented control (hides the commit box while viewing diffs).

### Decision 5 Terminal on mobile

Superseded by ADR-052 (remote-access.md): the remote terminal exists behind a desktop-side opt-in, capability
grants and passkey step-up. The mobile terminal is a fullscreen takeover reusing TerminalPanel wholesale
(availability, pool, read-only and step-up unchanged) plus an accessory key row (Esc, Tab, ^C, arrows) that
injects through xterm's own `input(data, true)` into the same `onData` closure that holds the ADR-054
read-only gate and is the renderer's only `terminal:write` caller, so the keys cannot bypass step-up. It mounts
only while open; the pty ring replays on re-attach. See ADR-060 (terminals-and-worktrees.md).

**amendment item 2 — settings is scope tabs, horizontal swipe and accordions.** Mobile settings is a fullscreen
takeover with equal-width tabs and an underline, lazily mounted accordions that reuse the desktop content
unchanged, and search that goes wide (one flat hit list across every tab; a phone user should not need to know
where "sandbox" lives). Since the ADR-065 page model the tabs are the three rail groups (App, Features,
Engines) and the accordions are pages; several may be open at once and the open set survives tab switches and
search. The phone re-presents the model and does not re-implement it: every row goes through the same
`item.render(...)` call as desktop, and engine-segment state and search bucketing come from shared modules. The
group chrome is rebuilt from the same class tokens (the desktop header's scroll-spy rail and fixed 240px control
column mean nothing at 390px), and a phone header wraps its engine segment, badge and storage tag onto a second
line where the desktop truncates the label. `useSwipeTabs` is touch/pen-only, direction-locked with ties going
to vertical, pointerId-keyed (a second finger aborts), never calls `preventDefault`, and exempts controls and
real horizontal scrollers.

**Enroll and access links.** The passkey enroll strip's dismissal latch is permanent because the durable "Set up
a passkey on this device" card (top of Settings > Remote on web) shares one flow with it through the
`window.__REMOTE_ENROLL__` bridge and never touches the latch. AccessLinks on web shows only facts a browser
holds; the LAN row asks via `authcfg:lan-link`, tailnet and tunnel rows are withheld rather than guessed, and
the locked LAN row's Reveal button re-asks on the operator's own press (the line ADR-054 §6 draws against
ambient ceremonies).

## One portalled image viewer; tool-returned images are `tool_result.images` (ADR-049)

- **One `ImageViewerOverlay` for desktop and mobile**, a portalled modal at `z-[300]` (above the `z-50` to
  `z-[200]` dialog and sheet stack), not an ADR-048 content-slot takeover: it is transient modal chrome with one
  interaction model (Pointer Events unify the modalities). It locks body scroll and seals synthetic events at its
  root so chat gestures (double-tap fullscreen) never fire through it. Gesture math (`zoomAt`, `clampPan`,
  pinch/swipe/double-tap classification) is pure functions in `ImageViewer/transform.ts`, because jsdom cannot
  synthesise gestures.
- **Backdrop dismissal is decided in the pointer state machine; `click` is sealed but never acted on.** After
  `setPointerCapture` on the viewport for an image-originated gesture, Chromium retargets the trailing `click`
  to the capturing element, so a plain click on the image arrives as `target === viewport` and a
  `click` plus `e.target === e.currentTarget` check closes the viewer. jsdom has no capture retargeting, which is
  why the naive version passes its tests. `pointerdown` records `onBackdrop`/`onImage`/movement; a tap without
  slop on the backdrop closes on `pointerup`. Any overlay that combines pointer capture with click-outside
  dismissal follows this pattern.
- **Galleries are scoped by `ImageGalleryProvider`, one per message list** (ChatPanel, AutomationRunHistory,
  SubagentMessages); a nested provider shadows the outer one, so paging never leaves the transcript the
  thumbnail belongs to. Thumbnails call `openAttachment(messageId, i)` / `openToolResult(toolUseId, i)` and know
  nothing of the viewer. The context value is identity-stable (galleries read through a ref) because
  `MessageBubble` is memoised and a per-partial identity change would re-render every bubble while streaming;
  the unwrapped default is a no-op with `enabled: false`, so a host without a provider renders inert thumbnails.
- **Two galleries as tabs**: Attachments (image blocks on user messages) and Tool results
  (`tool_result.images`). The tab bar renders only when two or more are non-empty. SentFilesWidget reuses the
  viewer with its own single-tab gallery.
- **`tool_result.images?: ToolResultImage[]` is the engine-neutral tool-media field**, an enrichment of
  `tool_result` and not a new block type or a `ToolKind` (kind is by tool name; an image is a per-invocation
  fact). Producers omit the key when empty. Only `IMAGE_MEDIA_TYPES` (jpeg, png, gif, webp) pass; anything
  else is dropped and never widened, because the renderer builds `data:` URLs from `mediaType`. Claude reads
  base64 image blocks inside tool_result content through the one shared `extractToolResultContent()`; opencode
  reads the tool part's own `state.attachments` (never assistant-role file parts, which stay skipped); pi reads
  `PiImageContent` blocks, and in-flight partial results stay text-only. PDFs returned by tools are not modelled.
- **The bytes are a blob ref (ADR-087, sync-core.md).** `ToolResultImage` and attachment image blocks carry a
  `{blobId, bytes}` handle resolved through `blob:get` and the client blob cache; the viewer, galleries and tabs
  are unchanged.
- **History rehydration mirrors the live echo, not storage order.** Attachment blocks come before the text
  block in both Claude jsonl parsers and in opencode's `convertStoredMessage`; attachment-only user messages are
  real messages. `file://` @-mention parts are never rehydrated; a data-URI decode requires the header to match
  the declared mime exactly (stored parts are untrusted).
- **The thumbnail strip renders in `ToolCard`'s shared result area, outside the collapse gate** (one
  kind-agnostic `<ToolResultImages>`), so an image-only Read (`toolResult === ''`) is not hidden by
  `FileReadBody`'s `showResult` gate. It is not gated on `expanded`: the image is the result. Custom-layout
  kinds (diagram, mockup) get no strip.

## No viewport units inside SessionView's zoom (ADR-093)

`SessionView` renders the app under CSS `zoom: uiFontScale` (1 to 1.5), on a root whose width and height already
divide by the scale. Inside that subtree every `vw`, `vh`, `dvh`, `svh` and `lvh` length is multiplied by the
zoom while `getBoundingClientRect()` reports page px, so a box sized as a fraction of the viewport is `scale`
times too big (dialogs run off a small window; a phone overlay's edge leaves the screen). jsdom evaluates no
layout and cannot see it. ChatPanel's message list is a second, nested zoom (`chatFontScale / uiFontScale`);
the rule applies there too.

**Inside the zoomed root, write no viewport unit.** Size against something already in zoomed px:

1. A percentage of a box that is: a modal inside a `fixed inset-0` backdrop uses `max-h-[85%]`, `max-w-[95%]`,
   `w-[min(620px,94%)]`, `max-w-[calc(100%-2rem)]`; the composer overlay uses `max-w-full`. A percentage
   `max-height` needs a parent with a definite height (every `fixed inset-0` backdrop has one); check before
   switching an auto-height parent's child.
2. Or divide by `uiFontScale` where there is no box to be a percentage of:
   `maxWidth: calc((100vw - 32px) / ${uiFontScale})` (SettingsDialog, SheetFrame, anchored menus; see
   `shared/use-anchored-menu.ts`).

**Enforcement.** Two selectors are appended to the renderer block's `no-restricted-syntax` array in
`eslint.config.mjs` (a second config object for the same files would replace the sealed-field selectors): a
string `Literal` or `TemplateElement` with a number followed by a viewport unit, and the Tailwind classes
`(min-|max-)?(h|w)-(screen|dvh|svh|lvh)`. A site that is outside the zoomed root, already divides by
`uiFontScale`, or is not mounted carries `// eslint-disable-next-line no-restricted-syntax -- <why>`. Today's
sites: SessionView's own root, SettingsDialog View and SheetFrame (divide), `TerminalMobileView` (hosted after
the zoomed div closes), `DirectoryBrowserDialog` (portalled to `document.body`), the `web/main.tsx` loading
screen (before SessionView), the unmounted WelcomeScreen. The rule is syntactic: it misses a unit built at
runtime and CSS files (`main.css`'s `html`/`body` units are outside the zoom). `McpDialogLayout.browser.test.tsx`
renders the MCP dialog in `ZoomFrame` at scales 1, 1.25 and 1.5 in a 1280x640 window and asserts the panel and
both Close buttons stay inside it; it is the backstop for what the lint cannot see.

## Mermaid labels are HTML, behind three coupled safeguards (ADR-012)

`MermaidDiagram` renders model-generated (semi-trusted) Mermaid source and injects the SVG with
`dangerouslySetInnerHTML`, in the desktop renderer and the web client alike. The safety stack, in
`chat/mermaid-themes.ts` (`buildMermaidInitConfig`, the one `mermaid.initialize` payload, also used by
`scripts/audit-mermaid-contrast.mjs`) and `chat/mermaid-render.ts` (`sanitizeMermaidSvg`):

- `securityLevel: 'antiscript'` with the root-level `htmlLabels: true`: HTML markup in labels (`<br/>`, `<b>`,
  `<span style>`) renders while `<script>` and click handlers are stripped. `'strict'` encodes the tags (no
  `<br/>`); `'loose'` re-admits click callbacks and arbitrary HTML, which is more than needed. `flowchart.htmlLabels`
  is deliberately not set (deprecated for the root key).
- DOMPurify with `USE_PROFILES: { svg, svgFilters, html }`, `ADD_TAGS: ['foreignObject']` and
  `HTML_INTEGRATION_POINTS: { foreignobject: true, 'annotation-xml': true }`. DOMPurify 3.x treats only
  `annotation-xml` as an integration point by default, so without the override every XHTML label under
  `<foreignObject>` fails the SVG-to-HTML namespace check and is silently emptied; the `html` profile alone is
  not enough, and dropping the override or the profile blanks every label. Keep `annotation-xml` (MathML).
  Scripts, `on*` handlers and `javascript:` hrefs are still removed.
- **The three are one unit.** Tightening to `strict`/`svg`-only kills markup; loosening to `'loose'` without
  re-examining DOMPurify re-admits click callbacks. Regression coverage is `sanitizeMermaidSvg.unit.test.ts`.

**Never parse the rendered SVG as `image/svg+xml`.** DOMPurify serialises void tags as bare `<br>`; the strict
XML parser errors on it and Chromium truncates the SVG at the first `<br>`, silently dropping every later node.
All DOM work goes through `parseSvgElement()` (the HTML parser) and every strict-XML consumer (rasterising to
PNG through `<img src="data:image/svg+xml">`) goes through `svgElementToXml()` (`XMLSerializer`, which
self-closes void tags and first strips the redundant literal `xmlns` on the foreignObject `<div>`); both live
in `shared/ImageViewer/svg-dom.ts`. `svg-dom.unit.test.ts` pins that a bare `<br>` in the first node does not
truncate.

**Dark-theme ER contrast.** Mermaid's `dark` base theme hardcodes white ER attribute-row fills regardless of
dark mode, leaving light theme text unreadable. The `dark` and `monokai` entries of `THEME_CONFIGS` override
`attributeBackgroundColorEven`/`Odd`; the light theme keeps Mermaid's default. Only ER needed it (the other
colour scales derive from the dark `primaryColor`). An explicit Mermaid theme setting (not `auto`) returns the
pure base theme with no overrides on purpose ("native theme as is"), so ER rows are white there. Rejected:
recolouring the rendered DOM (brittle against Mermaid's markup). `maxTextSize` and `maxEdges` are raised for
large model diagrams (they are local-render DoS guards, and hitting them failed silently).

## The Files widget for `SendUserFile` (ADR-043)

cli.js's `SendUserFile` tool delivers files to the harness client; ClaudeUI satisfies its enable gate
(`CLAUDE_CODE_ENTRYPOINT=claude-desktop`). Locally nothing is uploaded: the wire carries an assistant `tool_use`
with `{files[], caption?, status, display?}` and a paired `tool_result`. The tool is read-only and never prompts.

- **State is derived from the transcript**, never persisted separately: `buildSentFilesFromMessages` (now in the
  shared SyncCore reducer, `src/core/shared/sync/reducer.ts`, ADR-051) rebuilds `SentFile[]`, so resumption and
  remote resync inherit correctness. It is cumulative for the session, never auto-cleared, latest-send-wins per
  path (a re-send moves the entry to the end), and lists in-flight calls (the result fills in `error`). The
  "renderer store is the single source of truth, main is a pure relay" framing of the original ADR is superseded
  by ADR-051; the sent-file mechanism survived unchanged.
- **Desktop open is guarded shell IPC.** `shell:open-path` and `shell:show-in-folder` wrap Electron's
  `shell.openPath` / `showItemInFolder` behind `validateLocalFilePath` (`src/core/shell-security.ts`): non-empty,
  no control characters, no UNC path (an SMB open would leak NTLM credentials to an attacker-named host),
  absolute, and an existing regular file. Paths are model-controlled text; the renderer resolves relative paths
  against the session cwd and main re-validates. These members are optional on `FileAPI`; the web adapter omits
  them and the widget hides the affordances (capability probe, not platform sniffing).

### §2 Floating Files widget

`SentFilesWidget` is a visual sibling of `TodoWidget`; positioning belongs to the single stack container in
`ChatPanel` so the two stay one layout decision. Rows expand individually (caption, full path, error, actions).
A widget is draggable by its header (`useDraggableWidget`: pointer-event drag with a click threshold): a dragged
widget leaves the stack for a viewport-fixed position persisted in `localStorage`, clamped to the viewport, and
returns on double-click. It is pure DOM plus `localStorage`, so it behaves the same on the web client.

### §4 Image preview: one optional API member, two transports

The widget consumes `window.api.getSentFilePreview?(sessionKey, path)`, which returns an image `src`
(`sessionKey` is the session routingId, needed by the remote transport for the allowlist lookup). Desktop: IPC
`file:sent-file-preview` reads the file into a `data:` URL behind `validateLocalFilePath`, an image-extension
allowlist and a 10 MB cap checked by `stat` before any read (`src/core/sent-file-security.ts`). Remote: an
authenticated same-origin `/sent-file` URL with `inline=1`. SVG previews render through `<img>` only (scripts
inert). Non-image `display:render` files (HTML, PDF) are deliberately not rendered inline: rendering
model-authored HTML inside the app is a sandboxing project of its own, so they open externally (desktop) or
download (remote). `display` is honoured for images only.

### §5 Remote download: scoped token plus an allowlist

`GET /sent-file?session=<routingId>&path=<b64url>&token=<t>[&inline=1]` on the remote server
(`serveSentFile` in `remote-server.ts`; URL builder and parser in `shared/sent-file-url.ts`):

- **A third scoped token, `fileToken`** (32 random bytes), minted alongside the mockup token, delivered over the
  authenticated WS in `sync-full` and passed as a query parameter. The primary WS token is never placed in a URL;
  a URL-borne token stays low-privilege and independently revocable. Compared in constant time.
- **A path allowlist, not just validation.** The requested path must match an entry in that session's
  `sentFiles` (resolved against the session cwd, compared canonically by `matchSentFilePath`), taken from
  `SyncCore.getSnapshot()` in-process (ADR-051; the funnel-guard test asserts the route takes exactly one
  snapshot and never calls `executeJavaScript`). The path handed to the filesystem is the one derived from the
  snapshot, never the requester's string. `validateLocalFilePath` still applies on top, plus the Host allowlist
  and security headers. A key locked out by failed WS auth gets 429 here too, but failures on this route are
  not recorded against that budget (the token is 256-bit random and recording would let a LAN peer lock the
  operator out).
- **404 for everything that is not authenticated, allowlisted and readable**, so the route is not an existence
  oracle for host paths; only a token mismatch answers 403; methods other than GET/HEAD answer 405.
- **Response labelling**: correct Content-Type, `nosniff`, `Cache-Control: no-store`, `Content-Disposition:
attachment` unless `inline` was asked AND the file is an image (`sentFileDisposition`; model-authored HTML is
  never served inline from the remote origin, which would be same-origin script next to the WS token), and
  `Content-Security-Policy: default-src 'none'; sandbox` so a directly navigated SVG runs in an opaque origin.
- Files are downloadable only while their session (and its `sentFiles` state) exists. A compromised renderer
  gains nothing beyond files explicitly delivered or passing the local-file guard.

## What a tool returned is `TOOL_OUTPUT_SCOPE`; what it was given is not (ADR-075)

Find-in-chat (`chat/ChatSearch/`) walks the rendered DOM's text nodes (TreeWalker) and paints matches with the CSS
Custom Highlight API. The DOM does not say which text a tool returned and which it was given, so each renderer
declares it. The "Exclude tool output" toggle (setting `searchExcludeToolOutput`) skips tool OUTPUT only
(stdout, file contents, grep hits, subagent transcripts) and keeps headers and inputs searchable.

**Rule: an element that renders content a tool RETURNED spreads `TOOL_OUTPUT_SCOPE`
(`data-search-scope="tool-output"`, defined once in `ChatSearch/search-scope.ts`; never write the attribute as
a string literal).** Content the tool was GIVEN, the tool header and interaction cards are never marked. Mark
the outermost element that holds only output, usually the whole result section; the toggle skips any text node
with a marked ancestor. Ask where the text came from, not where it is drawn:

- Marked (returned): command stdout/stderr (live and background), file-read contents, grep/glob/search, web, MCP
  and generic results, the TaskCard result area, the subagent transcript and TaskCard usage stats, error text in
  ToolNoteRow and image/mockup bodies.
- Not marked (input or interaction): tool header (name, summary, chips), command, paths, JSON arguments, task
  prompt and description, edit diffs (even when "hide tool input" moves one into FileEditBody's result section),
  FileWrite `content` shown in the result slot, SendMessage's `message` in DetailBody's text slot, findings,
  diagrams, plan/question/todo/sleep cards.
- A slot that shows either kind is marked conditionally (DetailBody: `textIsOutput = text === result?.toolResult`;
  FileEditBody: the diff branch stays unmarked).

Other markers: `data-search="skip"` excludes a subtree regardless of the toggle (thinking blocks, the find bar and
indicator layer); `SEARCH_ANCHOR` (`data-search-anchor`) goes on each per-message `.cv-auto` wrapper, which the
engine binary-searches to pick the match nearest the viewport and pre-renders neighbours before a jump. A new
transcript host that wants viewport-relative navigation puts it on its per-message elements.

Consequences that look like bugs but are decided: **nothing enforces the rule at build time**, so a new renderer
that forgets the marker makes the toggle search that output with no error; when adding or changing one that
shows tool results, spread the marker and extend `ChatSearch/__tests__/tool-output-scope.component.test.tsx`.
Only mounted text is searchable: a collapsed tool card does not mount its body, so its output is not found
whatever the toggle says.

## Agent type is a letter tile in one shared palette (ADR-094)

One renderer, `AgentTypeTile` (`components/agents/`), serves every surface (the agent list `AgentRow`, the Task
card footer, Settings > Harnesses > <engine> > Agent colours); the pure logic (letters, palette, resolution) is
`shared/agent-type-colors.ts`, so the surfaces cannot disagree. It is a 16px rounded square, `title` and
`aria-label` carrying the full type name.

- **Every agent has a tile led by a small bot.** A typed agent is the bot plus its letters in the type's colour
  on a tint of it; the engine's default type (`DEFAULT_SUBAGENT_TYPE`: Claude `general-purpose`, pi
  `general-purpose`, opencode `general`) and an agent with no type is the bot alone, muted; a shell keeps its
  `$`. A new engine needs its default type there (a `Record<EngineId, string>`, a compile error until filled).
  A pi type that is a comma list (legacy parallel `subagent` call) is not one type and gets no letters.
- **Letters** (`agentTileLetter`): the initials of the type's segments (split on `-`, `_`, `:`, whitespace), at
  most two, uppercased, minus a first segment shared with another known type (`orch-reader` R, `orch-verifier`
  V, `orch-design-reviewer` DR, `Explore` E; alone in its family a type keeps its prefix, `migration-reviewer`
  MR). Known types are the engine's catalog plus the types the surface shows, so a letter does not change when a
  filter hides a sibling.
- **X for a cross-engine dispatch** (ADR-033): the bot and the letter X in one configurable colour (orange by
  default, setting `dispatchTileColor`, on the Cross-engine dispatch settings page), tooltip
  `Dispatch → <engine> · <model>`. It is detected by the structured field `dispatch?: { engine, model? }` on the
  task `ToolView`, which every engine's tool map sets through one helper, `dispatchTaskView`
  (`shared/tool-kinds.ts`). Nothing parses the old `"engine · model"` label, and a dispatch carries no
  `subagent`: that field is an agent TYPE.
- **One palette for every engine**: eight named colours (sky, violet, green, orange, rose, amber, teal, pink),
  each a theme token `--color-agent-<id>` in `assets/app.css`, defined for dark (Monokai inherits) and light.
  A palette and not free hex because a letter must hold 4.5:1 on a tint of its own colour on the surface it sits
  on, in both themes; a test pins that every id is defined in both. A colour then means the same on every
  harness.
- **Resolution order** for an (engine, type): the user's override (`AppSettings.agentTypeColors[engine][type]`,
  exact name else case-insensitive; absent from `DEFAULT_SETTINGS`, Reset deletes the key); else the engine's
  native colour mapped to the nearest palette colour; else a stable FNV-1a hash of the lowercased name. Claude's
  eight names map one-to-one (red rose, blue sky, green green, yellow amber, purple violet, orange orange, pink
  pink, cyan teal; a test pins the bijection, so every palette colour is reachable); a hex or opencode theme
  name goes to the palette colour nearest by hue; a grey or unreadable colour falls through to the hash.
- **Native colour sources**: Claude, the `color` frontmatter of `~/.claude/agents/*.md` and
  `<cwd>/.claude/agents/*.md`; opencode, the agent's `color`; pi has none. The host exposes the known types as
  the read-only query `config:list-agent-types (engine, cwd?)` (capability `config`, both transports). The
  renderer reads it once per (engine, cwd) and shares it; no polling.
- **Placements.** Agent list: the tile replaces the old text badge (`AgentRow.typeTile`); narrow (under 480px) it
  leads line 2, wide it sits where the badge was; the roster's type column is a fixed slot wide enough for the
  bot and two letters. Task card footer: a typed agent is a chip in the type's colour led by the tile (name
  wide, tile alone below 480px), the default type is the muted bot alone at every width; testids
  `TaskCard.type`, `TaskCard.typeTile`, `TaskCard.background`. A narrow row gives the name less room, never the
  tile. The bot is optically centred and letters are trimmed to cap height (`text-box`); a browser test pins it.
- **Settings.** An "Agent colours" group on each engine page lists the types the engine knows, each with tile,
  name, source (Built-in, User agent, Project agent), eight swatches and a Reset link when overridden; the
  default type is listed greyed. It works on the phone (swatches wrap to two rows of four). Both settings sync
  like any setting and carry no applies-later badge. The catalog follows the OPEN session's working directory,
  so with no session open only user-level and built-in types appear.
- Consequences: Claude's native colours never collide, opencode's hex colours can (the override is the escape
  hatch); `AgentRow.badge` is gone.

## The sidebar status dot ripples for activity and turns violet while only background tasks work (ADR-095)

The dot before each session (`Sidebar/StatusDot.tsx`, `deriveSessionDotState`; the agent roster's rows use the
same element and add a `failed` state, which no session derives, ADR-073) has seven states, first match wins:

1. `attention`: `needsAttention` and not the active session. Amber ripple.
2. `running`: `status.state === 'running'`. Green ripple.
3. `subagents`: a running background task (below). Violet ripple.
4. `idle`: `sdkActive`. Solid green.
5. `watching`: `isWatching` (an external CLI). Solid blue.
6. `inactive`: otherwise. Solid grey (`--color-dot-inactive`).
7. `failed`: roster only.

When the main agent and background tasks both work, the main agent wins and the tooltip appends
"· N background tasks running". Watched sessions never ripple violet (no lifecycle records reach us).

**A running subagent is a live `activeTasks` record that will wake the main agent** (`wakesParent`, stamped by
the emitter): `local_agent`, `remote_agent`, `in_process_teammate`, `local_workflow`, background shells
(`local_bash`), monitors, `mcp_task` and an X-Agent's `dispatch` run (ADR-105, dispatch.md), because a finished
shell starts an auto-continued turn just as an agent does. A dev server therefore keeps a session violet for
its life; that cost is accepted. The records, not the transcript, are the source: they are cleared on
disconnect (ADR-045), so a stale one cannot linger on a dead engine, and they cannot be fooled by a transcript
that lost its terminal events. A dispatched X-Agent outlives its parent's process, so `subagents` does not
require `sdkActive`: `countDotTasks` (`lib/task-types.ts`) counts every waking record with a live engine and
only the `dispatch` records for a disconnected or reopened parent (ADR-105 §5).

**`needsAttention`** is raised by a waiting approval (a re-raised one for a disconnected parent's X-Agent is
listed but raises nothing), by a turn that ended while you were not looking, and by an X-Agent result held for
a parent that is not live (`session:dispatch-result-held`, ADR-105 §3). A turn end raises it only when no
record that will wake the agent is live, no queued prompt is about to go out (unless a sign-in holds the queue)
and no hand-back wake is pending; an agent-started session is not flagged at birth.

**Look.** Every colour is a theme token holding 3:1 on the panel in dark, light and Monokai (running and idle
use `--color-success`; light overrides exist for violet and blue; `shared/__tests__/status-dot-contrast.test.ts`
pins them). The ripple is a 2s cycle: the dot dips, its glow blooms to a faint halo that stays between drops, and
one 2px ring leaves it and fades. Each dot starts at a random phase (`--dot-phase`) so a list does not ripple in
unison; `CYCLE_S` in `StatusDot.tsx` must match the `status-dot-*` animations in `app.css` (a unit test checks
it). The rules live in the shared `app.css`, which the web client also loads. Reduced motion shows the halo
steady and no ring.

Constraints that bind: animate only `transform` and `opacity` (the glow is a fixed blurred layer whose opacity
breathes; the ring is drawn at its final 13px size and scaled up), never `box-shadow` or `inset`, which repaint
on the main thread every frame. The ring and glow extend past the 14px dot slot: do not add `overflow: hidden`
to it. No class may be called `ring` (Tailwind's `ring` utility draws a 3px box-shadow and silently changes the
look). A missed terminal event leaves a record behind and the dot stays violet until the process disconnects; the
agent pill has the same exposure, and the remedy is the record's, not the dot's.
