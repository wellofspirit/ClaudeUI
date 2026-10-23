---
name: verifier-electron
description: Verify ClaudeUI UI/runtime changes by launching the REAL Electron app, screenshotting it, asserting on the live DOM, and driving clicks. Use when verifying a renderer/UX change, confirming a feature works in the actual app (not just jsdom tests), or capturing a screenshot of current UI state. This is the repo's evidence-capture protocol for the GUI surface — the /verify skill auto-discovers it.
---

# verifier-electron

The surface for a ClaudeUI renderer change is **pixels in the running Electron
window**, not a jsdom test. The renderer talks to the main process through the
preload `window.api` bridge, so a plain headless browser can't run it — you need
the real app. This skill launches it under Playwright's Electron driver, takes
screenshots, asserts on the live DOM, and drives clicks.

Tests (`bun run test`) and the screenshot harness are complementary: tests prove
logic in jsdom; this proves the assembled app renders and behaves. Run tests for
logic, run this for "does it actually look/work right."

## Why Playwright `_electron` (and not X)

- **Headless browser** → no `window.api` (preload only exists in Electron). Dead end.
- **Playwright Python** → no `_electron` binding. JS only.
- **Spectron** → deprecated.
- **Manual screenshot injection** → hacky, not driveable.

Playwright's `_electron` launches the project's own Electron against the built
`out/main`, exposes the window as a normal Playwright `Page` (click/type/screenshot/
locators), and there is **no `requestSingleInstanceLock`** in `src/main/`, so it
coexists with an already-running app.

## Prereq

```
bun run build        # produces out/main/index.js + out/renderer/index.html
```

The harness launches the **built** app (not dev). `playwright` is a devDep; if a
fresh clone lacks it, ask the orchestrator to install dependencies — never add it yourself.

## Primitive: `scripts/app-shot.mjs`

Run from the project root:

```
node scripts/app-shot.mjs [--out <png>] [--needle <text>] [--settle <ms>]
                          [--click <selector>]...   # repeatable, clicked in order
                          [--wait <ms>] [--eval <js>]  # ordered with --click/--press/--type
                          [--state]                  # print renderer state after the shot
                          [--timeout <ms>]           # watchdog, default 60000
                          [--keep]                   # leave the app open (implies --headed)
                          [--with-remote]            # don't suppress remote access
                          [--headed]                 # show the window on-screen
                          [--profile <name>]         # emulate a device (see "Mobile profile")
                          [--font-scale <n>]         # uiFontScale, in memory only
                          [--overflow-audit]         # print OVERFLOW [...] after the shot
```

It launches the app, waits for the first window + `--settle` ms (default 3000) so
React mounts and first IPC settles, performs each `--click` in order, screenshots
to `--out` (default `.cache/screenshots/app.png`), then prints JSON:

```json
{
  "ok": true,
  "screenshot": "...",
  "headless": true,
  "windowTitle": "ClaudeUI",
  "needle": "Codex",
  "needleVisibleInDom": 0,
  "needleInRawHtml": 0,
  "consoleErrors": []
}
```

- `needleVisibleInDom` / `needleInRawHtml` — count a string in the live UI
  (`--needle`). **Interpret carefully:** a hit can be user _data_ (session titles,
  chat text) rather than UI chrome. Always Read the PNG to disambiguate — text
  counts are a tripwire, the screenshot is the verdict.
- `consoleErrors` — renderer console errors + pageerrors. Non-empty is a finding.
- **Read the PNG** (it's a real image — open it) as your primary evidence.

`.cache/` is gitignored, so screenshots don't pollute the tree.

**Remote access is suppressed by default.** The harness launches the app with
`CLAUDEUI_DISABLE_REMOTE=1`, so the instance it starts never reconciles the
`tailscale serve` record, never autostarts the remote listener, and never tears
either down on quit. Those are _machine-global_ (a pinned TCP port + the host's
serve config), not per-instance: without the suppression a second instance
treats the primary app's live serve record as a leaked leftover and removes it,
races it for the port, and disables `tailscale serve` on exit — i.e. it kills
the user's remote access. Pass `--with-remote` to opt out (only when you must
verify remote-listener UI live, and only with no other instance running). The
app honours the `--disable-remote` CLI switch as well as the env var; with it
set, `remote:start` and `remote:force-reserve` reject.

