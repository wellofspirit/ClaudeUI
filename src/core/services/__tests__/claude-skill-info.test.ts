/**
 * @vitest-environment node
 *
 * The catalog entry -> SkillInfo / slash-menu mapping every engine session shares.
 */
import { describe, it, expect } from 'vitest'
import {
  claudeSkillEntryToInfo,
  claudeSkillSlashCommands,
  mergeSlashCommandLists
} from '../claude-skill-info'
import type { ClaudeSkillEntry } from '../claude-skill-catalog'

function entry(overrides: Partial<ClaudeSkillEntry> = {}): ClaudeSkillEntry {
  return {
    name: 'deploy',
    kind: 'skill',
    source: 'project',
    file: '/repo/.claude/skills/deploy/SKILL.md',
    baseDir: '/repo/.claude/skills/deploy',
    description: 'Ship it',
    argumentNames: [],
    body: '# Deploy',
    userInvocable: true,
    modelInvocable: true,
    claudeOnly: [],
    ...overrides
  }
}

describe('claudeSkillEntryToInfo', () => {
  it('maps the entry fields the dialog shows', () => {
    expect(
      claudeSkillEntryToInfo(
        entry({
          name: 'p:s',
          displayName: 'S',
          source: 'plugin',
          pluginName: 'p',
          kind: 'command',
          userInvocable: false,
          modelInvocable: false
        })
      )
    ).toEqual({
      name: 'p:s',
      displayName: 'S',
      description: 'Ship it',
      source: 'plugin',
      pluginName: 'p',
      path: '/repo/.claude/skills/deploy/SKILL.md',
      content: '# Deploy',
      kind: 'command',
      userInvocable: false,
      modelInvocable: false
    })
  })

  it('carries claudeOnly only when asked (non-Claude sessions) and non-empty', () => {
    const e = entry({ claudeOnly: ['context', 'hooks'] })
    expect(claudeSkillEntryToInfo(e).claudeOnly).toBeUndefined()
    expect(claudeSkillEntryToInfo(e, { includeClaudeOnly: true }).claudeOnly).toEqual([
      'context',
      'hooks'
    ])
    expect(claudeSkillEntryToInfo(entry(), { includeClaudeOnly: true }).claudeOnly).toBeUndefined()
  })
})

describe('slash menu helpers', () => {
  it('lists only user-invocable entries, as /name', () => {
    expect(
      claudeSkillSlashCommands([
        entry({ name: 'a', description: 'A' }),
        entry({ name: 'hidden', userInvocable: false }),
        entry({ name: 'b', description: '' })
      ])
    ).toEqual([{ name: '/a', description: 'A' }, { name: '/b' }])
  })

  it('caps a menu description at 100 characters with an ellipsis (the dialog keeps the full text)', () => {
    const long = 'x'.repeat(250)
    const [menu] = claudeSkillSlashCommands([entry({ name: 'long', description: long })])
    expect(menu.description).toHaveLength(100)
    expect(menu.description!.endsWith('…')).toBe(true)
    expect(claudeSkillEntryToInfo(entry({ description: long })).description).toBe(long)
    expect(
      claudeSkillSlashCommands([entry({ description: 'y'.repeat(100) })])[0].description
    ).toHaveLength(100)
  })

  it('merge keeps the base first and wins a name clash', () => {
    expect(
      mergeSlashCommandLists(
        [{ name: '/review', description: 'engine' }],
        [{ name: '/review', description: 'catalog' }, { name: '/deploy' }]
      )
    ).toEqual([{ name: '/review', description: 'engine' }, { name: '/deploy' }])
  })
})
