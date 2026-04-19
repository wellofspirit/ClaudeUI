#!/usr/bin/env node
/**
 * One-shot: strip "Part B (sdk.mjs)" sections from the 4 patches that add
 * methods to sdk.mjs. Those methods are now implemented natively in
 * src/main/sdk/, so the sdk.mjs patching is obsolete.
 *
 * Keeps Part A (cli.js patching) intact. Appends a terse summary.
 *
 * Idempotent: if no "Part B" block is found, leaves the file alone.
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PATCH_DIR = resolve(__dirname, '..', 'patch')

const targets = [
  {
    dir: 'voice-server',
    summary: [
      'Part A (cli.js): voice_server_start / voice_server_stop control requests.',
      'Part B (sdk.mjs) was removed — voiceServerStart/voiceServerStop live in src/main/sdk/.',
    ],
  },
  {
    dir: 'usage-relay',
    summary: [
      'Part A (cli.js): get_usage control-request handler (calls internal OAuth usage API).',
      'Part B (sdk.mjs) was removed — getUsage() lives in src/main/sdk/.',
    ],
  },
  {
    dir: 'queue-control',
    summary: [
      'Part A (cli.js): dequeue_message control-request + queued_command_consumed notification.',
      'Part B (sdk.mjs) was removed — dequeueMessage() lives in src/main/sdk/.',
    ],
  },
  {
    dir: 'background-task',
    summary: [
      'Part A (cli.js): background_task control-request handler (backgrounds running bash/agent tasks).',
      'Part B (sdk.mjs) was removed — backgroundTask() lives in src/main/sdk/.',
    ],
  },
]

for (const { dir, summary } of targets) {
  const p = join(PATCH_DIR, dir, 'apply.mjs')
  const src = readFileSync(p, 'utf8')

  // Find the header line that delimits Part B.
  const partBHeader = src.indexOf('// Part B: Patch sdk.mjs')
  if (partBHeader === -1) {
    console.log(`[skip] ${dir}: no Part B marker — already stripped?`)
    continue
  }
  // The Part B section is preceded by a ==== divider; trim back to the blank
  // line before that divider so we leave a clean Part A ending.
  // The divider line (===...===) is just above partBHeader.
  const dividerAbove = src.lastIndexOf(
    '// =================',
    partBHeader,
  )
  if (dividerAbove === -1) {
    console.error(`[fail] ${dir}: could not locate Part B divider`)
    process.exit(1)
  }
  // Walk back over the preceding blank lines/comments so Part A ends at its
  // own closing brace/marker, not mid-comment.
  let cut = dividerAbove
  while (cut > 0 && /\s/.test(src[cut - 1])) cut--

  // Strip `const sdkPath = …` line, since Part B is the only consumer.
  let head = src.slice(0, cut)
  head = head.replace(
    /\nconst sdkPath = resolve\([^\n]*\n/,
    '\n',
  )

  const tail =
    '\n\nconsole.log(\'\')\n' +
    'console.log(\'What this does:\')\n' +
    summary.map((s) => `console.log('  ${s.replace(/'/g, "\\'")}')`).join('\n') +
    '\n'

  const next = head.trimEnd() + tail
  writeFileSync(p, next)
  console.log(
    `[done] ${dir}: removed ${(src.length - next.length).toLocaleString()} bytes of Part B`,
  )
}
