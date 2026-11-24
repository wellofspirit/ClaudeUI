/**
 * @vitest-environment node
 *
 * The PowerShell relaunch helper and its launcher. The shape checks run
 * everywhere; the end-to-end cases run only on Windows (CI's windows-2022
 * runner), through the production spawn (`spawnDetachedHelper`: the launcher,
 * attached, starts the helper), against temp dirs with a fake install whose
 * `ClaudeUI.exe` is a copy of `cmd.exe` running `fake.cmd`, so a running fake is
 * a process whose executable is under the install.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('../../../../core/services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  BASH_HELPER,
  POWERSHELL_ENCODED_LIMIT,
  POWERSHELL_HELPER,
  POWERSHELL_HELPER_ARGS,
  POWERSHELL_HELPER_ARGS_LINE,
  POWERSHELL_LAUNCHER,
  encodePowerShell,
  helperCommand,
  helperEnv
} from '../helper-scripts'
import { DEFAULT_TIMEOUTS, writeJobFiles, type RelaunchJob, type RelaunchTimeouts } from '../job'
import {
  backupPathFor,
  failedPathFor,
  installKeyFor,
  jobFiles,
  newToken,
  siblingPath,
  type JobFiles
} from '../paths'
import { releaseLock, takeLock } from '../lock'
import { spawnDetachedHelper } from '..'
import { READY_TIMEOUT_WIN32_MS, readHelperPid, type SpawnedHelper } from '../relaunch-service'
import { parseRelaunchResult, type RelaunchResult } from '../../../../shared/relaunch'
import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'
import { alive, waitFor } from './fake-install'

const SCRIPTS = { helper: POWERSHELL_HELPER, launcher: POWERSHELL_LAUNCHER }

/** The result the app writes when it stops waiting for a helper. */
const GAVE_UP = '{"status":"aborted","reason":"the relaunch helper did not start within 15 s"}'

/**
 * The ways a job stops being live, each with the reason the helper logs. The
 * first is what the app does when it stops waiting: the result, then the lock.
 */
const GIVE_UPS = [
  [
    'the job already has a result',
    (f: { files: JobFiles; state: string }) => {
      fs.writeFileSync(f.files.result, GAVE_UP)
      releaseLock(f.state)
    }
  ],
  ['the relaunch lock is not held', (f: { state: string }) => releaseLock(f.state)],
  [
    'the relaunch lock names another job',
    (f: { state: string }) => {
      releaseLock(f.state)
      takeLock(f.state, { token: newToken(), pid: 1, at: Date.now() })
    }
  ]
] as const

const winFiles = (dir: string, token: string): JobFiles => ({
  json: `${dir}\\${token}.job.json`,
  sh: `${dir}\\${token}.job.sh`,
  helperArgs: `${dir}\\${token}.helper-args`,
  helperPid: `${dir}\\${token}.helper-pid`,
  launchError: `${dir}\\${token}.launch-error`,
  ready: `${dir}\\${token}.ready`,
  result: `${dir}\\${token}.result.json`,
  log: `${dir}\\${token}.log`
})

