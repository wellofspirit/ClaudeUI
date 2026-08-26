# ADR-048 — Mobile surface pattern: content-slot takeover, selection-as-navigation, keyboard-safe input placement

**Status:** Accepted (2026-08-04) — Decision 5 (terminal-on-mobile declined) **superseded by ADR-052**: remote terminal is now planned behind a desktop-side opt-in, capability grants, and passkey step-up (`docs/architecture/security.md`). The UI surface patterns here are unaffected. **Amended 2026-08-19** (§Amendment below): the mobile-parity arc landed Settings, Skills, MCP, the terminal, and the enroll/access-links surfaces on the phone; the amendment records the rulings that generalize this ADR's decisions.
**Relates to:** ADR-027 (test ids), ADR-046 (remote directory browser — Decision 3 partially fulfilled here), ADR-049 (bounds this pattern: transient modal chrome like the image viewer is a portalled overlay, not a content-slot takeover), the audit remediation's remote denylist posture

## Context

The mobile view (viewport ≤768px — in practice the remote web build on a phone, per the
ADR-039/-042 remote stack) historically exposed chat only: every right-side TopBar action
and every right panel except the task takeover (`MobileTaskView`) was `!isMobile`-gated.
Removing the fullscreen button in favor of the double-tap gesture (e70cdd6) freed the
top-right of the mobile bar, and the user asked for permissions management and a git view
on mobile (terminal was considered and dropped — see Decision 5).

Two platform constraints shape everything below:

- **Soft-keyboard viewport mechanics.** `interactive-widget=resizes-content`
  (156df4d) makes Android Chromium shrink the _layout_ viewport under the keyboard, so
  bottom-pinned flex footers and `fixed inset-0` overlays track the visible area. **iOS
  ignores the keyword**: the keyboard overlays the bottom of an unshrunk layout viewport,
  and only the browser's scroll-into-view keeps a focused input visible.
- **A phone fits one pane.** Desktop's side-by-side git panel (tree + diff + commit box)
  and the 680px permissions dialog with four mid-scroll add-rule inputs have no direct
  mobile translation.

## Decision

1. **Top-bar entry points (mobile): status pill + one overflow menu.** `GitChangesPill`
   renders on mobile (live ±line counts; it already toggles the git panel and self-hides
   outside a git repo) as the single one-tap, glanceable entry. Everything else lives
   behind a "⋯" overflow menu — an item array gated per item (Permissions requires `cwd`),
   hidden entirely when empty, with Skills/MCP as intended future entries. Rejected:
   a row of discrete icons (eats title space, doesn't scale) and menu-only (git status
   loses glanceability).

2. **Mobile right-panel surfaces are content-slot takeovers.** `MobileTaskView` set the
   pattern; `MobileGitView` follows it: when `isMobile && rightPanel === '<x>'`, the
   ChatPanel slot is replaced wholesale by a fullscreen component with a back-button header
   that drives the _same_ store action as the desktop panel's close. Panel state never
   forks between layouts. `plan` and `mockup` remain desktop-only and should adopt this
   same pattern when they get mobile surfaces.

3. **MobileGitView: two-screen drill-down, screen derived from selection.**
   Changes screen (FilterTabs + GitFileTree + bottom-pinned GitCommitBox) ⇄ Diff screen
   (prev/next over `filterAndSortFiles` order, stage/unstage, two-tap discard, full-height
   GitFileDiffView). There is deliberately **no local navigation state**:
   `gitSelectedFile === null` ⇒ list, non-null ⇒ diff, so GitFileTree's existing tap
   handler _is_ the router and mobile/desktop can't disagree. Selection-as-navigation has
   consequences that must hold for every future selection writer:
   - mount does NOT auto-select the first file (unlike GitPanel) and clears stale
     selections — mobile always lands on the list;
   - `GitCommitBox` grew `autoSelectNext` (default true; mobile passes false) because the
     desktop post-commit select-first-remaining behavior would teleport the list screen
     into an unrequested diff. Any new code that writes `gitSelectedFile` implicitly
     navigates the mobile view — treat it as a navigation API.

4. **Keyboard-safe input placement rule (applies to all future mobile UI).** A text input
   on mobile must be either (a) a **bottom-pinned flex footer** inside the
   viewport-sized layout — correct on Android via layout-viewport shrink, tolerable on iOS
   via scroll-into-view; the chat composer and GitCommitBox prove the pattern — or (b)
   **top-anchored in a fullscreen sheet**, which is safe on both platforms because the
   input can never be in the region the keyboard covers. **Never mid-scroll.** The
   permissions mobile UI is the reference implementation: an input-free browse layer
   (scope tabs, tap-to-edit rows, per-section ＋, pinned Save footer) plus an entry sheet
   with exactly one top-anchored input, template chips as a tap row, and tap-driven
   directory autocomplete (row tap descends, ✓ commits) replacing the desktop's
   Tab/arrow-key flow. The fork is presentation-only: the container (state, dirty
   tracking, persistence) is shared verbatim with desktop.

   The directory-suggestion mechanics were lifted out of `AddRuleInput` into
   `useDirSuggestions` (`PermissionsDialog/shared.ts`), now consumed by both the desktop
   input and the mobile sheet. This partially fulfills ADR-046 Decision 3's residual
   ("lift the shared helpers"): the hook is the shared core; unifying it with
   `DirectoryBrowserDialog` remains open and should start from the hook, not the widget.

5. **No terminal on mobile.** `terminal:*` stays on the RemoteDispatcher denylist. An
   opt-in unblock (desktop-side toggle, unreachable remotely since `remote:set-config` is
   itself denylisted) was designed and explicitly declined: driving an agent's Bash tool
   covers the need without reopening the audit's interactive-PTY exclusion. Revisiting
   this means revisiting that audit decision, not just UI work.

