/**
 * @vitest-environment node
 *
 * `scripts/boot-probe.mjs`: the gate that runs the rebundled bun-claude once,
 * offline, and decides from its output whether it still starts.
 *
 * Why this exists: rebundle-cli only syntax-checks the chunks a patch changed.
 * A patch that parses but throws when the module evaluates ships a binary that
 * dies before its first message, and nothing else in the pipeline notices.
 * The classifier is the contract — healthy means an init line AND a result
 * line AND no thrown JS error on stderr; the offline turn's own exit code 1
 * and `api_error` result are expected and must NOT read as a failure.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod: any = await import('../../../scripts/boot-probe.mjs')
const { classifyBootProbe, parseBootProbeArgs, runBootProbe, probeEnv, defaultBin } = mod

// What the real 2.1.293 build prints offline (init abridged to the fields read).
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  claude_code_version: '2.1.293',
  session_id: 'abc'
})
const RESULT_API_ERROR = JSON.stringify({
  type: 'result',
  is_error: true,
  terminal_reason: 'api_error',
  result: 'API Error: Connection refused (ECONNREFUSED)'
})
const healthy = { code: 1, stdout: `${INIT}\n${RESULT_API_ERROR}\n`, stderr: '', timedOut: false }

describe('classifyBootProbe', () => {
  it('accepts the healthy offline run (init + api_error result, exit 1)', () => {
    expect(classifyBootProbe(healthy)).toEqual({
      ok: true,
      reason: 'booted',
      terminalReason: 'api_error',
      version: '2.1.293'
    })
  })

  it('accepts any result line, not just api_error', () => {
    const stdout = `${INIT}\n${JSON.stringify({ type: 'result', terminal_reason: 'completed' })}\n`
    const v = classifyBootProbe({ ...healthy, code: 0, stdout })
    expect(v.ok).toBe(true)
    expect(v.terminalReason).toBe('completed')
  })

  it('ignores non-JSON noise and partial lines around the real ones', () => {
    const stdout = `warming up\n${INIT}\n{"type":"assistant","mess\n${RESULT_API_ERROR}\n`
    expect(classifyBootProbe({ ...healthy, stdout }).ok).toBe(true)
  })

  it('fails a run that was killed on timeout, even if it printed lines first', () => {
    const v = classifyBootProbe({ ...healthy, code: null, timedOut: true, timeoutMs: 30000 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('timed out after 30000 ms')
  })

  it('fails when there is no init line', () => {
    const v = classifyBootProbe({ ...healthy, stdout: `${RESULT_API_ERROR}\n` })
    expect(v).toMatchObject({ ok: false, reason: 'no init line (exit 1)' })
  })

  it('fails when there is an init line but no result line', () => {
    const v = classifyBootProbe({ ...healthy, stdout: `${INIT}\n` })
    expect(v).toMatchObject({ ok: false, reason: 'no result line (exit 1)' })
  })

  it('fails on a thrown JS error on stderr, and names it', () => {
    const stderr = 'error: boot\nTypeError: l is not a function\n    at <anonymous>\n'
    const v = classifyBootProbe({ ...healthy, code: 1, stdout: '', stderr })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('crashed: TypeError: l is not a function')
  })

  it('fails on a stderr crash even when init and result lines were printed', () => {
    const v = classifyBootProbe({ ...healthy, stderr: 'ReferenceError: x is not defined\n' })
    expect(v.ok).toBe(false)
    expect(v.reason).toMatch(/^crashed: ReferenceError/)
  })

  it('does not treat words that merely contain an error name as a crash', () => {
    expect(classifyBootProbe({ ...healthy, stderr: 'MyTypeErrorish ok\n' }).ok).toBe(true)
  })
})

describe('parseBootProbeArgs', () => {
  it('defaults', () => {
    expect(parseBootProbeArgs([])).toEqual({
      bin: null,
      timeoutMs: 30000,
      quiet: false,
      warnOnly: false
    })
  })

  it('reads every flag', () => {
    const a = parseBootProbeArgs(['--quiet', '--warn-only', '--timeout', '5000', '--bin', 'x.exe'])
    expect(a).toMatchObject({ quiet: true, warnOnly: true, timeoutMs: 5000 })
    expect(a.bin).toMatch(/x\.exe$/)
  })

  it('rejects unknown flags, a missing value and a bad timeout', () => {
    expect(() => parseBootProbeArgs(['--nope'])).toThrow(/unknown argument/)
    expect(() => parseBootProbeArgs(['--bin'])).toThrow(/needs a value/)
    expect(() => parseBootProbeArgs(['--timeout', 'abc'])).toThrow(/positive integer/)
  })
})

describe('probeEnv', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it('carries nothing from the parent but the allowlist, and points at the temp home', () => {
    process.env.CLAUDECODE = '1'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'leak-1'
    process.env.ANTHROPIC_AUTH_TOKEN = 'leak-2'
    process.env.ANTHROPIC_API_KEY = 'leak-3'
    process.env.GITHUB_TOKEN = 'leak-4'

    const env = probeEnv('/tmp/home', 4242)

    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-boot-probe-not-a-real-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4242')
    expect(env.HOME).toBe('/tmp/home')
    expect(env.USERPROFILE).toBe('/tmp/home')
    expect(env.CLAUDE_CONFIG_DIR).toContain('home')
    expect(env.CLAUDE_CODE_MAX_RETRIES).toBe('0')
    // A PATH is still there (under whatever case the platform spells it).
    expect(Object.keys(env).some((k) => k.toLowerCase() === 'path')).toBe(true)
  })
})

describe('runBootProbe: container check', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const fake = (magic: number[]): string => {
    const d = mkdtempSync(join(tmpdir(), 'boot-probe-test-'))
    dirs.push(d)
    const f = join(d, 'bun-claude')
    writeFileSync(f, Buffer.from([...magic, 0, 0, 0, 0]))
    return f
  }
  const PE = [0x4d, 0x5a]
  const MACHO = [0xcf, 0xfa, 0xed, 0xfe] // 0xfeedfacf little-endian
  const ELF = [0x7f, 0x45, 0x4c, 0x46]

  it('skips a binary whose container is not the host platform’s', async () => {
    expect(await runBootProbe({ bin: fake(ELF), platform: 'win32' })).toMatchObject({
      status: 'skipped',
      message: 'elf binary on win32'
    })
    expect(await runBootProbe({ bin: fake(PE), platform: 'linux' })).toMatchObject({
      status: 'skipped',
      message: 'pe binary on linux'
    })
    expect(await runBootProbe({ bin: fake(PE), platform: 'darwin' })).toMatchObject({
      status: 'skipped',
      message: 'pe binary on darwin'
    })
    expect(await runBootProbe({ bin: fake(MACHO), platform: 'win32' })).toMatchObject({
      status: 'skipped',
      message: 'macho64 binary on win32'
    })
  })

  it('does not skip a file that is no known container: garbage must fail, not pass', async () => {
    const r = await runBootProbe({ bin: fake([0x00, 0x01, 0x02, 0x03]), timeoutMs: 10000 })
    expect(r.status).toBe('failed')
  })

  it('probes (rather than skips) a file with the host’s own magic, and fails it cleanly', async () => {
    const magic = { win32: PE, darwin: MACHO, linux: ELF }[process.platform as string]
    if (!magic) return
    // Not a runnable executable: the point is that it is attempted, and that
    // the spawn failure is reported as a failure, not thrown or hung.
    const r = await runBootProbe({ bin: fake(magic), timeoutMs: 10000 })
    expect(r.status).toBe('failed')
    expect(r.reason).toMatch(/could not start|no init line|crashed/)
  })
})

// The real thing: runs vendor/claude-cli/bun-claude once. Gated because another
// session may be mid-`ensure-cli` on a dev box (the binary is briefly absent or
// being replaced), and because it takes seconds.
describe('boot probe against the vendored binary', () => {
  const bin = defaultBin()
  it.runIf(process.env.CLAUDE_INTEGRATION_TESTS === '1' && existsSync(bin))(
    'boots offline and reports an init and a result line',
    async () => {
      const r = await runBootProbe({ bin, timeoutMs: 30000 })
      expect(r.status, `${r.reason}\n${r.stderr}`).toBe('ok')
      expect(r.version).toMatch(/^\d+\.\d+\.\d+/)
    },
    60000
  )
})
