import { describe, it, expect } from 'vitest'
import type { TaskNotification } from '../../../../../shared/types'
import { deriveTaskState, latestNotification } from '../task-state'

function notif(
  toolUseId: string,
  status: TaskNotification['status'] = 'completed',
  summary = ''
): TaskNotification {
  return { taskId: 'a1', toolUseId, status, outputFile: '', summary }
}

describe('latestNotification', () => {
  it('returns the LAST notification for the id, not the first', () => {
    // The resume case (ADR-073): one agent, two runs, two terminal events.
    const list = [notif('toolu_A', 'completed', 'run 1'), notif('toolu_A', 'failed', 'run 2')]
    expect(latestNotification(list, 'toolu_A')?.summary).toBe('run 2')
    expect(latestNotification(list, 'toolu_A')?.status).toBe('failed')
  })

  it('ignores notifications belonging to other tasks', () => {
    const list = [notif('toolu_A', 'failed'), notif('toolu_B', 'completed')]
    expect(latestNotification(list, 'toolu_A')?.status).toBe('failed')
    expect(latestNotification(list, 'toolu_B')?.status).toBe('completed')
  })

  it('is undefined when the task has none', () => {
    expect(latestNotification([notif('toolu_B')], 'toolu_A')).toBeUndefined()
    expect(latestNotification([], 'toolu_A')).toBeUndefined()
  })

  it('matches find() for a single-run task', () => {
    const list = [notif('toolu_A', 'stopped')]
    expect(latestNotification(list, 'toolu_A')).toEqual(list.find((n) => n.toolUseId === 'toolu_A'))
  })
})

describe('deriveTaskState', () => {
  const base = { isHistorical: false, hasActiveTask: false, isBackground: false, hasResult: false }

  it('an active-task record means running, whatever the result says', () => {
    // 2.1.219+ async-launches Agent calls: run_in_background is absent and an
    // "Async agent launched successfully" tool_result arrives immediately.
    const s = deriveTaskState({ ...base, hasActiveTask: true, hasResult: true })
    expect(s.isRunning).toBe(true)
  })

  it('a background task runs until its notification arrives', () => {
    expect(deriveTaskState({ ...base, isBackground: true, hasResult: true }).isRunning).toBe(true)
    expect(
      deriveTaskState({ ...base, isBackground: true, hasResult: true, notification: notif('t') })
        .isRunning
    ).toBe(false)
  })

  it('a foreground task without a lifecycle record falls back to the result', () => {
    // The legacy heuristic, load-bearing for opencode / pi / Codex children.
    expect(deriveTaskState({ ...base }).isRunning).toBe(true)
    expect(deriveTaskState({ ...base, hasResult: true }).isRunning).toBe(false)
  })

  it('a terminal notification settles a foreground task too', () => {
    // ADR-040 calls the notification authoritative. A synchronous task that
    // notified may never post a tool_result, and used to read as running for
    // the rest of the session.
    expect(deriveTaskState({ ...base, notification: notif('t') }).isRunning).toBe(false)
  })

  it('an armed record outranks an earlier terminal event — the resume case', () => {
    // Run 1 notified, then run 2 started: the agent IS running again (ADR-073).
    const s = deriveTaskState({
      ...base,
      hasActiveTask: true,
      hasResult: true,
      notification: notif('t', 'completed')
    })
    expect(s.isRunning).toBe(true)
  })

  it('nothing in a historical transcript is running', () => {
    const s = deriveTaskState({ ...base, isHistorical: true, hasActiveTask: true })
    expect(s.isRunning).toBe(false)
  })

  it('marks an unfinished historical task as loaded, not running', () => {
    expect(deriveTaskState({ ...base, isHistorical: true }).isLoaded).toBe(true)
    expect(deriveTaskState({ ...base, isHistorical: true, hasResult: true }).isLoaded).toBe(false)
    expect(
      deriveTaskState({ ...base, isHistorical: true, notification: notif('t') }).isLoaded
    ).toBe(false)
    // A live task is never "loaded".
    expect(deriveTaskState({ ...base }).isLoaded).toBe(false)
  })

  it('takes isError from the notification when there is one', () => {
    expect(deriveTaskState({ ...base, notification: notif('t', 'failed') }).isError).toBe(true)
    expect(deriveTaskState({ ...base, notification: notif('t', 'stopped') }).isError).toBe(false)
    expect(deriveTaskState({ ...base, notification: notif('t', 'completed') }).isError).toBe(false)
  })

  it('falls back to the tool result error only when there is no notification', () => {
    expect(deriveTaskState({ ...base, resultIsError: true }).isError).toBe(true)
    // The notification wins: a failed run whose immediate "launched" result was
    // not an error is still an error. This is what the panel used to miss.
    expect(
      deriveTaskState({
        ...base,
        hasResult: true,
        resultIsError: false,
        notification: notif('t', 'failed')
      }).isError
    ).toBe(true)
  })

  it('defaults resultIsError to false', () => {
    expect(deriveTaskState({ ...base }).isError).toBe(false)
  })
})
