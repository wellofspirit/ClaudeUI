/** @vitest-environment node */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EngineId } from '../../../shared/types'

const uiConfigMocks = vi.hoisted(() => ({
  loadVendorConfig: vi.fn(() => ({}))
}))
vi.mock('../../services/ui-config', () => uiConfigMocks)

const proxyMocks = vi.hoisted(() => ({
  setProxyEnv: vi.fn(),
  setProxyAllSubprocesses: vi.fn()
}))
vi.mock('../../sdk/proxy', () => proxyMocks)

const endpointMocks = vi.hoisted(() => ({
  setEndpointEnv: vi.fn()
}))
vi.mock('../../sdk/endpoint-env', () => endpointMocks)

const modelEnvMocks = vi.hoisted(() => ({
  setModelEnv: vi.fn()
}))
vi.mock('../../sdk/model-env', () => modelEnvMocks)

const socksBridgeMocks = vi.hoisted(() => ({
  startSocksBridge: vi.fn(async () => 1080),
  stopSocksBridge: vi.fn(async () => {})
}))
vi.mock('../../services/socks-bridge', () => socksBridgeMocks)

vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), applyFilter: vi.fn() }
}))

const modelDiscoveryMocks = vi.hoisted(() => ({
  resolveOpencodeSpawnModel: vi.fn(async (m?: string) => m ?? 'opencode/zen-free')
}))
vi.mock('../../opencode/model-discovery', () => modelDiscoveryMocks)

const piModelDiscoveryMocks = vi.hoisted(() => ({
  resolvePiSpawnModel: vi.fn(async (m?: string) => m)
}))
vi.mock('../../pi/model-discovery', () => piModelDiscoveryMocks)

import { claudeSpawnPrep } from '../claude-spawn-prep'
import { opencodeSpawnPrep } from '../../opencode/opencode-spawn-prep'
import { piSpawnPrep } from '../../pi/pi-spawn-prep'
import { spawnPrepRegistry } from '../SpawnPrepRegistry'

describe('claudeSpawnPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('derives vendor from the model, applies proxy/endpoint/model env, and passes the model through', async () => {
    uiConfigMocks.loadVendorConfig.mockReturnValue({
      endpoint: { enabled: true, baseUrl: 'https://ep.example', authToken: 't' },
      modelOverride: { enabled: true, model: 'foo' }
    })
    const engineConfig = {
      proxy: {
        enabled: true,
        hostname: 'h',
        port: 8080,
        type: 'http' as const,
        username: '',
        password: ''
      }
    }

    const result = await claudeSpawnPrep('claude-sonnet-4-6', engineConfig)

    expect(uiConfigMocks.loadVendorConfig).toHaveBeenCalledWith('anthropic')
    expect(endpointMocks.setEndpointEnv).toHaveBeenCalledWith({
      ANTHROPIC_BASE_URL: 'https://ep.example',
      ANTHROPIC_AUTH_TOKEN: 't'
    })
    expect(modelEnvMocks.setModelEnv).toHaveBeenCalledWith({
      ANTHROPIC_MODEL: 'foo',
      ANTHROPIC_DEFAULT_SONNET_MODEL: '',
      ANTHROPIC_DEFAULT_OPUS_MODEL: '',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: ''
    })
    expect(proxyMocks.setProxyEnv).toHaveBeenCalledWith({
      HTTP_PROXY: 'http://h:8080',
      HTTPS_PROXY: 'http://h:8080',
      ALL_PROXY: 'http://h:8080'
    })
    expect(result).toEqual({ resolvedModel: 'claude-sonnet-4-6' })
  })

  it('clears endpoint/model env with null when configs are empty, and passes the model through unchanged', async () => {
    uiConfigMocks.loadVendorConfig.mockReturnValue({})

    const result = await claudeSpawnPrep('claude-opus-4-8', {})

    expect(endpointMocks.setEndpointEnv).toHaveBeenCalledWith(null)
    expect(modelEnvMocks.setModelEnv).toHaveBeenCalledWith(null)
    expect(result).toEqual({ resolvedModel: 'claude-opus-4-8' })
  })
})

describe('opencodeSpawnPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to resolveOpencodeSpawnModel and returns its result', async () => {
    modelDiscoveryMocks.resolveOpencodeSpawnModel.mockResolvedValueOnce('opencode/resolved-model')

    const result = await opencodeSpawnPrep('opencode/some-model', {})

    expect(modelDiscoveryMocks.resolveOpencodeSpawnModel).toHaveBeenCalledWith(
      'opencode/some-model'
    )
    expect(result).toEqual({ resolvedModel: 'opencode/resolved-model' })
  })
})

describe('piSpawnPrep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates to resolvePiSpawnModel and returns its result (cross-engine leak guard)', async () => {
    // The observed real-app bug: an opencode "openai/gpt-5.5" remembered on
    // the session slot must be resolved to a valid pi model before set_model.
    piModelDiscoveryMocks.resolvePiSpawnModel.mockResolvedValueOnce('openai-codex/gpt-5.6-luna')

    const result = await piSpawnPrep('openai/gpt-5.5', {})

    expect(piModelDiscoveryMocks.resolvePiSpawnModel).toHaveBeenCalledWith('openai/gpt-5.5')
    expect(result).toEqual({ resolvedModel: 'openai-codex/gpt-5.6-luna' })
  })

  it('returns undefined when the resolver yields none (PiSession then skips set_model)', async () => {
    piModelDiscoveryMocks.resolvePiSpawnModel.mockResolvedValueOnce(undefined)

    const result = await piSpawnPrep('anything/x', {})

    expect(result).toEqual({ resolvedModel: undefined })
  })
})

describe('spawnPrepRegistry', () => {
  it('throws when requiring an unregistered engine id', () => {
    expect(() => spawnPrepRegistry.require('gemini' as unknown as EngineId)).toThrow(
      /No spawn-prep registered for engine "gemini"/
    )
  })
})
