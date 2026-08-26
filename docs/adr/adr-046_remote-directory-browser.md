# ADR-046 — Remote New-Session directory browser over `file:list-dir` (no native picker, no extra confinement)

**Status:** Accepted (2026-08-03)
**Relates to:** ADR-030 (capability honesty), ADR-039 (remote auth modes), ADR-027 (test ids)

## Context

The web (remote) client renders the same New Session welcome state as the desktop app, but
"Browse…" is backed by Electron's native `dialog.showOpenDialog` — impossible in a browser.
`session:pick-folder` is permanently denylisted on the remote dispatcher (asserted by
tests), and the web `api-adapter` stubbed `pickFolder()` to `null`, so on web the button was
a silent no-op (a capability-honesty violation in spirit: the control rendered but did
nothing). The only remote path into a new session was the known-directories dropdown; a
directory never used before was unreachable.

Meanwhile the backend half already existed: `file:list-dir` (`listDirEntries`) was
remote-registered years-in-repo-time ago with the literal comment "for folder browser on
web", returns `{entries, isRoot, resolvedPath}`, hides dotfiles and build/VCS noise, and
already powers two renderer directory-browsing widgets (PermissionsDialog's dir
autocomplete — which works over remote today — and the `@`-mention browser).

## Decision

1. **Web-only inline browser, native dialog untouched on desktop.** When
   `window.api.platform === 'web'`, the dropdown's browse row ("Browse path…") switches the
   panel to an inline `DirectoryBrowserInput` (new shared, presentational component:
   absolute-path input, host-backed listing via an injected `listDir`, `..` synthesis,
   keyboard navigation, explicit Start/Cancel). Confirm re-validates against the host —
   `listDir(path).resolvedPath` non-empty is the "directory exists on the HOST" signal —
   and routes into the same `startSession` flow as the known-directory rows.
2. **`file:list-dir` keeps its current (unconfined-beyond-dotfiles) posture.** No path
   containment was added. Rationale: the remote channel is gated by ADR-039 auth, and an
   authenticated remote client can already create a session with an arbitrary cwd and run
   full `git:*` mutations — a directory _listing_ is strictly weaker than what the token
   already grants. Dotfiles/noise stay hidden by the handler. If the remote trust model
   ever weakens (e.g. scoped/guest tokens), containment must be revisited HERE first —
   `path-containment.ts` (`isPathInside`) is the ready-made primitive.
3. **`DirectoryBrowserInput` is the reusable browse primitive** for other surfaces that
   need a host directory on web (AutomationConfig's cwd field, the first-run screen).
   PermissionsDialog's `AddRuleInput` keeps its private copy of the path mechanics for now;
   whoever touches it next should lift the shared helpers out of `DirectoryBrowserInput`.
   _(Partially done by ADR-048: the mechanics were extracted into `useDirSuggestions` in
   `PermissionsDialog/shared.ts`, shared by the desktop input and the mobile entry sheet.
   Unifying with `DirectoryBrowserInput` is still open — start from the hook.)_

## Consequences

- Remote users can start a session in any host directory, not just previously-used ones.
- The silent no-op Browse is gone on web; desktop behavior is byte-identical (regression
  tests lock both).
- Known residuals: AutomationConfig / first-run WelcomeScreen / sidebar double-click still
  have no web browse; `listDirEntries` hides dot-directories, so a dot-named project root
  must be typed rather than picked from the listing.
  _(2026-08-25 — three of those are closed. The sidebar's "New session" double-click no
  longer calls the null-resolving `pickFolder()` on web: it shows the welcome screen and
  bumps an ephemeral `welcomeBrowseToken`, which `WelcomeState` consumes by opening this
  browser. `listDirEntries('')` now answers with the host's home directory instead of
  throwing `readdir('')` into the empty shape, and `DirectoryBrowserInput` seeds itself
  from it once on mount — the widget used to open on an empty box that listed nothing
  until an absolute path was typed. AutomationConfig's cwd row adopts the component on
  web, which is decision 3 above. Still open: the first-run `WelcomeScreen` is native-only
  (it appears unrouted), and dot-directories remain hidden.)_

## Amendment — 2026-08-26: the inline browser becomes a places-rail dialog

`DirectoryBrowserInput` is replaced by `DirectoryBrowserDialog` (Option C of the picker
mockups). Same component contract — dumb/presentational, host listing injected, confirm
still re-validated through `listDir` — but rendered as a centered modal (`createPortal` to
`<body>`, `z-[200]`, backdrop/Esc/× all cancel) with two panes: a left rail of RECENT
project directories plus the host's PLACES, and a right browse pane holding the path input,
the entry list and a footer that previews the resolved path. The old widget grew inside a
288px dropdown, which is where the "unusable on a phone" reports came from. Rail clicks
NAVIGATE — they never confirm — so every path, typed or clicked, still goes through the host
before it can start a session. The rail is `hidden sm:flex`: on a narrow viewport the
typed-path flow is the whole dialog.

Both web browse surfaces now share it: `WelcomeState` (the dropdown's "Browse path…" row and
the sidebar's `welcomeBrowseToken`, which opens the dialog directly instead of opening the
dropdown into browse mode) and `AutomationConfig`'s Directory row, which additionally passes
`initialPath={cwd}` — closing the residual where its browse opened on the host's home instead
of the directory the automation already names. Desktop is unchanged: both surfaces keep the
native `pickFolder()` and never mount the dialog.

New channel `file:list-places` (`listPlaces` in `handlers-core.ts`), registered on both
transports under the **existing `fs-read` capability**, answering `{ home, hostname, drives }`
— the home path, the machine name for the dialog's "on <hostname>", and the reachable drive
roots (probed `A:`–`Z:` on win32, `['/']` elsewhere). No widening of the remote surface in
substance: that capability already lists any path by name, and these are strictly weaker
reads. Best-effort by construction — a field the host cannot determine comes back empty and
the rail hides that entry rather than failing.

## Alternatives considered

- **Free-text cwd input only** (the old api-adapter comment's suggestion): rejected —
  typo-prone on mobile, no discoverability, no host validation until failure.
- **Un-denylist `session:pick-folder` remotely**: nonsensical — the dialog would open on
  the host's screen, not the client's.
- **Confine `file:list-dir` to known project roots**: rejected for now (see Decision 2) —
  it would also break the legitimate "browse to a brand-new directory" case this feature
  exists for.
