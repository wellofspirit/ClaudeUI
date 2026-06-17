/**
 * Unit tests for pure helper logic embedded in WelcomeState.tsx and TopBar.tsx.
 *
 * Neither sanitizeWorktreeName nor generateRandomName are exported from
 * WelcomeState.tsx, and the cost/duration formatting is inline JSX in TopBar.tsx.
 * We replicate the functions verbatim from source for standalone testing.
 *
 * sanitizeWorktreeName (from WelcomeState.tsx ln 27-29):
 *   val.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30)
 *
 * TopBar cost formatting (TopBar.tsx ln 157):
 *   cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)
 *
 * TopBar duration formatting (TopBar.tsx ln 165-167):
 *   durationMs < 60000 ? `${Math.floor(durationMs / 1000)}s`
 *                      : `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Replicated pure functions (mirrors WelcomeState.tsx + TopBar.tsx exactly)
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  'swift',
  'calm',
  'bold',
  'keen',
  'warm',
  'cool',
  'wild',
  'soft',
  'fair',
  'deep',
  'pure',
  'dark',
  'safe',
  'firm',
  'vast'
]
const NOUNS = [
  'river',
  'stone',
  'cloud',
  'flame',
  'frost',
  'ridge',
  'creek',
  'grove',
  'bloom',
  'cedar',
  'maple',
  'cliff',
  'brook',
  'trail',
  'haven'
]

function generateRandomName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

function sanitizeWorktreeName(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30)
}

function formatCost(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 60000) return `${Math.floor(durationMs / 1000)}s`
  return `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
}

// ---------------------------------------------------------------------------
// sanitizeWorktreeName
// ---------------------------------------------------------------------------

describe('sanitizeWorktreeName', () => {
  it('leaves a valid lowercase-alphanumeric-hyphen name unchanged', () => {
    expect(sanitizeWorktreeName('my-branch')).toBe('my-branch')
  })

  it('converts uppercase letters to lowercase', () => {
    expect(sanitizeWorktreeName('MyBranch')).toBe('mybranch')
  })

  it('strips underscores and special characters', () => {
    expect(sanitizeWorktreeName('my_branch!@#')).toBe('mybranch')
  })

  it('preserves hyphens', () => {
    expect(sanitizeWorktreeName('my-branch')).toBe('my-branch')
  })

  it('preserves digits', () => {
    expect(sanitizeWorktreeName('feature-123')).toBe('feature-123')
  })

  it('truncates to 30 characters', () => {
    const long = 'a'.repeat(35)
    expect(sanitizeWorktreeName(long)).toBe('a'.repeat(30))
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeWorktreeName('')).toBe('')
  })

  it('strips spaces', () => {
    expect(sanitizeWorktreeName('my branch name')).toBe('mybranchname')
  })

  it('strips dots and slashes', () => {
    expect(sanitizeWorktreeName('feat/my.branch')).toBe('featmybranch')
  })

  it('a 30-char input is not truncated', () => {
    const exactly30 = 'a'.repeat(30)
    expect(sanitizeWorktreeName(exactly30)).toBe(exactly30)
  })

  it('a 31-char input is truncated to 30', () => {
    const thirtyOne = 'b'.repeat(31)
    expect(sanitizeWorktreeName(thirtyOne)).toHaveLength(30)
  })

  it('mixed case with hyphens and digits round-trips correctly', () => {
    expect(sanitizeWorktreeName('Feature-123-ABC')).toBe('feature-123-abc')
  })
})

// ---------------------------------------------------------------------------
// generateRandomName
// ---------------------------------------------------------------------------

describe('generateRandomName', () => {
  it('returns a string matching adj-noun pattern', () => {
    const name = generateRandomName()
    expect(name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('uses only known adjectives and nouns', () => {
    const name = generateRandomName()
    const [adj, noun] = name.split('-')
    expect(ADJECTIVES).toContain(adj)
    expect(NOUNS).toContain(noun)
  })

  it('passes sanitizeWorktreeName without modification', () => {
    // Generated names should already be valid worktree names
    for (let i = 0; i < 20; i++) {
      const name = generateRandomName()
      expect(sanitizeWorktreeName(name)).toBe(name)
    }
  })

  it('produces varied output across multiple calls', () => {
    // With 15x15 = 225 possible names the probability of 10 identical in a row is negligible
    const names = new Set(Array.from({ length: 10 }, () => generateRandomName()))
    expect(names.size).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// formatCost (TopBar inline logic)
// ---------------------------------------------------------------------------

describe('formatCost', () => {
  it('formats sub-cent cost to 4 decimal places', () => {
    expect(formatCost(0.005)).toBe('$0.0050')
  })

  it('formats 0.009 to 4 decimal places', () => {
    expect(formatCost(0.009)).toBe('$0.0090')
  })

  it('formats exactly 0.01 to 2 decimal places', () => {
    expect(formatCost(0.01)).toBe('$0.01')
  })

  it('formats a dollar amount to 2 decimal places', () => {
    expect(formatCost(1.5)).toBe('$1.50')
  })

  it('formats 0.001 to 4 decimal places', () => {
    expect(formatCost(0.001)).toBe('$0.0010')
  })

  it('formats zero to 4 decimal places (sub-cent)', () => {
    expect(formatCost(0)).toBe('$0.0000')
  })

  it('formats a larger cost correctly', () => {
    expect(formatCost(12.345)).toBe('$12.35')
  })

  it('boundary: 0.0099 is still sub-cent → 4dp', () => {
    expect(formatCost(0.0099)).toBe('$0.0099')
  })
})

// ---------------------------------------------------------------------------
// formatDuration (TopBar inline logic)
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('formats 5 seconds correctly', () => {
    expect(formatDuration(5000)).toBe('5s')
  })

  it('formats 59999ms as 59s (floors correctly)', () => {
    expect(formatDuration(59999)).toBe('59s')
  })

  it('formats exactly 60000ms as 1m 0s', () => {
    expect(formatDuration(60000)).toBe('1m 0s')
  })

  it('formats 90000ms as 1m 30s', () => {
    expect(formatDuration(90000)).toBe('1m 30s')
  })

  it('formats 125000ms as 2m 5s', () => {
    expect(formatDuration(125000)).toBe('2m 5s')
  })

  it('formats 0ms as 0s', () => {
    expect(formatDuration(0)).toBe('0s')
  })

  it('formats 1000ms as 1s', () => {
    expect(formatDuration(1000)).toBe('1s')
  })

  it('formats exactly 2 minutes as 2m 0s', () => {
    expect(formatDuration(120000)).toBe('2m 0s')
  })

  it('floors sub-second remainder in minutes display', () => {
    // 61500ms = 1m 1.5s → should floor to 1m 1s
    expect(formatDuration(61500)).toBe('1m 1s')
  })
})
