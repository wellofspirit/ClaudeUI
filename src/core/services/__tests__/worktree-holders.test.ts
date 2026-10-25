/**
 * @vitest-environment node
 *
 * Who counts as using a worktree: containment of a working directory, lexical AND canonical.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  collectHolders,
  createHolderMatcher,
  holdersOf,
  type HolderCwd,
  type HolderSources
} from '../worktree-holders'

let base: string
let wt: string

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeui-wthold-'))
  wt = path.join(base, 'repo', '.claude', 'worktrees', 'feat')
  fs.mkdirSync(path.join(wt, 'src'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 })
})

const none: HolderSources = { sessions: () => [], xAgents: () => [], terminals: () => [] }

describe('collectHolders', () => {
  it('flattens sessions (one row per cwd), X-Agents and terminals, labelled', () => {
    const rows = collectHolders({
      sessions: () => [
        { id: 'abcdef123456', engine: 'claude', live: true, cwds: ['/a', '/b', ''] },
        { id: 's2', engine: 'pi', title: '  Fix the thing ', live: false, cwds: ['/c'] }
      ],
      xAgents: () => [{ id: 'x1', engine: 'codex', label: 'reviewer', cwd: '/d', live: false }],
      terminals: () => [{ id: 't1', cwd: '/e' }]
    })

    expect(rows).toEqual([
      {
        kind: 'session',
        id: 'abcdef123456',
        label: 'claude abcdef12',
        live: true,
        engine: 'claude',
        cwd: '/a'
      },
      {
        kind: 'session',
        id: 'abcdef123456',
        label: 'claude abcdef12',
        live: true,
        engine: 'claude',
        cwd: '/b'
      },
      { kind: 'session', id: 's2', label: 'Fix the thing', live: false, engine: 'pi', cwd: '/c' },
      { kind: 'x-agent', id: 'x1', label: 'reviewer', live: false, engine: 'codex', cwd: '/d' },
      { kind: 'terminal', id: 't1', label: 'terminal', live: true, cwd: '/e' }
    ])
  })
})

describe('holdersOf', () => {
  it('a cwd equal to or inside the worktree holds it; its parent and a prefix-sharing sibling do not', () => {
    const holders = collectHolders({
      ...none,
      sessions: () => [
        { id: 'at', engine: 'claude', live: true, cwds: [wt] },
        { id: 'inside', engine: 'claude', live: true, cwds: [path.join(wt, 'src')] },
        { id: 'parent', engine: 'claude', live: true, cwds: [path.dirname(wt)] },
        { id: 'sibling', engine: 'claude', live: true, cwds: [`${wt}-other`] }
      ]
    })

    expect(holdersOf(wt, holders).map((h) => h.id)).toEqual(['at', 'inside'])
  })

  it('merges rows of one holder into one, live when any of them is live', () => {
    const found = holdersOf(wt, [
      { kind: 'session', id: 's', label: 'x', live: false, cwd: wt },
      { kind: 'session', id: 's', label: 'x', live: true, cwd: path.join(wt, 'src') },
      { kind: 'x-agent', id: 's', label: 'agent', live: false, cwd: wt }
    ])

    expect(found).toHaveLength(2)
    expect(found.find((h) => h.kind === 'session')?.live).toBe(true)
    expect(found.find((h) => h.kind === 'x-agent')?.live).toBe(false)
  })

  it('keeps a cold or parked holder in the list, marked not live', () => {
    const holders = collectHolders({
      ...none,
      sessions: () => [{ id: 'cold', engine: 'claude', live: false, cwds: [wt] }]
    })

    expect(holdersOf(wt, holders)).toEqual([
      { kind: 'session', id: 'cold', label: 'claude cold', live: false, engine: 'claude' }
    ])
  })

  it('sees a cwd spelled through a junction into the worktree', () => {
    const alias = path.join(base, 'alias')
    try {
      fs.symlinkSync(wt, alias, 'junction')
    } catch {
      return // links not creatable here
    }
    const holders = collectHolders({
      ...none,
      sessions: () => [
        { id: 'via-link', engine: 'claude', live: true, cwds: [path.join(alias, 'src')] }
      ]
    })

    expect(holdersOf(wt, holders).map((h) => h.id)).toEqual(['via-link'])
  })

  it('sees the worktree itself spelled through a junction', () => {
    const alias = path.join(base, 'alias')
    try {
      fs.symlinkSync(wt, alias, 'junction')
    } catch {
      return
    }
    const holders = collectHolders({
      ...none,
      terminals: () => [{ id: 'pty', cwd: path.join(wt, 'src') }]
    })

    expect(holdersOf(alias, holders).map((h) => h.id)).toEqual(['pty'])
  })

  it.skipIf(process.platform !== 'win32')(
    'Windows: drive-letter and folder case do not hide a holder',
    () => {
      const holders = collectHolders({
        ...none,
        terminals: () => [{ id: 'pty', cwd: path.join(wt, 'src').toUpperCase() }]
      })

      expect(holdersOf(wt, holders).map((h) => h.id)).toEqual(['pty'])
    }
  )

  it('a cwd that does not exist is compared as spelled', () => {
    const holders = collectHolders({
      ...none,
      terminals: () => [{ id: 'pty', cwd: path.join(wt, 'deleted-subdir') }]
    })

    expect(holdersOf(wt, holders).map((h) => h.id)).toEqual(['pty'])
  })
})

describe('createHolderMatcher (N9)', () => {
  it('resolves each holder directory once however many worktrees it is asked about', () => {
    const holders: HolderCwd[] = [
      { kind: 'session', id: 's1', label: 'one', live: true, cwd: path.join(wt, 'src') },
      {
        kind: 'terminal',
        id: 't1',
        label: 'terminal',
        live: true,
        cwd: path.join(base, 'elsewhere')
      }
    ]
    const resolved: string[] = []
    const match = createHolderMatcher(holders, (p) => {
      resolved.push(p)
      return p
    })
    const others = [1, 2, 3, 4].map((n) => path.join(base, 'repo', '.claude', 'worktrees', `o${n}`))

    const found = [wt, ...others].map((w) => match(w).map((h) => h.id))

    expect(found).toEqual([['s1'], [], [], [], []])
    // 5 worktree roots + 2 holder directories, not 5 + 5 x 2.
    expect(resolved.filter((p) => holders.some((h) => h.cwd === p))).toHaveLength(2)
  })

  it('answers like holdersOf', () => {
    const holders: HolderCwd[] = [
      { kind: 'session', id: 's1', label: 'one', live: false, cwd: wt },
      { kind: 'session', id: 's1', label: 'one', live: true, cwd: path.join(wt, 'src') }
    ]
    expect(createHolderMatcher(holders)(wt)).toEqual(holdersOf(wt, holders))
    expect(holdersOf(wt, holders)).toEqual([
      { kind: 'session', id: 's1', label: 'one', live: true, engine: undefined }
    ])
  })
})
