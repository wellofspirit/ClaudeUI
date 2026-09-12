#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import {
  root,
  manifest,
  assertPin,
  cacheValid,
  isolatedEnv,
  verifyVersion,
  sha256
} from './ensure-codex.mjs'

// Only selected methods enter the dependency closure, never the full RPC unions.
export const methods = {
  'account/read': ['GetAccountParams', 'GetAccountResponse'],
  'account/login/start': ['LoginAccountParams', 'LoginAccountResponse'],
  'account/login/cancel': ['CancelLoginAccountParams', 'CancelLoginAccountResponse'],
  'account/logout': [null, 'LogoutAccountResponse'],
  'model/list': ['ModelListParams', 'ModelListResponse'],
  'config/read': ['ConfigReadParams', 'ConfigReadResponse'],
  'configRequirements/read': [null, 'ConfigRequirementsReadResponse'],
  'thread/settings/update': ['ThreadSettingsUpdateParams', 'ThreadSettingsUpdateResponse'],
  // Retries an action the native approval reviewer denied, after a human
  // approves it. Unused by the read-only guardian transcript rows; generated
  // now so the follow-on "approve anyway" slice has the exact payload type.
  'thread/approveGuardianDeniedAction': [
    'ThreadApproveGuardianDeniedActionParams',
    'ThreadApproveGuardianDeniedActionResponse'
  ],
  ...Object.fromEntries(
    ['Start', 'Read', 'Resume', 'Fork', 'List', 'Delete', 'Archive', 'TurnsList', 'ItemsList'].map(
      (name) => [
        `thread/${name
          .replace(/List$/, '/list')
          .replace(/^./, (c) => c.toLowerCase())
          .replace(/^\/list$/, 'list')}`,
        [`Thread${name}Params`, `Thread${name}Response`]
      ]
    )
  ),
  ...Object.fromEntries(
    ['Start', 'Steer', 'Interrupt'].map((name) => [
      `turn/${name.toLowerCase()}`,
      [`Turn${name}Params`, `Turn${name}Response`]
    ])
  )
}
export const serverMethods = {
  'item/commandExecution/requestApproval': [
    'CommandExecutionRequestApprovalParams',
    'CommandExecutionRequestApprovalResponse'
  ],
  'item/fileChange/requestApproval': [
    'FileChangeRequestApprovalParams',
    'FileChangeRequestApprovalResponse'
  ],
  'item/tool/requestUserInput': ['ToolRequestUserInputParams', 'ToolRequestUserInputResponse'],
  'item/permissions/requestApproval': [
    'PermissionsRequestApprovalParams',
    'PermissionsRequestApprovalResponse'
  ],
  'item/tool/call': ['DynamicToolCallParams', 'DynamicToolCallResponse']
}
export const notifications = {
  'account/login/completed': 'AccountLoginCompletedNotification',
  'account/updated': 'AccountUpdatedNotification',
  'thread/started': 'ThreadStartedNotification',
  'thread/status/changed': 'ThreadStatusChangedNotification',
  'thread/settings/updated': 'ThreadSettingsUpdatedNotification',
  'thread/tokenUsage/updated': 'ThreadTokenUsageUpdatedNotification',
  'item/reasoning/summaryTextDelta': 'ReasoningSummaryTextDeltaNotification',
  'item/reasoning/textDelta': 'ReasoningTextDeltaNotification',
  'item/commandExecution/outputDelta': 'CommandExecutionOutputDeltaNotification',
  'turn/started': 'TurnStartedNotification',
  'turn/completed': 'TurnCompletedNotification',
  'item/started': 'ItemStartedNotification',
  'item/completed': 'ItemCompletedNotification',
  // Under `approvalsReviewer: "auto_review"` these REPLACE the client approval
  // requests: no `*/requestApproval` reaches us, so this pair plus
  // `guardianWarning` is the only trace a gated action leaves. Reviews are not
  // thread items, so nothing reconstructs them from history.
  'item/autoApprovalReview/started': 'ItemGuardianApprovalReviewStartedNotification',
  'item/autoApprovalReview/completed': 'ItemGuardianApprovalReviewCompletedNotification',
  guardianWarning: 'GuardianWarningNotification',
  'item/agentMessage/delta': 'AgentMessageDeltaNotification',
  'serverRequest/resolved': 'ServerRequestResolvedNotification'
}
export const roots = [
  'RequestId',
  'InitializeParams',
  'InitializeResponse',
  ...new Set(
    [
      ...Object.values(methods).flat(),
      ...Object.values(serverMethods).flat(),
      ...Object.values(notifications)
    ]
      .filter(Boolean)
      .map((name) => `v2/${name}`)
  )
]

export function checkOutput(destination, files) {
  const actual = readdirSync(destination, { recursive: true })
    .filter((name) => /\.(ts|json)$/.test(String(name)))
    .sort()
  if (
    JSON.stringify(actual) !== JSON.stringify([...files.keys()].sort()) ||
    [...files].some(([name, text]) => readFileSync(join(destination, name), 'utf8') !== text)
  ) {
    throw new Error('Codex protocol drift')
  }
}

