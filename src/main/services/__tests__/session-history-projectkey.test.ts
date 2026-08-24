/**
 * @vitest-environment node
 *
 * H14 guard — the transcript project-key derivation used by session-history's
 * disk consumers must match cli.js's on-disk naming (EVERY non-alphanumeric
 * char → '-'), not the old `/`+`.`+`:`-only replace which left `_`/space
 * intact and pointed at a nonexistent directory.
 *
 * We drive the real `resolveForkAnchor` (a disk consumer of the key) against a
 * temp ~/.claude/projects tree. The transcript lives in the dir cli.js would
 * create for a cwd containing an underscore; a correct derivation finds it, the
 * old one returns `transcript-not-found`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import { cwdToProjectKey } from '../../../shared/project-key'

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'projkey-test-'))
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

async function freshResolveForkAnchor(): Promise<
  (typeof import('../../../core/services/session-history'))['resolveForkAnchor']
> {
  vi.resetModules()
  const mod = await import('../../../core/services/session-history')
  return mod.resolveForkAnchor
}

/** cwd whose cli.js key differs from the legacy `/`+`.`+`:` replace: the `_`
 *  survives the old regex but becomes `-` under the correct derivation. */
const CWD_WITH_UNDERSCORE = '/home/user/my_proj'

function seedTranscript(projectKey: string, sessionId: string): void {
  const dir = nodePath.join(TEMP_HOME, '.claude', 'projects', projectKey)
  fs.mkdirSync(dir, { recursive: true })
  const lines = [
    { type: 'user', userType: 'external', uuid: 'u1', message: { content: 'hi' } },
    {
      type: 'assistant',
      uuid: 'anchor-uuid',
      message: { id: 'msg_x', content: [{ type: 'text', text: 'hello' }] }
    }
  ]
  fs.writeFileSync(
    nodePath.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n')
  )
}

describe('resolveForkAnchor — transcript project-key derivation (H14)', () => {
  it('resolves a transcript in the cli.js-correct dir for a cwd containing "_"', async () => {
    // cli.js would name the dir with the underscore replaced by '-'.
    const correctKey = cwdToProjectKey(CWD_WITH_UNDERSCORE)
    expect(correctKey).toBe('-home-user-my-proj') // underscore → '-'
    seedTranscript(correctKey, 'sess-underscore')

    const resolveForkAnchor = await freshResolveForkAnchor()
    const res = await resolveForkAnchor(
      'sess-underscore',
      CWD_WITH_UNDERSCORE,
      'msg_x',
      'claude',
      0
    )

    // Old derivation looked in '-home-user-my_proj' (underscore kept) → the file
    // is not there → 'transcript-not-found'. The correct one finds + resolves it.
    expect(res.reason).not.toBe('transcript-not-found')
    expect(res.anchorUuid).toBe('anchor-uuid')
  })

  it('still resolves for a plain cwd (no regression on simple paths)', async () => {
    const cwd = '/tmp/proj'
    seedTranscript(cwdToProjectKey(cwd), 'sess-plain')

    const resolveForkAnchor = await freshResolveForkAnchor()
    const res = await resolveForkAnchor('sess-plain', cwd, 'msg_x', 'claude', 0)
    expect(res.anchorUuid).toBe('anchor-uuid')
  })
})
