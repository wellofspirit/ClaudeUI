/**
 * Layer 1 guards for the Codex config service (ADR-068 §6, Slice 5a).
 *
 * Everything asserted here is a consequence of what the REAL binary answered in
 * `src/integration/codex/codex-config-write.integration.test.ts` and
 * `docs/codex-spike.md` § "`config/batchWrite` probe" (0.154.0, Windows x64,
 * 2026-09-14):
 *
 *  (a) a `batchWrite` with `mergeStrategy: 'replace'` sets ONE key and leaves
 *      the rest of `config.toml` — comments included — untouched, answering a
 *      NEW user-layer version;
 *  (b) a stale `expectedVersion` is refused with the CAMELCASE tag
 *      `configVersionConflict` in `error.data.config_write_error_code`, and
 *      nothing is written;
 *  (c) `value: null` REMOVES the key — so Reset is a removal, not a
 *      write-the-default;
 *  (d) a dotted key path addresses a nested table and arrays round-trip.
 *
 * These tests pin the MAPPING onto those answers. The wire itself is pinned by
 * the integration file, which is the only place a real `config.toml` is touched.
 */
import { describe, expect, it, vi } from 'vitest'
import { CodexTransportError } from '../CodexAppServerClient'
import { readCodexConfig, writeCodexConfig } from '../codex-config'
import type { ConfigBatchWriteParams } from '../protocol/v2/ConfigBatchWriteParams'
import type { ConfigReadResponse } from '../protocol/v2/ConfigReadResponse'
import type { CodexConfigWriteResult } from '../../../shared/codex-types'

/** Narrow a write result to its success branch, failing the test otherwise. */
function ok(result: CodexConfigWriteResult): Extract<CodexConfigWriteResult, { status: 'ok' }> {
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error(`write did not succeed: ${result.status}`)
  return result
}

const USER_FILE = '/home/u/.codex/config.toml'

function layers(): ConfigReadResponse {
  return {
    config: { model: 'gpt-5', model_verbosity: 'high' },
    origins: {
      model_verbosity: { name: { type: 'user', file: USER_FILE, profile: null }, version: 'v7' }
    },
    layers: [
      {
        name: { type: 'packagedDefaults', file: '/opt/codex/defaults.toml' },
        version: 'd1',
        config: { model: 'gpt-5' },
        disabledReason: null
      },
      {
        name: { type: 'user', file: USER_FILE, profile: null },
        version: 'v7',
        config: { model_verbosity: 'high' },
        disabledReason: null
      },
      {
        // A profile-v2 layer is ALSO `type: 'user'`, at a HIGHER precedence, and
        // is not ours to write. Picking "the first user layer" would be wrong
        // the moment a user runs `--profile`.
        name: { type: 'user', file: USER_FILE, profile: 'work' },
        version: 'v7-work',
        config: { model_verbosity: 'low' },
        disabledReason: null
      }
    ]
  } as unknown as ConfigReadResponse
}

/** What `config/read` answers AFTER a write — the page's next state. */
function layersAfterWrite(): ConfigReadResponse {
  return {
    config: { model: 'gpt-5', model_verbosity: 'low' },
    origins: {},
    layers: [
      {
        name: { type: 'user', file: USER_FILE, profile: null },
        version: 'v8',
        config: { model_verbosity: 'low' },
        disabledReason: null
      }
    ]
  } as unknown as ConfigReadResponse
}

function fixture(
  options: {
    read?: () => Promise<ConfigReadResponse>
    write?: (params: ConfigBatchWriteParams) => Promise<unknown>
    /** What the write's own read-back answers. */
    afterWrite?: () => ConfigReadResponse
  } = {}
) {
  const writes: ConfigBatchWriteParams[] = []
  const dispose = vi.fn()
  const service = {
    readConfigLayers: vi.fn(options.read ?? (async () => layers())),
    batchWriteConfigAndRead: vi.fn(async (params: ConfigBatchWriteParams) => {
      writes.push(params)
      const write = (await (options.write?.(params) ??
        Promise.resolve({
          status: 'ok',
          version: 'v8',
          filePath: USER_FILE,
          overriddenMetadata: null
        }))) as never
      return { write, read: (options.afterWrite ?? layersAfterWrite)() } as never
    }),
    dispose
  }
  return {
    writes,
    dispose,
    service,
    deps: { service: () => service, available: () => true }
  }
}

