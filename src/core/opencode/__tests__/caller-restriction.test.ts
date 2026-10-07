/**
 * A subagent child's restriction carried into its dispatch (ADR-097 S9,
 * option a): the agent's own rules alone are a floor, mapped to Claude-form
 * deny/ask rules; only ever tighter; a deny with no exact equivalent becomes
 * the whole category.
 */
import { describe, expect, it } from 'vitest'
import {
  callerRestrictionFromAgent,
  mergeRestrictions,
  restrictionCovers,
  restrictionNote
} from '../caller-restriction'
import type { Permission_Rule } from '../protocol-v2/openapi'

const ALLOW_ALL: Permission_Rule = { action: '*', resource: '*', effect: 'allow' }
const rule = (
  action: string,
  effect: Permission_Rule['effect'],
  resource = '*'
): Permission_Rule => ({
  action,
  resource,
  effect
})
const of = (permissions: Permission_Rule[], id = 'custom') =>
  callerRestrictionFromAgent({ id, permissions }, '/repo/pkg', 'darwin')

describe('callerRestrictionFromAgent', () => {
  it("opencode's `general`: no questions, no subagents — nothing else", () => {
    const r = of([ALLOW_ALL, rule('question', 'deny'), rule('subagent', 'deny')], 'general')
    expect([...r.deny].sort()).toEqual(['Agent', 'AskUserQuestion', 'Task'])
    expect(r.ask).toEqual([])
    expect(r.agents).toEqual(['general'])
  })

  it('`edit: deny` → every Claude edit tool denied', () => {
    expect(of([ALLOW_ALL, rule('edit', 'deny')]).deny).toEqual(
      expect.arrayContaining(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
    )
  })

  it('narrow shell, path and URL denies map exactly; asks too', () => {
    const r = of([
      ALLOW_ALL,
      rule('shell', 'deny', 'git push*'),
      rule('edit', 'deny', 'secrets/*'),
      rule('webfetch', 'deny', 'https://evil.example/*'),
      rule('read', 'ask', '/etc/*')
    ])
    expect(r.deny).toEqual(
      expect.arrayContaining([
        'Bash(git push*)',
        'Edit(//repo/pkg/secrets/**)',
        'Write(//repo/pkg/secrets/**)',
        'WebFetch(domain:evil.example)'
      ])
    )
    expect(r.ask).toEqual(expect.arrayContaining(['Read(//etc/**)']))
    expect(r.deny).not.toContain('Bash')
  })

  it('a deny with no exact equivalent is the whole category, never dropped', () => {
    const r = of([
      ALLOW_ALL,
      rule('shell', 'deny', '* --force'),
      rule('webfetch', 'deny', 'https://*.evil/*'),
      rule('glob', 'deny', 'src/**'),
      rule('external_directory', 'deny')
    ])
    expect(r.deny).toEqual(expect.arrayContaining(['Bash', 'WebFetch', 'Glob', 'Read', 'Edit']))
  })

  it('a catch-all deny with carve-outs: the carved categories open, the rest denied whole', () => {
    // opencode's own `explore`.
    const r = of([
      rule('*', 'deny'),
      rule('shell', 'allow'),
      rule('read', 'allow'),
      rule('read', 'ask', '*.env'),
      rule('external_directory', 'ask')
    ])
    expect(r.deny).toEqual(expect.arrayContaining(['Edit', 'Write', 'WebFetch', 'Task']))
    expect(r.deny).not.toContain('Bash')
    expect(r.deny).not.toContain('Read')
    expect(r.ask).toContain('Read(//repo/pkg/**.env)')
  })

  it('no rule for a category is an ask (the floor: no match = ask)', () => {
    const r = of([rule('read', 'allow'), rule('claudeui_*', 'allow')])
    expect(r.ask).toEqual(expect.arrayContaining(['Bash', 'Edit', 'WebFetch']))
    expect(r.ask).not.toContain('Read')
  })

  it("MCP denies restrict the whole server; ClaudeUI's own tools are not the target's", () => {
    const r = of([
      ALLOW_ALL,
      rule('github_create_issue', 'deny'),
      rule('claudeui_render_mermaid', 'deny')
    ])
    expect(r.deny).toContain('mcp__github')
    expect(r.deny.some((d) => d.includes('claudeui'))).toBe(false)
  })

  it('never an allow: a later allow only lifts the floor where the agent itself allows', () => {
    const r = of([ALLOW_ALL, rule('edit', 'deny'), rule('edit', 'allow', 'docs/*')])
    // Carved: not wholly denied, but the catch-all still denies → the whole category.
    expect(r.deny).toEqual(expect.arrayContaining(['Edit', 'Write']))
  })
})

describe('merging and covering', () => {
  const a = { agents: ['a'], deny: ['Edit'], ask: ['Bash'] }
  const b = { agents: ['b'], deny: ['Bash'], ask: ['WebFetch'] }

  it('merge is a union where a deny wins over an ask', () => {
    expect(mergeRestrictions(a, b)).toEqual({
      agents: ['a', 'b'],
      deny: ['Edit', 'Bash'],
      ask: ['WebFetch']
    })
  })

  it('covers: a held restriction must include every wanted rule (a deny cannot be met by an ask)', () => {
    expect(restrictionCovers(a, undefined)).toBe(true)
    expect(restrictionCovers(undefined, a)).toBe(false)
    expect(restrictionCovers(mergeRestrictions(a, b), a)).toBe(true)
    expect(restrictionCovers({ agents: [], deny: [], ask: ['Edit', 'Bash'] }, a)).toBe(false)
  })

  it('the judge note names the agent and what it may not do', () => {
    expect(restrictionNote(a)).toBe(
      'dispatched by the "a" subagent, which may not: Edit; must ask before: Bash'
    )
    expect(restrictionNote(undefined)).toBe('')
  })
})
