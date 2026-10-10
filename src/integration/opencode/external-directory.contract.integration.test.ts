/**
 * opencode 2.x contract: the `external_directory` ask ClaudeUI states itself
 * (ADR-097 §3, 2026-10-10 amendment; `permission-v2.ts` `externalDirectoryGates`,
 * `own-dirs.ts`).
 *
 * opencode 2.0.25 (#53585, `36a38058fb`) removed `{external_directory,*,ask}`
 * and the own-directory allows from every agent and made `explore` allow
 * everything. So on the pinned binary: (a) no agent carries the ask (this
 * documents upstream's default — if a bump restores it, this fails and the
 * ClaudeUI-side rules want a second look); (b) a read outside the workspace
 * asks under ClaudeUI's compiled ruleset, in every mode; (c) opencode's own
 * data/tmp/config directories, derived by ClaudeUI for the server's env, do
 * not; (d) an `explore` child asks too — its agent-level allow is outranked by
 * the session rule — and (d0) without that rule it reads silently.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import type { ClaudePermissions } from '../../shared/types'
import { resolveOpencodeOwnDirAllows } from '../../core/opencode/own-dirs'
import { buildSessionRuleset, type V2Rule } from '../../core/opencode/permission-v2'
import { childSessionRuleset } from '../../core/opencode/subagent-permissions'
import { describeV2, nonce, useRig, type Rig } from './harness/host'

const perms: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}

/** The session ruleset ClaudeUI would send, with the own-dir allows derived for THIS server. */
async function ruleset(rig: Rig, mode: string, autoMode = false, p = perms) {
  const home = rig.home.env.HOME ?? rig.home.env.USERPROFILE
  const externalDirAllows = await resolveOpencodeOwnDirAllows(
    { call: async () => rig.api.ok('server.info') },
    // The suite spawns the server with the home's HOME/XDG env and nothing else of
    // ClaudeUI's process env: derive for exactly that. (tmp comes from /api/info.)
    { env: rig.home.env, homedir: home, tmpdir: home }
  )
  return {
    externalDirAllows,
    ...buildSessionRuleset({
      mode,
      autoMode,
      permissions: p,
      mcpServers: ['claudeui'],
      externalDirAllows
    })
  }
}

async function createWith(rig: Rig, rules: readonly V2Rule[], agent?: string): Promise<string> {
  return rig.createSession({ permissions: rules, ...(agent ? { agent } : {}) })
}

