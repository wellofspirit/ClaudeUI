#!/usr/bin/env bun
/**
 * opencode 2.x wire types (ADR-097 §7), generated from the OpenAPI document the
 * pinned binary SERVES (`GET /openapi.json` of `opencode serve --stdio`). Zero
 * dependencies: a small OpenAPI 3.1 / JSON Schema 2020-12 → TypeScript emitter
 * that understands exactly the constructs that spec uses and FAILS CLOSED on
 * anything else.
 *
 *   bun run generate-opencode-protocol        regenerate src/core/opencode/protocol-v2/
 *   bun run check-opencode-protocol           fail on any drift (generated files or event sources)
 *   bun scripts/generate-opencode-protocol.mjs --accept-events
 *                                             record the event sources events.ts was reviewed against
 *
 * Input, spec: the served document, not upstream's committed
 * `packages/protocol/openapi.json` — upstream stopped regenerating that file at
 * 2.0.25 while the schema sources kept moving, and only the served one is what
 * the binary ClaudeUI ships actually speaks (owner ruling, 2026-10-10). The
 * binary is resolved like the contract suite does (`OPENCODE_V2_BIN`, else the
 * managed store's copy of the manifest's `tested`, honouring
 * `CLAUDEUI_HARNESS_STORE`; install it with `bun run ensure-opencode`), and
 * BEFORE it is run its SHA-256 must equal the manifest's reviewed
 * `binarySha256` for this host and `--version` must equal `tested`. It then runs
 * as `serve --stdio` under an isolated HOME/XDG, with every proxy pointed at a
 * refusing address and models.dev fetch + autoupdate off (the contract suite's
 * isolation), and is ended by closing stdin. The served document is canonicalised
 * (keys sorted) for its digest, and generation FAILS CLOSED if it names anything
 * host-specific (the temporary home, the binary's path, a drive letter, the
 * user's name). Upstream's committed spec at the pin is read only to print an
 * informational difference summary.
 *
 * Input, events: the pinned commit of the upstream checkout, read with `git show`
 * so the checkout's working tree does not matter. The checkout is found at
 * `$OPENCODE_SRC`, else `vendor/opencode-src`, else the pre-S10 name
 * `vendor/opencode-v2-src`, else (agent worktrees) the same in the main
 * checkout — the first that holds the pinned tag (`locateSource`).
 *
 * SSE event payloads are NOT in the spec (`V2EventEncoded` is an opaque JSON
 * string, at runtime too: the served `/openapi.json` says the same). They are
 * Effect Schemas in `packages/schema/src`, so `protocol-v2/events.ts` is a
 * hand-curated closure of the events ClaudeUI consumes. This script pins the
 * sha256 of every upstream file that closure was written against
 * (`events.reviewed.json`); a bump that changes any of them fails both generate
 * and check until a human re-reviews `events.ts` and runs `--accept-events`.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { opencodePlatformKey } from '../src/core/harness/install/sources.ts'
import { installDir } from '../src/core/harness/store.ts'

/** Bump when the emitted TypeScript changes for the same spec. */
export const GENERATOR_VERSION = 2

/**
 * The opencode 2.x the generated types describe: the harness manifest's
 * `tested` (one source of truth for the pin, ADR-097 §1), its release tag, and
 * the commit that tag was reviewed at. `pinnedReader` proves the tag still
 * names that commit, so bumping `tested` without re-reviewing `PIN_COMMIT`
 * fails both generate and check.
 */
const PIN_COMMIT = 'a517687fde98a7329ada3ae644a01a9fc6c4e99e'
const manifest = JSON.parse(
  readFileSync(new URL('../src/shared/harness-manifests/opencode.json', import.meta.url), 'utf8')
)
export const PIN = {
  version: manifest.tested,
  tag: `v${manifest.tested}`,
  commit: PIN_COMMIT
}

/** Where the spec comes from: the binary's own route. Named in headers and provenance. */
export const SERVED_ROUTE = '/openapi.json'
export const SERVED_SPEC = `GET ${SERVED_ROUTE}`
/** Upstream's committed spec: read only for the informational difference summary. */
export const UPSTREAM_SPEC_PATH = 'packages/protocol/openapi.json'

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
/**
 * The raw config editor's JSON Schema (ADR-097 S8): `Config.InfoEncoded` and
 * every component it reaches, as a draft 2020-12 document. It lives beside the
 * renderer's other shared data (`src/shared/`), not in OUTPUT_DIR.
 */
