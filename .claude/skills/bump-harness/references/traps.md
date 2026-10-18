# Traps past bumps fell into

Each of these cost a session hours, most of them more than once.

## Processes, files and Windows

- **Never kill by image name.** `taskkill /IM bun-claude.exe` also kills the agent session running
  you, and every other ClaudeUI session. Kill only PIDs you spawned.
- **A running binary cannot be deleted or overwritten on Windows** (EPERM / EBUSY), but it can be
  renamed. `ensure-cli` moves a held `bun-claude.exe` aside into `vendor/.claude-cli-trash/`; if a
  build still fails on a lock, find the holder (dev app, patch suite, verifier) rather than retrying.
- **Agent shells set `NoDefaultCurrentDirectoryInExePath`**, which breaks node-pty's native rebuild
  (`'GetCommitHash.bat' is not recognized`). `postinstall` unsets it for that step; anything else
  that rebuilds natives needs `env -u NoDefaultCurrentDirectoryInExePath`.
- **Python on Windows prints cp1252**: set `PYTHONIOENCODING=utf-8` (or write to a file with
  `encoding='utf-8'`), and open files with `newline=''` to keep LF endings.
- **`subprocess.run(..., shell=True)` goes through cmd.exe**, not bash: a guard run once reported
  "0 failing" because vitest never started. Use an argument list and check the output has a test
  count.
- **Shell quoting**: heredocs and `node -e` mangle backslashes and newlines; backticks in
  `git commit -m` are command-substituted. Write probe scripts and commit messages to files.

## Unattended runs

- **Any delete can stall a run on a permission prompt** — plain `rm` too, not just `rm -rf`. One
  stalled 6 h 20 m, another 7 h. When nobody is watching, delete nothing: use fresh file names, or
  Read a file before overwriting it with Write.
- A sub-agent waiting on a prompt never sends a completion notice. If one has been silent far longer
  than its task should take, check on it.

## Gates that lie

- **Never pipe a gate into `grep`/`tail`/`head` before `&& git commit`** — the pipeline's exit code
  is the filter's. Commits landed on red gates four times this way. Use `scripts/gates.sh`, or run
  the gate, then read its saved output.
- **Skipped is not passed.** Integration suites skip without their env flag
  (`OPENCODE_V2_INTEGRATION`, `PI_INTEGRATION_TESTS`, `CODEX_INTEGRATION`,
  `CLAUDE_INTEGRATION_TESTS`), when HOME is redirected away from a credential, or when the engine is
  not in the managed store. Read the skip count.
- **An expired default login looks like a patch break**: every live test fails at its first "used
  the tool" check. See `claude-code.md` §Behavioural suites.
- **A patch can apply cleanly and still be wrong**: it bound a minified name that changed meaning,
  matched the wrong call site, or became dead code whose test passes vacuously. The boot probe
  catches crashes; only the behavioural suite and a real-app drive catch the rest.
- **Tests pass for the wrong reason**: a subagent test passed on the official binary because the
  model chose to background the agent. Check the assertion would fail without the patch.
- **15,000 green tests missed a regression the real-app verifier caught** (composer labels leaking
  model taglines after a Claude Code bump). The verifier drive is not optional.

## Process

- **One worktree per bump.** Three sessions once shared a dirty checkout; another switched branches
  in the main checkout while a second session used it.
- **ADR numbers collide** across branches: check every remote branch for the next free number
  before using it.
- **Decisions waiting on the owner go stale**: re-check upstream before implementing.
- **Report a settled design decision as a bug** and the owner has to re-explain it. Check the ADRs
  and handoff docs first.
- **Don't over-escalate**: an expired login, a locked file or a missing env flag is something to
  fix, not a decision to put to the owner.
