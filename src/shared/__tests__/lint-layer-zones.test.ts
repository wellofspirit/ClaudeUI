// @vitest-environment node
// Lints virtual source through the REAL eslint.config.mjs: the `layer/zones` rule
// must fire for one violating import per zone, and stay quiet for allowed ones.
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

const ROOT = resolve(__dirname, '../../..')
let eslint: ESLint

beforeAll(async () => {
  eslint = new ESLint({ cwd: ROOT })
  // The first lint loads the config and the TypeScript parser, which takes several
  // seconds on a slow runner (7.9 s seen on macOS CI): pay it here, under its own
  // budget, so it is not charged to the first case's default timeout.
  await eslint.lintText('', { filePath: resolve(ROOT, 'src/shared/x.ts') })
}, 60_000)

async function layerMessages(filePath: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: resolve(ROOT, filePath) })
  return res.messages.filter((m) => m.ruleId === 'layer/zones').map((m) => m.message)
}

describe('layer/zones lint rule', () => {
  const violations: Array<[string, string, string]> = [
    ['1 core -> main', 'src/core/services/x.ts', "import '../../main/index'"],
    ['1 core -> renderer (alias)', 'src/core/services/x.ts', "import '@renderer/stores/app'"],
    [
      '2 renderer -> core',
      'src/renderer/src/lib/x.ts',
      "import { a } from '../../../core/services/db'"
    ],
    ['2 web -> core (export from)', 'src/web/x.ts', "export * from '../core/services/db'"],
    [
      '3 renderer -> main',
      'src/renderer/src/lib/x.ts',
      "import type { A } from '../../../main/index'"
    ],
    ['4 shared -> core', 'src/shared/x.ts', "const m = import('../core/services/db')"],
    ['5 server -> main', 'src/server/x.ts', "import '../main/index'"],
    ['6 preload -> core', 'src/preload/x.ts', "import '../core/services/db'"],
    ['7 production -> test', 'src/core/services/x.ts', "import '../../test/helpers/migration-db'"],
    ['7 production -> __tests__', 'src/shared/x.ts', "import '../core/shared/__tests__/y'"],
    ['7 production -> a spec file', 'src/shared/x.ts', "import './y.test'"],
    [
      '1 core -> main (inline import type)',
      'src/core/services/x.ts',
      "export type A = import('../../main/index').B"
    ],
    ['8 core/shared -> core', 'src/core/shared/x.ts', "import '../services/db'"],
    ['9 pi -> opencode', 'src/core/pi/x.ts', "import '../opencode/OpencodeSession'"],
    ['10 opencode -> pi', 'src/core/opencode/x.ts', "import '../pi/PiSession'"]
  ]

  it.each(violations)('fires: %s', async (_name, file, code) => {
    const msgs = await layerMessages(file, code)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toContain('must not import')
  })

  it('stays quiet for allowed imports and exempt importers', async () => {
    expect(
      await layerMessages('src/renderer/src/lib/x.ts', "import '../../../core/shared/y'")
    ).toEqual([])
    expect(await layerMessages('src/core/services/x.ts', "import 'node:path'")).toEqual([])
    expect(
      await layerMessages(
        'src/core/services/__tests__/x.test.ts',
        "import '../../../test/helpers/migration-db'"
      )
    ).toEqual([])
    expect(await layerMessages('src/main/x.ts', "import '../core/services/db'")).toEqual([])
  })

  it('stays quiet for an allow-listed pair, fires for another module from the same importer', async () => {
    expect(
      await layerMessages('src/core/pi/pi-json-raw.ts', "import '../opencode/opencode-jsonc-io'")
    ).toEqual([])
    expect(
      await layerMessages('src/core/pi/pi-json-raw.ts', "import '../opencode/OpencodeSession'")
    ).toHaveLength(1)
  })
})