export const CONFIG_SCHEMA_FILE = 'src/shared/opencode-config-schema.json'
export const CONFIG_SCHEMA_ROOT = 'Config.InfoEncoded'
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
  'not',
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
  if (node.not !== undefined) {
    // The only negation opencode 2.1 serves: a payload that may be anything but
    // null (`Session.Inbox.CompactionPayload`). TypeScript cannot express a
    // general `not`, so fail closed on any other shape.
    if (Object.keys(node).some((key) => STRUCTURAL_KEYWORDS.has(key) && key !== 'not'))
      throw new Error(`not with sibling structure at ${at}`)
    if (node.not?.type === 'null') return 'NonNullable<unknown>'
    throw new Error(`Unsupported not-schema at ${at}: ${JSON.stringify(node.not)}`)
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
    `// Source: the ${SERVED_ROUTE} served by opencode ${tag} (${commit}), not upstream's committed spec.`,
    `// Served spec sha256 ${specSha256} (keys sorted). Regenerate: bun run generate-opencode-protocol`,
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
// Config JSON Schema (raw config editor)
// ---------------------------------------------------------------------------

const COMPONENT_REF = /^#\/components\/schemas\/(.+)$/

/** `node` with every component `$ref` pointed at `#/$defs/<name>`; `reach` sees each name. */
function rebaseRefs(node, reach) {
  if (Array.isArray(node)) return node.map((item) => rebaseRefs(item, reach))
  if (!node || typeof node !== 'object') return node
  const out = {}
  for (const key of Object.keys(node).sort(byCodeUnit)) {
    const value = node[key]
    if (key === '$ref' && typeof value === 'string') {
      const match = COMPONENT_REF.exec(value)
      if (!match) throw new Error(`Config schema: unsupported $ref ${value}`)
      reach(match[1])
      out[key] = `#/$defs/${match[1]}`
    } else out[key] = rebaseRefs(value, reach)
  }
  return out
}

/**
 * `Config.InfoEncoded` and its transitive closure as one JSON Schema document
 * (keys sorted, so the bytes depend on the spec alone).
 */
export function renderConfigSchema(spec, { tag, commit, specSha256 }) {
  const components = spec.components?.schemas ?? {}
  const defs = {}
  const queue = [CONFIG_SCHEMA_ROOT]
  while (queue.length) {
    const name = queue.shift()
    if (name in defs) continue
    if (!components[name]) throw new Error(`Config schema: missing component ${name}`)
    defs[name] = null
    defs[name] = rebaseRefs(components[name], (next) => {
      if (!(next in defs)) queue.push(next)
    })
  }
  const sorted = Object.fromEntries(
    Object.keys(defs)
      .sort(byCodeUnit)
      .map((k) => [k, defs[k]])
  )
  return (
    JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $comment: `GENERATED by scripts/generate-opencode-protocol.mjs from the ${SERVED_ROUTE} served by opencode ${tag} (${commit}), served spec sha256 ${specSha256}. Do not edit.`,
        $ref: `#/$defs/${CONFIG_SCHEMA_ROOT}`,
        $defs: sorted
      },
      null,
      2
    ) + '\n'
  )
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

/** The checkout directory names, in order: the opencode checkout, then its pre-S10 2.x name. */
export const SOURCE_DIR_NAMES = ['opencode-src', 'opencode-v2-src']

/**
 * Where an opencode checkout may be, in order: `$OPENCODE_SRC` (or the older
 * `$OPENCODE_V2_SRC`), then `vendor/opencode-src` and `vendor/opencode-v2-src`
 * (the 2.x checkout's name until ADR-097 S10 renamed it) of this checkout, then
 * the same two of the main checkout (an agent worktree has no `vendor/` of its
 * own).
 */
export function sourceCandidates(repoRoot = root, env = process.env) {
  const candidates = []
  for (const name of ['OPENCODE_SRC', 'OPENCODE_V2_SRC'])
    if (env[name]) candidates.push(resolve(env[name]))
  const roots = [repoRoot]
  try {
    const common = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    roots.push(dirname(common))
  } catch {
    // not a git checkout: this root only
  }
  for (const base of roots)
    for (const name of SOURCE_DIR_NAMES) candidates.push(join(base, 'vendor', name))
  return [...new Set(candidates)]
}

/** Whether `dir`'s repository has the pinned tag naming the pinned commit. */
function hasPin(dir, pin = PIN) {
  try {
    return git(dir, ['rev-parse', `${pin.tag}^{commit}`]).trim() === pin.commit
  } catch {
    return false
  }
}

