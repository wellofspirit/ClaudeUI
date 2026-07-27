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