**The app runs "headless" by default.** The harness launches it with
`CLAUDEUI_HEADLESS=1` (the app also honours a `--claudeui-headless` CLI switch),
which shows the window _inactive_, positioned beyond the virtual desktop, with
no taskbar entry — so a verifier run never steals your focus, covers your
screen, or leaves a stray taskbar button. Screenshots, `capturePage`, and clicks
all still work because the window is genuinely shown and keeps painting
(`--disable-backgrounding-occluded-windows`); a _hidden_ window produces no
compositor frames at all and hangs `screenshot()`. Pass `--headed` to opt out
and get a normal visible window; `--keep` implies `--headed`, since an
invisible, taskbar-less instance left running is impossible to close by hand.

## Reading renderer state (`--eval`, `--state`, `--wait`)

The DOM tells you what rendered; it can't tell you whether the store had the data
at all. For the class of bug where those differ — a turn whose assistant messages
never appear, but core's canonical state has them — the harness launches the app
with `CLAUDEUI_VERIFIER_HOOKS=1`, which makes the renderer publish
`window.__claudeuiVerifier`: the live Zustand store, the replica's canonical
state, and a `snapshot()` summary of both. The app publishes **nothing** without
that opt-in (`src/shared/verifier-hooks.ts`); it is a harness affordance, never a
user's app.

- `--state` — after the shot, prints one line `STATE <json>`:

  ```
  STATE {"activeSessionId":"abc","sessions":[{"id":"abc","messageCount":12,"roles":{"user":6,"assistant":6},"state":"idle"}],"canonical":{"activeSessionId":"abc","sessions":[{"id":"abc","messageCount":12}]}}
  ```

  Read it as a three-way comparison on the **message counts**. `canonical` is the
  authority the store projects from: **canonical ahead of the store** = the
  projection dropped it; **store and canonical agree but the DOM doesn't** = the
  component dropped it. The two `activeSessionId`s are allowed to differ —
  selection is resolved client-locally (ADR-041), so canonical holds what the last
  hydration decided, not what you just clicked. Don't chase that one.
  `STATE null` means the hook wasn't there (a stale `out/`, or an app this
  harness didn't launch) — rebuild before reading anything into it.

- `--eval '<expr>'` — evaluates the expression in the renderer and prints
  `EVAL <json>`. Repeatable, ordered with the other steps, so you can probe
  before and after a click:
  `--eval 'window.__claudeuiVerifier.sessionStore.getState().activeSessionId'`.
  Anything not JSON-serialisable comes back `null` — summarise inside the
  expression rather than dumping objects.
- `--wait <ms>` — a pause as its own ordered step, for a transition that outlasts
  the 1.2 s each action already waits. It counts against the watchdog, so raise
  `--timeout` alongside it.

## Mobile profile (`--profile`, `--font-scale`, `--overflow-audit`)

Any change that is visible on mobile is verified here, not only in a desktop-sized window: the phone layout
is a different component tree (`useIsMobile` is `window.innerWidth < 768`) under a different `zoom`.

- `--profile <name>` emulates a device from `scripts/lib/mobile-profiles.mjs`, the single copy of the numbers
  that the vitest `browser` project asserts at too. `s25-ultra-edge` is the owner's phone: Samsung S25 Ultra,
  Edge on Android, 412 x 728 CSS px, touch. It applies `Emulation.setDeviceMetricsOverride` /
  `setTouchEmulationEnabled` / `setUserAgentOverride` over a CDP session on the window (falling back to
  `webContents.enableDeviceEmulation`), then waits for `window.innerWidth < 768`. It prints
  `PROFILE <name> via cdp 412x728`.
- `--font-scale <n>` (1 to 1.5) sets `settings.uiFontScale` for this run only, through
  `window.__claudeuiVerifier.sessionStore.setState`. It never calls `updateSettings` (that persists), and the
  original value is put back before the app closes, so the owner's settings file is never changed. It prints
  `FONT_SCALE <n> (was <original>, restored on exit)`.
- `--overflow-audit` prints one line `OVERFLOW [...]` after the shot. An entry is any visible element whose
  rect leaves the viewport horizontally (`kind: "viewport"`), or whose `scrollWidth` exceeds its `clientWidth`
  while its `overflow-x` is `visible` or `hidden` (`kind: "scrollWidth"`); `auto`/`scroll` boxes,
  `text-overflow: ellipsis` truncation and `mask-image` fades are ignored. Each entry carries the nearest
  `data-testid`, the tag, the rect `[left, top, right, bottom]` and the overflow in px. `OVERFLOW []` is clean.

The rule: verify a mobile-visible change with `--profile s25-ultra-edge` at `--font-scale` 1 and 1.1, and also
1.5 for layout-dense surfaces (rosters, cards, headers, sheets), with `--overflow-audit` clean on each:

