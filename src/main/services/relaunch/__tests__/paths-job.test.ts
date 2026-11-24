/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  backupPathFor,
  caseInsensitivePaths,
  failedPathFor,
  installKeyFor,
  installLocation,
  jobFiles,
  newToken,
  relaunchStateDir,
  relaunchTokenFromArgv,
  samePath,
  sanitiseVersion
} from '../paths'
import {
  DEFAULT_TIMEOUTS,
  defaultLaunch,
  relaunchArgs,
  jobJsonText,
  jobShellText,
  parseJob,
  shQuote,
  writeJobFiles,
  type RelaunchJob
} from '../job'
import { ownedNamePattern } from '../delete-gate'

describe('install location', () => {
  it('macOS: the .app three levels above the executable', () => {
    expect(installLocation('/Applications/ClaudeUI.app/Contents/MacOS/ClaudeUI', 'darwin')).toEqual(
      {
        ok: true,
        path: '/Applications/ClaudeUI.app'
      }
    )
  })

  it('macOS: refuses anything that is not a bundle', () => {
    expect(installLocation('/usr/local/bin/ClaudeUI', 'darwin').ok).toBe(false)
    expect(installLocation('/Apps/ClaudeUI/Contents/MacOS/ClaudeUI', 'darwin').ok).toBe(false)
  })

  it('Windows: the folder holding the exe', () => {
    expect(installLocation('C:\\Tools\\ClaudeUI\\ClaudeUI.exe', 'win32')).toEqual({
      ok: true,
      path: 'C:\\Tools\\ClaudeUI'
    })
  })

  it('refuses other platforms', () => {
    expect(installLocation('/opt/claudeui/claudeui', 'linux').ok).toBe(false)
  })
})

describe('installKey', () => {
  it('is 16 hex, stable, and case-insensitive on Windows only', () => {
    const k = installKeyFor('C:\\Tools\\ClaudeUI', 'win32')
    expect(k).toMatch(/^[0-9a-f]{16}$/)
    expect(installKeyFor('c:\\tools\\claudeui', 'win32')).toBe(k)
    expect(installKeyFor('/Applications/ClaudeUI.app', 'darwin')).not.toBe(
      installKeyFor('/applications/claudeui.app', 'darwin')
    )
  })
})

describe('sibling names', () => {
  const token = 'abcdef0123456789abcdef0123456789'

  it('macOS backup and failed paths sit beside the bundle and carry the token', () => {
    expect(backupPathFor('/Applications/ClaudeUI.app', '3.9.1', token, 'darwin')).toBe(
      '/Applications/.ClaudeUI.app.old-3.9.1-abcdef01'
    )
    expect(failedPathFor('/Applications/ClaudeUI.app', '3.10.0-pre.2', token, 'darwin')).toBe(
      '/Applications/.ClaudeUI.app.failed-3.10.0-pre.2-abcdef01'
    )
  })

  it('Windows names use the folder name', () => {
    expect(backupPathFor('C:\\Tools\\ClaudeUI', '1.0.0', token, 'win32')).toBe(
      'C:\\Tools\\.ClaudeUI.old-1.0.0-abcdef01'
    )
  })

  it('owned names and paths compare case-insensitively on win32 and darwin only', () => {
    const name = '.CLAUDEUI.APP.OLD-1.0.0-ABCDEF01'
    expect(ownedNamePattern('ClaudeUI.app', true).test(name)).toBe(true)
    expect(ownedNamePattern('ClaudeUI.app').test(name)).toBe(false)
    expect(caseInsensitivePaths('darwin')).toBe(true)
    expect(caseInsensitivePaths('win32')).toBe(true)
    expect(caseInsensitivePaths('linux')).toBe(false)
    expect(samePath('/A/ClaudeUI.app', '/a/claudeui.APP', 'darwin')).toBe(true)
    expect(samePath('C:\\Tools\\X', 'c:\\tools\\x', 'win32')).toBe(true)
    expect(samePath('/A/ClaudeUI', '/a/claudeui', 'linux')).toBe(false)
  })

  it('sanitises versions to the characters the gate accepts', () => {
    expect(sanitiseVersion('1.0.0 beta/../x')).toBe('1.0.0beta..x')
    expect(sanitiseVersion('$`')).toBe('unknown')
    const name = path.basename(backupPathFor('/A/ClaudeUI.app', 'v1 "2"', token, 'darwin'))
    expect(ownedNamePattern('ClaudeUI.app').test(name)).toBe(true)
  })
})

describe('tokens and argv', () => {
  it('mints 128-bit hex tokens', () => {
    expect(newToken()).toMatch(/^[0-9a-f]{32}$/)
    expect(newToken()).not.toBe(newToken())
  })

  it('reads --relaunch-token strictly', () => {
    const t = newToken()
    expect(relaunchTokenFromArgv(['x', `--relaunch-token=${t}`])).toBe(t)
    expect(relaunchTokenFromArgv([`--relaunch-token=${t.toUpperCase()}`])).toBeNull()
    expect(relaunchTokenFromArgv(['--relaunch-token=abc'])).toBeNull()
    expect(relaunchTokenFromArgv([])).toBeNull()
  })

  it('the state dir is under the given home', () => {
    expect(relaunchStateDir('/h')).toBe(path.join('/h', '.claude', 'ui', 'relaunch'))
    expect(jobFiles('/s', 'tok').sh).toBe(path.join('/s', 'tok.job.sh'))
  })
})

