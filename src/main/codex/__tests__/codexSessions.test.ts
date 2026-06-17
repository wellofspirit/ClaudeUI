/**
 * Unit tests for the Codex session scanner (codexSessions.ts).
 *
 * Tests two key behaviours:
 *   1. `parseRolloutMetaAsync` — correctly parses the first-line session_meta
 *      from a rollout JSONL file into { sessionId, cwd, timestamp }.
 *   2. `listCodexSessions` + the cwd-merge logic — a cwd that has BOTH a Claude
 *      session (from session-history.ts's listDirectories) and a Codex session
 *      (from codexSessions.ts) yields ONE DirectoryGroup with both, correctly
 *      provider-tagged, after merging.
 *
 * All tests are pure FS reads against temp directories — no process spawn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  listCodexSessions,
  setCodexCacheFileForTesting,
  resolveCodexRolloutPath,
  deleteCodexSession
} from '../codexSessions'

// ─── Inline the merge logic so we can test it without spawning codex ──────────
//
// The merge is trivial and lives in session-history.ts / listDirectories().
// We replicate the essential rule here so changes to the merge are caught:
// "For each Codex SessionInfo, find-or-create the DirectoryGroup for its cwd."

import type { DirectoryGroup, SessionInfo } from '../../../shared/types'

function mergeCodexIntoGroups(
  claudeGroups: DirectoryGroup[],
  codexSessions: SessionInfo[]
): DirectoryGroup[] {
  const groupByCwd = new Map<string, DirectoryGroup>()
  for (const g of claudeGroups) {
    if (g.cwd) groupByCwd.set(g.cwd, g)
  }

  for (const cs of codexSessions) {
    if (!cs.cwd) continue
    const existing = groupByCwd.get(cs.cwd)
    if (existing) {
      const alreadyPresent = existing.sessions.some((s) => s.sessionId === cs.sessionId)
      if (!alreadyPresent) {
        existing.sessions.push(cs)
      }
    } else {
      const folderName = cs.cwd.split(/[\\/]/).pop() || cs.cwd
      const newGroup: DirectoryGroup = {
        cwd: cs.cwd,
        projectKey: cs.projectKey,
        folderName,
        sessions: [cs]
      }
      claudeGroups.push(newGroup)
      groupByCwd.set(cs.cwd, newGroup)
    }
  }

  for (const g of claudeGroups) {
    g.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  return claudeGroups
}

// ─── Import the actual module functions (FS-based, uses temp dirs) ────────────

import { parseRolloutMetaAsync, extractFirstUserText, cwdToProjectKey } from '../codexSessions'

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeLine(filePath: string, ...lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8')
}

const SESSION_META_LINE = JSON.stringify({
  type: 'session_meta',
  payload: {
    id: 'thread-abc-123',
    timestamp: '2026-01-15T10:30:00.000Z',
    cwd: '/home/user/myproject',
    model_provider: 'openai'
  }
})

/** Build a realistic session_meta line whose `base_instructions` field is at
 *  least `padBytes` bytes — mirrors real rollouts where the first line is
 *  8KB–27KB. Used to guard against a fixed-buffer read truncating it. */
function bigSessionMetaLine(padBytes: number): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id: 'thread-big-001',
      timestamp: '2026-01-15T10:30:00.000Z',
      cwd: '/home/user/bigproject',
      model_provider: 'openai',
      // The real bloat source: the full system prompt is embedded here.
      base_instructions: { text: 'X'.repeat(padBytes) }
    }
  })
}

/** A real-shaped event_msg/user_message line (the clean human prompt). */
function userMessageLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-01-15T10:31:00.000Z',
    type: 'event_msg',
    payload: { type: 'user_message', message: text, images: [], local_images: [] }
  })
}

/** A noisy non-user event_msg line (token_count / reasoning) — must be skipped. */
function noiseLine(payloadType: string): string {
  return JSON.stringify({
    timestamp: '2026-01-15T10:31:00.000Z',
    type: 'event_msg',
    payload: { type: payloadType, text: 'some reasoning' }
  })
}

