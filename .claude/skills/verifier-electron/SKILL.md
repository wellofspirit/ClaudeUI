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
`text=All Settings`; a settings page = `[data-testid="SettingsDialog.railSub"]:has-text("<page>")`
(its group may already be expanded — clicking the group header collapses it, so check first). For new selectors, run with `--keep` and inspect, or grep the
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
- **autoMode is read at session start and cached**: `judgeModel` / `twoStageMode`
  changes bind only a NEW session — create one per mode.

## Judge drives without a real provider (local stand-in)

Learned verifying judge-reply capture: a local OpenAI-compatible stand-in serves
both the agent and the judge, so a judge scenario (over-budget stage 1, stop cut
with trailing text, reasoning fields, 429/500, a hang) is scripted exactly and no
call leaves the machine.

- **Network first.** Before any engine spawns: `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`
  to a dead local port and `NO_PROXY=127.0.0.1,localhost` — the judge transport
  honours `NO_PROXY`, so without it the stand-in is unreachable too.
- **Register the stand-in** from the renderer:
  `window.api.saveSharedProvider({id, name, kind: 'custom', protocol:
'openai-completions' | 'openai-responses', baseUrl: 'http://127.0.0.1:<port>/v1',
models: [{id}], routes: {pi: {enabled: true}, opencode: {enabled: true}},
managed: true})`, then `window.api.setSharedProviderApiKey(id, key)`, then
  `sessionStore.getState().reloadEngineModels('opencode')` + `reloadModels()` and
  wait ~7 s (opencode's models arrive after pi's). The model value is
  `<providerId>/<modelId>`; point the judge at it through
  `loadEngineConfig(engine)` → `autoMode: {judgeModel, twoStageMode}` →
  `saveEngineConfig`. An `openai-responses` provider gives the Responses wire (the
  ChatGPT-like shape: client-side stop and budget).
- **Steer the agent without consent.** Map a token in the prompt (`[job:NAME]`) to a
  tool call the stand-in emits (`shell` / pi `bash`: `echo MARK_NAME > cap_NAME.txt`);
  a command typed verbatim would be consent. Pick the judge scenario from the LAST
  marker in the judge's user message — the transcript repeats earlier actions.
- **Check the session's model before every prompt** (`standin/<model>`); abort on a
  mismatch rather than let an engine fall back to a hosted model.
- **Tell the stages apart by the user message**: stage 1's instruction ("Grade HARM
  ONLY … `<severity>`") travels in the judge's user message, stage 2's asks for
  `<block>`. A stage-2 BLOCK is sampled twice (the confirmation sample), so a block
  scenario sees two stage-2 requests. `routes` needs both the `pi` and `opencode`
  keys, or `saveSharedProvider` throws.
- **Verdict lines need `CLAUDE_UI_LOG=info`** (with `CLAUDE_UI_LOG_DIR` on the scratch
  home): the `auto-mode allow|BLOCK (stage=…, s1=…, sev=…)` lines are info-level; the
  default `warn` log shows only the `stage=error` warnings. Slice the log as a Buffer
  when polling by byte offset (the lines carry em-dashes).
- **A Claude turn without credentials** (the "don't break Claude" check): point
  `CLAUDEUI_CLAUDE_CLI` at the main checkout's `vendor/claude-cli/bun-claude.exe` (a
  worktree has no `vendor/`), set `loadVendorConfig('anthropic')` → `endpoint:
{enabled, baseUrl, authToken}` → `saveVendorConfig` to a local `/v1/messages` SSE
  stand-in (answer `count_tokens` too; one short turn makes about six requests).
- **A worktree installed with `--ignore-scripts`** has `node_modules/electron` without
  `dist/`: launch the main checkout's `electron.exe` with the worktree as the app
  path, and check `process.versions.electron` matches the worktree's pin.
- **Baseline for "same as before" claims:** `git archive <base> | tar -x -C
<scratch>/base`, junction `node_modules`, build and launch it with its own home;
  unlink the junction afterwards (PowerShell `(Get-Item p -Force).Delete()`).
  A base extracted under the main checkout needs no junction: it resolves
  `node_modules` upward. Two instances (change and base) can share one stand-in on
  separate control ports; scope each run by the stand-in log's line offset.

## Multi-client and approval-card drives

Learned verifying cross-client approval dismiss and dispatch-target scope.