function main() {
  const check = process.argv.includes('--check')
  const temp = mkdtempSync(join(tmpdir(), 'codex-protocol-'))
  try {
    assertPin()
    const vendor = join(root, 'vendor/codex-cli')
    if (!cacheValid(vendor)) throw new Error('Run ensure-codex first')
    const binary = join(vendor, 'codex')
    const env = isolatedEnv(temp)
    verifyVersion(binary, temp, env)
    const generated = join(temp, 'generated')
    execFileSync(binary, ['app-server', 'generate-ts', '--experimental', '--out', generated], {
      cwd: temp,
      env,
      timeout: 60000,
      maxBuffer: 65536,
      stdio: ['ignore', 'ignore', 'ignore']
    })
    const files = new Map()
    const schemaDir = join(temp, 'schema')
    execFileSync(
      binary,
      ['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir],
      {
        cwd: temp,
        env,
        timeout: 60000,
        stdio: 'ignore'
      }
    )
    const schemaText = readFileSync(join(schemaDir, 'JSONRPCMessage.json'), 'utf8')
    const methodSchemaHashes = {}
    for (const [name, entries] of [
      ['ClientRequest', methods],
      ['ServerRequest', serverMethods],
      [
        'ServerNotification',
        Object.fromEntries(
          Object.entries(notifications).map(([method, params]) => [method, [params]])
        )
      ]
    ]) {
      const text = readFileSync(join(schemaDir, `${name}.json`), 'utf8')
      methodSchemaHashes[name] = sha256(text)
      const variants = JSON.parse(text).oneOf
      for (const [method, [params]] of Object.entries(entries)) {
        const variant = variants.find((value) => value.properties?.method?.enum?.[0] === method)
        if (!variant || (params && variant.properties.params?.$ref !== `#/definitions/${params}`))
          throw new Error('Method schema mismatch')
      }
    }
    const schema = JSON.parse(schemaText)
    // Intentionally limited to the envelope schema's constructs; new constructs fail closed.
    function type(node) {
      if (node === true) return 'unknown'
      if (
        !node ||
        Object.keys(node).some(
          (key) =>
            ![
              '$schema',
              'title',
              'description',
              'definitions',
              'type',
              'format',
              'anyOf',
              '$ref',
              'properties',
              'required'
            ].includes(key)
        )
      )
        throw new Error('Unsupported envelope schema construct')
      if (node.$ref) return node.$ref.replace('#/definitions/', '')
      if (node.anyOf) return node.anyOf.map(type).join(' | ')
      if (Array.isArray(node.type)) return node.type.map((t) => type({ type: t })).join(' | ')
      if (node.type === 'object')
        return (
          '{ ' +
          Object.entries(node.properties)
            .map(
              ([key, value]) => `${key}${node.required?.includes(key) ? '' : '?'}: ${type(value)}`
            )
            .join('; ') +
          ' }'
        )
      if (node.type === 'integer') return 'number'
      if (['string', 'null', 'boolean', 'number'].includes(node.type)) return node.type
      throw new Error('Unsupported envelope schema construct')
    }
    files.set(
      'envelopes.ts',
      '// GENERATED from pinned app-server generate-json-schema --experimental.\n' +
        'import type { RequestId } from "./RequestId";\n' +
        Object.entries(schema.definitions)
          .filter(([name]) => name !== 'RequestId')
          .map(([name, node]) => `export type ${name} = ${type(node)};\n`)
          .join('') +
        `export type JSONRPCMessage = ${type(schema)};\n`
    )
    const ref = (name) => (name ? `import("./v2/${name}").${name}` : 'undefined')
    files.set(
      'methods.ts',
      '// GENERATED narrow maps; payloads are exact upstream types.\n' +
        [
          ['CodexMethods', methods],
          ['CodexServerMethods', serverMethods]
        ]
          .map(
            ([name, entries]) =>
              `export interface ${name} {\n` +
              Object.entries(entries)
                .map(
                  ([method, [params, result]]) =>
                    `  "${method}": { params: ${ref(params)}; result: ${ref(result)} };\n`
                )
                .join('') +
              '}\n'
          )
          .join('') +
        'export interface CodexNotifications {\n' +
        Object.entries(notifications)
          .map(([method, params]) => `  "${method}": ${ref(params)};\n`)
          .join('') +
        '}\n'
    )
    const pending = roots.map((name) => `${name}.ts`)
    while (pending.length) {
      const name = pending.pop()
      if (files.has(name)) continue
      if (name.startsWith('../') || posix.isAbsolute(name))
        throw new Error('Unsafe generated import')
      const text = readFileSync(join(generated, name), 'utf8')
      files.set(name, text)
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        pending.push(
          posix.normalize(posix.join(posix.dirname(name), match[1].replace(/\.js$/, '') + '.ts'))
        )
      }
    }
    files.set(
      'provenance.json',
      JSON.stringify(
        {
          version: manifest.version,
          sourceCommit: manifest.sourceCommit,
          // The protocol is generated by `codex` alone; the code-mode host is not an input.
          binarySha256: manifest.binaries.codex.binarySha256,
          command: 'app-server generate-ts --experimental',
          envelopeCommand: 'app-server generate-json-schema --experimental',
          envelopeSchemaSha256: sha256(schemaText),
          methodSchemaHashes,
          roots,
          files: Object.fromEntries(
            [...files]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, text]) => [name, sha256(text)])
          )
        },
        null,
        2
      ) + '\n'
    )
    const destination = join(root, 'src/core/codex/protocol')
    if (check) {
      checkOutput(destination, files)
      console.log('Codex protocol matches pinned generator')
    } else {
      rmSync(destination, { recursive: true, force: true })
      for (const [name, text] of files) {
        mkdirSync(dirname(join(destination, name)), { recursive: true })
        writeFileSync(join(destination, name), text)
      }
      console.log(`Generated ${files.size - 1} Codex protocol files`)
    }
  } catch {
    console.error(
      'Codex protocol generation/check failed (pin, version, cache or generated output mismatch)'
    )
    process.exitCode = 1
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
