#!/usr/bin/env node
/** Emit request usage at the end of each streamed API response. */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const file = process.argv[2] ? resolve(process.argv[2]) : resolve(root, 'vendor/claude-cli/cli.js')
let src = readFileSync(file, 'utf8')
const marker = '/*PATCHED:request-usage*/'
if (src.includes(marker)) {
  console.log('request-usage already applied')
  process.exit(0)
}
const V = '[\\w$]+'
const esc = (name) => name.replace(/[$]/g, '\\$&')
const unique = (pattern, label) => {
  const matches = [...src.matchAll(new RegExp(pattern, 'g'))]
  if (matches.length !== 1)
    throw Error(`${label}: expected exactly one match, got ${matches.length}`)
  return matches[0]
}

// Scope the message_start to the stream_event branch; capture its event and
// per-request accumulator rather than assuming the current minifier's names.
const start = unique(
  `case"stream_event":if\\(${V}\\.onStreamEvent\\((${V})\\),[^\\n]{0,450}?` +
    `if\\(\\1\\.event\\.type==="message_start"\\)\\{[^\\n]{0,370}?` +
    `(${V})=(${V})\\((${V}),\\1\\.event\\.message\\.usage\\)` +
    `\\}else if\\(\\1\\.event\\.type==="message_delta"\\)`,
  'message_start/usage accumulator'
)
const [, event, usage, merge, initial] = start
const stop = unique(
  `else if\\(${esc(event)}\\.event\\.type==="message_stop"\\)` +
    `(${V})=(${V})\\(\\1,${esc(usage)}\\);break;case"system":`,
  'message_stop/turn accumulator'
)
if (stop.index - start.index < 0 || stop.index - start.index > 1800) {
  throw Error('message_start and message_stop are not in the same stream_event branch')
}
// Ensure deltas feed the same per-request accumulator, not just the initial
// message usage. A different variable would silently emit partial usage.
const deltaStart =
  start.index + start[0].lastIndexOf(`else if(${event}.event.type==="message_delta")`)
if (deltaStart < start.index) throw Error('Cannot locate the message_delta branch')
const between = src.slice(deltaStart, stop.index)
// Upstream conditionally uses an alternate merger for served fallback models.
// Both arms MUST merge the same per-request accumulator with this delta's
// usage; merely mentioning event.usage elsewhere in the branch is insufficient.
const delta = new RegExp(
  `${esc(usage)}=${V}\\(${esc(event)}\\.event\\.usage\\)\\?\\.servedFallbackModel\\?` +
    `${V}\\(${esc(usage)},${esc(event)}\\.event\\.usage\\):` +
    `${esc(merge)}\\(${esc(usage)},${esc(event)}\\.event\\.usage\\)`
)
if (!delta.test(between)) {
  throw Error('message_delta does not merge into the message_start usage accumulator')
}
// The accumulator is initialized at turn entry. Pin the declaration to the
// same branch's immediate enclosing turn (and its original initializer), then
// put the model alongside it. message_start updates the model on EVERY API
// response, including a second request inside the same turn.
const declarationRe = new RegExp(`(?:let |,)${esc(usage)}=${esc(initial)}(?=,)`, 'g')
const declarations = [...src.matchAll(declarationRe)].filter(
  (m) => m.index < start.index && start.index - m.index < 3500
)
if (declarations.length !== 1) throw Error('Cannot prove unique per-turn usage declaration')
const declaration = declarations[0]
const model = '_patchRequestModel'
if (src.includes(model)) throw Error('Request model binding already present without patch marker')
// Splice in descending offset order: edits cannot accidentally move a later
// match. Avoid String.replace replacement-string $ expansion on minified names.
const changes = [
  {
    at: stop.index,
    length: stop[0].length,
    text:
      `else if(${event}.event.type==="message_stop"){${stop[1]}=${stop[2]}(${stop[1]},${usage});` +
      `${marker}process.stdout.write(JSON.stringify({type:"request_usage",usage:${usage},model:${model}})+"\\n")}break;case"system":`
  },
  {
    at:
      start.index + start[0].indexOf(`${usage}=${merge}(${initial},${event}.event.message.usage)`),
    length: `${usage}=${merge}(${initial},${event}.event.message.usage)`.length,
    text: `(${model}=${event}.event.message.model||"",${usage}=${merge}(${initial},${event}.event.message.usage))`
  },
  {
    at: declaration.index + declaration[0].length,
    length: 0,
    text: `,${model}=""`
  }
]
if (changes[1].at < start.index) throw Error('Cannot locate captured message_start assignment')
for (const change of changes.sort((a, b) => b.at - a.at)) {
  src = src.slice(0, change.at) + change.text + src.slice(change.at + change.length)
}
writeFileSync(file, src)
console.log(`request-usage applied (event=${event}, usage=${usage}, turn=${stop[1]})`)
