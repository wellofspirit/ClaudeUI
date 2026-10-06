#!/usr/bin/env bun
/**
 * opencode 2.x wire types (ADR-093 §7), generated from the pinned upstream
 * `packages/protocol/openapi.json`. Zero dependencies: a small OpenAPI 3.1 /
 * JSON Schema 2020-12 → TypeScript emitter that understands exactly the
 * constructs that spec uses and FAILS CLOSED on anything else.
 *
 *   bun run generate-opencode-protocol        regenerate src/core/opencode/protocol-v2/
 *   bun run check-opencode-protocol           fail on any drift (generated files or event sources)
 *   bun scripts/generate-opencode-protocol.mjs --accept-events
 *                                             record the event sources events.ts was reviewed against
 *
 * Input: the pinned commit of the upstream checkout, read with `git show` so
 * the checkout's working tree does not matter. The checkout is found at
 * `$OPENCODE_V2_SRC`, else `vendor/opencode-v2-src`, else (agent worktrees) the
 * main checkout's `vendor/opencode-v2-src`.
 *
 * SSE event payloads are NOT in the spec (`V2EventEncoded` is an opaque JSON
 * string, at runtime too: the served `/openapi.json` says the same). They are
 * Effect Schemas in `packages/schema/src`, so `protocol-v2/events.ts` is a
 * hand-curated closure of the events ClaudeUI consumes. This script pins the
 * sha256 of every upstream file that closure was written against
 * (`events.reviewed.json`); a bump that changes any of them fails both generate
 * and check until a human re-reviews `events.ts` and runs `--accept-events`.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bump when the emitted TypeScript changes for the same spec. */
export const GENERATOR_VERSION = 1

/**
 * The opencode 2.x the generated types describe: the harness manifest's
 * `tested` (one source of truth for the pin, ADR-093 §1), its release tag, and
 * the commit that tag was reviewed at. `pinnedReader` proves the tag still
 * names that commit, so bumping `tested` without re-reviewing `PIN_COMMIT`
 * fails both generate and check.
 */
const PIN_COMMIT = 'e7a34f09bfd9134dfade5a8ddb843f7030bc9a69'
const manifest = JSON.parse(
  readFileSync(new URL('../src/shared/harness-manifests/opencode.json', import.meta.url), 'utf8')
)
export const PIN = {
  version: manifest.tested,
  tag: `v${manifest.tested}`,
  commit: PIN_COMMIT
}

export const SPEC_PATH = 'packages/protocol/openapi.json'

/**
 * Every upstream file whose definitions `events.ts` transcribes: the envelope,
 * the public event union, and each consumed event family. Payload types that
 * ARE spec components (TokenUsage.Info, Permission.Request, Form.Info, …) are
 * referenced from the generated file instead and drift through it.
 */
