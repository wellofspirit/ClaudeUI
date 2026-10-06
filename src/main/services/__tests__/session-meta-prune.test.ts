/**
 * @vitest-environment node
 *
 * The boot-time prune of `session_meta` rows for Claude sessions that never produced
 * a transcript. What matters here is the negative space: a row that belongs to a real
 * session must survive every failure mode, and nothing but `session_meta` rows may
 * change.
 *
 * DB, sessions.json and ~/.claude/projects are isolated per test via an os.homedir()
 * redirect to a temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''
/** When set, a readdir of a path ending in this suffix fails (a project dir that cannot be read). */
let failReaddirSuffix: string | null = null
let savedConfigDir: string | undefined

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  const readdirSync = ((p: unknown, ...rest: unknown[]) => {
    if (failReaddirSuffix && String(p).endsWith(failReaddirSuffix)) {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    }
    return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest)
  }) as typeof actual.readdirSync
  return { ...actual, readdirSync, default: { ...actual, readdirSync } }
})

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'metaprune-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
  failReaddirSuffix = null
  // The user's own config dir would (rightly) switch the prune off; tests opt in.
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  vi.clearAllMocks()
})

async function fresh(): Promise<{
  db: typeof import('../../../core/services/db')
  prune: typeof import('../../../core/services/session-meta-prune')
}> {
  vi.resetModules()
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const prune = await import('../../../core/services/session-meta-prune')
  return { db, prune }
}

/** A Claude transcript (any content — the prune reads names only). */
function transcript(projectKey: string, sessionId: string): void {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(nodePath.join(dir, `${sessionId}.jsonl`), '{}\n')
}

const SESSIONS_FILE = (): string => nodePath.join(TEMP_HOME, '.claude', 'ui', 'sessions.json')

function writeSessionsJson(config: Record<string, unknown>): void {
  fs.writeFileSync(SESSIONS_FILE(), JSON.stringify(config))
}

const ids = (db: typeof import('../../../core/services/db')): string[] =>
  Object.keys(db.allSessionMeta()).sort()