/** A response_item user message (injected AGENTS.md / env context) — these are
 *  NOT the clean human prompt and must NOT be picked up as the title. */
function responseItemUserLine(text: string): string {
  return JSON.stringify({
    timestamp: '2026-01-15T10:30:30.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  })
}

// ─── Tests: parseRolloutMetaAsync ─────────────────────────────────────────────

describe('parseRolloutMetaAsync', () => {
  it('parses a valid session_meta first line', async () => {
    const filePath = path.join(tmpDir, 'rollout-test.jsonl')
    writeLine(filePath, SESSION_META_LINE)

    const result = await parseRolloutMetaAsync(filePath)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('thread-abc-123')
    expect(result!.cwd).toBe('/home/user/myproject')
    expect(result!.timestamp).toBe(new Date('2026-01-15T10:30:00.000Z').getTime())
  })

  it('parses correctly when the file has many subsequent event lines', async () => {
    const filePath = path.join(tmpDir, 'rollout-multi.jsonl')
    const eventLine = userMessageLine('hello')
    writeLine(filePath, SESSION_META_LINE, eventLine, eventLine, eventLine)

    const result = await parseRolloutMetaAsync(filePath)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('thread-abc-123')
  })

  // REGRESSION: real rollout session_meta first lines are 8KB–27KB because
  // payload.base_instructions embeds the full system prompt. A fixed-size
  // buffer read (e.g. Buffer.alloc(4096)) truncates the line → JSON.parse
  // throws → the session is silently dropped. This guards the readline path.
  it('parses a LARGE first line (>4KB session_meta with big base_instructions)', async () => {
    const filePath = path.join(tmpDir, 'rollout-big.jsonl')
    const bigLine = bigSessionMetaLine(20000) // ~20KB, well past any 4KB buffer
    expect(bigLine.length).toBeGreaterThan(20000)
    writeLine(filePath, bigLine, userMessageLine('first prompt'))

    const result = await parseRolloutMetaAsync(filePath)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe('thread-big-001')
    expect(result!.cwd).toBe('/home/user/bigproject')
  })

  it('returns null when the file is empty', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(filePath, '', 'utf-8')
    const result = await parseRolloutMetaAsync(filePath)
    expect(result).toBeNull()
  })

  it('returns null when the first line is not session_meta', async () => {
    const filePath = path.join(tmpDir, 'wrong-type.jsonl')
    writeLine(filePath, JSON.stringify({ type: 'event_msg', msg: {} }), SESSION_META_LINE)
    const result = await parseRolloutMetaAsync(filePath)
    expect(result).toBeNull()
  })

  it('returns null when cwd is missing from payload', async () => {
    const filePath = path.join(tmpDir, 'no-cwd.jsonl')
    writeLine(
      filePath,
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', timestamp: '2026-01-01T00:00:00Z' } })
    )
    const result = await parseRolloutMetaAsync(filePath)
    expect(result).toBeNull()
  })

  it('returns null for a non-existent file', async () => {
    const result = await parseRolloutMetaAsync(path.join(tmpDir, 'nonexistent.jsonl'))
    expect(result).toBeNull()
  })

  it('returns null when first line is malformed JSON', async () => {
    const filePath = path.join(tmpDir, 'bad-json.jsonl')
    writeLine(filePath, 'not json at all')
    const result = await parseRolloutMetaAsync(filePath)
    expect(result).toBeNull()
  })

  it('handles timestamp 0 gracefully when timestamp field is absent', async () => {
    const filePath = path.join(tmpDir, 'no-ts.jsonl')
    writeLine(
      filePath,
      JSON.stringify({ type: 'session_meta', payload: { id: 'y', cwd: '/some/dir' } })
    )
    const result = await parseRolloutMetaAsync(filePath)
    expect(result).not.toBeNull()
    expect(result!.timestamp).toBe(0)
  })
})

// ─── Tests: extractFirstUserText ──────────────────────────────────────────────
//
// Title source is the first event_msg record with payload.type === 'user_message'
// (verified against real ~/.codex rollouts). Distinct from response_item user
// messages, which are injected AGENTS.md / environment context, not the prompt.

describe('extractFirstUserText', () => {
  it('extracts the first event_msg/user_message text (real shape, nested under payload)', async () => {
    const filePath = path.join(tmpDir, 'rollout-title.jsonl')
    writeLine(
      filePath,
      SESSION_META_LINE,
      noiseLine('task_started'),
      userMessageLine('Refactor the auth module to use JWT'),
      noiseLine('agent_reasoning')
    )
    const title = await extractFirstUserText(filePath)
    expect(title).toBe('Refactor the auth module to use JWT')
  })

  it('skips response_item user messages (injected context) and finds the event_msg prompt', async () => {
    const filePath = path.join(tmpDir, 'rollout-injected.jsonl')
    writeLine(
      filePath,
      SESSION_META_LINE,
      responseItemUserLine('# AGENTS.md instructions for /repo'),
      responseItemUserLine('<environment_context><cwd>/repo</cwd></environment_context>'),
      userMessageLine('Actual human prompt here')
    )
    const title = await extractFirstUserText(filePath)
    expect(title).toBe('Actual human prompt here')
  })

  it('truncates to 80 chars and collapses whitespace', async () => {
    const filePath = path.join(tmpDir, 'rollout-long.jsonl')
    const longText = 'word '.repeat(40) // 200 chars with spaces/newlines
    writeLine(filePath, SESSION_META_LINE, userMessageLine(longText))
    const title = await extractFirstUserText(filePath)
    expect(title!.length).toBeLessThanOrEqual(80)
    expect(title).not.toMatch(/\n/)
  })

  // REGRESSION: the first user prompt can sit 13KB–71KB into the file (after a
  // 27KB system-prompt first line + reasoning/tool turns). Make sure the
  // streaming scan reaches it rather than giving up on a small byte window.
  it('finds a user_message that appears DEEP in the file (after a large first line + many events)', async () => {
    const filePath = path.join(tmpDir, 'rollout-deep.jsonl')
    const lines = [bigSessionMetaLine(27000)] // 27KB first line, like real data
    // 50 noisy events before the human prompt
    for (let i = 0; i < 50; i++) lines.push(noiseLine('token_count'))
    lines.push(userMessageLine('The deep human prompt'))
    writeLine(filePath, ...lines)

    const title = await extractFirstUserText(filePath)
    expect(title).toBe('The deep human prompt')
  })

  it('returns null (caller falls back to a label) when there is no user_message', async () => {
    const filePath = path.join(tmpDir, 'rollout-nouser.jsonl')
    writeLine(filePath, SESSION_META_LINE, noiseLine('agent_reasoning'), noiseLine('token_count'))
    const title = await extractFirstUserText(filePath)
    expect(title).toBeNull()
  })

  it('returns null and does not throw on a non-existent file', async () => {
    const title = await extractFirstUserText(path.join(tmpDir, 'nope.jsonl'))
    expect(title).toBeNull()
  })

  it('returns null and does not throw on malformed JSON lines', async () => {
    const filePath = path.join(tmpDir, 'rollout-malformed.jsonl')
    // A line that contains both markers but is not valid JSON — must not throw.
    writeLine(
      filePath,
      SESSION_META_LINE,
      '{"type":"event_msg","payload":{"type":"user_message" BROKEN'
    )
    const title = await extractFirstUserText(filePath)
    expect(title).toBeNull()
  })
})

// ─── Tests: cwdToProjectKey ───────────────────────────────────────────────────

describe('cwdToProjectKey', () => {
  it('replaces slashes and dots with dashes', () => {
    expect(cwdToProjectKey('/home/user/my.project')).toBe('-home-user-my-project')
  })

  it('handles Windows-style paths', () => {
    expect(cwdToProjectKey('C:\\Users\\dev\\project')).toBe('C:-Users-dev-project')
  })
})

// ─── Tests: cwd-merge (one group per directory, provider-tagged) ──────────────

describe('cwd-merge: Claude + Codex sessions in same directory', () => {
  const SHARED_CWD = '/home/user/shared-project'

  const claudeSession: SessionInfo = {
    sessionId: 'claude-sess-001',
    cwd: SHARED_CWD,
    projectKey: '-home-user-shared-project',
    title: 'Claude: Fix the bug',
    timestamp: 1000,
    lastActivityAt: 2000,
    aiTitle: null,
    provider: 'claude'
  }

  const codexSession: SessionInfo = {
    sessionId: 'thread-codex-001',
    cwd: SHARED_CWD,
    projectKey: '-home-user-shared-project',
    title: 'Codex: Refactor',
    timestamp: 1500,
    lastActivityAt: 3000,
    aiTitle: null,
    provider: 'codex'
  }

  const claudeGroup: DirectoryGroup = {
    cwd: SHARED_CWD,
    projectKey: '-home-user-shared-project',
    folderName: 'shared-project',
    sessions: [claudeSession]
  }

  it('produces ONE group with both sessions when they share a cwd', () => {
    const groups = mergeCodexIntoGroups([{ ...claudeGroup, sessions: [...claudeGroup.sessions] }], [codexSession])
    expect(groups).toHaveLength(1)
    expect(groups[0].cwd).toBe(SHARED_CWD)
    expect(groups[0].sessions).toHaveLength(2)
  })

  it('tags Claude sessions with provider:"claude"', () => {
    const groups = mergeCodexIntoGroups([{ ...claudeGroup, sessions: [...claudeGroup.sessions] }], [codexSession])
    const claude = groups[0].sessions.find((s) => s.sessionId === 'claude-sess-001')
    expect(claude?.provider).toBe('claude')
  })

  it('tags Codex sessions with provider:"codex"', () => {
    const groups = mergeCodexIntoGroups([{ ...claudeGroup, sessions: [...claudeGroup.sessions] }], [codexSession])
    const codex = groups[0].sessions.find((s) => s.sessionId === 'thread-codex-001')
    expect(codex?.provider).toBe('codex')
  })

  it('sorts sessions by lastActivityAt descending (most recent first)', () => {
    const groups = mergeCodexIntoGroups([{ ...claudeGroup, sessions: [...claudeGroup.sessions] }], [codexSession])
    const sessions = groups[0].sessions
    // codexSession.lastActivityAt = 3000 > claudeSession.lastActivityAt = 2000
    expect(sessions[0].sessionId).toBe('thread-codex-001')
    expect(sessions[1].sessionId).toBe('claude-sess-001')
  })

  it('creates a NEW group for a cwd that has only Codex sessions', () => {
    const codexOnly: SessionInfo = {
      sessionId: 'thread-new-cwd',
      cwd: '/home/user/codex-only-dir',
      projectKey: '-home-user-codex-only-dir',
      title: 'Codex session',
      timestamp: 1000,
      lastActivityAt: 1000,
      aiTitle: null,
      provider: 'codex'
    }
    const groups = mergeCodexIntoGroups([], [codexOnly])
    expect(groups).toHaveLength(1)
    expect(groups[0].cwd).toBe('/home/user/codex-only-dir')
    expect(groups[0].folderName).toBe('codex-only-dir')
    expect(groups[0].sessions[0].provider).toBe('codex')
  })

  it('does not duplicate a Codex session already present in the group', () => {
    const groupWithBoth: DirectoryGroup = {
      cwd: SHARED_CWD,
      projectKey: '-home-user-shared-project',
      folderName: 'shared-project',
      sessions: [claudeSession, codexSession] // codexSession already present
    }
    const groups = mergeCodexIntoGroups([groupWithBoth], [codexSession])
    expect(groups[0].sessions).toHaveLength(2) // still 2, not 3
  })

  it('keeps Claude-only groups untouched when there are no Codex sessions', () => {
    const groups = mergeCodexIntoGroups(
      [{ ...claudeGroup, sessions: [...claudeGroup.sessions] }],
      []
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions).toHaveLength(1)
    expect(groups[0].sessions[0].provider).toBe('claude')
  })

  it('handles multiple cwds: claude+codex in one, codex-only in another', () => {
    const codexOtherCwd: SessionInfo = {
      sessionId: 'thread-other',
      cwd: '/home/user/other-dir',
      projectKey: '-home-user-other-dir',
      title: 'Other Codex session',
      timestamp: 500,
      lastActivityAt: 500,
      aiTitle: null,
      provider: 'codex'
    }
    const groups = mergeCodexIntoGroups(
      [{ ...claudeGroup, sessions: [...claudeGroup.sessions] }],
      [codexSession, codexOtherCwd]
    )
    expect(groups).toHaveLength(2)
    const sharedGroup = groups.find((g) => g.cwd === SHARED_CWD)
    const otherGroup = groups.find((g) => g.cwd === '/home/user/other-dir')
    expect(sharedGroup?.sessions).toHaveLength(2)
    expect(otherGroup?.sessions).toHaveLength(1)
  })
})

// ─── Tests: listCodexSessions end-to-end against a temp CODEX_HOME ────────────
//
// Full-scan integration: walk → parse (large first lines) → title → SessionInfo.
// This is the guard that the 4KB-buffer bug (which dropped EVERY real session)
// stays fixed. We point CODEX_HOME at a temp dir of realistic rollouts.

describe('listCodexSessions (end-to-end, temp CODEX_HOME)', () => {
  let codexHome: string
  let prevCodexHome: string | undefined

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
    prevCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    // Redirect the disk cache into the temp dir so the test never reads or
    // writes the real ~/.claude/ui/codex-sessions-cache.json (hermetic).
    setCodexCacheFileForTesting(path.join(codexHome, 'codex-sessions-cache.json'))
  })

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    setCodexCacheFileForTesting(null)
    fs.rmSync(codexHome, { recursive: true, force: true })
  })

  /** Write a rollout file under sessions/YYYY/MM/DD/ with a LARGE first line. */
  function writeRollout(
    relDay: string,
    fileName: string,
    sessionId: string,
    cwd: string,
    userText?: string
  ): void {
    const dir = path.join(codexHome, 'sessions', relDay)
    fs.mkdirSync(dir, { recursive: true })
    const metaLine = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-01-15T10:30:00.000Z',
        cwd,
        model_provider: 'openai',
        base_instructions: { text: 'X'.repeat(15000) } // ~15KB, like real data
      }
    })
    const lines = [metaLine]
    if (userText) lines.push(userMessageLine(userText))
    fs.writeFileSync(path.join(dir, fileName), lines.join('\n') + '\n', 'utf-8')
  }

  it('returns NON-EMPTY results with correct cwd/sessionId/provider for large-first-line rollouts', async () => {
    writeRollout('2026/01/15', 'rollout-a.jsonl', 'thread-aaa', '/work/proj-a', 'Fix the login bug')
    writeRollout('2026/01/16', 'rollout-b.jsonl', 'thread-bbb', '/work/proj-b', 'Add a dark theme')

    const sessions = await listCodexSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.every((s) => s.provider === 'codex')).toBe(true)
    expect(sessions.every((s) => !!s.cwd && !!s.sessionId)).toBe(true)

    const a = sessions.find((s) => s.sessionId === 'thread-aaa')
    expect(a?.cwd).toBe('/work/proj-a')
    expect(a?.title).toBe('Fix the login bug')
    expect(a?.projectKey).toBe('-work-proj-a')
  })

  it('falls back to a "Codex <date>" label when no user_message is present', async () => {
    writeRollout('2026/01/15', 'rollout-c.jsonl', 'thread-ccc', '/work/proj-c') // no userText
    const sessions = await listCodexSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].title.startsWith('Codex ')).toBe(true)
  })

  it('returns [] when CODEX_HOME/sessions does not exist', async () => {
    // Fresh temp home with no sessions/ dir.
    const sessions = await listCodexSessions()
    expect(sessions).toEqual([])
  })

  it('skips rollouts whose session_meta has no cwd', async () => {
    const dir = path.join(codexHome, 'sessions', '2026/01/15')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'rollout-nocwd.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { id: 'x', timestamp: '2026-01-01T00:00:00Z' } }) +
        '\n',
      'utf-8'
    )
    const sessions = await listCodexSessions()
    expect(sessions).toEqual([])
  })

  // HERMETICITY GUARD: a scan must write its cache to the redirected temp path,
  // never to the real ~/.claude/ui/codex-sessions-cache.json.
  it('writes the cache to the redirected temp path, not the real home cache', async () => {
    const realCacheFile = path.join(os.homedir(), '.claude', 'ui', 'codex-sessions-cache.json')
    const realExistedBefore = fs.existsSync(realCacheFile)
    const realStatBefore = realExistedBefore ? fs.statSync(realCacheFile).mtimeMs : null

    writeRollout('2026/01/15', 'rollout-h.jsonl', 'thread-herm', '/work/herm', 'hermetic prompt')
    await listCodexSessions()

    // The temp cache file was created…
    const tempCacheFile = path.join(codexHome, 'codex-sessions-cache.json')
    expect(fs.existsSync(tempCacheFile)).toBe(true)

    // …and the real home cache was not created or modified.
    if (!realExistedBefore) {
      expect(fs.existsSync(realCacheFile)).toBe(false)
    } else {
      expect(fs.statSync(realCacheFile).mtimeMs).toBe(realStatBefore)
    }
  })

  it('uses the disk cache on a warm second scan (mtime hit) and returns the same result', async () => {
    writeRollout('2026/01/15', 'rollout-w.jsonl', 'thread-warm', '/work/warm', 'cold then warm')

    const cold = await listCodexSessions()
    expect(cold).toHaveLength(1)

    // Second scan: the rollout file is unchanged, so it should be served from
    // the (temp) cache and yield an identical result.
    const warm = await listCodexSessions()
    expect(warm).toHaveLength(1)
    expect(warm[0].sessionId).toBe('thread-warm')
    expect(warm[0].title).toBe('cold then warm')
    expect(warm[0].cwd).toBe('/work/warm')
  })
})

