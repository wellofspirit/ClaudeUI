/**
 * @vitest-environment node
 *
 * Regression test for the opencode model label order (the picker showed the
 * provider as the PRIMARY and the model name as the SUB — inverted).
 *
 * The picker convention is `description = "<primary> · <sub>"`: InputBox derives
 * shortName = description.split('·')[0] (the primary), and InlinePickers renders
 * description.split('·')[1] as the muted sub-label. opencode descriptions must
 * therefore be "<modelName> · <providerName>" so an OpenCode Zen model reads
 * "MiMo V2.5 Free" (primary) / "OpenCode Zen" (sub), matching Claude's
 * "<model> · <hint>" order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAcquire, mockRelease, MockOpencodeClient } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))

// Hermetic: do NOT read the developer's real ~/.claude/ui/engines/opencode.json —
// a machine-local modelAllowlist would filter the mocked catalog and break the
// label assertions below.
vi.mock('../../services/ui-config', () => ({
  loadEngineConfig: () => ({})
}))

import { discoverOpencodeModels, invalidateOpencodeModelCache } from '../model-discovery'

const PROVIDERS = {
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      source: 'env' as const,
      env: [],
      options: {},
      models: {
        'mimo-v2.5': {
          id: 'mimo-v2.5',
          providerID: 'opencode',
          api: { id: '', url: '', npm: '' },
          name: 'MiMo V2.5 Free',
          family: 'mimo',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          }
        },
        // A model with no `name` falls back to the model id for the primary.
        'no-name': {
          id: 'no-name',
          providerID: 'opencode',
          api: { id: '', url: '', npm: '' },
          name: '',
          family: 'x',
          capabilities: {
            temperature: true,
            reasoning: false,
            attachment: false,
            toolcall: true,
            input: { text: true, audio: false, image: false, video: false, pdf: false },
            output: { text: true, audio: false, image: false, video: false, pdf: false }
          }
        }
      }
    }
  ]
}

function setupMocks(): void {
  mockAcquire.mockReset()
  mockRelease.mockReset()
  MockOpencodeClient.mockReset()
  mockAcquire.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'Basic test' })
  mockRelease.mockReturnValue(undefined)
  MockOpencodeClient.mockImplementation(function () {
    return { getConfigProviders: vi.fn().mockResolvedValue(PROVIDERS) }
  })
  invalidateOpencodeModelCache()
}

describe('model-discovery — label order (model primary, provider sub)', () => {
  beforeEach(setupMocks)

  it('description is "<modelName> · <providerName>" (not inverted)', async () => {
    const groups = await discoverOpencodeModels()
    const model = groups
      .flatMap((g) => g.models)
      .find((m) => m.value === 'opencode/mimo-v2.5')!
    expect(model).toBeDefined()
    // The primary (split[0]) must be the model name; the sub (split[1]) the provider.
    expect(model.description.split('·')[0].trim()).toBe('MiMo V2.5 Free')
    expect(model.description.split('·')[1].trim()).toBe('OpenCode Zen')
    // displayName stays the model name (used by the settings dropdowns directly).
    expect(model.displayName).toBe('MiMo V2.5 Free')
  })

  it('falls back to the model id as the primary when name is empty', async () => {
    const groups = await discoverOpencodeModels()
    const model = groups.flatMap((g) => g.models).find((m) => m.value === 'opencode/no-name')!
    expect(model.description.split('·')[0].trim()).toBe('no-name')
    expect(model.description.split('·')[1].trim()).toBe('OpenCode Zen')
  })
})
