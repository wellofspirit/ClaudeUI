/**
 * The per-file guarantees of `src/test/setup/process-reset.ts` that one file can observe by
 * itself. The env/cwd restore, the exit-listener cleanup and the leak guard are about the files
 * AROUND this one; they were proven with throwaway files run in one worker (`--maxWorkers=1`).
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('process-reset', () => {
  it("puts this file's home under the run's test-home root, never the developer's", () => {
    const home = process.env.CLAUDEUI_TEST_HOME as string
    expect(homedir()).toBe(home)
    expect(home.startsWith(join(tmpdir(), 'claudeui-test-home'))).toBe(true)
    // vitest.config.ts captured the real home before moving it.
    expect(process.env.CLAUDEUI_REAL_HOME).toBeTruthy()
    expect(homedir()).not.toBe(process.env.CLAUDEUI_REAL_HOME)
    expect(process.env.HOME).toBe(home)
    expect(process.env.USERPROFILE).toBe(home)
  })

  it.runIf(process.env.VITEST_VM_POOL === '1')(
    'refuses a native addon under vmForks and names the file to move',
    () => {
      try {
        expect(() => process.dlopen({ exports: {} } as NodeJS.Module, 'some-addon.node')).toThrow(
          /native addon some-addon\.node loaded under vmForks: add src\/test\/setup\/__tests__\/process-reset\.unit\.test\.ts to FORKS_ONLY in vitest\.config\.ts/
        )
      } finally {
        // The attempt was deliberate: it must not fail this file in the setup's afterAll.
        const state = (process as unknown as Record<symbol, { dlopenAttempts: string[] }>)[
          Symbol.for('claudeui.processReset')
        ]
        state.dlopenAttempts.length = 0
      }
    }
  )

  // Built-in modules belong to the host realm, so under a vm pool their errors would fail the
  // context's own `instanceof Error` (and send production code down another branch).
  it.runIf(process.env.VITEST_VM_POOL === '1')(
    "accepts Node's own errors as instanceof Error, but only for the base class",
    async () => {
      const missing = join(tmpdir(), 'claudeui-no-such-file', 'x')
      const thrown = (fn: () => unknown): unknown => {
        try {
          fn()
        } catch (error) {
          return error
        }
        throw new Error('expected a throw')
      }
      const fsError = thrown(() => readFileSync(missing))
      const fsPromisesError = await readFile(missing).catch((error: unknown) => error)
      const signal = AbortSignal.timeout(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      for (const error of [fsError, fsPromisesError, signal.reason]) {
        expect(error instanceof Error).toBe(true)
      }
      expect({} instanceof Error).toBe(false)
      expect(new RangeError('x') instanceof TypeError).toBe(false)
      expect(fsError instanceof TypeError).toBe(false)
    }
  )
})
