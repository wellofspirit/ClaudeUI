/**
 * opencode 2.x contract: ClaudeUI's COMPILED rulesets on the real engine
 * (ADR-097 §3, S6 — `permission-v2.ts`, `subagent-permissions.ts`).
 *
 * (a) an allowed shell command runs without an ask; (b) an `ask` resource
 * raises `permission.asked` with the 2.x action and resources; (c) a narrow
 * deny blocks per call with `permission.rejected` while the tool stays
 * offered; (d) the wholly-denied decisions, asserted on the tool list the
 * MODEL was sent; (e) subagent children: the parent's rules apply natively,
 * and the child agent's own narrowing survives once the host PATCHes
 * `childSessionRuleset` onto the child. Plus the saved-allow fact (as shipped,
 * without ClaudeUI's plugin) that makes
 * narrow denies stay server-side denies.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ClaudePermissions } from '../../shared/types'
import type { Config_InfoEncoded, Permission_Rule } from '../../core/opencode/protocol-v2/openapi'
import {
  agentPermissionOverlay,
  buildSessionRuleset,
  type V2Rule
} from '../../core/opencode/permission-v2'
import { childSessionRuleset } from '../../core/opencode/subagent-permissions'
import {
  NOTES_FILE,
  SHELL_COMMAND,
  messageText,
  type FixtureProvider
} from './harness/fixture-provider'
import { describeV2, fixtureConfig, nonce, SHELL_ASKS, useRig, type Rig } from './harness/host'

function perms(p: Partial<ClaudePermissions> = {}): ClaudePermissions {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], defaultMode: undefined, ...p }
}

function session(mode: string, p: Partial<ClaudePermissions> = {}) {
  return buildSessionRuleset({
    mode,
    autoMode: mode === 'auto',
    permissions: perms(p),
    mcpServers: ['claudeui']
  })
}

/** The overlay as `OPENCODE_CONFIG_CONTENT` carries it, plus extra agent rules. */
function withAgents(
  fixture: FixtureProvider,
  extra: Record<string, readonly Permission_Rule[]> = {}
): Config_InfoEncoded {
  const overlay = { ...agentPermissionOverlay() }
  const agents: Record<string, { permissions: readonly Permission_Rule[] }> = {}
  for (const [name, rules] of Object.entries(overlay)) agents[name] = { permissions: rules }
  for (const [name, rules] of Object.entries(extra))
    agents[name] = { permissions: [...(agents[name]?.permissions ?? []), ...rules] }
  return { ...fixtureConfig(fixture), agents }
}

async function create(rig: Rig, rules: readonly V2Rule[], agent?: string): Promise<string> {
  return rig.createSession({ permissions: rules, ...(agent ? { agent } : {}) })
}

/** The tool names the model was offered on the first request mentioning `tag`. */
function offered(rig: Rig, tag: string): readonly string[] {
  const [first] = rig.fixture.mentioning(tag)
  expect(first, `no model request mentioned ${tag}`).toBeDefined()
  return first.tools
}

