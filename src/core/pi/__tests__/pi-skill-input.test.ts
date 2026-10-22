import { describe, expect, it } from 'vitest'
import type { ClaudeSkillCatalog } from '../../skills/claude-skills'
import type { PiCommandEntry } from '../pi-protocol'
import { blockedNativeClaudeSkillNames, unavailableClaudeSkillCommand } from '../pi-skill-input'

describe('Pi native skill command boundary', () => {
  const catalog: ClaudeSkillCatalog = {
    sourceRoots: ['/project/.claude/skills'],
    revision: '',
    warnings: [],
    skills: [
      {
        name: 'plugin:task',
        aliases: ['task', 'model-only'],
        path: '/project/.claude/skills/task/SKILL.md',
        directory: '/project/.claude/skills/task',
        description: 'Task',
        content: 'Task body',
        source: 'project',
        userInvocable: true,
        modelInvocable: true,
        compatibilityWarnings: []
      },
      {
        name: 'model-only',
        path: '/project/.claude/skills/model-only/SKILL.md',
        directory: '/project/.claude/skills/model-only',
        description: 'Model',
        content: 'Model body',
        source: 'project',
        userInvocable: false,
        modelInvocable: true,
        compatibilityWarnings: []
      }
    ]
  }
  const skill = (name: string, path: string): PiCommandEntry => ({
    name: `skill:${name}`,
    source: 'skill',
    sourceInfo: { path }
  })

  it('blocks excluded Claude native names but keeps selected aliases and unrelated Pi roots', () => {
    const blocked = blockedNativeClaudeSkillNames(
      [
        skill('off', '/project/.claude/skills/off/SKILL.md'),
        skill('plugin:task', '/project/.claude/skills/task/SKILL.md'),
        skill('task', '/project/.claude/skills/old-task/SKILL.md'),
        skill('native', '/project/.pi/skills/native/SKILL.md'),
        skill('sibling', '/project/.claude/skills-old/sibling/SKILL.md')
      ],
      catalog
    )
    expect([...blocked]).toEqual(['off'])
    expect(unavailableClaudeSkillCommand('/skill:off args', catalog, blocked, true)).toBe('off')
    expect(unavailableClaudeSkillCommand('/skill:model-only', catalog, blocked, true)).toBe(
      'model-only'
    )
    expect(
      unavailableClaudeSkillCommand('/skill:plugin:task args', catalog, blocked, true)
    ).toBeNull()
    expect(unavailableClaudeSkillCommand('/skill:task', catalog, blocked, true)).toBeNull()
    expect(unavailableClaudeSkillCommand('/skill:native', catalog, blocked, true)).toBeNull()
    expect(unavailableClaudeSkillCommand('/skill:sibling', catalog, blocked, true)).toBeNull()
    expect(unavailableClaudeSkillCommand('hello /skill:off', catalog, blocked, true)).toBeNull()
  })

  it('uses Pi’s first-literal-space name grammar and fails closed without a command inventory', () => {
    const blocked = new Set(['bad/name', '雪', 'tab\tname'])
    expect(unavailableClaudeSkillCommand('/skill:bad/name run', catalog, blocked, true)).toBe(
      'bad/name'
    )
    expect(unavailableClaudeSkillCommand('/skill:雪 run', catalog, blocked, true)).toBe('雪')
    expect(unavailableClaudeSkillCommand('/skill:tab\tname run', catalog, blocked, true)).toBe(
      'tab\tname'
    )
    expect(unavailableClaudeSkillCommand('/skill:unknown run', catalog, blocked, false)).toBe(
      'unknown'
    )
    expect(
      unavailableClaudeSkillCommand('/skill:plugin:task run', catalog, blocked, false)
    ).toBeNull()
    expect(unavailableClaudeSkillCommand('plain text', catalog, blocked, false)).toBeNull()
  })

  it('rejects selected commands whose arguments the shared renderer cannot parse', () => {
    const blocked = new Set<string>()
    for (const command of [
      '/skill:plugin:task "unterminated',
      `/skill:plugin:task ${'a'.repeat(65 * 1024)}`,
      `/skill:plugin:task ${Array(129).fill('a').join(' ')}`
    ]) {
      expect(unavailableClaudeSkillCommand(command, catalog, blocked, true)).toBe('plugin:task')
    }
  })

  it('rejects malformed native inventories before they can be marked verified', () => {
    for (const malformed of [
      null,
      {},
      { name: 'skill:off', source: 'skill' },
      { name: 'skill:off', source: 'skill', sourceInfo: { path: 'relative/SKILL.md' } }
    ]) {
      expect(() => blockedNativeClaudeSkillNames([malformed] as never, catalog)).toThrow()
    }
    expect([
      ...blockedNativeClaudeSkillNames(
        [
          { name: 'session-name', source: 'extension' },
          { name: 'fix-tests', source: 'prompt' }
        ],
        catalog
      )
    ]).toEqual([])
  })
})
