/**
 * Live/cold parity of the opencode 2.x mapper (ADR-097 S4) on sequences
 * RECORDED from the real 2.0.24 engine (the mapper contract suite with
 * `OPENCODE_V2_CAPTURE=1`; paths redacted): the events a chat streamed, fed
 * through `OpencodeEventMapper` and folded the way the reducer folds them,
 * must equal the cold converter's reading of the rows opencode stored.
 *
 * Then the same sequences with a feed GAP cut out, reconciled from the final
 * stored state (the worst case of the reconnect contract: the read already
 * reflects everything the remaining live events will say) — still equal, and
 * nothing emitted twice.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OpencodeEvent } from '../protocol-v2/events'
import type { Session_Message_Info } from '../protocol-v2/openapi'
import { OpencodeEventMapper, type OpencodeMapperOutput } from '../event-mapper'
import { convertOpencodeHistory } from '../history'
import { foldOutputs, normalizeTranscript } from '../../../test/helpers/opencode-v2-transcript'
import { opencodeHistorySeed } from '../history-status-line'
import type { TokenUsage_Info } from '../protocol-v2/openapi'

// Pricing reads the billing type; the figures compared here (opencode's own
// cost and the tokens) do not depend on it.
vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { buildAccountRef: () => ({ billingType: 'api' }) }
}))
vi.mock('../model-discovery', () => ({ getOpencodeModelContextWindow: () => 100_000 }))

interface Recording {
  scenario: string
  sessionID: string
  events: OpencodeEvent[]
  messages: Session_Message_Info[]
  children: Record<string, Session_Message_Info[]>
  /** `GET /api/session/:id` cost/tokens at the end of the recording. */
  sessionTotals: { cost: number; tokens: TokenUsage_Info }
}

const DIR = join(__dirname, 'fixtures', 'opencode-v2')
const recordings: Recording[] = readdirSync(DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Recording)

function cold(recording: Recording) {
  return normalizeTranscript(
    convertOpencodeHistory(recording.messages, new Map(Object.entries(recording.children)))
  )
}

function ids(outputs: readonly OpencodeMapperOutput[], kind: 'tool-result' | 'step-usage') {
  return outputs.flatMap((o) =>
    o.kind === 'tool-result' && kind === 'tool-result'
      ? [o.result.toolUseId]
      : o.kind === 'step-usage' && kind === 'step-usage'
        ? [o.usage.messageId]
        : []
  )
}

function ends(outputs: readonly OpencodeMapperOutput[]) {
  return outputs.filter(
    (o) =>
      o.kind === 'result' ||
      o.kind === 'stopped' ||
      o.kind === 'error' ||
      o.kind === 'auth-required'
  )
}

