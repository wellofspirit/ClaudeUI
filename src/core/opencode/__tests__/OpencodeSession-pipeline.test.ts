/**
 * ADR-088 — "no third copy of the judge pipeline": OpencodeSession decides an
 * auto-mode ask through `runJudgePipeline` (automode/judge-pipeline.ts) and
 * keeps no step-for-step copy of its body. A structural guard over the
 * session's source (comments stripped), since a re-inlined copy would pass
 * every behavioural test.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.join(__dirname, '..', 'OpencodeSession.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

describe('OpencodeSession runs on the shared judge pipeline (J-T5)', () => {
  it('calls runJudgePipeline and none of the steps the pipeline owns', () => {
    expect(source).toMatch(/\brunJudgePipeline\(/)
    expect(source).not.toMatch(/\bclassify\(/)
    expect(source).not.toMatch(/\breadOnlyGate\(/)
    expect(source).not.toMatch(/\ballowRuleGate\(/)
  })
})
