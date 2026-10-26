# ADR-113: The test suite runs on `vmForks`, with a per-file home and process guards

**Status:** Accepted (2026-10-26). Implemented on branch `test/suite-audit`.
**Amends:** [ADR-026](adr-026_development-workflow.md) (the commit gate no longer retries a failed test run).
**Relates to:** [ADR-027](adr-027_test-data-attributes.md) (structural assertions), ADR-082 §8 (the managed harness store
the real-binary tests read).

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
   - Only these reasons qualify: a native addon (node-pty), a process-global module hook (`module.registerHooks`), or
     a wall-clock CPU-budget assertion. A file is never listed because it is slow or flaky.
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
   - **Retention.** Run directories older than 7 days are pruned at config load. Nothing is cleaned per file, so a
     write after teardown stays visible.
4. **Process reset and guards** (`process-reset.ts`). A vm context does not isolate the process, so:
   - **Restore.** The environment, the cwd and `exit` listeners are restored at the start of every file, from a
     snapshot kept on `process` (a module-scope snapshot would be retaken in every context). `VITEST*` keys are left
     alone.
   - **Leak guard.** Under the vm pools, a file fails when it leaves more `uncaughtException` or `unhandledRejection`
     listeners, or more `FSEventWrap`, `StatWatcher`, `TCPServerWrap` or `ProcessWrap` handles, than it started with.
     A leaked error listener would otherwise silence Vitest's unhandled-error reporting for the rest of the worker.
   - **Native addons.** Under the vm pools, `process.dlopen` throws and names the file to add to `FORKS_ONLY`.
   - **Not guarded:** built-in module state, and the filesystem outside the per-file home.
5. **The gate.** `scripts/gates.sh` no longer retries a failed test run. Its "failed run, zero failed tests"
   signature also matches an unhandled error, which is how a cross-file leak appears under `vmForks`.
6. **CI.** Pull requests run the tests on Linux (3 shards, browser project included), macOS and Windows (one job
   each, every project except `browser`).

## Consequences

- **Speed.** The default suite takes about 33 s and `scripts/gates.sh --full` about 42 s on the reference host, down
  from 112 s and 147 s.
- **Isolation.** A test file still gets fresh module state and globals. Process-level state is shared within a
  worker; the guards above make a leak fail the file that caused it, not a later one.
- **No `instanceof` across realms.** Code that tests `instanceof Error` on an error created by Node itself (e.g.
  `AbortSignal.timeout()`) fails under a vm context; compare `name` instead.
- **Native addons.** A test that loads one must be listed in `FORKS_ONLY`; the `dlopen` guard says so.
- **Shared-state tests in one file.** Tests that depend on the order within their file were fixed alongside this
  change (fresh state per test). Pinning an order is not an acceptable fix.
- **Temp space.** Test homes collect under `<tmpdir>/claudeui-test-home/` for a week. The flat
  `claudeui-test-home-<pid>` directories of the old layout are not touched by the pruning.
