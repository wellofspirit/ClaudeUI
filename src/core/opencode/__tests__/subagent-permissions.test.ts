/**
 * @vitest-environment node
 *
 * ADR-085 S4 / ADR-097 §3 (S6) — the ruleset ClaudeUI PATCHes onto an
 * opencode subagent child, and the host's backstop on a child ask. Synthetic
 * agents and rules only.
 */
import { describe, it, expect } from 'vitest'
import { agentWhollyDenies, evaluateChildCall, childSessionRuleset } from '../subagent-permissions'
import { buildSessionRuleset, wireOrder, type V2Rule } from '../permission-v2'
import { evaluateV2Call, v2ToolHidden } from '../wildcard'

// ── opencode 2.x: the child's ruleset (ADR-097 §3, S6) ──────────────────────

describe('2.x subagent children — childSessionRuleset / agentWhollyDenies', () => {
  const v = (action: string, effect: V2Rule['effect'], resource = '*'): V2Rule => ({
    action,
    resource,
    effect
  })
  // The agent rulesets 2.x computes (vendor/opencode-src/packages/schema/src/agent.ts
  // `Info.default`, core/src/plugin/agent.ts), opencode's own data dirs elided.
  const DEFAULTS = [
    v('*', 'allow'),
    v('external_directory', 'ask'),
    v('read', 'ask', '*.env'),
    v('read', 'ask', '*.env.*'),
    v('read', 'allow', '*.env.example')
  ]
  const GENERAL_V2 = [...DEFAULTS, v('question', 'deny'), v('subagent', 'deny')]
  const EXPLORE_V2 = [
    ...DEFAULTS,
    v('*', 'deny'),
    v('shell', 'allow'),
    v('grep', 'allow'),
    v('glob', 'allow'),
    v('webfetch', 'allow'),
    v('websearch', 'allow'),
    v('read', 'allow'),
    v('read', 'ask', '*.env'),
    v('read', 'ask', '*.env.*'),
    v('read', 'allow', '*.env.example'),
    v('subagent', 'deny'),
    v('external_directory', 'ask')
  ]
  const parent = (mode: string, deny: string[] = [], allow: string[] = []) =>
    buildSessionRuleset({
      mode,
      autoMode: mode === 'auto',
      permissions: { allow, deny, ask: [], additionalDirectories: [], defaultMode: undefined },
      mcpServers: ['claudeui', 'lsphub']
    }).rules
  /** What the engine evaluates for a child: its agent's rules, then its session's. */
  const effective = (agent: V2Rule[], session: V2Rule[]) => [...agent, ...session]

  it('agentWhollyDenies reads the agent rules from the end, overlap-aware', () => {
    expect(agentWhollyDenies(EXPLORE_V2, 'edit', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'claudeui_dispatch_agent', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'lsphub_*', 'linux')).toBe(true)
    expect(agentWhollyDenies(EXPLORE_V2, 'shell', 'linux')).toBe(false)
    expect(agentWhollyDenies(GENERAL_V2, 'edit', 'linux')).toBe(false)
    expect(agentWhollyDenies(GENERAL_V2, 'question', 'linux')).toBe(true)
    // A narrower deny only carves out.
    expect(agentWhollyDenies([v('*', 'allow'), v('shell', 'deny', 'rm *')], 'shell', 'linux')).toBe(
      false
    )
  })

  it('PRE-FIX: an inherited parent rule re-opens what the child agent denies (why the PATCH exists)', () => {
    const session = parent('default')
    // explore denies edit outright, but the parent's `edit: ask` comes after it.
    expect(v2ToolHidden(effective(EXPLORE_V2, session), 'edit', 'linux')).toBe(false)
    expect(evaluateV2Call(effective(EXPLORE_V2, session), 'edit', ['a.ts'], 'linux')).toBe('ask')
    // …and a user allow turns a custom agent's shell deny into an allow.
    const custom = [...DEFAULTS, v('shell', 'deny')]
    const withAllow = parent('default', [], ['Bash(git status)'])
    expect(evaluateV2Call(effective(custom, withAllow), 'shell', ['git status'], 'linux')).toBe(
      'allow'
    )
  })

  it('explore under a default parent: edit and the dispatch tool hidden again; shell keeps the parent ask', () => {
    const session = parent('default')
    const child = childSessionRuleset(session, EXPLORE_V2, 'linux')
    const rules = effective(EXPLORE_V2, child)
    expect(v2ToolHidden(rules, 'edit', 'linux')).toBe(true)
    expect(v2ToolHidden(rules, 'claudeui_dispatch_agent', 'linux')).toBe(true)
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
    expect(evaluateV2Call(rules, 'shell', ['ls'], 'linux')).toBe('ask') // ruling 4
    expect(evaluateV2Call(rules, 'read', ['a.ts'], 'linux')).toBe('allow')
    // The parent's rules are all still there, in order, ahead of the narrowing.
    expect(child.slice(0, session.length - 1)).toEqual(session.slice(0, -1))
  })

  it('a custom agent that denies shell stays shell-less under a parent that allows a command', () => {
    const custom = [...DEFAULTS, v('shell', 'deny')]
    const session = parent('default', [], ['Bash(git status)'])
    const rules = effective(custom, childSessionRuleset(session, custom, 'linux'))
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(true)
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('deny')
  })

  it('general (allow-all): only its own denies are restated after the parent; nothing else changes', () => {
    const session = parent('default')
    const child = childSessionRuleset(session, GENERAL_V2, 'linux')
    expect(child).toEqual(wireOrder([...session, v('question', 'deny'), v('subagent', 'deny')]))
    expect(v2ToolHidden(effective(GENERAL_V2, child), 'question', 'linux')).toBe(true)
    expect(evaluateV2Call(effective(GENERAL_V2, child), 'edit', ['a.ts'], 'linux')).toBe('ask')
  })

  it('auto mode: claudeui tools the agent wholly denies are re-denied; MCP tools ask (judged)', () => {
    const session = parent('auto')
    const child = childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(child).toContainEqual(v('claudeui_*', 'deny'))
    expect(v2ToolHidden(effective(EXPLORE_V2, child), 'claudeui_render_mermaid', 'linux')).toBe(
      true
    )
    // The `*_*` catch-all overlaps explore's own `external_directory` ask, so it
    // is not a wholly denied action: an MCP call asks and the judge decides.
    expect(evaluateV2Call(effective(EXPLORE_V2, child), 'lsphub_find', ['*'], 'linux')).toBe('ask')
  })

  it("review #5: a custom agent's NARROW deny survives the parent's gate and a user allow", () => {
    const custom = [...DEFAULTS, v('shell', 'deny', 'git push*'), v('edit', 'deny', 'src/secret/*')]
    // PRE-FIX shape: the parent's later `shell *` ask / allow outranks the agent deny.
    const withAllow = parent('default', [], ['Bash(git:*)'])
    expect(
      evaluateV2Call(effective(custom, withAllow), 'shell', ['git push origin main'], 'linux')
    ).toBe('allow')
    const rules = effective(custom, childSessionRuleset(withAllow, custom, 'linux'))
    expect(evaluateV2Call(rules, 'shell', ['git push origin main'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'shell', ['git status'], 'linux')).toBe('allow')
    expect(evaluateV2Call(rules, 'edit', ['src/secret/k'], 'linux')).toBe('deny')
    expect(evaluateV2Call(rules, 'edit', ['src/ok.ts'], 'linux')).toBe('ask')
    expect(v2ToolHidden(rules, 'shell', 'linux')).toBe(false)
  })

  it('an agent deny its own later rules carve is left to the host backstop, not over-applied', () => {
    const carved = [...DEFAULTS, v('shell', 'deny', 'git *'), v('shell', 'allow', 'git status')]
    const child = childSessionRuleset(parent('default'), carved, 'linux')
    expect(child).not.toContainEqual(v('shell', 'deny', 'git *'))
    expect(evaluateChildCall(carved, 'shell', 'git push', 'linux')).toBe('deny')
    expect(evaluateChildCall(carved, 'shell', 'git status', 'linux')).toBe('allow')
  })

  it('evaluateChildCall: last match over the agent rules, no match = ask', () => {
    expect(evaluateChildCall(EXPLORE_V2, 'edit', 'a.ts', 'linux')).toBe('deny')
    expect(evaluateChildCall(EXPLORE_V2, 'shell', 'ls', 'linux')).toBe('allow')
    expect(evaluateChildCall([], 'shell', 'ls', 'linux')).toBe('ask')
  })

  it('re-derived for a switched agent (session.agent.selected): same parent, the new agent', () => {
    const session = parent('default')
    const before = childSessionRuleset(session, GENERAL_V2, 'linux')
    const after = childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(v2ToolHidden(effective(GENERAL_V2, before), 'edit', 'linux')).toBe(false)
    expect(v2ToolHidden(effective(EXPLORE_V2, after), 'edit', 'linux')).toBe(true)
  })

  it("the parent's denies need nothing: inherited, they hold in the child", () => {
    const session = parent('plan', ['Bash(rm:*)'])
    const child = childSessionRuleset(session, GENERAL_V2, 'linux')
    expect(v2ToolHidden(effective(GENERAL_V2, child), 'edit', 'linux')).toBe(true)
    expect(evaluateV2Call(effective(GENERAL_V2, child), 'shell', ['rm x'], 'linux')).toBe('deny')
  })

  it('does not mutate the parent ruleset', () => {
    const session = parent('default')
    const copy = structuredClone(session)
    childSessionRuleset(session, EXPLORE_V2, 'linux')
    expect(session).toEqual(copy)
  })
})
