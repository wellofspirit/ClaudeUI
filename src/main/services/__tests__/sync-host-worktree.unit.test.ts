/**
 * @vitest-environment node
 *
 * The funnel observer that turns `EnterWorktree` / `ExitWorktree` tool results into the
 * session's `worktreeInfoMap` entry (slice 3a/3b), driven through the real funnel: canonical
 * state, the reducer and `emitEvent`, with only the config file mocked.
 *
 * What it pins end to end: a curly-quoted cli.js 2.1.308 result records the entry, the entry
 * SURVIVES the next `session:status` (whose cwd is the spawn cwd, equal to `originalCwd`), a
 * second EnterWorktree into another worktree overwrites it, and a successful ExitWorktree clears
 * it. An error result changes nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { UISessionConfig } from '../../../shared/types'
import {
  fabricateRepo,
  fabricateWorktree,
  makeScratchDir
} from '../../../test/helpers/fabricated-worktree'

let stored: Record<string, unknown> = {}
vi.mock('../../../core/services/ui-config', () => ({
  loadSessionConfig: () => ({ ...stored }) as UISessionConfig,
  saveSessionConfig: (config: Record<string, unknown>) => {
    stored = { ...config }
  }
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const { syncCore, emitEvent, resetWorktreeObserverForTests } =
  await import('../../../core/services/sync-host')
const { forgetLinkedWorktrees } = await import('../../../core/services/worktree-root')

const TAIL =
  ' The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.'

describe('worktree tool results through the funnel', () => {
  let base: string
  let repo: string
  let wtFoo: string
  let wtBar: string

  const toolUse = (id: string, toolName: string, toolInput: Record<string, unknown> = {}): void =>
    emitEvent('session:message', [
      'rid',
      {
        id: `m-${id}`,
        role: 'assistant',
        content: [{ type: 'tool_use', toolUseId: id, toolName, toolInput }],
        timestamp: 0
      }
    ])
  const result = (id: string, text: string, isError = false): void =>
    emitEvent('session:tool-result', ['rid', { toolUseId: id, result: text, isError }])
  const entry = (): { worktreePath?: string; originalCwd?: string; origin?: string } | undefined =>
    syncCore.getCanonicalState().worktreeInfoMap['rid']

  beforeEach(() => {
    stored = {}
    forgetLinkedWorktrees()
    resetWorktreeObserverForTests()
    syncCore.resetCanonicalForTests()
    base = makeScratchDir('claudeui-obs-')
    repo = fabricateRepo(path.join(base, 'repo'))
    wtFoo = fabricateWorktree(repo, path.join(repo, '.claude', 'worktrees', 'foo'), 'foo')
    wtBar = fabricateWorktree(repo, path.join(repo, '.claude', 'worktrees', 'bar'), 'bar')
    emitEvent('session:created', ['rid', { cwd: repo }])
  })
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
  })

  it('records a curly-quoted result, keeps it across the next status, and ExitWorktree clears it', () => {
    toolUse('t1', 'EnterWorktree', { name: 'foo' })
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    expect(entry()).toMatchObject({
      worktreePath: wtFoo,
      originalCwd: repo,
      origin: 'detected'
    })

    // status.cwd is the spawn cwd (== originalCwd): the old reducer rule dropped the entry here.
    emitEvent('session:status', [
      'rid',
      {
        state: 'idle',
        sessionId: null,
        model: null,
        cwd: repo,
        totalCostUsd: 0,
        engineId: 'claude'
      }
    ])
    expect(entry()?.worktreePath).toBe(wtFoo)

    toolUse('t2', 'ExitWorktree', { action: 'keep' })
    result('t2', `Exited worktree. Your work is preserved at “${wtFoo}”.`)
    expect(entry()).toBeUndefined()
    expect(stored.worktreeInfoMap).toEqual({})
  })

  it('a second EnterWorktree into another worktree overwrites, keeping the first originalCwd', () => {
    toolUse('t1', 'EnterWorktree', { name: 'foo' })
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    toolUse('t2', 'EnterWorktree', { path: wtBar })
    result('t2', `Entered worktree at “${wtBar}” on branch “worktree-bar”.${TAIL}`)
    expect(entry()).toMatchObject({ worktreePath: wtBar, originalCwd: repo })
  })

  it('an error result records and clears nothing', () => {
    toolUse('t1', 'EnterWorktree', { name: 'foo' })
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    toolUse('t2', 'ExitWorktree', {})
    result('t2', 'Not in a worktree session', true)
    expect(entry()?.worktreePath).toBe(wtFoo)
    toolUse('t3', 'EnterWorktree', { name: 'bar' })
    result('t3', `Created worktree at “${wtBar}” on branch “worktree-bar”.`, true)
    expect(entry()?.worktreePath).toBe(wtFoo)
  })

  it("ignores a worktree of another repository (it would widen the session's permission roots)", () => {
    const other = fabricateRepo(path.join(base, 'other'))
    const foreign = fabricateWorktree(other, path.join(other, '.claude', 'worktrees', 'x'), 'x')
    toolUse('t1', 'EnterWorktree', { path: foreign })
    result('t1', `Entered worktree at “${foreign}” on branch “worktree-foo”.${TAIL}`)
    expect(entry()).toBeUndefined()
  })

  it('a created entry survives Enter and Exit of detected worktrees (B1)', () => {
    const mine = {
      worktreePath: wtFoo,
      worktreeBranch: 'worktree-foo',
      worktreeName: 'foo',
      originalCwd: repo,
      gitRoot: repo,
      originalHeadCommit: 'abc123',
      createdAt: 5,
      origin: 'created'
    }
    stored = { worktreeInfoMap: { rid: mine } }
    emitEvent('session:created', ['rid', { cwd: repo }])
    emitEvent('config:sessions-changed', [stored])
    expect(entry()).toEqual(mine)

    toolUse('t1', 'EnterWorktree', { path: wtBar })
    result('t1', `Entered worktree at “${wtBar}” on branch “worktree-bar”.${TAIL}`)
    expect(entry()).toEqual(mine)
    toolUse('t2', 'ExitWorktree', { action: 'keep' })
    result('t2', `Exited worktree. Your work is preserved at “${wtBar}”.`)
    expect(entry()).toEqual(mine)
    expect(stored.worktreeInfoMap).toEqual({ rid: mine })
  })

  it('a re-delivered result is acted on once: a stale Enter does not undo a later one (S2)', () => {
    toolUse('t1', 'EnterWorktree', { name: 'foo' })
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    toolUse('t2', 'EnterWorktree', { path: wtBar })
    result('t2', `Entered worktree at “${wtBar}” on branch “worktree-bar”.${TAIL}`)
    expect(entry()?.worktreePath).toBe(wtBar)

    // The first result arrives again (a resume replay): it must not flip the entry back.
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    expect(entry()?.worktreePath).toBe(wtBar)

    // Same for an Exit replayed after a newer Enter.
    toolUse('t3', 'ExitWorktree', { action: 'keep' })
    result('t3', `Exited worktree. Your work is preserved at “${wtBar}”.`)
    expect(entry()).toBeUndefined()
    toolUse('t4', 'EnterWorktree', { path: wtFoo })
    result('t4', `Entered worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    result('t3', `Exited worktree. Your work is preserved at “${wtBar}”.`)
    expect(entry()?.worktreePath).toBe(wtFoo)
  })

  it('a relative path input resolves against the worktree the session is in (N5)', () => {
    toolUse('t1', 'EnterWorktree', { name: 'foo' })
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    toolUse('t2', 'EnterWorktree', { path: '../bar' })
    result('t2', `Entered worktree at “${wtBar}x” (not its exact spelling).${TAIL}`)
    expect(entry()?.worktreePath).toBe(wtBar)
  })

  it('a look-alike tool name from another server is not trusted', () => {
    toolUse('t1', 'mcp__evil__EnterWorktree')
    result('t1', `Created worktree at “${wtFoo}” on branch “worktree-foo”.${TAIL}`)
    expect(entry()).toBeUndefined()
  })
})
