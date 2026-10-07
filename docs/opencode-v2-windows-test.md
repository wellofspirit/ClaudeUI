# opencode 2.x — Windows test pass (ADR-097 §8.2)

The `opencode-v2` branch moves ClaudeUI to opencode 2.x only. The macOS runs are done; this is the
Windows x64 pass ADR-097 §8.2 requires before release. It needs about 30 minutes. Run it in Git Bash
(or PowerShell where noted). Nothing here touches your real opencode data until step 4.

## 0. Keep 2.x out of the shared store

ClaudeUI builds share the managed store `~/.claude/ui/harnesses`. Until PR #61 is on the build you
normally run, a pre-release build with opencode on "Latest" would pick up a 2.x install there. So
this pass installs opencode 2.x into a store of its own:

```bash
export CLAUDEUI_HARNESS_STORE="$PWD/.cache/harness-store"
```

Export it in every shell you use below (PowerShell: `$env:CLAUDEUI_HARNESS_STORE = "$PWD\.cache\harness-store"`).

## 1. Build

```bash
git fetch origin && git checkout opencode-v2
bun install && bun run rebuild:native
bun run ensure-opencode        # installs the tested 2.x (src/shared/harness-manifests/opencode.json) into the store above
bun run typecheck && bun run lint
```

`ensure-opencode` must report `opencode <version> installed and verified (reviewed)`.

## 2. Unit and component tests

```bash
bun run test
```

Known Windows-only noise: none expected from this branch. `remote-*.test.ts` can flake under load;
rerun a failing file on its own before reporting it.

## 3. Contract suite against the real 2.x binary (isolated, no network)

Each test runs the real `opencode.exe` with its own temporary home, a localhost fake model and a
proxy that refuses all outbound traffic. Your real opencode data is not used. (macOS additionally
wraps the server in a loopback-only sandbox; on Windows the ChatGPT-mode case is skipped by design.)

```bash
OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode
OPENCODE_V2_INTEGRATION=1 bun run test:integration src/integration/opencode --maxWorkers=4
```

Both runs should be fully green (apart from the skipped ChatGPT case). Afterwards, Task Manager
should show no leftover `opencode.exe`.

## 4. Real app (your real profile and opencode data dir)

Start the dev build with the isolated store still exported:

```bash
bun run dev
```

Check, in this order:

1. **Settings → Harnesses → opencode** shows the 2.x tested version as "Tested". A 1.x `opencode`
   on your PATH shows as "from the 1.x line".
2. **New opencode session** in a scratch folder, model **opencode Zen → Nemotron 3.5 Flash
   Lightning** (free). Ask it to list the folder, then to create a file: the shell and edit tool
   cards render, the edit asks for approval in default mode, Allow lands the file.
3. **Deny** an edit with a message: the model gets the reason and the turn continues.
4. **Queue** two messages while a turn runs, remove one: only the other is delivered. **Steer** a
   message mid-turn. **Stop** with an approval pending: no error banner, the card disappears.
5. **Subagent**: ask it to use a subagent to read a file; the child streams under its card.
6. **Close and reopen** the session from the sidebar: the transcript is the same.
7. **Settings → opencode config**: change a model setting and save; edit an agent's permissions
   and save. Your `opencode.json` keeps its comments and hand edits.
8. **Quit** ClaudeUI: within a few seconds Task Manager shows no `opencode.exe` from ClaudeUI.

Report anything that differs, with the log from `~/.claude/ui/logs/<date>.log` (it contains no
tokens; credential errors are redacted).

## 5. Clean up

```bash
unset CLAUDEUI_HARNESS_STORE
rm -rf .cache/harness-store
```
