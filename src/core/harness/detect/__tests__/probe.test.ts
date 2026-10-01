/**
 * @vitest-environment node
 *
 * The isolated `--version` probe (ADR-082 research §3): parsing per harness,
 * the isolation environment (no parent secrets), timeouts, and one real
 * process end to end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { nativeLaunch, nodeScriptLaunch } from '../../launch'
import { parseVersionOutput, probeVersion } from '../probe'
import type { RunFn, RunOptions, SpawnFn } from '../run'

let tmp: string

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-probe-')))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('parseVersionOutput', () => {
  it.each([
    ['claude', '2.1.280 (Claude Code)\n', '2.1.280'],
    ['claude', '2.1.198 (Claude Code)', '2.1.198'],
    ['opencode', '1.18.32\n', '1.18.32'],
    ['pi', '0.87.1\n', '0.87.1'],
    ['codex', 'codex-cli 0.156.0\n', '0.156.0']
  ] as const)('%s: %j → %s', (id, stdout, version) => {
    expect(parseVersionOutput(id, stdout)).toEqual({ status: 'ok', version })
  })

  it("reports opencode's source-build `local` as not a version", () => {
    expect(parseVersionOutput('opencode', 'local\n')).toEqual({
      status: 'not-a-version',
      output: 'local'
    })
  })

  it('fails on output of the wrong shape', () => {
    expect(parseVersionOutput('claude', '2.1.280\n').status).toBe('failed')
    expect(parseVersionOutput('codex', '0.156.0').status).toBe('failed')
    expect(parseVersionOutput('pi', '').status).toBe('failed')
    expect(parseVersionOutput('opencode', 'Error: something broke\nat x').status).toBe('failed')
  })
})

describe('probeVersion isolation', () => {
  function capture(stdout: string) {
    const seen: {
      command: string
      args: readonly string[]
      options: RunOptions
      dirExisted: boolean
    }[] = []
    const run = vi.fn<RunFn>(async (command, args, options) => {
      const env = options.env ?? {}
      const dir =
        env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME ?? env.PI_CODING_AGENT_DIR ?? env.XDG_DATA_HOME
      seen.push({ command, args, options, dirExisted: !!dir && fs.existsSync(dir) })
      return { stdout, code: 0, timedOut: false }
    })
    return { run, seen }
  }

  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'x',
    OPENAI_API_KEY: 'y',
    GITHUB_TOKEN: 'z',
    NODE_OPTIONS: '--require /evil.js'
  }

  it('Claude: --version is the only argument; config in a fresh dir; no parent secrets', async () => {
    const { run, seen } = capture('2.1.198 (Claude Code)\n')
    const result = await probeVersion('claude', nativeLaunch('/x/claude'), {
      run,
      env: parent,
      platform: 'linux',
      tmpdir: tmp
    })
    expect(result).toEqual({ status: 'ok', version: '2.1.198' })
    const [{ command, args, options, dirExisted }] = seen
    expect(command).toBe('/x/claude')
    expect(args).toEqual(['--version'])
    expect(options.timeoutMs).toBe(10_000)
    expect(options.maxStdoutBytes).toBe(4096)
    const env = options.env ?? {}
    for (const secret of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(secret)
    }
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'en_US.UTF-8',
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
    })
    expect(path.dirname(env.CLAUDE_CONFIG_DIR as string)).toBe(tmp)
    expect(dirExisted).toBe(true)
    // Removed afterwards.
    expect(fs.existsSync(env.CLAUDE_CONFIG_DIR as string)).toBe(false)
    expect(fs.readdirSync(tmp)).toEqual([])
  })

  it.each([
    [
      'opencode',
      '1.18.32',
      ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME']
    ],
    ['pi', '0.87.1', ['PI_CODING_AGENT_DIR']],
    ['codex', 'codex-cli 0.156.0', ['CODEX_HOME']]
  ] as const)('%s: its state dirs point into the fresh dir', async (id, stdout, dirs) => {
    const { run, seen } = capture(stdout)
    await probeVersion(id, nativeLaunch('/x/h'), {
      run,
      env: parent,
      platform: 'linux',
      tmpdir: tmp
    })
    const env = seen[0].options.env ?? {}
    for (const name of dirs) expect(path.dirname(env[name] as string)).toBe(tmp)
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    if (id === 'opencode') {
      expect(env).toMatchObject({
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1'
      })
    }
    if (id === 'pi') {
      expect(env).toMatchObject({ PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' })
    }
  })

  it('pi under node: the script leads the argv and the launch env is kept', async () => {
    const { run, seen } = capture('0.87.1\n')
    const launch = nodeScriptLaunch('/n/node', '/p/cli.js', {
      PI_MANAGED_INSTALL_ROOT: '/r',
      ELECTRON_RUN_AS_NODE: '1'
    })
    await probeVersion('pi', launch, { run, env: parent, platform: 'linux', tmpdir: tmp })
    expect(seen[0].command).toBe('/n/node')
    expect(seen[0].args).toEqual(['/p/cli.js', '--version'])
    expect(seen[0].options.env).toMatchObject({
      PI_MANAGED_INSTALL_ROOT: '/r',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('a non-zero exit or a spawn error is a failure', async () => {
    const exit1: RunFn = async () => ({ stdout: 'Error: unknown option', code: 1, timedOut: false })
    await expect(
      probeVersion('claude', nativeLaunch('/x'), { run: exit1, tmpdir: tmp })
    ).resolves.toEqual({
      status: 'failed',
      reason: '--version exited with code 1'
    })
    const enoent: RunFn = async () => ({
      stdout: '',
      code: null,
      timedOut: false,
      error: 'spawn ENOENT'
    })
    await expect(
      probeVersion('claude', nativeLaunch('/x'), { run: enoent, tmpdir: tmp })
    ).resolves.toEqual({
      status: 'failed',
      reason: 'could not start: spawn ENOENT'
    })
  })
})

describe('probeVersion timeout', () => {
  it('kills a probe that does not answer and reports failed', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      pid: undefined,
      kill: vi.fn(() => true)
    })
    const spawn = vi.fn(() => child as unknown as ChildProcess) as unknown as SpawnFn
    const result = await probeVersion('opencode', nativeLaunch('/x/opencode'), {
      spawn,
      timeoutMs: 50,
      tmpdir: tmp
    })
    expect(result).toEqual({ status: 'failed', reason: '--version did not answer within 0.05 s' })
    expect(child.kill).toHaveBeenCalled()
    expect(fs.readdirSync(tmp)).toEqual([])
  })
})

describe('probeVersion, real process', () => {
  it('runs a fake Node-script harness isolated, end to end', async () => {
    const script = path.join(tmp, 'fake-pi.js')
    fs.writeFileSync(
      script,
      [
        "const leaked = process.env.ANTHROPIC_API_KEY ? ' LEAKED' : ''",
        "const isolated = process.env.PI_CODING_AGENT_DIR && process.env.PI_OFFLINE === '1'",
        "if (process.argv[2] !== '--version' || process.argv.length !== 3) process.exit(3)",
        "console.log(isolated ? '0.87.1' + leaked : 'not isolated')"
      ].join('\n')
    )
    const probes = path.join(tmp, 'probes')
    fs.mkdirSync(probes)
    const launch = nodeScriptLaunch(process.execPath, script, { ELECTRON_RUN_AS_NODE: '1' })
    const result = await probeVersion('pi', launch, {
      env: { ...process.env, ANTHROPIC_API_KEY: 'x' },
      tmpdir: probes
    })
    expect(result).toEqual({ status: 'ok', version: '0.87.1' })
    expect(fs.readdirSync(probes)).toEqual([])
    // A real spawn: a cold Windows host with on-access scanning can take seconds.
  }, 20_000)
})