export const EVENT_SOURCES = [
  'packages/protocol/src/groups/event.ts',
  'packages/schema/src/event.ts',
  'packages/schema/src/event-manifest.ts',
  'packages/schema/src/session-event.ts',
  'packages/schema/src/session-inbox.ts',
  'packages/schema/src/session-error.ts',
  'packages/schema/src/permission.ts',
  'packages/schema/src/form.ts',
  'packages/schema/src/credential.ts',
  'packages/schema/src/provider.ts',
  'packages/schema/src/model.ts',
  'packages/schema/src/server-event.ts',
  'packages/schema/src/llm.ts',
  'packages/schema/src/location.ts'
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const OUTPUT_DIR = 'src/core/opencode/protocol-v2'
const GENERATED_FILE = 'openapi.ts'
const PROVENANCE_FILE = 'provenance.json'
const EVENTS_REVIEWED_FILE = 'events.reviewed.json'

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// Schema → TypeScript
// ---------------------------------------------------------------------------

/** Keywords that only annotate or constrain values TypeScript cannot express. */
const ANNOTATION_KEYWORDS = new Set([
  'description',
  'title',
  '$comment',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'default',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'contentMediaType',
  'contentEncoding'
])
const STRUCTURAL_KEYWORDS = new Set([
  '$ref',
  'type',
  'const',
  'enum',
  'anyOf',
  'oneOf',
  'allOf',
  'items',
  'prefixItems',
  'properties',
  'required',
  'additionalProperties',
  'patternProperties'
])

/** `Agent.Info` → `Agent_Info`. Collisions are rejected by `componentNames`. */
export const typeName = (component) => component.replace(/[^A-Za-z0-9_]/g, '_')

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
/** Single-quoted TS string literal (repo style). */
export function quote(value) {
  return `'${JSON.stringify(String(value)).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
}
function literal(value) {
  if (typeof value === 'string') return quote(value)
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value)
  throw new Error(`Unsupported literal ${JSON.stringify(value)}`)
}
const propertyKey = (key) => (IDENTIFIER.test(key) ? key : quote(key))
const jsdoc = (text, indent) =>
  text ? `${indent}/** ${String(text).replace(/\*\//g, '*\\/').replace(/\n/g, ' ')} */\n` : ''

/** True when `text` has a `|` outside any brackets: it needs parens in an intersection. */
function topLevelUnion(text) {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === "'") inString = false
    } else if (c === "'") inString = true
    else if ('{[(<'.includes(c)) depth++
    else if ('}])>'.includes(c)) depth--
    else if (c === '|' && depth === 0) return true
  }
  return false
}
const unionOf = (parts) => (parts.includes('unknown') ? 'unknown' : [...new Set(parts)].join(' | '))
const intersectionOf = (parts) =>
  parts.map((part) => (topLevelUnion(part) ? `(${part})` : part)).join(' & ')

/**
 * One JSON Schema node → a TypeScript type expression. `at` is a JSON-pointer-ish
 * location for error messages; `indent` is the current nesting indentation.
 */
export function schemaToTs(node, at = '#', indent = '') {
  if (node === true || node === undefined) return 'unknown'
  if (node === false) return 'never'
  if (typeof node !== 'object' || node === null || Array.isArray(node))
    throw new Error(`Unsupported schema at ${at}: ${JSON.stringify(node)}`)
  for (const key of Object.keys(node)) {
    if (!STRUCTURAL_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key) && !key.startsWith('x-'))
      throw new Error(`Unsupported schema keyword "${key}" at ${at}`)
  }
  if (node.$ref !== undefined) {
    const prefix = '#/components/schemas/'
    if (typeof node.$ref !== 'string' || !node.$ref.startsWith(prefix))
      throw new Error(`Unsupported $ref ${node.$ref} at ${at}`)
    if (Object.keys(node).some((key) => STRUCTURAL_KEYWORDS.has(key) && key !== '$ref'))
      throw new Error(`$ref with sibling structure at ${at}`)
    return typeName(node.$ref.slice(prefix.length))
  }
  if (node.allOf) {
    const { allOf, ...base } = node
    const parts = Object.keys(base).some((key) => STRUCTURAL_KEYWORDS.has(key))
      ? [schemaToTs(base, at, indent)]
      : []
    allOf.forEach((part, i) => parts.push(schemaToTs(part, `${at}/allOf/${i}`, indent)))
    return intersectionOf([...new Set(parts)])
  }
  if (node.const !== undefined) return literal(node.const)
  if (node.enum) return unionOf(node.enum.map(literal))
  const alternatives = node.anyOf ?? node.oneOf
  if (alternatives) {
    const keyword = node.anyOf ? 'anyOf' : 'oneOf'
    // A union beside other structure would silently drop that structure.
    if (Object.keys(node).some((key) => STRUCTURAL_KEYWORDS.has(key) && key !== keyword))
      throw new Error(`${keyword} with sibling structure at ${at}`)
    return unionOf(alternatives.map((alt, i) => schemaToTs(alt, `${at}/${keyword}/${i}`, indent)))
  }
  if (Array.isArray(node.type))
    return unionOf(node.type.map((type) => schemaToTs({ ...node, type }, at, indent)))
  switch (node.type) {
    case undefined:
      return 'unknown'
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      if (node.prefixItems) {
        const head = node.prefixItems.map((item, i) =>
          schemaToTs(item, `${at}/prefixItems/${i}`, indent)
        )
        const rest =
          node.items === false
            ? []
            : [`...${arrayElement(schemaToTs(node.items, `${at}/items`, indent))}[]`]
        return `readonly [${[...head, ...rest].join(', ')}]`
      }
      return `ReadonlyArray<${schemaToTs(node.items, `${at}/items`, indent)}>`
    }
    case 'object':
      return objectToTs(node, at, indent)
    default:
      throw new Error(`Unsupported type "${node.type}" at ${at}`)
  }
}

const arrayElement = (text) => (/^[\w.]+$/.test(text) ? text : `(${text})`)

function objectToTs(node, at, indent) {
  const inner = indent + '  '
  const required = new Set(node.required ?? [])
  const lines = Object.entries(node.properties ?? {}).map(
    ([key, value]) =>
      `${jsdoc(value?.description, inner)}${inner}readonly ${propertyKey(key)}${required.has(key) ? '' : '?'}: ${schemaToTs(value, `${at}/properties/${key}`, inner)}`
  )
  const index = []
  const extra = node.additionalProperties
  if (extra !== undefined && extra !== false)
    index.push(schemaToTs(extra, `${at}/additionalProperties`, inner))
  for (const [pattern, value] of Object.entries(node.patternProperties ?? {}))
    index.push(schemaToTs(value, `${at}/patternProperties/${pattern}`, inner))
  // An object with neither keyword is open in JSON Schema.
  const open = extra === undefined && !node.patternProperties
  const block = lines.length ? `{\n${lines.join('\n')}\n${indent}}` : null
  const indexType = index.length ? unionOf(index) : open ? 'unknown' : null
  if (!block) {
    if (indexType === null) return 'Record<string, never>'
    return `{ readonly [key: string]: ${indexType} }`
  }
  // Declared properties plus an index signature: an intersection, so a declared
  // property never has to be assignable to the index type.
  if (indexType === null || (open && indexType === 'unknown' && extra === undefined)) return block
  return `${block} & { readonly [key: string]: ${indexType} }`
}

// ---------------------------------------------------------------------------
// Document → generated file
// ---------------------------------------------------------------------------

const METHODS = ['get', 'put', 'post', 'patch', 'delete']

export function componentNames(spec) {
  const names = Object.keys(spec.components?.schemas ?? {}).sort(byCodeUnit)
  const seen = new Map()
  for (const name of names) {
    const id = typeName(name)
    if (seen.has(id)) throw new Error(`Component name collision: ${seen.get(id)} / ${name} → ${id}`)
    seen.set(id, name)
  }
  return names
}

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The operation table: one entry per operationId, sorted. */
export function operations(spec) {
  const result = []
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const key of Object.keys(item)) {
      if (!METHODS.includes(key)) throw new Error(`Unsupported path item key "${key}" at ${path}`)
    }
    for (const method of METHODS) {
      const op = item[method]
      if (!op) continue
      if (!op.operationId) throw new Error(`Missing operationId: ${method} ${path}`)
      result.push({ id: op.operationId, method: method.toUpperCase(), path, op })
    }
  }
  result.sort((a, b) => byCodeUnit(a.id, b.id))
  for (let i = 1; i < result.length; i++)
    if (result[i].id === result[i - 1].id) throw new Error(`Duplicate operationId ${result[i].id}`)
  return result
}

/** A parameter schema without its top-level `| null` (a query value is either sent or not). */
function stripNull(schema) {
  const alternatives = schema?.anyOf
  if (!Array.isArray(alternatives)) return schema
  const kept = alternatives.filter((alt) => alt?.type !== 'null')
  if (kept.length === alternatives.length) return schema
  const { anyOf: _anyOf, ...rest } = schema
  return kept.length === 1 ? { ...rest, ...kept[0] } : { ...rest, anyOf: kept }
}

function parametersOf(op, location, at, indent) {
  const params = (op.parameters ?? []).filter((param) => param.in === location)
  if (!params.length) return 'never'
  const inner = indent + '  '
  const lines = params
    .map(
      (param) =>
        `${jsdoc(param.description ?? param.schema?.description, inner)}${inner}readonly ${propertyKey(param.name)}${param.required ? '' : '?'}: ${schemaToTs(stripNull(param.schema), `${at}/parameters/${param.name}`, inner)}`
    )
    .join('\n')
  return `{\n${lines}\n${indent}}`
}

const JSON_TYPE = 'application/json'
const SSE_TYPE = 'text/event-stream'
const BINARY_TYPE = 'application/octet-stream'

function bodyOf(op, at, indent) {
  const body = op.requestBody
  if (!body) return { kind: 'none', type: 'never' }
  const types = Object.keys(body.content ?? {})
  if (types.length !== 1) throw new Error(`Expected one request content type at ${at}`)
  const optional = body.required ? '' : ' | undefined'
  if (types[0] === JSON_TYPE)
    return {
      kind: 'json',
      type: schemaToTs(body.content[JSON_TYPE].schema, `${at}/requestBody`, indent) + optional
    }
  if (types[0] === BINARY_TYPE) return { kind: 'binary', type: 'Uint8Array' + optional }
  throw new Error(`Unsupported request content type ${types[0]} at ${at}`)
}

function responseOf(op, at, indent) {
  const success = Object.entries(op.responses ?? {}).filter(([code]) => /^2\d\d$/.test(code))
  if (success.length !== 1) throw new Error(`Expected exactly one 2xx response at ${at}`)
  const [code, response] = success[0]
  const types = Object.keys(response.content ?? {})
  if (types.length === 0) return { kind: 'empty', type: 'void', code }
  if (types.length !== 1) throw new Error(`Expected one response content type at ${at}`)
  const schema = response.content[types[0]].schema
  if (types[0] === JSON_TYPE)
    return { kind: 'json', type: schemaToTs(schema, `${at}/responses/${code}`, indent), code }
  // The SSE frame (`{id, event, data}`); `data` is the JSON text of one event.
  if (types[0] === SSE_TYPE)
    return { kind: 'sse', type: schemaToTs(schema, `${at}/responses/${code}`, indent), code }
  if (types[0] === BINARY_TYPE) return { kind: 'binary', type: 'Uint8Array', code }
  throw new Error(`Unsupported response content type ${types[0]} at ${at}`)
}

function errorsOf(op, at, indent) {
  const parts = []
  const flatten = (schema) => (schema.anyOf ? schema.anyOf.flatMap(flatten) : [schema])
  for (const [code, response] of Object.entries(op.responses ?? {})) {
    if (/^2\d\d$/.test(code)) continue
    const schema = response.content?.[JSON_TYPE]?.schema
    if (!schema) continue
    // `A | A` alternatives inside one response collapse; so do repeats across codes.
    for (const alt of flatten(schema))
      parts.push(schemaToTs(alt, `${at}/responses/${code}`, indent))
  }
  return parts.length ? unionOf(parts) : 'never'
}

/** The whole generated module as text. Pure and deterministic for a given spec. */
export function renderProtocol(spec, { tag, commit, specSha256 }) {
  const out = [
    `// GENERATED by scripts/generate-opencode-protocol.mjs (v${GENERATOR_VERSION}) — do not edit.`,
    `// Source: opencode ${tag} (${commit}) ${SPEC_PATH}`,
    `// sha256 ${specSha256}. Regenerate: bun run generate-opencode-protocol`,
    `// SSE event payloads are not in the spec: see ./events.ts.`,
    ''
  ]
  for (const name of componentNames(spec)) {
    const schema = spec.components.schemas[name]
    out.push(
      `${jsdoc(schema.description, '')}export type ${typeName(name)} = ${schemaToTs(schema, `#/components/schemas/${name}`)}`,
      ''
    )
  }
  const ops = operations(spec)
  const table = []
  out.push('/** Every operation of the pinned API, keyed by operationId. */')
  out.push('export interface Operations {')
  for (const { id, method, path, op } of ops) {
    const at = `${method} ${path}`
    const indent = '    '
    const body = bodyOf(op, at, indent)
    const response = responseOf(op, at, indent)
    const summary = [op.summary, op.description].filter(Boolean).join(' — ')
    out.push(`${jsdoc(summary, '  ')}  ${quote(id)}: {`)
    out.push(`    readonly method: ${quote(method)}`)
    out.push(`    readonly path: ${quote(path)}`)
    out.push(`    readonly params: ${parametersOf(op, 'path', at, indent)}`)
    out.push(`    readonly query: ${parametersOf(op, 'query', at, indent)}`)
    out.push(`    readonly headers: ${parametersOf(op, 'header', at, indent)}`)
    out.push(`    readonly bodyKind: ${quote(body.kind)}`)
    out.push(`    readonly body: ${body.type}`)
    out.push(`    readonly responseKind: ${quote(response.kind)}`)
    out.push(`    readonly response: ${response.type}`)
    out.push(`    readonly errors: ${errorsOf(op, at, indent)}`)
    out.push('  }')
    table.push(
      `  ${quote(id)}: { method: ${quote(method)}, path: ${quote(path)}, bodyKind: ${quote(body.kind)}, responseKind: ${quote(response.kind)} },`
    )
  }
  out.push('}')
  out.push('')
  out.push('export type OperationId = keyof Operations')
  out.push('')
  out.push(
    '/** The runtime half of `Operations`: how to send each one and how to read its answer. */'
  )
  out.push('export const OPERATIONS = {')
  out.push(...table)
  out.push('} as const satisfies {')
  out.push(
    "  readonly [K in OperationId]: Pick<Operations[K], 'method' | 'path' | 'bodyKind' | 'responseKind'>"
  )
  out.push('}')
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Upstream checkout
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

export function locateSource() {
  const candidates = []
  if (process.env.OPENCODE_V2_SRC) candidates.push(resolve(process.env.OPENCODE_V2_SRC))
  candidates.push(join(root, 'vendor', 'opencode-v2-src'))
  try {
    // An agent worktree has no vendor/ source of its own: use the main checkout's.
    const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    candidates.push(join(dirname(common), 'vendor', 'opencode-v2-src'))
  } catch {
    // not a git checkout: only the explicit candidates
  }
  const found = candidates.find((dir) => existsSync(join(dir, '.git')))
  if (!found)
    throw new Error(
      `No opencode 2.x source checkout (tried ${candidates.join(', ')}). ` +
        `Create it with: git -C vendor/opencode-src worktree add ../opencode-v2-src ${PIN.tag}`
    )
  return found
}

/** Reads `path` at the pinned commit, after proving the tag still names that commit. */
export function pinnedReader(source, pin = PIN) {
  let tagged
  try {
    tagged = git(source, ['rev-parse', `${pin.tag}^{commit}`]).trim()
  } catch {
    throw new Error(`Tag ${pin.tag} is not in ${source}; fetch upstream tags first`)
  }
  if (tagged !== pin.commit)
    throw new Error(`Tag ${pin.tag} is ${tagged} in ${source}, but the pin says ${pin.commit}`)
  return (path) => git(source, ['show', `${pin.commit}:${path}`])
}

export function eventSourceDigests(read) {
  return Object.fromEntries(EVENT_SOURCES.map((path) => [path, sha256(read(path))]))
}

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

/** `export type X = …` blocks and `Operations` entries of a generated file, by name. */
export function declarations(text) {
  const result = new Map()
  const lines = text.split('\n')
  let current = null
  let inOperations = false
  for (const line of lines) {
    const type = /^export type (\w+) = /.exec(line)
    const op = inOperations ? /^ {2}'([^']+)': \{$/.exec(line) : null
    if (line === 'export interface Operations {') inOperations = true
    else if (inOperations && line === '}') inOperations = false
    if (type) current = `type ${type[1]}`
    else if (op) current = `operation ${op[1]}`
    else if (/^(export|\/\*\*)/.test(line) || line === '') current = null
    if (current) result.set(current, (result.get(current) ?? '') + line + '\n')
  }
  return result
}

