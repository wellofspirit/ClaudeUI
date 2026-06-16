#!/usr/bin/env node
/**
 * Generate plain-TypeScript protocol types for the Codex app-server protocol.
 *
 * Two-phase approach:
 *   Phase 1 (one-time): Download the openai/codex repo archive at the pinned
 *     codexProtocolRef and cache it under .cache/codex-schema/. This avoids
 *     making hundreds of individual GitHub API calls (which hit rate limits quickly).
 *   Phase 2: Read JSON schema files from the local cache and generate TS.
 *
 * Outputs (checked in — build is hermetic, diffs are reviewable on version bumps):
 *   src/main/codex/protocol/schema.ts  — TS interfaces/types for all definitions
 *   src/main/codex/protocol/methods.ts — method catalog with typed param/response maps
 *   src/main/codex/protocol/index.ts   — barrel re-export
 *
 * Run:
 *   node scripts/generate-codex-protocol.mjs
 *   node scripts/generate-codex-protocol.mjs --force   # re-download archive
 */

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, createWriteStream
} from 'node:fs'
import { get as httpsGet } from 'node:https'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const OUT_DIR = join(ROOT, 'src', 'main', 'codex', 'protocol')
const CACHE_DIR = join(ROOT, '.cache', 'codex-schema')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PROTOCOL_REF = pkg.codexProtocolRef
if (!PROTOCOL_REF) throw new Error('package.json#codexProtocolRef is not set')

function log(...args) { console.log('[generate-codex-protocol]', ...args) }

// ---------------------------------------------------------------------------
// Download & cache the repo archive
// ---------------------------------------------------------------------------

