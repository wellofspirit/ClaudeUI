/**
 * opencode 2.x contract: Claude Code agent definitions injected as opencode
 * agents (ADR-103, `claude-agent-shim.ts`, `opencode-server-config.ts`).
 *
 * The block is built the way the server manager builds it: real definition
 * files in an isolated "Claude home" and project, read by the shim, merged by
 * `buildOpencodeConfig`, and handed to the real binary as
 * `OPENCODE_CONFIG_CONTENT`. The model is the in-process fixture only.
 *
 * Proven against the pinned binary:
 *  (a) injected agents are listed by `agent.list` as subagents, their own
 *      rules last and deny-only, with the ClaudeUI preamble in `system`;
 *  (b) the `subagent` tool launches one, on the model its file names, and the
 *      child runs on the file's body;
 *  (c) a child whose `tools` list leaves out Edit/Write is not offered edit,
 *      write or patch — and an agent that names Edit still edits;
 *  (d) such a child can still read a path outside the workspace that the
 *      parent allows, even after the host's child ruleset is applied
 *      (`childSessionRuleset`): no deny-all, so `external_directory` stays;
 *  (e) through the production spawn, an MCP server the user configured natively
 *      in opencode.json is denied to a tools-list agent, and a Claude agent that
 *      shares a name with a JSON-only native agent is not injected, so the native
 *      agent is not rewritten.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  CLAUDE_AGENT_PREAMBLE,
  loadClaudeAgentsForOpencode
} from '../../core/opencode/claude-agent-shim'
import { opencodeNativeAgentNames } from '../../core/opencode/opencode-config-sources'
import { buildOpencodeConfig } from '../../core/opencode/opencode-server-config'
import { childSessionRuleset } from '../../core/opencode/subagent-permissions'
import type { Config_InfoEncoded } from '../../core/opencode/protocol-v2/openapi'
import { messageText, NOTES_FILE } from './harness/fixture-provider'
import { OpencodeServerManager, locatePluginDir } from '../../core/opencode/OpencodeServerManager'
import { endStdioServer, spawnStdioServer } from '../../core/opencode/opencode-server-spawn'
import type { HarnessLaunch } from '../../core/harness/launch'
import { startFixtureProvider, type FixtureProvider } from './harness/fixture-provider'
import {
  createApi,
  createHome,
  describeV2,
  fixtureConfig,
  isolatedEnv,
  nonce,
  SANDBOX_AVAILABLE,
  sandboxProfile,
  startRefusingProxy,
  useRig,
  V2_BIN,
  type RefusingProxy,
  type Rig,
  type TestHome
} from './harness/host'

const ORCH_READER = `---
name: orch-reader
description: Collects evidence for the orchestrator.
model: sonnet
tools: Read, Grep, Glob, Bash, WebFetch, WebSearch
harness:
  opencode:
    model: fixture/fixture-model
---
You collect evidence. You never edit.
`

const EDITOR = `---
name: editor
description: Edits files.
tools: Read, Edit
---
You edit files.
`

const PROJECT_ONE = `---
name: project-one
description: A repository agent.
harness:
  opencode:
    model: fixture/fixture-model
---
You belong to the repository.
`

/** Writes the definitions and returns the injected `agents` block, as the manager would build it. */
function injectedConfig(fixture: Parameters<typeof fixtureConfig>[0], home: TestHome) {
  const userDir = join(home.root, 'claude-home', 'agents')
  mkdirSync(userDir, { recursive: true })
  writeFileSync(join(userDir, 'orch-reader.md'), ORCH_READER)
  writeFileSync(join(userDir, 'editor.md'), EDITOR)
  const cwd = home.workspace('main')
  mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(cwd, '.claude', 'agents', 'project-one.md'), PROJECT_ONE)
  const shim = loadClaudeAgentsForOpencode({
    cwd,
    mcpServers: [],
    nativeAgentNames: [],
    modelAllowlist: {},
    claudeUserAgentsDir: userDir
  })
  expect(shim.diagnostics).toEqual([]) // the project file's model is honoured, so nothing is said
  const agents = buildOpencodeConfig({ claudeAgents: shim.agents }, { port: 1, token: 'x' }).agents
  const config: Config_InfoEncoded = { ...fixtureConfig(fixture), agents }
  return config
}

