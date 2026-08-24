import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { killProcessTree } from '../../../core/services/process-tree'

/**
 * A fake child with a settable pid and a kill() spy that records call ORDER
 * against the injected taskkill spawn (M-OC4 / M-PI3 — the whole point of the
 * fix is that taskkill runs and child.kill() does NOT pre-empt it).
 */
function makeFakeChild(pid: number | undefined): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> }
  ;(emitter as { pid?: number }).pid = pid
  emitter.kill = vi.fn(() => true) as unknown as ChildProcess['kill'] & ReturnType<typeof vi.fn>
  return emitter
}

/** A fake spawn returning an EventEmitter so `.on('error', …)` is wireable. */
function makeFakeSpawn(): {
  spawn: ReturnType<typeof vi.fn>
  child: EventEmitter
} {
  const child = new EventEmitter()
  const spawn = vi.fn(() => child)
  return { spawn: spawn as unknown as ReturnType<typeof vi.fn>, child }
}

describe('killProcessTree', () => {
  it('win32: spawns taskkill /T /F for the pid and does NOT call child.kill()', () => {
    const { spawn } = makeFakeSpawn()
    const child = makeFakeChild(4321)

    killProcessTree(child, { platform: 'win32', spawn: spawn as never })

    // taskkill reaps the LIVE tree…
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/pid', '4321', '/T', '/F'], {
      stdio: 'ignore'
    })
    // …and child.kill() never fires on the happy path (pre-fix it ran BEFORE
    // taskkill, orphaning the tree — this is the guard assertion).
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('win32 with no pid: falls back to child.kill() (cannot tree-kill)', () => {
    const { spawn } = makeFakeSpawn()
    const child = makeFakeChild(undefined)

    killProcessTree(child, { platform: 'win32', spawn: spawn as never })

    expect(spawn).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('win32: if taskkill fails to spawn, falls back to child.kill() so exit still fires', () => {
    const { spawn, child: taskkillProc } = makeFakeSpawn()
    const child = makeFakeChild(999)

    killProcessTree(child, { platform: 'win32', spawn: spawn as never })
    expect(child.kill).not.toHaveBeenCalled() // not yet — waiting on spawn outcome

    // Simulate ENOENT: taskkill's process emits 'error'.
    taskkillProc.emit('error', new Error('spawn taskkill ENOENT'))
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('non-win32: sends a single SIGTERM, never taskkill', () => {
    const { spawn } = makeFakeSpawn()
    const child = makeFakeChild(4321)

    killProcessTree(child, { platform: 'linux', spawn: spawn as never })

    expect(spawn).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