```
node scripts/app-shot.mjs --profile s25-ultra-edge --font-scale 1.1 --overflow-audit   --out .cache/screenshots/mobile-1.1.png
```

Assert the structure (`--assert-testid`, `--eval`) before reading the PNG, as everywhere else.

## Driving the UI

`--click` takes Playwright selectors: `text=All Settings`, `[title="Settings"]`,
CSS, `role=button[name="..."]`. Chain them to reach a view:

```
# Welcome screen (no session): no Codex provider toggle should appear
node scripts/app-shot.mjs --out .cache/screenshots/welcome.png

# Full Settings dialog nav (gear → All Settings)
node scripts/app-shot.mjs --click '[title="Settings"]' --click 'text=All Settings' \
  --out .cache/screenshots/settings.png
```

Known selectors: settings gear = `[title="Settings"]`; quick-panel → full dialog =
`text=All Settings`. For new selectors, run with `--keep` and inspect, or grep the
renderer source for `title=`/`aria-label`/button text.

## Driving a full session turn (only with the owner's OK for a live turn)

`app-shot.mjs` is single-shot: one screenshot after a fixed wait. A judged turn
takes 5–15 s and needs evidence per prompt, so write a small purpose-built
driver that reuses its launch contract (`CLAUDEUI_DISABLE_REMOTE=1`,
`CLAUDEUI_HEADLESS=1`, `CLAUDEUI_VERIFIER_HOOKS=1`). Learned on a live auto-mode
judge run:

- **New session without the folder picker.** The welcome dropdown ends in
  `useSessionStore.createNewSession(routingId, cwd)`; call it through
  `window.__claudeuiVerifier.sessionStore`, then the composer pickers' own store
  actions `setSelectedEngine`, `setSelectedModel` and
  `changePermissionMode(id, 'auto')`. Type into `InputBox.textarea`, send with Enter.
- **pi rekeys the session id on its first spawn.** The id you passed becomes pi's
  own (`01a1…`) after the first turn; poll `getState().activeSessionId` after each
  send, and after a relaunch read the sidebar row's `SessionItem[data-id]`.
- **Verdict lines.** `CLAUDE_UI_LOG_DIR` (read at module load) redirects the
  main-process daily log (`YYYYMMDD.log`) into your report folder; the judge
  writes `auto-mode allow (stage=…[, sev=…][, overturned=block]) <tool>` /
  `auto-mode block …` under `[PiSession]` / `[OpencodeSession]`.
- **Review chips are ephemeral.** `ToolCard.reviewChip` / `ToolCard.review`
  (expand with `ToolCard.expand`) render in the launch that judged the call and
  are gone after a relaunch — capture them in the same launch.
- **The agent may refuse before calling a tool**, which yields no verdict at all:
  check for a `tool_use` block before calling a missing verdict a failure.
- **A command the user types verbatim is consent** (Requested Exact Action): it
  cannot test a should-block path. A block check needs an action the user did not
  name.
- **pi's model picker lists only authenticated pi providers**
  (`availableModels` filtered by `engineId === 'pi'`); the judge model is
  `window.api.loadEngineConfig('pi').autoMode.judgeModel`.
- `[harness] detection (boot): … pi none` reports PATH detection only; the managed
  store's pi still spawns.

## Isolation, terminals and native modules

Learned verifying an Electron patch bump (node-pty + better-sqlite3 under a new build):

- **Isolated home.** `app-shot.mjs` passes `process.env` through and has no
  isolation flag: on Windows set `APPDATA`, `LOCALAPPDATA`, `USERPROFILE` and `HOME`
  to a throwaway folder before launching (a custom driver also passes
  `--user-data-dir=<folder>/electron`). In a clean home the log's
  `[SessionHistory] Failed to read projects directory` (ENOENT) and a missing
  optional engine are expected, not failures.
- **The first screen is `WelcomeState`** (not `WelcomeScreen`, which also exists in
  the source).
- **Terminal.** The panel is closed by default: `TerminalPanel.newTab` is in the DOM
  but hidden. Create a session first (store recipe above), then click
  `TopBar.terminal`, which opens slot 0 in the session's cwd. With no session the `+`
  button spawns a shell at `'.'` that the panel never shows (0×0 xterm). Type into
  xterm's own textarea; read output from `.xterm-rows` of the instance whose
  `getBoundingClientRect().height > 0` (every tab keeps a hidden instance).
- **Main-process output.** `app-shot.mjs` reports renderer `consoleErrors` only; for
  crash evidence attach to `app.process().stdout/stderr` in a custom driver.
