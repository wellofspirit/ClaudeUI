/**
 * The per-file guarantees of `src/test/setup/process-reset.ts` that one file can observe by
 * itself. The env/cwd restore, the exit-listener cleanup and the leak guard are about the files
 * AROUND this one; they were proven with throwaway files run in one worker (`--maxWorkers=1`).
 */
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
      expect(() => process.dlopen({ exports: {} } as NodeJS.Module, 'some-addon.node')).toThrow(
        /native addon some-addon\.node loaded under vmForks: add .*process-reset\.unit\.test\.ts to FORKS_ONLY in vitest\.config\.ts/
      )
    }
  )
})
