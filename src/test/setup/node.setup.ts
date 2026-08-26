/**
 * Node environment test setup — loaded by the git and integration test
 * projects. Minimal setup for non-DOM tests.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