// ─── Tests: resolveCodexRolloutPath ──────────────────────────────────────────

describe('resolveCodexRolloutPath (temp CODEX_HOME)', () => {
  let codexHome: string
  let prevCodexHome: string | undefined

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-resolve-'))
    prevCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    setCodexCacheFileForTesting(path.join(codexHome, 'cache.json'))
  })

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    setCodexCacheFileForTesting(null)
    fs.rmSync(codexHome, { recursive: true, force: true })
  })

  function writeRollout(relDay: string, fileName: string, sessionId: string, cwd: string): string {
    const dir = path.join(codexHome, 'sessions', relDay)
    fs.mkdirSync(dir, { recursive: true })
    const metaLine = JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-01-15T10:30:00.000Z', cwd }
    })
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, metaLine + '\n', 'utf-8')
    return filePath
  }

  it('returns the rollout path when resolved via a fresh scan (no cache)', async () => {
    const expected = writeRollout('2026/01/15', 'rollout-r1.jsonl', 'thread-r1', '/proj/r1')

    const result = await resolveCodexRolloutPath('thread-r1')
    expect(result).toBe(expected)
  })

  it('resolves correctly from the disk cache on a second call', async () => {
    // Populate the cache by running listCodexSessions first.
    writeRollout('2026/01/15', 'rollout-cached.jsonl', 'thread-c1', '/proj/c1')
    await listCodexSessions()

    // Second call should hit the cache (no additional scan needed).
    const result = await resolveCodexRolloutPath('thread-c1')
    expect(result).not.toBeNull()
    expect(result).toContain('rollout-cached.jsonl')
  })

  it('returns null when the sessionId does not exist', async () => {
    writeRollout('2026/01/15', 'rollout-other.jsonl', 'thread-other', '/proj/other')

    const result = await resolveCodexRolloutPath('thread-nonexistent')
    expect(result).toBeNull()
  })

  it('returns null when CODEX_HOME/sessions does not exist', async () => {
    // sessions/ dir was never created in this temp home
    const result = await resolveCodexRolloutPath('thread-any')
    expect(result).toBeNull()
  })

  it('falls back to a fresh scan when the cached path no longer exists on disk', async () => {
    const filePath = writeRollout('2026/01/16', 'rollout-gone.jsonl', 'thread-gone', '/proj/gone')
    // Prime the cache
    await listCodexSessions()
    // Delete the file externally (simulates an out-of-band removal)
    fs.unlinkSync(filePath)

    // The cache hit will fail the fs.access check; fresh scan also finds nothing.
    const result = await resolveCodexRolloutPath('thread-gone')
    expect(result).toBeNull()
  })
})

