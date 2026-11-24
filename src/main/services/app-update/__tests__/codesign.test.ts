/**
 * @vitest-environment node
 *
 * The macOS signature policy for a staged release (design review ruling 10),
 * against a scripted `codesign`: nothing here runs the real tool.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CODESIGN,
  checkStagedSignature,
  designatedRequirement,
  isAdhocSignature
} from '../codesign'
import type { Exec, ExecResult } from '../exec'

const INSTALL = '/Applications/ClaudeUI.app'
const STAGED = '/Applications/.ClaudeUI.app.update-2.0.0-abcdef01'
const DR =
  'identifier "com.claudeui.app" and anchor apple generic and certificate leaf[subject.CN] = "ClaudeUI Dev"'

const CERT_DV = [
  `Executable=${INSTALL}/Contents/MacOS/ClaudeUI`,
  'Identifier=com.claudeui.app',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=28+7 location=embedded',
  'Signature size=4797',
  'Authority=ClaudeUI Dev',
  'TeamIdentifier=not set'
].join('\n')
const ADHOC_DV = [
  `Executable=${INSTALL}/Contents/MacOS/ClaudeUI`,
  'Identifier=com.claudeui.app',
  'CodeDirectory v=20400 size=1234 flags=0x2(adhoc) hashes=28+7 location=embedded',
  'Signature=adhoc',
  'TeamIdentifier=not set'
].join('\n')

interface Script {
  verify?: number
  dv?: Partial<ExecResult>
  dr?: Partial<ExecResult>
  /** Exit code of `--verify -R =<req>` per requirement. */
  meets?: Record<string, number>
}

/** A scripted codesign; `calls` records every argv. */
function fakeCodesign(script: Script): { exec: Exec; calls: string[][] } {
  const calls: string[][] = []
  const res = (r: Partial<ExecResult> = {}): ExecResult => ({
    code: 0,
    stdout: '',
    stderr: '',
    ...r
  })
  const exec: Exec = async (file, args) => {
    expect(file).toBe(CODESIGN)
    calls.push([...args])
    if (args[0] === '--verify' && args[1] === '--deep') return res({ code: script.verify ?? 0 })
    if (args[0] === '-dv') return res({ stderr: CERT_DV, ...script.dv })
    if (args[0] === '-d' && args[1] === '-r-')
      return res({
        stdout: `designated => ${DR}\n`,
        stderr: `Executable=${INSTALL}\n`,
        ...script.dr
      })
    if (args[0] === '--verify' && args[1] === '-R') {
      const req = args[2]
      expect(req.startsWith('=')).toBe(true)
      return res({ code: script.meets?.[req.slice(1)] ?? 3 })
    }
    throw new Error(`unexpected codesign ${args.join(' ')}`)
  }
  return { exec, calls }
}

const check = (exec: Exec, accepted: string[] = []) =>
  checkStagedSignature({
    exec,
    installPath: INSTALL,
    stagedPath: STAGED,
    acceptedRequirements: accepted
  })

describe('output parsing', () => {
  it('tells an ad-hoc signature only by its own line', () => {
    expect(isAdhocSignature(ADHOC_DV)).toBe(true)
    expect(isAdhocSignature(CERT_DV)).toBe(false)
    expect(isAdhocSignature('Authority=Signature=adhoc')).toBe(false)
    expect(isAdhocSignature('')).toBe(false)
  })

  it('reads the designated requirement after `designated => `', () => {
    expect(designatedRequirement(`Executable=/x\ndesignated => ${DR}\n`)).toBe(DR)
    expect(designatedRequirement('designated => \n')).toBeNull()
    expect(designatedRequirement('no requirement here')).toBeNull()
    expect(designatedRequirement(`designated => ${'x'.repeat(5000)}`)).toBeNull()
  })
})

describe('checkStagedSignature', () => {
  it('a certificate-signed app: the staged build must meet its designated requirement', async () => {
    const { exec, calls } = fakeCodesign({ meets: { [DR]: 0 } })
    await expect(check(exec)).resolves.toEqual({ ok: true, identity: 'designated' })
    expect(calls).toEqual([
      ['--verify', '--deep', '--strict', STAGED],
      ['-dv', INSTALL],
      ['-d', '-r-', INSTALL],
      ['--verify', '-R', `=${DR}`, STAGED]
    ])
  })

  it('a staged build that does not meet it is refused', async () => {
    const { exec } = fakeCodesign({ meets: { [DR]: 3 } })
    await expect(check(exec)).resolves.toEqual({
      ok: false,
      reason: 'The update is not signed by the same developer as this ClaudeUI'
    })
  })

  it('an accepted requirement (a certificate change) lets it through', async () => {
    const NEXT = 'identifier "com.claudeui.app" and certificate leaf[subject.CN] = "ClaudeUI 2027"'
    const { exec, calls } = fakeCodesign({ meets: { [DR]: 3, [NEXT]: 0 } })
    await expect(check(exec, ['  ', 'anchor apple', NEXT])).resolves.toEqual({
      ok: true,
      identity: 'accepted'
    })
    expect(calls.at(-1)).toEqual(['--verify', '-R', `=${NEXT}`, STAGED])
    // The blank entry is never asked.
    expect(calls.some((c) => c[2] === '=')).toBe(false)
  })

  it('ad-hoc (a local build): the requirement check is skipped, and logged', async () => {
    const log = vi.fn()
    const { exec, calls } = fakeCodesign({ dv: { stderr: ADHOC_DV } })
    await expect(
      checkStagedSignature({ exec, installPath: INSTALL, stagedPath: STAGED, log })
    ).resolves.toEqual({ ok: true, identity: 'adhoc' })
    expect(calls.map((c) => c[0])).toEqual(['--verify', '-dv'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ad-hoc'))
  })

  it('a staged build whose own signature does not verify is refused before anything else', async () => {
    const { exec, calls } = fakeCodesign({ verify: 1, dv: { stderr: ADHOC_DV } })
    await expect(check(exec)).resolves.toEqual({
      ok: false,
      reason: "The update's code signature is not valid"
    })
    expect(calls).toHaveLength(1)
  })

  it('an unsigned (or unreadable) running app refuses: nothing says which identity to keep', async () => {
    const { exec } = fakeCodesign({ dv: { code: 1, stderr: 'code object is not signed at all' } })
    await expect(check(exec)).resolves.toMatchObject({ ok: false })
  })

  it('an unreadable designated requirement refuses', async () => {
    for (const dr of [{ code: 1 }, { stdout: 'nothing useful', stderr: '' }]) {
      const { exec } = fakeCodesign({ dr })
      await expect(check(exec)).resolves.toMatchObject({
        ok: false,
        reason: expect.stringMatching(/signing requirement/)
      })
    }
  })
})
