// @vitest-environment node
/**
 * The opencode 2.x protocol generator (`scripts/generate-opencode-protocol.mjs`)
 * and its committed output (`src/core/opencode/protocol-v2/`). The full drift
 * check needs the upstream checkout (`bun run check-opencode-protocol`); what
 * runs everywhere is the emitter itself, and that the committed files are the
 * ones provenance names.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  build,
  componentNames,
  driftReport,
  locateSource,
  PIN,
  pinnedReader,
  renderProtocol,
  schemaToTs
} from '../../../../scripts/generate-opencode-protocol.mjs'
import provenance from '../protocol-v2/provenance.json'
import reviewed from '../protocol-v2/events.reviewed.json'
import { EVENT_DURABILITY, eventSessionID, isOpencodeEvent } from '../protocol-v2/events'

const DIR = join(__dirname, '..', 'protocol-v2')
const read = (name: string) => readFileSync(join(DIR, name), 'utf8')
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('committed output', () => {
  it('is exactly the file provenance names (no hand edits, no partial regeneration)', () => {
    expect(sha256(read('openapi.ts'))).toBe(provenance.files['openapi.ts'])
  })

  it('was generated, and its event closure reviewed, at the script’s pin', () => {
    expect(provenance).toMatchObject({ version: PIN.version, tag: PIN.tag, commit: PIN.commit })
    expect(reviewed).toMatchObject({ version: PIN.version, commit: PIN.commit })
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
    const { generated, provenance: text } = build(pinnedReader(source!))
    expect(generated).toBe(read('openapi.ts'))
    expect(text).toBe(read('provenance.json'))
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
