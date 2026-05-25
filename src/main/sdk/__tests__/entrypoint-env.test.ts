import { describe, it, expect } from 'vitest'
import { buildEnv } from '../args'

describe('buildEnv entrypoint identification', () => {
  it('sets CLAUDE_CODE_ENTRYPOINT=claude-desktop on every spawn', () => {
    const env = buildEnv({})
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
  })

  it('overrides an inherited CLAUDE_CODE_ENTRYPOINT from the parent process', () => {
    const env = buildEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' })
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('claude-desktop')
  })
})