- **A second client** needs the remote server, but `scripts/lib/scroll-bench/launch.mjs`
  forces `CLAUDEUI_DISABLE_REMOTE=1`: write a launcher without it, and only with a
  FRESH isolated home (its empty remote config has no serve record, so Tailscale is
  never touched; hash `tailscale serve status` before and after). Then
  `window.api.setRemoteConfig({bindHost: '127.0.0.1'})`,
  `startRemoteServer({host: '127.0.0.1'})`, `setRemotePassword('<throwaway>')`, open
  `status.lanUrl` (`http://127.0.0.1:<port>/remote`) in Playwright Chromium and log in
  through `[data-testid="PasswordLogin.input"]` + Enter (policy `off` still wants a
  `#k=` token). The web client has no `__claudeuiVerifier`: assert by `data-testid`
  (`ApprovalButtons.allow|deny`, `ApprovalCardView.*`, `FloatingApproval`).
- **Tell a dismiss from a tool-result removal**: the reducer also drops a card when its
  tool result arrives, so gate a `sleep 10` command and read about 1.5 s after the
  click while the session is still `running`; read the desktop replica
  (`__claudeuiVerifier.canonical.sessions[id].pendingApprovals`, an object) as well as
  the DOM. An answered `AskUserQuestionBlock` stays in the transcript as a summary:
  count `pendingApprovals`, not the block.
- **Card flow**: new sessions start in `auto` (`changePermissionMode(id, 'default')`
  for cards); pi and Claude raise one card at a time, so two pending cards need two
  sessions; an opencode parent in `default` first shows its own dispatch card, and the
  target's `xeng:` card follows on the parent's routing id.
- **Dispatch-target evidence**: an opencode target's ruleset is in
  `<home>/.local/share/opencode/opencode.db` (copy with `-wal`/`-shm`), table
  `session_v2`, column `permission`, `title = 'xeng-dispatch'`; a Claude target's flags
  (`--add-dir`, `--settings`) from `Get-CimInstance Win32_Process` while its card is
  pending (filter on `vendor\claude-cli\bun-claude`, which excludes a packaged app).
  Name each fixture file uniquely (`VERIFY_<x>.txt`) to attribute judge calls; the
  action under review is the last command after the judge text's final "Proposed next
  action" block.
- **Codex without a provider**: copy the managed store's `codex/<version>` into the
  scratch store and RESTART the app (Codex is detected at boot), point it at a localhost
  fixture provider with a fixture key, and use a catalog model id (`gpt-5.5`). The
  sandbox the binary actually ran is in the rollout's `turn_context.sandbox_policy`
  (`<CODEX_HOME>/sessions/**/rollout-*.jsonl`); approval decisions in
  `<CODEX_HOME>/logs_2.sqlite` (`FileChangeRequestApproval … Accept|Decline`).
  `request_user_input` fires only in plan mode and Codex forces `isOther`, so only the
  missing-answer rejections are reachable live. An accepted `apply_patch` may stall
  against a fixture provider on Windows: interrupt the session after the decision.
- **pi's bash strips backslashes** (`cat D:\x` becomes `D:x`): use forward slashes in
  pi commands.

## Permission-ladder drives (pi, opencode)

Learned verifying pi path containment, judge-off and Agent/Task rules.

- **Session cwd in Windows form.** Pass `cygpath -m <dir>` to `createNewSession`: an MSYS
  path (`/c/Users/…`) fails as "Cannot use simple-git on a directory that does not exist"
  and then a misleading `spawn …\pi.exe ENOENT`.
- **Forcing a judge call.** Read-only commands (`echo`, `cat`) take the read-only fast
  path and an exact allow rule takes the ADR-085 allow-rule gate, so neither reaches the
  judge: use a mutating command (`touch VERIFY_x.txt`, a redirect) to count judge calls.
- **Judge on/off and rule files are read at session start**: `loadEngineConfig('pi')` →
  `autoMode.enabled` → `saveEngineConfig`, or the isolated home's `.claude/settings.json`;
  create a new session after each change.
- **pi re-keys its session id after the first turn**: re-read `activeSessionId` before an
  IPC call (`respondApproval` with the old id silently does nothing).
- **Stop visibility**: `TaskCard.stop`, `AgentRow.stop`, `TaskEntry.stop`; the roster
  opens (toggles) on `AgentPill`/`AgentTab`; `status.capabilities.backgroundTasks` is in
  the store. A long native task: have the stand-in's child prompt run `sleep N`.
