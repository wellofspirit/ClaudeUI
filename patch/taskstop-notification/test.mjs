#!/usr/bin/env node
/**
 * Patch test: taskstop-notification
 *
 * Verifies that stopping a background task produces a task_notification
 * with status 'stopped' (Part B of the patch).
 *
 * Strategy:
 *   1. Ask Claude to launch a background task running `sleep 300`
 *   2. When task_started arrives, wait 2s then call q.stopTask(taskId)
 *   3. When task_notification with matching task_id arrives, close the query
 *   4. Assert task_started + task_notification with status 'stopped'
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = "Use the Task tool to run 'sleep 300' in Bash. Set run_in_background to true."

async function main() {
  const t = new TestRunner('taskstop-notification')

  console.log('  Starting SDK query...')
  const { q, cleanup, ac } = createQuery(PROMPT, {}, 120_000)

  let startedTaskId = null
  let notificationReceived = false

  const messages = await collectMessages(q, {
    cleanup,
    onMessage: (msg) => {
      // Detect task_started
      if (
        msg.type === 'system' &&
        msg.subtype === 'task_started' &&
        msg.task_id &&
        !startedTaskId
      ) {
        startedTaskId = msg.task_id
        console.log(`  task_started: task_id=${startedTaskId}`)

        // Wait a bit, then stop the task
        setTimeout(async () => {
          console.log(`  Stopping task ${startedTaskId}...`)
          try {
            await q.stopTask(startedTaskId)
          } catch (err) {
            console.error('  stopTask error:', err.message || err)
          }
        }, 2000)
      }

      // Detect task_notification for the stopped task
      if (
        msg.type === 'system' &&
        msg.subtype === 'task_notification' &&
        msg.task_id === startedTaskId &&
        !notificationReceived
      ) {
        notificationReceived = true
        console.log(`  task_notification: task_id=${msg.task_id} status=${msg.status}`)

        // We got what we need — close the query
        setTimeout(() => q.close(), 500)
      }
    },
  })

  dumpMessages(messages)

  // 1. task_started received
  t.assertSome(
    'task_started received',
    messages,
    (m) => m.type === 'system' && m.subtype === 'task_started' && !!m.task_id
  )

  // 2. task_notification with status 'stopped'
  t.assertSome(
    "task_notification with status 'stopped'",
    messages,
    (m) =>
      m.type === 'system' &&
      m.subtype === 'task_notification' &&
      m.status === 'stopped'
  )

  // 3. task_id matches between started and notification
  const startedIds = messages
    .filter((m) => m.type === 'system' && m.subtype === 'task_started')
    .map((m) => m.task_id)
  const notifIds = messages
    .filter((m) => m.type === 'system' && m.subtype === 'task_notification')
    .map((m) => m.task_id)
  const idsMatch = startedIds.length > 0 && notifIds.some((id) => startedIds.includes(id))
  t.assert('task_id matches between task_started and task_notification', idsMatch)

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
