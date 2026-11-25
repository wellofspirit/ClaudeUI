/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import { parseBuildInfo } from '../../shared/build-info'

const { buildInfoFor }: any = await import('../../../scripts/stamp-build-info.mjs')
const now = new Date('2026-11-24T10:00:00.000Z')
const fakeGit = (answers: Record<string, string | null>) => (args: string[]) =>
  answers[args[0]] ?? null

describe('buildInfoFor', () => {
  const full = fakeGit({ describe: 'v3.9.1-pre.13-5-ge4f1a2c-dirty', 'rev-parse': 'deadbeef' })

  it('local by default, with sourcePath and parsed git fields', () => {
    const info = buildInfoFor({ env: {}, git: full, now, version: '3.9.1' })
    expect(parseBuildInfo(info)).toEqual(info)
    expect(info).toMatchObject({
      kind: 'local',
      git: { baseTag: 'v3.9.1-pre.13', ahead: 5, dirty: true, commit: 'deadbeef' }
    })
    expect(info.sourcePath).toBeTruthy()
    expect(info.channel).toBeUndefined()
  })

  it('release carries the channel and never a sourcePath', () => {
    const info = buildInfoFor({
      env: { CLAUDEUI_BUILD_KIND: 'release', CLAUDEUI_RELEASE_CHANNEL: 'pre-release' },
      git: full,
      now,
      version: '3.9.1-pre.14'
    })
    expect(info.kind).toBe('release')
    expect(info.channel).toBe('pre-release')
    expect('sourcePath' in info).toBe(false)
    expect(Object.keys(info)).toEqual(['schema', 'kind', 'version', 'channel', 'git', 'builtAt'])
  })

  it('a release without a valid channel fails loudly', () => {
    for (const ch of [undefined, '', 'beta'])
      expect(() =>
        buildInfoFor({
          env: { CLAUDEUI_BUILD_KIND: 'release', CLAUDEUI_RELEASE_CHANNEL: ch },
          git: full,
          now,
          version: '1.0.0'
        })
      ).toThrow(/CLAUDEUI_RELEASE_CHANNEL/)
  })

  it('survives git failing; a release falls back to GITHUB_SHA', () => {
    const none = () => null
    const local = buildInfoFor({ env: {}, git: none, now, version: '1.0.0' })
    expect(local.git).toEqual({
      describe: null,
      baseTag: null,
      ahead: null,
      commit: null,
      dirty: null,
      branch: null
    })
    const rel = buildInfoFor({
      env: {
        CLAUDEUI_BUILD_KIND: 'release',
        CLAUDEUI_RELEASE_CHANNEL: 'stable',
        GITHUB_SHA: 'cafebabe'
      },
      git: none,
      now,
      version: '1.0.0'
    })
    expect(rel.git.commit).toBe('cafebabe')
    expect(parseBuildInfo(rel)).not.toBeNull()
  })
})