function fetchBinary(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    httpsGet(url, { headers: { 'User-Agent': 'claudeui-codex-protocol-gen/1.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (redirects > 5) return reject(new Error('too many redirects'))
        return resolve(fetchBinary(res.headers.location, outPath, redirects + 1))
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} → ${res.statusCode}`))
      const total = parseInt(res.headers['content-length'] || '0', 10)
      let seen = 0
      const ws = createWriteStream(outPath)
      res.on('data', chunk => {
        seen += chunk.length
        if (total) process.stdout.write(`\r  downloading ${(seen / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB…  `)
      })
      res.pipe(ws)
      ws.on('finish', () => { process.stdout.write('\n'); ws.close(resolve) })
      ws.on('error', reject)
    }).on('error', reject)
  })
}

async function ensureSchemaCache(force) {
  mkdirSync(CACHE_DIR, { recursive: true })
  const archivePath = join(CACHE_DIR, `${PROTOCOL_REF.slice(0, 12)}.tar.gz`)
  const extractedDir = join(CACHE_DIR, `extracted-${PROTOCOL_REF.slice(0, 12)}`)
  const schemaDir = join(extractedDir, 'codex-rs', 'app-server-protocol', 'schema', 'json')

  if (!force && existsSync(schemaDir)) {
    log(`schema cache hit: ${schemaDir}`)
    return schemaDir
  }

  const url = `https://github.com/openai/codex/archive/${PROTOCOL_REF}.tar.gz`
  log(`downloading repo archive at ${PROTOCOL_REF.slice(0, 12)}…`)
  await fetchBinary(url, archivePath)
  log(`extracting archive…`)
  mkdirSync(extractedDir, { recursive: true })
  execSync(`tar xf "${archivePath}" -C "${extractedDir}" --strip-components=1`, { stdio: 'pipe' })
  log(`schema dir: ${schemaDir}`)
  return schemaDir
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeScript converter
//
// Goals:
//   - Emit plain TS interfaces/type aliases — no Effect, no Zod, no validators.
//   - Stable alphabetical ordering so re-runs produce clean diffs.
//   - Resolve $ref within the same file's definitions context; cross-file refs
//     use the qualified (V1/V2-prefixed) name.
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema node to a TypeScript type expression.
 * @param schema     The JSON Schema node.
 * @param resolveRef (localRefName) => qualified TS type name. Resolves a
 *                   `#/definitions/<name>` ref to the aggregate's qualified name.
 * @param indent     Current indent depth.
 */
function schemaToTs(schema, resolveRef, indent = 0) {
  if (!schema || typeof schema !== 'object') return 'unknown'
  const pad = '  '.repeat(indent)

  // $ref
  if (schema.$ref) {
    const localName = schema.$ref.replace('#/definitions/', '')
    return resolveRef(localName) ?? localName
  }

  // anyOf / oneOf → union
  const unionKey = schema.anyOf ? 'anyOf' : schema.oneOf ? 'oneOf' : null
  if (unionKey) {
    const variants = schema[unionKey]
    const nonNull = variants.filter(v => v.type !== 'null')
    const hasNull = variants.some(v => v.type === 'null')
    const types = nonNull.map(v => schemaToTs(v, resolveRef, indent))
    const unique = [...new Set(types)]
    let base
    if (unique.length === 1) {
      base = unique[0]
    } else {
      const complex = unique.some(t => t.startsWith('{') || t.includes('\n'))
      if (complex) {
        base = `(\n${pad}  | ${unique.join(`\n${pad}  | `)}\n${pad})`
      } else {
        base = unique.join(' | ')
      }
    }
    return hasNull ? `${base} | null` : base
  }

  // allOf → intersection
  if (schema.allOf) {
    const types = schema.allOf.map(v => schemaToTs(v, resolveRef, indent))
    return [...new Set(types)].join(' & ')
  }

  // enum
  if (schema.enum) {
    return schema.enum
      .map(v => typeof v === 'string' ? JSON.stringify(v) : String(v))
      .join(' | ')
  }

  // type-based primitives
  const type = schema.type
  if (type === 'string') return 'string'
  if (type === 'integer' || type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  if (type === 'null') return 'null'

  if (type === 'array') {
    const item = schema.items ? schemaToTs(schema.items, resolveRef, indent) : 'unknown'
    // Wrap complex item types in parens
    const needsParens = item.includes(' | ') || item.includes(' & ') || item.startsWith('{')
    return needsParens ? `Array<(${item})>` : `Array<${item}>`
  }

  if (type === 'object' || schema.properties) {
    const props = schema.properties || {}
    const required = new Set(schema.required || [])
    const lines = Object.entries(props).map(([key, val]) => {
      const opt = required.has(key) ? '' : '?'
      const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
      const tsType = schemaToTs(val, resolveRef, indent + 1)
      return `${pad}  readonly ${safeKey}${opt}: ${tsType};`
    })

    let indexSig = ''
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const valType = schemaToTs(schema.additionalProperties, resolveRef, indent + 1)
      indexSig = `\n${pad}  readonly [key: string]: ${valType};`
    } else if (schema.additionalProperties === true) {
      indexSig = `\n${pad}  readonly [key: string]: unknown;`
    }

    if (lines.length === 0 && !indexSig) return 'Record<string, unknown>'
    return `{\n${lines.join('\n')}${indexSig}\n${pad}}`
  }

  // No type info
  return 'unknown'
}

// ---------------------------------------------------------------------------
// Schema file collection
// ---------------------------------------------------------------------------

const SKIP_FILES = new Set([
  'codex_app_server_protocol.schemas.json',
  'codex_app_server_protocol.v2.schemas.json',
  // JSONRPC envelope types are implementation details; keep RequestId as it's
  // referenced by notification payloads.
  'JSONRPCError.json',
  'JSONRPCErrorError.json',
  'JSONRPCMessage.json',
  'JSONRPCNotification.json',
  'JSONRPCRequest.json',
  'JSONRPCResponse.json',
])

// The 4 method-catalog files. Their `definitions` are collected like any other
// file, but their top-level `oneOf` union is NOT emitted as a named type — the
// generated method catalog (CLIENT_REQUEST_METHODS etc.) supersedes it.
const METHOD_FILES = new Set([
  'ClientRequest.json',
  'ClientNotification.json',
  'ServerRequest.json',
  'ServerNotification.json',
])

/** Read all JSON schema files in a directory (non-recursive). */
function readSchemaDir(dir) {
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && !SKIP_FILES.has(f))
    .sort()
    .map(f => ({ name: f, schema: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
}

/** Does a schema node carry a top-level shape worth emitting as a named type? */
function hasTopLevelShape(schema) {
  return Boolean(
    schema.properties || schema.oneOf || schema.anyOf || schema.allOf ||
    schema.type || schema.enum || schema.$ref
  )
}

/**
 * Collect all definitions from each schema file into the aggregate map, PLUS
 * the file's own top-level schema (named after the file's base name).
 *
 * The file-top-level types are the response/notification/param payloads that
 * have no other home: e.g. v2/ThreadStartResponse.json's top-level object is
 * the *only* place ThreadStartResponse is defined — it is not a `definitions`
 * entry anywhere. Method files (ClientRequest/ServerRequest/…) reference some
 * of these as `definitions`, so first-wins dedup keeps the two consistent.
 *
 * Mirrors t3code's generator (`aggregateSchemas[file.exportName] = topLevel`).
 *
 * @param prefix  '' | 'V1' | 'V2'
 */
function collectDefinitions(files, prefix, aggregate) {
  for (const { name, schema } of files) {
    // 1. Each file's `definitions` map.
    for (const [localName, defSchema] of Object.entries(schema.definitions ?? {})) {
      const qualifiedName = prefix ? `${prefix}${localName}` : localName
      if (!(qualifiedName in aggregate)) {
        aggregate[qualifiedName] = { schema: defSchema, prefix }
      }
    }

    // 2. The file's own top-level schema, named after the file. This is where
    //    response types (and standalone param/notification types) live.
    //    Skip the 4 method-catalog files — their top-level `oneOf` is the whole
    //    request/notification union, which the method catalog supersedes.
    if (!METHOD_FILES.has(name)) {
      const { definitions: _ignored, $schema: _ignored2, ...topLevel } = schema
      if (hasTopLevelShape(topLevel)) {
        const baseName = name.replace(/\.json$/, '')
        const qualifiedName = prefix ? `${prefix}${baseName}` : baseName
        if (!(qualifiedName in aggregate)) {
          aggregate[qualifiedName] = { schema: topLevel, prefix }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Method catalog extraction
// ---------------------------------------------------------------------------

function extractMethods(schema) {
  return (schema.oneOf ?? []).map(variant => {
    const method =
      variant.properties?.method?.enum?.[0] ??
      variant.properties?.method?.const ??
      null
    if (!method) return null
    const params = variant.properties?.params
    // params may be: a $ref to a named type, an inline `{ type: 'null' }`
    // (no-arg method), or absent entirely.
    const paramsRef = params?.$ref
    const localParamsName = paramsRef?.replace('#/definitions/', '') ?? null
    // Methods declaring `params: { type: 'null' }` take no payload → `null`.
    const isNullParams = !paramsRef && params?.type === 'null'
    return { method, localParamsName, isNullParams }
  }).filter(Boolean)
}

/** Resolve a locally-named definition to its qualified name in the aggregate. */
function resolveQualified(localName, prefix, aggregate) {
  if (!localName) return null
  const candidates = [
    prefix ? `${prefix}${localName}` : null,
    `V2${localName}`,
    `V1${localName}`,
    localName,
  ].filter(Boolean)
  for (const c of candidates) {
    if (c in aggregate) return c
  }
  return localName
}

/** Derive the response type name for a request given the params name. */
function deriveResponseName(method, paramsQualified, aggregate) {
  // Well-known overrides
  const overrides = {
    'account/logout': ['V2LogoutAccountResponse', 'LogoutAccountResponse'],
    'account/rateLimits/read': ['V2GetAccountRateLimitsResponse', 'GetAccountRateLimitsResponse'],
    'account/usage/read': ['V2GetAccountTokenUsageResponse', 'GetAccountTokenUsageResponse'],
    'config/batchWrite': ['V2ConfigWriteResponse', 'ConfigWriteResponse'],
    'config/mcpServer/reload': ['V2McpServerRefreshResponse', 'McpServerRefreshResponse'],
    'config/value/write': ['V2ConfigWriteResponse', 'ConfigWriteResponse'],
    'configRequirements/read': ['V2ConfigRequirementsReadResponse', 'ConfigRequirementsReadResponse'],
    'windowsSandbox/readiness': ['V2WindowsSandboxReadinessResponse'],
  }
  const candidates = overrides[method]
  if (candidates) {
    for (const c of candidates) {
      if (c in aggregate) return c
    }
  }

  // Derive from params: V2FooParams → V2FooResponse
  if (paramsQualified) {
    const fromParams = paramsQualified.replace(/Params$/, 'Response')
    if (fromParams in aggregate) return fromParams
    // Try stripping/adding prefix
    for (const p of ['V2', 'V1', '']) {
      const stripped = fromParams.replace(/^V[12]/, '')
      const c = `${p}${stripped}`
      if (c in aggregate) return c
    }
  }

  // Derive from method string
  const pascalMethod = method
    .split('/')
    .flatMap(s => s.split(/[-_]/))
    .filter(Boolean)
    .map(s => s[0].toUpperCase() + s.slice(1))
    .join('')
  for (const p of ['V2', 'V1', '']) {
    const c = `${p}${pascalMethod}Response`
    if (c in aggregate) return c
  }

  return null
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

const HEADER = `\
// Generated by scripts/generate-codex-protocol.mjs — do not edit by hand.
// Source: openai/codex codex-rs/app-server-protocol at ${PROTOCOL_REF}
// Regenerate: bun run generate-codex-protocol (when bumping codexCliVersion)
`

function generateSchemaTs(aggregate) {
  const lines = [HEADER, '']
  const sortedNames = Object.keys(aggregate).sort()

  // Skip JSONRPC plumbing envelope types (they're in SKIP_FILES so not collected,
  // but guard here for any inline definitions in the main schema files)
  const skipDefs = new Set(['JSONRPCMessage', 'JSONRPCError', 'JSONRPCErrorError',
    'JSONRPCNotification', 'JSONRPCRequest', 'JSONRPCResponse'])

  for (const qname of sortedNames) {
    if (skipDefs.has(qname) || skipDefs.has(qname.replace(/^V[12]/, ''))) continue

    const { schema, prefix } = aggregate[qname]

    // Resolve `#/definitions/<name>` refs to qualified names. We don't track the
    // exact source file per definition, so resolveQualified tries the def's own
    // prefix first, then V2/V1/bare — which is unambiguous in practice because
    // versioned types only ref same-version or shared root types.
    const resolveRef = (localRef) => resolveQualified(localRef, prefix, aggregate)

    const tsType = schemaToTs(schema, resolveRef, 0)
    if (!tsType || tsType === 'unknown') continue // skip pure-unknown defs

    if (tsType.startsWith('{')) {
      lines.push(`export interface ${qname} ${tsType}`, '')
    } else {
      lines.push(`export type ${qname} = ${tsType};`, '')
    }
  }

  return lines.join('\n')
}

function generateMethodsTs(clientReqs, clientNotifs, serverReqs, serverNotifs, aggregate) {
  const lines = [HEADER, '', `import type * as S from './schema';`, '']

  function methodConst(constName, entries) {
    lines.push(`export const ${constName} = {`)
    for (const e of entries) {
      lines.push(`  ${JSON.stringify(e.method)}: ${JSON.stringify(e.method)},`)
    }
    lines.push('} as const;', '')
  }

  methodConst('CLIENT_REQUEST_METHODS', clientReqs)
  methodConst('CLIENT_NOTIFICATION_METHODS', clientNotifs)
  methodConst('SERVER_REQUEST_METHODS', serverReqs)
  methodConst('SERVER_NOTIFICATION_METHODS', serverNotifs)

  lines.push(
    `export type ClientRequestMethod = keyof typeof CLIENT_REQUEST_METHODS;`,
    `export type ClientNotificationMethod = keyof typeof CLIENT_NOTIFICATION_METHODS;`,
    `export type ServerRequestMethod = keyof typeof SERVER_REQUEST_METHODS;`,
    `export type ServerNotificationMethod = keyof typeof SERVER_NOTIFICATION_METHODS;`,
    '',
  )

  function typeRef(name) {
    if (!name || !(name in aggregate)) return 'unknown'
    return `S.${name}`
  }

  // Param type for a method entry: a named type, `null` (no-arg methods that
  // declare `params: { type: 'null' }`), or `undefined` (no params field).
  function paramTypeRef(e) {
    if (e.localParamsName) return typeRef(resolveQualified(e.localParamsName, '', aggregate))
    if (e.isNullParams) return 'null'
    return 'undefined'
  }

  // Response type for a request entry, derived from the schema definition names.
  function responseTypeRef(e) {
    const paramsQ = e.localParamsName ? resolveQualified(e.localParamsName, '', aggregate) : null
    return typeRef(deriveResponseName(e.method, paramsQ, aggregate))
  }

  function renderInterface(name, entries, typeFn) {
    lines.push(`export interface ${name} {`)
    for (const e of entries) {
      lines.push(`  readonly ${JSON.stringify(e.method)}: ${typeFn(e)};`)
    }
    lines.push('}', '')
  }

  // params come from the method file's own definitions (resolved prefix-bare)
  renderInterface('ClientRequestParamsByMethod', clientReqs, paramTypeRef)
  renderInterface('ClientRequestResponsesByMethod', clientReqs, responseTypeRef)
  renderInterface('ClientNotificationParamsByMethod', clientNotifs, paramTypeRef)
  renderInterface('ServerRequestParamsByMethod', serverReqs, paramTypeRef)
  renderInterface('ServerRequestResponsesByMethod', serverReqs, responseTypeRef)
  renderInterface('ServerNotificationParamsByMethod', serverNotifs, paramTypeRef)

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const force = process.argv.includes('--force')
  mkdirSync(OUT_DIR, { recursive: true })

  const schemaDir = await ensureSchemaCache(force)
  const v1Dir = join(schemaDir, 'v1')
  const v2Dir = join(schemaDir, 'v2')

  log('reading schema files…')
  const rootFiles = readSchemaDir(schemaDir)
  const v1Files = existsSync(v1Dir) ? readSchemaDir(v1Dir) : []
  const v2Files = existsSync(v2Dir) ? readSchemaDir(v2Dir) : []

  log(`schema files: root=${rootFiles.length}, v1=${v1Files.length}, v2=${v2Files.length}`)

  // Collect definitions — order matters: v1 then v2 then root
  // (later insertions skip duplicates, so root defs that share a name with v1/v2
  // will lose to the versioned one — this matches t3code's behavior)
  const aggregate = {}
  collectDefinitions(v1Files, 'V1', aggregate)
  collectDefinitions(v2Files, 'V2', aggregate)
  collectDefinitions(rootFiles, '', aggregate)

  log(`total definitions: ${Object.keys(aggregate).length}`)

  // Method catalog
  const getSchema = (name) => rootFiles.find(f => f.name === name)?.schema
  const clientReqs = extractMethods(getSchema('ClientRequest.json') ?? {})
  const clientNotifs = extractMethods(getSchema('ClientNotification.json') ?? {})
  const serverReqs = extractMethods(getSchema('ServerRequest.json') ?? {})
  const serverNotifs = extractMethods(getSchema('ServerNotification.json') ?? {})

  log(`methods: clientReq=${clientReqs.length}, clientNotif=${clientNotifs.length}, serverReq=${serverReqs.length}, serverNotif=${serverNotifs.length}`)

  // Generate files
  const schemaContent = generateSchemaTs(aggregate)
  const methodsContent = generateMethodsTs(clientReqs, clientNotifs, serverReqs, serverNotifs, aggregate)
  const indexContent = [
    HEADER,
    `export * from './schema';`,
    `export * from './methods';`,
    '',
  ].join('\n')

  writeFileSync(join(OUT_DIR, 'schema.ts'), schemaContent)
  writeFileSync(join(OUT_DIR, 'methods.ts'), methodsContent)
  writeFileSync(join(OUT_DIR, 'index.ts'), indexContent)

  const schemaLines = schemaContent.split('\n').length
  const methodsLines = methodsContent.split('\n').length
  log(`wrote schema.ts (${schemaLines} lines), methods.ts (${methodsLines} lines), index.ts`)

  console.log('\nProtocol surface:')
  console.log(`  client→server requests:      ${clientReqs.length}`)
  console.log(`  client→server notifications: ${clientNotifs.length}`)
  console.log(`  server→client requests:      ${serverReqs.length}`)
  console.log(`  server→client notifications: ${serverNotifs.length}`)
  console.log(`  total type definitions:      ${Object.keys(aggregate).length}`)
}

main().catch(err => {
  console.error(`\n[generate-codex-protocol] FAIL: ${err.message}`)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
