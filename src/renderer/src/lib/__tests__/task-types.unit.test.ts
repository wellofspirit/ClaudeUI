import { describe, it, expect } from 'vitest'
import { countDotTasks, countWakingTasks, hasWakingTask } from '../task-types'

const tasks = (...types: string[]): Record<string, { taskType: string; wakesParent?: boolean }> =>
  Object.fromEntries(types.map((taskType, i) => [`tu-${i}`, { taskType }]))

describe('countWakingTasks', () => {
  it('counts every legacy agent-like type when a record carries no wakesParent', () => {
    expect(
      countWakingTasks(
        tasks('local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow')
      )
    ).toBe(4)
  })

  it('skips shells and monitors on a record without wakesParent (older replays)', () => {
    expect(countWakingTasks(tasks('local_bash', 'monitor_mcp', 'monitor_ws'))).toBe(0)
    expect(countWakingTasks(tasks('local_bash', 'local_agent', 'local_agent'))).toBe(2)
  })

  it('lets wakesParent override the type either way', () => {
    expect(
      countWakingTasks({
        a: { taskType: 'local_bash', wakesParent: true },
        b: { taskType: 'monitor_ws', wakesParent: true },
        c: { taskType: 'local_agent', wakesParent: false },
        d: { taskType: 'dream', wakesParent: false }
      })
    ).toBe(2)
  })

  it('is 0 for no tasks', () => {
    expect(countWakingTasks({})).toBe(0)
  })
})

describe('hasWakingTask', () => {
  it('agrees with the count', () => {
    expect(hasWakingTask(tasks('local_bash'))).toBe(false)
    expect(hasWakingTask(tasks('local_bash', 'in_process_teammate'))).toBe(true)
    expect(hasWakingTask({ a: { taskType: 'local_bash', wakesParent: true } })).toBe(true)
    expect(hasWakingTask({ a: { taskType: 'local_agent', wakesParent: false } })).toBe(false)
  })
})

describe('countDotTasks', () => {
  const mixed = {
    agent: { taskType: 'local_agent', wakesParent: true },
    shell: { taskType: 'local_bash', wakesParent: true },
    xagent: { taskType: 'dispatch', wakesParent: true }
  }

  it('a live engine counts every waking task', () => {
    expect(countDotTasks(mixed, true)).toBe(3)
  })

  it('an engine that is not live counts only the dispatched X-Agents the dispatcher re-raised', () => {
    expect(countDotTasks(mixed, false)).toBe(1)
    expect(countDotTasks({ a: mixed.agent, b: mixed.shell }, false)).toBe(0)
  })

  it('a dispatch record that does not wake the parent is not counted', () => {
    expect(countDotTasks({ x: { taskType: 'dispatch', wakesParent: false } }, false)).toBe(0)
  })
})
