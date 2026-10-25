/**
 * opencode 2.x contract: the subagent model gate of the REAL `claudeui-xeng`
 * plugin (ADR-111), on the real engine.
 *
 * The allowlist reaches the plugin as the OPTIONS of its `{package, options}`
 * entry in the injected config (a DIRECTORY entry: the options must be
 * delivered to `ctx.options` in `setup`). Proven against the pinned binary:
 *  (a) the `guard` RPC reports `modelGate: true`;
 *  (b) a `subagent` call whose `model` is off the allowlist is refused BEFORE a
 *      child session exists, and the message is what the model reads as the
 *      tool failure; an allowed model runs;
 *  (c) an agent pinned (in its config) to an off-list model is refused the same
 *      way; one pinned to an allowed model runs; an agent without a model
 *      inherits the (gated) parent;
 *  (d) the gate still holds after `POST /api/location/reload` (setup re-ran, the
 *      options were read again — nothing was pushed that could be lost);
 *  (e) options that are missing refuse a model-bearing call (fail closed) and
 *      leave an inheriting one alone;
 *  (f) opencode's own `models` tool is a Code Mode tool: with `execute` hidden
 *      (ClaudeUI's rulesets) it is not offered to the model at all, which is why
 *      ClaudeUI hosts `claudeui_list_models`.
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Config_InfoEncoded } from '../../core/opencode/protocol-v2/openapi'
import { messageText } from './harness/fixture-provider'
import type { FixtureProvider } from './harness/fixture-provider'
import { describeV2, fixtureConfig, nonce, useRig, type Rig, type TestHome } from './harness/host'

const PLUGIN_SRC = join(__dirname, '..', '..', '..', 'resources', 'opencode', 'claudeui-xeng')

/** Installs the production plugin directory under the isolated home. */
function installRealPlugin(home: TestHome): string {
  const directory = join(home.root, 'plugins', 'claudeui-xeng')
  mkdirSync(directory, { recursive: true })
  for (const file of ['index.js', 'package.json'])
    copyFileSync(join(PLUGIN_SRC, file), join(directory, file))
  return directory
}

/** The fixture provider with a second model, two pinned agents, and the plugin (with or without options). */
function gateConfig(options: Record<string, unknown> | null) {
  return (fixture: FixtureProvider, home: TestHome): Config_InfoEncoded => {
    const base = fixtureConfig(fixture)
    const directory = installRealPlugin(home)
    return {
      ...base,
      providers: {
        fixture: {
          ...base.providers!.fixture,
          models: {
            ...base.providers!.fixture.models,
            'other-model': {
              name: 'Other Model',
              limit: { context: 100_000, output: 4096 },
              cost: { input: 1, output: 2 }
            }
          }
        }
      },
      plugins: [options === null ? directory : { package: directory, options }],
      agents: {
        'pinned-off': { description: 'off-list', mode: 'subagent', model: 'fixture/other-model' },
        'pinned-ok': { description: 'on-list', mode: 'subagent', model: 'fixture/fixture-model' }
      }
    }
  }
}

const ALLOW_ALL = [{ action: '*', resource: '*', effect: 'allow' as const }]

/** What the model was sent as the tool result after the prompt tagged `tag`. */
function toolResultFor(r: Rig, tag: string): string | undefined {
  const request = r.fixture.requests.find(
    (q) => q.lastUserText.includes(tag) && q.messages.at(-1)?.role === 'tool'
  )
  if (!request) return undefined
  const text = messageText(request.messages.at(-1)!.content)
  // A failed tool reaches the model as `{"error":{"type":"unknown","message":"…"}}`.
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } }
    return parsed.error?.message ?? text
  } catch {
    return text
  }
}

/** Prompts `text` (tagged) in a fresh session and waits for the turn; returns the tool result text. */
async function runPrompt(r: Rig, text: string, tag: string) {
  const parent = await r.createSession({ permissions: ALLOW_ALL })
  const from = r.feed.mark()
  await r.api.ok('session.prompt', { params: { sessionID: parent }, body: { text } })
  await r.feed.waitForTurnEnd(parent, from, 60_000)
  const children = r.feed.select('session.created', { after: from }).filter((e) => {
    return (e.data as { parentID?: string }).parentID === parent
  })
  return { parent, children, result: toolResultFor(r, tag) }
}

async function guard(r: Rig): Promise<unknown> {
  const response = await fetch(`${r.server.url}/api/rpc/claudeui-xeng/guard`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`opencode:${r.server.password}`).toString('base64'),
      'x-opencode-directory': r.cwd,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ input: {} })
  })
  const body = (await response.json()) as { output?: unknown }
  return response.ok ? body.output : undefined
}

