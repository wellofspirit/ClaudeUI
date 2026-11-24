import { describe, expect, it } from 'vitest'
import {
  buildCommitOf,
  buildId,
  comparisonVersion,
  parseBuildInfo,
  parseGitDescribe,
  type BuildInfo
} from '../build-info'

const git = {
  describe: 'v3.9.1-pre.13-5-ge4f1a2c',
  baseTag: 'v3.9.1-pre.13',
  ahead: 5,
  commit: 'e4f1a2c0123456789abcdef0123456789abcdef0',
  dirty: true,
  branch: 'feat/x'
}
const release: BuildInfo = {
  schema: 1,
  kind: 'release',
  version: '3.9.1-pre.14',
  channel: 'pre-release',
  git,
  builtAt: '2026-11-24T10:00:00.000Z'
}
const local: BuildInfo = { ...release, kind: 'local', sourcePath: '/src/ClaudeUI' }
delete local.channel

describe('parseGitDescribe', () => {
  it('parses a clean build ahead of a pre tag', () => {
    expect(parseGitDescribe('v3.9.1-pre.13-5-ge4f1a2c')).toEqual({
      baseTag: 'v3.9.1-pre.13',
      ahead: 5,
      shortCommit: 'e4f1a2c',
      dirty: false
    })
  })
  it('parses dirty and zero-ahead', () => {
    expect(parseGitDescribe('v3.9.1-pre.13-5-ge4f1a2c-dirty')?.dirty).toBe(true)
    expect(parseGitDescribe('v3.9.0-0-gabc1234\n')).toEqual({
      baseTag: 'v3.9.0',
      ahead: 0,
      shortCommit: 'abc1234',
      dirty: false
    })
  })
  it.each(['', 'garbage', 'v3.9.0', 'v3.9.0-g1234567', 'x3.9.0-1-gabc1234', 'v3.9.0-1-gXYZ'])(
    'rejects %j',
    (s) => expect(parseGitDescribe(s)).toBeNull()
  )
})

describe('parseBuildInfo', () => {
  it('accepts a release and a local stamp', () => {
    expect(parseBuildInfo(release)).toEqual(release)
    expect(parseBuildInfo(local)).toEqual(local)
  })
  it('accepts null git fields (no git at build time)', () => {
    const nogit = {
      ...release,
      git: { describe: null, baseTag: null, ahead: null, commit: null, dirty: null, branch: null }
    }
    expect(parseBuildInfo(nogit)).toEqual(nogit)
  })
  it('ignores unknown keys', () => {
    const parsed = parseBuildInfo({ ...release, extra: 1, git: { ...git, more: true } })
    expect(parsed).toEqual(release)
  })
  it.each([
    ['null', null],
    ['an array', []],
    ['missing schema', { ...release, schema: undefined }],
    ['schema 2', { ...release, schema: 2 }],
    ['kind dev', { ...release, kind: 'dev' }],
    ['numeric version', { ...release, version: 3 }],
    ['empty version', { ...release, version: '' }],
    ['bad channel', { ...release, channel: 'beta' }],
    ['missing git', { ...release, git: undefined }],
    ['string ahead', { ...release, git: { ...git, ahead: '5' } }],
    ['negative ahead', { ...release, git: { ...git, ahead: -1 } }],
    ['missing commit', { ...release, git: { ...git, commit: undefined } }],
    ['numeric sourcePath', { ...local, sourcePath: 4 }],
    ['missing builtAt', { ...release, builtAt: undefined }]
  ])('rejects %s', (_n, raw) => expect(parseBuildInfo(raw)).toBeNull())
})

describe('comparisonVersion', () => {
  it('release: the version', () => expect(comparisonVersion(release)).toBe('3.9.1-pre.14'))
  it('local: the base tag without v', () => expect(comparisonVersion(local)).toBe('3.9.1-pre.13'))
  it('local without a base tag: null', () =>
    expect(comparisonVersion({ ...local, git: { ...git, baseTag: null } })).toBeNull())
  it('dev: null', () => expect(comparisonVersion({ kind: 'dev' })).toBeNull())
})

describe('buildId', () => {
  it('changes with the commit and with builtAt', () => {
    const a = buildId(release)
    expect(a).toBe('e4f1a2c@2026-11-24T10:00:00.000Z')
    expect(buildId({ ...release, builtAt: '2026-11-25T00:00:00.000Z' })).not.toBe(a)
    expect(buildId({ ...release, git: { ...git, commit: 'aaaaaaa1' } })).not.toBe(a)
  })
  it('falls back to the version without a commit', () =>
    expect(buildId({ ...release, git: { ...git, commit: null } })).toBe(
      '3.9.1-pre.14@2026-11-24T10:00:00.000Z'
    ))
})

describe('buildCommitOf', () => {
  it('names the short commit a build id leads with, lower case', () => {
    expect(buildCommitOf('e4f1a2c@2026-11-24T00:00:00.000Z')).toBe('e4f1a2c')
    expect(buildCommitOf('E4F1A2C9D0@2026-11-24T00:00:00.000Z')).toBe('e4f1a2c')
  })

  it('names none for a build without git, or no id', () => {
    expect(buildCommitOf('3.9.0@2026-11-24T00:00:00.000Z')).toBeUndefined()
    expect(buildCommitOf(null)).toBeUndefined()
    expect(buildCommitOf(undefined)).toBeUndefined()
    expect(buildCommitOf('')).toBeUndefined()
  })
})
