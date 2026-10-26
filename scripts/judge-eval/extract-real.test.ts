import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { convertPiSessionEntries } from '../../src/core/services/pi-session-list'
import { convertOpencodeHistory } from '../../src/core/opencode/history'
import { inTimeOrder, recordTrajectoryMessage } from '../../src/core/automode/trajectory'
import { DispatchTargetJudge } from '../../src/core/services/dispatch-target-judge'
import { cardsFor, extractReal, redact } from './extract-real'

type Row = Record<string, any>
const denied = 'Auto mode blocked: synthetic refusal'
const timestamp = (n: number) => new Date(n * 1000).toISOString()
const entry = (id: string, parentId: string | null, n: number, message: Row) => ({
  type: 'message',
  id,
  parentId,
  timestamp: timestamp(n),
  message: { ...message, timestamp: n * 1000 }
})
const user = (id: string, parent: string | null, n: number, text: string) =>
  entry(id, parent, n, { role: 'user', content: [{ type: 'text', text }] })
const call = (
  id: string,
  parent: string,
  n: number,
  callId: string,
  name = 'bash',
  args: Row = { command: 'echo fixture' }
) =>
  entry(id, parent, n, {
    role: 'assistant',
    content: [{ type: 'toolCall', id: callId, name, arguments: args }]
  })
const result = (
  id: string,
  parent: string,
  n: number,
  callId: string,
  text = denied,
  isError = true,
  details?: Row
) =>
  entry(id, parent, n, {
    role: 'toolResult',
    toolCallId: callId,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    details
  })
function fixture(home = mkdtempSync(join(tmpdir(), 'replay-fixture-'))) {
  function pi(id: string, rows: Row[], child: boolean | 'dispatch' = false) {
    const dir = join(
      home,
      child === 'dispatch'
        ? '.claude/ui/dispatch/pi'
        : child
          ? '.claude/ui/pi-subagents'
          : '.pi/agent/sessions',
      id
    )
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `fixture_${id}.jsonl`)
    writeFileSync(
      file,
      [{ type: 'session', id, cwd: home }, ...rows].map((r) => JSON.stringify(r)).join('\n')
    )
    return file
  }
  return { home, pi }
}
const convertPi = (rows: Row[]) =>
  convertPiSessionEntries(rows as Parameters<typeof convertPiSessionEntries>[0])

function opencodeDb(home: string, sessions: Array<{ id: string; parent?: string; rows: Row[] }>) {
  const file = join(home, 'opencode.db')
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE session_v2 (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE session_message (id TEXT, type TEXT, session_id TEXT, seq INTEGER, time_created INTEGER, data TEXT)'
  )
  for (const session of sessions) {
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run(
      session.id,
      home,
      session.parent ?? null
    )
    for (const [index, row] of session.rows.entries())
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
        row.id,
        row.type,
        session.id,
        index + 1,
        row.time.created,
        JSON.stringify({ ...row, id: undefined, type: undefined })
      )
  }
  db.close()
  return file
}
const ocUser = (id: string, created: number, text: string) => ({
  id,
  type: 'user',
  text,
  time: { created }
})
const ocCall = (
  id: string,
  created: number,
  callId: string,
  input: Row = { command: 'echo fixture' },
  name = 'bash'
) => ({
  id,
  type: 'assistant',
  agent: 'build',
  time: { created },
  content: [
    {
      type: 'tool',
      id: callId,
      name,
      time: { created },
      state: { status: 'error', input, error: { type: 'denied', message: denied } }
    }
  ]
})

