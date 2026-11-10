import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('transcript producers use item lifecycle', () => {
  const RETIRED_CHANNEL = /(?:send|emitEvent)\(\s*['"]session:(?:subagent-)?stream['"]/
  const read = (relativePath: string): string =>
    readFileSync(join(process.cwd(), relativePath), 'utf8')

  const producers = [
    'src/core/services/claude-session.ts',
    'src/core/opencode/OpencodeSession.ts',
    'src/core/pi/PiSession.ts',
    // Dispatch targets: the Claude and opencode target modules produce transcript items.
    'src/core/services/dispatch-claude-targets.ts',
    'src/core/services/dispatch-opencode-targets.ts'
  ]

  it.each(producers)('%s does not emit a retired transcript channel', (relativePath) => {
    const source = read(relativePath)
    expect(source).toMatch(/session:item-open/)
    expect(source).toMatch(/session:item-delta/)
    expect(source).toMatch(/session:item-seal/)
    expect(source).not.toMatch(RETIRED_CHANNEL)
  })

  // The rest of the dispatcher (one file until it was split per engine): these produce no
  // transcript items of their own, and must not start emitting a retired channel either.
  const dispatcherRest = [
    'src/core/services/cross-engine-dispatcher.ts',
    'src/core/services/dispatch-pi-targets.ts',
    'src/core/services/dispatch-target-shared.ts'
  ]

  it.each(dispatcherRest)('%s emits no retired transcript channel', (relativePath) => {
    expect(read(relativePath)).not.toMatch(RETIRED_CHANNEL)
  })
})
