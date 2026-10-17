/**
 * @vitest-environment node
 *
 * `session:created` says who started the session only when a session tool did
 * (slice 1c, spec §6.1): `createdBy: 'agent'` rides the birth event so no client
 * follows the new session. Every other session — a client's, a resume, a fork —
 * carries no such key, so its clients behave exactly as before.
 *
 * Drives the real `prepareAndCreateSession` and reads the event off the funnel;
 * only the engine sessions and spawn preps are stubbed (as in
 * create-session-announce.test.ts).
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'

const { TEMP_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  return { TEMP_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'create-created-by-')) }
})

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('../../../core/services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../../core/opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../../core/pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../../core/codex/CodexSession', () => ({ CodexSession: class {} }))
vi.mock('../../../core/providers/claude-spawn-prep', () => ({
  claudeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/opencode/opencode-spawn-prep', () => ({
  opencodeSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/pi/pi-spawn-prep', () => ({
  piSpawnPrep: vi.fn(async (model?: string) => ({ resolvedModel: model }))
}))
vi.mock('../../../core/services/skill-scanner', () => ({ scanSkills: vi.fn(async () => []) }))
vi.mock('../../../core/services/claude-settings', () => ({ saveCleanupPeriodDays: vi.fn() }))
vi.mock('../../../core/services/ui-config', () => ({
  loadEngineConfig: () => ({}),
  saveSessionConfig: vi.fn()
}))
vi.mock('../../../core/services/cross-engine-dispatcher', () => ({
  crossEngineDispatcher: { dispatch: vi.fn(), stopDispatch: vi.fn(), disposeFor: vi.fn() },
  crossEngineDispatchAvailable: () => false
}))
vi.mock('../../../core/services/db', () => ({
  getSessionMeta: () => undefined,
  setSessionMeta: vi.fn()
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// Import AFTER mocks.
import { prepareAndCreateSession, type CreateSessionArgs } from '../../../core/ipc/create-session'
import { addSyncSubscriber, syncCore } from '../../../core/services/sync-host'
import type { SessionManager } from '../../../core/services/session-manager'

const RID = 'rid-created-by'

/** Create a session and return the payload of its `session:created` event. */
async function createdEvent(extra: Partial<CreateSessionArgs>): Promise<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = []
  const off = addSyncSubscriber((_seq, channel, args) => {
    if (channel === 'session:created' && args[0] === RID) seen.push(args[1] as never)
  })
  try {
    const manager = { create: vi.fn(), get: () => undefined } as unknown as SessionManager
    await prepareAndCreateSession(manager, null, {
      routingId: RID,
      cwd: '/r/repo',
      engineId: 'claude',
      ...extra
    })
  } finally {
    off()
  }
  expect(seen).toHaveLength(1)
  return seen[0]
}

afterEach(() => {
  syncCore.resetCanonicalForTests()
  vi.clearAllMocks()
})

afterAll(() => {
  fs.rmSync(TEMP_HOME, { recursive: true, force: true })
})

describe('session:created createdBy', () => {
  it('carries createdBy: agent for a session a session tool started', async () => {
    const event = await createdEvent({ createdBy: 'agent' })
    expect(event.createdBy).toBe('agent')
    // The rest of the birth config is what it always was.
    expect(event).toMatchObject({ cwd: '/r/repo', engineId: 'claude' })
  })

  it('carries no such key for any other session, so existing clients see the event they always did', async () => {
    const event = await createdEvent({})
    expect(event).not.toHaveProperty('createdBy')
    expect(Object.keys(event).sort()).toEqual(['cwd', 'engineId', 'resumeSessionId'])
  })

  it('is not folded into canonical: it only steers how a client reacts', async () => {
    await createdEvent({ createdBy: 'agent' })
    expect(syncCore.getCanonicalState().sessions[RID]).not.toHaveProperty('createdBy')
  })
})
