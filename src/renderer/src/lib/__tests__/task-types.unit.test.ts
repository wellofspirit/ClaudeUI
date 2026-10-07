import { describe, it, expect } from 'vitest'
import { countAutoContinuingTasks, hasAutoContinuingTask } from '../task-types'

const tasks = (...types: string[]): Record<string, { taskType: string }> =>
  Object.fromEntries(types.map((taskType, i) => [`tu-${i}`, { taskType }]))

describe('countAutoContinuingTasks', () => {
  it('counts every auto-continuing type', () => {
    expect(
      countAutoContinuingTasks(
        tasks('local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow')
      )
    ).toBe(4)
  })

  it('skips background shells and monitors', () => {
    expect(countAutoContinuingTasks(tasks('local_bash', 'monitor_mcp', 'monitor_ws'))).toBe(0)
    expect(countAutoContinuingTasks(tasks('local_bash', 'local_agent', 'local_agent'))).toBe(2)
  })

  it('is 0 for no tasks', () => {
    expect(countAutoContinuingTasks({})).toBe(0)
  })
})

describe('hasAutoContinuingTask', () => {
  it('agrees with the count', () => {
    expect(hasAutoContinuingTask(tasks('local_bash'))).toBe(false)
    expect(hasAutoContinuingTask(tasks('local_bash', 'in_process_teammate'))).toBe(true)
  })
})
