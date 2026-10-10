// @vitest-environment node
/**
 * The opencode 2.x protocol generator (`scripts/generate-opencode-protocol.mjs`)
 * and its committed output (`src/core/opencode/protocol-v2/`). The generator's
 * input is the spec the pinned binary SERVES; the full drift check needs that
 * binary (`bun run check-opencode-protocol`, or the gated test below when the
 * managed store has it) and the upstream checkout for the event sources. What
 * runs everywhere is the emitter, the host-neutrality and binary checks, and
 * that the committed files are the ones provenance names.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireServedSpec,
  assertHostNeutral,
  build,
  canonicalize,
  componentNames,
  declarations,
  driftReport,
  hostMarkers,
  locateSource,
  PIN,
  provenanceProblems,
  servedBinaryPath,
  servedPlatform,
  sourceCandidates,
  renderConfigSchema,
  renderProtocol,
  schemaToTs,
  specDifferenceReport,
  specDifferences,
  specDigest,
  verifyServedBinary
} from '../../../../scripts/generate-opencode-protocol.mjs'
import { harnessManifest } from '../../harness/manifests'
import { installDir } from '../../harness/store'
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

  it('records the served spec and the reviewed binary that served it', () => {
    expect(provenance.spec).toBe('GET /openapi.json')
    expect(provenance.servedSpecSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(provenance).not.toHaveProperty('specSha256')
    const reviewedBinary = harnessManifest('opencode').platforms[provenance.platform]?.binarySha256
    expect(reviewedBinary).toBeTruthy()
    expect(provenance.binarySha256).toBe(reviewedBinary)
    expect(read('openapi.ts')).toContain(`Served spec sha256 ${provenance.servedSpecSha256}`)
    expect(JSON.stringify(configSchema.$comment)).toContain(provenance.servedSpecSha256)
  })

  it('describes the opencode the harness manifest installs (one pin, ADR-097 §1)', () => {
    const { tested } = harnessManifest('opencode')
    expect(PIN).toMatchObject({ version: tested, tag: `v${tested}` })
    expect(provenance.version).toBe(tested)
    expect(reviewed.version).toBe(tested)
  })

  // Runs where the REAL managed store holds the tested binary (the setup files
  // move HOME, so `CLAUDEUI_TEST_HARNESS_STORE` names it: developer boxes, CI's
  // setup-workspace) and skips elsewhere. `acquireServedSpec` itself fails closed on
  // a binary that is not the reviewed one, so a wrong binary FAILS rather than skips.
  const storeRoot = process.env.CLAUDEUI_TEST_HARNESS_STORE
  const storedBinary = storeRoot
    ? join(
        storeRoot,
        'opencode',
        PIN.version,
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      )
    : null
  it.skipIf(!storedBinary || !existsSync(storedBinary))(
    'regenerates byte-identically from the spec the pinned binary serves',
    async () => {
      const served = await acquireServedSpec({ env: { OPENCODE_V2_BIN: storedBinary! } })
      const { generated, provenanceData, configSchema: schema } = build(served)
      expect(generated).toBe(read('openapi.ts'))
      expect(JSON.parse(schema)).toEqual(configSchema)
      expect(provenanceProblems(read('provenance.json'), provenanceData)).toEqual([])
    },
    90_000
  )
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
    expect(text).toContain('Source: the /openapi.json served by opencode vX (c0ffee)')
    expect(text).not.toContain('packages/protocol/openapi.json')
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

describe('the served spec as input', () => {
  it('digests the canonical form: key order never matters, array order does', () => {
    const a = { b: { y: 1, x: [1, 2] }, a: 'z' }
    const b = { a: 'z', b: { x: [1, 2], y: 1 } }
    expect(specDigest(a)).toBe(specDigest(b))
    expect(specDigest(a)).not.toBe(specDigest({ ...a, b: { y: 1, x: [2, 1] } }))
    expect(Object.keys(canonicalize(a) as object)).toEqual(['a', 'b'])
  })

  it('maps the manifest platform key the binary is reviewed under', () => {
    expect(servedPlatform('win32', 'arm64')).toBe('win32-x64') // runs the x64 build emulated
    expect(servedPlatform('linux', 'arm64')).toBe('linux-arm64')
    expect(() => servedPlatform('linux', 'ia32')).toThrow('no reviewed release')
  })

  it('resolves OPENCODE_V2_BIN first, else the managed store’s copy of the tested version', () => {
    expect(servedBinaryPath({ OPENCODE_V2_BIN: '/x/opencode' })).toBe(resolve('/x/opencode'))
    expect(servedBinaryPath({})).toBe(
      join(
        installDir('opencode', PIN.version),
        process.platform === 'win32' ? 'opencode.exe' : 'opencode'
      )
    )
  })

  describe('verifyServedBinary fails closed before anything runs the binary', () => {
    const reviewed = (binarySha256?: string) => ({
      tested: '9.9.9',
      platforms: { 'linux-x64': binarySha256 ? { binarySha256 } : {} }
    })
    const withBinary = async (body: (file: string) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'oc-bin-'))
      try {
        const file = join(dir, 'opencode')
        writeFileSync(file, 'pretend binary')
        await body(file)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('returns the digest of the reviewed binary', () =>
      withBinary(async (file) => {
        await expect(
          verifyServedBinary(file, 'linux-x64', reviewed(sha256('pretend binary')))
        ).resolves.toBe(sha256('pretend binary'))
      }))

    it('refuses any other binary, naming both digests and how to install the right one', () =>
      withBinary(async (file) => {
        const error = await verifyServedBinary(file, 'linux-x64', reviewed(sha256('other'))).catch(
          (e: Error) => e
        )
        expect((error as Error).message).toContain(sha256('pretend binary'))
        expect((error as Error).message).toContain(sha256('other'))
        expect((error as Error).message).toMatch(/Refusing to run it.*bun run ensure-opencode/)
      }))

    it('refuses a platform the manifest has no digest for', () =>
      withBinary(async (file) => {
        await expect(verifyServedBinary(file, 'linux-x64', reviewed())).rejects.toThrow(
          'no reviewed binarySha256 for linux-x64'
        )
      }))

    it('says how to install a missing binary', async () => {
      await expect(
        verifyServedBinary(join(tmpdir(), 'oc-bin-missing', 'opencode'), 'linux-x64', reviewed('a'))
      ).rejects.toThrow(/No opencode binary at .*bun run ensure-opencode/)
    })
  })

  describe('host neutrality', () => {
    const home = '/tmp/opencode-served-spec-ab12'
    const binary = 'C:\\store\\opencode\\2.0.26\\opencode.exe'
    const markers = hostMarkers({ paths: [home, binary], username: 'devuser' })
    const check = (text: string) => () => assertHostNeutral(text, markers)

    it('passes a document with URLs, route templates and a property called tmp', () => {
      expect(
        check(
          JSON.stringify({
            description: 'See https://example.com/a, file:///x and GET /api/session/{id}; a:b',
            properties: { tmp: { type: 'string' } }
          })
        )
      ).not.toThrow()
    })

    it('rejects the temporary home and the binary, in either slash style and JSON-escaped', () => {
      for (const path of [home, binary]) {
        for (const variant of [
          path,
          path.replaceAll('\\', '/'),
          path.replaceAll('/', '\\'),
          JSON.stringify(path.replaceAll('/', '\\')).slice(1, -1)
        ]) {
          expect(check(`{"description":"at ${variant} now"}`), variant).toThrow(/host-specific/)
        }
      }
    })

    it('rejects a drive-letter path and the user’s name as a path segment, not as a word', () => {
      expect(check('{"d":"D:/x"}')).toThrow(/drive-letter/)
      expect(check('{"d":"C:\\\\Users\\\\x"}')).toThrow(/drive-letter/)
      expect(check('{"d":"/home/devuser/project"}')).toThrow(/devuser/)
      expect(check('{"d":"\\\\Users\\\\DevUser\\\\x"}')).toThrow(/devuser/i)
      expect(check('{"d":"devuser asked"}')).not.toThrow()
    })

    it('names what it found, with context', () => {
      expect(check('{"d":"before /home/devuser/ after"}')).toThrow(/before \/home\/devuser\/ after/)
    })
  })

  describe('provenance across platforms', () => {
    const reviewedDigests = {
      platforms: { 'win32-x64': { binarySha256: 'w' }, 'linux-x64': { binarySha256: 'l' } }
    }
    const built = { version: '1', servedSpecSha256: 's', binarySha256: 'l', platform: 'linux-x64' }
    const committed = (patch: object) =>
      JSON.stringify({ ...built, binarySha256: 'w', platform: 'win32-x64', ...patch })

    it('lets another platform’s reviewed binary serve the same spec', () => {
      expect(provenanceProblems(committed({}), built, reviewedDigests)).toEqual([])
    })

    it('flags a different spec, and a binary the manifest never reviewed', () => {
      expect(
        provenanceProblems(committed({ servedSpecSha256: 'other' }), built, reviewedDigests)
      ).toEqual(['provenance.json differs from the generator output'])
      expect(
        provenanceProblems(committed({ binarySha256: 'forged' }), built, reviewedDigests)
      ).toEqual([expect.stringContaining('did not review')])
    })

    it('flags a missing or unparseable file', () => {
      expect(provenanceProblems(null, built, reviewedDigests)).toHaveLength(1)
      expect(provenanceProblems('{', built, reviewedDigests)).toHaveLength(1)
    })
  })

  describe('the informational difference from upstream’s committed spec', () => {
    const schema = (type: string) => ({ type })
    const upstream = {
      components: {
        schemas: { Same: schema('string'), Gone: schema('string'), Moved: schema('string') }
      },
      paths: {
        '/a': { get: { operationId: 'a.get', responses: {} } },
        '/b': { get: { operationId: 'b.get', responses: {} } }
      }
    }
    const served = {
      components: {
        schemas: { Same: schema('string'), New: schema('number'), Moved: schema('number') }
      },
      paths: {
        '/a': { get: { operationId: 'a.get', summary: 'now documented', responses: {} } },
        '/c': { post: { operationId: 'c.post', responses: {} } }
      }
    }

    it('lists component and operation names only, added / removed / changed', () => {
      expect(specDifferences(upstream, served)).toEqual({
        components: { added: ['New'], removed: ['Gone'], changed: ['Moved'] },
        operations: { added: ['c.post'], removed: ['b.get'], changed: ['a.get'] }
      })
      expect(specDifferenceReport(specDifferences(upstream, served))).toEqual([
        '  components + (1): New',
        '  components - (1): Gone',
        '  components ~ (1): Moved',
        '  operations + (1): c.post',
        '  operations - (1): b.get',
        '  operations ~ (1): a.get'
      ])
    })

    it('is empty when upstream’s spec matches, whatever the key order', () => {
      const reordered = { paths: upstream.paths, components: upstream.components }
      expect(specDifferenceReport(specDifferences(upstream, reordered))).toEqual([])
    })
  })
})

describe('the drift report credits a JSDoc change to the declaration it documents', () => {
  const spec = (opSummary: string, typeDescription: string) => ({
    components: { schemas: { A: { type: 'string', description: typeDescription } } },
    paths: {
      '/a': { get: { operationId: 'fs.list', summary: 'List', responses: { '204': {} } } },
      '/b': { get: { operationId: 'fs.read', summary: opSummary, responses: { '204': {} } } },
      '/c': { get: { operationId: 'fs.stat', summary: 'Stat', responses: { '204': {} } } }
    }
  })
  const meta = { tag: 'vX', commit: 'c', specSha256: 's' }
  const render = (opSummary: string, typeDescription: string) =>
    renderProtocol(spec(opSummary, typeDescription), meta)

  it('an operation’s summary change is that operation’s, not the one before it (2.0.25: fs.read reported as fs.list)', () => {
    expect(driftReport(render('Serve one file', 'd'), render('Stream one file', 'd'))).toEqual([
      '  ~ operation fs.read'
    ])
  })

  it('a type’s description change is that type’s', () => {
    expect(driftReport(render('r', 'old'), render('r', 'new'))).toEqual(['  ~ type A'])
  })

  it('holds a declaration’s JSDoc with it and ends an operation at its closing brace', () => {
    const entries = declarations(render('Stream', 'd'))
    expect(entries.get('operation fs.read')).toMatch(
      /^ {2}\/\*\* Stream \*\/\n {2}'fs\.read': \{\n/
    )
    expect(entries.get('operation fs.read')).toMatch(/\n {2}\}\n$/)
    expect(entries.get('operation fs.list')).not.toContain('Stream')
    expect(entries.get('type A')).toMatch(/^\/\*\* d \*\/\nexport type A = /)
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