- **Isolate the OS temp dir too** for pi drives: TEMP/TMP/TMPDIR in the launch env (assert
  `os.tmpdir()` in `app.evaluate` first). The scratchpad is
  `<TEMP>\claudeui\<cwd key>\<session-id>\scratchpad` (POSIX: `$TMPDIR/claudeui-<uid>/…`); pi's spawn args (`--session-id`,
  `--append-system-prompt`) show in `Get-CimInstance Win32_Process` (`Name -eq 'pi.exe'`;
  filter on your scratch path — the owner's own app has pi children too).
- **Pin proof**: pi's write/edit result echoes the path it used (`Successfully wrote to <abs>`),
  so write with an odd spelling (`@x`, `file:///…`, `/c/…`) and read the result text.
- **pi's default tool set** has no `grep`/`find`/`ls`, and plan mode hides `edit`/`write`:
  those ladder rows are reachable only in unit tests.
- **Historical pi session after a relaunch**: click its sidebar `[data-id]` first, then set
  engine and model before prompting. Delete: right-click `[data-id]` →
  `SessionItem.delete` → `DeleteConfirmModal.confirm`. A pi dispatch target resumes by
  `session_message` only with `dispatch.defaultModel` set in `engines/pi.json`.
- **Proving the gate touches no network path or device**: preload an fs-wrapping hook into the
  main process (`electron.launch` args `-r <hook.cjs>`) that logs calls whose path argument is
  UNC-shaped, `*.invalid`, `file://<host>` or has a DOS-device component; run a positive control
  (`app.evaluate` → `fs.existsSync(<scratch>\NUL)`) before trusting a zero, and attribute hits by
  stack (`GitService.getStatus` polls untracked files — put fixture links in `.git/info/exclude`).
  Use `.invalid` hostnames only. Write backslash-heavy test paths through the driver
  (`String.fromCharCode(92)`), not shell heredocs (they halve `\\`). Device-name and UNC links:
  `fs.symlinkSync(target, p, 'file'|'dir')` with an explicit type so the target is never statted.
- **Rules and the judge bind at session start**: rewrite the isolated settings, then open a NEW
  session. A cwd passed as a junction path stays logical (allow rules like `Edit(src/**)` match).
  A pi dispatch target needs a non-pi parent (opencode `claudeui_dispatch_agent`).
- **Pre-fix baseline** for a red proof: `git archive <sha> | tar -x -C <scratch>/base`, junction
  `node_modules`, build, launch with its own home.
- **Browser test project in a worktree** (the plain run fails with `NetworkError`): a
  scratch `vitest.browser-wt.config.ts` that imports the worktree's `vitest.config.ts` by
  `file:///` URL, maps `test.projects` with `root` set to the worktree, and gives the
  browser project `server.fs.allow: [<worktree>, <main>/node_modules]`; run
  `VITE_CONFIG_NATIVE_IGNORE_WARNING=true bunx vitest run --config <scratch> --project browser`.

## Subagent drives (opencode native subagents)

Learned verifying the opencode subagent parity arc (ADR-111).

- **Ports**: concurrent verifiers collide on fixed stand-in and driver ports; pick distinct ones per run.
- **The stand-in emits the subagent call** from a prompt token (`[spawn:agent|description|prompt|model|sessionID]`),
  so the user never types the payload. Hide judge markers from the spawn's OWN review by writing `MRK_` in the
  prompt and having the stand-in expand it to `MARK_` only inside the child's tool call. Key the judge on
  `body.model` (a dedicated judge model id), not on the prompt. The static read-only path never asks for
  `echo …`; use a redirect (`echo X > f.txt`) or `touch` to reach the judge. A judge HTTP 500 forces the human
  fallback card.
- **Evidence**: `__claudeuiVerifier.canonical().sessions[id].pendingApprovals[].agent.label` (child cards only),
  `TaskCard.reviewChip` / `ToolCard.reviewChip`, `TaskCard.expand` (instructions and result are collapsed). Save
  every judge request body: the merged child transcript is only visible there.
- **Allowlist**: `window.api.setProviderModelAllowlist('opencode', providerId, ids | null)`; it reaches new
  sessions only (a new pooled server), so open a fresh session after changing it. Effort warnings:
  `window.api.listAgentTypes('opencode', cwd)` (field `type`), and in Settings the opencode rail's "Agent colours"
  sub-page (`AgentColours.warning`), not Appearance → Agents.
- **Nesting**: opencode's built-in `general` and `explore` deny `subagent`, so a grandchild needs a custom agent
  that allows it plus `experimental.subagent_depth` ≥ 2 (the first child request may still offer `subagent`
  before ClaudeUI's child ruleset lands).
- **An opencode dispatch target needs a pi (or Claude/Codex) parent**: opencode's dispatch tool cannot target
  opencode. Copy the managed `pi/<version>` into the scratch store, restart, `reloadEngineModels('pi')`, and set
  BOTH engines' `autoMode.judgeModel`.
- **Backslashes are halved** on their way through the shell tool: a `\d` in a `sed` or `bash -c` argument arrives as
  `\d`. Put regexes in heredoc files (`<<'EOF'`) or `String.raw` node scripts.
- **Idle timeout**: `sessionStore.getState().updateSettings({sessionTimeoutMins: 0.5})` (the Settings minimum is
  5 min); it applies at a live session's next timer reset. The renderer keeps `status.state` `idle` after a
  disconnect: read the main log's `[OpencodeSession] Idle timeout — auto-disconnecting` and the sidebar dot
  `SessionItem.statusDot[data-state]` (`inactive`).
- **"Ready for input"**: stub `document.hasFocus = () => false` and spy on `window.Notification` (a stub class with
  `permission = 'granted'`); sanity-check with a plain no-subagent turn first.
- **Selectors**: `SessionItem.statusDot` (`data-state` running | subagents | idle | attention | inactive,
  `data-subagents`); the roster opens with `AgentTab`, rows are `AgentRow` (`.stop`, `.resumed`, `.metrics`,
  `.status[data-status]`); its filter defaults to Running and is sticky (`AgentRoster.filter.all` for finished
  rows); `TaskCard.stop|sendToBackground|background|resumed|openInPanel`; `TaskEntry.stop`; host notes
  `MessageBubble.hostLabel`; the composer's Stop `InputBox.cancel`. `sessions[id].activeTasks` records carry
  `runIndex`, `isBackgrounded`, `wakesParent`; ids rekey to `ses_…` after the first turn.
- **Project config from the session's cwd**: a project `opencode.json` with `"experimental": {"subagent_depth": 2}`
  and a custom agent (`"agent": {"nest": {"mode": "subagent", "permission": {"subagent": "allow"}}}`) gives depth 2;
  `"permission": {"subagent": "ask"}` is the only way a default-mode spawn raises a card. Claude-form allow rules go
  in `<cwd>/.claude/settings.local.json`; skills in `<cwd>/.opencode/skills/<name>/SKILL.md`.
- **Hash checks**: the owner's running app rewrites the real `opencode.db`; exclude it from before/after hashes.
- **Reopen**: quit through the driver, relaunch on the same home, click `SessionItem[data-id=…]` (expand its project
  row when it is not in Recent); the store holds no sessions until one is opened.

## Isolation, terminals and native modules

Learned verifying an Electron patch bump (node-pty + better-sqlite3 under a new build):

- **Isolated home.** `app-shot.mjs` passes `process.env` through and has no
  isolation flag. `scripts/lib/scroll-bench/launch.mjs` `launchApp({app, home,
extraEnv})` shims `os.homedir()` and strips credential-shaped env names; pass the
  rest in `extraEnv`: `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`,
  `XDG_DATA_HOME`/`XDG_CONFIG_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`,
  `CLAUDE_CONFIG_DIR` and `CLAUDEUI_HARNESS_STORE`, all on the throwaway folder, plus
  `--user-data-dir=<folder>/electron`. HOME alone is not isolation on Windows (the
  app resolves the profile from `USERPROFILE`). Prove it after the first launch: the
  scratch `.claude/ui` exists and the sidebar has no real sessions. In a clean home
  the log's `[SessionHistory] Failed to read projects directory` (ENOENT) and a
  missing optional engine are expected, not failures.
- **Engines in isolation.** Copy the needed versions from
  `~/.claude/ui/harnesses/<engine>/<version>` into a scratch store and point
  `CLAUDEUI_HARNESS_STORE` at it; never write to the real store.
- **Building without postinstall** (a worktree installed with `--ignore-scripts`):
  `bunx electron-vite build --logLevel warn` writes `out/`; the only symptom of the
  missing Claude Code binary is `[harness] bundled Claude Code not found`, harmless
  for opencode and pi drives.
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
  command runs; type a split literal: `echo ('e45-' + 'ok')` in PowerShell (the
  terminal's shell when pwsh is installed), `echo e45-^ok` in the cmd.exe fallback.
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
