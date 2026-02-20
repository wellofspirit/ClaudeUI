#!/usr/bin/env node
/**
 * Patch test: team-dowhile-fix
 *
 * Verifies that a team session completes without deadlocking.
 *
 * Without this patch, the do-while loop includes `in_process_teammate` agents
 * which prevents the inbox polling from running, causing the session to hang.
 *
 * We create a minimal team with one teammate and verify the session finishes
 * within the timeout (a deadlock would cause a timeout/abort).
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT =
  "Create a team called 'quick-test' with one teammate named 'helper'. Give the helper a simple task: respond with 'done'. After the helper finishes, delete the team."

async function main() {
  const t = new TestRunner('team-dowhile-fix')
  const TIMEOUT = 90_000

  console.log('  Starting SDK query (timeout: 90s)...')
  const { q, cleanup, ac } = createQuery(PROMPT, {}, TIMEOUT)

  const timedOut = { value: false }
  const onAbort = () => { timedOut.value = true }
  ac.signal.addEventListener('abort', onAbort)

  const messages = await collectMessages(q, { cleanup })

  dumpMessages(messages)

  // 1. Session completed (result message exists)
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  // 2. Did not time out
  t.assert('Did not time out (no deadlock)', !timedOut.value)

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
