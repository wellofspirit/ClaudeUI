/**
 * Which vitest command lines may drop the browser project (`scripts/lib/vitest-focus.mjs`, called by
 * vitest.config.ts). The only wrong answer allowed is `false`.
 */
import { describe, expect, it } from 'vitest'
import { namesOnlyNonBrowserSpecs } from '../../../../scripts/lib/vitest-focus.mjs'

const NODE = 'src/core/automode/__tests__/retry-match.test.ts'
const COMP = 'src/renderer/src/components/Foo.component.test.tsx'
const BROWSER = 'src/renderer/src/components/Foo.browser.test.tsx'

describe('namesOnlyNonBrowserSpecs', () => {
  it.each<[string, string[], boolean]>([
    ['a node spec', [NODE], true],
    ['with the run subcommand', ['run', NODE], true],
    ['a component spec', [COMP], true],
    ['a line suffix', [`${NODE}:42`], true],
    ['two specs', [NODE, COMP], true],
    ['--run flag', ['--run', NODE], true],
    ['a browser spec', [BROWSER], false],
    ['a mixed list with a browser spec', [NODE, BROWSER], false],
    ['a directory filter', ['src/renderer/src/components'], false],
    ['a bare name filter', ['retry-match'], false],
    ['no positionals', [], false],
    ['no positionals with a flag', ['run', '--reporter', 'verbose'], false],
    ['related', ['related', 'src/renderer/src/components/chat/ChatPanel/TopBar.tsx'], false],
    ['related with a spec', ['related', NODE], false],
    ['list', ['list', NODE], false],
    ['--project value', ['--project', 'unit-node', NODE], false],
    ['--project=value', ['--project=browser', NODE], false],
    ['--browser.enabled', ['--browser.enabled', NODE], false],
    ['--dir', ['--dir', 'src', NODE], false],
    ['--changed', ['--changed', NODE], false],
    ['-c config', ['-c', 'x.ts', NODE], false],
    ['-t value that looks like a spec', ['-t', 'some name.test.ts', NODE], true],
    ['-t value alone', ['-t', 'some name.test.ts'], false],
    ['--reporter value', ['--reporter', 'verbose', NODE], true],
    ['--testNamePattern=value', ['--testNamePattern=x', NODE], true],
    ['an unknown value flag then a non-spec', ['--exclude', 'foo', NODE], false],
    ['an unknown flag swallowing a spec', ['--silent', NODE], false],
    ['an unknown flag after the spec', [NODE, '--silent'], true]
  ])('%s', (_name, argv, expected) => {
    expect(namesOnlyNonBrowserSpecs(argv)).toBe(expected)
  })
})
