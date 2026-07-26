/**
 * @vitest-environment node
 *
 * M-DB5 guard — parseJsonlFile / the mtime-keyed fileCache must not hide pre-7d
 * entries from the historical backfill.
 *
 * recalculate() runs scanAllJsonl (cutoff = now-7d) FIRST, then
 * backfillHistoricalSummaries runs scanJsonlWithCutoff(0). Pre-fix, parseJsonlFile
 * dropped entries older than the passed cutoff and cached the truncated list by
 * mtime, so the cutoff-0 backfill cache-HIT on the same file and never saw the
 * pre-7d entries. Post-fix, parseJsonlFile keeps every dated entry and each
 * caller applies its own per-entry cutoff, so the backfill sees the old rows.
 *
 * os.homedir() is redirected to a temp dir so CLAUDE_PROJECTS_DIR points at a
 * fixture tree (better-sqlite3 is the node:sqlite stub; the DB is unused here).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'backfill-cache-'))
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

interface DatedEntry {
  timestamp: number
}

/** Build one assistant-usage JSONL line the parser accepts. */
function jsonlLine(id: string, tsMs: number): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(tsMs).toISOString(),
    message: {
      id,
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }
  })
}

async function freshService(): Promise<
  InstanceType<(typeof import('../block-usage'))['BlockUsageService']>
> {
  vi.resetModules()
  const bu = await import('../block-usage')
  return new bu.BlockUsageService()
}

describe('M-DB5 — JSONL parse cache does not hide pre-7d entries from backfill', () => {
  it('scanJsonlWithCutoff(0) sees old entries even after scanAllJsonl cached the file', async () => {
    const now = Date.now()
    // One file, modified now (so scanAllJsonl does not skip it via mtime<cutoff),
    // containing one entry 20 days old (pre-7d) and one entry 1 day old.
    const projDir = nodePath.join(TEMP_HOME, '.claude', 'projects', 'proj-a')
    fs.mkdirSync(projDir, { recursive: true })
    const file = nodePath.join(projDir, '11111111-1111-1111-1111-111111111111.jsonl')
    fs.writeFileSync(
      file,
      jsonlLine('msg_old', now - 20 * DAY) + '\n' + jsonlLine('msg_recent', now - 1 * DAY) + '\n'
    )

    const service = (await freshService()) as unknown as {
      scanAllJsonl(): Promise<DatedEntry[]>
      scanJsonlWithCutoff(cutoff: number): Promise<DatedEntry[]>
    }

    // recalculate() order: 7d scan first (populates the mtime-keyed cache)...
    const recent = await service.scanAllJsonl()
    expect(recent.map(() => true)).toHaveLength(1) // only the 1-day-old entry is in-window
    expect(recent.every((e) => e.timestamp >= now - 7 * DAY)).toBe(true)

    // ...then the backfill's cutoff-0 scan. Must include the 20-day-old entry.
    const all = await service.scanJsonlWithCutoff(0)
    expect(all).toHaveLength(2)
    const oldest = Math.min(...all.map((e) => e.timestamp))
    expect(oldest).toBeLessThan(now - 7 * DAY) // pre-7d entry present (bug would drop it)
  })
})
