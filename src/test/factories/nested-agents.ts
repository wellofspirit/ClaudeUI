/**
 * A depth-2 background agent, as ClaudeUI's store holds it. Shapes and ids are
 * from the S0 wire probe (`scripts/probe-nested-agents.mjs`, cli.js 2.1.280,
 * 2026-09-30; ADR-073 §7):
 *
 *   main   spawns agent A in the background
 *   A      spawns agent B in the background, runs a foreground Bash past 2 s
 *          (`sleep 4; echo fg`) and a run_in_background Bash (`sleep 8; echo bg`)
 *   B      runs a foreground Bash past 2 s (`sleep 5; echo done`)
 *
 * A's and B's calls live in the bucket of the agent that made them
 * (`subagentMessages[<that agent's origin id>]`), each tool_result appended to
 * the message holding its call. Every lifecycle record is keyed by the call's
 * own id; the foreground Bashes register `isBackgrounded: false` at depth 1
 * and 2 alike.
 */
import type { ActiveTask, ChatMessage, ContentBlock } from '../../shared/types'

export const A = 'toolu_0154emGrqXM4zdunsk8jurMs'
export const B = 'toolu_01Qgsza72xfqotM1PXQbVMoj'
export const A_FG_BASH = 'toolu_01WPZwzohpKYLZS1Qg6cZLhk'
export const A_BG_BASH = 'toolu_0111zu17CxKLxtxfR7bbYRSV'
export const B_FG_BASH = 'toolu_01MYcRi6RW6Br84UpALwZGBG'

const LAUNCHED =
  'Async agent launched successfully. (This tool result is internal metadata — never quote or paraphrase it.)'

function call(
  id: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  result?: string
): ChatMessage {
  const content: ContentBlock[] = [{ type: 'tool_use', toolUseId, toolName, toolInput }]
  if (result !== undefined) {
    content.push({ type: 'tool_result', toolUseId, toolResult: result, isError: false })
  }
  return { id, role: 'assistant', content, timestamp: 0 }
}

/** The main transcript: A's spawn, and its immediate "launched" result. */
export function nestedMessages(): ChatMessage[] {
  return [
    call('m-a', A, 'Agent', {
      name: 'probenesta',
      subagent_type: 'general-purpose',
      description: 'probe nested a',
      run_in_background: true,
      prompt: 'spawn B, then run two Bash commands'
    }),
    {
      id: 'm-a-result',
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: A, toolResult: LAUNCHED, isError: false }],
      timestamp: 0
    }
  ]
}

/** A's and B's own transcripts, keyed by their origin ids. */
export function nestedBuckets(): Record<string, ChatMessage[]> {
  return {
    [A]: [
      call(
        'a-1',
        B,
        'Agent',
        {
          name: 'probenestb',
          subagent_type: 'general-purpose',
          description: 'probe nested b',
          run_in_background: true,
          prompt: 'sleep 5; echo done'
        },
        LAUNCHED
      ),
      call('a-2', A_FG_BASH, 'Bash', { command: 'sleep 4; echo fg', run_in_background: false }),
      call(
        'a-3',
        A_BG_BASH,
        'Bash',
        { command: 'sleep 8; echo bg', run_in_background: true },
        'Command running in background with ID: bxfh7umpu. Output is being written to: /tmp/claude/proj/session/tasks/bxfh7umpu.output'
      )
    ],
    [B]: [
      call('b-1', B_FG_BASH, 'Bash', {
        command: 'sleep 5; echo done',
        description: 'Sleep for 5 seconds then echo done'
      })
    ]
  }
}

/** The live records at t≈13 s of the probe: both agents and all three Bashes running. */
export function nestedActiveTasks(): Record<string, ActiveTask> {
  return {
    [A]: {
      taskId: 'af110ad6ad039a313',
      taskType: 'local_agent',
      runIndex: 1,
      isBackgrounded: true
    },
    [B]: {
      taskId: 'ae1c808a813a4dcb5',
      taskType: 'local_agent',
      runIndex: 1,
      isBackgrounded: true
    },
    [A_BG_BASH]: { taskId: 'bxfh7umpu', taskType: 'local_bash', runIndex: 1, isBackgrounded: true },
    [A_FG_BASH]: {
      taskId: 'bd5rrczsg',
      taskType: 'local_bash',
      runIndex: 1,
      isBackgrounded: false
    },
    [B_FG_BASH]: { taskId: 'biwuaer1m', taskType: 'local_bash', runIndex: 1, isBackgrounded: false }
  }
}