/**
 * The checkout to read: the first candidate that is a git checkout holding the
 * pinned tag at the pinned commit — so a `vendor/opencode-src` that is still
 * the old 1.x clone without the 2.x tags is passed over for the next one —
 * else the first git checkout at all, so `pinnedReader` names what is wrong
 * with it.
 */
export function locateSource({
  candidates = sourceCandidates(),
  isCheckout = (dir) => existsSync(join(dir, '.git')),
  holdsPin = (dir) => hasPin(dir)
} = {}) {
  const checkouts = candidates.filter((dir) => isCheckout(dir))
  const found = checkouts.find((dir) => holdsPin(dir)) ?? checkouts[0]
  if (!found)
    throw new Error(
      `No opencode source checkout (tried ${candidates.join(', ')}). ` +
        `Create it with: git clone https://github.com/anomalyco/opencode vendor/opencode-src && ` +
        `git -C vendor/opencode-src checkout ${PIN.tag}`
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
// The served spec (the pinned binary's own `/openapi.json`)
// ---------------------------------------------------------------------------

/** `value` with every object's keys in code-unit order (arrays keep theirs). */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(byCodeUnit)
      .map((key) => [key, canonicalize(value[key])])
  )
}

/** The digest of a spec: sha256 of its canonical (keys sorted), compact JSON. */
export const specDigest = (spec) => sha256(JSON.stringify(canonicalize(spec)))

/** The manifest platform key this host's binary is reviewed under (`win32-x64`, …). */
export function servedPlatform(platform = process.platform, arch = process.arch) {
  const key = opencodePlatformKey(platform, arch)
  if (!key) throw new Error(`opencode has no reviewed release for ${platform}-${arch}`)
  return key
}

/**
 * The binary whose spec is generated from: `OPENCODE_V2_BIN`, else the managed
 * store's copy of the manifest's `tested` (the contract suite's resolution).
 */
export function servedBinaryPath(env = process.env) {
  if (env.OPENCODE_V2_BIN) return resolve(env.OPENCODE_V2_BIN)
  return join(
    installDir('opencode', manifest.tested),
    process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  )
}

const INSTALL_HINT = 'Install the tested version with: bun run ensure-opencode'

function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')))
  })
}

/**
 * Proves `binary` is the reviewed one for `platform` before anything runs it:
 * its SHA-256 is the manifest's `binarySha256`. Returns that digest.
 */
export async function verifyServedBinary(binary, platform, reviewed = manifest) {
  if (!existsSync(binary)) throw new Error(`No opencode binary at ${binary}. ${INSTALL_HINT}`)
  const expected = reviewed.platforms?.[platform]?.binarySha256
  if (!/^[0-9a-f]{64}$/.test(expected ?? ''))
    throw new Error(`The opencode manifest has no reviewed binarySha256 for ${platform}`)
  const actual = await sha256File(binary)
  if (actual !== expected)
    throw new Error(
      `The opencode binary at ${binary} has SHA-256 ${actual}, but the manifest reviewed ` +
        `${expected} for ${platform} (opencode ${reviewed.tested}). Refusing to run it. ${INSTALL_HINT}`
    )
  return actual
}

/**
 * What a served document must not contain: the temporary home it ran under, the
 * binary's path and directory, this machine's home and temp directories, a
 * drive-letter path, and the user's name as a path segment. Each path is checked
 * in both slash styles and JSON-escaped. Returns `{what, pattern}` markers to
 * test against the raw text.
 */
export function hostMarkers({ paths = [], username = userInfo().username } = {}) {
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markers = []
  for (const path of paths.filter(Boolean)) {
    const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])
    for (const variant of [...variants]) variants.add(JSON.stringify(variant).slice(1, -1))
    for (const variant of variants)
      markers.push({ what: `the path ${path}`, pattern: new RegExp(escape(variant), 'i') })
  }
  markers.push({ what: 'a drive-letter path', pattern: /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/ })
  if (username && username.length >= 3)
    markers.push({
      what: `the user name "${username}" as a path segment`,
      pattern: new RegExp(`[\\\\/]${escape(username)}[\\\\/]`, 'i')
    })
  return markers
}