## Consequences

- Phones get permissions management and a full git review/commit flow; the top bar stays
  two-buttons-small and absorbs future entries without redesign.
- Desktop rendering is byte-identical everywhere (regression-locked in the TopBar,
  SessionView, and PermissionsDialog suites).
- The `gitSelectedFile`-as-navigation contract (Decision 3) is load-bearing and
  non-obvious; its guard tests live in the MobileGitView and GitCommitBox suites.
- iOS keeps `resizes-visual` behavior, so bottom-pinned inputs there rely on
  scroll-into-view; if that proves janky in device testing, the escape hatch is moving the
  commit box behind a top-anchored sheet like permissions (Decision 4b), not per-platform
  viewport hacks.

## Amendment — the mobile-parity arc (2026-08-19, as built)

Five series (`ecb2066`, `f900cfa`, `52c4cef`, `b058b7d`, with `ffd80ab` on the server
side) closed the gap this ADR's Context named. The owner-ratified rulings, recorded
because each generalizes a decision above:

1. **The presentation-fork rule is the pattern for every dialog.** `const View = isMobile
? MobileView : DesktopView` with the container (state, channels, mutations) shared
   verbatim — PermissionsDialog's shape, now carried by SettingsDialog, McpDialog,
   SkillsDialog and TerminalPanel. The desktop View files stay byte-identical; every fork
   carries a two-direction fork-guard test.

2. **Settings is scope TABS + horizontal SWIPE + accordions** (owner-picked over a
   drill-down stack and an adaptive squeeze): fullscreen takeover, four equal-width tabs
   with an underline, sections as lazily-mounted accordions reusing the section content
   unchanged, and search that goes WIDE (one flat hit list across all scopes — a phone
   user searching "sandbox" should not need to know it lives under Claude). The swipe
   detector (`useSwipeTabs`) is touch/pen-only, direction-locked with ties to vertical,
   pointerId-keyed (a second finger aborts), never calls `preventDefault`, and exempts
   controls and real horizontal scrollers. Mobile settings are HOSTED by SessionView
   (the drawer unmounts its children, so the panel inside it cannot both close the
   drawer and keep the dialog alive); each host drops its state on its wrong side of
   the 768px edge, so a breakpoint crossing can neither double-mount nor resurrect.

3. **Decision 1's ⋯ menu absorbed its intended entries — under a gate-parity rule.**
   Skills, MCP and Terminal entries carry character-for-character the gates their
   desktop buttons use, so the two surfaces can never disagree about a session's
   capabilities. The Terminal entry additionally inherits the menu's `cwd` precondition,
   deliberately: with no cwd the panel opens empty and its `+` spawns into the `'.'`
   fallback — an invisible orphan pty with no second entry point on a phone.

4. **Master/detail dialogs become list ⇄ detail drill-downs** (Decision 3 extended):
   selection IS the navigation (MCP derives it from the container's `selected`; a
   successful remove lands on the list because the container clears selection), mobile
   always lands on the list, destructive actions are two-tap with a 3s disarm on a
   STABLE testid + `data-armed` discriminator. Deliberate omissions are stated in the
   file headers (MCP Add Server: a six-field mid-scroll form with raw-JSON textareas is
   a feature, not chrome — Decision 4 forbids it).

5. **Decision 5's supersession is realized.** The terminal is a fullscreen takeover
   reusing TerminalPanel wholesale — availability, pool, read-only, step-up unchanged —
   plus an accessory key row (Esc/Tab/^C/arrows) that injects through xterm's own
   `input(data, true)` into the same `onData` closure that holds the ADR-054 read-only
   gate and is the renderer's only `terminal:write` caller: the keys cannot bypass
   step-up by construction. Mobile mounts only while open; the pty ring replays on
   re-attach, so nothing is lost.

6. **The enroll offer's dismissal latch is permanent — because it stopped being the only
   path.** The strip and the durable "Set up a passkey on this device" card (top of
   Settings › Remote on web) share ONE flow via a `window.__REMOTE_ENROLL__` bridge;
   the card never touches the latch. AccessLinks mounts on web with an HONEST status:
   only facts a browser holds (the LAN row asks via `authcfg:lan-link`; tailnet/tunnel
   rows are withheld, not guessed — a future remote status verb can make them real),
   and the locked LAN row carries a Reveal button — re-asking on the operator's own
   press, which is the line ADR-054 §6 draws against ambient ceremonies.

7. **Test-id ruling:** mobile forks carry DISTINCT roots (`SettingsMobileView`,
   `McpMobileView`, `SkillsMobileView`, `TerminalMobileView`) rather than
   PermissionsDialog's shared root — the fork-guard tests depend on telling the two
   presentations apart, and a verifier asserting the desktop id must not silently no-op
   on a phone. PermissionsDialog keeps its shared root as the grandfathered exception.

## Alternatives considered

- **Git as a segmented control (one screen)** — rejected: hides the commit box (invisible
  dirty state) while viewing diffs; auto-switching segments on file tap is jumpier than an
  explicit push.
- **Git as the desktop stacked single layout at phone width** — rejected: ~110px of diff,
  zero under the keyboard.
- **Permissions as a responsive pass on the desktop dialog** — rejected: keeps mid-scroll
  inputs (violates Decision 4), down-opening menus clip behind the keyboard, keyboard-only
  autocomplete stays broken on touch.
- **Permissions as a chat-style bottom composer** — workable but weaker: the upward stack
  (suggestions above chips above input) crowds a ~350px viewport and moves the target
  section into a tiny chip.
- **Terminal behind an opt-in remote unblock** — declined by the user (Decision 5).