describe('readCodexConfig', () => {
  it('reads the BASE user layer — not the profile layer — and reports version, file and profile', async () => {
    const { deps, service } = fixture()
    const snapshot = await readCodexConfig(deps)

    expect(service.readConfigLayers).toHaveBeenCalledOnce()
    expect(snapshot.version).toBe('v7')
    expect(snapshot.file).toBe(USER_FILE)
    // The base layer's own table is the "is this key set by the user?" oracle.
    expect(snapshot.user).toEqual({ model_verbosity: 'high' })
    // …and the profile layer is REPORTED, so the Managed group can say a
    // profile is overriding these rows, but never written.
    expect(snapshot.profile).toBe('work')
    expect(snapshot.effective.model).toBe('gpt-5')
    expect(snapshot.origins.model_verbosity).toEqual({ layer: 'user', version: 'v7' })
  })

  it('refuses a read with no writable base user layer instead of guessing one', async () => {
    const { deps } = fixture({
      read: async () =>
        ({
          config: {},
          origins: {},
          layers: [
            {
              name: { type: 'user', file: USER_FILE, profile: 'work' },
              version: 'v1',
              config: {},
              disabledReason: null
            }
          ]
        }) as unknown as ConfigReadResponse
    })
    await expect(readCodexConfig(deps)).rejects.toThrow('writable user config layer')
  })

  it('self-gates on the binary rather than spawning one that is not there', async () => {
    const { deps, service } = fixture()
    await expect(readCodexConfig({ ...deps, available: () => false })).rejects.toThrow(
      'not installed'
    )
    expect(service.readConfigLayers).not.toHaveBeenCalled()
  })
})