/** A file outside the session directory (`<home>/outside/<name>`). */
function outsideFile(rig: Rig, name: string, content = 'outside-secret\n'): string {
  const file = join(rig.home.root, 'outside', name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

const slashed = (path: string): string => path.replaceAll('\\', '/')

describeV2('opencode 2.x contract: the external_directory ask (2.0.25+ baseline)', () => {
  const rig = useRig('extdir')
  // The suite's homes live under the ClaudeUI checkout, which is itself a git repo: 2.x treats
  // everything inside the git WORKTREE as internal (`file-access.ts` resolve), so the session
  // directory is its own repo — otherwise "outside" files here would be inside ClaudeUI's.
  beforeAll(() => {
    execFileSync('git', ['init', '-q'], { cwd: rig().cwd })
  })

  it('(a) upstream default: no agent carries an external_directory ask; only explore allows it', async () => {
    const r = rig()
    // A cold directory lists no agents until its plugins load (ADR-097 S3).
    await r.api.ok('integration.list')
    const agents = (await r.api.ok('agent.list')).data
    expect(agents.map((agent) => agent.id)).toEqual(expect.arrayContaining(['build', 'explore']))
    for (const agent of agents) {
      const external = agent.permissions.filter((rule) => rule.action === 'external_directory')
      expect(
        external.filter((rule) => rule.effect !== 'allow'),
        agent.id
      ).toEqual([])
      if (agent.id === 'explore')
        expect(external).toEqual([{ action: 'external_directory', resource: '*', effect: 'allow' }])
      else expect(external, agent.id).toEqual([])
    }
  })

  it.each([
    ['default', false, undefined],
    ['acceptEdits', false, undefined],
    ['plan', false, 'plan'],
    ['auto', true, undefined]
  ] as const)(
    '(b) %s: a read outside the workspace asks `external_directory` with the directory glob',
    async (mode, autoMode, agent) => {
      const r = rig()
      const file = outsideFile(r, `b-${mode}.txt`)
      const { rules } = await ruleset(r, mode, autoMode)
      const id = await createWith(r, rules, agent)
      const from = r.feed.mark()
      await r.api.ok('session.prompt', {
        params: { sessionID: id },
        body: { text: `[readabs:${file}] ${nonce(`b-${mode}`)}` }
      })
      const asked = await r.feed.waitFor('permission.asked', {
        sessionID: id,
        after: from,
        where: (e) => e.data.action === 'external_directory'
      })
      expect(asked.data.resources).toEqual([`${slashed(dirname(file))}/*`])
      await r.api.ok('session.permission.reply', {
        params: { sessionID: id, requestID: asked.data.id },
        body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
      })
      expect((await r.feed.waitForTurnEnd(id, from)).type).toBe('session.execution.succeeded')
    }
  )

  it('(b) an additionalDirectories entry is allowed without an ask; its sibling outside still asks', async () => {
    const r = rig()
    const allowed = outsideFile(r, 'extra/in.txt', 'extra-ok\n')
    const other = outsideFile(r, 'other/out.txt')
    const { rules } = await ruleset(r, 'default', false, {
      ...perms,
      additionalDirectories: [dirname(allowed)]
    })
    const id = await createWith(r, rules)
    const tag = nonce('b-extra')
    const first = await r.turn(id, `[readabs:${allowed}] ${tag}`)
    expect(r.feed.select('permission.asked', { sessionID: id, after: first.from })).toHaveLength(0)
    expect(
      r.feed.select('session.tool.success', { sessionID: id, after: first.from })
    ).toHaveLength(1)
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[readabs:${other}] ${nonce('b-other')}` }
    })
    const asked = await r.feed.waitFor('permission.asked', {
      sessionID: id,
      after: from,
      where: (e) => e.data.action === 'external_directory'
    })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: id, requestID: asked.data.id },
      body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
    })
    await r.feed.waitForTurnEnd(id, from)
  })

  it('(c) opencode’s own tool-output, shell-output, tmp and config files read without an ask', async () => {
    const r = rig()
    const { rules } = await ruleset(r, 'default')
    // Where the server writes: the isolated XDG dirs, and tmp as /api/info reports it.
    const data = join(r.home.env.XDG_DATA_HOME, 'opencode')
    const config = join(r.home.env.XDG_CONFIG_HOME, 'opencode')
    const tmp = (await r.api.ok('server.info')).paths.tmp
    const targets = {
      'tool-output': join(data, 'tool-output', 'tool_contract.txt'),
      'shell output': join(data, 'shell', 'prj_contract', 'shell_contract.txt'),
      tmp: join(tmp, 'tmp_contract.txt'),
      config: join(config, 'config_contract.txt')
    }
    const id = await createWith(r, rules)
    for (const [label, file] of Object.entries(targets)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `own-dir-${label}\n`)
      const tag = nonce(`c-${label.replace(' ', '-')}`)
      const turn = await r.turn(id, `[readabs:${file}] ${tag}`)
      expect(
        r.feed.select('permission.asked', { sessionID: id, after: turn.from }),
        label
      ).toHaveLength(0)
      expect(
        r.feed.select('session.tool.success', { sessionID: id, after: turn.from }),
        label
      ).toHaveLength(1)
      expect(turn.end.type).toBe('session.execution.succeeded')
    }
  })

  it('(d0) control: an explore child under a session WITHOUT the ask reads outside silently', async () => {
    const r = rig()
    const file = outsideFile(r, 'd0.txt', 'explore-silent\n')
    // The 2.0.26 baseline alone: everything allowed, the agent's own allow decides.
    const id = await createWith(r, [{ action: '*', resource: '*', effect: 'allow' }])
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[subexplore:${file}] ${nonce('d0')}` }
    })
    const child = await r.feed.waitFor('session.created', {
      after: from,
      where: (e) => e.data.parentID === id
    })
    const end = await r.feed.waitForTurnEnd(id, from, 60_000)
    expect(
      r.feed.select('permission.asked', { sessionID: child.data.sessionID, after: from })
    ).toHaveLength(0)
    expect(
      r.feed.select('session.tool.success', { sessionID: child.data.sessionID, after: from })
    ).toHaveLength(1)
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(d) an explore child under ClaudeUI’s ruleset asks for a read outside — its own allow loses to the session ask', async () => {
    const r = rig()
    const file = outsideFile(r, 'd.txt')
    const { rules } = await ruleset(r, 'default')
    const id = await createWith(r, rules)
    await r.api.ok('integration.list')
    const explore = (await r.api.ok('agent.list')).data.find((agent) => agent.id === 'explore')
    expect(explore).toBeDefined()
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[subexplore:${file}] ${nonce('d')}` }
    })
    const child = await r.feed.waitFor('session.created', {
      after: from,
      where: (e) => e.data.parentID === id
    })
    // The host's reaction to the child (child-rulesets.ts): the child's own ruleset on top of the parent's.
    await r.api.ok('session.update', {
      params: { sessionID: child.data.sessionID },
      body: { permissions: childSessionRuleset(rules, explore!.permissions) }
    })
    const asked = await r.feed.waitFor('permission.asked', {
      sessionID: child.data.sessionID,
      after: from,
      where: (e) => e.data.action === 'external_directory'
    })
    expect(asked.data.resources).toEqual([`${slashed(dirname(file))}/*`])
    await r.api.ok('session.permission.reply', {
      params: { sessionID: child.data.sessionID, requestID: asked.data.id },
      body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
    })
    expect((await r.feed.waitForTurnEnd(id, from, 60_000)).type).toBe('session.execution.succeeded')
  })
})