/** Throws, naming each marker found (with a little context), on host-specific text. */
export function assertHostNeutral(text, markers) {
  const found = []
  for (const { what, pattern } of markers) {
    const match = pattern.exec(text)
    if (!match) continue
    const around = text.slice(Math.max(0, match.index - 30), match.index + match[0].length + 30)
    found.push(`  ${what}: …${around}…`)
  }
  if (found.length)
    throw new Error(
      `The served spec contains host-specific text, so it cannot be a repo artifact:\n${found.join('\n')}`
    )
}

const GRACE_MS = 10_000
const START_MS = 30_000

/** `GET path` on a loopback server, bypassing any proxy configured for this process. */
function httpGet(url, path, headers) {
  return new Promise((done, fail) => {
    const req = request(new URL(path, url), { method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
      )
      res.on('error', fail)
    })
    req.setTimeout(30_000, () => req.destroy(new Error(`GET ${path} timed out`)))
    req.on('error', fail)
    req.end()
  })
}

/** The environment of the spec-serving process: isolated home, refusing proxy, nothing fetched. */
function isolatedServeEnv(root) {
  const dir = (...parts) => {
    const path = join(root, ...parts)
    mkdirSync(path, { recursive: true })
    return path
  }
  const refusing = 'http://127.0.0.1:9' // the discard port: nothing listens, so every request is refused
  const win = process.platform === 'win32'
  return {
    PATH: win ? (process.env.PATH ?? '') : '/usr/bin:/bin:/usr/sbin:/sbin',
    ...(win && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: dir('home'),
    XDG_DATA_HOME: dir('home', '.local', 'share'),
    XDG_CONFIG_HOME: dir('home', '.config'),
    XDG_CACHE_HOME: dir('home', '.cache'),
    XDG_STATE_HOME: dir('home', '.local', 'state'),
    ...(win
      ? {
          USERPROFILE: dir('home'),
          APPDATA: dir('home', 'AppData', 'Roaming'),
          LOCALAPPDATA: dir('home', 'AppData', 'Local')
        }
      : {}),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: '{}',
    HTTPS_PROXY: refusing,
    HTTP_PROXY: refusing,
    https_proxy: refusing,
    http_proxy: refusing,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost'
  }
}

/**
 * Runs `serve --stdio` from `binary` under a throwaway home and returns the
 * text of its `GET /openapi.json`, after `--version` has matched `tested`. The
 * server is ended by closing stdin (killed if that is ignored) and the home is
 * removed, by explicit path, either way.
 */
export async function serveOpenapi(binary, { tested = manifest.tested } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-served-spec-'))
  let child = null
  try {
    const env = isolatedServeEnv(root)
    const cwd = join(root, 'project')
    mkdirSync(cwd, { recursive: true })

    const reported = execFileSync(binary, ['--version'], {
      env,
      cwd,
      encoding: 'utf8',
      timeout: START_MS,
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    if (/(\d+\.\d+\.\d+[\w.+-]*)/.exec(reported)?.[1] !== tested)
      throw new Error(`The opencode binary reports "${reported}", but the pin is ${tested}`)

    const password = randomBytes(18).toString('base64url')
    child = spawn(
      binary,
      ['serve', '--stdio', '--port', '0', '--print-logs', '--log-level', 'warn'],
      { cwd, env: { ...env, OPENCODE_PASSWORD: password }, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const exited = new Promise((done) =>
      child.once('exit', (code, signal) => done({ code, signal }))
    )
    const stderr = []
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderr.push(line)
      if (stderr.length > 40) stderr.shift()
    })
    let timer
    const first = await Promise.race([
      new Promise((done) => createInterface({ input: child.stdout }).once('line', done)),
      exited.then(({ code, signal }) => {
        throw new Error(
          `opencode exited (${code ?? signal}) before printing its url\n${stderr.join('\n')}`
        )
      }),
      new Promise((_, fail) => {
        timer = setTimeout(
          () =>
            fail(
              new Error(`opencode printed no url within ${START_MS / 1000} s\n${stderr.join('\n')}`)
            ),
          START_MS
        )
      })
    ]).finally(() => clearTimeout(timer))
    let url
    try {
      url = JSON.parse(first).url
    } catch {
      throw new Error(`--stdio first line is not {url}: ${String(first).slice(0, 200)}`)
    }
    const headers = {
      authorization: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
      'x-opencode-directory': encodeURIComponent(cwd)
    }
    let last = ''
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await httpGet(url, SERVED_ROUTE, headers)
      if (response.status === 200) {
        assertHostNeutral(
          response.text,
          hostMarkers({ paths: [root, binary, dirname(binary), homedir(), tmpdir()] })
        )
        return response.text
      }
      last = `${response.status} ${response.text.slice(0, 200)}`
      await new Promise((done) => setTimeout(done, 500))
    }
    throw new Error(`GET ${SERVED_ROUTE} did not answer 200: ${last}`)
  } finally {
    if (child) {
      child.stdin.end()
      const ended = await Promise.race([
        new Promise((done) =>
          child.exitCode !== null || child.signalCode !== null
            ? done(true)
            : child.once('exit', () => done(true))
        ),
        new Promise((done) => setTimeout(() => done(false), GRACE_MS))
      ])
      if (!ended) child.kill('SIGKILL')
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

/**
 * The served spec of the pinned binary, ready to generate from: resolves the
 * binary, proves it is the reviewed one (SHA-256, then `--version`), runs it
 * isolated, and refuses a document that names this host.
 */
export async function acquireServedSpec({ env = process.env } = {}) {
  const platform = servedPlatform()
  const binary = servedBinaryPath(env)
  const binarySha256 = await verifyServedBinary(binary, platform)
  const spec = JSON.parse(await serveOpenapi(binary))
  return { spec, specSha256: specDigest(spec), binarySha256, platform }
}

/** Component and operation names that differ between upstream's committed spec and the served one. */
export function specDifferences(upstream, served) {
  const compare = (before, after) => {
    const same = (name) =>
      JSON.stringify(canonicalize(before[name])) === JSON.stringify(canonicalize(after[name]))
    return {
      added: Object.keys(after)
        .filter((name) => !(name in before))
        .sort(byCodeUnit),
      removed: Object.keys(before)
        .filter((name) => !(name in after))
        .sort(byCodeUnit),
      changed: Object.keys(after)
        .filter((name) => name in before && !same(name))
        .sort(byCodeUnit)
    }
  }
  const byId = (spec) =>
    Object.fromEntries(
      operations(spec).map(({ id, op, method, path }) => [id, { method, path, op }])
    )
  return {
    components: compare(upstream.components?.schemas ?? {}, served.components?.schemas ?? {}),
    operations: compare(byId(upstream), byId(served))
  }
}

/** Lines for `specDifferences` (empty when the two agree). */
export function specDifferenceReport(differences) {
  const lines = []
  for (const [kind, { added, removed, changed }] of Object.entries(differences)) {
    for (const [mark, names] of [
      ['+', added],
      ['-', removed],
      ['~', changed]
    ])
      if (names.length) lines.push(`  ${kind} ${mark} (${names.length}): ${names.join(', ')}`)
  }
  return lines
}

// ---------------------------------------------------------------------------
// Drift report
// ---------------------------------------------------------------------------

/**
 * `export type X = …` blocks and `Operations` entries of a generated file, by
 * name. A declaration's one-line JSDoc belongs to the declaration FOLLOWING it,
 * so it is held back and attached to that one — never to the one before.
 */
export function declarations(text) {
  const result = new Map()
  let current = null
  let doc = ''
  let inOperations = false
  for (const line of text.split('\n')) {
    if (line === 'export interface Operations {') inOperations = true
    else if (inOperations && line === '}') inOperations = false
    const type = /^export type (\w+) = /.exec(line)
    const op = inOperations ? /^ {2}'([^']+)': \{$/.exec(line) : null
    if (type || op) {
      current = type ? `type ${type[1]}` : `operation ${op[1]}`
      result.set(current, doc + line + '\n')
      doc = ''
    } else if (inOperations ? /^ {2}\/\*\*/.test(line) : /^\/\*\*/.test(line)) {
      current = null
      doc = line + '\n'
    } else if (inOperations && current && line === '  }') {
      result.set(current, result.get(current) + line + '\n')
      current = null
    } else if (/^export/.test(line) || line === '') {
      current = null
      doc = ''
    } else if (current) {
      result.set(current, result.get(current) + line + '\n')
    }
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

/**
 * Everything generated from one served spec. `served` is `acquireServedSpec`'s
 * result: the parsed spec, its canonical digest, and the reviewed binary
 * (digest + manifest platform) that served it. The binary is recorded in
 * provenance only: the generated files depend on the spec alone, so another
 * platform's binary serving the same spec reproduces them byte for byte.
 */
export function build(served, pin = PIN) {
  const { spec, specSha256, binarySha256, platform } = served
  const generated = renderProtocol(spec, { tag: pin.tag, commit: pin.commit, specSha256 })
  const configSchema = renderConfigSchema(spec, { tag: pin.tag, commit: pin.commit, specSha256 })
  const provenanceData = {
    version: pin.version,
    tag: pin.tag,
    commit: pin.commit,
    spec: SERVED_SPEC,
    servedSpecSha256: specSha256,
    binarySha256,
    platform,
    specInfo: { title: spec.info?.title, version: spec.info?.version },
    generator: 'scripts/generate-opencode-protocol.mjs',
    generatorVersion: GENERATOR_VERSION,
    counts: {
      schemas: componentNames(spec).length,
      operations: operations(spec).length
    },
    files: { [GENERATED_FILE]: sha256(generated), [CONFIG_SCHEMA_FILE]: sha256(configSchema) }
  }
  const provenance = JSON.stringify(provenanceData, null, 2) + '\n'
  return { generated, provenance, provenanceData, configSchema }
}

/**
 * Why `committed` provenance text is not what `built` would write. The binary
 * that served the spec may be another platform's (`binarySha256` and `platform`
 * are the only fields allowed to differ), but the committed one must name a
 * binary the manifest actually reviewed for its platform.
 */
export function provenanceProblems(committedText, built, reviewed = manifest) {
  let committed
  try {
    committed = JSON.parse(committedText ?? 'null')
  } catch {
    committed = null
  }
  if (!committed) return ['provenance.json is missing or not JSON']
  const problems = []
  const { binarySha256: _b, platform: _p, ...rest } = committed
  const { binarySha256: _bb, platform: _pp, ...expected } = built
  if (JSON.stringify(rest) !== JSON.stringify(expected))
    problems.push('provenance.json differs from the generator output')
  if (committed.binarySha256 !== reviewed.platforms?.[committed.platform]?.binarySha256)
    problems.push(
      `provenance.json names binary ${committed.binarySha256} for ${committed.platform}, which the manifest did not review`
    )
  return problems
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

async function main(argv) {
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

  let served
  try {
    served = await acquireServedSpec()
  } catch (error) {
    throw new Error(
      `${error?.message ?? error}
(the types are generated from the spec the tested opencode binary serves, ` +
        `so ${check ? 'the check' : 'generation'} needs that binary in the managed store)`,
      { cause: error }
    )
  }
  const { generated, provenance, provenanceData, configSchema } = build(served)

  // Informational: where upstream's committed spec has drifted from what the binary serves.
  try {
    const differences = specDifferenceReport(
      specDifferences(JSON.parse(read(UPSTREAM_SPEC_PATH)), served.spec)
    )
    console.log(
      differences.length
        ? `Served spec differs from upstream's committed ${UPSTREAM_SPEC_PATH} at ${PIN.tag} (informational):\n${differences.join('\n')}`
        : `Served spec matches upstream's committed ${UPSTREAM_SPEC_PATH} at ${PIN.tag}`
    )
  } catch (error) {
    console.log(`Upstream's committed spec was not compared: ${error?.message ?? error}`)
  }

  // Paths relative to the repo root.
  const files = [
    [`${OUTPUT_DIR}/${GENERATED_FILE}`, generated],
    [`${OUTPUT_DIR}/${PROVENANCE_FILE}`, provenance],
    [CONFIG_SCHEMA_FILE, configSchema]
  ]
  const committedGenerated = readIfExists(join(root, files[0][0]))
  if (check) {
    for (const [name, text] of files) {
      const current = readIfExists(join(root, name))
      if (name.endsWith(PROVENANCE_FILE)) {
        problems.push(...provenanceProblems(current, provenanceData))
        continue
      }
      if (current === text) continue
      problems.push(`${name} differs from the pinned generator output`)
      if (name.endsWith(GENERATED_FILE) && current) problems.push(...driftReport(current, text))
    }
  } else {
    mkdirSync(destination, { recursive: true })
    for (const [name, text] of files) writeFileSync(join(root, name), text)
    console.log(
      `Generated ${OUTPUT_DIR}/${GENERATED_FILE} and ${CONFIG_SCHEMA_FILE} from the served spec of opencode ${PIN.tag}`
    )
    const drift = committedGenerated ? driftReport(committedGenerated, generated) : []
    console.log(
      drift.length
        ? `Drift in ${GENERATED_FILE} (${drift.length}):\n${drift.join('\n')}`
        : `No drift in ${GENERATED_FILE}`
    )
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else if (check) {
    console.log(
      `opencode protocol matches ${PIN.tag} (served spec + ${EVENT_SOURCES.length} event sources)`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(`opencode protocol generation failed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