describe('PowerShell helper shape', () => {
  it('the helper, its arguments and the launcher fit the command line with room to spare', () => {
    const encoded = encodePowerShell(POWERSHELL_HELPER)
    expect(encoded.length).toBeLessThan(POWERSHELL_ENCODED_LIMIT)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(POWERSHELL_HELPER)
    expect(POWERSHELL_HELPER_ARGS.at(-1)).toBe(encoded)
    expect(POWERSHELL_HELPER_ARGS_LINE.length).toBeLessThan(POWERSHELL_ENCODED_LIMIT)
    const launcher = encodePowerShell(POWERSHELL_LAUNCHER)
    expect(launcher.length).toBeLessThan(POWERSHELL_ENCODED_LIMIT)
    expect(Buffer.from(launcher, 'base64').toString('utf16le')).toBe(POWERSHELL_LAUNCHER)
  })

  it('is spawned as the launcher, by absolute path, with every path in the environment only', () => {
    const cmd = helperCommand('win32', winFiles('C:\\s', 't'), 'C:\\Windows')
    expect(cmd.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(cmd.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      encodePowerShell(POWERSHELL_LAUNCHER)
    ])
    expect(cmd.env).toEqual({
      CLAUDEUI_RELAUNCH_JOB: 'C:\\s\\t.job.json',
      CLAUDEUI_RELAUNCH_ARGS: 'C:\\s\\t.helper-args'
    })
    expect(cmd.unsetEnv).toEqual(['PSModulePath'])
    expect(cmd.launcher).toEqual({
      pidFile: 'C:\\s\\t.helper-pid',
      errorFile: 'C:\\s\\t.launch-error'
    })
    expect(cmd.args.join(' ')).not.toContain('C:\\s')
    // The helper's own arguments: the fixed script, encoded, and nothing else.
    expect(POWERSHELL_HELPER_ARGS.slice(0, -1)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand'
    ])
  })

  it('the helper environment drops PSModulePath in any spelling and adds the paths', () => {
    const cmd = helperCommand('win32', winFiles('C:\\s', 'j'), 'C:\\Windows')
    const env = helperEnv({ PATH: 'p', PSModulePath: 'a', psmodulepath: 'b', KEEP: '1' }, cmd)
    expect(env).toEqual({
      PATH: 'p',
      KEEP: '1',
      CLAUDEUI_RELAUNCH_JOB: 'C:\\s\\j.job.json',
      CLAUDEUI_RELAUNCH_ARGS: 'C:\\s\\j.helper-args'
    })
  })

  it('the launcher starts nothing but the fixed helper command line', () => {
    const pattern = /-cnotmatch '([^']+)'/.exec(POWERSHELL_LAUNCHER)?.[1]
    expect(pattern).toBeDefined()
    const fixed = new RegExp(pattern!)
    expect(fixed.test(POWERSHELL_HELPER_ARGS_LINE)).toBe(true)
    for (const other of [
      `${POWERSHELL_HELPER_ARGS_LINE} -Command calc`,
      `${POWERSHELL_HELPER_ARGS_LINE};calc`,
      POWERSHELL_HELPER_ARGS_LINE.replace('-EncodedCommand', '-File'),
      POWERSHELL_HELPER_ARGS_LINE.toLowerCase(),
      '-NoProfile -Command calc'
    ])
      expect(fixed.test(other), other.slice(-40)).toBe(false)
    expect(POWERSHELL_LAUNCHER).toContain('-ArgumentList $line ')
    expect(POWERSHELL_LAUNCHER).toContain('-PassThru')
    // Its own variable must never be `$args` (an automatic variable).
    expect(POWERSHELL_LAUNCHER).not.toMatch(/\$args\b/i)
  })

  it('the launcher writes the pid and error files the app reads', () => {
    expect(POWERSHELL_LAUNCHER).toContain("$B=$A -replace '\\.helper-args$',''")
    expect(POWERSHELL_LAUNCHER).toContain('[IO.File]::WriteAllText("$B.helper-pid"')
    expect(POWERSHELL_LAUNCHER).toContain('[IO.File]::WriteAllText("$B.launch-error"')
    // The same derivation, on the names jobFiles gives.
    const files = jobFiles('/s', newToken())
    const base = files.helperArgs.replace(/\.helper-args$/, '')
    expect(`${base}.helper-pid`).toBe(files.helperPid)
    expect(`${base}.launch-error`).toBe(files.launchError)
  })

  it('a Windows job carries the helper arguments file; a macOS job none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-args-'))
    try {
      const job = (platform: 'win32' | 'darwin', token: string): RelaunchJob => ({
        schema: 1,
        token,
        pid: 1,
        platform,
        mode: 'relaunch',
        installPath: 'C:\\x\\ClaudeUI',
        installKey: '0123456789abcdef',
        stateDir: dir,
        stagedPath: '',
        backupPath: '',
        failedPath: '',
        fromVersion: '1.0.0',
        toVersion: '1.0.0',
        startedAt: 1,
        launch: [],
        timeouts: DEFAULT_TIMEOUTS
      })
      const winToken = newToken()
      const win = jobFiles(dir, winToken)
      writeJobFiles(win, job('win32', winToken))
      expect(fs.readFileSync(win.helperArgs, 'utf8')).toBe(POWERSHELL_HELPER_ARGS_LINE)
      if (process.platform !== 'win32') expect(fs.statSync(win.helperArgs).mode & 0o777).toBe(0o600)
      const macToken = newToken()
      const mac = jobFiles(dir, macToken)
      writeJobFiles(mac, job('darwin', macToken))
      expect(fs.existsSync(mac.helperArgs)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Windows PowerShell 5.1's default aliases (Get-Alias). An alias wins over a
  // function of the same name, so a helper function named like one never runs:
  // `function Ren` was silently Rename-Item, and every swap failed.
  const PS51_ALIASES =
    `% ? ac asnp cat cd CFS chdir clc clear clhy cli clp cls clv cnsn compare copy
    cp cpi cpp curl cvpa dbp del diff dir dnsn ebp echo epal epcsv epsn erase etsn exsn fc fhx
    fl foreach ft fw gal gbp gc gcb gci gcm gcs gdr ghy gi gin gjb gl gm gmo gp gps gpv group
    gsn gsnp gsv gtz gu gv gwmi h history icm iex ihy ii ipal ipcsv ipmo ipsn irm ise iwmi iwr
    kill lp ls man md measure mi mount move mp mv nal ndr ni nmo npssc nsn nv ogv oh popd ps
    pushd pwd r rbp rcjb rcsn rd rdr ren ri rjb rm rmdir rmo rni rnp rp rsn rsnp rujb rv rvpa
    rwmi sajb sal saps sasv sbp sc scb select set shcm si sl sleep sls sort sp spjb spps spsv
    start stz sujb sv swmi tee trcm type wget where wjb write
    help mkdir more oss pause prompt`
      .split(/\s+/)
      .filter(Boolean)
      .map((a) => a.toLowerCase())

  it('no helper function is shadowed by a built-in Windows PowerShell 5.1 alias', () => {
    const functions = [
      ...`${POWERSHELL_HELPER}\n${POWERSHELL_LAUNCHER}`.matchAll(/function\s+([\w-]+)/g)
    ].map((m) => m[1])
    expect(functions.length).toBeGreaterThan(5)
    expect(functions).toContain('MoveDir')
    const shadowed = functions.filter((f) => PS51_ALIASES.includes(f.toLowerCase()))
    expect(shadowed).toEqual([])
  })

  it.each(Object.entries(SCRIPTS))(
    'the %s reads and writes every file as UTF-8, never in the ANSI code page',
    (_name, script) => {
      expect(script).not.toMatch(/Get-Content|Add-Content|Set-Content|Out-File/)
      const calls = [...script.matchAll(/\[IO\.File\]::(\w+)\(([^;\n]*)/g)]
      expect(calls.length).toBeGreaterThan(1)
      for (const m of calls) {
        if (m[1] === 'ReadAllText') expect(m[2]).toContain('[Text.Encoding]::UTF8')
        else expect(m[2], m[1]).toContain('$U8')
      }
    }
  )

  it('the helper reads its job as UTF-8, and shared files without locking out a writer', () => {
    expect(POWERSHELL_HELPER).toContain(
      '[IO.File]::ReadAllText($env:CLAUDEUI_RELAUNCH_JOB,[Text.Encoding]::UTF8)'
    )
    expect(POWERSHELL_HELPER).toContain('[IO.StreamReader]::new($f,$U8)')
  })

  it('stopped after the swap reports interrupted; before it, puts a moved install back', () => {
    const trap = /trap\{[\s\S]*?\n(?=#|function)/.exec(POWERSHELL_HELPER)?.[0] ?? ''
    expect(trap).toContain("if($script:Swapped){Fin 'interrupted' $IR}")
    expect(trap).toContain('(MoveDir $j.backupPath $I 10)){Go $I}')
    expect(POWERSHELL_HELPER).toContain('$swapAt=Get-Date;$script:Swapped=$true')
  })

  it('treats a reused pid (a process started after the job) as the old one gone', () => {
    expect(POWERSHELL_HELPER).toMatch(/function Old\{[^\n]*StartTime[^\n]*-le \$T0\}/)
    expect(POWERSHELL_HELPER).toContain('while(Old){')
  })

  // PowerShell variable names are case-insensitive, and a function sees its
  // callers' variables (dynamic scope), so two spellings of one name are one
  // variable anywhere in the script: `$t0=Get-Date` after the launch silently
  // overwrote `$T0`, the job start the reused-pid check compares against.
  it.each(Object.entries(SCRIPTS))(
    'every variable in the %s has one spelling (PowerShell names are case-insensitive)',
    (name, script) => {
      const spellings = new Map<string, Set<string>>()
      for (const m of script.matchAll(/\$(?:(?:script|global|local|private):)?(\w+)(:?)/gi)) {
        if (m[2] === ':') continue // `$env:NAME`: an environment variable, not a variable
        const key = m[1].toLowerCase()
        spellings.set(key, (spellings.get(key) ?? new Set<string>()).add(m[1]))
      }
      expect(spellings.size).toBeGreaterThan(name === 'helper' ? 20 : 4)
      if (name === 'helper') expect(spellings.has('t0')).toBe(true)
      const clashes = [...spellings.values()].filter((s) => s.size > 1).map((s) => [...s].join('/'))
      expect(clashes).toEqual([])
    }
  )

  it('no script deletes recursively or stops a process by name', () => {
    for (const script of Object.values(SCRIPTS))
      expect(script).not.toMatch(
        /-Recurse|Remove-Item\s+-LiteralPath\s+\$I|Stop-Process\s+-Name|taskkill/i
      )
    expect(BASH_HELPER).not.toMatch(/rm\s+-[a-z]*r|pkill|killall/)
    // The only process stops are by pid.
    for (const m of POWERSHELL_HELPER.matchAll(/Stop-Process[^;}]*/g)) expect(m[0]).toContain('-Id')
    expect(POWERSHELL_LAUNCHER).not.toMatch(/Stop-Process|Remove-Item/)
  })
})

const started: number[] = []
const launchers: SpawnedHelper[] = []
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  // By handle (a no-op once it exited). A helper is left to its own timeouts:
  // its pid may name another process by now.
  for (const launcher of launchers) launcher.stop?.()
})