describe('pruneOrphanClaudeSessionMeta', () => {
  it('removes a Claude row with no transcript; keeps one that has a transcript (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      // Not in any recents list: a real historical session the sidebar lists from disk.
      transcript('-proj-a', 'real-historical')
      db.setSessionMeta('real-historical', { engineId: 'claude' })
      db.setSessionMeta('orphan', { engineId: 'claude' })

      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual(['orphan'])
      expect(ids(db)).toEqual(['real-historical'])
    } finally {
      db.closeDb()
    }
  })

  it('finds a transcript in ANY project dir, not just the session cwd one', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-elsewhere', 'moved')
      transcript('-other', 'unrelated')
      db.setSessionMeta('moved', { engineId: 'claude' })
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['moved'])
    } finally {
      db.closeDb()
    }
  })

  it('never touches another engine, even with no record it can see (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      db.setSessionMeta('oc', { engineId: 'opencode' })
      db.setSessionMeta('pi-1', { engineId: 'pi' })
      db.setSessionMeta('cx', { engineId: 'codex' })
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['cx', 'oc', 'pi-1'])
    } finally {
      db.closeDb()
    }
  })

  it('does not read an engine this build does not know as Claude (downgrade)', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      // A newer build's engine id: rowToMeta clamps it to 'claude', the prune must not.
      db.setSessionMeta('future', { engineId: 'gemini' as never })
      expect(db.allSessionMeta()['future'].engineId).toBe('claude')
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['future'])
    } finally {
      db.closeDb()
    }
  })

  it('keeps a row with a context reading or a Codex override', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      db.setSessionMeta('metered', { engineId: 'claude', contextUsed: 10, contextWindow: 200 })
      db.setSessionMeta('overridden', { engineId: 'claude' })
      db.ensureCodexSessionOverrides('overridden')
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['metered', 'overridden'])
    } finally {
      db.closeDb()
    }
  })

  it('keeps a row anything in sessions.json still mentions', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      for (const id of ['in-recents', 'pinned', 'hidden', 'titled', 'worktree', 'orphan']) {
        db.setSessionMeta(id, { engineId: 'claude' })
      }
      writeSessionsJson({
        recentSessions: ['in-recents'],
        pinnedSessions: ['pinned'],
        hiddenSessions: ['hidden'],
        customTitles: { titled: 'T' },
        worktreeInfoMap: { worktree: { worktreePath: '/w' } }
      })
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual(['orphan'])
      expect(ids(db)).toEqual(['hidden', 'in-recents', 'pinned', 'titled', 'worktree'])
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when the transcript store cannot be read (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      // No ~/.claude/projects at all.
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      // Present but not a directory.
      fs.writeFileSync(nodePath.join(TEMP_HOME, '.claude', 'projects'), 'not a directory')
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['would-be-orphan'])
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when ONE project dir cannot be read (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      // The unreadable dir may hold the transcript of the row below.
      transcript('-fine', 'fine')
      transcript('-flaky', 'in-the-flaky-dir')
      db.setSessionMeta('in-the-flaky-dir', { engineId: 'claude' })
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      failReaddirSuffix = '-flaky'
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['in-the-flaky-dir', 'would-be-orphan'])
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when sessions.json exists but does not parse (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      // loadSessionConfig degrades this to {} — nothing would look referenced.
      fs.writeFileSync(SESSIONS_FILE(), '{ "recentSessions": ["would-be-orphan"')
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['would-be-orphan'])
      // A MISSING file is a genuinely empty registry: the same row is then an orphan.
      fs.rmSync(SESSIONS_FILE())
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual(['would-be-orphan'])
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when sessions.json parses to something that is not an object (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      // Valid JSON, but `loadSessionConfig` reads it as {} just like a broken file.
      for (const body of ['null', '[]']) {
        fs.writeFileSync(SESSIONS_FILE(), body)
        expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
        expect(ids(db)).toEqual(['would-be-orphan'])
      }
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when CLAUDE_CONFIG_DIR is set (transcripts live elsewhere) (GUARD)', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'anchor')
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      process.env.CLAUDE_CONFIG_DIR = nodePath.join(TEMP_HOME, 'elsewhere')
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['would-be-orphan'])
      delete process.env.CLAUDE_CONFIG_DIR
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual(['would-be-orphan'])
    } finally {
      db.closeDb()
    }
  })

  it('removes nothing when the store holds no transcript at all (wiped / unmounted)', async () => {
    const { db, prune } = await fresh()
    try {
      fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'projects', '-empty'), { recursive: true })
      db.setSessionMeta('would-be-orphan', { engineId: 'claude' })
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])
      expect(ids(db)).toEqual(['would-be-orphan'])
    } finally {
      db.closeDb()
    }
  })

  it('is idempotent and changes nothing but session_meta rows', async () => {
    const { db, prune } = await fresh()
    try {
      transcript('-p', 'real')
      db.setSessionMeta('real', { engineId: 'claude' })
      db.setSessionMeta('orphan', { engineId: 'claude' })
      writeSessionsJson({
        recentSessions: ['real'],
        customTitles: { real: 'Mine' },
        somethingElse: { keep: true }
      })
      const before = fs.readFileSync(SESSIONS_FILE(), 'utf-8')

      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual(['orphan'])
      expect(prune.pruneOrphanClaudeSessionMeta()).toEqual([])

      expect(ids(db)).toEqual(['real'])
      expect(fs.readFileSync(SESSIONS_FILE(), 'utf-8')).toBe(before)
      const transcriptPath = nodePath.join(TEMP_HOME, '.claude', 'projects', '-p', 'real.jsonl')
      expect(fs.existsSync(transcriptPath)).toBe(true)
    } finally {
      db.closeDb()
    }
  })
})
