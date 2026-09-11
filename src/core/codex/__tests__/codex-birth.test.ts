// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import type { CodexClientOptions } from '../CodexAppServerClient'
import { SessionManager } from '../../services/session-manager'
import { prepareAndCreateSession } from '../../ipc/create-session'
import { emitEvent, syncCore } from '../../services/sync-host'
import { fromSnapshot } from '../../shared/sync/state'

const fake = vi.hoisted(() => ({
  options: undefined as CodexClientOptions | undefined,
  request: vi.fn()
}))
vi.mock('../CodexClient', () => ({
  CodexClient: class {
    constructor(options: CodexClientOptions) {
      fake.options = options
    }
    start = vi.fn(async () => ({}))
    request = fake.request
    dispose = vi.fn()
    abortServerRequests = vi.fn()
  }
}))
vi.mock('../codex-locate', () => ({ codexBinaryAvailable: () => true }))
vi.mock('../../services/claude-session', () => ({ ClaudeSession: class {} }))
vi.mock('../../opencode/OpencodeSession', () => ({ OpencodeSession: class {} }))
vi.mock('../../pi/PiSession', () => ({ PiSession: class {} }))
vi.mock('../../providers/claude-spawn-prep', () => ({ claudeSpawnPrep: vi.fn() }))
vi.mock('../../opencode/opencode-spawn-prep', () => ({ opencodeSpawnPrep: vi.fn() }))
vi.mock('../../pi/pi-spawn-prep', () => ({ piSpawnPrep: vi.fn() }))
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({ sandbox: { enabled: true } })
}))
vi.mock('../../services/db', () => ({
  setSessionMeta: vi.fn(),
  getSessionMeta: () => undefined,
  renameDispatchedUsage: vi.fn(),
  appendAuditLog: vi.fn(),
  getCodexSessionOverrides: () => undefined,
  hasCodexSessionOverrides: () => false,
  ensureCodexSessionOverrides: vi.fn(),
  setCodexSessionOverrides: vi.fn()
}))
vi.mock('../../services/engine-history', () => ({ readSessionHistory: vi.fn() }))

let manager: SessionManager | undefined
afterEach(() => {
  manager?.cancelAll()
  manager?.disposeRekeyObserver()
  syncCore.resetCanonicalForTests()
})

it('birth, identity acknowledgement, native commands and reconnect agree without a window', async () => {
  const inherited = {
    approvalPolicy: { granular: { rules: true } },
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: null
  }
  fake.request.mockImplementation(async (method, params) => {
    if (method === 'config/read') return { config: { model: 'native', model_provider: 'openai' } }
    if (method === 'account/read') return { account: null }
    if (method === 'model/list')
      return {
        data: [
          {
            model: 'native',
            supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Native ultra' }],
            inputModalities: ['text']
          }
        ],
        nextCursor: null
      }
    if (method === 'thread/start')
      return {
        thread: { id: 'root' },
        model: 'native',
        modelProvider: 'openai',
        reasoningEffort: null,
        ...inherited
      }
    if (method === 'turn/start') {
      fake.options!.onNotification!('turn/started', { threadId: 'root', turn: { id: 'turn' } })
      fake.options!.onNotification!('item/completed', {
        threadId: 'root',
        turnId: 'turn',
        item: {
          type: 'userMessage',
          id: 'native-user',
          clientId: params.clientUserMessageId,
          content: params.input
        }
      })
      return { turn: { id: 'turn', status: 'inProgress', items: [] } }
    }
    if (method === 'thread/settings/update')
      fake.options!.onNotification!('thread/settings/updated', {
        threadId: 'root',
        threadSettings: {
          ...inherited,
          sandboxPolicy: inherited.sandbox,
          model: 'native',
          modelProvider: 'openai',
          effort: params.effort ?? null
        }
      })
    return {}
  })
  manager = new SessionManager()
  await prepareAndCreateSession(manager, null, {
    routingId: 'temporary',
    cwd: '/isolated',
    engineId: 'codex',
    permissionMode: 'auto'
  })
  emitEvent('session:user-message', [
    'temporary',
    { id: 'msg-host', timestamp: 1, prompt: 'hello' }
  ])
  await manager.get('temporary')!.run('hello', undefined, 'msg-host')
  const native = manager.get('root')!
  expect(native.routingId).toBe('root')
  // `auto` maps to Codex's own auto_review reviewer under on-request; every
  // other mode runs `untrusted` so ClaudeUI's gate sees every action.
  expect(fake.request).toHaveBeenCalledWith('thread/start', {
    cwd: '/isolated',
    model: 'native',
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    approvalsReviewer: 'auto_review',
    allowProviderModelFallback: false,
    historyMode: 'paginated'
  })
  const snapshot = syncCore.getSnapshot()
  expect(snapshot.sessions.root.messages).toHaveLength(1)
  expect(snapshot.sessions.root.messages[0]).toMatchObject({
    role: 'user',
    replacesMessageId: 'msg-host'
  })
  expect(snapshot.sessions.root.permissionMode).toBe('auto')
  expect(snapshot.sessions.root.selectedModel).toBe('native')
  expect(snapshot.sessions.root.codexModelExplicit).toBe(false)
  expect(snapshot.sessionEngines?.root.model?.modelId).toBe('native')
  // Native policy is no longer mirrored into replicated state — ClaudeUI owns it.
  expect(snapshot.sessions.root.status.codex).toEqual({
    modelProvider: 'openai',
    reasoningEffort: null,
    effortOptions: [{ value: 'ultra', description: 'Native ultra' }],
    overrides: {}
  })

  const controller = new AbortController()
  const pending = fake.options!.onServerRequest!(
    'item/commandExecution/requestApproval',
    {
      threadId: 'root',
      turnId: 'turn',
      itemId: 'command',
      availableDecisions: ['decline', 'cancel']
    },
    { id: 1, signal: controller.signal }
  )
  const approval = syncCore.getSnapshot().sessions.root.pendingApprovals[0]
  // A command approval is a STANDARD card: no engine-specific payload, and the
  // shared `session:approval-response` path answers it.
  expect(approval.codex).toBeUndefined()
  expect(approval.toolName).toBe('commandExecution')
  native.resolveApproval!(approval.requestId, 'deny')
  expect(await pending).toEqual({ decision: 'decline' })
  // Effort travels over the engine-neutral `session:set-effort` command, which
  // lands on ISession.setEffort — no native settings channel in between.
  await native.setEffort!('ultra')
  const restored = fromSnapshot(syncCore.getSnapshot())
  expect(restored.sessions.root.pendingApprovals).toEqual([])
  expect(restored.sessions.root.status.codex?.reasoningEffort).toBe('ultra')
  expect(restored.sessions.root.permissionMode).toBe('auto')
})
