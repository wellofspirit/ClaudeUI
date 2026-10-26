# ADR-113: The test suite runs on `vmForks`, with a per-file home and process guards

**Status:** Accepted (2026-10-26). Implemented on branch `test/suite-audit`.
**Relates to:** [ADR-026](adr-026_development-workflow.md) (the commit gate), [ADR-027](adr-027_test-data-attributes.md)
(structural assertions), ADR-082 §8 (the managed harness store the real-binary tests read).

## Context

The default suite (`bun run test`: about 1,000 files and 23,700 tests in the unit, unit-node, component, e2e and browser
projects) took 112 s on a 32-thread Windows host. Most of that was not test code:

- **One child process per file.** The `forks` pool with per-file isolation spawns a Node child for every test file.
- **The spawns are serialized.** Vitest's main process starts them one at a time, at about 80 ms each on Windows.
  64 empty test files took about 5.3 s whether the run had 4, 8, 16 or 31 workers.
- **So the suite had a floor of about 75 s** before any test ran, and more workers no longer helped.

The candidate pools, measured on the same host, with the same files:

| pool             | per test file                            | full suite            |
| ---------------- | ---------------------------------------- | --------------------- |
| `forks` (before) | a new process                            | 112 s                 |
| `threads`        | a new worker thread (a fresh V8 isolate) | 68 s, 8 files failing |
| `vmThreads`      | a new vm context in reused threads       | 45 s, 8 files failing |
| `vmForks`        | a new vm context in reused processes     | 33–37 s, all green    |

Two other options were measured and rejected:

- **Sharing workers across files (`isolate: false`).** Files failed depending on the order they ran in, because
  module state leaked between them.
- **Bun.** Vitest 5 cannot start its workers on the Bun runtime. `bun test` lacks `vi.hoisted`,
  `vi.advanceTimersByTimeAsync`, `vi.waitFor` and `it.runIf`, has no per-file isolation, and hung on the unit-node
  files.

### The home directory

The setup files moved the home directory by writing `process.env.USERPROFILE` and `process.env.HOME`. That only works
in a process the test owns.

- **Worker threads.** `process.env` is a per-thread copy, while `os.homedir()` reads the process's real environment.
  So under the thread pools every test resolved the developer's real home. An experiment wrote fixture files into the
  real `~/.claude/ui` that way.
- **`vmForks`.** One process runs many files, so a home named by process id is shared by every file in the worker.

## Decision

1. **Pools.**
   - `unit`, `unit-node`, `component` and `e2e` run on `vmForks`. Each sets `vmMemoryLimit` to half of V8's heap
     limit; the default (total memory ÷ workers) is above that limit, so workers would never be recycled.
   - `git`, `integration` and `browser` are unchanged.
   - No thread pool is used.
2. **Opt-out.**
   - A `unit-forks` project runs the files listed in `FORKS_ONLY` (`vitest.config.ts`) on plain `forks`, one process
     per file.
   - Only these reasons qualify: a native addon (node-pty; the real better-sqlite3 in `sqlite-driver.test.ts`), a
     process-global module hook (`module.registerHooks`), or a wall-clock CPU-budget assertion. A file is never listed
     because it is slow or flaky.
   - The config throws at load if an entry is not an existing unit-node test file.
