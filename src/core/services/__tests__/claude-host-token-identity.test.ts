/**
 * @vitest-environment node
 *
 * The keeper's `read(dir)` carries the account row's recorded identity
 * (`accountUuid` / `organizationUuid`) for the spawn env's
 * `CLAUDE_CODE_ACCOUNT_UUID` / `CLAUDE_CODE_ORGANIZATION_UUID`. The credentials
 * file alone decides whether a token exists: a missing row or a failing lookup
 * gives nulls, never a refused spawn. Every token and uuid below is invented.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const getAccount = vi.hoisted(() => vi.fn())
vi.mock('../db', () => ({ getAccount }))
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { ClaudeHostTokenKeeper } from '../claude-host-token'
import { CREDENTIALS_FILE } from '../../auth/claude-oauth'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-token-identity-'))
  dir = join(root, 'account-1')
  await mkdir(dir)
  await writeFile(
    join(dir, CREDENTIALS_FILE),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'fake-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
        subscriptionType: 'team',
        rateLimitTier: null
      }
    }),
    'utf-8'
  )
  getAccount.mockReset()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ClaudeHostTokenKeeper.read identity', () => {
  it('copies the account row’s uuids, looked up by the dir’s account id', () => {
    getAccount.mockReturnValue({
      id: 'account-1',
      accountUuid: '00000000-0000-4000-8000-0000000000aa',
      organizationUuid: '00000000-0000-4000-8000-0000000000bb'
    })

    const cred = new ClaudeHostTokenKeeper().read(dir)

    expect(getAccount).toHaveBeenCalledWith('account-1')
    expect(cred).toMatchObject({
      accessToken: 'fake-access',
      accountUuid: '00000000-0000-4000-8000-0000000000aa',
      organizationUuid: '00000000-0000-4000-8000-0000000000bb'
    })
  })

  it('gives null uuids for a row not yet identified, or no row', () => {
    getAccount.mockReturnValueOnce({ id: 'account-1', accountUuid: null })
    expect(new ClaudeHostTokenKeeper().read(dir)).toMatchObject({
      accessToken: 'fake-access',
      accountUuid: null,
      organizationUuid: null
    })

    getAccount.mockReturnValueOnce(null)
    expect(new ClaudeHostTokenKeeper().read(dir)).toMatchObject({
      accountUuid: null,
      organizationUuid: null
    })
  })

  it('still hands out the credential when the lookup throws', () => {
    getAccount.mockImplementation(() => {
      throw new Error('no SQLite driver')
    })

    expect(new ClaudeHostTokenKeeper().read(dir)).toMatchObject({
      accessToken: 'fake-access',
      accountUuid: null,
      organizationUuid: null
    })
  })

  it('returns null with no credentials file, whatever the row says', async () => {
    getAccount.mockReturnValue({ accountUuid: 'x', organizationUuid: 'y' })
    await rm(join(dir, CREDENTIALS_FILE))

    expect(new ClaudeHostTokenKeeper().read(dir)).toBeNull()
  })
})