describeV2('opencode 2.x contract: the subagent model gate (plugin options)', () => {
  const rig = useRig('model-gate', {
    config: gateConfig({ modelAllowlist: { fixture: ['fixture-model'] } })
  })

  it('(a) the guard RPC reports the model gate next to the permission hook and direct MCP', async () => {
    const r = rig()
    // The plugin's setup runs when the location activates: touch it, then ask.
    await r.api.ok('agent.list')
    let answer: unknown
    for (let i = 0; i < 40 && !answer; i++) {
      answer = await guard(r)
      if (!answer) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(answer).toEqual({ permissionHook: true, mcpDirect: true, modelGate: true })
  })

  it('(b) an off-list call model is refused before any child exists, with the message the model reads; an allowed model runs', async () => {
    const r = rig()
    const tag = nonce('b-off')
    const off = await runPrompt(r, `[submodel:fixture/other-model] ${tag}`, tag)
    expect(off.children).toHaveLength(0)
    expect(off.result).toContain(
      'Model "fixture/other-model" is not allowed by ClaudeUI\'s model allowlist. Allowed for "fixture": fixture-model.'
    )
    expect(off.result).toContain('claudeui_list_models')
    expect(off.result).toContain('omit the model parameter')

    const okTag = nonce('b-ok')
    const ok = await runPrompt(r, `[submodel:fixture/fixture-model] ${okTag}`, okTag)
    expect(ok.children).toHaveLength(1)
    expect(ok.result).toContain('state="completed"')
  })

  it('(c) an agent pinned off-list is refused; one pinned on-list runs; an agent with no model inherits', async () => {
    const r = rig()
    const offTag = nonce('c-off')
    const off = await runPrompt(r, `[subas:pinned-off:read] ${offTag}`, offTag)
    expect(off.children).toHaveLength(0)
    expect(off.result).toContain(
      'Agent "pinned-off" runs on model "fixture/other-model", which ClaudeUI\'s model allowlist does not allow.'
    )

    const okTag = nonce('c-ok')
    const ok = await runPrompt(r, `[subas:pinned-ok:read] ${okTag}`, okTag)
    expect(ok.children).toHaveLength(1)

    const plainTag = nonce('c-plain')
    const plain = await runPrompt(r, `[sub] ${plainTag}`, plainTag)
    expect(plain.children).toHaveLength(1)
    expect(plain.result).toContain('state="completed"')
  })

  it('(d) the gate still holds after POST /api/location/reload (setup re-ran and re-read its options)', async () => {
    const r = rig()
    await r.api.ok('location.reload')
    let answer: unknown
    for (let i = 0; i < 40 && !answer; i++) {
      answer = await guard(r)
      if (!answer) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    expect(answer).toMatchObject({ modelGate: true })
    const tag = nonce('d-off')
    const off = await runPrompt(r, `[submodel:fixture/other-model] ${tag}`, tag)
    expect(off.children).toHaveLength(0)
    expect(off.result).toContain('is not allowed by ClaudeUI')
    const okTag = nonce('d-ok')
    const ok = await runPrompt(r, `[submodel:fixture/fixture-model] ${okTag}`, okTag)
    expect(ok.children).toHaveLength(1)
  })

  it("(f) opencode's own models tool is not offered to the model (Code Mode, execute hidden)", async () => {
    const r = rig()
    const tag = nonce('f')
    const parent = await r.createSession({
      permissions: [...ALLOW_ALL, { action: 'execute', resource: '*', effect: 'deny' }]
    })
    await r.turn(parent, `plain ${tag}`)
    const offered = r.fixture.mentioning(tag).at(0)?.tools ?? []
    expect(offered).toContain('subagent')
    expect(offered).not.toContain('models')
    expect(offered).not.toContain('opencode_models')
    expect(offered).not.toContain('execute')
  })
})

describeV2('opencode 2.x contract: the subagent model gate without options (fail closed)', () => {
  const rig = useRig('model-gate-no-options', { config: gateConfig(null) })

  it('(e) a model-bearing call is refused as unavailable; an inheriting call runs', async () => {
    const r = rig()
    const tag = nonce('e-model')
    const refused = await runPrompt(r, `[submodel:fixture/fixture-model] ${tag}`, tag)
    expect(refused.children).toHaveLength(0)
    expect(refused.result).toContain("ClaudeUI's model allowlist is unavailable")

    const pinnedTag = nonce('e-pinned')
    const pinned = await runPrompt(r, `[subas:pinned-ok:read] ${pinnedTag}`, pinnedTag)
    expect(pinned.children).toHaveLength(0)
    expect(pinned.result).toContain("ClaudeUI's model allowlist is unavailable")

    const plainTag = nonce('e-plain')
    const plain = await runPrompt(r, `[sub] ${plainTag}`, plainTag)
    expect(plain.children).toHaveLength(1)
  })
})
