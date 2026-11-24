/**
 * @vitest-environment node
 *
 * The PowerShell relaunch helper. The shape checks run everywhere; the end-to-end
 * cases run only on Windows (CI's windows-2022 runner), against temp dirs with a
 * fake install whose `ClaudeUI.exe` is a copy of `cmd.exe` running `fake.cmd`,
 * so a running fake is a process whose executable is under the install.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  BASH_HELPER,
  POWERSHELL_ENCODED_LIMIT,
  POWERSHELL_HELPER,
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
import { takeLock } from '../lock'
import { parseRelaunchResult, type RelaunchResult } from '../../../../shared/relaunch'
import { INSTALL_MARKER_PRODUCT } from '../../../../shared/install-marker'
import { waitFor } from './fake-install'

describe('PowerShell helper shape', () => {
  it('fits the command line with room to spare', () => {
    const encoded = encodePowerShell(POWERSHELL_HELPER)
    expect(encoded.length).toBeLessThan(POWERSHELL_ENCODED_LIMIT)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(POWERSHELL_HELPER)
  })

  it('is spawned by absolute path with the job path in the environment only', () => {
    const cmd = helperCommand(
      'win32',
      { json: 'C:\\s\\t.job.json', sh: 'C:\\s\\t.job.sh' },
      'C:\\Windows'
    )
    expect(cmd.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(cmd.args.slice(0, -1)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand'
    ])
    expect(cmd.env).toEqual({ CLAUDEUI_RELAUNCH_JOB: 'C:\\s\\t.job.json' })
    expect(cmd.unsetEnv).toEqual(['PSModulePath'])
    expect(cmd.args.join(' ')).not.toContain('t.job')
  })

  it('the helper environment drops PSModulePath in any spelling and adds the job path', () => {
    const cmd = helperCommand('win32', { json: 'C:\\s\\j.json', sh: '' }, 'C:\\Windows')
    const env = helperEnv({ PATH: 'p', PSModulePath: 'a', psmodulepath: 'b', KEEP: '1' }, cmd)
    expect(env).toEqual({ PATH: 'p', KEEP: '1', CLAUDEUI_RELAUNCH_JOB: 'C:\\s\\j.json' })
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
    const functions = [...POWERSHELL_HELPER.matchAll(/function\s+([\w-]+)/g)].map((m) => m[1])
    expect(functions.length).toBeGreaterThan(5)
    expect(functions).toContain('MoveDir')
    const shadowed = functions.filter((f) => PS51_ALIASES.includes(f.toLowerCase()))
    expect(shadowed).toEqual([])
  })

  it('reads and writes every file as UTF-8, never in the ANSI code page', () => {
    expect(POWERSHELL_HELPER).toContain(
      '[IO.File]::ReadAllText($env:CLAUDEUI_RELAUNCH_JOB,[Text.Encoding]::UTF8)'
    )
    expect(POWERSHELL_HELPER).not.toMatch(/Get-Content|Add-Content|Set-Content|Out-File/)
    for (const m of POWERSHELL_HELPER.matchAll(/\[IO\.File\]::(\w+)\(([^;]*)/g)) {
      if (m[1] === 'ReadAllText') expect(m[2]).toContain('[Text.Encoding]::UTF8')
      else expect(m[2], m[1]).toContain('$U8')
    }
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
  it('every variable has one spelling (PowerShell names are case-insensitive)', () => {
    const spellings = new Map<string, Set<string>>()
    for (const m of POWERSHELL_HELPER.matchAll(
      /\$(?:(?:script|global|local|private):)?(\w+)(:?)/gi
    )) {
      if (m[2] === ':') continue // `$env:NAME`: an environment variable, not a variable
      const key = m[1].toLowerCase()
      spellings.set(key, (spellings.get(key) ?? new Set<string>()).add(m[1]))
    }
    expect(spellings.size).toBeGreaterThan(20)
    expect(spellings.has('t0')).toBe(true)
    const clashes = [...spellings.values()].filter((s) => s.size > 1).map((s) => [...s].join('/'))
    expect(clashes).toEqual([])
  })

  it('neither script deletes recursively or stops a process by name', () => {
    expect(POWERSHELL_HELPER).not.toMatch(
      /-Recurse|Remove-Item\s+-LiteralPath\s+\$I|Stop-Process\s+-Name|taskkill/i
    )
    expect(BASH_HELPER).not.toMatch(/rm\s+-[a-z]*r|pkill|killall/)
    // The only process stops are by pid.
    for (const m of POWERSHELL_HELPER.matchAll(/Stop-Process[^;}]*/g)) expect(m[0]).toContain('-Id')
  })
})

const started: number[] = []
const helpers: ChildProcess[] = []
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  // A no-op for one that exited (its pid may name another process by now).
  for (const child of helpers) child.kill()
})

/** How a helper run ended (null while it runs), and what it printed. */
interface HelperRun {
  status: string | null
  exitedAt: number
  stdout: string
  stderr: string
}