describe('opencode 2.x mapper — live equals cold on recorded 2.0.24 sequences', () => {
  it('has the recordings', () => {
    expect(recordings.map((r) => r.scenario).sort()).toEqual([
      'denials',
      'form-cancel',
      'form-compaction',
      'multi-tool',
      'patch',
      'resume',
      'stops'
    ])
  })

  describe.each(recordings.map((r) => [r.scenario, r] as const))('%s', (_name, recording) => {
    it('streamed live, it reads exactly as the stored history', () => {
      const mapper = new OpencodeEventMapper({ sessionID: recording.sessionID })
      const outputs = recording.events.flatMap((event) => mapper.map(event))
      const live = normalizeTranscript(foldOutputs(outputs))
      expect(live).toEqual(cold(recording))
      // Something substantial was compared.
      expect(live.messages.length).toBeGreaterThan(1)
      // One result per call, one metering per step.
      expect(new Set(ids(outputs, 'tool-result')).size).toBe(ids(outputs, 'tool-result').length)
      expect(new Set(ids(outputs, 'step-usage')).size).toBe(ids(outputs, 'step-usage').length)
      // One end per execution.
      const executions = recording.events.filter(
        (e) => e.type === 'session.execution.started' && e.data.sessionID === recording.sessionID
      ).length
      expect(ends(outputs)).toHaveLength(executions)
    })

    it('live usage (steps, children, compactions, overhead) totals what the cold line counts', () => {
      const mapper = new OpencodeEventMapper({ sessionID: recording.sessionID })
      const outputs = recording.events.flatMap((event) => mapper.map(event))
      let cost = 0
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const add = (c: number, t: TokenUsage_Info) => {
        cost += c
        tokens.input += t.input
        tokens.output += t.output + t.reasoning
        tokens.cacheRead += t.cache.read
        tokens.cacheWrite += t.cache.write
      }
      for (const o of outputs) {
        if (o.kind === 'step-usage') add(o.usage.cost, o.usage.tokens)
        else if (o.kind === 'compaction' && o.usage) add(o.usage.cost, o.usage.tokens)
        else if (o.kind === 'overhead-usage') add(o.cost, o.tokens)
      }
      const seed = opencodeHistorySeed(
        recording.messages,
        { providerID: 'fixture', modelID: 'fixture-model' },
        { children: Object.values(recording.children), sessionTotals: recording.sessionTotals }
      )
      expect(cost).toBeCloseTo(seed.engineReportedCostUsd, 10)
      expect(tokens).toEqual(seed.tokens)
      // Something beyond the steps (title generation) was in it.
      expect(outputs.some((o) => o.kind === 'overhead-usage')).toBe(true)
    })

    // Gaps at several places and widths; the reconcile reads the FINAL state.
    const n = recording.events.length
    const gaps = [
      [0.1, 0.3],
      [0.3, 0.6],
      [0.5, 0.9],
      [0.2, 1]
    ].map(([a, b]) => [Math.floor(n * a), Math.floor(n * b)] as const)
    it.each(gaps)(
      'a feed gap over events [%i, %i) is recovered from a re-read, once',
      (from, to) => {
        const mapper = new OpencodeEventMapper({ sessionID: recording.sessionID })
        const outputs: OpencodeMapperOutput[] = []
        for (const event of recording.events.slice(0, from)) outputs.push(...mapper.map(event))
        const sessions: Record<
          string,
          { messages: Session_Message_Info[]; permissions: []; forms: []; inbox?: [] }
        > = {
          [recording.sessionID]: {
            messages: recording.messages,
            permissions: [],
            forms: [],
            inbox: []
          }
        }
        for (const [id, rows] of Object.entries(recording.children))
          sessions[id] = { messages: rows, permissions: [], forms: [] }
        // Two rounds, as `reconcileAfterReconnect` does when the read links a child.
        outputs.push(...mapper.reconcile({ sessions, active: {} }))
        outputs.push(...mapper.reconcile({ sessions, active: {} }))
        for (const event of recording.events.slice(to)) outputs.push(...mapper.map(event))

        expect(normalizeTranscript(foldOutputs(outputs))).toEqual(cold(recording))
        expect(new Set(ids(outputs, 'tool-result')).size).toBe(ids(outputs, 'tool-result').length)
        expect(new Set(ids(outputs, 'step-usage')).size).toBe(ids(outputs, 'step-usage').length)
        // Never more ends than executions (turns wholly inside the gap collapse
        // into the one end the re-read reports), and the last one is reported.
        const executions = recording.events.filter(
          (e) => e.type === 'session.execution.started' && e.data.sessionID === recording.sessionID
        ).length
        expect(ends(outputs).length).toBeGreaterThan(0)
        expect(ends(outputs).length).toBeLessThanOrEqual(executions)
        expect(mapper.running).toBe(false)
        // Nothing is left waiting on the user.
        const asked = outputs
          .filter((o) => o.kind === 'approval')
          .map((o) => o.kind === 'approval' && o.approval.requestId)
        const resolved = outputs
          .filter((o) => o.kind === 'approval-resolved')
          .map((o) => o.kind === 'approval-resolved' && o.requestId)
        expect(new Set(resolved)).toEqual(new Set(asked))
      }
    )
  })
})
