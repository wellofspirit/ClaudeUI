# ADR-048 — Mobile surface pattern: content-slot takeover, selection-as-navigation, keyboard-safe input placement

**Status:** Accepted (2026-08-04) — Decision 5 (terminal-on-mobile declined) **superseded by ADR-052**: remote terminal is now planned behind a desktop-side opt-in, capability grants, and passkey step-up (`docs/architecture/security.md`). The UI surface patterns here are unaffected.
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
  (156df4d) makes Android Chromium shrink the *layout* viewport under the keyboard, so
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
   that drives the *same* store action as the desktop panel's close. Panel state never
   forks between layouts. `plan` and `mockup` remain desktop-only and should adopt this
   same pattern when they get mobile surfaces.

3. **MobileGitView: two-screen drill-down, screen derived from selection.**
   Changes screen (FilterTabs + GitFileTree + bottom-pinned GitCommitBox) ⇄ Diff screen
   (prev/next over `filterAndSortFiles` order, stage/unstage, two-tap discard, full-height
   GitFileDiffView). There is deliberately **no local navigation state**:
   `gitSelectedFile === null` ⇒ list, non-null ⇒ diff, so GitFileTree's existing tap
   handler *is* the router and mobile/desktop can't disagree. Selection-as-navigation has
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
   `DirectoryBrowserInput` remains open and should start from the hook, not the widget.

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