describe('real replay extraction on synthetic histories', () => {
  it('uses the pi decision branch, excludes its result and future sibling, and redacts secrets', async () => {
    const f = fixture()
    const rows = [
      user('u', null, 1, 'inspect fixture'),
      call('a', 'u', 2, 'old'),
      result('r', 'a', 3, 'old'),
      call('b', 'r', 4, 'current'),
      result('s', 'b', 5, 'current'),
      user('fork', 'u', 6, 'future sibling')
    ]
    rows[0].message.content.push({ type: 'image', mimeType: 'image/png', data: 'fake-image' })
    f.pi('root-fixture', rows)
    const extracted = await extractReal({ home: f.home })
    const c = extracted.cases.find((c) => c.real.callId === 'current')!
    const clean = structuredClone(rows.slice(0, 4))
    clean[0].message.content.pop()
    expect(c.messages).toEqual(convertPi(clean))
    expect(c.action).toEqual({ toolName: 'bash', input: { command: 'echo fixture' } })
    expect(c.outcomes).toEqual({ old: 'automode-blocked' })
    expect(c.messages.at(-1)?.content).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'current',
        toolName: 'bash',
        toolInput: { command: 'echo fixture' }
      }
    ])
    const secret = 'sk-ant-syntheticSecret1234567890'
    const secretRows = [
      user('su', null, 1, secret),
      call('sa', 'su', 2, 'secret-call', 'bash', { command: `echo ${secret}` }),
      result('sr', 'sa', 3, 'secret-call', `${denied} ${secret}`)
    ]
    const file = f.pi('secret-fixture', secretRows)
    const safe = (await extractReal({ home: f.home })).cases.find(
      (c) => c.real.sessionId === 'secret-fixture'
    )!
    expect(JSON.stringify(safe)).not.toContain(secret)
    expect(safe.real.redactions['provider-key']).toBe(5)
    expect(cardsFor([safe])).not.toContain(secret)
    expect(readFileSync(file, 'utf8')).toContain(secret)
  })

  it('uses root human turns and assistant-only bounded trajectory for a native pi child', async () => {
    const f = fixture()
    const childId = '00000000-0000-4000-8000-000000000001'
    const task = {
      subagent_type: 'reviewer',
      description: 'Review fixture',
      prompt: 'child kickoff'
    }
    const root = [
      user('u', null, 1, 'human request'),
      call('launch', 'u', 2, 'launch-call', 'agent', task),
      result('linked', 'launch', 3, 'launch-call', 'started', false, {
        cuiAgent: { agentId: childId }
      }),
      user('consent', 'linked', 6, 'continue fixture')
    ]
    f.pi('root-parent', root)
    const child = [
      user('cu', null, 3, task.prompt),
      call('ca', 'cu', 4, 'previous'),
      result('cr', 'ca', 5, 'previous'),
      call('cb', 'cr', 7, 'current'),
      result('cs', 'cb', 8, 'current')
    ]
    f.pi(childId, child, true)
    const c = (await extractReal({ home: f.home })).cases.find((c) => c.real.callId === 'current')!
    const trajectory = new Map()
    for (const message of convertPi(child.slice(0, 4))) recordTrajectoryMessage(trajectory, message)
    expect(c.messages).toEqual(inTimeOrder(convertPi(root), [], trajectory.values()))
    expect(c.action).toEqual({
      toolName: 'bash',
      input: { command: 'echo fixture' },
      subagent: { type: 'reviewer', description: task.description, prompt: task.prompt }
    })
    expect(c.outcomes).toEqual({ previous: 'automode-blocked' })
    expect(c.messages.filter((m) => m.role === 'user').flatMap((m) => m.content)).toEqual([
      { type: 'text', text: 'human request' },
      { type: 'text', text: 'continue fixture' }
    ])
  })

  it('includes an allowed call only on request, with stable ids and no own outcome', async () => {
    const f = fixture()
    const rows = [
      user('u', null, 1, 'fixture'),
      call('a', 'u', 2, 'allowed'),
      result('r', 'a', 3, 'allowed', 'done', false),
      call('b', 'r', 4, 'blocked'),
      result('s', 'b', 5, 'blocked')
    ]
    f.pi('included-root', rows)
    const normal = await extractReal({ home: f.home })
    const included = await extractReal({ home: f.home, include: ['pi:included-root:allowed'] })
    expect(normal.cases).toHaveLength(1)
    expect(included.cases).toHaveLength(2)
    expect(included.cases.find((c) => c.real.callId === 'blocked')!.id).toBe(normal.cases[0].id)
    const c = included.cases.find((c) => c.real.callId === 'allowed')!
    expect(c.messages).toEqual(convertPi(rows.slice(0, 2)))
    expect(c.action).toEqual({ toolName: 'bash', input: { command: 'echo fixture' } })
    expect(c.outcomes).toEqual({})
    expect(included.stats['pi-root']).toEqual({ denies: 1, built: 2, skipped: {} })
  })

  it('reads canonical SQLite rows read-only and masks the current opencode result', async () => {
    const f = fixture()
    const dbFile = join(f.home, 'fixture.db')
    const db = new DatabaseSync(dbFile)
    const tool = (id: string, error = denied) => ({
      type: 'tool',
      id,
      name: 'bash',
      state: {
        status: 'error',
        input: { command: 'echo fixture' },
        error: { type: 'denied', message: error }
      },
      time: { created: 2000 }
    })
    const rows = [
      { id: 'u', type: 'user', text: 'human fixture', time: { created: 1000 } },
      {
        id: 'a',
        type: 'assistant',
        agent: 'build',
        content: [tool('old')],
        time: { created: 2000 }
      },
      {
        id: 'b',
        type: 'assistant',
        agent: 'build',
        content: [tool('current')],
        time: { created: 3000 }
      }
    ]
    db.exec(
      'CREATE TABLE session_v2 (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE session_message (id TEXT, type TEXT, session_id TEXT, seq INTEGER, time_created INTEGER, data TEXT)'
    )
    db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?)').run('ses_fixture', f.home, null)
    for (const [index, row] of rows.entries())
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
        row.id,
        row.type,
        'ses_fixture',
        index + 10,
        row.time.created,
        JSON.stringify({ ...row, id: undefined, type: undefined })
      )
    db.close()
    const before = readFileSync(dbFile)
    const extracted = await extractReal({ home: f.home, opencodeDb: dbFile })
    const c = extracted.cases.find((c) => c.real.callId === 'current')!
    const expected = structuredClone(rows)
    expected[2].content![0].state = { status: 'running', input: { command: 'echo fixture' } } as any
    expect(c.messages).toEqual(
      convertOpencodeHistory(expected as Parameters<typeof convertOpencodeHistory>[0]).messages
    )
    expect(c.action).toEqual({ toolName: 'bash', input: { command: 'echo fixture' } })
    expect(c.outcomes).toEqual({ old: 'automode-blocked' })
    expect(c.real.line).toBe(12)
    expect(readFileSync(dbFile)).toEqual(before)
  })

  it('screens nested values and keys with kind-tagged counts', () => {
    const counts = {}
    const safe = redact(
      {
        nested: ['ghp_syntheticToken123456', 'password=syntheticPassword123'],
        AKIA1234567890123456: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'
      },
      counts
    )
    expect(safe).toEqual({
      nested: ['[REDACTED:github-token]', '[REDACTED:secret-assignment]'],
      '[REDACTED:aws-key]': '[REDACTED:private-key]'
    })
    expect(counts).toEqual({
      'github-token': 1,
      'secret-assignment': 1,
      'aws-key': 1,
      'private-key': 1
    })
  })

  it.each(['pi', 'opencode'] as const)(
    'assembles a %s dispatch target through the production judge merger',
    async (engine) => {
      const f = fixture()
      const prompt = 'delegated fixture task'
      const root = [
        user('u', null, 1, 'human dispatch'),
        call('launch', 'u', 2, 'dispatch-call', 'dispatch_agent', { prompt }),
        user('later', 'launch', 10, 'future human')
      ]
      f.pi('parent', root)
      const piTarget = [
        user('tu', null, 3, prompt),
        call('ta', 'tu', 4, 'target-call'),
        result('tr', 'ta', 5, 'target-call')
      ]
      const ocTarget = [ocUser('tu', 3000, prompt), ocCall('ta', 4000, 'target-call')]
      let database: string | undefined
      if (engine === 'pi') {
        f.pi('target', piTarget, 'dispatch')
      } else database = opencodeDb(f.home, [{ id: 'target', rows: ocTarget }])
      const ledgerDir = join(f.home, '.claude/ui')
      mkdirSync(ledgerDir, { recursive: true })
      const ledger = new DatabaseSync(join(ledgerDir, 'operational.db'))
      ledger.exec(
        'CREATE TABLE dispatch_target (id TEXT, engine TEXT, parent_session_id TEXT, parent_engine TEXT, parent_tool_use_id TEXT, harness_ref TEXT, model TEXT, caller_restriction TEXT)'
      )
      ledger
        .prepare('INSERT INTO dispatch_target VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('ledger', engine, 'parent', 'pi', 'dispatch-call', 'target', 'fixture-model', null)
      ledger.close()
      const extracted = await extractReal({ home: f.home, opencodeDb: database })
      const c = extracted.cases.find((c) => c.real.route === `dispatch-${engine}`)!
      const target =
        engine === 'pi'
          ? convertPi(piTarget.slice(0, 2))
          : convertOpencodeHistory([
              ocTarget[0],
              {
                ...ocTarget[1],
                content: [
                  {
                    ...ocTarget[1].content![0],
                    state: { status: 'running', input: { command: 'echo fixture' } }
                  }
                ]
              }
            ] as Parameters<typeof convertOpencodeHistory>[0]).messages
      const trajectory = new Map()
      for (const message of target) recordTrajectoryMessage(trajectory, message)
      const production = new DispatchTargetJudge({
        engine,
        cwd: f.home,
        routingId: 'parent',
        sessionId: () => 'target',
        model: () => 'fixture-model',
        emit: () => () => {},
        messages: () => convertPi(root.slice(0, 2)),
        trajectory: () => trajectory.values(),
        subagent: () => undefined,
        loadEngineConfig: () => ({}),
        peekModels: () => null
      })
      expect(c.messages).toEqual(production.judgeMessages())
      expect(c.action).toEqual({
        toolName: 'bash',
        input: { command: 'echo fixture' },
        subagent: { type: `dispatch:${engine}`, description: 'fixture-model', prompt }
      })
      expect(c.outcomes).toEqual({})
      expect(extracted.cases).toHaveLength(1)
      expect(c.messages.filter((m) => m.role === 'user')).toEqual(convertPi(root.slice(0, 1)))
    }
  )

  it('faithfully gives an opencode child the root transcript and root outcomes only', async () => {
    const f = fixture()
    const root = [
      ocUser('u', 1000, 'root human'),
      ocCall('a', 2000, 'root-deny'),
      ocCall('launch', 3000, 'launch-call', { agent: 'reviewer', prompt: 'kickoff' }, 'subagent')
    ]
    const child = [
      ocUser('cu', 3500, 'kickoff'),
      ocCall('ca', 4000, 'child-old'),
      ocCall('cb', 5000, 'child-current')
    ]
    const db = opencodeDb(f.home, [
      { id: 'ses_root', rows: root },
      { id: 'ses_child', parent: 'ses_root', rows: child }
    ])
    const c = (await extractReal({ home: f.home, opencodeDb: db })).cases.find(
      (c) => c.real.callId === 'child-current'
    )!
    expect(c.messages).toEqual(
      convertOpencodeHistory(root as Parameters<typeof convertOpencodeHistory>[0]).messages
    )
    expect(c.outcomes).toEqual({
      'root-deny': 'automode-blocked',
      'launch-call': 'automode-blocked'
    })
    expect(c.real.fidelity).toContain('child outcomes absent in production')
    expect(JSON.stringify(c.messages)).not.toContain('child-current')
    expect(c.action.subagent).toEqual({ type: 'reviewer', prompt: 'kickoff' })
  })

  it('loads a Claude dispatch parent through the production loader at the timestamp anchor', async () => {
    // The production loader resolves ~/.claude/projects at import time, so this fixture must
    // live under homedir() — which the unit project's setup redirects into the temp dir.
    // Refuse to write anything if it did not (e.g. run outside that setup).
    if (!resolve(homedir()).startsWith(resolve(tmpdir())))
      throw new Error('homedir() is not redirected into the temp dir; refusing to write fixtures')
    const f = fixture(homedir())
    const projectKey = 'synthetic-replay-project'
    const sessionId = 'synthetic-claude-parent'
    const project = join(f.home, '.claude/projects', projectKey)
    mkdirSync(project, { recursive: true })
    const rows = [
      {
        type: 'user',
        uuid: 'human',
        timestamp: timestamp(1),
        message: { role: 'user', content: 'human fixture' }
      },
      {
        type: 'assistant',
        uuid: 'launch',
        timestamp: timestamp(2),
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'dispatch-call',
              name: 'mcp__claudeui__dispatch_agent',
              input: { prompt: 'delegated fixture' }
            }
          ]
        }
      },
      {
        type: 'user',
        uuid: 'future-result',
        timestamp: timestamp(9),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'dispatch-call', content: 'future result' }]
        }
      }
    ]
    writeFileSync(
      join(project, `${sessionId}.jsonl`),
      rows.map((r) => JSON.stringify(r)).join('\n')
    )
    f.pi(
      'claude-target',
      [
        user('u', null, 3, 'kickoff'),
        call('a', 'u', 4, 'target-call'),
        result('r', 'a', 5, 'target-call')
      ],
      'dispatch'
    )
    const ledgerDir = join(f.home, '.claude/ui')
    mkdirSync(ledgerDir, { recursive: true })
    const ledger = new DatabaseSync(join(ledgerDir, 'operational.db'))
    // The redirected home is per worker PROCESS, so an earlier test file in the same worker may
    // have left this database (with the app's own schema) behind.
    ledger.exec('DROP TABLE IF EXISTS dispatch_target')
    ledger.exec(
      'CREATE TABLE dispatch_target (id TEXT, engine TEXT, parent_session_id TEXT, parent_engine TEXT, parent_tool_use_id TEXT, harness_ref TEXT, model TEXT, caller_restriction TEXT)'
    )
    ledger
      .prepare('INSERT INTO dispatch_target VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'ledger',
        'pi',
        sessionId,
        'claude',
        'dispatch-call',
        'claude-target',
        'fixture-model',
        null
      )
    ledger.close()
    const { loadSessionHistory } = await import('../../src/core/services/session-history')
    const parent = (
      await loadSessionHistory(sessionId, projectKey, 'launch', { deferStatusLine: true })
    ).messages
    const c = (await extractReal({ home: f.home })).cases.find(
      (c) => c.real.sessionId === 'claude-target'
    )!
    const own = convertPi([user('u', null, 3, 'kickoff'), call('a', 'u', 4, 'target-call')]).filter(
      (m) => m.role === 'assistant'
    )
    expect(c.messages).toEqual(inTimeOrder(parent, [], own))
    expect(JSON.stringify(c.messages)).not.toContain('future result')
    expect(c.action.subagent).toEqual({
      type: 'dispatch:pi',
      description: 'fixture-model',
      prompt: 'delegated fixture'
    })
    expect(c.outcomes).toEqual({})
  })
})
