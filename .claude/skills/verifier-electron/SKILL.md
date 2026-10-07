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
fresh clone lacks it: `bun add -d playwright`.

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

## Caveats — what you can't (safely) drive

- **New session** needs the native OS folder picker (`dialog.showOpenDialog`),
  which Playwright can't drive. Reach existing sessions via the sidebar instead.
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
