/**
 * @vitest-environment node
 *
 * What ships (ADR-082 §8, amending ADR-061): Claude Code is the one bundled
 * harness, with `audio-capture.node` for voice. opencode, pi and Codex are
 * downloaded into ClaudeUI's managed store, so no package, release zip or
 * server tarball may carry their `vendor/<id>-cli` directories, and
 * `postinstall` installs them into the store for development.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import pkg from '../../../../package.json'

const ROOT = join(__dirname, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const UNBUNDLED = /\b(?:opencode|pi|codex)-cli\b/

interface ExtraResource {
  from: string
  to: string
  filter?: string[]
}

describe('electron-builder.yml', () => {
  const config = parse(read('electron-builder.yml')) as {
    extraResources: ExtraResource[]
    asarUnpack: string[]
  }

  it('ships Claude Code with its native voice addon, and no other harness', () => {
    const froms = config.extraResources.map((r) => r.from)
    expect(froms.filter((from) => from.startsWith('vendor/'))).toEqual(['vendor/claude-cli'])
    expect(froms.filter((from) => UNBUNDLED.test(from))).toEqual([])
    const claude = config.extraResources.find((r) => r.from === 'vendor/claude-cli')!
    expect(claude.to).toBe('claude-cli')
    expect(claude.filter).toEqual(
      expect.arrayContaining(['bun-claude*', 'version.json', 'vendor/**/*.node'])
    )
  })

  it("unpacks resources/, so opencode can load ClaudeUI's directory plugin from disk (ADR-097 §4)", () => {
    // opencode 2.x reads a plugin DIRECTORY (index.js + package.json); a path
    // inside app.asar is not a directory to the external process.
    expect(config.asarUnpack).toContain('resources/**')
    expect(() => read('resources/opencode/claudeui-xeng/index.js')).not.toThrow()
    expect(() => read('resources/opencode/claudeui-xeng/package.json')).not.toThrow()
  })

  it('names no unbundled harness directory anywhere', () => {
    const text = read('electron-builder.yml')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(text).not.toMatch(UNBUNDLED)
  })
})

describe('release workflows', () => {
  it.each([
    '.github/workflows/ci.yml',
    '.github/workflows/pre-release.yml',
    '.github/workflows/release.yml'
  ])('%s copies or caches no vendored opencode, pi or Codex', (file) => {
    expect(read(file)).not.toMatch(/vendor\/(?:opencode|pi|codex)-cli/)
  })
})

describe('postinstall', () => {
  it('installs the tested opencode, pi and Codex into the managed store', () => {
    const postinstall = pkg.scripts.postinstall
    for (const id of ['opencode', 'pi', 'codex']) {
      expect(postinstall).toContain(`npm run ensure-${id}`)
      expect(pkg.scripts[`ensure-${id}` as keyof typeof pkg.scripts]).toBe(
        `node scripts/build.mjs ensure-${id}`
      )
    }
  })
})
