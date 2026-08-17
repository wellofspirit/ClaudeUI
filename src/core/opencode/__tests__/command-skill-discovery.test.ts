/**
 * @vitest-environment node
 *
 * Unit tests for command-skill-discovery.ts — verifies that discoverOpencodeSkills
 * maps opencode Skill[] → SkillInfo[] correctly and degrades to [] on failure.
 * Stubs OpencodeServerManager + OpencodeClient (no real binary/network).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mocks BEFORE vi.mock() calls
// ---------------------------------------------------------------------------

const { mockAcquire, mockRelease, mockListSkills, MockOpencodeClient } = vi.hoisted(() => {
  const mockAcquire = vi.fn()
  const mockRelease = vi.fn()
  const mockListSkills = vi.fn()
  const MockOpencodeClient = vi.fn()
  return { mockAcquire, mockRelease, mockListSkills, MockOpencodeClient }
})

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: {
    acquire: mockAcquire,
    release: mockRelease
  }
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

import { discoverOpencodeSkills, invalidateOpencodeSkillCache } from '../command-skill-discovery'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  mockListSkills.mockReset()
  MockOpencodeClient.mockReset()
  // Invalidate cache so each test starts fresh
  invalidateOpencodeSkillCache()

  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9000', authHeader: 'Basic test' })
  MockOpencodeClient.mockImplementation(function () {
    return { listSkills: mockListSkills }
  })
})

describe('discoverOpencodeSkills', () => {
  it('maps opencode Skill[] → SkillInfo[] with correct fields', async () => {
    mockListSkills.mockResolvedValue([
      {
        name: 'my-skill',
        description: 'Does something useful',
        location: '/home/user/.claude/skills/my-skill/SKILL.md',
        content: '# My Skill\nHelp text here.'
      },
      {
        name: 'no-description',
        location: '/home/user/.agents/skills/no-description/SKILL.md',
        content: '# No Description'
      }
    ])

    const result = await discoverOpencodeSkills('/my/project')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'my-skill',
      displayName: 'my-skill',
      description: 'Does something useful',
      source: 'project',
      path: '/home/user/.claude/skills/my-skill/SKILL.md',
      content: '# My Skill\nHelp text here.'
    })
    // description defaults to '' when absent
    expect(result[1]).toEqual({
      name: 'no-description',
      displayName: 'no-description',
      description: '',
      source: 'project',
      path: '/home/user/.agents/skills/no-description/SKILL.md',
      content: '# No Description'
    })
  })

  it('acquires + releases the server (transient pattern)', async () => {
    mockListSkills.mockResolvedValue([])

    await discoverOpencodeSkills('/my/project')

    expect(mockAcquire).toHaveBeenCalledWith('/my/project')
    expect(mockRelease).toHaveBeenCalledWith('/my/project')
  })

  it('caches the result — second call does not re-acquire', async () => {
    mockListSkills.mockResolvedValue([{ name: 's', location: '/x', content: 'c' }])

    const first = await discoverOpencodeSkills('/cached/cwd')
    const second = await discoverOpencodeSkills('/cached/cwd')

    expect(mockAcquire).toHaveBeenCalledTimes(1)
    expect(first).toBe(second) // same reference
  })

  it('different cwds have separate cache entries', async () => {
    mockListSkills
      .mockResolvedValueOnce([{ name: 'skill-a', location: '/a', content: 'a' }])
      .mockResolvedValueOnce([{ name: 'skill-b', location: '/b', content: 'b' }])

    const a = await discoverOpencodeSkills('/cwd/a')
    const b = await discoverOpencodeSkills('/cwd/b')

    expect(a[0].name).toBe('skill-a')
    expect(b[0].name).toBe('skill-b')
    expect(mockAcquire).toHaveBeenCalledTimes(2)
  })

  it('degrades to [] on acquire failure (opencode optional)', async () => {
    mockAcquire.mockRejectedValue(new Error('binary not found'))

    const result = await discoverOpencodeSkills('/fail/cwd')

    expect(result).toEqual([])
  })

  it('degrades to [] on listSkills failure', async () => {
    mockListSkills.mockRejectedValue(new Error('opencode GET /skill → 500'))

    const result = await discoverOpencodeSkills('/fail2/cwd')

    expect(result).toEqual([])
    // Server was acquired + must be released even on failure
    expect(mockRelease).toHaveBeenCalledWith('/fail2/cwd')
  })

  it('invalidateOpencodeSkillCache(cwd) clears only that cwd', async () => {
    mockListSkills.mockResolvedValue([{ name: 's', location: '/x', content: '' }])

    await discoverOpencodeSkills('/clear/this')
    await discoverOpencodeSkills('/keep/this')

    invalidateOpencodeSkillCache('/clear/this')

    // '/clear/this' re-fetches; '/keep/this' still cached
    mockListSkills.mockResolvedValue([{ name: 's2', location: '/y', content: '' }])
    const re = await discoverOpencodeSkills('/clear/this')
    expect(re[0].name).toBe('s2')
    expect(mockAcquire).toHaveBeenCalledTimes(3) // original 2 + 1 re-fetch
  })

  it('invalidateOpencodeSkillCache() (no cwd) clears all', async () => {
    mockListSkills.mockResolvedValue([{ name: 's', location: '/x', content: '' }])
    await discoverOpencodeSkills('/cwd1')
    await discoverOpencodeSkills('/cwd2')

    invalidateOpencodeSkillCache()

    // Both are re-fetched
    mockListSkills.mockResolvedValue([])
    await discoverOpencodeSkills('/cwd1')
    await discoverOpencodeSkills('/cwd2')
    expect(mockAcquire).toHaveBeenCalledTimes(4)
  })
})
