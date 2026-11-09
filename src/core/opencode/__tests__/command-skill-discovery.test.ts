/**
 * @vitest-environment node
 *
 * Unit tests for command-skill-discovery.ts — verifies that discoverOpencodeSkills
 * maps opencode 2.x Skill.Info[] → SkillInfo[] correctly and degrades to [] on failure.
 * Stubs OpencodeServerManager + OpencodeClient (no real binary/network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mocks BEFORE vi.mock() calls
// ---------------------------------------------------------------------------

const { mockAcquire, mockRelease, mockListSkills, mockListAgents, MockOpencodeClient } = vi.hoisted(
  () => {
    const mockAcquire = vi.fn()
    // releaseIfCurrent — the exact release for this lease.
    const mockRelease = vi.fn()
    const mockListSkills = vi.fn()
    const mockListAgents = vi.fn()
    const MockOpencodeClient = vi.fn()
    return { mockAcquire, mockRelease, mockListSkills, mockListAgents, MockOpencodeClient }
  }
)

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    releaseIfCurrent: mockRelease
  }
}))

const { catalog } = vi.hoisted(() => ({
  catalog: { entries: [] as unknown[], skipped: [] as unknown[] }
}))
vi.mock('../../services/claude-skill-catalog', () => ({
  resolveClaudeSkillCatalog: () => catalog
}))

vi.mock('../OpencodeClient', () => ({
  OpencodeClient: MockOpencodeClient
}))

vi.mock('../../services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}))

// ---------------------------------------------------------------------------
// Import AFTER mocking
// ---------------------------------------------------------------------------

import type { ClaudeSkillEntry } from '../../services/claude-skill-catalog'
import { discoverOpencodeSkills } from '../command-skill-discovery'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  mockListSkills.mockReset()
  mockListAgents.mockReset()
  MockOpencodeClient.mockReset()
  catalog.entries = []

  mockAcquire.mockImplementation(async (cwd: string) => ({
    baseUrl: 'http://127.0.0.1:9000',
    authHeader: 'Basic test',
    directory: cwd
  }))
  // No agents unless a test says otherwise: nothing is filtered.
  mockListAgents.mockResolvedValue([])
  MockOpencodeClient.mockImplementation(function () {
    return { skills: mockListSkills, agents: mockListAgents }
  })
})

describe('discoverOpencodeSkills', () => {
  it('maps opencode Skill.Info[] → SkillInfo[] with correct fields', async () => {
    mockListSkills.mockResolvedValue([
      {
        id: 'my-skill',
        name: 'my-skill',
        description: 'Does something useful',
        path: '/home/user/.claude/skills/my-skill/SKILL.md',
        content: '# My Skill\nHelp text here.'
      },
      {
        id: 'no-description',
        name: 'no-description',
        path: '/home/user/.agents/skills/no-description/SKILL.md',
        content: '# No Description'
      }
    ])

    const result = await discoverOpencodeSkills('/my/project')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'my-skill',
      displayName: 'my-skill',
      description: 'Does something useful',
      source: 'engine',
      path: '/home/user/.claude/skills/my-skill/SKILL.md',
      content: '# My Skill\nHelp text here.'
    })
    // description defaults to '' when absent
    expect(result[1]).toEqual({
      name: 'no-description',
      displayName: 'no-description',
      description: '',
      source: 'engine',
      path: '/home/user/.agents/skills/no-description/SKILL.md',
      content: '# No Description'
    })
  })

  it('acquires + releases the server (transient pattern), without the hosted-tools wait', async () => {
    mockListSkills.mockResolvedValue([])

    await discoverOpencodeSkills('/my/project')

    expect(mockAcquire).toHaveBeenCalledWith('/my/project', { waitForHostedTools: false })
    const conn = await mockAcquire.mock.results[0].value
    // The client is built on the lease, so it sends the lease's directory.
    expect(MockOpencodeClient).toHaveBeenCalledWith(conn)
    expect(mockRelease).toHaveBeenCalledWith('/my/project', conn)
  })

  it('does not cache: a second call reads the server again (the list follows the skill files)', async () => {
    mockListSkills.mockResolvedValue([{ id: 's', name: 's', path: '/x', content: 'c' }])
    await discoverOpencodeSkills('/same/cwd')
    await discoverOpencodeSkills('/same/cwd')
    expect(mockAcquire).toHaveBeenCalledTimes(2)
  })

  it('a skill the Claude catalog supplied takes its source, kind, flags and claudeOnly; the rest are engine skills', async () => {
    const entry = (name: string, extra: Partial<ClaudeSkillEntry>): ClaudeSkillEntry => ({
      name,
      kind: 'skill',
      source: 'project',
      file: `/proj/.claude/skills/${name}/SKILL.md`,
      description: `claude ${name}`,
      argumentNames: [],
      body: `claude body ${name}`,
      userInvocable: true,
      modelInvocable: true,
      claudeOnly: [],
      ...extra
    })
    catalog.entries = [
      entry('deploy', {
        displayName: 'Deploy',
        claudeOnly: ['allowed-tools'],
        userInvocable: false
      }),
      entry('p:fmt', { source: 'plugin', pluginName: 'p', kind: 'command', modelInvocable: false }),
      // The engine's own `.agents` skill of the same id won the clash: its path differs.
      entry('clash', {})
    ]
    mockListSkills.mockResolvedValue([
      { id: 'deploy', name: 'Deploy', path: '/proj/.claude/skills/deploy/SKILL.md', content: 'x' },
      { id: 'p:fmt', name: 'p:fmt', path: '/proj/.claude/skills/p:fmt/SKILL.md', content: 'x' },
      {
        id: 'clash',
        name: 'clash',
        path: '/proj/.agents/skills/clash/SKILL.md',
        content: 'engine'
      },
      { id: 'own', name: 'own', path: '/proj/.opencode/skills/own/SKILL.md', content: 'own' }
    ])
    const result = await discoverOpencodeSkills('/proj')
    expect(result.find((s) => s.name === 'deploy')).toEqual({
      name: 'deploy',
      displayName: 'Deploy',
      description: 'claude deploy',
      source: 'project',
      path: '/proj/.claude/skills/deploy/SKILL.md',
      content: 'claude body deploy',
      kind: 'skill',
      userInvocable: false,
      modelInvocable: true,
      claudeOnly: ['allowed-tools']
    })
    expect(result.find((s) => s.name === 'clash')).toMatchObject({
      source: 'engine',
      content: 'engine'
    })
    expect(result.find((s) => s.name === 'own')).toMatchObject({ source: 'engine' })
    expect(result.find((s) => s.name === 'p:fmt')).toMatchObject({
      source: 'plugin',
      pluginName: 'p',
      kind: 'command',
      modelInvocable: false
    })
  })

  it('hides a skill EVERY agent denies (the browser plugin denies `Browser` on every agent)', async () => {
    // `packages/plugin-browser/src/connection.ts` appends `{action:"skill", resource:"browser",
    // effect:"deny"}` to every agent; only an attached browser allows it, and ClaudeUI never
    // attaches one. `GET /api/skill` still lists it, `skill.list` being unfiltered.
    const browserDeny = { action: 'skill', resource: 'browser', effect: 'deny' }
    mockListSkills.mockResolvedValue([
      { id: 'browser', name: 'Browser', path: '/builtin/browser.md', content: '# In-app browser' },
      { id: 'my-skill', name: 'my-skill', path: '/x/SKILL.md', content: 'c' }
    ])
    mockListAgents.mockResolvedValue([
      { id: 'build', permissions: [browserDeny] },
      { id: 'explore', permissions: [browserDeny] }
    ])

    const result = await discoverOpencodeSkills('/skills/denied')

    expect(result.map((s) => s.name)).toEqual(['my-skill'])
  })

  it('keeps a skill at least one agent may load, and everything when the agent list is unknown', async () => {
    const browserDeny = { action: 'skill', resource: 'browser', effect: 'deny' }
    mockListSkills.mockResolvedValue([
      { id: 'browser', name: 'Browser', path: '/builtin/browser.md', content: '' },
      { id: 'deploy', name: 'deploy', path: '/x/SKILL.md', content: '' }
    ])
    // `deploy` is denied by one agent only; `browser` by every agent except one that allows it.
    mockListAgents.mockResolvedValue([
      {
        id: 'build',
        permissions: [browserDeny, { action: 'skill', resource: 'deploy', effect: 'deny' }]
      },
      { id: 'review', permissions: [{ action: 'skill', resource: '*', effect: 'allow' }] }
    ])
    expect((await discoverOpencodeSkills('/skills/partial')).map((s) => s.name)).toEqual([
      'Browser',
      'deploy'
    ])

    // A cold or failed `agent.list` filters nothing rather than emptying the dialog.
    mockListAgents.mockRejectedValue(new Error('agent.list → 500'))
    expect((await discoverOpencodeSkills('/skills/partial')).map((s) => s.name)).toEqual([
      'Browser',
      'deploy'
    ])
  })

  it('degrades to [] on acquire failure (opencode optional)', async () => {
    mockAcquire.mockRejectedValue(new Error('binary not found'))

    const result = await discoverOpencodeSkills('/fail/cwd')

    expect(result).toEqual([])
  })

  it('degrades to [] on listSkills failure', async () => {
    mockListSkills.mockRejectedValue(new Error('opencode skill.list (GET /api/skill) → 500'))

    const result = await discoverOpencodeSkills('/fail2/cwd')

    expect(result).toEqual([])
    // Server was acquired + must be released even on failure
    expect(mockRelease).toHaveBeenCalledWith('/fail2/cwd', expect.anything())
  })
})
