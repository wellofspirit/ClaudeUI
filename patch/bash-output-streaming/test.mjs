/**
 * Behavioral test for the bash-output-streaming patch.
 *
 * Verifies that running a Bash command produces `bash_output` messages
 * in the SDK stream with real-time output data.
 *
 * Usage: node patch/bash-output-streaming/test.mjs
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const runner = new TestRunner('bash-output-streaming')

const { q, cleanup } = createQuery(
  'Run this exact bash command: for i in $(seq 1 20); do echo "line-$i"; sleep 0.2; done\nDo NOT explain anything, just run the command.',
  { effort: 'low' }
)

const bashOutputMessages = []
let usedBashTool = false
let sessionCompleted = false

const messages = await collectMessages(q, {
  onMessage(msg) {
    if (msg.type === 'bash_output') {
      bashOutputMessages.push(msg)
      if (bashOutputMessages.length === 1) {
        console.log(
          `  First bash_output received (tool_use_id=${msg.tool_use_id?.slice(0, 20)}...)`
        )
      }
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const b of msg.message.content) {
        if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell')) {
          usedBashTool = true
          console.log(`  Bash tool_use detected: ${b.input?.command?.slice(0, 60)}...`)
        }
      }
    }
    if (msg.type === 'result') {
      sessionCompleted = true
    }
  },
  cleanup
})

dumpMessages(messages)

// Assertions
runner.assert('Parent used Bash tool', usedBashTool)
runner.assert('bash_output messages received', bashOutputMessages.length > 0)

if (bashOutputMessages.length > 0) {
  const first = bashOutputMessages[0]
  runner.assert(
    'bash_output has tool_use_id',
    typeof first.tool_use_id === 'string' && first.tool_use_id.length > 0
  )
  runner.assert('bash_output has output field', typeof first.output === 'string')
  runner.assert('bash_output has total_lines', typeof first.total_lines === 'number')
  runner.assert('bash_output has total_bytes', typeof first.total_bytes === 'number')

  // Check that at least one message contains actual output text
  const hasContent = bashOutputMessages.some((m) => m.output && m.output.length > 0)
  runner.assert('At least one bash_output has non-empty output', hasContent)

  // Check that we got output containing our expected text
  const hasExpectedOutput = bashOutputMessages.some(
    (m) =>
      (m.output && m.output.includes('line-')) || (m.full_output && m.full_output.includes('line-'))
  )
  runner.assert('Output contains expected "line-" text', hasExpectedOutput)

  console.log(`  Total bash_output messages: ${bashOutputMessages.length}`)
  console.log(
    `  Last output preview: ${bashOutputMessages[bashOutputMessages.length - 1]?.output?.slice(-80)}`
  )
} else {
  // Skip field checks if no messages received
  runner.assert('bash_output has tool_use_id', false)
  runner.assert('bash_output has output field', false)
  runner.assert('bash_output has total_lines', false)
  runner.assert('bash_output has total_bytes', false)
  runner.assert('At least one bash_output has non-empty output', false)
  runner.assert('Output contains expected "line-" text', false)
}

runner.assert('Session completed (result message)', sessionCompleted)

const allPassed = runner.summarize()
process.exit(allPassed ? 0 : 1)
