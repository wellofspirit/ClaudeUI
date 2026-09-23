#!/usr/bin/env node
/** Offline fail-closed patch anchors. Never writes the shared vendor bundle. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const patch = fileURLToPath(new URL('./apply.mjs', import.meta.url))
const original = readFileSync(resolve('vendor/claude-cli/cli.js'), 'utf8')
// The patched copy already has a marker; extract a fresh copy from the cached
// original binary via extract-cli only if the test caller supplies one. For
// reliable CI, construct a small synthetic stream-event lifecycle instead.
const fixture = (name = 'Ae', usage = 'Ln', merge = 'Ple', seed = 'Gp') =>
  `let an=new Set,${usage}=${seed},Hn=null;` +
  `case"stream_event":if(ss.onStreamEvent(${name}),Bs.push(...Ao.onStreamEvent(${name}.event,Ln)),` +
  `!Jn&&(${name}.event.type==="content_block_start"))Jn=performance.now();` +
  `if(${name}.event.type==="message_start"){if(!Io)Io=performance.now();` +
  `${usage}=${merge}(${seed},${name}.event.message.usage)}` +
  `else if(${name}.event.type==="message_delta"){` +
  `${usage}=uVt(${name}.event.usage)?.servedFallbackModel?Atr(${usage},${name}.event.usage):${merge}(${usage},${name}.event.usage)}` +
  `else if(${name}.event.type==="message_stop")Ze=x_t(Ze,${usage});break;case"system":`

const dir = mkdtempSync(join(tmpdir(), 'claudeui-request-usage-anchor-'))
try {
  const path = join(dir, 'cli.js')
  for (const [label, source, shouldPass] of [
    ['current shape', fixture(), true],
    ['minified dollar identifiers', fixture('$e', '$u', '$m', '$g'), true],
    [
      'missing delta accumulation',
      fixture().replace('Ln=uVt(Ae.event.usage)', 'other=uVt(Ae.event.usage)'),
      false
    ],
    [
      'unrelated usage mention',
      fixture().replace(
        'Ln=uVt(Ae.event.usage)?.servedFallbackModel?Atr(Ln,Ae.event.usage):Ple(Ln,Ae.event.usage)',
        'Ln=compute(other),trace(Ae.event.usage)'
      ),
      false
    ],
    [
      'ambiguous stop',
      fixture() + 'else if(Ae.event.type==="message_stop")Ze=x_t(Ze,Ln);break;case"system":',
      false
    ]
  ]) {
    writeFileSync(path, source)
    let passed = true
    try {
      execFileSync(process.execPath, [patch, path], { stdio: 'pipe' })
    } catch {
      passed = false
    }
    assert.equal(passed, shouldPass, label)
    if (shouldPass) {
      const output = readFileSync(path, 'utf8')
      assert.match(output, /PATCHED:request-usage/, label)
      assert.match(output, /_patchRequestModel=.*\.event\.message\.model/, label)
      assert.match(output, /model:_patchRequestModel/, label)
      assert.equal((output.match(/PATCHED:request-usage/g) ?? []).length, 1, label)
    }
  }
  // The output assertion genuinely rejects the unpatched fixture. This is
  // deliberately evaluated inside assert.throws, not against shared vendor.
  assert.throws(() => assert.match(fixture(), /PATCHED:request-usage/))
  assert.ok(original.includes('PATCHED:request-usage'), 'real bundle is patched')
  console.log('request-usage offline anchors: 6/6 passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
