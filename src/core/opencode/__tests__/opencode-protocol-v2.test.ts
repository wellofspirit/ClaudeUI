// @vitest-environment node
/**
 * The opencode 2.x protocol generator (`scripts/generate-opencode-protocol.mjs`)
 * and its committed output (`src/core/opencode/protocol-v2/`). The full drift
 * check needs the upstream checkout (`bun run check-opencode-protocol`); what
 * runs everywhere is the emitter itself, and that the committed files are the
 * ones provenance names.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  build,
  componentNames,
  driftReport,
  locateSource,
  PIN,
  sourceCandidates,
  pinnedReader,
  renderConfigSchema,
  renderProtocol,
  schemaToTs
} from '../../../../scripts/generate-opencode-protocol.mjs'
import { harnessManifest } from '../../harness/manifests'
import provenance from '../protocol-v2/provenance.json'
import configSchema from '../../../shared/opencode-config-schema.json'
import reviewed from '../protocol-v2/events.reviewed.json'
import { EVENT_DURABILITY, eventSessionID, isOpencodeEvent } from '../protocol-v2/events'

const DIR = join(__dirname, '..', 'protocol-v2')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('committed output', () => {
  it('is exactly the file provenance names (no hand edits, no partial regeneration)', () => {
    expect(sha256(read('openapi.ts'))).toBe(provenance.files['openapi.ts'])
    const schemaText = readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'opencode-config-schema.json'),
      'utf8'
    )
    expect(sha256(schemaText)).toBe(provenance.files['src/shared/opencode-config-schema.json'])
  })

  it('ships the raw editor schema rooted at Config.InfoEncoded, every $ref resolvable', () => {
    expect(configSchema.$ref).toBe('#/$defs/Config.InfoEncoded')
    const defs = configSchema.$defs as Record<string, unknown>
    const refs = JSON.stringify(configSchema).match(/"\$ref":"[^"]+"/g) ?? []
    for (const ref of refs) {
      const target = /#\/\$defs\/([^"]+)/.exec(ref)?.[1]
      expect(target && target in defs, ref).toBe(true)
    }
    // 2.x keys only: none of the 1.x top-level keys the writers stopped emitting.
    const keys = Object.keys(
      (defs['Config.InfoEncoded'] as { properties: Record<string, unknown> }).properties
    )
    expect(keys).toEqual(expect.arrayContaining(['agents', 'providers', 'permissions', 'plugins']))
    for (const legacy of ['agent', 'provider', 'permission', 'small_model', 'disabled_providers'])
      expect(keys).not.toContain(legacy)
  })

  it('was generated, and its event closure reviewed, at the script’s pin', () => {
    expect(provenance).toMatchObject({ version: PIN.version, tag: PIN.tag, commit: PIN.commit })
    expect(reviewed).toMatchObject({ version: PIN.version, commit: PIN.commit })
  })

  it('describes the opencode the harness manifest installs (one pin, ADR-097 §1)', () => {
    const { tested } = harnessManifest('opencode')
    expect(PIN).toMatchObject({ version: tested, tag: `v${tested}` })
    expect(provenance.version).toBe(tested)
    expect(reviewed.version).toBe(tested)
  })

  // Runs where the upstream checkout exists (developer boxes), skips in CI.
  const source = (() => {
    try {
      const dir = locateSource()
      pinnedReader(dir)
      return dir
    } catch {
      return null
    }
  })()
  it.skipIf(!source)('regenerates byte-identically from the pinned checkout', () => {
    const { generated, provenance: text, configSchema: schema } = build(pinnedReader(source!))
    expect(generated).toBe(read('openapi.ts'))
    expect(text).toBe(read('provenance.json'))
    expect(JSON.parse(schema)).toEqual(configSchema)
  })
})

describe('locating the upstream checkout', () => {
  it('tries the env override, then vendor/opencode-src before the pre-S10 vendor/opencode-v2-src', () => {
    const repo = mkdtempSync(join(tmpdir(), 'oc-src-')) // not a git checkout: no main-checkout candidates
    try {
      expect(sourceCandidates(repo, { OPENCODE_SRC: '/x/oc', OPENCODE_V2_SRC: '/x/oc2' })).toEqual([
        resolve('/x/oc'),
        resolve('/x/oc2'),
        join(repo, 'vendor', 'opencode-src'),
        join(repo, 'vendor', 'opencode-v2-src')
      ])
      expect(sourceCandidates(repo, {})).toEqual([
        join(repo, 'vendor', 'opencode-src'),
        join(repo, 'vendor', 'opencode-v2-src')
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  const candidates = ['/r/vendor/opencode-src', '/r/vendor/opencode-v2-src']
  const pick = (checkouts: string[], pinned: string[]) =>
    locateSource({
      candidates,
      isCheckout: (dir: string) => checkouts.includes(dir),
      holdsPin: (dir: string) => pinned.includes(dir)
    })

  it('prefers vendor/opencode-src when it holds the pin', () => {
    expect(pick(candidates, candidates)).toBe(candidates[0])
  })

  it('falls back to vendor/opencode-v2-src when opencode-src lacks the pin or is missing', () => {
    expect(pick(candidates, [candidates[1]])).toBe(candidates[1])
    expect(pick([candidates[1]], [candidates[1]])).toBe(candidates[1])
  })

  it('with no candidate holding the pin, the first checkout (pinnedReader then says why)', () => {
    expect(pick(candidates, [])).toBe(candidates[0])
  })

  it('throws with what it tried when there is no checkout at all', () => {
    expect(() => pick([], [])).toThrow(/No opencode source checkout.*opencode-v2-src/)
  })
})

describe('renderConfigSchema', () => {
  const pin = { tag: 'vX', commit: 'c', specSha256: 's' }
  it('closes over reachable components only, with refs rebased onto $defs', () => {
    const spec = {
      components: {
        schemas: {
          'Config.InfoEncoded': {
            type: 'object',
            properties: { a: { $ref: '#/components/schemas/A' } }
          },
          A: { anyOf: [{ $ref: '#/components/schemas/B' }, { type: 'null' }] },
          B: { type: 'string' },
          Unused: { type: 'number' }
        }
      }
    }
    const doc = JSON.parse(renderConfigSchema(spec, pin))
    expect(Object.keys(doc.$defs)).toEqual(['A', 'B', 'Config.InfoEncoded'])
    expect(doc.$defs.A.anyOf[0]).toEqual({ $ref: '#/$defs/B' })
    expect(renderConfigSchema(spec, pin)).toBe(renderConfigSchema(spec, pin))
  })

  it('fails closed on a ref it cannot rebase', () => {
    const spec = {
      components: { schemas: { 'Config.InfoEncoded': { $ref: 'https://x/y.json' } } }
    }
    expect(() => renderConfigSchema(spec, pin)).toThrow('unsupported $ref')
  })
})

describe('schemaToTs', () => {
  it('fails closed on a keyword it does not understand', () => {
    expect(() => schemaToTs({ type: 'string', if: { const: 'x' } }, '#/x')).toThrow(
      'Unsupported schema keyword "if" at #/x'
    )
    expect(() => schemaToTs({ $ref: '#/definitions/Foo' })).toThrow('Unsupported $ref')
    expect(() =>
      schemaToTs({ type: 'object', properties: {}, anyOf: [{ type: 'string' }] }, '#/u')
    ).toThrow('anyOf with sibling structure at #/u')
  })

  it('ignores annotations and maps the constructs the spec uses', () => {
    expect(schemaToTs({ type: 'string', pattern: '^ses', description: 'x' })).toBe('string')
    expect(schemaToTs({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null')
    expect(schemaToTs({ anyOf: [{}, { type: 'null' }] })).toBe('unknown')
    expect(schemaToTs({ type: 'boolean', enum: [false] })).toBe('false')
    expect(schemaToTs({ type: 'string', enum: ["it's", 'b'] })).toBe("'it\\'s' | 'b'")
    expect(schemaToTs({ $ref: '#/components/schemas/Form.Answer_1' })).toBe('Form_Answer_1')
    expect(
      schemaToTs({
        type: 'array',
        prefixItems: [{ $ref: '#/components/schemas/A' }],
        items: { $ref: '#/components/schemas/A' }
      })
    ).toBe('readonly [A, ...A[]]')
    expect(schemaToTs({ type: 'array', items: { type: 'integer' } })).toBe('ReadonlyArray<number>')
  })

  it('renders objects: required, quoted keys, closed, open and indexed', () => {
    expect(
      schemaToTs({
        type: 'object',
        properties: { a: { type: 'string' }, 'b-c': { type: 'number' } },
        required: ['a'],
        additionalProperties: false
      })
    ).toBe("{\n  readonly a: string\n  readonly 'b-c'?: number\n}")
    expect(schemaToTs({ type: 'object', additionalProperties: false })).toBe(
      'Record<string, never>'
    )
    expect(schemaToTs({ type: 'object' })).toBe('{ readonly [key: string]: unknown }')
    expect(
      schemaToTs({
        type: 'object',
        patternProperties: { '^ses': { $ref: '#/components/schemas/S' } }
      })
    ).toBe('{ readonly [key: string]: S }')
    expect(
      schemaToTs({
        type: 'object',
        properties: { a: { type: 'string' } },
        allOf: [{ type: 'object', additionalProperties: { type: 'number' } }]
      })
    ).toBe('{\n  readonly a?: string\n} & { readonly [key: string]: number }')
  })

  it('parenthesises unions inside intersections', () => {
    expect(
      schemaToTs({
        allOf: [
          { anyOf: [{ type: 'string' }, { type: 'number' }] },
          { $ref: '#/components/schemas/B' }
        ]
      })
    ).toBe('(string | number) & B')
  })
})

describe('renderProtocol', () => {
  const spec = {
    info: { title: 't', version: '0' },
    components: {
      schemas: {
        'Z.Item': { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        'A.Error': { type: 'object', properties: { _tag: { type: 'string', enum: ['E'] } } }
      }
    },
    paths: {
      '/api/z/{id}': {
        delete: {
          operationId: 'z.remove',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '204': { description: 'ok' },
            '404': {
              content: {
                'application/json': {
                  schema: {
                    anyOf: [
                      { $ref: '#/components/schemas/A.Error' },
                      { $ref: '#/components/schemas/A.Error' }
                    ]
                  }
                }
              }
            }
          }
        },
        get: {
          operationId: 'a.get',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { anyOf: [{ type: 'string' }, { type: 'null' }] }
            }
          ],
          responses: {
            '200': {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Z.Item' } } }
            }
          }
        }
      }
    }
  }
  const meta = { tag: 'vX', commit: 'c0ffee', specSha256: 'abc' }

  it('is deterministic, sorted, and maps params, 204 and errors', () => {
    const text = renderProtocol(spec, meta)
    expect(renderProtocol(JSON.parse(JSON.stringify(spec)), meta)).toBe(text)
    expect(text.indexOf('export type A_Error')).toBeLessThan(text.indexOf('export type Z_Item'))
    expect(text.indexOf("  'a.get': {")).toBeLessThan(text.indexOf("  'z.remove': {"))
    expect(text).toContain('    readonly query: {\n      readonly limit?: string\n    }')
    expect(text).toContain("    readonly responseKind: 'empty'\n    readonly response: void")
    expect(text).toContain('    readonly errors: A_Error\n')
    expect(text).toContain(
      "  'z.remove': { method: 'DELETE', path: '/api/z/{id}', bodyKind: 'none', responseKind: 'empty' },"
    )
  })

  it('rejects names that collide once sanitised', () => {
    expect(() => componentNames({ components: { schemas: { 'A.B': {}, A_B: {} } } })).toThrow(
      'collision'
    )
  })

  it('reports drift by declaration', () => {
    const before = renderProtocol(spec, meta)
    const schemas: Record<string, unknown> = {
      ...spec.components.schemas,
      'Z.Item': { type: 'object', properties: { id: { type: 'number' } } },
      'N.New': { type: 'string' }
    }
    const changed = { ...spec, components: { schemas } }
    // `a.get` names Z_Item by reference, so only the type itself is reported.
    expect(driftReport(before, renderProtocol(changed, meta))).toEqual([
      '  + type N_New',
      '  ~ type Z_Item'
    ])
  })
})

describe('curated events', () => {
  it('recognises curated types only and finds the session of each shape', () => {
    expect(isOpencodeEvent({ type: 'session.text.delta' })).toBe(true)
    expect(isOpencodeEvent({ type: 'worktree.resolved' })).toBe(false)
    expect(isOpencodeEvent({ type: 'toString' })).toBe(false)
    expect(Object.values(EVENT_DURABILITY).every((d) => d === 'durable' || d === 'ephemeral')).toBe(
      true
    )
    expect(
      eventSessionID({
        id: 'evt_1',
        type: 'form.created',
        created: 1,
        data: { form: { id: 'frm_1', sessionID: 'ses_1', title: 'q', fields: [] as never } }
      })
    ).toBe('ses_1')
    expect(
      eventSessionID({
        id: 'evt_2',
        type: 'credential.switched',
        created: 1,
        data: { integrationID: 'openai', credentialID: null }
      })
    ).toBeUndefined()
  })
})