describe('writeCodexConfig', () => {
  it('sends ONE batchWrite with replace, reloadUserConfig and the expected version', async () => {
    const { deps, writes, service } = fixture()
    const result = await writeCodexConfig(
      [{ keyPath: 'model_verbosity', value: 'low' }],
      'v7',
      deps
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({
      edits: [{ keyPath: 'model_verbosity', value: 'low', mergeStrategy: 'replace' }],
      expectedVersion: 'v7',
      reloadUserConfig: true
    })
    // The read-back rides on the SAME operation, so the caller never issues a
    // second one — that is the whole reason the service method does both.
    expect(service.readConfigLayers).not.toHaveBeenCalled()
    const written = ok(result)
    expect(written.version).toBe('v8')
    expect(written.snapshot.user).toEqual({ model_verbosity: 'low' })
    expect(written.snapshot.version).toBe('v8')
    expect(written.snapshot.file).toBe(USER_FILE)
  })

  it('never carries an `ok` key — the preload/web `unwrap` treats that as the IPC envelope', async () => {
    // `unwrap` (preload/index.ts, web/api-adapter.ts) hands the renderer
    // `result.data` for ANY object with an `ok` key, so a `{ ok: true, … }`
    // result arrived as `undefined` and a `{ ok: false }` refusal was thrown as
    // a transport failure. Seen live on 2026-09-14; the discriminator is
    // `status` for that reason and this pins it on every branch.
    const outcomes = await Promise.all([
      writeCodexConfig([{ keyPath: 'model_verbosity', value: 'low' }], 'v7', fixture().deps),
      writeCodexConfig([], 'v7', fixture().deps),
      writeCodexConfig([{ keyPath: 'a', value: 1 }], 'v7', {
        ...fixture().deps,
        available: () => false
      }),
      writeCodexConfig(
        [{ keyPath: 'model_verbosity', value: 'low' }],
        'stale',
        fixture({
          write: async () => {
            throw new CodexTransportError('rpc-error--32600', false, 'x', 'configVersionConflict')
          }
        }).deps
      )
    ])
    for (const outcome of outcomes) {
      expect(outcome).not.toHaveProperty('ok')
      expect(typeof outcome.status).toBe('string')
    }
  })

  it('takes the version from the READ-BACK layer, not from the write response', async () => {
    // If the two ever disagree, the page must carry the token of the config it
    // is actually showing — otherwise its next write is stale against its own
    // rendered state.
    const { deps } = fixture({
      write: async () => ({
        status: 'ok',
        version: 'from-write-response',
        filePath: USER_FILE,
        overriddenMetadata: null
      })
    })
    const result = await writeCodexConfig(
      [{ keyPath: 'model_verbosity', value: 'low' }],
      'v7',
      deps
    )
    expect(ok(result).version).toBe('v8')
    expect(ok(result).snapshot.version).toBe('v8')
  })

  it('shapes a write-back snapshot with the SAME base-layer rule as a plain read', async () => {
    // A profile-v2 layer is also `type: 'user'`; picking it here would hand the
    // page a version it can never write to.
    const { deps } = fixture({
      afterWrite: () =>
        ({
          config: {},
          origins: {},
          layers: [
            {
              name: { type: 'user', file: USER_FILE, profile: null },
              version: 'v8',
              config: { service_tier: 'flex' },
              disabledReason: null
            },
            {
              name: { type: 'user', file: USER_FILE, profile: 'work' },
              version: 'v8-work',
              config: { service_tier: 'priority' },
              disabledReason: null
            }
          ]
        }) as unknown as ConfigReadResponse
    })
    const result = await writeCodexConfig([{ keyPath: 'service_tier', value: 'flex' }], 'v7', deps)
    expect(ok(result).snapshot.version).toBe('v8')
    expect(ok(result).snapshot.user).toEqual({ service_tier: 'flex' })
    expect(ok(result).snapshot.profile).toBe('work')
  })

  it('carries several edits — nested and array paths included — in the SAME write', async () => {
    const { deps, writes } = fixture()
    await writeCodexConfig(
      [
        { keyPath: 'sandbox_workspace_write.network_access', value: true },
        { keyPath: 'project_doc_fallback_filenames', value: ['CLAUDE.md'] }
      ],
      'v7',
      deps
    )
    // One write, one version token: two calls would make the second one stale
    // against the first's answer and fail for a reason the user never caused.
    expect(writes).toHaveLength(1)
    expect(writes[0].edits.map((edit) => edit.keyPath)).toEqual([
      'sandbox_workspace_write.network_access',
      'project_doc_fallback_filenames'
    ])
    expect(writes[0].edits[1].value).toEqual(['CLAUDE.md'])
  })

  it('sends `null` VERBATIM as the removal sentinel — this is what Reset does', async () => {
    const { deps, writes } = fixture()
    await writeCodexConfig([{ keyPath: 'model_verbosity', value: null }], 'v7', deps)
    // Probe (c): a null value deletes the key. There is no separate delete verb,
    // so anything that stripped or defaulted this null would silently turn Reset
    // into a no-op.
    expect(writes[0].edits[0]).toEqual({
      keyPath: 'model_verbosity',
      value: null,
      mergeStrategy: 'replace'
    })
  })

  it('maps the native camelCase version-conflict tag to a typed failure', async () => {
    const { deps } = fixture({
      write: async () => {
        throw new CodexTransportError(
          'rpc-error--32600',
          false,
          'Configuration was modified since last read. Fetch latest version and retry.',
          // Probe (b): camelCase on the wire, NOT the Rust variant spelling.
          'configVersionConflict'
        )
      }
    })
    expect(
      await writeCodexConfig([{ keyPath: 'model_verbosity', value: 'low' }], 'stale', deps)
    ).toEqual({ status: 'version-conflict' })
  })

  it('passes any other refusal through with the native message verbatim', async () => {
    const { deps } = fixture({
      write: async () => {
        throw new CodexTransportError(
          'rpc-error--32600',
          false,
          '`nonsense_key` is not a known configuration key',
          'configSchemaUnknownKey'
        )
      }
    })
    expect(await writeCodexConfig([{ keyPath: 'nonsense_key', value: 1 }], 'v7', deps)).toEqual({
      status: 'refused',
      message: '`nonsense_key` is not a known configuration key'
    })
  })

  it('reports a broken transport as unavailable rather than as a refusal', async () => {
    const { deps } = fixture({
      write: async () => {
        throw new CodexTransportError('binary-unavailable')
      }
    })
    expect(
      await writeCodexConfig([{ keyPath: 'model_verbosity', value: 'low' }], 'v7', deps)
    ).toEqual({ status: 'unavailable' })
  })

  it('never reaches the binary with an empty batch or without one installed', async () => {
    const { deps, service } = fixture()
    expect(await writeCodexConfig([], 'v7', deps)).toMatchObject({ status: 'refused' })
    expect(
      await writeCodexConfig([{ keyPath: 'a', value: 1 }], 'v7', {
        ...deps,
        available: () => false
      })
    ).toEqual({ status: 'unavailable' })
    expect(service.batchWriteConfigAndRead).not.toHaveBeenCalled()
  })
})
