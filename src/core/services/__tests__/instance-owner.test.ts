/**
 * @vitest-environment node
 *
 * Who owns a `running` X-Agent row (ADR-105 §5).
 */
import { describe, expect, it } from 'vitest'
import { currentInstanceOwner, ownerIsGone, pidIsAlive } from '../instance-owner'

const me = { pid: 100, boot: 'boot-me' }

describe('currentInstanceOwner', () => {
  it('is this process under one id per boot', () => {
    expect(currentInstanceOwner()).toEqual({ pid: process.pid, boot: expect.any(String) })
    expect(currentInstanceOwner()).toBe(currentInstanceOwner())
  })
})

describe('pidIsAlive', () => {
  it('is true for this process and false for a pid that cannot be a process', () => {
    expect(pidIsAlive(process.pid)).toBe(true)
    // 0 and negative pids would signal a group: they are never a probe.
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(pidIsAlive(pid)).toBe(false)
  })
})

describe('ownerIsGone', () => {
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

  it('a row with no owner is gone (written before the owner column)', () => {
    expect(ownerIsGone(null, me, alive([100, 200]))).toBe(true)
  })

  it('this boot owns its own rows', () => {
    expect(ownerIsGone({ pid: 100, boot: 'boot-me' }, me, alive([]))).toBe(false)
  })

  it('our pid under another boot id is a reused pid', () => {
    expect(ownerIsGone({ pid: 100, boot: 'an-earlier-boot' }, me, alive([100]))).toBe(true)
  })

  it('another instance is gone exactly when its pid is not running', () => {
    expect(ownerIsGone({ pid: 200, boot: 'boot-other' }, me, alive([200]))).toBe(false)
    expect(ownerIsGone({ pid: 200, boot: 'boot-other' }, me, alive([]))).toBe(true)
  })
})