/** A file outside the session directory (`<home>/outside/<name>`). */
function outsideFile(rig: Rig, name: string, content: string): string {
  const file = join(rig.home.root, 'outside', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

const ALLOW_ALL = [{ action: '*', resource: '*', effect: 'allow' as const }]

describeV2('opencode 2.x contract: injected Claude agents (ADR-103)', () => {
  const rig = useRig('claude-agents', { config: injectedConfig })
  // 2.x treats everything inside the enclosing git worktree as internal; the suite lives inside
  // ClaudeUI's own checkout, so the session directory is its own repo (see external-directory).
  beforeAll(() => {
    execFileSync('git', ['init', '-q'], { cwd: rig().cwd })
  })

  async function childOf(r: Rig, parent: string, from: number): Promise<string> {
    const created = await r.feed.waitFor('session.created', {
      after: from,
      where: (e) => e.data.parentID === parent
    })
    return created.data.sessionID
  }

  it('(a) agent.list shows them as subagents: own rules last and deny-only, the preamble in system', async () => {
    const r = rig()
    await r.api.ok('integration.list')
    const agents = (await r.api.ok('agent.list')).data
    const reader = agents.find((agent) => agent.id === 'orch-reader')
    expect(reader).toBeDefined()
    expect(reader).toMatchObject({
      mode: 'subagent',
      description: 'Collects evidence for the orchestrator.'
    })
    expect(reader?.model).toMatchObject({ providerID: 'fixture', id: 'fixture-model' })
    expect(reader?.system).toContain(CLAUDE_AGENT_PREAMBLE)
    expect(reader?.system).toContain('You collect evidence. You never edit.')
    // Its own rules close the file's gaps, after the defaults; none is an allow, none is `*`.
    // claudeui_* is ClaudeUI's hosted MCP server: a tools list that does not name it gets none of it.
    // Its two MCP resource actions are denied with it (opencode checks the configured server name).
    const own = [
      ...['edit', 'subagent', 'skill', 'question', 'claudeui_*'].map((action) => ({
        action,
        resource: '*',
        effect: 'deny'
      })),
      { action: 'opencode_list_mcp_resources', resource: 'claudeui', effect: 'deny' },
      { action: 'opencode_read_mcp_resource', resource: 'claudeui:*', effect: 'deny' }
    ]
    const rules = reader!.permissions
    const at = rules.findIndex((rule) => rule.action === own[0].action && rule.effect === 'deny')
    expect(rules.slice(at, at + own.length)).toEqual(own)
    expect(rules.slice(at + own.length)).toEqual([
      // opencode's browser plugin denies the browser tool on every agent (opt-in per session).
      { action: 'browser', resource: '*', effect: 'deny' }
    ])
    expect(own.some((rule) => rule.effect !== 'deny' || rule.action === '*')).toBe(false)
    // The repository's agent is there too, on the model its own file names.
    const project = agents.find((agent) => agent.id === 'project-one')
    expect(project).toMatchObject({ mode: 'subagent' })
    expect(project?.model).toMatchObject({ providerID: 'fixture', id: 'fixture-model' })
    expect(
      project?.permissions.some((rule) => rule.effect === 'deny' && rule.action === 'edit')
    ).toBe(false)
  })

  it('(b) the subagent tool launches an injected agent: its body is the child system prompt', async () => {
    const r = rig()
    writeFileSync(join(r.cwd, NOTES_FILE), 'alpha\n')
    const parent = await r.createSession({ permissions: ALLOW_ALL })
    const tag = nonce('b')
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: parent },
      body: { text: `[subas:orch-reader:read] ${tag}` }
    })
    const child = await childOf(r, parent, from)
    expect((await r.feed.waitForTurnEnd(parent, from, 60_000)).type).toBe(
      'session.execution.succeeded'
    )
    expect(r.feed.select('session.tool.success', { sessionID: child, after: from })).toHaveLength(1)
    const childRequests = r.fixture.requests.filter(
      (q) => q.lastUserText.includes('child does [read]') && q.tools.length > 0
    )
    expect(childRequests.length).toBeGreaterThan(0)
    const system = childRequests[0].messages.find((message) => message.role === 'system')
    expect(JSON.stringify(system?.content)).toContain(CLAUDE_AGENT_PREAMBLE)
    expect(JSON.stringify(system?.content)).toContain('You collect evidence. You never edit.')
  })

  it('(c) a tools list without Edit/Write: the child cannot edit (no ask, file untouched); naming Edit keeps it', async () => {
    const r = rig()
    writeFileSync(join(r.cwd, NOTES_FILE), 'alpha\n')
    await r.api.ok('integration.list')
    const reader = (await r.api.ok('agent.list')).data.find((agent) => agent.id === 'orch-reader')
    // The parent opens edit through an ask: the child's own rules must beat it, unasked.
    const parentRules = [
      { action: '*', resource: '*', effect: 'allow' as const },
      { action: 'edit', resource: '*', effect: 'ask' as const }
    ]
    const parent = await r.createSession({ permissions: parentRules })

    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: parent },
      body: { text: `[subas:orch-reader:edit] ${nonce('c-denied')}` }
    })
    const child = await childOf(r, parent, from)
    // The host's reaction to the child (child-rulesets.ts).
    await r.api.ok('session.update', {
      params: { sessionID: child },
      body: { permissions: childSessionRuleset(parentRules, reader!.permissions) }
    })
    await r.feed.waitForTurnEnd(parent, from, 60_000)
    expect(readFileSync(join(r.cwd, NOTES_FILE), 'utf8')).toBe('alpha\n')
    expect(r.feed.select('permission.asked', { sessionID: child, after: from })).toHaveLength(0)
    expect(r.feed.select('session.tool.success', { sessionID: child, after: from })).toHaveLength(0)
    // After the host's ruleset landed, the child is no longer offered edit/write/patch.
    const childRequests = r.fixture.requests.filter(
      (q) =>
        q.tools.length > 0 &&
        q.messages.some(
          (m) => m.role === 'user' && messageText(m.content).includes('child does [edit]')
        )
    )
    const offered = childRequests.at(-1)!.tools
    expect(offered).toEqual(expect.arrayContaining(['read', 'grep']))
    for (const hidden of ['edit', 'write', 'patch', 'subagent', 'question'])
      expect(offered, hidden).not.toContain(hidden)

    // Control: the same instruction to an agent that names Edit reaches the ask and edits.
    const controlFrom = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: parent },
      body: { text: `[subas:editor:edit] ${nonce('c-control')}` }
    })
    const editor = await childOf(r, parent, controlFrom)
    const asked = await r.feed.waitFor('permission.asked', {
      sessionID: editor,
      after: controlFrom,
      where: (e) => e.data.action === 'edit'
    })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: editor, requestID: asked.data.id },
      body: { decision: 'once' }
    })
    await r.feed.waitForTurnEnd(parent, controlFrom, 60_000)
    expect(readFileSync(join(r.cwd, NOTES_FILE), 'utf8')).toBe('beta\n')
  })

  it('(d) a Read-only child still reads outside the workspace when the parent allows it, host ruleset applied', async () => {
    const r = rig()
    const file = outsideFile(r, 'd.txt', 'outside-ok\n')
    await r.api.ok('integration.list')
    const reader = (await r.api.ok('agent.list')).data.find((agent) => agent.id === 'orch-reader')
    expect(reader).toBeDefined()
    const parent = await r.createSession({ permissions: ALLOW_ALL })
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: parent },
      body: { text: `[subas:orch-reader:readabs=${file}] ${nonce('d')}` }
    })
    const child = await childOf(r, parent, from)
    // The host's reaction to the child (child-rulesets.ts): the child's own ruleset on top of the parent's.
    const ruleset = childSessionRuleset(ALLOW_ALL, reader!.permissions)
    expect(ruleset).toContainEqual({ action: 'edit', resource: '*', effect: 'deny' })
    expect(ruleset.some((rule) => rule.action === 'external_directory')).toBe(false)
    await r.api.ok('session.update', {
      params: { sessionID: child },
      body: { permissions: ruleset }
    })
    expect((await r.feed.waitForTurnEnd(parent, from, 60_000)).type).toBe(
      'session.execution.succeeded'
    )
    expect(r.feed.select('permission.asked', { sessionID: child, after: from })).toHaveLength(0)
    expect(r.feed.select('session.tool.success', { sessionID: child, after: from })).toHaveLength(1)
    expect(
      JSON.stringify(r.feed.select('session.tool.success', { sessionID: child, after: from }))
    ).toContain('outside-ok')
  })
})

