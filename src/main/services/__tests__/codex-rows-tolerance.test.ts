/**
 * @vitest-environment node
 *
 * S2 of the Codex-engine removal: usage and dispatch history rows that name the
 * retired `codex` engine are KEPT, and every read that can reach one returns it
 * without throwing — the usage dashboard query, the per-session dispatched-cost
 * seed, and the dispatch ledger that backs the dispatch-history cards.
 *
 * DB is isolated per test via an os.homedir() redirect, as usage-dashboard.test.ts does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import type { ChatMessage, EngineId } from '../../../shared/types'
import { engineLabelOf, isEngineId } from '../../../shared/engine-label'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

// The dashboard asks the limits providers for labels; none are needed here.
vi.mock('../../../core/services/usage-provider', () => ({
  readAccountLimits: vi.fn(async () => [])
}))

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'codex-rows-'))
  fs.mkdirSync(nodePath.join(TEMP_HOME, '.claude', 'ui'), { recursive: true })
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

type DbModule = typeof import('../../../core/services/db')

async function fresh(): Promise<{
  db: DbModule
  dashboard: typeof import('../../../core/services/usage-dashboard')
  ledger: typeof import('../../../core/services/dispatch-target-ledger')
  history: typeof import('../../../core/services/dispatch-task-history')
}> {
  vi.resetModules()
  const driverSeam = await import('../../../core/services/sqlite-driver')
  const { betterSqlite3Driver } =
    await import('../../../core/services/sqlite/better-sqlite3-driver')
  driverSeam.setSqliteDriver(betterSqlite3Driver())
  const db = await import('../../../core/services/db')
  const dashboard = await import('../../../core/services/usage-dashboard')
  const ledger = await import('../../../core/services/dispatch-target-ledger')
  const history = await import('../../../core/services/dispatch-task-history')
  return { db, dashboard, ledger, history }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const DAY_D = new Date(2025, 5, 15, 0, 0, 0, 0).getTime()
const NOW = DAY_D + 2 * DAY + 10 * HOUR
const CODEX = 'codex' as EngineId
const PARENT = 'parent-routing-1'

function dispatchEvent(id: string): Parameters<DbModule['insertUsageEvent']>[0] {
  return {
    id,
    ts: NOW - HOUR,
    engineId: CODEX,
    vendorId: 'openai',
    accountId: null,
    accountUuid: null,
    modelId: 'gpt-5',
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    equivCostUsd: null,
    engineCostUsd: null,
    sessionId: 'thread-1',
    messageId: id,
    source: 'live',
    accountKey: 'chatgpt:ws-1:user-1',
    accountLabel: null,
    billingType: 'subscription',
    origin: 'dispatch',
    parentRoutingId: PARENT,
    apiCostUsd: 0.5,
    billedCostUsd: 0
  }
}

describe('rows naming the retired codex engine are still read', () => {
  it('the usage dashboard query returns a codex bucket without throwing', async () => {
    const { db, dashboard } = await fresh()
    try {
      db.upsertUsageBuckets([
        {
          hourUtc: DAY_D + DAY + 4 * HOUR,
          accountKey: 'chatgpt:ws-1:user-1',
          billingType: 'subscription',
          engineId: CODEX,
          vendorId: 'openai',
          modelId: 'gpt-5',
          origin: 'dispatch',
          inputTokens: 100,
          outputTokens: 10,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
          cacheReadTokens: 0,
          apiCostUsd: 2,
          billedCostUsd: 0,
          unbilledApiCostUsd: 0,
          unknownApiCostCount: 0,
          unknownBilledCostCount: 0,
          requestCount: 1,
          source: 'rollup'
        }
      ])

      const data = await dashboard.buildUsageDashboard({ range: '7d', now: NOW })

      const model = data.providers
        .flatMap((p) => p.accounts)
        .flatMap((a) => a.models)
        .find((m) => m.modelId === 'gpt-5')
      expect(model).toMatchObject({ engineId: 'codex', vendorId: 'openai' })
      expect(data.totals.displayCostUsd).toBeCloseTo(2, 6)
      // The display helper the dashboard rows go through never throws on it either.
      expect(engineLabelOf(model!.engineId)).toBe('Codex (removed)')
    } finally {
      db.closeDb()
    }
  })

  it('a dispatch usage_event on codex still seeds the dispatching session’s cost breakdown', async () => {
    const { db } = await fresh()
    try {
      db.insertUsageEvent(dispatchEvent('ev-1'))

      expect(db.dispatchedCostsByRouting(PARENT)).toEqual([
        expect.objectContaining({ targetEngine: 'codex', costUsd: 0.5 })
      ])
    } finally {
      db.closeDb()
    }
  })

  it('a codex dispatch_target row is listed by its parent, and its history card is rebuilt', async () => {
    const { db, ledger, history } = await fresh()
    try {
      const created = ledger.dispatchLedger.create({
        engine: CODEX,
        harnessRef: 'thread-1',
        parentSessionId: PARENT,
        parentEngine: 'claude',
        parentToolUseId: 'toolu_codex_1',
        cwd: '/w',
        parentCwd: '/w',
        model: 'gpt-5',
        launchMode: 'default',
        accountKey: null,
        callerRestriction: null,
        name: 'reviewer',
        description: 'review'
      })
      ledger.dispatchLedger.update(created.id, { state: 'stopped' })

      const rows = ledger.dispatchLedger.byParent(PARENT)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ id: created.id, engine: 'codex', state: 'stopped' })
      // A display site that labels the row's engine goes through the shared helper.
      expect(isEngineId(rows[0].engine)).toBe(false)
      expect(engineLabelOf(rows[0].engine)).toBe('Codex (removed)')

      const transcript: ChatMessage[] = [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: 1,
          content: [
            {
              type: 'tool_use',
              toolUseId: 'toolu_codex_1',
              toolName: 'mcp__claude-ui-collab__dispatch_agent',
              toolInput: {}
            }
          ]
        } as ChatMessage
      ]
      const read = history.withDispatchTasks(PARENT, { messages: transcript })
      expect(read.taskNotifications).toEqual([
        expect.objectContaining({ taskId: created.id, toolUseId: 'toolu_codex_1' })
      ])
    } finally {
      db.closeDb()
    }
  })
})
