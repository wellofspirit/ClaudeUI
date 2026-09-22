/**
 * Node environment test setup — loaded by the git and integration test
 * projects. Minimal setup for non-DOM tests.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

/**
 * EVERY test run gets a throwaway home, before anything else in this file.
 *
 * `os.homedir()` reads `USERPROFILE` on Windows and `HOME` elsewhere AT CALL
 * TIME, so redirecting both here moves every `homedir()` in the process — and
 * with it every `~/.claude` path a service builds at import time. This is not
 * tidiness: on 2026-09-21 a suite ran `UsageFetcher`'s single-account path
 * against the developer's REAL home and appended a wrong-account record to
 * `~/.claude/ui/usage/account-log.jsonl`, which re-attributed 61 turns by time.
 * A test may not be able to reach the real home to get that wrong.
 *
 * Deliberately never cleaned up: a write that lands after teardown is exactly
 * what this exists to catch, and it can only be seen if the directory survives.
 */
const TEST_HOME = join(tmpdir(), `claudeui-test-home-${process.pid}`)
mkdirSync(TEST_HOME, { recursive: true })
process.env.USERPROFILE = TEST_HOME
process.env.HOME = TEST_HOME

// Redirect logger.ts's file output before anything in the test module graph
// can import it — otherwise every test run appends fixture noise to the real
// ~/.claude/ui/logs. `??=` lets an outer invocation still redirect explicitly.
process.env.CLAUDE_UI_LOG_DIR ??= join(tmpdir(), 'claudeui-vitest-logs')

// Install the SQLite driver for the test process (S3 stage 1). `db.ts` talks to
// a driver seam now and deliberately has no default, so every entrypoint —
// including this one — must name its engine.
//
// `betterSqlite3Driver` resolves through the long-standing `resolve.alias` to
// `src/test/stubs/better-sqlite3-stub.ts`, i.e. an in-memory `node:sqlite`. That
// is the SAME engine and the SAME isolation tests have always had, which is
// exactly the point: the seam must not change what the suite runs against.
import { setSqliteDriver } from '../../core/services/sqlite-driver'
import { betterSqlite3Driver } from '../../core/services/sqlite/better-sqlite3-driver'

setSqliteDriver(betterSqlite3Driver())
