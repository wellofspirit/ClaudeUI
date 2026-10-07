/**
 * opencode 2.x contract: path deny rules in a session that runs in a
 * SUB-DIRECTORY of a git repo (ADR-097 §3, S6 review #1). 2.x asks with the
 * path relative to the session directory for any file in the worktree, so an
 * edit of `<repo>/secrets/x` from `<repo>/pkg` is asked as `../secrets/x`;
 * `deny Edit(//<repo>/secrets/**)` must still block it.
 *
 * The shared fixture provider has no marker for an arbitrary path, so this file
 * scripts its own tiny OpenAI-compatible model: `[edit-up]` edits
 * `../secrets/x` (alpha → beta); after a tool result it answers in text.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildSessionRuleset } from '../../core/opencode/permission-v2'
import type { FixtureProvider } from './harness/fixture-provider'
import { describeV2, fixtureConfig, nonce, useRig } from './harness/host'

interface Scripted {
  readonly baseURL: string
  readonly toolsSeen: string[][]
  close(): Promise<void>
}

async function startScriptedModel(): Promise<Scripted> {
  const toolsSeen: string[][] = []
  let n = 0
  const server: Server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model' }] }))
        return
      }
      n++
      const body = JSON.parse(raw || '{}') as {
        messages?: { role: string; content: unknown }[]
        tools?: { function?: { name?: string } }[]
      }
      const tools = (body.tools ?? []).map((t) => t.function?.name ?? '')
      const messages = body.messages ?? []
      const last = messages.at(-1)
      const text = JSON.stringify(messages.filter((m) => m.role === 'user').at(-1)?.content ?? '')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (delta: object, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-paths',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fixture-model',
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        )
      const end = (finish: string) => {
        chunk({}, finish)
        res.end('data: [DONE]\n\n')
      }
      if (tools.length > 0 && last?.role !== 'tool' && text.includes('[edit-up]')) {
        toolsSeen.push(tools)
        chunk({ role: 'assistant', content: null })
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `call_paths_${n}`,
              type: 'function',
              function: {
                name: 'edit',
                arguments: JSON.stringify({
                  path: '../secrets/x',
                  oldString: 'alpha',
                  newString: 'beta'
                })
              }
            }
          ]
        })
        return end('tool_calls')
      }
      chunk({ role: 'assistant', content: last?.role === 'tool' ? 'TOOL_RESULT_SEEN' : 'ok' })
      end('stop')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    toolsSeen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

describeV2('opencode 2.x contract: path rules from a sub-directory session', () => {
  let model: Scripted
  beforeAll(async () => {
    model = await startScriptedModel()
  })
  afterAll(async () => model?.close())
  const rig = useRig('paths', {
    config: () => fixtureConfig({ baseURL: model.baseURL } as FixtureProvider)
  })

  /** `<cwd>` as a git repo with `secrets/x` = alpha, and the `pkg` sub-directory. */
  function repo() {
    const root = rig().cwd
    execFileSync('git', ['init', '-q'], { cwd: root })
    mkdirSync(join(root, 'secrets'), { recursive: true })
    mkdirSync(join(root, 'pkg'), { recursive: true })
    writeFileSync(join(root, 'secrets', 'x'), 'alpha\n')
    return { root, pkg: join(root, 'pkg'), secret: join(root, 'secrets', 'x') }
  }

  async function editUp(denies: string[]) {
    const r = rig()
    const { root, pkg, secret } = repo()
    const { rules } = buildSessionRuleset({
      mode: 'acceptEdits',
      autoMode: false,
      permissions: {
        allow: [],
        ask: [],
        deny: denies.map((d) => d.replace('<repo>', root)),
        additionalDirectories: [],
        defaultMode: undefined
      },
      mcpServers: ['claudeui'],
      cwd: pkg
    })
    const created = await r.api.ok('session.create', {
      body: { location: { directory: pkg }, permissions: rules }
    })
    const sessionID = created.data.id
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID },
      body: { text: `[edit-up] ${nonce('paths')}` },
      directory: pkg
    })
    const end = await r.feed.waitForTurnEnd(sessionID, from)
    return {
      end,
      content: readFileSync(secret, 'utf8'),
      asked: r.feed.select('permission.asked', { sessionID, after: from }),
      failed: r.feed.select('session.tool.failed', { sessionID, after: from })
    }
  }

  it('control: without a rule, acceptEdits edits ../secrets/x (the call reaches the file)', async () => {
    const { content, failed, end } = await editUp([])
    expect(failed).toHaveLength(0)
    expect(content).toBe('beta\n')
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('deny Edit(//<repo>/secrets/**) blocks the edit asked as ../secrets/x', async () => {
    const { content, failed, asked, end } = await editUp(['Edit(/<repo>/secrets/**)'])
    expect(asked).toHaveLength(0)
    expect(failed.map((e) => e.data.error)).toEqual([
      { type: 'permission.rejected', message: 'Permission denied: edit' }
    ])
    expect(content).toBe('alpha\n')
    expect(end.type).toBe('session.execution.succeeded')
  })
})
