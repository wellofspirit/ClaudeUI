import { describe, expect, it } from 'vitest'
import { parseSpawnRequest, spawnRequestFromLegacyArgs } from '../spawn-request'

describe('spawnRequestFromLegacyArgs (the 11-argument shape of a client from before the request object)', () => {
  it('maps the full argument list, in the old order, to one request', () => {
    expect(
      spawnRequestFromLegacyArgs(
        '/r/repo',
        'high',
        'resume-1',
        'plan',
        'sonnet',
        'adaptive',
        'anchor-1',
        false,
        'pi',
        { effort: 'high', thinkingMode: null }
      )
    ).toEqual({
      cwd: '/r/repo',
      engineId: 'pi',
      config: { effort: 'high', permissionMode: 'plan', model: 'sonnet', thinkingMode: 'adaptive' },
      resume: { sessionId: 'resume-1', at: 'anchor-1', fork: false },
      announce: { effort: 'high', thinkingMode: null }
    })
  })

  it('maps a call with only cwd to a bare request', () => {
    expect(spawnRequestFromLegacyArgs('/r/repo')).toEqual({ cwd: '/r/repo' })
  })

  it('treats null in every optional slot as absent (a WS client cannot send a hole)', () => {
    expect(
      spawnRequestFromLegacyArgs('/r/repo', null, null, null, null, null, null, null, null, null)
    ).toEqual({ cwd: '/r/repo' })
  })

  it('maps a fork call: anchor and true', () => {
    expect(
      spawnRequestFromLegacyArgs(
        '/r/repo',
        'low',
        'source-1',
        'default',
        'sonnet',
        undefined,
        'uuid-9',
        true,
        'claude'
      )
    ).toEqual({
      cwd: '/r/repo',
      engineId: 'claude',
      config: { effort: 'low', permissionMode: 'default', model: 'sonnet' },
      resume: { sessionId: 'source-1', at: 'uuid-9', fork: true }
    })
  })
})

describe('parseSpawnRequest (the wire arguments after the routing id)', () => {
  const request = {
    cwd: '/r/repo',
    engineId: 'opencode',
    config: { effort: 'high', permissionMode: 'plan', model: 'a/b', thinkingMode: 'adaptive' },
    resume: { sessionId: 'resume-1', at: 'anchor-1', fork: true },
    announce: { effort: null, thinkingMode: 'adaptive' }
  }

  it('produces the same request from the legacy list as from the object, for the same values', () => {
    const legacy = parseSpawnRequest([
      '/r/repo',
      'high',
      'resume-1',
      'plan',
      'a/b',
      'adaptive',
      'anchor-1',
      true,
      'opencode',
      { effort: null, thinkingMode: 'adaptive' }
    ])
    expect(legacy).toEqual(parseSpawnRequest([request]))
    expect(legacy).toEqual(request)
  })

  it('treats a legacy list cut short by the caller like null slots', () => {
    expect(parseSpawnRequest(['/r/repo', 'high'])).toEqual({
      cwd: '/r/repo',
      config: { effort: 'high' }
    })
  })

  it('ignores unknown keys and a config, resume or announce that is not an object', () => {
    expect(
      parseSpawnRequest([
        { cwd: '/r', config: 'x', resume: ['a'], announce: 3, extra: { sandboxConfig: {} } }
      ])
    ).toEqual({ cwd: '/r' })
  })

  // The config is spread whole into the engine's spawn options: what a client can put there is
  // the config fields, with values of the right kind, and nothing else.
  it('lets only config fields of the right kind through, and nothing a client invents', () => {
    expect(
      parseSpawnRequest([
        {
          cwd: '/r',
          config: {
            model: 'sonnet',
            effort: 7,
            thinkingMode: null,
            permissionMode: { mode: 'plan' },
            reasoningVariant: null,
            sandboxConfig: { enabled: false },
            resumeSessionId: 'other'
          },
          resume: { sessionId: 's', at: 5, fork: 'yes', extra: 1 },
          announce: { effort: null, thinkingMode: 3, extra: 1 }
        }
      ])
    ).toEqual({
      cwd: '/r',
      config: { model: 'sonnet', reasoningVariant: null },
      resume: { sessionId: 's' },
      announce: { effort: null }
    })
  })

  it('refuses an object without a string cwd, and a non-request', () => {
    expect(() => parseSpawnRequest([{ engineId: 'claude' }])).toThrow(/string cwd/)
    expect(() => parseSpawnRequest([null])).toThrow(/string cwd/)
    expect(() => parseSpawnRequest([])).toThrow(/string cwd/)
  })
})