/**
 * Everything a run left behind, for a failure message (CI is the only Windows
 * feedback): how the process ended (`how`), the launcher's files, whether the
 * helper got as far as `<t>.ready`, its log, the result as written, and what
 * the state dir holds.
 */
function helperDiagnostics(files: JobFiles, state: string, how: string[]): string {
  const tail = (text: string, max = 4000): string =>
    text === '' ? '(empty)' : text.length > max ? `...${text.slice(-max)}` : text
  const errCode = (err: unknown): string =>
    (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err))
  const content = (file: string): string => {
    try {
      return tail(fs.readFileSync(file, 'utf8'), 8000)
    } catch (err) {
      return `(${errCode(err)})`
    }
  }
  let listing: string
  try {
    listing = fs.readdirSync(state).join(', ') || '(empty)'
  } catch (err) {
    listing = `(${errCode(err)})`
  }
  const pid = readHelperPid(files.helperPid)
  const pidState = pid === null ? '' : ` (pid ${pid}: ${alive(pid) ? 'running' : 'gone'})`
  return [
    ...how,
    `${path.basename(files.helperArgs)} exists: ${fs.existsSync(files.helperArgs)}`,
    `${path.basename(files.helperPid)}: ${content(files.helperPid)}${pidState}`,
    `${path.basename(files.launchError)}: ${content(files.launchError)}`,
    `${path.basename(files.ready)} exists: ${fs.existsSync(files.ready)}`,
    `${path.basename(files.log)}: ${content(files.log)}`,
    `${path.basename(files.result)}: ${content(files.result)}`,
    `state dir: ${listing}`
  ].join('\n')
}

