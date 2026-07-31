/**
 * Auto-mode classifier bench — multi-model prompt evaluation harness.
 *
 * Runs the labeled scenario corpus (scenarios.ts) through the REAL classifier
 * pipeline (src/main/automode/classifier.ts) against real models via a local
 * `opencode serve`, and reports per-model safety/efficiency metrics:
 *
 *   - false-allow rate on safety-critical cases (the metric that matters)
 *   - false-block rate on expect-allow cases (what gets auto mode turned off)
 *   - stage-1 short-circuit rate + escalation rate (cost profile, `both` mode)
 *   - tokens (est. via response lengths) and wall-clock latency per verdict
 *
 * Usage:
 *   bun scripts/automode-bench/bench.ts [--models a,b,c] [--mode both|fast|thinking]
 *                                       [--cases id1,id2] [--concurrency N] [--json out.json]
 *
 * The judge transport mirrors OpencodeSession.makeJudgeFn: fresh session per
 * call, patched tool-denied before prompting, deleted after. The bench rides
 * the user's own opencode provider auth — no keys are handled here.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classify,
  type ClassifyInput,
  type ClassifyResult,
  type JudgeTransport
} from '../../src/main/automode/classifier'
import type { EnvironmentInfo } from '../../src/main/automode/rules/policy'
import { BENCH_CASES, type BenchCase } from './scenarios'
import type { ChatMessage } from '../../src/shared/types'

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_MODELS = [
  'openai/gpt-5.6-luna',
  'openai/gpt-5.6-terra',
  'alicloud/qwen3.8-max-preview',
  'openrouter/z-ai/glm-5.2'
]
// Excluded per instruction: openrouter/moonshotai/kimi-k3.

const ROOT = join(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..', '..')
const BINARY = join(ROOT, 'vendor', 'opencode-cli', process.platform === 'win32' ? 'opencode.exe' : 'opencode')

const DENY_ALL: Array<{ permission: string; pattern: string; action: string }> = [
  { permission: '*', pattern: '*', action: 'deny' }
]

const BENCH_ENV: EnvironmentInfo = {
  cwd: '/home/dev/project',
  platform: 'linux',
  remotes: [{ name: 'origin', url: 'https://github.com/acme/project.git' }]
}

// ── opencode server ───────────────────────────────────────────────────────────

async function startServer(): Promise<{ proc: ChildProcess; baseUrl: string; auth: string }> {
  if (!existsSync(BINARY)) throw new Error(`opencode binary missing: ${BINARY} — run bun run ensure-opencode`)
  const password = `bench-${Math.random().toString(36).slice(2)}`
  const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
  return await new Promise((resolve, reject) => {
    const proc = spawn(BINARY, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      cwd: ROOT,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    const timer = setTimeout(() => reject(new Error('opencode serve start timeout')), 20_000)
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        resolve({ proc, baseUrl: m[1], auth })
      }
    })
    proc.on('error', reject)
    proc.on('exit', (code) => reject(new Error(`opencode serve exited early (${code})\n${out}`)))
  })
}

// ── Judge transport (mirrors makeJudgeFn) ─────────────────────────────────────

function makeTransport(baseUrl: string, auth: string, model: string): JudgeTransport {
  const [providerID, ...rest] = model.split('/')
  const modelID = rest.join('/')
  const api = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    if (!res.ok && method !== 'DELETE') {
      throw new Error(`${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    return res
  }
  return async ({ system, user }) => {
    const created = (await (await api('POST', '/session', { title: 'automode-bench-judge' })).json()) as {
      id: string
    }
    try {
      await api('PATCH', `/session/${created.id}`, { permission: DENY_ALL })
      const resp = (await (
        await api('POST', `/session/${created.id}/message`, {
          model: { providerID, modelID },
          system,
          parts: [{ type: 'text', text: user }]
        })
      ).json()) as { parts?: Array<{ type?: string; text?: string }> }
      return (resp.parts ?? [])
        .filter((p) => p?.type === 'text')
        .map((p) => p?.text ?? '')
        .join('')
    } finally {
      api('DELETE', `/session/${created.id}`).catch(() => {})
    }
  }
}

// ── Scenario → ClassifyInput ──────────────────────────────────────────────────

let idc = 0
function toMessages(c: BenchCase): ChatMessage[] {
  return c.transcript.map((e) => {
    if (e.kind === 'user')
      return { id: `b${idc++}`, role: 'user' as const, content: [{ type: 'text' as const, text: e.text }], timestamp: 0 }
    if (e.kind === 'assistant')
      return {
        id: `b${idc++}`,
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: e.text }],
        timestamp: 0
      }
    return {
      id: `b${idc++}`,
      role: 'assistant' as const,
      content: [{ type: 'tool_use' as const, toolUseId: `t${idc}`, toolName: e.name, toolInput: e.input }],
      timestamp: 0
    }
  })
}

// ── Runner ────────────────────────────────────────────────────────────────────

interface CaseResult {
  id: string
  expect: 'allow' | 'block'
  got: 'allow' | 'block'
  ok: boolean
  critical: boolean
  stage: ClassifyResult['stage']
  category?: string
  reason?: string
  ms: number
  unavailable?: boolean
}

async function runModel(
  model: string,
  mode: 'both' | 'fast' | 'thinking',
  cases: BenchCase[],
  transport: JudgeTransport,
  concurrency: number
): Promise<CaseResult[]> {
  const queue = [...cases]
  const results: CaseResult[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const c = queue.shift()
      if (!c) return
      const input: ClassifyInput = {
        messages: toMessages(c),
        action: c.action,
        environment: BENCH_ENV,
        twoStageMode: mode
      }
      const t0 = performance.now()
      let r: ClassifyResult
      try {
        r = await classify(input, transport)
      } catch (err) {
        r = { block: true, stage: 'error', unavailable: true, reason: String(err) }
      }
      const got = r.block ? 'block' : 'allow'
      results.push({
        id: c.id,
        expect: c.expect,
        got,
        ok: got === c.expect,
        critical: c.critical ?? false,
        stage: r.stage,
        category: r.category,
        reason: r.reason,
        unavailable: r.unavailable,
        ms: Math.round(performance.now() - t0)
      })
      process.stderr.write(
        `  [${model}] ${c.id}: ${got}${r.category ? `/${r.category}` : ''} ${got === c.expect ? '✓' : '✗ EXPECTED ' + c.expect}${r.unavailable ? ' (unavailable!)' : ''} ${Math.round(performance.now() - t0)}ms\n`
      )
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

function summarize(model: string, mode: string, all: CaseResult[]): Record<string, unknown> {
  // Ground-truth-dependent cases measure phase-3's missing meta lines, not the
  // prompt — split them out of the headline metrics until that lands.
  const gtIds = new Set(BENCH_CASES.filter((c) => c.requiresGroundTruth).map((c) => c.id))
  const rs = all.filter((r) => !gtIds.has(r.id))
  const groundTruthPending = all
    .filter((r) => gtIds.has(r.id))
    .map((r) => `${r.id}: ${r.ok ? 'already passes' : `misses (got ${r.got}) — expected until phase 3`}`)
  const allowCases = rs.filter((r) => r.expect === 'allow')
  const blockCases = rs.filter((r) => r.expect === 'block')
  const criticalMisses = rs.filter((r) => r.critical && !r.ok)
  const falseBlocks = allowCases.filter((r) => !r.ok)
  const falseAllows = blockCases.filter((r) => !r.ok)
  const stage1Decided = rs.filter((r) => r.stage === 'fast').length
  const unavailable = rs.filter((r) => r.unavailable).length
  return {
    model,
    mode,
    cases: rs.length,
    accuracy: +((rs.filter((r) => r.ok).length / rs.length) * 100).toFixed(1),
    falseAllowPct: +((falseAllows.length / Math.max(1, blockCases.length)) * 100).toFixed(1),
    falseBlockPct: +((falseBlocks.length / Math.max(1, allowCases.length)) * 100).toFixed(1),
    criticalMisses: criticalMisses.map((r) => r.id),
    stage1DecidedPct: +((stage1Decided / rs.length) * 100).toFixed(1),
    unavailable,
    p50ms: rs.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(rs.length / 2)] ?? 0,
    failures: rs.filter((r) => !r.ok).map((r) => `${r.id} (got ${r.got})`),
    ...(groundTruthPending.length ? { groundTruthPending } : {})
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
  }
  const models = opt('models')?.split(',') ?? DEFAULT_MODELS
  const mode = (opt('mode') as 'both' | 'fast' | 'thinking' | undefined) ?? 'both'
  const only = opt('cases')?.split(',')
  const concurrency = Number(opt('concurrency') ?? 4)
  const cases = only ? BENCH_CASES.filter((c) => only.includes(c.id)) : BENCH_CASES

  process.stderr.write(`starting opencode serve…\n`)
  const { proc, baseUrl, auth } = await startServer()
  process.stderr.write(`server at ${baseUrl}; ${cases.length} cases × ${models.length} models (mode=${mode})\n`)

  const summaries: Array<Record<string, unknown>> = []
  const raw: Record<string, CaseResult[]> = {}
  try {
    for (const model of models) {
      process.stderr.write(`\n=== ${model} ===\n`)
      const transport = makeTransport(baseUrl, auth, model)
      const rs = await runModel(model, mode, cases, transport, concurrency)
      raw[model] = rs
      summaries.push(summarize(model, mode, rs))
    }
  } finally {
    proc.kill('SIGTERM')
  }

  console.log(JSON.stringify(summaries, null, 2))
  const jsonOut = opt('json')
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summaries, raw }, null, 2))
}

await main()
