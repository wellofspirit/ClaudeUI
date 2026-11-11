/**
 * @vitest-environment node
 *
 * Tests the real loadSessionHistory parser against a temp JSONL transcript:
 *
 *   1. model_refusal_fallback / model_fallback system entries are collected
 *      into SessionHistoryResult.warnings (transcript camelCase form).
 *   2. `fallback` content blocks (the canonical-replacement frame for a
 *      refusal-retracted partial) render as a readable note, not raw JSON.
 *
 * CLAUDE_PROJECTS_DIR derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// vi.mock factories are hoisted above module-level consts — vi.hoisted runs first
const TMP_HOME = vi.hoisted(() => `${__dirname}/.tmp-home-${process.pid}`)

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: (): string => TMP_HOME }
})

import { loadSessionHistory, fallbackBlockText } from '../session-history'

const PROJECT_KEY = 'test-project'
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function writeTranscript(lines: object[]): void {
  const dir = path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

const TS = '2026-06-10T06:22:16.376Z'

describe('loadSessionHistory — model fallback warnings', () => {
  it('collects model_refusal_fallback content into warnings', async () => {
    writeTranscript([
      {
        type: 'user',
        userType: 'external',
        message: { role: 'user', content: 'hello' },
        uuid: 'u1',
        timestamp: TS
      },
      {
        type: 'system',
        subtype: 'model_refusal_fallback',
        direction: 'retry',
        trigger: 'refusal',
        content: 'Safety measures flagged this message. Switched to Opus 4.8.',
        originalModel: 'claude-fable-5[1m]',
        fallbackModel: 'claude-opus-4-8',
        level: 'warning',
        uuid: 's1',
        timestamp: TS
      }
    ])

    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.warnings).toEqual(['Safety measures flagged this message. Switched to Opus 4.8.'])
    // The system entry must not leak into the visible message list
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].role).toBe('user')
  })

  it('composes a warning from models when content is absent (model_fallback)', async () => {
    writeTranscript([
      {
        type: 'system',
        subtype: 'model_fallback',
        trigger: 'overloaded',
        originalModel: 'claude-opus-4-8',
        fallbackModel: 'claude-sonnet-4-6',
        uuid: 's1',
        timestamp: TS
      }
    ])

    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.warnings).toEqual(['Switched models from claude-opus-4-8 to claude-sonnet-4-6.'])
  })

  it('returns empty warnings for a transcript without fallback events', async () => {
    writeTranscript([
      {
        type: 'user',
        userType: 'external',
        message: { role: 'user', content: 'hello' },
        uuid: 'u1',
        timestamp: TS
      }
    ])

    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.warnings).toEqual([])
  })

  it('renders fallback content blocks as a readable note, not raw JSON', async () => {
    writeTranscript([
      {
        type: 'assistant',
        message: {
          id: 'msg_01',
          role: 'assistant',
          content: [
            {
              type: 'fallback',
              from: { model: 'claude-fable-5' },
              to: { model: 'claude-opus-4-8' }
            }
          ]
        },
        uuid: 'a1',
        timestamp: TS
      }
    ])

    const result = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].content[0]).toEqual({
      type: 'text',
      text: 'Switched models from claude-fable-5 to claude-opus-4-8.'
    })
  })
})

describe('fallbackBlockText', () => {
  it('handles missing from/to gracefully', () => {
    expect(fallbackBlockText({})).toBe('Switched models.')
    expect(fallbackBlockText({ to: { model: 'claude-opus-4-8' } })).toBe(
      'Switched models to claude-opus-4-8.'
    )
  })
})