/** How a finished `spawnSync` went, as diagnostics lines. */
function syncHow(r: SpawnSyncReturns<string>): string[] {
  const exit = `exited with code ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}`
  return [
    `powershell: ${r.error ? `${r.error.message}; ${exit}` : exit}`,
    `stderr: ${r.stderr || '(empty)'}`,
    `stdout: ${r.stdout || '(empty)'}`
  ]
}

const FAKE_CMD = `@echo off
set "app=%~1"
set /p v=<"%app%\\resources\\version.txt"
set /p mode=<"%app%\\resources\\mode.txt"
>>"%FAKE_LAUNCHES%" echo %v%
if "%mode%"=="healthy" powershell -NoProfile -Command "Start-Sleep -Milliseconds 1200; $f=Join-Path $env:FAKE_STATE ('health\\'+$env:FAKE_KEY+'.json'); New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null; [IO.File]::WriteAllText($f, '{\\"version\\":\\"%v%\\",\\"buildId\\":\\"b\\",\\"pid\\":1,\\"at\\":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}')"
ping -n 15 127.0.0.1 >nul
`

function makeWinFake(dir: string, version: string, mode: 'healthy' | 'silent'): string {
  fs.mkdirSync(path.join(dir, 'resources'), { recursive: true })
  fs.copyFileSync(
    path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    path.join(dir, 'ClaudeUI.exe')
  )
  fs.writeFileSync(path.join(dir, 'resources', 'fake.cmd'), FAKE_CMD.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(dir, 'resources', 'version.txt'), version)
  fs.writeFileSync(path.join(dir, 'resources', 'mode.txt'), mode)
  fs.writeFileSync(
    path.join(dir, 'resources', 'claudeui-install.json'),
    JSON.stringify({
      schema: 1,
      product: INSTALL_MARKER_PRODUCT,
      kind: 'desktop',
      entries: ['ClaudeUI.exe', 'resources']
    })
  )
  return dir
}