// ─── Tests: deleteCodexSession ────────────────────────────────────────────────

describe('deleteCodexSession (temp CODEX_HOME)', () => {
  let codexHome: string
  let prevCodexHome: string | undefined

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-delete-'))
    prevCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
    setCodexCacheFileForTesting(path.join(codexHome, 'cache.json'))
  })

  afterEach(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prevCodexHome
    setCodexCacheFileForTesting(null)
    fs.rmSync(codexHome, { recursive: true, force: true })
  })

  function writeRollout(relDay: string, fileName: string, sessionId: string, cwd: string): string {
    const dir = path.join(codexHome, 'sessions', relDay)
    fs.mkdirSync(dir, { recursive: true })
    const metaLine = JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-01-15T10:30:00.000Z', cwd }
    })
    const filePath = path.join(dir, fileName)
    fs.writeFileSync(filePath, metaLine + '\n', 'utf-8')
    return filePath
  }

  it('deletes the rollout file and it no longer exists on disk', async () => {
    const filePath = writeRollout('2026/01/15', 'rollout-del.jsonl', 'thread-del', '/proj/del')
    expect(fs.existsSync(filePath)).toBe(true)

    await deleteCodexSession('thread-del')

    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('deletes the correct file when multiple rollout files exist', async () => {
    const keep = writeRollout('2026/01/15', 'rollout-keep.jsonl', 'thread-keep', '/proj/keep')
    const remove = writeRollout('2026/01/16', 'rollout-remove.jsonl', 'thread-remove', '/proj/rm')

    await deleteCodexSession('thread-remove')

    expect(fs.existsSync(remove)).toBe(false)
    expect(fs.existsSync(keep)).toBe(true)
  })

  it('no-ops gracefully when the sessionId is not found', async () => {
    // Should resolve without throwing
    await expect(deleteCodexSession('thread-nonexistent')).resolves.toBeUndefined()
  })

  it('invalidates the cache entry after deletion', async () => {
    writeRollout('2026/01/15', 'rollout-inv.jsonl', 'thread-inv', '/proj/inv')
    // Prime the cache
    await listCodexSessions()

    await deleteCodexSession('thread-inv')

    // After deletion, resolveCodexRolloutPath should return null (no stale cache hit)
    const resolved = await resolveCodexRolloutPath('thread-inv')
    expect(resolved).toBeNull()
  })

  it('throws when sessionId is empty', async () => {
    await expect(deleteCodexSession('')).rejects.toThrow('sessionId is required')
  })

  it('rejects paths outside CODEX_HOME/sessions (path-traversal guard)', async () => {
    // Craft a fake cache entry pointing to a file outside sessions/
    const outsidePath = path.join(codexHome, 'outside-sessions.jsonl')
    fs.writeFileSync(
      outsidePath,
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'thread-evil', timestamp: '2026-01-01T00:00:00Z', cwd: '/evil' }
      }) + '\n',
      'utf-8'
    )
    // Manually inject a poisoned cache entry.
    // We write the cache file directly to bypass the normal scan path.
    const cacheFile = path.join(codexHome, 'cache.json')
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({
        version: 1,
        entries: {
          [outsidePath]: {
            mtime: Date.now(),
            sessionId: 'thread-evil',
            cwd: '/evil',
            timestamp: Date.now(),
            title: 'evil'
          }
        }
      }),
      'utf-8'
    )

    await expect(deleteCodexSession('thread-evil')).rejects.toThrow('Path traversal blocked')
    // The outside file must still exist — we didn't touch it
    expect(fs.existsSync(outsidePath)).toBe(true)
  })
})