export function driftReport(before, after) {
  const a = declarations(before)
  const b = declarations(after)
  const lines = []
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort(byCodeUnit)) {
    if (!a.has(name)) lines.push(`  + ${name}`)
    else if (!b.has(name)) lines.push(`  - ${name}`)
    else if (a.get(name) !== b.get(name)) lines.push(`  ~ ${name}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function build(read, pin = PIN) {
  const specText = read(SPEC_PATH)
  const spec = JSON.parse(specText)
  const specSha256 = sha256(specText)
  const generated = renderProtocol(spec, { tag: pin.tag, commit: pin.commit, specSha256 })
  const provenance =
    JSON.stringify(
      {
        version: pin.version,
        tag: pin.tag,
        commit: pin.commit,
        spec: SPEC_PATH,
        specSha256,
        specInfo: { title: spec.info?.title, version: spec.info?.version },
        generator: 'scripts/generate-opencode-protocol.mjs',
        generatorVersion: GENERATOR_VERSION,
        counts: {
          schemas: componentNames(spec).length,
          operations: operations(spec).length
        },
        files: { [GENERATED_FILE]: sha256(generated) }
      },
      null,
      2
    ) + '\n'
  return { generated, provenance }
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function main(argv) {
  const check = argv.includes('--check')
  const acceptEvents = argv.includes('--accept-events')
  const destination = join(root, OUTPUT_DIR)
  const source = locateSource()
  const read = pinnedReader(source)
  const problems = []

  // The hand-written event closure must have been reviewed against these exact sources.
  const digests = eventSourceDigests(read)
  const reviewedPath = join(destination, EVENTS_REVIEWED_FILE)
  if (acceptEvents) {
    writeFileSync(
      reviewedPath,
      JSON.stringify({ version: PIN.version, commit: PIN.commit, sources: digests }, null, 2) + '\n'
    )
    console.log(`Recorded ${EVENT_SOURCES.length} event sources as reviewed at ${PIN.tag}`)
  }
  const reviewed = JSON.parse(readIfExists(reviewedPath) ?? '{"sources":{}}')
  const changed = EVENT_SOURCES.filter((path) => reviewed.sources[path] !== digests[path])
  if (changed.length) {
    problems.push(
      `Event sources changed since events.ts was reviewed (${reviewed.version ?? 'never'} → ${PIN.version}):`,
      ...changed.map((path) => `  ${path}`),
      `Review with: git -C ${source} diff ${reviewed.commit ?? '<reviewed>'} ${PIN.commit} -- ${changed.join(' ')}`,
      `then update ${OUTPUT_DIR}/events.ts and run: bun scripts/generate-opencode-protocol.mjs --accept-events`
    )
  }

  const { generated, provenance } = build(read)
  const files = [
    [GENERATED_FILE, generated],
    [PROVENANCE_FILE, provenance]
  ]
  if (check) {
    for (const [name, text] of files) {
      const current = readIfExists(join(destination, name))
      if (current === text) continue
      problems.push(`${OUTPUT_DIR}/${name} differs from the pinned generator output`)
      if (name === GENERATED_FILE && current) problems.push(...driftReport(current, text))
    }
  } else {
    mkdirSync(destination, { recursive: true })
    for (const [name, text] of files) writeFileSync(join(destination, name), text)
    console.log(`Generated ${OUTPUT_DIR}/${GENERATED_FILE} from opencode ${PIN.tag}`)
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else if (check) {
    console.log(
      `opencode protocol matches ${PIN.tag} (spec + ${EVENT_SOURCES.length} event sources)`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`opencode protocol generation failed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
