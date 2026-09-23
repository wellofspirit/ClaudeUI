#!/usr/bin/env node
/**
 * Behavioral test for the automode-verdict patch.
 *
 * Verifies that an auto-mode classifier ALLOW reaches stdout as
 * `system/permission_allowed`, bound to the tool call it cleared. Stock cli.js
 * emits nothing for an allow — only the denial half is on the wire — so an
 * unpatched binary fails the first assertion.
 *
 * ## Two paths, ClaudeUI's first
 *
 * cli.js builds a different permission wrapper depending on the flags:
 *
 *  - `--permission-prompt-tool stdio` → the stdio wrapper (edit C1). This is
 *    ClaudeUI's LIVE path: `src/core/sdk/args.ts` passes the flag whenever
 *    `canUseTool` is set, and ClaudeSession always sets it. The harness answers
 *    any `can_use_tool` escalation with a deny so the turn cannot hang.
 *  - no prompt tool → the other wrapper (edit C2).
 *
 * The same trigger runs once on each, stdio first. A patch that only reaches
 * one of them fails the other's assertions.
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
 *  3. A command the fast paths don't clear. `ls`/`cat` are cleared by the
 *     static safety checker ("Read-only command is allowed"); `mkdir`/`touch`
 *     inside the cwd are cleared by fast path A ("would acceptEdits allow
 *     this?", `docs/protocol-cc/14-auto-mode-classifier.md` §3). On 2.1.280 an
 *     in-cwd `chmod` no longer reaches the classifier either. A network read,
 *     `curl -sI https://example.com`, does — so this test needs network.
 *
 * Usage: node patch/automode-verdict/test.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const PROMPT = 'Use Bash to run exactly this, nothing else: curl -sI https://example.com'

/**
 * Run the trigger once and assert on what reached stdout.
 *
 * @param {TestRunner} t
 * @param {string} label   prefix for every assertion, names the wrapper under test
 * @param {object} extra   extra createQuery options selecting the wrapper
 */
async function runScenario(t, label, extra) {
  // A throwaway cwd, so the agent cannot reach anything that matters.
  const cwd = mkdtempSync(join(tmpdir(), 'automode-verdict-'))

  try {
    console.log(`  [${label}] starting auto-mode query...`)
    const { q, cleanup } = createQuery(
      PROMPT,
      { permissionMode: 'auto', settingSources: [], cwd, effort: 'low', ...extra },
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
    for (const f of allowed) console.log(`  [${label}] permission_allowed:`, JSON.stringify(f))
    for (const f of denied) console.log(`  [${label}] permission_denied:`, JSON.stringify(f))
    if (q.canUseToolRequests.length > 0) {
      console.log(
        `  [${label}] can_use_tool escalations auto-denied: ${q.canUseToolRequests.length}`
      )
    }

    // 1. The frame exists. This is the patch.
    t.assert(`[${label}] permission_allowed emitted`, allowed.length > 0)

    if (allowed.length > 0) {
      const f = allowed[0]

      // 2. Only the judge's allows are emitted. A rule/mode/fast-path allow has
      //    a different (or absent) decisionReason and must stay silent — that
      //    filter is what keeps this from narrating every tool call.
      const types = allowed.map((m) => m.decision_reason_type).join(',')
      t.assert(
        `[${label}] every frame is a classifier decision (saw: ${types})`,
        allowed.every((m) => m.decision_reason_type === 'classifier')
      )

      // 3. …and only the ones where it reached a verdict. A no-verdict allow
      //    ("Delivered with a note: the classifier could not review it") is
      //    gated out, so `no_verdict` must never ride on a permission_allowed.
      t.assert(
        `[${label}] no permission_allowed carries no_verdict`,
        allowed.every((m) => !('no_verdict' in m))
      )
      //    The gate is cli.js's own `classifierAllowed`, so the allows it never
      //    stamps can't appear either: the classifier never ran, it reached no
      //    verdict, or it blocked and a flag-policy tool delivered anyway.
      t.assert(
        `[${label}] no permission_allowed carries a non-verdict reason`,
        allowed.every(
          (m) =>
            m.decision_reason !== 'Tool declares no classifier-relevant input' &&
            !/^(Delivered with a |Flagged by the classifier)/.test(m.decision_reason ?? '')
        )
      )

      // 4. It binds to a real call. A frame a host cannot attach to a card is
      //    worse than no frame: it renders nowhere and looks like a bug.
      t.assert(
        `[${label}] tool_use_id names a tool_use from this turn (${f.tool_use_id})`,
        typeof f.tool_use_id === 'string' && toolUses.some((b) => b.id === f.tool_use_id)
      )
      t.assert(`[${label}] tool_name is Bash (saw: ${f.tool_name})`, f.tool_name === 'Bash')

      // 5. Stamped like every other frame — uuid is the host's dedupe key.
      t.assert(`[${label}] uuid is stamped`, typeof f.uuid === 'string' && f.uuid.length > 0)
      t.assert(
        `[${label}] session_id is stamped`,
        typeof f.session_id === 'string' && f.session_id.length > 0
      )

      // 6. Carries the judge's reason. Upstream's allow reasons are fixed
      //    strings ("Allowed by fast classifier" for a stage-1 clear,
      //    "Allowed by classifier" for a stage-2 one), so this asserts presence
      //    and not wording.
      t.assert(
        `[${label}] decision_reason is present (${f.decision_reason})`,
        typeof f.decision_reason === 'string' && f.decision_reason.length > 0
      )

      // 7. No `message`: that key is the DENIAL's rejection text, and an allow
      //    has none. An empty one would invite a consumer to render a blank
      //    sentence under the verdict.
      t.assert(`[${label}] no message key on an allow`, f.message === undefined)
    }

    // 8. The denial half still works — the patch rewrites that emitter too,
    //    and must not have disturbed what was already there.
    if (denied.length > 0) {
      t.assert(
        `[${label}] any denial still carries its reason type`,
        denied.every((m) => typeof m.decision_reason_type === 'string')
      )
      t.assert(
        `[${label}] any denial's no_verdict is absent or exactly true`,
        denied.every((m) => !('no_verdict' in m) || m.no_verdict === true)
      )
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function main() {
  const t = new TestRunner('automode-verdict')

  // ClaudeUI's live path (edit C1).
  await runScenario(t, 'stdio', { permissionPromptTool: 'stdio' })
  // Hosts with no permission-prompt tool (edit C2).
  await runScenario(t, 'no-prompt-tool', {})

  if (!t.summarize()) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
