/**
 * @vitest-environment node
 *
 * Resolving a detection candidate to what ClaudeUI would spawn, over real
 * temp-directory layouts (ADR-082 research §1-2). Nothing is executed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  installKindFor,
  parseBunxShim,
  parseScoopShim,
  resolveCandidate,
  shimTargets,
  type InstallResolution,
  type ResolveDeps
} from '../resolve-install'
import type { Candidate } from '../candidates'
import {
  PLACEHOLDER_STUB,
  cmdShim,
  linkDir,
  shShim,
  writeNative,
  writePackage,
  writeText
} from './layout'

let tmp: string
let deps: ResolveDeps

const WIN: Pick<ResolveDeps, 'platform' | 'arch'> = { platform: 'win32', arch: 'x64' }
const HOST_EXE = process.platform === 'win32' ? '.exe' : ''

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-resolve-')))
  deps = {
    env: {},
    platform: process.platform,
    arch: process.arch,
    homedir: path.join(tmp, 'home')
  }
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function file(id: Candidate['id'], p: string): Candidate {
  return { id, kind: 'file', path: p }
}

function resolved(r: InstallResolution | null): Extract<InstallResolution, { status: 'resolved' }> {
  expect(r?.status).toBe('resolved')
  return r as Extract<InstallResolution, { status: 'resolved' }>
}

function unsupported(
  r: InstallResolution | null
): Extract<InstallResolution, { status: 'unsupported' }> {
  expect(r?.status).toBe('unsupported')
  return r as Extract<InstallResolution, { status: 'unsupported' }>
}

describe('npm Claude Code', () => {
  it('runs bin/claude.exe directly when postinstall placed the native binary there', () => {
    const prefix = path.join(tmp, 'npm')
    const pkg = path.join(prefix, 'node_modules', '@anthropic-ai', 'claude-code')
    writePackage(
      pkg,
      { name: '@anthropic-ai/claude-code', version: '2.1.280' },
      {
        'bin/claude.exe': 'native'
      }
    )
    const shim = writeText(
      path.join(prefix, 'claude.cmd'),
      cmdShim('node_modules/@anthropic-ai/claude-code/bin/claude.exe', false)
    )
    const r = resolved(resolveCandidate(file('claude', shim), { ...deps, ...WIN }))
    const bin = path.join(pkg, 'bin', 'claude.exe')
    expect(r).toMatchObject({
      displayPath: shim,
      realPath: bin,
      installKind: 'npm',
      launch: { command: bin, args: [] }
    })
    expect(r.nodeFor).toBeUndefined()
  })

  it('follows the text placeholder to the platform package when postinstall did not run', () => {
    const nm = path.join(tmp, 'npm', 'node_modules')
    const pkg = writePackage(
      path.join(nm, '@anthropic-ai', 'claude-code'),
      { name: '@anthropic-ai/claude-code', version: '2.1.280' },
      { 'bin/claude.exe': PLACEHOLDER_STUB }
    )
    const platformPkg = writePackage(
      path.join(nm, '@anthropic-ai', 'claude-code-win32-x64'),
      { name: '@anthropic-ai/claude-code-win32-x64', version: '2.1.280' },
      { 'claude.exe': 'native' }
    )
    const shim = writeText(
      path.join(tmp, 'npm', 'claude.cmd'),
      cmdShim('node_modules/@anthropic-ai/claude-code/bin/claude.exe', false)
    )
    for (const candidate of [file('claude', shim), { id: 'claude', kind: 'package', path: pkg }]) {
      const r = resolved(resolveCandidate(candidate as Candidate, { ...deps, ...WIN }))
      expect(r.realPath).toBe(path.join(platformPkg, 'claude.exe'))
      expect(r.launch).toEqual({ command: path.join(platformPkg, 'claude.exe'), args: [] })
    }
  })

  it('is unsupported when neither bin/claude.exe nor a platform package is native', () => {
    const pkg = writePackage(
      path.join(tmp, 'nm', 'node_modules', '@anthropic-ai', 'claude-code'),
      { name: '@anthropic-ai/claude-code', version: '2.1.280' },
      { 'bin/claude.exe': PLACEHOLDER_STUB }
    )
    const r = unsupported(
      resolveCandidate({ id: 'claude', kind: 'package', path: pkg }, { ...deps, ...WIN })
    )
    expect(r.reason).toMatch(/2\.1\.280.*--ignore-scripts/)
  })

  it('ignores a package directory that is not the harness', () => {
    const pkg = writePackage(path.join(tmp, 'nm', 'node_modules', 'other'), { name: 'other' })
    expect(resolveCandidate({ id: 'claude', kind: 'package', path: pkg }, deps)).toBeNull()
  })
})

describe('npm opencode', () => {
  it('finds the baseline platform build when only that one is installed', () => {
    const nm = path.join(tmp, 'npm', 'node_modules')
    const pkg = writePackage(
      path.join(nm, 'opencode-ai'),
      { name: 'opencode-ai', version: '1.18.32' },
      { 'bin/opencode.exe': 'echo "postinstall was not run" >&2\nexit 1\n' }
    )
    const baseline = writePackage(
      path.join(nm, 'opencode-windows-x64-baseline'),
      { name: 'opencode-windows-x64-baseline', version: '1.18.32' },
      { 'bin/opencode.exe': 'native' }
    )
    const r = resolved(
      resolveCandidate({ id: 'opencode', kind: 'package', path: pkg }, { ...deps, ...WIN })
    )
    expect(r.realPath).toBe(path.join(baseline, 'bin', 'opencode.exe'))
  })
})

describe('npm Codex', () => {
  const TRIPLE = 'x86_64-pc-windows-msvc'

  function codexPackage(nm: string): string {
    return writePackage(
      path.join(nm, '@openai', 'codex'),
      { name: '@openai/codex', version: '0.156.0', bin: { codex: 'bin/codex.js' } },
      { 'bin/codex.js': '#!/usr/bin/env node\nimport "./x.js"\n' }
    )
  }

  it('resolves the aliased platform package past the Node launcher', () => {
    const prefix = path.join(tmp, 'npm')
    const nm = path.join(prefix, 'node_modules')
    codexPackage(nm)
    // npm aliases `@openai/codex-win32-x64` to `@openai/codex@<v>-win32-x64`,
    // so the platform package's own name is `@openai/codex`.
    const platformPkg = writePackage(
      path.join(nm, '@openai', 'codex-win32-x64'),
      { name: '@openai/codex', version: '0.156.0-win32-x64' },
      {
        [`vendor/${TRIPLE}/bin/codex.exe`]: 'native',
        [`vendor/${TRIPLE}/bin/codex-code-mode-host.exe`]: 'native'
      }
    )
    const shim = writeText(
      path.join(prefix, 'codex.cmd'),
      cmdShim('node_modules/@openai/codex/bin/codex.js', true)
    )
    const r = resolved(resolveCandidate(file('codex', shim), { ...deps, ...WIN }))
    const exe = path.join(platformPkg, 'vendor', TRIPLE, 'bin', 'codex.exe')
    expect(r).toMatchObject({ displayPath: shim, realPath: exe, installKind: 'npm' })
    expect(r.launch).toEqual({ command: exe, args: [] })
  })

  it("falls back to the package's own vendor directory", () => {
    const nm = path.join(tmp, 'npm', 'node_modules')
    const pkg = codexPackage(nm)
    writeNative(path.join(pkg, 'vendor', TRIPLE, 'bin', 'codex.exe'))
    const r = resolved(
      resolveCandidate({ id: 'codex', kind: 'package', path: pkg }, { ...deps, ...WIN })
    )
    expect(r.realPath).toBe(path.join(pkg, 'vendor', TRIPLE, 'bin', 'codex.exe'))
  })

  it('is unsupported without a platform package', () => {
    const pkg = codexPackage(path.join(tmp, 'npm', 'node_modules'))
    const r = unsupported(
      resolveCandidate({ id: 'codex', kind: 'package', path: pkg }, { ...deps, ...WIN })
    )
    expect(r.reason).toContain('@openai/codex-win32-x64')
  })
})

describe('Codex standalone installer', () => {
  it('resolves the current junction/symlink into the release directory', () => {
    const standalone = path.join(deps.homedir, '.codex', 'packages', 'standalone')
    const release = path.join(standalone, 'releases', '0.156.0-x86_64-pc-windows-msvc')
    writeNative(path.join(release, 'bin', `codex${HOST_EXE}`))
    linkDir(release, path.join(standalone, 'current'))
    const r = resolved(
      resolveCandidate(
        file('codex', path.join(standalone, 'current', 'bin', `codex${HOST_EXE}`)),
        deps
      )
    )
    expect(r.realPath).toBe(path.join(release, 'bin', `codex${HOST_EXE}`))
    expect(r.installKind).toBe('standalone')
  })
})

describe('scoop', () => {
  it('reads the shim executable through its .shim file', () => {
    const scoop = path.join(tmp, 'scoop')
    const real = writeNative(path.join(scoop, 'apps', 'claude-code', '2.1.285', 'claude.exe'))
    const shimExe = writeNative(path.join(scoop, 'shims', 'claude.exe'), 'scoop shim')
    writeText(path.join(scoop, 'shims', 'claude.shim'), `path = "${real}"\r\n`)
    const r = resolved(resolveCandidate(file('claude', shimExe), deps))
    expect(r).toMatchObject({ displayPath: shimExe, realPath: real, installKind: 'scoop' })
  })

  it('parses the shim format', () => {
    expect(
      parseScoopShim('path = "C:\\x\\scoop\\apps\\gh\\current\\bin\\gh.exe"\r\nargs = x')
    ).toBe('C:\\x\\scoop\\apps\\gh\\current\\bin\\gh.exe')
    expect(parseScoopShim('args = x')).toBeNull()
  })
})

describe('bun', () => {
  it('reads the shim executable through its .bunx file (UTF-16LE, relative to bun home)', () => {
    const bunHome = path.join(tmp, '.bun')
    const pkg = writePackage(
      path.join(bunHome, 'install', 'global', 'node_modules', '@anthropic-ai', 'claude-code'),
      { name: '@anthropic-ai/claude-code', version: '2.1.280' },
      { 'bin/claude.exe': 'native' }
    )
    const shimExe = writeNative(path.join(bunHome, 'bin', 'claude.exe'), 'bun shim')
    const rel = 'install\\global\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"'
    fs.writeFileSync(
      path.join(bunHome, 'bin', 'claude.bunx'),
      Buffer.concat([Buffer.from(rel, 'utf16le'), Buffer.from('\0node', 'utf16le')])
    )
    const r = resolved(resolveCandidate(file('claude', shimExe), deps))
    expect(r.realPath).toBe(path.join(pkg, 'bin', 'claude.exe'))
    expect(r.installKind).toBe('bun')
  })

  it('parses the bunx format', () => {
    const buf = Buffer.from(
      'install\\global\\node_modules\\pnpm\\bin\\pnpm.cjs"\0node Z',
      'utf16le'
    )
    expect(parseBunxShim(buf)).toBe('install\\global\\node_modules\\pnpm\\bin\\pnpm.cjs')
  })
})

describe('pi', () => {
  const PI = '@earendil-works/pi-coding-agent'

  it('npm: runs cli.js under a node, preferring the node beside the shim', () => {
    const prefix = path.join(tmp, 'npm')
    const pkg = writePackage(
      path.join(prefix, 'node_modules', ...PI.split('/')),
      { name: PI, version: '0.87.1', bin: { pi: 'dist/bundle/cli.js' } },
      { 'dist/bundle/cli.js': '#!/usr/bin/env node\nimport "./cli-runtime.js"\n' }
    )
    const nodeBeside = writeNative(path.join(prefix, `node${HOST_EXE}`))
    const shim = writeText(
      path.join(prefix, 'pi.cmd'),
      cmdShim(`node_modules/${PI}/dist/bundle/cli.js`, true)
    )
    const r = resolved(resolveCandidate(file('pi', shim), deps))
    const cli = path.join(pkg, 'dist', 'bundle', 'cli.js')
    expect(r).toMatchObject({ displayPath: shim, realPath: cli, installKind: 'npm', launch: null })
    expect(r.nodeFor?.script).toBe(cli)
    expect(r.nodeFor?.preferredNodes[0]).toBe(nodeBeside)
  })

  it('npm (Unix layout): the sh shim resolves the same way', () => {
    const prefix = path.join(tmp, 'usr')
    const pkg = writePackage(
      path.join(prefix, 'lib', 'node_modules', ...PI.split('/')),
      { name: PI, version: '0.87.1' },
      { 'dist/bundle/cli.js': '#!/usr/bin/env node\n' }
    )
    const shim = writeText(
      path.join(prefix, 'bin', 'pi'),
      shShim(`../lib/node_modules/${PI}/dist/bundle/cli.js`)
    )
    const node = writeNative(path.join(prefix, 'bin', `node${HOST_EXE}`))
    const r = resolved(resolveCandidate(file('pi', shim), deps))
    expect(r.realPath).toBe(path.join(pkg, 'dist', 'bundle', 'cli.js'))
    expect(r.nodeFor?.preferredNodes).toContain(node)
  })

  it('managed install: current-version selects the release, with the launcher env', () => {
    const agent = path.join(deps.homedir, '.pi', 'agent')
    const root = path.join(agent, 'install')
    writeText(
      path.join(root, 'managed-install.json'),
      JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
    )
    writeText(path.join(root, 'current-version'), '0.87.1\n')
    const pkg = writePackage(
      path.join(root, 'releases', '0.87.1', 'node_modules', ...PI.split('/')),
      { name: PI, version: '0.87.1' },
      { 'dist/bundle/cli.js': '#!/usr/bin/env node\n' }
    )
    const dataHome = path.join(tmp, 'data')
    const nodeBin = path.join(dataHome, 'pi-node', 'current', 'bin')
    const node = writeNative(path.join(nodeBin, `node${HOST_EXE}`))
    const launcher = writeText(
      path.join(agent, 'bin', 'pi'),
      '#!/bin/sh\nexec "$pi_release_bin" "$@"\n'
    )
    const managedDeps = { ...deps, env: { XDG_DATA_HOME: dataHome, PATH: '/usr/bin' } }

    const cli = path.join(pkg, 'dist', 'bundle', 'cli.js')
    for (const candidate of [
      { id: 'pi', kind: 'pi-managed', path: root } as Candidate,
      file('pi', launcher)
    ]) {
      const r = resolved(resolveCandidate(candidate, managedDeps))
      expect(r).toMatchObject({ displayPath: launcher, realPath: cli, installKind: 'pi-managed' })
      expect(r.nodeFor).toEqual({
        script: cli,
        preferredNodes: [node],
        env: { PI_MANAGED_INSTALL_ROOT: root, PATH: `${nodeBin}${path.delimiter}/usr/bin` }
      })
    }
  })

  it('managed install with an invalid current-version is unsupported', () => {
    const root = path.join(tmp, 'agent', 'install')
    writeText(
      path.join(root, 'managed-install.json'),
      JSON.stringify({ kind: 'pi-managed-install', schemaVersion: 1, layout: 'releases-v1' })
    )
    writeText(path.join(root, 'current-version'), '../../etc\n')
    const r = unsupported(resolveCandidate({ id: 'pi', kind: 'pi-managed', path: root }, deps))
    expect(r.reason).toContain('current-version')
  })
})

describe('rejections', () => {
  it.each(['mise', 'volta-shim', 'asdf'])('a %s multiplexer is never the harness', (name) => {
    const bin = writeNative(path.join(tmp, 'shims', `${name}${HOST_EXE}`))
    let candidate = bin
    try {
      // The shape on disk: the command is a link to the multiplexer.
      candidate = path.join(tmp, 'bin', `opencode${HOST_EXE}`)
      fs.mkdirSync(path.dirname(candidate), { recursive: true })
      fs.symlinkSync(bin, candidate, 'file')
    } catch {
      candidate = bin // No symlink privilege (Windows without Developer Mode).
    }
    const r = unsupported(resolveCandidate(file('opencode', candidate), deps))
    expect(r.reason).toContain(`${name} shim`)
    expect(r.realPath).toBe(bin)
  })

  it('a Chocolatey shim is never the harness', () => {
    const shim = writeNative(path.join(tmp, 'chocolatey', 'bin', 'opencode.exe'))
    expect(unsupported(resolveCandidate(file('opencode', shim), deps)).reason).toContain(
      'Chocolatey'
    )
  })

  it('a text launcher that leads nowhere is an unsupported script launcher', () => {
    const script = writeText(path.join(tmp, 'bin', 'claude'), '#!/bin/sh\nexec my-claude "$@"\n')
    const r = unsupported(resolveCandidate(file('claude', script), deps))
    expect(r.reason).toBe(`${script} is a script launcher ClaudeUI cannot run directly`)
  })

  it('a missing file resolves to nothing', () => {
    expect(resolveCandidate(file('claude', path.join(tmp, 'nope')), deps)).toBeNull()
  })

  it('a native file outside any package is taken as-is', () => {
    const bin = writeNative(path.join(deps.homedir, '.local', 'bin', `claude${HOST_EXE}`))
    const r = resolved(resolveCandidate(file('claude', bin), deps))
    expect(r).toMatchObject({ realPath: bin, installKind: 'native-installer' })
  })
})

describe('shimTargets', () => {
  it('reads cmd-shim .cmd files, leaving out the node preference', () => {
    const text = cmdShim('node_modules/x/cli.js', true)
    expect(shimTargets(text, tmp)).toEqual([path.join(tmp, 'node_modules', 'x', 'cli.js')])
  })

  it('reads sh shims', () => {
    expect(shimTargets(shShim('node_modules/x/cli.js'), tmp)).toEqual([
      path.join(tmp, 'node_modules', 'x', 'cli.js'),
      path.join(tmp, 'node_modules', 'x', 'cli.js')
    ])
  })

  it('reads quoted absolute paths (Homebrew env scripts)', () => {
    expect(
      shimTargets('#!/bin/bash\nexec "/opt/homebrew/Cellar/x/1/libexec/bin/x" "$@"\n', tmp)
    ).toEqual(['/opt/homebrew/Cellar/x/1/libexec/bin/x'])
  })
})

describe('installKindFor', () => {
  it.each([
    ['/opt/homebrew/Cellar/pi-coding-agent/0.87.1/libexec/lib/node_modules/x/cli.js', 'homebrew'],
    ['C:\\Users\\u\\scoop\\apps\\codex\\0.159.2\\bin\\codex.exe', 'scoop'],
    [
      'C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_x\\codex.exe',
      'winget'
    ],
    ['/home/u/.codex/packages/standalone/releases/0.156.0-x/bin/codex', 'standalone'],
    ['/home/u/.pi/agent/install/releases/0.87.1/node_modules/x/cli.js', 'pi-managed'],
    ['/home/u/.bun/install/global/node_modules/x/bin/x.exe', 'bun'],
    ['/home/u/.local/share/pnpm/global/5/node_modules/.pnpm/x/node_modules/x/bin/x', 'pnpm'],
    ['/usr/local/lib/node_modules/x/bin/x.exe', 'npm'],
    ['/home/u/.local/share/claude/versions/2.1.280', 'native-installer'],
    ['/usr/bin/claude', 'path']
  ])('%s → %s', (p, kind) => {
    expect(installKindFor(p, p)).toBe(kind)
  })
})
