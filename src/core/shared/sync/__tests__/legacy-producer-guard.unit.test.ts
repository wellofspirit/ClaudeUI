import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('transcript producers use item lifecycle', () => {
  const producers = [
    'src/core/services/claude-session.ts',
    'src/core/opencode/OpencodeSession.ts',
    'src/core/pi/PiSession.ts',
    'src/core/codex/CodexSession.ts',
    'src/core/services/cross-engine-dispatcher.ts'
  ]

  it.each(producers)('%s does not emit a retired transcript channel', (relativePath) => {
    const source = readFileSync(join(process.cwd(), relativePath), 'utf8')
    expect(source).toMatch(/session:item-open/)
    expect(source).toMatch(/session:item-delta/)
    expect(source).toMatch(/session:item-seal/)
    expect(source).not.toMatch(/(?:send|emitEvent)\(\s*['"]session:(?:subagent-)?stream['"]/)
  })
})
