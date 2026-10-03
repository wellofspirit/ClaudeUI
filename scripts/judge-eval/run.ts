/**
 * Replay the auto-mode judge cases (./cases.ts) against a LIVE judge model and
 * report each verdict against the policy's intent (ADR-091).
 *
 *   bun scripts/judge-eval/run.ts [--runs 3] [--model openai-codex/gpt-6-luna]
 *     [--engine pi] [--case '#4'] [--root <repo checkout>] [--json <out>]
 *
 * `--root` swaps in ANOTHER checkout's classifier, policy and redirect
 * measurement (e.g. a worktree at a pre-change commit) while the cases and the
 * judge route stay this checkout's — the before/after comparison. The judge is
 * called through ClaudeUI's own route resolver (the vault on disk), exactly as a
 * session calls it; nothing here prints a header, key or token.
 *
 * Every run costs real judge calls (stage 1, plus stage 2 when stage 1 blocks).
 */
import { parseArgs } from 'node:util'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { makeHttpJudgeTransport } from '../../src/core/automode/judge-http/transport'
import { resolveJudgeRoute, type JudgeEngine } from '../../src/core/automode/judge-route'
import type { ChatMessage } from '../../src/shared/types'
import { CASES, CWD, DELEGATED_CASES, type EvalCase } from './cases'

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: 'openai-codex/gpt-6-luna' },
    engine: { type: 'string', default: 'pi' },
    case: { type: 'string', multiple: true },
    root: { type: 'string', default: resolve(import.meta.dir, '../..') },
    json: { type: 'string' },
    concurrency: { type: 'string', default: '4' }
  }
})

const root = resolve(args.root!)
const classifier = await import(`${root}/src/core/automode/classifier.ts`)
const groundTruth = await import(`${root}/src/core/automode/ground-truth.ts`)
// Absent before ADR-091: the pre-change judge read parent + trajectory only.
const trajectoryMod = await import(`${root}/src/core/automode/trajectory.ts`)
const hasTimeOrder = typeof trajectoryMod.inTimeOrder === 'function'

const judge = makeHttpJudgeTransport({
  resolve: () => resolveJudgeRoute(args.engine as JudgeEngine, args.model!),
  userAgent: 'ClaudeUI-judge-eval'
})

const environment = {
  cwd: CWD,
  platform: 'darwin',
  remotes: [{ name: 'origin', url: 'git@github.com:example/vnc-probe.git' }],
  repoVisibility: 'private'
}

/** The transcript the judge reads — for a delegated case, as THIS root builds it. */
function transcriptFor(c: EvalCase): ChatMessage[] {
  if (!c.delegated) return c.messages
  const { parent, queued, trajectory } = c.delegated
  return hasTimeOrder
    ? trajectoryMod.inTimeOrder(parent, queued, trajectory)
    : [...parent, ...trajectory]
}

function actionMetaFor(c: EvalCase): Record<string, unknown> | undefined {
  if (!c.measureRedirects) return undefined
  // A pre-ADR-091 tempDirRoots takes no platform and ignores the argument.
  const tempDirs = groundTruth.tempDirRoots({ TMPDIR: '/var/folders/x1/abc/T/' }, 'darwin')
  const redirects = groundTruth.analyzeRedirects(
    c.measureRedirects,
    { cwd: CWD, tempDirs },
    'darwin'
  )
  return redirects ? { redirects } : undefined
}

interface RunResult {
  block: boolean
  stage: string
  category?: string
  reason?: string
  error?: string
}

async function runOnce(c: EvalCase): Promise<RunResult> {
  const result = await classifier.classify(
    {
      messages: transcriptFor(c),
      action: c.action,
      environment,
      ...(c.outcomes ? { outcomes: c.outcomes } : {}),
      ...(actionMetaFor(c) ? { actionMeta: actionMetaFor(c) } : {})
    },
    judge
  )
  return {
    block: result.block,
    stage: result.stage,
    ...(result.category ? { category: result.category } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.error ? { error: result.error } : {})
  }
}

/** Bounded-concurrency map, results in input order. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    })
  )
  return out
}

const runs = Number(args.runs)
const wanted = args.case?.length ? new Set(args.case) : null
const cases = [...CASES, ...DELEGATED_CASES].filter((c) => !wanted || wanted.has(c.id))
const jobs = cases.flatMap((c) => Array.from({ length: runs }, () => c))

console.log(
  `judge-eval: ${cases.length} cases × ${runs} runs, model ${args.model} (${args.engine}), root ${root}${hasTimeOrder ? '' : ' [pre-ADR-091 transcript order]'}`
)
const results = await pool(jobs, Number(args.concurrency), async (c) => {
  try {
    return { id: c.id, r: await runOnce(c) }
  } catch (err) {
    return { id: c.id, r: { block: true, stage: 'error', error: String(err) } as RunResult }
  }
})

const report = cases.map((c) => {
  const mine = results.filter((x) => x.id === c.id).map((x) => x.r)
  const verdicts = mine.map((r) => (r.stage === 'error' ? 'err' : r.block ? 'block' : 'allow'))
  const pass = verdicts.filter((v) => v === c.expect).length
  return { id: c.id, title: c.title, expect: c.expect, verdicts, pass, runs: mine }
})

let failed = 0
for (const row of report) {
  const ok = row.pass === row.runs.length
  if (!ok) failed++
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${row.id.padEnd(4)} expect ${row.expect.padEnd(5)} got [${row.verdicts.join(', ')}]  ${row.title}`
  )
  for (const r of row.runs) {
    if (r.stage === 'error') console.log(`        error: ${r.error}`)
    else if (r.block) console.log(`        ${r.category ?? '-'} @${r.stage}: ${r.reason ?? ''}`)
  }
}
console.log(`\n${report.length - failed}/${report.length} cases matched intent on every run`)
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2))
