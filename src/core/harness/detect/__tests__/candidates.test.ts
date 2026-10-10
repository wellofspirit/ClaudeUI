/**
 * @vitest-environment node
 *
 * Where detection looks (ADR-082 research §5): PATH hits, the harnesses' own
 * install locations, and npm-family global roots. Real temp directories; the
 * host's platform (the fixtures are written with its path rules).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { commandIn, harnessCandidates, npmGlobalRoots, type CandidateDeps } from '../candidates'
import { linkDir, writeNative, writePackage, writeText } from './layout'

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''
let tmp: string
let home: string
let deps: CandidateDeps

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-candidates-')))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home)
  // Point every default location the code derives from the env into the temp dir.
  deps = {
    env: {
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      ProgramData: path.join(tmp, 'ProgramData'),
      HOMEBREW_PREFIX: path.join(tmp, 'brew'),
      PNPM_HOME: path.join(tmp, 'pnpm'),
      BUN_INSTALL: path.join(home, '.bun'),
      NVM_DIR: path.join(home, '.nvm')
    },
    platform: process.platform,
    arch: process.arch,
    homedir: home,
    pathEntries: []
  }
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * Only what the fixtures made: the fixed Homebrew prefixes (`/opt/homebrew`,
 * `/usr/local`) are always searched and a CI host may have real installs there.
 */
function candidates(...args: Parameters<typeof harnessCandidates>) {
  return harnessCandidates(...args).filter((c) => c.path.startsWith(tmp))
}

function roots(d: CandidateDeps) {
  return npmGlobalRoots(d).filter((r) => r.startsWith(tmp))
}

describe('commandIn', () => {
  it('on Windows prefers .exe, then .cmd, .ps1, the bare name', () => {
    const dir = path.join(tmp, 'bin')
    writeText(path.join(dir, 'pi'), '#!/bin/sh')
    expect(commandIn(dir, 'pi', 'win32')).toBe(path.join(dir, 'pi'))
    writeText(path.join(dir, 'pi.ps1'), '')
    expect(commandIn(dir, 'pi', 'win32')).toBe(path.join(dir, 'pi.ps1'))
    writeText(path.join(dir, 'pi.cmd'), '')
    expect(commandIn(dir, 'pi', 'win32')).toBe(path.join(dir, 'pi.cmd'))
    writeNative(path.join(dir, 'pi.exe'))
    expect(commandIn(dir, 'pi', 'win32')).toBe(path.join(dir, 'pi.exe'))
  })

  it('elsewhere only the bare name', () => {
    const dir = path.join(tmp, 'bin')
    writeText(path.join(dir, 'pi.cmd'), '')
    expect(commandIn(dir, 'pi', 'linux')).toBeNull()
  })
})

