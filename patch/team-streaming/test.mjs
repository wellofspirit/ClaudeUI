#!/usr/bin/env node
/**
 * Patch test: team-streaming
 *
 * Verifies that teammate stream events, assistant messages, and task notifications
 * are forwarded to the SDK consumer.
 *
 * Patches:
 *   B1 — stream_event with teammate_id
 *   B2 — assistant with teammate_id
 *   C  — task_notification with task_id containing "@" (name@team format)
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT =
  "Create a team called 'simple-team' with one teammate named 'solver'. Tell the solver to answer: 'What is the capital of France?' Wait for the solver to finish, then delete the team and tell me the answer."

async function main() {
  const t = new TestRunner('team-streaming')

  console.log('  Starting SDK query (timeout: 180s)...')
  const { q, cleanup, ac } = createQuery(PROMPT, {}, 180_000)
  const messages = await collectMessages(q, { cleanup })

  dumpMessages(messages)

  // 1. stream_event with teammate_id field
  t.assertSome(
    'stream_event with teammate_id (patch B1)',
    messages,
    (m) => m.type === 'stream_event' && !!m.teammate_id
  )

  // 2. assistant with teammate_id field
  t.assertSome(
    'assistant with teammate_id (patch B2)',
    messages,
    (m) => m.type === 'assistant' && !!m.teammate_id
  )

  // 3. task_notification with task_id containing "@" (name@team format)
  t.assertSome(
    'task_notification with name@team task_id (patch C)',
    messages,
    (m) =>
      m.type === 'system' &&
      m.subtype === 'task_notification' &&
      typeof m.task_id === 'string' &&
      m.task_id.includes('@')
  )

  // 4. Session completed
  t.assertSome('Session completed (result message)', messages, (m) => m.type === 'result')

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