3. **HOME in two layers.**
   - **Main process.** `vitest.config.ts` moves the process home to `<tmpdir>/claudeui-test-home/<runId>/main` before
     any worker exists, so threads, children and plugin code cannot resolve the real home.
   - **Real paths captured first.** Before the move, it stores the real home once in `CLAUDEUI_REAL_HOME` (a config
     re-evaluated in the same process keeps it). From that it derives the real harness store and, on macOS and Linux,
     `PLAYWRIGHT_BROWSERS_PATH`.
   - **Per file.** `src/test/setup/process-reset.ts`, the first import of both setup files, gives every test file its
     own home at `<runId>/<pid>-<seq>`.
   - **Tripwire.** That file refuses to run unless `os.homedir()` is that path.
   - **Path overrides.** The same step deletes the variables that move a directory the code would derive from the
     home (`CODEX_HOME`, the `XDG_*_HOME` four, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_TEST_HOME`,
     `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR`, `CLAUDE_SECURESTORAGE_CONFIG_DIR`, `CLAUDE_UI_LOG_DIR`,
     `CLAUDEUI_HARNESS_STORE`); workers inherit the cleaned environment. The `integration` project re-adds the store.
     `os.userInfo().homedir` is not redirected.
   - **Retention.** Run directories older than 7 days are pruned at config load. Nothing is cleaned per file, so a
     write after teardown stays visible. The root is created `0700`, and the prune is skipped when the root is a
     symlink or junction or, on POSIX, owned by another user (a shared `/tmp`).
4. **Process reset and guards** (`process-reset.ts`). A vm context does not isolate the process, so:
   - **Restore.** The environment, the cwd and `exit` listeners are restored at the start of every file, from a
     snapshot kept on `process` (a module-scope snapshot would be retaken in every context). `VITEST*` keys are left
     alone.
   - **Leak guard.** Under the vm pools, a file fails when its `uncaughtException` or `unhandledRejection` listener
     count differs from the start (a leaked listener, or Vitest's own removed), or it leaves more `FSEventWrap`,
     `StatWatcher`, `TCPServerWrap` or `ProcessWrap` handles than it started with (the wait for a closing handle is
     bounded by 1 s of wall time). A missing error listener would otherwise silence Vitest's unhandled-error
     reporting for the rest of the worker.
   - **Native addons.** Under the vm pools, `process.dlopen` throws and names the file to add to `FORKS_ONLY`. The
     attempt is also recorded, so a file that catches the throw (to skip when an addon will not load) still fails in
     the setup's `afterAll`.
   - **`instanceof Error`.** Under the vm pools, the context's `Error[Symbol.hasInstance]` also accepts
     `util.types.isNativeError(v)`, so errors thrown by Node's own modules (`fs`, `fetch`, `AbortSignal`) are
     `instanceof Error` as in production. Only the base class: see the consequence below.
   - **Not guarded:** built-in module state, and the filesystem outside the per-file home.
5. **The gate.** `scripts/gates.sh` runs typecheck, lint and the whole default suite, and never retries a failed
   test run: a "failed run, zero failed tests" signature also matches an unhandled error, which is how a cross-file
   leak appears under `vmForks`.
6. **CI.** Pull requests run the tests on Linux, macOS and Windows, 3 shards each, every project except `browser`;
   the `browser` project runs once, on Linux, in its own job inside Playwright's container image. On Linux and macOS CI the suite uses every core of the runner.

## Consequences

- **Speed.** The default suite takes about 30 s and `scripts/gates.sh` about 40 s on the reference host, down
  from 112 s and 147 s.
- **Isolation.** A test file still gets fresh module state and globals. Process-level state is shared within a
  worker; the guards above make a leak fail the file that caused it, not a later one.
- **Realm fidelity.** Objects created by Node itself come from the host realm, which a vm context does not share.
  The `Error` base class is patched back (decision 4), so production's `instanceof Error` branches run as in the app.
  Subclass checks (`instanceof TypeError` on an `fs` or `fetch` error) and other host-realm objects still differ. This
  is a fidelity cost of `vmForks`, not a rule for production code: a test that depends on such a check belongs in
  `FORKS_ONLY`.
- **Native addons.** A test that loads one must be listed in `FORKS_ONLY`; the `dlopen` guard says so, even when the
  test swallows the error.
- **Developer git config.** The moved HOME hides the developer's global git config from every `git` a test spawns and
  from `vitest --changed`.
- **Shared-state tests in one file.** Tests that depend on the order within their file were fixed alongside this
  change (fresh state per test). Pinning an order is not an acceptable fix.
- **Temp space.** Test homes collect under `<tmpdir>/claudeui-test-home/` for a week. The flat
  `claudeui-test-home-<pid>` directories of the old layout are not touched by the pruning.