describe('harnessCandidates', () => {
  it('lists PATH hits first, in PATH order, then own dirs, then npm packages', () => {
    const a = writeNative(path.join(tmp, 'a', `claude${EXE}`))
    const b = writeNative(path.join(tmp, 'b', `claude${EXE}`))
    const launcher = writeNative(path.join(home, '.local', 'bin', `claude${EXE}`))
    const prefix = path.join(tmp, 'prefix')
    const nodeDir = WIN ? prefix : path.join(prefix, 'bin')
    writeNative(path.join(nodeDir, `node${EXE}`))
    const root = WIN ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')
    const pkg = writePackage(path.join(root, '@anthropic-ai', 'claude-code'), {
      name: '@anthropic-ai/claude-code'
    })
    const list = candidates('claude', {
      ...deps,
      pathEntries: [path.dirname(a), path.join(tmp, 'empty'), path.dirname(b), nodeDir]
    })
    expect(list).toEqual([
      { id: 'claude', kind: 'file', path: a },
      { id: 'claude', kind: 'file', path: b },
      { id: 'claude', kind: 'file', path: launcher },
      { id: 'claude', kind: 'package', path: pkg }
    ])
  })

  it("falls back to the newest of Claude's versions/ only without the launcher", () => {
    const versions = path.join(home, '.local', 'share', 'claude', 'versions')
    writeNative(path.join(versions, '2.1.152'))
    const newest = writeNative(path.join(versions, '2.1.280'))
    writeNative(path.join(versions, '2.1.99'))
    fs.mkdirSync(path.join(versions, '2.1.300.tmp'))
    expect(candidates('claude', deps)).toEqual([{ id: 'claude', kind: 'file', path: newest }])
    const launcher = writeNative(path.join(home, '.local', 'bin', `claude${EXE}`))
    expect(candidates('claude', deps)).toEqual([{ id: 'claude', kind: 'file', path: launcher }])
  })

  it("finds pi.dev's managed install root", () => {
    const root = path.join(home, '.pi', 'agent', 'install')
    writeText(path.join(root, 'managed-install.json'), '{}')
    expect(candidates('pi', deps)).toContainEqual({ id: 'pi', kind: 'pi-managed', path: root })
  })

  it("finds Codex's standalone install through current/", () => {
    const standalone = path.join(home, '.codex', 'packages', 'standalone')
    const release = path.join(standalone, 'releases', '0.156.0-x')
    writeNative(path.join(release, 'bin', `codex${EXE}`))
    linkDir(release, path.join(standalone, 'current'))
    expect(candidates('codex', deps)).toContainEqual({
      id: 'codex',
      kind: 'file',
      path: path.join(standalone, 'current', 'bin', `codex${EXE}`)
    })
  })

  it("finds opencode 2.x's opencode2 on PATH beside (or instead of) opencode", () => {
    const v1Dir = path.join(tmp, 'v1')
    const v2Dir = path.join(tmp, 'v2')
    const v1 = writeNative(path.join(v1Dir, `opencode${EXE}`))
    const v2 = writeNative(path.join(v2Dir, `opencode2${EXE}`))
    const both = writeNative(path.join(v2Dir, `opencode${EXE}`))
    expect(candidates('opencode', { ...deps, pathEntries: [v1Dir, v2Dir] })).toEqual([
      { id: 'opencode', kind: 'file', path: v1 },
      { id: 'opencode', kind: 'file', path: both },
      { id: 'opencode', kind: 'file', path: v2 }
    ])
    // Only opencode's alias: no other harness looks for it.
    expect(candidates('pi', { ...deps, pathEntries: [v2Dir] })).toEqual([])
  })

  it('finds opencode 1.x too (so it can be labelled too old)', () => {
    writeNative(path.join(deps.env.BUN_INSTALL as string, 'install', 'global', 'node_modules', 'x'))
    const root = path.join(deps.env.BUN_INSTALL as string, 'install', 'global', 'node_modules')
    const v1 = writePackage(path.join(root, 'opencode-ai'), { name: 'opencode-ai' })
    const v2 = writePackage(path.join(root, '@opencode', 'cli'), { name: '@opencode/cli' })
    expect(candidates('opencode', deps)).toEqual([
      { id: 'opencode', kind: 'package', path: v1 },
      { id: 'opencode', kind: 'package', path: v2 }
    ])
  })
})

describe('npmGlobalRoots', () => {
  it('finds nvm versions, pnpm and bun globals, de-duplicated by realpath', () => {
    const bun = path.join(home, '.bun', 'install', 'global', 'node_modules')
    fs.mkdirSync(bun, { recursive: true })
    const pnpm = path.join(tmp, 'pnpm', 'global', '5', 'node_modules')
    fs.mkdirSync(pnpm, { recursive: true })
    const expected = [pnpm, bun]
    if (!WIN) {
      const nvm = path.join(home, '.nvm', 'versions', 'node', 'v22.19.0', 'lib', 'node_modules')
      fs.mkdirSync(nvm, { recursive: true })
      expected.unshift(nvm)
    } else {
      const nvmHome = path.join(tmp, 'nvm')
      const v = path.join(nvmHome, 'v26.7.0', 'node_modules')
      fs.mkdirSync(v, { recursive: true })
      fs.mkdirSync(path.join(nvmHome, 'settings'), { recursive: true })
      deps.env.NVM_HOME = nvmHome
      // nvm-windows' symlink directory is on PATH and points at the active version.
      const symlink = path.join(tmp, 'nodejs')
      linkDir(path.join(nvmHome, 'v26.7.0'), symlink)
      writeNative(path.join(nvmHome, 'v26.7.0', 'node.exe'))
      deps.pathEntries = [symlink]
      expected.unshift(path.join(symlink, 'node_modules'))
    }
    expect(roots(deps)).toEqual(expected)
  })

  it("reads ~/.npmrc's prefix", () => {
    const prefix = path.join(tmp, 'custom')
    const root = WIN ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')
    fs.mkdirSync(root, { recursive: true })
    writeText(path.join(home, '.npmrc'), `registry=https://example.invalid/\nprefix=${prefix}\n`)
    expect(roots(deps)).toEqual([root])
  })
})