describe('job files', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaunch-job-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  const nasty = `/tmp/it's a "path" with $HOME and \`date\` and\nnewline \\ back`
  const job = (): RelaunchJob => ({
    schema: 1,
    token: 'abcdef0123456789abcdef0123456789',
    pid: 4242,
    platform: 'darwin',
    mode: 'swap',
    installPath: nasty,
    installKey: '0123456789abcdef',
    stateDir: dir,
    stagedPath: `${nasty}.staged`,
    backupPath: "/x/'old'",
    failedPath: '/x/$(rm -rf ~)',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    startedAt: 1700000000123,
    launch: ['open', '-n', '{app}', '--args', "--x='y'"],
    timeouts: DEFAULT_TIMEOUTS
  })

  // The .sh job is the macOS helper's: these two need bash.
  it.skipIf(process.platform === 'win32')(
    'shQuote survives bash for every awkward character',
    () => {
      for (const value of [nasty, "'", "''", '$(id)', '`id`', ' ', '\n', '\\', '!']) {
        const r = spawnSync('/bin/bash', ['-c', `v=${shQuote(value)}; printf %s "$v"`], {
          encoding: 'utf8'
        })
        expect(r.stdout).toBe(value)
      }
    }
  )

  it('shQuote refuses a NUL byte', () => {
    expect(() => shQuote('a\0b')).toThrow(/NUL/)
  })

  it.skipIf(process.platform === 'win32')(
    'the sh rendering sources back to the same values, without running anything',
    () => {
      const files = jobFiles(dir, job().token)
      writeJobFiles(files, job())
      const marker = path.join(dir, 'ran')
      const r = spawnSync(
        '/bin/bash',
        [
          '-c',
          'source "$1" && printf "%s\\0" "$JOB_INSTALL" "$JOB_STAGED" "$JOB_BACKUP" "$JOB_FAILED" "$JOB_PID" "$JOB_STARTED_AT" "${#JOB_LAUNCH[@]}" "${JOB_LAUNCH[4]}"',
          'x',
          files.sh
        ],
        { encoding: 'utf8', env: { HOME: marker } }
      )
      expect(r.status).toBe(0)
      expect(r.stdout.split('\0').slice(0, 8)).toEqual([
        nasty,
        `${nasty}.staged`,
        "/x/'old'",
        '/x/$(rm -rf ~)',
        '4242',
        '1700000000123',
        '5',
        "--x='y'"
      ])
      expect(fs.existsSync(marker)).toBe(false)
    }
  )

  it('the json rendering round-trips through parseJob', () => {
    const files = jobFiles(dir, job().token)
    writeJobFiles(files, job())
    expect(parseJob(JSON.parse(fs.readFileSync(files.json, 'utf8')))).toEqual(job())
    expect(JSON.parse(jobJsonText(job())).installPath).toBe(nasty)
    expect(jobShellText(job())).toContain("JOB_MODE='swap'")
  })

  it('the builds and the source round-trip; malformed ones are dropped, not the job', () => {
    const withFacts = {
      ...job(),
      fromBuild: 'abc1234',
      toBuild: 'def5678',
      source: 'rebuild' as const
    }
    const files = jobFiles(dir, withFacts.token)
    writeJobFiles(files, withFacts)
    expect(parseJob(JSON.parse(fs.readFileSync(files.json, 'utf8')))).toEqual(withFacts)
    // The helper's shell rendering carries none of them.
    expect(jobShellText(withFacts)).not.toMatch(/abc1234|def5678|rebuild/)
    expect(parseJob({ ...job(), fromBuild: '../x', toBuild: 7, source: 'elsewhere' })).toEqual(
      job()
    )
  })

  it('parseJob refuses what is not a job', () => {
    expect(parseJob({ ...job(), token: 'x' })).toBeNull()
    expect(parseJob({ ...job(), mode: 'rm' })).toBeNull()
    expect(parseJob({ ...job(), launch: [1] })).toBeNull()
    expect(parseJob({ ...job(), timeouts: {} })).toBeNull()
    expect(parseJob(null)).toBeNull()
  })

  it('default launch argv per platform', () => {
    expect(defaultLaunch('darwin', 'ClaudeUI', 't')).toEqual([
      'open',
      '-n',
      '{app}',
      '--args',
      '--relaunch-token=t'
    ])
    expect(defaultLaunch('win32', 'ClaudeUI.exe', 't')).toEqual([
      '{app}\\ClaudeUI.exe',
      '--relaunch-token=t'
    ])
  })

  it('starts the next instance the way this one started', () => {
    const args = relaunchArgs([
      '/A/ClaudeUI.app/Contents/MacOS/ClaudeUI',
      '-psn_0_12345',
      '--user-data-dir=/tmp/p q/electron',
      '--relaunch-token=old',
      '--claudeui-headless'
    ])
    expect(args).toEqual(['--user-data-dir=/tmp/p q/electron', '--claudeui-headless'])
    const env = {
      HOME: '/tmp/p q',
      CLAUDEUI_DISABLE_REMOTE: '1',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      OPENAI_API_KEY: 'sk-secret',
      CLAUDEUI_PI_BRIDGE_TOKEN: 'secret'
    }
    expect(defaultLaunch('darwin', 'ClaudeUI', 't', { args, env })).toEqual([
      'open',
      '-n',
      '--env',
      'HOME=/tmp/p q',
      '--env',
      'CLAUDEUI_DISABLE_REMOTE=1',
      '--env',
      'HTTPS_PROXY=http://127.0.0.1:9',
      '{app}',
      '--args',
      '--user-data-dir=/tmp/p q/electron',
      '--claudeui-headless',
      '--relaunch-token=t'
    ])
    // Windows inherits the environment; only the arguments are carried.
    expect(defaultLaunch('win32', 'ClaudeUI.exe', 't', { args, env })).toEqual([
      '{app}\\ClaudeUI.exe',
      '--user-data-dir=/tmp/p q/electron',
      '--claudeui-headless',
      '--relaunch-token=t'
    ])
  })
})
