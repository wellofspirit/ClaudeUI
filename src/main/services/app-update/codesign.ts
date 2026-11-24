/**
 * macOS: is a staged release signed well enough to replace the running app
 * (design review ruling 10)? Critical: this decides which build runs next.
 *
 *   1. `codesign --verify --deep --strict <staged>` must pass (the bundle is
 *      intact and every nested binary is signed).
 *   2. The running app's signature (`codesign -dv <install>`):
 *      - ad-hoc (`Signature=adhoc`, a local build): there is no identity to
 *        keep, so the requirement check is skipped, and logged;
 *      - certificate-signed: its designated requirement (`codesign -d -r-`, the
 *        text after `designated => `) must be met by the staged build
 *        (`codesign --verify -R =<requirement>`), or one of the pinned
 *        `UPDATE_ACCEPTED_REQUIREMENTS` must be (a certificate change);
 *      - unreadable (not signed at all, or `codesign` failed): refused, since
 *        nothing says which identity an update must carry.
 *
 * `codesign` is `/usr/bin/codesign` by absolute path and argv only; the
 * requirement text reaches it as one argument, never through a shell. Outputs
 * are parsed defensively: anything unexpected is a refusal.
 */

import { UPDATE_ACCEPTED_REQUIREMENTS } from '../../../shared/update-keys'
import type { Exec } from './exec'

export const CODESIGN = '/usr/bin/codesign'

export interface SignaturePolicyArgs {
  exec: Exec
  /** The running app's bundle. */
  installPath: string
  /** The staged bundle to check. */
  stagedPath: string
  /** Extra requirements the staged build may satisfy instead (default: the pinned list). */
  acceptedRequirements?: readonly string[]
  log?: (message: string) => void
}

export type SignatureVerdict =
  { ok: true; identity: 'adhoc' | 'designated' | 'accepted' } | { ok: false; reason: string }

const output = (r: { stdout: string; stderr: string }): string => `${r.stdout}\n${r.stderr}`

/** `Signature=adhoc` on a line of its own in `codesign -dv` output. */
export function isAdhocSignature(text: string): boolean {
  return /^Signature=adhoc\s*$/m.test(text)
}

/** The requirement after `designated => ` in `codesign -d -r-` output, or null. */
export function designatedRequirement(text: string): string | null {
  const m = /^designated => (.+)$/m.exec(text)
  if (!m) return null
  const req = m[1].trim()
  if (req === '' || req.length > 4096 || /[\0\r\n]/.test(req)) return null
  return req
}

export async function checkStagedSignature(args: SignaturePolicyArgs): Promise<SignatureVerdict> {
  const { exec, installPath, stagedPath } = args
  const log = args.log ?? (() => {})

  const verify = await exec(CODESIGN, ['--verify', '--deep', '--strict', stagedPath])
  if (verify.code !== 0) return { ok: false, reason: "The update's code signature is not valid" }

  const running = await exec(CODESIGN, ['-dv', installPath])
  if (running.code !== 0)
    return {
      ok: false,
      reason: "ClaudeUI could not read its own code signature, so it cannot check the update's"
    }
  if (isAdhocSignature(output(running))) {
    log(
      'this ClaudeUI is ad-hoc signed (a local build): the update is not checked against a signing identity'
    )
    return { ok: true, identity: 'adhoc' }
  }

  const dr = await exec(CODESIGN, ['-d', '-r-', installPath])
  const requirement = dr.code === 0 ? designatedRequirement(output(dr)) : null
  if (!requirement)
    return {
      ok: false,
      reason: "ClaudeUI could not read its own signing requirement, so it cannot check the update's"
    }

  const meets = async (req: string): Promise<boolean> =>
    (await exec(CODESIGN, ['--verify', '-R', `=${req}`, stagedPath])).code === 0

  if (await meets(requirement)) return { ok: true, identity: 'designated' }
  for (const req of args.acceptedRequirements ?? UPDATE_ACCEPTED_REQUIREMENTS) {
    if (typeof req === 'string' && req.trim() !== '' && (await meets(req.trim()))) {
      log("the update meets an accepted signing requirement, not this build's own")
      return { ok: true, identity: 'accepted' }
    }
  }
  return { ok: false, reason: 'The update is not signed by the same developer as this ClaudeUI' }
}
