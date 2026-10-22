/**
 * @vitest-environment node
 *
 * Ending an X-Agent for good (ADR-105 §5), as far as its ledger row alone can do it: the
 * harness-side state an ended X-Agent leaves behind (opencode's session, pi's session
 * directory), and the boot sweep of X-Agents whose parent session no longer exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
// The sweep's default check reads ~/.claude; every test here injects its own.
vi.mock('../../../core/services/opencode-session-list', () => ({
  deleteOpencodeSession: vi.fn(async () => {})
}))

import {
  removeHarnessState,
  sweepOrphanDispatchTargets
} from '../../../core/services/dispatch-target-end'
import type { DispatchTargetRow } from '../../../core/services/dispatch-target-ledger'

const row = (over: Partial<DispatchTargetRow> = {}): DispatchTargetRow => ({
  id: 's-abc123',
  engine: 'pi',
  harnessRef: 'harness-1',
  parentSessionId: 'parent-1',
  parentEngine: 'claude',
  parentToolUseId: 'toolu_1',
  cwd: '/proj',
  parentCwd: '/proj',
  model: 'm',
  launchMode: 'default',
  accountKey: null,
  codexAccountId: null,
  callerRestriction: null,
  name: null,
  description: null,
  handBack: false,
  state: 'idle',
  createdAt: 1,
  lastActiveAt: 1,
  ...over
})

describe('removeHarnessState', () => {
  let home = ''
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-end-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const piDir = (id: string): string => path.join(home, '.claude', 'ui', 'dispatch', 'pi', id)

  it('removes a pi X-Agent’s session directory — that one and nothing beside it', async () => {
    for (const id of ['s-abc123', 's-other1']) {
      fs.mkdirSync(path.join(piDir(id), 'nested'), { recursive: true })
      fs.writeFileSync(path.join(piDir(id), 'session.jsonl'), '{}\n')
    }
    await removeHarnessState(row({ id: 's-abc123', engine: 'pi' }), { home })
    expect(fs.existsSync(piDir('s-abc123'))).toBe(false)
    expect(fs.existsSync(path.join(piDir('s-other1'), 'session.jsonl'))).toBe(true)
  })

  it('a directory that is already gone is not an error', async () => {
    await expect(removeHarnessState(row({ engine: 'pi' }), { home })).resolves.toBeUndefined()
  })

  it('deletes an opencode X-Agent’s session by its harness id', async () => {
    const del = vi.fn(async () => {})
    await removeHarnessState(row({ engine: 'opencode', harnessRef: 'ses_1' }), {
      deleteOpencodeSession: del
    })
    expect(del).toHaveBeenCalledWith('ses_1')
  })

  it('leaves a Claude transcript and a Codex thread alone', async () => {
    const del = vi.fn(async () => {})
    const rm = vi.fn(async () => {})
    for (const engine of ['claude', 'codex'] as const)
      await removeHarnessState(row({ engine }), { deleteOpencodeSession: del, removeDir: rm })
    expect(del).not.toHaveBeenCalled()
    expect(rm).not.toHaveBeenCalled()
  })

  it('never throws: a failing delete or a path that is not a ref only logs', async () => {
    const boom = vi.fn(async () => {
      throw new Error('server down')
    })
    await expect(
      removeHarnessState(row({ engine: 'opencode' }), { deleteOpencodeSession: boom })
    ).resolves.toBeUndefined()
    await expect(
      removeHarnessState(row({ id: '../../etc', engine: 'pi' }), { home })
    ).resolves.toBeUndefined()
    expect(fs.existsSync(home)).toBe(true)
  })
})

describe('sweepOrphanDispatchTargets', () => {
  function setup(rows: DispatchTargetRow[], gone: string[]) {
    const update = vi.fn()
    const removed = vi.fn(async () => {})
    // The boot sweep never deletes an opencode session itself: that would start a server.
    const immediate = vi.fn(async () => {})
    const deferred = vi.fn()
    const asked: string[][] = []
    const ended = sweepOrphanDispatchTargets({
      rows: () => rows,
      goneParents: (ids) => {
        asked.push(ids)
        return ids.filter((id) => gone.includes(id))
      },
      ledger: { update },
      deleteOpencodeSession: immediate,
      deferOpencodeDelete: deferred,
      removeDir: removed,
      now: () => 99
    })
    return { ended, update, removed, immediate, deferred, asked }
  }

  it('ends the X-Agents of a parent that is positively gone and leaves every other one alone', () => {
    const t = setup(
      [
        row({ id: 's-g00001', parentSessionId: 'gone' }),
        row({ id: 's-g00002', parentSessionId: 'gone', engine: 'opencode', harnessRef: 'ses_9' }),
        row({ id: 's-h00001', parentSessionId: 'here' })
      ],
      ['gone']
    )
    expect(t.ended).toBe(2)
    expect(t.update).toHaveBeenCalledTimes(2)
    expect(t.update).toHaveBeenCalledWith('s-g00001', { state: 'stopped', lastActiveAt: 99 })
    expect(t.update).toHaveBeenCalledWith('s-g00002', { state: 'stopped', lastActiveAt: 99 })
    expect(t.update).not.toHaveBeenCalledWith('s-h00001', expect.anything())
    // Their harness state goes too: pi's directory at once, opencode's session when a
    // server is up anyway — never by starting one at boot.
    expect(t.removed).toHaveBeenCalledTimes(1)
    expect(t.deferred).toHaveBeenCalledWith('ses_9')
    expect(t.deferred).toHaveBeenCalledTimes(1)
    expect(t.immediate).not.toHaveBeenCalled()
  })

  it('only a CLAUDE parent can be proven gone: another engine’s parent is never asked about', () => {
    const t = setup(
      [
        row({ id: 's-oc0001', parentSessionId: 'oc-parent', parentEngine: 'opencode' }),
        row({ id: 's-pi0001', parentSessionId: 'pi-parent', parentEngine: 'pi' }),
        row({ id: 's-cx0001', parentSessionId: 'cx-parent', parentEngine: 'codex' })
      ],
      ['oc-parent', 'pi-parent', 'cx-parent']
    )
    expect(t.ended).toBe(0)
    expect(t.update).not.toHaveBeenCalled()
    expect(t.asked).toEqual([]) // nothing to ask about
  })

  it('asks once per parent, and a parent it cannot classify (store unreadable) stays', () => {
    const t = setup(
      [
        row({ id: 's-a00001', parentSessionId: 'p' }),
        row({ id: 's-a00002', parentSessionId: 'p' })
      ],
      [] // the check proved nothing
    )
    expect(t.asked).toEqual([['p']])
    expect(t.ended).toBe(0)
    expect(t.update).not.toHaveBeenCalled()
  })

  it('keeps the harness state of a row it could not mark stopped, and never throws', () => {
    const removed = vi.fn(async () => {})
    const ended = sweepOrphanDispatchTargets({
      rows: () => [row({ id: 's-b00001', parentSessionId: 'gone', engine: 'opencode' })],
      goneParents: (ids) => ids,
      ledger: {
        update: () => {
          throw new Error('locked')
        }
      },
      deferOpencodeDelete: removed
    })
    expect(ended).toBe(0)
    expect(removed).not.toHaveBeenCalled()
    expect(
      sweepOrphanDispatchTargets({
        rows: () => {
          throw new Error('no ledger')
        }
      })
    ).toBe(0)
  })
})
