/**
 * @vitest-environment node
 *
 * `formatOpencodeModelList` — the text of the hosted `claudeui_list_models`
 * tool (ADR-111): the models a subagent may name, from ClaudeUI's allowlist-
 * filtered discovery, `provider/id` with the `#variant`s a model accepts.
 */
import { describe, it, expect } from 'vitest'
import {
  OPENCODE_MODEL_LIST_CAP,
  OPENCODE_MODEL_LIST_EMPTY,
  formatOpencodeModelList
} from '../model-list'
import type { EngineModelGroup, ModelInfo } from '../../../shared/types'

const model = (vendorId: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  value: `${vendorId}/${id}`,
  displayName: id.toUpperCase(),
  description: id,
  engineId: 'opencode',
  vendorId,
  ...extra
})
const group = (vendorId: string, vendorName: string, models: ModelInfo[]): EngineModelGroup => ({
  engineId: 'opencode',
  vendorId,
  vendorName,
  models
})

const SAMPLE: EngineModelGroup[] = [
  group('openai', 'OpenAI', [
    model('openai', 'gpt-b', { reasoningVariants: ['low', 'high'] }),
    model('openai', 'gpt-a')
  ]),
  group('anthropic', 'Anthropic', [model('anthropic', 'claude-x', { free: true })]),
  group('local', 'local', [model('local', 'tiny')])
]

describe('formatOpencodeModelList', () => {
  it('groups by provider (sorted), lists provider/id with name and #variants, marks free ones', () => {
    expect(formatOpencodeModelList(SAMPLE).split('\n').slice(1)).toEqual([
      'anthropic (Anthropic):',
      '  anthropic/claude-x — CLAUDE-X · free',
      'local:',
      '  local/tiny — TINY',
      'openai (OpenAI):',
      '  openai/gpt-a — GPT-A',
      '  openai/gpt-b — GPT-B · variants: #low #high'
    ])
  })

  it('opens with how the value is passed and the "only when the user asks" rule', () => {
    const head = formatOpencodeModelList(SAMPLE).split('\n')[0]
    expect(head).toContain("subagent tool's model parameter")
    expect(head).toContain('provider/id#variant')
    expect(head).toContain('Only pass a model when the user asks for one')
  })

  it('filters by a case-insensitive substring of the value or the name', () => {
    const lines = formatOpencodeModelList(SAMPLE, 'GPT-B').split('\n')
    expect(lines.slice(1)).toEqual([
      'openai (OpenAI):',
      '  openai/gpt-b — GPT-B · variants: #low #high'
    ])
    expect(formatOpencodeModelList(SAMPLE, 'anthropic/')).toContain('anthropic/claude-x')
    expect(formatOpencodeModelList(SAMPLE, 'anthropic/')).not.toContain('openai/')
  })

  it('says so when nothing matches the query', () => {
    expect(formatOpencodeModelList(SAMPLE, ' nope ')).toContain('No model matches "nope"')
  })

  it('an empty discovery is a clear text result that points at omitting the model', () => {
    expect(formatOpencodeModelList([])).toBe(OPENCODE_MODEL_LIST_EMPTY)
    expect(formatOpencodeModelList([group('openai', 'OpenAI', [])])).toBe(OPENCODE_MODEL_LIST_EMPTY)
    expect(OPENCODE_MODEL_LIST_EMPTY).toContain('Omit the model parameter')
  })

  it('caps the list and says how many more there are', () => {
    const many = group(
      'p',
      'P',
      Array.from({ length: OPENCODE_MODEL_LIST_CAP + 7 }, (_, i) =>
        model('p', `m${String(i).padStart(3, '0')}`)
      )
    )
    const lines = formatOpencodeModelList([many]).split('\n')
    expect(lines.filter((l) => l.startsWith('  p/'))).toHaveLength(OPENCODE_MODEL_LIST_CAP)
    expect(lines[lines.length - 1]).toBe('… 7 more — pass query to narrow.')
  })
})
