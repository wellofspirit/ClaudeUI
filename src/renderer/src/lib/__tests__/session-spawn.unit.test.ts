/**
 * Layer 1: `spawnSession`, the one renderer path that spawns an engine. The request it builds
 * for each resume mode and session state, and the steps it runs around the call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../../stores/session-store'
import { resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ModelInfo, SessionSpawnRequest } from '../../../../shared/types'

const steps: string[] = []

vi.mock('../session-history-load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../session-history-load')>()),
  awaitReloadBeforeSpawn: vi.fn(async () => {
    steps.push('reload')
  })
}))
vi.mock('../worktree-start', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../worktree-start')>()),
  createPendingWorktree: vi.fn(async () => {
    steps.push('worktree')
  })
}))

import { spawnSession } from '../session-spawn'

const ROUTE = 'sp-1'
const OPUS: ModelInfo = {
  value: 'opus',
  resolvedModel: 'claude-opus-5-5',
  displayName: 'Opus 5.5',
  description: '',
  engineId: 'claude',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
}

let createSession: ReturnType<typeof vi.fn>
const req = (): SessionSpawnRequest => createSession.mock.calls[0][1] as SessionSpawnRequest

/** Patch the session's fields; sealed ones are mirrored into the replica so they stick. */
function patchSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((s) => ({
    sessions: { ...s.sessions, [ROUTE]: { ...s.sessions[ROUTE], ...patch } }
  }))
  mirrorStoreIntoReplica()
}

beforeEach(() => {
  steps.length = 0
  resetReplicaSeam()
  createSession = vi.fn(async () => {
    steps.push('create')
  })
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    createSession
  }
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    availableModels: [OPUS]
  })
  mirrorStoreIntoReplica()
  useSessionStore.getState().createNewSession(ROUTE, '/proj')
  patchSession({ selectedModel: 'opus' })
})

describe('spawnSession: the request', () => {
  it('a new session: no resume, the resolved config, the announce', async () => {
    patchSession({ effort: 'low', thinkingMode: 'disabled', permissionMode: 'plan' })
    await spawnSession(ROUTE)
    expect(req()).toMatchObject({
      cwd: '/proj',
      engineId: 'claude',
      config: { model: 'opus', effort: 'low', permissionMode: 'plan' },
      announce: { effort: 'low', thinkingMode: 'disabled' }
    })
    expect(req().resume).toBeUndefined()
  })

  it('a historical session resumes its own id', async () => {
    patchSession({ isHistorical: true })
    await spawnSession(ROUTE)
    expect(req().resume).toEqual({ sessionId: ROUTE })
  })

  it('opencode resumes its own id with no local transcript', async () => {
    patchSession({ selectedEngineId: 'opencode', selectedModel: 'opencode/free' })
    await spawnSession(ROUTE)
    expect(req().engineId).toBe('opencode')
    expect(req().resume).toEqual({ sessionId: ROUTE })
  })

  it('a fork that has not materialised branches from its source at the anchor', async () => {
    patchSession({
      isHistorical: true,
      forkOrigin: { sourceSessionId: 'src-1', anchorUuid: 'a-1' }
    })
    await spawnSession(ROUTE)
    expect(req().resume).toEqual({ sessionId: 'src-1', at: 'a-1', fork: true })
  })

  it('a fork that has materialised (no forkOrigin) resumes itself', async () => {
    patchSession({ isHistorical: true, forkOrigin: null })
    await spawnSession(ROUTE)
    expect(req().resume).toEqual({ sessionId: ROUTE })
  })

  it("'self' resumes its own id for an active session, fork pointer or not", async () => {
    patchSession({ sdkActive: true, forkOrigin: { sourceSessionId: 's', anchorUuid: 'a' } })
    await spawnSession(ROUTE, { resume: 'self' })
    expect(req().resume).toEqual({ sessionId: ROUTE })
  })

  it("'none' starts a new session even when the session is historical", async () => {
    patchSession({ isHistorical: true })
    await spawnSession(ROUTE, { resume: 'none' })
    expect(req().resume).toBeUndefined()
  })

  it('permissionMode overrides the session mode', async () => {
    patchSession({ permissionMode: 'default' })
    await spawnSession(ROUTE, { permissionMode: 'acceptEdits' })
    expect(req().config?.permissionMode).toBe('acceptEdits')
  })

  it('`from` resolves model, effort, thinking mode and engine from the snapshot, not the store', async () => {
    patchSession({ effort: 'low', thinkingMode: 'disabled' })
    const snapshot = useSessionStore.getState().sessions[ROUTE]
    patchSession({ selectedModel: '', effort: null, thinkingMode: null })
    await spawnSession(ROUTE, { resume: 'none', from: snapshot })
    expect(req().config).toMatchObject({ model: 'opus', effort: 'low' })
    expect(req().announce).toMatchObject({ thinkingMode: 'disabled' })
  })

  it('carries the stored reasoning variant, and none when the session has no pick', async () => {
    patchSession({ selectedEngineId: 'opencode', selectedModel: 'opencode/free' })
    await spawnSession(ROUTE)
    expect(req().config).not.toHaveProperty('reasoningVariant')

    createSession.mockClear()
    patchSession({ reasoningVariant: 'high' })
    await spawnSession(ROUTE)
    expect(req().config?.reasoningVariant).toBe('high')
  })
})

describe('spawnSession: the steps', () => {
  it('runs reload, worktree, create once each in that order, and marks the session active last', async () => {
    let activeDuringCreate: boolean | undefined
    createSession.mockImplementation(async () => {
      activeDuringCreate = useSessionStore.getState().sessions[ROUTE].sdkActive
      steps.push('create')
    })
    await spawnSession(ROUTE)
    expect(steps).toEqual(['reload', 'worktree', 'create'])
    expect(activeDuringCreate).toBe(false)
    expect(useSessionStore.getState().sessions[ROUTE].sdkActive).toBe(true)
  })

  it('marks nothing when the create rejects', async () => {
    createSession.mockRejectedValue(new Error('spawn failed'))
    await expect(spawnSession(ROUTE)).rejects.toThrow('spawn failed')
    expect(useSessionStore.getState().sessions[ROUTE].sdkActive).toBe(false)
  })

  it('refuses an unresolved model before the worktree or the create', async () => {
    useSessionStore.setState({ claudeDefaultModelConfigured: true })
    patchSession({ selectedModel: '' })
    await expect(spawnSession(ROUTE)).rejects.toThrow(/No model selected/)
    expect(steps).toEqual(['reload'])
    expect(createSession).not.toHaveBeenCalled()
  })
})
