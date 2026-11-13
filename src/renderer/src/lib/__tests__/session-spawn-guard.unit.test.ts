/**
 * @vitest-environment node
 *
 * `spawnSession` (`lib/session-spawn.ts`) owns the steps around an engine spawn (reload wait,
 * model check, pending worktree, config resolution, fork or resume, announce, `markSdkActive`).
 * A second `createSession(` call skips them, which is how the eight copies drifted.
 */
import { describe, it, expect } from 'vitest'
import { isTestFile, listSourceFiles, readSource } from '../../../../test/helpers/source-graph'

describe('renderer spawns', () => {
  it('only lib/session-spawn.ts calls createSession', () => {
    const callers = listSourceFiles().filter(
      (f) =>
        f.startsWith('src/renderer/src/') &&
        !isTestFile(f) &&
        /\bcreateSession\(/.test(readSource(f))
    )
    expect(
      callers,
      'Spawn through `spawnSession(routingId, opts)` from `src/renderer/src/lib/session-spawn.ts`.'
    ).toEqual(['src/renderer/src/lib/session-spawn.ts'])
  })
})