describeV2('opencode 2.x contract: compiled session rulesets', () => {
  const rig = useRig('ruleset', { config: (fixture) => withAgents(fixture) })

  it('(a) a user allow rule runs the shell command without an ask', async () => {
    const r = rig()
    const id = await create(r, session('default', { allow: [`Bash(${SHELL_COMMAND})`] }).rules)
    const tag = nonce('allow')
    const { end, from } = await r.turn(id, `[tool] ${tag}`)
    expect(r.feed.select('permission.asked', { sessionID: id, after: from })).toHaveLength(0)
    const requests = r.fixture.mentioning(tag)
    expect(messageText(requests.at(-1)?.messages.at(-1)?.content)).toContain('contract-tool-ran')
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(b) the default gate asks with action `shell` and the statement as the resource', async () => {
    const r = rig()
    const id = await create(r, session('default').rules)
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[tool] ${nonce('ask')}` }
    })
    const asked = await r.feed.waitFor('permission.asked', { sessionID: id, after: from })
    expect(asked.data).toMatchObject({ action: 'shell', resources: [SHELL_COMMAND] })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: id, requestID: asked.data.id },
      body: { decision: 'once' }
    })
    expect((await r.feed.waitForTurnEnd(id, from)).type).toBe('session.execution.succeeded')
  })

  it('(c) a narrow user deny: the tool stays offered, the call fails `permission.rejected`, no ask', async () => {
    const r = rig()
    const id = await create(r, session('default', { deny: ['Bash(echo:*)'] }).rules)
    const tag = nonce('deny')
    const { end, from } = await r.turn(id, `[tool] ${tag}`)
    expect(offered(r, tag)).toContain('shell')
    expect(r.feed.select('permission.asked', { sessionID: id, after: from })).toHaveLength(0)
    const failed = r.feed.select('session.tool.failed', { sessionID: id, after: from })
    expect(failed.map((event) => event.data.error)).toEqual([
      { type: 'permission.rejected', message: 'Permission denied: shell' }
    ])
    // Non-fatal: the model got the rejection as its tool result and the turn went on.
    expect(r.fixture.mentioning(tag)).toHaveLength(2)
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(d) Code Mode `execute` is offered by default and hidden by every compiled ruleset', async () => {
    const r = rig()
    const plain = await r.createSession(SHELL_ASKS)
    const before = nonce('codemode')
    await r.turn(plain, before)
    // Without ClaudeUI's rule the model gets `execute`, whose runtime has an ungated `fetch`.
    expect(offered(r, before)).toContain('execute')
    for (const mode of ['default', 'acceptEdits', 'plan', 'auto']) {
      const { rules, agent } = session(mode)
      const id = await create(r, rules, agent)
      const tag = nonce(`exec-${mode}`)
      await r.turn(id, tag)
      expect(offered(r, tag), mode).not.toContain('execute')
    }
  })

  it('(d) a user deny on the whole tool hides it; the mode gates hide nothing', async () => {
    const r = rig()
    const gated = await create(r, session('default').rules)
    const tagGated = nonce('gated')
    await r.turn(gated, tagGated)
    expect(offered(r, tagGated)).toEqual(
      expect.arrayContaining(['shell', 'edit', 'write', 'read', 'webfetch', 'subagent'])
    )

    const denied = await create(
      r,
      session('default', { deny: ['Bash', 'WebFetch'], ask: ['Bash(git:*)'] }).rules
    )
    const tag = nonce('whole')
    const { end } = await r.turn(denied, `[tool] ${tag}`)
    expect(offered(r, tag)).not.toContain('shell')
    expect(offered(r, tag)).not.toContain('webfetch')
    expect(offered(r, tag)).toContain('read')
    // The fixture had no shell to call: nothing ran.
    expect(r.feed.streamedText(denied)).toContain('FIXTURE_NO_TOOL')
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(d) plan mode: edit/write/patch hidden, the `general` subagent denied server-side', async () => {
    const r = rig()
    const { rules, agent } = session('plan', { allow: ['Edit'], ask: ['Edit(docs/**)'] })
    expect(agent).toBe('plan')
    const id = await create(r, rules, agent)
    const tag = nonce('plan')
    const { from, end } = await r.turn(id, `[sub] ${tag}`)
    const tools = offered(r, tag)
    // (`patch` is offered to some models only; `edit` is its permission id too.)
    for (const tool of ['edit', 'write', 'patch']) expect(tools).not.toContain(tool)
    expect(tools).toEqual(expect.arrayContaining(['shell', 'read', 'subagent']))
    // The fixture asks for `general`: refused server-side, no ask, no child session.
    expect(r.feed.select('permission.asked', { sessionID: id, after: from })).toHaveLength(0)
    expect(
      r.feed
        .select('session.tool.failed', { sessionID: id, after: from })
        .map((e) => e.data.error.type)
    ).toEqual(['permission.rejected'])
    expect(
      r.feed.select('session.created', { after: from, where: (e) => e.data.parentID === id })
    ).toHaveLength(0)
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('(e) a child inherits the parent ruleset natively: its gated call asks on the CHILD session', async () => {
    const r = rig()
    writeFileSync(join(r.cwd, NOTES_FILE), 'alpha\n')
    // `Read(notes.txt)` ask stands in for a gated category the child's agent allows.
    const id = await create(r, session('default', { ask: [`Read(${NOTES_FILE})`] }).rules)
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID: id },
      body: { text: `[subread] ${nonce('inherit')}` }
    })
    const child = await r.feed.waitFor('session.created', {
      after: from,
      where: (e) => e.data.parentID === id
    })
    expect(child.data.permissions).toEqual(
      session('default', { ask: [`Read(${NOTES_FILE})`] }).rules
    )
    const asked = await r.feed.waitFor('permission.asked', {
      sessionID: child.data.sessionID,
      after: from
    })
    expect(asked.data).toMatchObject({ action: 'read', resources: [NOTES_FILE] })
    await r.api.ok('session.permission.reply', {
      params: { sessionID: child.data.sessionID, requestID: asked.data.id },
      body: { decision: 'reject', message: 'ClaudeUI denied: contract' }
    })
    expect((await r.feed.waitForTurnEnd(id, from)).type).toBe('session.execution.succeeded')
  })
})

describeV2(
  'opencode 2.x contract: a subagent keeps its own narrowing (childSessionRuleset)',
  () => {
    // `general` here wholly denies `read` in its own (config) rules.
    const NARROWED: readonly Permission_Rule[] = [{ action: 'read', resource: '*', effect: 'deny' }]
    const rig = useRig('ruleset-child', {
      config: (fixture) => withAgents(fixture, { general: NARROWED })
    })
    // The parent allows reads outright, so the inherited rules re-open `read`.
    const parent = () => session('default', { allow: ['Read'] }).rules

    /** Runs `[subread]`; `patch` (the host's reaction to the child) is optional. */
    async function runChild(patchChild: boolean) {
      const r = rig()
      writeFileSync(join(r.cwd, NOTES_FILE), 'alpha-secret\n')
      const rules = parent()
      const id = await create(r, rules)
      // What S5 caches per session: the agents' own rulesets.
      // A cold directory lists no agents until its plugins load (ADR-097 S3).
      await r.api.ok('integration.list')
      const agents = (await r.api.ok('agent.list')).data
      const general = agents.find((agent) => agent.id === 'general')
      expect(general).toBeDefined()
      expect(general!.permissions).toContainEqual(NARROWED[0])
      const from = r.feed.mark()
      await r.api.ok('session.prompt', {
        params: { sessionID: id },
        body: { text: `[subread] ${nonce('narrow')}` }
      })
      const created = await r.feed.waitFor('session.created', {
        after: from,
        where: (e) => e.data.parentID === id
      })
      const childID = created.data.sessionID
      if (patchChild) {
        await r.api.ok('session.update', {
          params: { sessionID: childID },
          body: { permissions: childSessionRuleset(rules, general!.permissions) }
        })
      }
      const end = await r.feed.waitForTurnEnd(id, from, 60_000)
      return {
        end,
        childID,
        succeeded: r.feed.select('session.tool.success', { sessionID: childID, after: from }),
        failed: r.feed.select('session.tool.failed', { sessionID: childID, after: from }),
        childRequests: r.fixture.requests.filter((req) =>
          req.messages.some((m) => messageText(m.content).includes('child reads [read]'))
        )
      }
    }

    it('PRE-FIX (2.x as is): the inherited parent allow overrides the agent deny — the child reads', async () => {
      const { succeeded, end } = await runChild(false)
      expect(succeeded).toHaveLength(1)
      expect(end.type).toBe('session.execution.succeeded')
    })

    it('with the child ruleset PATCHed on `session.created`, the read neither runs nor asks', async () => {
      const { succeeded, failed, childRequests, end, childID } = await runChild(true)
      expect(succeeded).toHaveLength(0)
      expect(rig().feed.select('permission.asked', { sessionID: childID })).toHaveLength(0)
      // Either the PATCH landed before the child's first request (read not offered),
      // or before its call ran (blocked) — both are the narrowing.
      const hidden = childRequests.length > 0 && !childRequests[0].tools.includes('read')
      const blocked = failed.some((e) => e.data.error.type === 'permission.rejected')
      expect(hidden || blocked).toBe(true)
      if (childRequests.length > 1) expect(childRequests.at(-1)!.tools).not.toContain('read')
      expect(end.type).toBe('session.execution.succeeded')
    })
  }
)

describeV2(
  'opencode 2.x contract: saved "always" allows vs session rules (no ClaudeUI plugin)',
  () => {
    // Own home: saved allows are per project, in the (shared, in production) DB.
    // The CONTROL for plugin.contract.integration.test.ts: opencode as shipped.
    const rig = useRig('ruleset-saved')

    it('a saved allow outranks a session ASK but never a session DENY', async () => {
      const r = rig()
      // 1. An "always" reply (what the user's own opencode TUI sends) saves `echo *`.
      const first = await create(r, session('default').rules)
      const from = r.feed.mark()
      await r.api.ok('session.prompt', {
        params: { sessionID: first },
        body: { text: `[tool] ${nonce('always')}` }
      })
      const asked = await r.feed.waitFor('permission.asked', { sessionID: first, after: from })
      expect(asked.data.save).toEqual(['echo *'])
      await r.api.ok('session.permission.reply', {
        params: { sessionID: first, requestID: asked.data.id },
        body: { decision: 'always' }
      })
      await r.feed.waitForTurnEnd(first, from)
      const saved = (await r.api.ok('permission.saved.list')).data
      expect(saved).toEqual(
        expect.arrayContaining([expect.objectContaining({ action: 'shell', resource: 'echo *' })])
      )

      // 2. A NEW session whose ruleset asks for shell: the saved allow answers, no ask.
      const second = await create(r, session('default').rules)
      const asks = await r.turn(second, `[tool] ${nonce('saved-ask')}`)
      expect(
        r.feed.select('permission.asked', { sessionID: second, after: asks.from })
      ).toHaveLength(0)
      expect(
        r.feed.select('session.tool.success', { sessionID: second, after: asks.from })
      ).toHaveLength(1)

      // 3. A session with a narrow DENY for it: the deny holds.
      const third = await create(r, session('default', { deny: ['Bash(echo:*)'] }).rules)
      const denies = await r.turn(third, `[tool] ${nonce('saved-deny')}`)
      expect(
        r.feed
          .select('session.tool.failed', { sessionID: third, after: denies.from })
          .map((e) => e.data.error.type)
      ).toEqual(['permission.rejected'])
    })
  }
)
