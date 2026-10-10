/**
 * @vitest-environment node
 *
 * `locateClaudeTranscript` / `claudeProjectKeyFor` against a temp projects root
 * (the injected `root` — never the real ~/.claude).
 *
 * The case that matters is the relocated one: cli.js's `EnterWorktree` moves a
 * live transcript into the worktree path's project dir while its session cwd
 * still derives the ORIGINAL project key, so a cwd-derived path misses it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { locateClaudeTranscript, claudeProjectKeyFor } from '../claude-transcript-locator'

const CWD = '/r/repo'
const HOME_KEY = '-r-repo'
const WORKTREE_KEY = '-r-repo--claude-worktrees-wt'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-locator-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function seed(projectKey: string, sessionId: string): string {
  const dir = path.join(root, projectKey)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  fs.writeFileSync(file, '{}\n')
  return file
}

describe('locateClaudeTranscript', () => {
  it('finds the transcript in the cwd-derived dir (hint hit)', () => {
    const file = seed(HOME_KEY, 's1')
    // A same-id decoy elsewhere proves the hint is tried FIRST.
    seed('-a-decoy', 's1')
    expect(locateClaudeTranscript('s1', CWD, root)).toBe(file)
  })

  it('scans every project dir when the hint misses (a relocated transcript)', () => {
    seed(HOME_KEY, 'other')
    const file = seed(WORKTREE_KEY, 's1')
    expect(locateClaudeTranscript('s1', CWD, root)).toBe(file)
  })

  it('scans without a hint at all', () => {
    const file = seed(WORKTREE_KEY, 's1')
    expect(locateClaudeTranscript('s1', undefined, root)).toBe(file)
  })

  it('returns null when no dir holds the transcript', () => {
    seed(HOME_KEY, 'other')
    expect(locateClaudeTranscript('missing', CWD, root)).toBeNull()
  })

  it('returns null when the projects root does not exist', () => {
    expect(locateClaudeTranscript('s1', CWD, path.join(root, 'nope'))).toBeNull()
  })

  it('returns null for a traversal / separator / empty id, without touching disk', () => {
    // A real file the traversal id would reach if it were joined unguarded.
    fs.writeFileSync(path.join(root, 'escape.jsonl'), '{}\n')
    seed(HOME_KEY, 'x')
    expect(locateClaudeTranscript('../escape', CWD, root)).toBeNull()
    expect(locateClaudeTranscript('..', CWD, root)).toBeNull()
    expect(locateClaudeTranscript(`${HOME_KEY}/x`, CWD, root)).toBeNull()
    expect(locateClaudeTranscript('a\\b', CWD, root)).toBeNull()
    expect(locateClaudeTranscript('', CWD, root)).toBeNull()
  })
})

describe('claudeProjectKeyFor', () => {
  it('is the located dir name for a relocated transcript', () => {
    seed(WORKTREE_KEY, 's1')
    expect(claudeProjectKeyFor('s1', CWD, root)).toBe(WORKTREE_KEY)
  })

  it('falls back to the cwd-derived key when nothing is on disk yet', () => {
    expect(claudeProjectKeyFor('s1', CWD, root)).toBe(HOME_KEY)
  })
})