/**
 * Everything a helper run left behind, for a failure message (CI is the only
 * Windows feedback): how the process ended, its output, whether it got as far
 * as `<t>.ready`, its log, the result as written, and what the state dir holds.
 */
function helperDiagnostics(files: JobFiles, state: string, run: HelperRun): string {
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
  return [
    `helper: ${run.status ?? 'still running'}`,
    `stderr: ${tail(run.stderr)}`,
    `stdout: ${tail(run.stdout)}`,
    `${path.basename(files.ready)} exists: ${fs.existsSync(files.ready)}`,
    `${path.basename(files.log)}: ${content(files.log)}`,
    `${path.basename(files.result)}: ${content(files.result)}`,
    `state dir: ${listing}`
  ].join('\n')
}

/** A finished `spawnSync` as a {@link HelperRun}. */
function syncRun(r: SpawnSyncReturns<string>): HelperRun {
  const how = `exited with code ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}`
  return {
    status: r.error ? `${r.error.message}; ${how}` : how,
    exitedAt: Date.now(),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? ''
  }
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

describe.skipIf(process.platform !== 'win32')('PowerShell relaunch helper (Windows)', () => {
  const cmdExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')

  // A syntax error makes powershell.exe print it and exit before the first
  // line runs, which a detached helper with no output never shows.
  it('the compacted helper parses in Windows PowerShell 5.1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-ps-parse-'))
    const file = path.join(dir, 'helper.ps1')
    // With a BOM: Windows PowerShell reads a BOM-less file in the ANSI code page.
    fs.writeFileSync(file, `\ufeff${POWERSHELL_HELPER}`, 'utf8')
    const parse = [
      '$e=$null;$t=$null',
      '[void][System.Management.Automation.Language.Parser]::ParseFile($env:RL_PARSE_FILE,[ref]$t,[ref]$e)',
      "if($e.Count){$e|%{$_.Extent.StartLineNumber.ToString()+': '+$_.Message+' | '+$_.Extent.StartScriptPosition.Line};exit 1}",
      'exit 0'
    ].join('\n')
    const cmd = helperCommand('win32', { json: '', sh: '' })
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
    const out = syncRun(r)
    expect(r.status, `${out.status}\nparse errors:\n${out.stdout}\nstderr:\n${out.stderr}`).toBe(0)
  }, 90_000)

  // The real encoded helper, run attached (not detached) with its output
  // captured, so a helper that cannot run at all says why. The old pid is
  // dead and the launch just exits: nothing reports healthy, so no-health.
  it('runs to a result when attached, its output captured', () => {
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
    const r = spawnSync(cmd.file, cmd.args, {
      cwd: state,
      env: helperEnv(process.env, cmd),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000
    })
    const why = helperDiagnostics(files, state, syncRun(r))
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
    let helper: HelperRun = { status: 'never spawned', exitedAt: 0, stdout: '', stderr: '' }
    const run = (over: { pid?: number; timeouts?: Partial<RelaunchTimeouts> } = {}): void => {
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
      const cmd = helperCommand('win32', files)
      // Detached and hidden as production spawns it, but with its output kept
      // (production ignores it): a helper that writes no result says why.
      const child = spawn(cmd.file, cmd.args, {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: state,
        env: {
          ...helperEnv(process.env, cmd),
          FAKE_LAUNCHES: path.join(root, 'launches.log'),
          FAKE_STATE: state,
          FAKE_KEY: key
        }
      })
      const proc: HelperRun = { status: null, exitedAt: 0, stdout: '', stderr: '' }
      helper = proc
      helpers.push(child)
      child.stdout?.setEncoding('utf8').on('data', (d: string) => (proc.stdout += d))
      child.stderr?.setEncoding('utf8').on('data', (d: string) => (proc.stderr += d))
      const ended = (status: string): void => {
        proc.status ??= status
        proc.exitedAt ||= Date.now()
      }
      child.once('exit', (code, signal) =>
        ended(`exited with code ${code}${signal ? ` (signal ${signal})` : ''}`)
      )
      child.once('error', (err) => ended(`spawn error: ${err.message}`))
      child.unref()
    }
    const result = async (): Promise<RelaunchResult> => {
      try {
        return await waitFor(
          () => {
            if (fs.existsSync(files.result))
              return parseRelaunchResult(JSON.parse(fs.readFileSync(files.result, 'utf8')))
            // Gone for a while with nothing written: it never will.
            if (helper.exitedAt && Date.now() - helper.exitedAt > 2000)
              throw new Error('the helper exited without writing a result')
            return null
          },
          60_000,
          'the result'
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`${message}\n${helperDiagnostics(files, state, helper)}`, { cause: err })
      }
    }
    return { root, state, install, stagedPath, backup, failed, files, run, result }
  }

  it('relaunch: ok once healthy', async () => {
    const f = fixture('relaunch')
    f.run()
    expect((await f.result()).status).toBe('ok')
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

  it('old process never exits: aborted, nothing touched', async () => {
    const f = fixture('swap', 'healthy')
    const old = spawn('cmd.exe', ['/c', 'ping -n 30 127.0.0.1 >nul'], { stdio: 'ignore' })
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
