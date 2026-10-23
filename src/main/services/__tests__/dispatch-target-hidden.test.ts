/**
 * @vitest-environment node
 *
 * ADR-105 — a Claude dispatch target's transcript is on disk now (it used to run
 * `--no-session-persistence`), so the readers that list or total transcripts must
 * skip it through the ledger: the history list (it is not a session of the user's),
 * and block usage's per-file parse (its spend is already in the blocks through the
 * dispatcher's `usage_event` rows, so reading the file too would count it twice).
 *
 * Each case runs against a real temp `~/.claude/projects` and the real ledger store,
 * with a control that proves the same files ARE read when no ledger row names them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'dispatch-hidden-'))
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

const PROJECT_KEY = '-r-repo'
const USER_SESSION = '11111111-1111-4111-8111-111111111111'
const TARGET_SESSION = '22222222-2222-4222-8222-222222222222'

/** One fresh module graph, with the SQLite seam installed into it. */
async function freshGraph(): Promise<{
  ledger: typeof import('../../../core/services/dispatch-target-ledger')
  history: typeof import('../../../core/services/session-history')
  blockUsage: typeof import('../../../core/services/block-usage')
}> {
  vi.resetModules()
  const { setSqliteDriver } = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  setSqliteDriver(betterSqlite3Driver())
  return {
    ledger: await import('../../../core/services/dispatch-target-ledger'),
    history: await import('../../../core/services/session-history'),
    blockUsage: await import('../../../core/services/block-usage')
  }
}

function recordTarget(
  ledger: typeof import('../../../core/services/dispatch-target-ledger'),
  harnessRef: string
): void {
  ledger.dispatchLedger.create({
    engine: 'claude',
    harnessRef,
    parentSessionId: 'parent-1',
    parentEngine: 'opencode',
    parentToolUseId: null,
    cwd: '/r/repo',
    parentCwd: '/r/repo',
    model: 'haiku',
    launchMode: 'default',
    accountKey: null,
    codexAccountId: null,
    callerRestriction: null,
    name: null,
    description: null
  })
}

function projectDir(): string {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A transcript the history list and the usage scan both accept. */
function transcriptLines(sessionId: string): string {
  const now = Date.now() - 60_000
  return [
    {
      type: 'user',
      userType: 'external',
      uuid: `u-${sessionId}`,
      cwd: '/r/repo',
      sessionId,
      timestamp: new Date(now - 1_000).toISOString(),
      message: { role: 'user', content: `prompt of ${sessionId}` }
    },
    {
      type: 'assistant',
      uuid: `a-${sessionId}`,
      cwd: '/r/repo',
      sessionId,
      timestamp: new Date(now).toISOString(),
      message: {
        id: `msg_${sessionId}`,
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      }
    }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n')
}

function seedSession(sessionId: string, withSubagent = false): void {
  const dir = projectDir()
  fs.writeFileSync(nodePath.join(dir, `${sessionId}.jsonl`), transcriptLines(sessionId) + '\n')
  if (withSubagent) {
    // A target's own subagents carry the SAME session id (cli.js `<sid>/subagents/agent-*.jsonl`).
    const sub = nodePath.join(dir, sessionId, 'subagents')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(
      nodePath.join(sub, 'agent-a1.jsonl'),
      transcriptLines(sessionId).replaceAll(`msg_${sessionId}`, `msg_sub_${sessionId}`) + '\n'
    )
  }
}

describe('the Claude history list', () => {
  it("omits a dispatch target's transcript and keeps the user's session", async () => {
    seedSession(USER_SESSION)
    seedSession(TARGET_SESSION)
    const { ledger, history } = await freshGraph()
    recordTarget(ledger, TARGET_SESSION)

    const groups = await history.listDirectories()

    expect(groups.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual([USER_SESSION])
  })

  it('control: without a ledger row both sessions list', async () => {
    seedSession(USER_SESSION)
    seedSession(TARGET_SESSION)
    const { history } = await freshGraph()

    const groups = await history.listDirectories()

    expect(groups.flatMap((g) => g.sessions.map((s) => s.sessionId)).sort()).toEqual(
      [USER_SESSION, TARGET_SESSION].sort()
    )
  })
})

describe("block usage's per-file parse", () => {
  type Scan = { scanJsonlWithCutoff(cutoff: number): Promise<Array<{ messageId: string }>> }

  it('skips a dispatch target transcript and its subagent files, once the row exists', async () => {
    seedSession(USER_SESSION, true)
    seedSession(TARGET_SESSION, true)
    const { ledger, blockUsage } = await freshGraph()
    recordTarget(ledger, TARGET_SESSION)

    const service = new blockUsage.BlockUsageService() as unknown as Scan
    const ids = (await service.scanJsonlWithCutoff(0)).map((e) => e.messageId)

    expect(ids).toContain(`msg_${USER_SESSION}`)
    expect(ids.some((id) => id.includes(TARGET_SESSION))).toBe(false)
  })

  it('control: without a ledger row the same target files are read, subagents included', async () => {
    seedSession(USER_SESSION, true)
    seedSession(TARGET_SESSION, true)
    const { blockUsage } = await freshGraph()

    const service = new blockUsage.BlockUsageService() as unknown as Scan
    const ids = (await service.scanJsonlWithCutoff(0)).map((e) => e.messageId)

    expect(ids).toContain(`msg_${TARGET_SESSION}`)
    expect(ids).toContain(`msg_sub_${TARGET_SESSION}`)
  })
})