- **Native modules from the running app.** Inside `app.evaluate`, load the module with
  `createRequire(root + '/package.json')(root + '/node_modules/better-sqlite3')` and
  open the app's own `~/.claude/ui/operational.db` (created at boot in the isolated
  home) read-only: `PRAGMA integrity_check` and `user_version` prove the ABI and the
  migration chain. node-pty's `conpty_console_list_agent` may print `AttachConsole
failed` at teardown with a terminal open; that is shutdown noise.
- **Pin the Electron you launch.** A driver script outside the worktree (e.g. under
  `.work/`) resolves `playwright`, and Playwright then launches the MAIN checkout's
  `electron`: a bump verifier once got a green boot on the old major. Resolve Playwright
  with `createRequire(<worktree>/package.json)`, pass
  `executablePath: <worktree>/node_modules/electron/dist/electron.exe`, and assert
  `process.versions.electron` / `modules` from the main process before anything else.
- **`app.evaluate` has no `require`.** Use `process.mainModule.require(...)` (and
  `process.mainModule.require('node:module').createRequire(...)`); dynamic `import()`
  fails there too.
- **Which native binary loaded.** node-pty loads `build/Release/*.node` (the
  `rebuild:native` output) before its prebuilds; better-sqlite3 loads
  `prebuilds/<platform>.node`. `require.cache` shows the asar virtual path in a
  packaged app; the main process's module list (`Get-Process -Id <pid> |
Select-Object -ExpandProperty Modules`, with a terminal open so node-pty is loaded)
  shows the real `app.asar.unpacked` path.
- **Terminal needle.** The typed line echoes too, so `echo e45-ok` matches before the
  command runs; type a split literal like `echo ('e45-' + 'ok')`.
- **Packaged app.** `executablePath: dist/win-unpacked/claudui.exe`, `args: []`, the
  isolated-home variables plus `CLAUDEUI_ALLOW_MULTIPLE_INSTANCES=1` (the packaged build
  enforces the single-instance lock) and `CLAUDE_UI_LOG_DIR=<report folder>`.
- **ASAR reads.** Run the packaged `claudui.exe` with `ELECTRON_RUN_AS_NODE=1` on a
  script outside the asar that `fs.createReadStream`s (`highWaterMark: 1024`) every file
  under `resources/app.asar/out/renderer/assets/` and compares sha256 with
  `out/renderer/assets/`.
- **Plugin view.** A fixture plugin goes in `<home>/.claude/ui/plugins/<id>/`
  (`docs/plugin-development.md`). Reach the guest from the main process with
  `webContents.getAllWebContents().find((w) => w.getType() === 'webview')`;
  `getLastWebPreferences().sandbox` is true for the guest. `pluginApi.invoke` round
  trips; `ctx.emit` events reach only the main window, not the guest (a known gap).
- **Mockup preview.** Put `index.html` in
  `<session cwd>/.claude/ui/mockups/<8-hex-id>/`, call the store's
  `openMockupPanel(activeSessionId, '<id>', title)`, assert
  `iframe[src^="mockup-asset://"]` and read it through Playwright's `win.frames()`.
- **Voice worker.** `ready` needs the ~700 MB speech pack. Without it, run the launcher's
  command shape (`ELECTRON_RUN_AS_NODE=1`, `CLAUDEUI_VOICE_TOKEN` set, stdin kept open)
  and expect the worker's own `{"type":"fatal","message":"could not load the speech model…"}`.
- **Log viewer.** `window.api.openLogViewer()` arrives as a Playwright `window` event;
  its rows are `.log-entry`.

## Caveats — what you can't (safely) drive

- **New session** through the UI needs the native OS folder picker
  (`dialog.showOpenDialog`), which Playwright can't drive — reach existing sessions via
  the sidebar, or create one through the store (see "Driving a full session turn").
- **A live Claude turn** (prompt → response → approval → thinking → MCP) spends the
  user's API quota **and writes to real `~/.claude` transcripts**. Don't drive it
  live without explicit OK, or first isolate config (point the app at a throwaway
  `HOME`/config dir). For most UI changes the boot log (`Service session spawned`)
  - the e2e suite already cover the chat pipeline.

## Report

Follow the `/verify` report format: Verdict (PASS/FAIL/BLOCKED/SKIP), Claim,
Method, Steps (each a thing you did to the running app + what you saw; mark
off-happy-path probes 🔍), the key screenshot, and Findings. The screenshot and
the JSON are your evidence — paste/Read them, don't paraphrase.

```

```
