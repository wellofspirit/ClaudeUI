// @vitest-environment node
/**
 * S8 review F2: the shared opencode config modules run in the renderer and the
 * web client, where there is no `process`. jsdom tests run on Node and cannot
 * see that, so this one compiles the modules and evaluates them in a fresh
 * realm with no `process` global, then exercises the Tools pane's path.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SHARED = join(__dirname, '..')
const MODULES = ['opencode-wildcard', 'opencode-config-v1'] as const

/** Evaluate the shared modules as CommonJS in a realm with no `process`. */
function loadInBareRealm(): Record<string, Record<string, unknown>> {
  const context = vm.createContext({ console })
  expect(vm.runInContext('typeof process', context)).toBe('undefined')
  const loaded: Record<string, Record<string, unknown>> = {}
  for (const name of MODULES) {
    const source = readFileSync(join(SHARED, `${name}.ts`), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    const module = { exports: {} as Record<string, unknown> }
    const require = (spec: string): unknown => {
      const dep = spec.replace(/^\.\//, '')
      if (!(dep in loaded)) throw new Error(`unexpected import ${spec}`)
      return loaded[dep]
    }
    vm.runInContext(`(function (module, exports, require) {${outputText}\n})`, context)(
      module,
      module.exports,
      require
    )
    loaded[name] = module.exports
  }
  return loaded
}

describe('shared opencode config modules in a realm without `process` (F2)', () => {
  it('the Tools pane path evaluates: toolDisabledIn / agentsOverridingSwitch', () => {
    const v1 = loadInBareRealm()['opencode-config-v1'] as {
      toolDisabledIn: (config: unknown, action: string, platform: string) => boolean
      agentsOverridingSwitch: (a: string, agents: unknown[], platform: string) => string[]
      configAgentRules: (config: unknown) => unknown[]
    }
    const config = {
      permissions: [{ action: 'shell', resource: '*', effect: 'deny' }],
      agents: { loose: { permissions: [{ action: '*', resource: '*', effect: 'allow' }] } }
    }
    expect(v1.toolDisabledIn(config, 'shell', 'web')).toBe(true)
    expect(v1.toolDisabledIn(config, 'read', 'web')).toBe(false)
    expect(v1.agentsOverridingSwitch('shell', v1.configAgentRules(config), 'web')).toEqual([
      'loose'
    ])
  })

  it('no shared opencode config module reads `process`', () => {
    for (const name of MODULES) {
      const code = readFileSync(join(SHARED, `${name}.ts`), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      expect(code, name).not.toMatch(/\bprocess\b/)
    }
  })
})