describeV2('opencode 2.x contract: a near-cap injected block through the production spawn', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  let home: TestHome
  let proxy: RefusingProxy
  let fixture: FixtureProvider
  let manager: OpencodeServerManager
  const savedEnv: Record<string, string | undefined> = {}
  const ends: Promise<{ forced: boolean }>[] = []
  const spawned: { configChars: number; agentsBytes: number }[] = []

  beforeAll(async () => {
    home = createHome('claude-agents-cap')
    proxy = await startRefusingProxy()
    fixture = await startFixtureProvider()
    const configDir = join(home.env.XDG_CONFIG_HOME, 'opencode')
    mkdirSync(configDir, { recursive: true })
    // A natively configured MCP server (disabled: never started) and a JSON-only native agent.
    writeFileSync(
      join(configDir, 'opencode.json'),
      JSON.stringify({
        ...fixtureConfig(fixture),
        mcp: {
          servers: { ghost: { type: 'local', command: ['ghost-mcp-never-run'], disabled: true } }
        },
        agents: { 'native-one': { description: 'the user own agent', system: 'native prompt' } }
      })
    )
    // The in-process helper finds the global config where the spawned server does.
    // The manager's own reads (the Claude MCP bridge, ~/.claude.json) follow the home too.
    for (const key of ['OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG', 'HOME', 'USERPROFILE'])
      savedEnv[key] = process.env[key]
    delete process.env.OPENCODE_CONFIG
    process.env.OPENCODE_CONFIG_DIR = configDir
    process.env.HOME = home.env.HOME
    process.env.USERPROFILE = home.env.HOME
    // Three ~7 KiB definitions: the injected block is over 20 KiB, under the 24 KiB cap.
    const userDir = join(home.root, 'claude-home', 'agents')
    mkdirSync(userDir, { recursive: true })
    for (const name of ['big-a', 'big-b', 'big-c']) {
      writeFileSync(
        join(userDir, `${name}.md`),
        `---
name: ${name}
description: ${name}
tools: Read
---
${name.repeat(1300)}
`
      )
    }
    writeFileSync(
      join(userDir, 'native-one.md'),
      `---
name: native-one
description: Clashes with a native agent.
tools: Read
---
Shim body.
`
    )
    const env = isolatedEnv(home, proxy)
    const launch: HarnessLaunch = SANDBOX_AVAILABLE
      ? { command: '/usr/bin/sandbox-exec', args: ['-f', sandboxProfile(home), V2_BIN] }
      : { command: V2_BIN, args: [] }
    const pluginDir = locatePluginDir(REPO_ROOT)
    if (!pluginDir) throw new Error(`claudeui-xeng plugin not found under ${REPO_ROOT}`)
    manager = new OpencodeServerManager({
      locateBinaryFn: () => launch,
      spawnFn: (l, options) => {
        const injected = (JSON.parse(options.configContent) as { agents?: object }).agents
        spawned.push({
          configChars: options.configContent.length,
          agentsBytes: Buffer.byteLength(JSON.stringify(injected))
        })
        return spawnStdioServer(l, options, { env })
      },
      // The production default input, with the shim reading the isolated Claude home.
      claudeAgentsFn: (cwd, mcpServers) =>
        loadClaudeAgentsForOpencode({
          cwd,
          mcpServers,
          nativeAgentNames: opencodeNativeAgentNames(cwd),
          modelAllowlist: {},
          claudeUserAgentsDir: userDir
        }),
      endServerFn: (child) => {
        ends.push(endStdioServer(child))
      },
      serverCwd: home.workspace('server-cwd')
    })
  }, 60_000)

  afterAll(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    manager?.dispose()
    const results = await Promise.all(ends)
    await fixture?.close()
    await proxy?.close()
    home?.cleanup()
    if (results.some((r) => r.forced))
      throw new Error('an opencode server ignored stdin EOF and had to be killed')
  }, 30_000)

  it('the server becomes ready with >=20 KiB of injected agents in OPENCODE_CONFIG_CONTENT, and lists them', async () => {
    const ws = home.workspace('cap')
    const conn = await manager.acquire(ws)
    try {
      expect(conn.hostedTools).toMatchObject({ state: 'ready' })
      expect(spawned).toHaveLength(1)
      expect(spawned[0].agentsBytes).toBeGreaterThanOrEqual(20 * 1024)
      expect(spawned[0].configChars).toBeLessThan(32_767)
      const api = createApi(conn.baseUrl, conn.password, ws)
      await api.ok('integration.list')
      const listed = (await api.ok('agent.list')).data
      expect(listed.map((agent) => agent.id)).toEqual(
        expect.arrayContaining(['big-a', 'big-b', 'big-c'])
      )
      // The hosted server is registered (ready above) and a tools-restricted agent is denied it.
      const bigA = listed.find((agent) => agent.id === 'big-a')?.permissions
      expect(bigA).toContainEqual({ action: 'claudeui_*', resource: '*', effect: 'deny' })
      expect(bigA).toContainEqual({
        action: 'opencode_list_mcp_resources',
        resource: 'claudeui',
        effect: 'deny'
      })
      expect(bigA).toContainEqual({
        action: 'opencode_read_mcp_resource',
        resource: 'claudeui:*',
        effect: 'deny'
      })
      // (e) A server from the user's own opencode.json is live to the agent too: denied as well.
      expect(bigA).toContainEqual({ action: 'ghost_*', resource: '*', effect: 'deny' })
      expect(bigA).toContainEqual({
        action: 'opencode_list_mcp_resources',
        resource: 'ghost',
        effect: 'deny'
      })
      expect(bigA).toContainEqual({
        action: 'opencode_read_mcp_resource',
        resource: 'ghost:*',
        effect: 'deny'
      })
      // (e) The JSON-only native agent keeps its own description and prompt: the Claude
      // agent of the same name was left out of the injection, not merged over it.
      const native = listed.find((agent) => agent.id === 'native-one')
      expect(native).toMatchObject({ description: 'the user own agent', system: 'native prompt' })
      expect(native?.mode).not.toBe('subagent')
      expect(native?.system).not.toContain('Shim body.')
    } finally {
      manager.releaseIfCurrent(ws, conn)
    }
  })
})
