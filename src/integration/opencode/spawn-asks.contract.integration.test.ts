/**
 * opencode 2.x contract: the asks ClaudeUI's AUTO ruleset adds for a subagent
 * spawn, a web search and a skill (subagent-parity S1, R3).
 *
 * Native 2.x allows all three (the agent baseline is `*: allow`), so under the
 * default rulesets nothing asks. The auto ruleset (`autoModeGates`) adds
 * `{subagent|websearch|skill, *, ask}`; this suite pins on the real engine that
 *   - each call raises `permission.asked` with the 2.x action and resources;
 *   - the ask carries no metadata for `subagent` / `skill`, so the call's own
 *     input must already be on the feed — `session.tool.called` PRECEDES the
 *     ask — and the REAL mapper turns that into an approval whose `input` is the
 *     call's (`agent`, `prompt`, `description` / `query` / `id`): what the judge
 *     reads;
 *   - a reject WITH a message is non-fatal (the turn goes on), as ClaudeUI sends;
 *   - without the ask rules (default mode) a spawn runs unasked.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ClaudePermissions } from '../../shared/types'
import { OpencodeEventMapper } from '../../core/opencode/event-mapper'
import { eventSessionID } from '../../core/opencode/protocol-v2/events'
import { buildSessionRuleset } from '../../core/opencode/permission-v2'
import { SKILL_ID, WEBSEARCH_QUERY } from './harness/fixture-provider'
import { describeV2, fixtureConfig, nonce, useRig, type Rig } from './harness/host'

const perms: ClaudePermissions = {
  allow: [],
  deny: [],
  ask: [],
  additionalDirectories: [],
  defaultMode: undefined
}
const ruleset = (mode: 'auto' | 'default') =>
  buildSessionRuleset({
    mode,
    autoMode: mode === 'auto',
    permissions: perms,
    mcpServers: ['claudeui']
  }).rules

const DENIAL = 'ClaudeUI denied: contract probe'

describeV2('opencode 2.x contract: auto-mode spawn, web search and skill asks', () => {
  const rig = useRig('spawn-asks', {
    config: (fixture, home) => {
      // The skill the `[skill]` marker loads (project skills: `.opencode/skills/<id>/SKILL.md`).
      const dir = join(home.workspace('main'), '.opencode', 'skills', SKILL_ID)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${SKILL_ID}\ndescription: Contract probe skill\n---\nDo nothing.\n`
      )
      return fixtureConfig(fixture)
    }
  })

  /** Prompts `marker`, waits for the ask of `action`, maps the feed so far, rejects with a message. */
  async function askFor(r: Rig, marker: string, action: string) {
    const sessionID = await r.createSession({ permissions: ruleset('auto') })
    const from = r.feed.mark()
    await r.api.ok('session.prompt', {
      params: { sessionID },
      body: { text: `${marker} ${nonce(action)}` }
    })
    const asked = await r.feed.waitFor('permission.asked', {
      sessionID,
      after: from,
      where: (event) => event.data.action === action
    })
    const upTo = r.feed.events.indexOf(asked)
    const events = r.feed.events
      .slice(from, upTo + 1)
      .filter((e) => eventSessionID(e) === sessionID)
    const mapper = new OpencodeEventMapper({ sessionID })
    const outputs = events.flatMap((event) => mapper.map(event))
    const callID = asked.data.source?.id
    const called = events.filter(
      (event) => event.type === 'session.tool.called' && event.data.id === callID
    )
    await r.api.ok('session.permission.reply', {
      params: { sessionID, requestID: asked.data.id },
      body: { decision: 'reject', message: DENIAL }
    })
    const end = await r.feed.waitForTurnEnd(sessionID, from)
    const approval = outputs.find((o) => o.kind === 'approval')
    return { asked, callID, called, calledBeforeAsk: called.length > 0, approval, end }
  }

  it('subagent: asks with the agent as the resource; tool.called (with the prompt) precedes it; the mapped approval carries agent/prompt/description', async () => {
    const { asked, callID, called, approval, end } = await askFor(rig(), '[sub]', 'subagent')
    expect(asked.data).toMatchObject({ action: 'subagent', resources: ['general'] })
    expect(asked.data.source).toMatchObject({ type: 'tool' })
    expect(callID).toBeTruthy()
    expect(called).toHaveLength(1)
    if (called[0].type === 'session.tool.called')
      expect(called[0].data.input).toMatchObject({
        agent: 'general',
        prompt: 'child says hi',
        description: 'contract child'
      })
    expect(approval).toMatchObject({
      kind: 'approval',
      approval: {
        toolName: 'subagent',
        toolUseId: callID,
        input: { agent: 'general', prompt: 'child says hi', description: 'contract child' }
      }
    })
    // Non-fatal: the model reads the rejection and the turn ends normally; no child ran.
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('websearch: asks with the query as the resource; the mapped approval carries the query', async () => {
    const { asked, callID, called, approval, end } = await askFor(rig(), '[websearch]', 'websearch')
    expect(asked.data).toMatchObject({ action: 'websearch', resources: [WEBSEARCH_QUERY] })
    expect(called).toHaveLength(1)
    expect(approval).toMatchObject({
      kind: 'approval',
      approval: { toolName: 'websearch', toolUseId: callID, input: { query: WEBSEARCH_QUERY } }
    })
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('skill: asks with the skill id as the resource; the mapped approval carries the id', async () => {
    const { asked, callID, called, approval, end } = await askFor(rig(), '[skill]', 'skill')
    expect(asked.data).toMatchObject({ action: 'skill', resources: [SKILL_ID] })
    expect(called).toHaveLength(1)
    expect(approval).toMatchObject({
      kind: 'approval',
      approval: { toolName: 'skill', toolUseId: callID, input: { id: SKILL_ID } }
    })
    expect(end.type).toBe('session.execution.succeeded')
  })

  it('the default ruleset leaves all three unasked (a spawn runs its child)', async () => {
    const r = rig()
    const sessionID = await r.createSession({ permissions: ruleset('default') })
    const { end, from } = await r.turn(sessionID, `[sub] ${nonce('plain')}`)
    expect(
      r.feed
        .select('permission.asked', { after: from })
        .filter((event) => ['subagent', 'websearch', 'skill'].includes(event.data.action))
    ).toHaveLength(0)
    expect(r.feed.select('session.created', { after: from }).length).toBeGreaterThan(0)
    expect(end.type).toBe('session.execution.succeeded')
  })
})
