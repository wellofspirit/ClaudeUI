#!/usr/bin/env node
/**
 * Behavioral test for the automode-verdict patch.
 *
 * Verifies that an auto-mode classifier ALLOW reaches stdout as
 * `system/permission_allowed`, bound to the tool call it cleared. Stock cli.js
 * emits nothing for an allow — only the denial half is on the wire — so an
 * unpatched binary fails the first assertion.
 *
 * ## Why this shape
 *
 * Three things have to line up for the classifier to run at all, and every one
 * of them cost a probe round to discover:
 *
 *  1. `--permission-mode auto`. Implies `--enable-auto-mode`.
 *  2. `settingSources: []`. THE non-obvious one: a developer's own
 *     `~/.claude/settings.json` almost certainly carries broad Bash allow
 *     rules, and a rule allow short-circuits the pipeline long before the
 *     classifier. With user settings loaded the decision comes back
 *     `subcommandResults` and this test silently tests nothing. (The harness
 *     already defaults to `[]`; it is passed explicitly because it is
 *     load-bearing, not incidental.)
 *  3. A command that is neither read-only nor an in-cwd edit. `ls`/`cat` are
 *     cleared by the static safety checker ("Read-only command is allowed");
 *     `mkdir`/`touch` inside the cwd are cleared by fast path A, which asks
 *     "would acceptEdits allow this?" (`docs/protocol-cc/14-auto-mode-classifier.md`
 *     §3). `chmod` is neither, so it reaches the judge — and it is offline and
 *     deterministic, which a `curl` probe is not.
 *
 * Usage: node patch/automode-verdict/test.mjs
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

async function main() {
  const t = new TestRunner('automode-verdict')

  // A throwaway cwd, so the agent cannot reach anything that matters and the
  // classifier judges a file it just made rather than a repo file.
  const cwd = mkdtempSync(join(tmpdir(), 'automode-verdict-'))
  writeFileSync(join(cwd, 'subject.txt'), 'probe\n')

  try {
    console.log('  Starting auto-mode query...')
    const { q, cleanup } = createQuery(
      'Use Bash to run exactly this, nothing else: chmod 600 subject.txt',
      { permissionMode: 'auto', settingSources: [], cwd, effort: 'low' },
      120_000
    )

    const allowed = []
    const denied = []
    const toolUses = []
    const messages = await collectMessages(q, {
      cleanup,
      onMessage: (msg) => {
        if (msg.type === 'system' && msg.subtype === 'permission_allowed') allowed.push(msg)
        if (msg.type === 'system' && msg.subtype === 'permission_denied') denied.push(msg)
        if (msg.type === 'assistant') {
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use') toolUses.push(b)
          }
        }
      }
    })

    dumpMessages(messages)
    if (allowed.length > 0) {
      console.log('  First permission_allowed:', JSON.stringify(allowed[0]).slice(0, 300))
    }

    // 1. The frame exists. This is the patch.
    t.assert('permission_allowed emitted', allowed.length > 0)

    if (allowed.length > 0) {
      const f = allowed[0]

      // 2. Only the judge's allows are emitted. A rule/mode/fast-path allow has
      //    a different (or absent) decisionReason and must stay silent — that
      //    filter is what keeps this from narrating every tool call.
      const types = allowed.map((m) => m.decision_reason_type).join(',')
      t.assert(
        `every frame is a classifier decision (saw: ${types})`,
        allowed.every((m) => m.decision_reason_type === 'classifier')
      )

      // 3. It binds to a real call. A frame a host cannot attach to a card is
      //    worse than no frame: it renders nowhere and looks like a bug.
      t.assert(
        `tool_use_id names a tool_use from this turn (${f.tool_use_id})`,
        typeof f.tool_use_id === 'string' && toolUses.some((b) => b.id === f.tool_use_id)
      )
      t.assert(`tool_name is Bash (saw: ${f.tool_name})`, f.tool_name === 'Bash')

      // 4. Stamped like every other frame — uuid is the host's dedupe key.
      t.assert('uuid is stamped', typeof f.uuid === 'string' && f.uuid.length > 0)
      t.assert('session_id is stamped', typeof f.session_id === 'string' && f.session_id.length > 0)

      // 5. Carries the judge's reason. Upstream's allow reasons are fixed
      //    strings ("Allowed by fast classifier" for a stage-1 clear,
      //    "Allowed by classifier" for a stage-2 one), so this asserts presence
      //    and not wording.
      t.assert(
        `decision_reason is present (${f.decision_reason})`,
        typeof f.decision_reason === 'string' && f.decision_reason.length > 0
      )

      // 6. No `message`: that key is the DENIAL's rejection text, and an allow
      //    has none. An empty one would invite a consumer to render a blank
      //    sentence under the verdict.
      t.assert('no message key on an allow', f.message === undefined)
    }

    // 7. The denial half still works — the patch adds a branch, it must not
    //    have disturbed the one that was already there.
    if (denied.length > 0) {
      t.assert(
        'any denial still carries its reason type',
        denied.every((m) => typeof m.decision_reason_type === 'string')
      )
    }

    if (!t.summarize()) process.exitCode = 1
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