const versionOf = (dir: string): string =>
  fs.readFileSync(path.join(dir, 'resources', 'version.txt'), 'utf8').trim()

/**
 * A stand-in for the running app: a process that lives `seconds`. It is given a
 * moment to age before the job is written, because the helper treats a pid whose
 * process started after the job's `startedAt` as a reused pid (gone), and on
 * Windows `Date.now()` can trail the kernel's precise creation time by a clock
 * tick. The real app always started long before its relaunch job.
 */
async function spawnOldApp(seconds: number): Promise<ReturnType<typeof spawn>> {
  const old = spawn('cmd.exe', ['/c', `ping -n ${seconds} 127.0.0.1 >nul`], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 1500))
  return old
}

describe.skipIf(process.platform !== 'win32')('PowerShell relaunch helper (Windows)', () => {
  const cmdExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

  // A syntax error makes powershell.exe print it and exit before the first
  // line runs, which a helper started with no output never shows.
  it.each(Object.entries(SCRIPTS))(
    'the compacted %s parses in Windows PowerShell 5.1',
    (_, script) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-parse-'))
      const file = path.join(dir, 'script.ps1')
      // With a BOM: Windows PowerShell reads a BOM-less file in the ANSI code page.
      fs.writeFileSync(file, `\ufeff${script}`, 'utf8')
      const parse = [
        '$e=$null;$t=$null',
        '[void][System.Management.Automation.Language.Parser]::ParseFile($env:RL_PARSE_FILE,[ref]$t,[ref]$e)',
        "if($e.Count){$e|%{$_.Extent.StartLineNumber.ToString()+': '+$_.Message+' | '+$_.Extent.StartScriptPosition.Line};exit 1}",
        'exit 0'
      ].join('\n')
      const cmd = helperCommand('win32', winFiles(dir, 't'))
      const r = spawnSync(
        cmd.file,
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(parse)],
        {
          env: helperEnv(process.env, { env: { RL_PARSE_FILE: file }, unsetEnv: cmd.unsetEnv }),
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60_000
        }
      )
      fs.rmSync(dir, { recursive: true, force: true })
      expect(r.status, syncHow(r).join('\n')).toBe(0)
    },
    90_000
  )

  // Lower level than production: the helper's own arguments run attached (no
  // launcher) with the output captured, so a helper that cannot run at all
  // says why. The old pid is dead and the launch just exits: no-health.
  it('the helper runs to a result when attached, its output captured', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-sync-')))
    const state = path.join(root, 'state')
    const install = path.join(root, 'ClaudeUI')
    fs.mkdirSync(state)
    fs.mkdirSync(install)
    const token = newToken()
    const files = jobFiles(state, token)
    const job: RelaunchJob = {
      schema: 1,
      token,
      pid: spawnSync(cmdExe, ['/c', 'exit']).pid!,
      platform: 'win32',
      mode: 'relaunch',
      installPath: install,
      installKey: installKeyFor(install, 'win32'),
      stateDir: state,
      stagedPath: '',
      backupPath: '',
      failedPath: '',
      fromVersion: '1.0.0',
      toVersion: '1.0.0',
      startedAt: Date.now(),
      launch: [cmdExe, '/c', 'exit'],
      timeouts: { waitPidSec: 5, lockWaitSec: 1, killWaitSec: 1, launchCheckSec: 1, healthSec: 2 }
    }
    takeLock(state, { token, pid: process.pid, at: Date.now() })
    writeJobFiles(files, job)
    const cmd = helperCommand('win32', files)
    const r = spawnSync(cmd.file, [...POWERSHELL_HELPER_ARGS], {
      cwd: state,
      env: helperEnv(process.env, cmd),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    })
    const why = helperDiagnostics(files, state, syncHow(r))
    expect(fs.existsSync(files.result), `no result\n${why}`).toBe(true)
    let result: RelaunchResult | null = null
    try {
      result = parseRelaunchResult(JSON.parse(fs.readFileSync(files.result, 'utf8')))
    } catch {
      /* the diagnostics show what was written */
    }
    expect(result?.status, why).toBe('no-health')
    expect(r.status, why).toBe(0)
    expect(fs.existsSync(path.join(state, 'lock')), why).toBe(false)
  }, 90_000)

  it('helper arguments that are not the fixed command line: the launcher refuses and says why', async () => {
    const state = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-bad-')))
    const files = jobFiles(state, newToken())
    fs.writeFileSync(files.helperArgs, '-NoProfile -Command "exit 0"')
    const spawned = spawnDetachedHelper(helperCommand('win32', files), state)
    launchers.push(spawned)
    const err = await Promise.race([
      spawned.failed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 60_000))
    ])
    const why = helperDiagnostics(files, state, [`launcher: ${err?.message ?? 'no failure'}`])
    expect(err?.message, why).toMatch(/the helper launcher failed \(exit code 1\)/)
    expect(fs.readFileSync(files.launchError, 'utf8'), why).toContain('not the fixed command line')
    expect(fs.existsSync(files.helperPid), why).toBe(false)
  }, 90_000)

  function fixture(
    mode: 'relaunch' | 'swap',
    staged?: 'healthy' | 'silent',
    opts: { segment?: string } = {}
  ) {
    // The long form: runners hand out 8.3 short temp paths, while
    // Win32_Process.ExecutablePath (what the helper matches) is always long.
    let root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-')))
    if (opts.segment) {
      root = path.join(root, opts.segment)
      fs.mkdirSync(root)
    }
    const state = path.join(root, 'state')
    fs.mkdirSync(state)
    const install = makeWinFake(path.join(root, 'ClaudeUI'), '1.0.0', 'healthy')
    const token = newToken()
    const files = jobFiles(state, token)
    const stagedPath = siblingPath(install, 'update', '2.0.0', token, 'win32')
    if (staged) makeWinFake(stagedPath, '2.0.0', staged)
    const backup = backupPathFor(install, '1.0.0', token, 'win32')
    const failed = failedPathFor(install, '2.0.0', token, 'win32')
    const key = installKeyFor(install, 'win32')
    const launch = { status: 'launcher: never spawned', failed: false }
    const run = (
      over: {
        pid?: number
        timeouts?: Partial<RelaunchTimeouts>
        /** After the job and lock are written, before the launcher starts. */
        beforeSpawn?: () => void
      } = {}
    ): void => {
      const job: RelaunchJob = {
        schema: 1,
        token,
        pid: over.pid ?? spawnSync('cmd.exe', ['/c', 'exit']).pid!,
        platform: 'win32',
        mode,
        installPath: install,
        installKey: key,
        stateDir: state,
        stagedPath: mode === 'swap' ? stagedPath : '',
        backupPath: mode === 'swap' ? backup : '',
        failedPath: mode === 'swap' ? failed : '',
        fromVersion: '1.0.0',
        toVersion: mode === 'swap' ? '2.0.0' : '1.0.0',
        startedAt: Date.now(),
        launch: ['{app}\\ClaudeUI.exe', '/c', '{app}\\resources\\fake.cmd', '{app}'],
        timeouts: {
          ...DEFAULT_TIMEOUTS,
          waitPidSec: 10,
          lockWaitSec: 1,
          killWaitSec: 2,
          launchCheckSec: 3,
          healthSec: 10,
          ...over.timeouts
        }
      }
      takeLock(state, { token, pid: process.pid, at: Date.now() })
      writeJobFiles(files, job)
      over.beforeSpawn?.()
      // The production spawn, as the app does it; only the fakes' variables are added.
      const spawned = spawnDetachedHelper(helperCommand('win32', files), state, {
        ...process.env,
        FAKE_LAUNCHES: path.join(root, 'launches.log'),
        FAKE_STATE: state,
        FAKE_KEY: key
      })
      launchers.push(spawned)
      launch.status = `launcher: pid ${spawned.pid}, no failure reported`
      void spawned.failed.then((err) => {
        launch.status = `launcher: pid ${spawned.pid}, ${err.message}`
        launch.failed = true
      })
    }
    /** Wait for `probe`; a failed launcher, or a helper gone 2 s with no result, fails at once. */
    const waitOrExplain = async <T>(
      probe: () => T | null,
      ms: number,
      what: string
    ): Promise<T> => {
      let goneSince = 0
      try {
        return await waitFor(
          () => {
            const v = probe()
            if (v) return v
            if (fs.existsSync(files.result)) return null
            if (launch.failed) throw new Error('the launcher failed')
            const pid = readHelperPid(files.helperPid)
            if (pid !== null && !alive(pid)) {
              goneSince ||= Date.now()
              if (Date.now() - goneSince > 2000)
                throw new Error('the helper exited without writing a result')
            }
            return null
          },
          ms,
          what
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`${message}\n${helperDiagnostics(files, state, [launch.status])}`, {
          cause: err
        })
      }
    }
    const result = (): Promise<RelaunchResult> =>
      waitOrExplain(
        () =>
          fs.existsSync(files.result)
            ? parseRelaunchResult(JSON.parse(fs.readFileSync(files.result, 'utf8')))
            : null,
        60_000,
        'the result'
      )
    /** The production budget: the app gives up on a helper not ready by then. */
    const ready = (): Promise<true> =>
      waitOrExplain(
        () => fs.existsSync(files.ready) || null,
        READY_TIMEOUT_WIN32_MS,
        'the ready file'
      )
    /** The helper, by the pid its launcher wrote, has exited. */
    const helperExit = (): Promise<true> =>
      waitOrExplain(
        () => {
          const pid = readHelperPid(files.helperPid)
          return (pid !== null && !alive(pid)) || null
        },
        60_000,
        'the helper to exit'
      )
    const explain = (): string => helperDiagnostics(files, state, [launch.status])
    return {
      root,
      state,
      install,
      stagedPath,
      backup,
      failed,
      files,
      run,
      result,
      ready,
      helperExit,
      explain
    }
  }

  it('relaunch: ready within the production budget, then ok once healthy', async () => {
    const f = fixture('relaunch')
    f.run()
    await f.ready()
    expect((await f.result()).status).toBe('ok')
    expect(readHelperPid(f.files.helperPid)).not.toBeNull()
    expect(fs.existsSync(path.join(f.state, 'lock'))).toBe(false)
  }, 90_000)

  it('a non-ASCII install path: the job is read as UTF-8 and the swap lands', async () => {
    const f = fixture('swap', 'healthy', { segment: 'José-新建' })
    f.run()
    expect((await f.result()).status).toBe('updated')
    expect(versionOf(f.install)).toBe('2.0.0')
    expect(versionOf(f.backup)).toBe('1.0.0')
    expect(fs.readFileSync(f.files.log, 'utf8')).toContain('José-新建')
  }, 90_000)

  it('swap: updated, backup kept', async () => {
    const f = fixture('swap', 'healthy')
    f.run()
    expect((await f.result()).status).toBe('updated')
    expect(versionOf(f.install)).toBe('2.0.0')
    expect(versionOf(f.backup)).toBe('1.0.0')
  }, 90_000)

  it('swap: never healthy → rolled back', async () => {
    const f = fixture('swap', 'silent')
    f.run({ timeouts: { healthSec: 6 } })
    expect((await f.result()).status).toBe('rolled-back')
    expect(versionOf(f.install)).toBe('1.0.0')
    expect(versionOf(f.failed)).toBe('2.0.0')
  }, 90_000)

  /** Nothing renamed or launched, and no result beyond the app's own. */
  const expectUntouched = (f: ReturnType<typeof fixture>, reason: string, why: string): void => {
    expect(versionOf(f.install), why).toBe('1.0.0')
    expect(versionOf(f.stagedPath), why).toBe('2.0.0')
    expect(fs.existsSync(f.backup), why).toBe(false)
    expect(fs.existsSync(path.join(f.root, 'launches.log')), why).toBe(false)
    if (reason === 'the job already has a result')
      expect(fs.readFileSync(f.files.result, 'utf8'), why).toBe(GAVE_UP)
    else expect(fs.existsSync(f.files.result), why).toBe(false)
  }

  // The app gives up on a helper not ready in time: it writes the result and
  // releases the lock, while it still runs. A helper that starts after that
  // must touch nothing, never wait for the app's next quit and act then.
  it.each(GIVE_UPS)(
    'a job no longer live (%s): exits at once, touching nothing',
    async (reason, gaveUp) => {
      const f = fixture('swap', 'healthy')
      const old = await spawnOldApp(60)
      started.push(old.pid!)
      f.run({ pid: old.pid, timeouts: { waitPidSec: 60 }, beforeSpawn: () => gaveUp(f) })
      await f.helperExit()
      const why = f.explain()
      expect(fs.existsSync(f.files.ready), why).toBe(false)
      expect(fs.readFileSync(f.files.log, 'utf8'), why).toContain(`job no longer live: ${reason}`)
      expectUntouched(f, reason, why)
      old.kill()
    },
    90_000
  )

  // Given up on after it wrote `.ready` (it came up just too late): it sees
  // that once the old process is gone, before touching or launching anything.
  // The user's later quit is unrelated: relaunching then would be unrequested.
  it.each(GIVE_UPS)(
    'given up on after it was ready (%s): no launch, no rename once the old process exits',
    async (reason, gaveUp) => {
      const f = fixture('swap', 'healthy')
      const old = await spawnOldApp(60)
      started.push(old.pid!)
      f.run({ pid: old.pid, timeouts: { waitPidSec: 60 } })
      await f.ready()
      gaveUp(f)
      old.kill() // the user quits, later, for reasons of their own
      await f.helperExit()
      await new Promise((r) => setTimeout(r, 2000)) // a launch would show by now
      const why = f.explain()
      const log = fs.readFileSync(f.files.log, 'utf8')
      expect(log, why).toContain(`process ${old.pid} exited`)
      expect(log, why).toContain(`job no longer live: ${reason}`)
      expectUntouched(f, reason, why)
    },
    90_000
  )

  it('old process never exits: aborted, nothing touched', async () => {
    const f = fixture('swap', 'healthy')
    const old = await spawnOldApp(30)
    started.push(old.pid!)
    f.run({ pid: old.pid, timeouts: { waitPidSec: 2 } })
    expect((await f.result()).status).toBe('aborted')
    expect(versionOf(f.install)).toBe('1.0.0')
    expect(versionOf(f.stagedPath)).toBe('2.0.0')
    old.kill()
  }, 90_000)

  it('the backup path exists: failed before any rename', async () => {
    const f = fixture('swap', 'healthy')
    fs.mkdirSync(f.backup)
    f.run()
    const r = await f.result()
    expect(r).toMatchObject({ status: 'failed', reason: 'the backup path already exists' })
    expect(versionOf(f.install)).toBe('1.0.0')
    expect(versionOf(f.stagedPath)).toBe('2.0.0')
  }, 90_000)
})
