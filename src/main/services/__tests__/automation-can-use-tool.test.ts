/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildCanUseTool, type CanUseToolResult } from '../automation-manager'
import type { TranscriptMessage } from '../auto-classifier'

// ---------------------------------------------------------------------------
// Mock auto-classifier
// ---------------------------------------------------------------------------

const mockClassify =
  vi.fn<
    (
      toolName: string,
      input: Record<string, unknown>,
      transcript: string
    ) => Promise<{ shouldBlock: boolean; reason: string }>
  >()
const mockClassifierInstance = { classify: mockClassify }

vi.mock('../auto-classifier', () => ({
  isSafeTool: (name: string) => ['Read', 'Grep', 'Glob', 'WebSearch', 'TodoWrite'].includes(name),
  getClassifier: () => mockClassifierInstance,
  buildTranscript: (msgs: TranscriptMessage[]) =>
    msgs.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join('\n'),
  stopClassifier: vi.fn()
}))

vi.mock('../logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCanUseTool', () => {
  const messages: TranscriptMessage[] = []
  const classifierId = 'automation:test-123'

  beforeEach(() => {
    vi.clearAllMocks()
    messages.length = 0
  })

  describe('auto mode', () => {
    it('auto-allows mcp__claude-ui__ tools without classifier', async () => {
      const canUseTool = buildCanUseTool('auto', messages, classifierId)
      const result = await canUseTool('mcp__claude-ui__render_mermaid', { source: 'graph TD' })

      expect(result.behavior).toBe('allow')
      expect((result as Extract<CanUseToolResult, { behavior: 'allow' }>).updatedInput).toEqual({
        source: 'graph TD'
      })
      expect(mockClassify).not.toHaveBeenCalled()
    })

    it('auto-allows safe tools (Read, Grep, Glob, etc.) without classifier', async () => {
      const canUseTool = buildCanUseTool('auto', messages, classifierId)

      for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch', 'TodoWrite']) {
        const result = await canUseTool(tool, { path: '/test' })
        expect(result.behavior).toBe('allow')
      }
      expect(mockClassify).not.toHaveBeenCalled()
    })

    it('invokes classifier for non-safe tools and allows when not blocked', async () => {
      mockClassify.mockResolvedValueOnce({ shouldBlock: false, reason: 'command is safe' })

      const canUseTool = buildCanUseTool('auto', messages, classifierId)
      const result = await canUseTool('Bash', { command: 'git status' })

      expect(result.behavior).toBe('allow')
      expect(mockClassify).toHaveBeenCalledWith(
        'Bash',
        { command: 'git status' },
        expect.any(String)
      )
    })

    it('invokes classifier for non-safe tools and denies when blocked', async () => {
      mockClassify.mockResolvedValueOnce({ shouldBlock: true, reason: 'destructive command' })

      const canUseTool = buildCanUseTool('auto', messages, classifierId)
      const result = await canUseTool('Bash', { command: 'rm -rf /' })

      expect(result.behavior).toBe('deny')
      expect((result as Extract<CanUseToolResult, { behavior: 'deny' }>).message).toContain(
        'destructive command'
      )
    })

    it('denies when classifier throws (no user fallback)', async () => {
      mockClassify.mockRejectedValueOnce(new Error('classifier crashed'))

      const canUseTool = buildCanUseTool('auto', messages, classifierId)
      const result = await canUseTool('Edit', { file_path: '/test.ts', new_string: 'x' })

      expect(result.behavior).toBe('deny')
      expect((result as Extract<CanUseToolResult, { behavior: 'deny' }>).message).toContain(
        'classifier unavailable'
      )
    })

    it('passes accumulated transcript to classifier', async () => {
      messages.push(
        { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'I will fix it' }] }
      )
      mockClassify.mockResolvedValueOnce({ shouldBlock: false, reason: 'safe' })

      const canUseTool = buildCanUseTool('auto', messages, classifierId)
      await canUseTool('Write', { file_path: '/f.ts', content: 'fix' })

      const transcript = mockClassify.mock.calls[0][2]
      expect(transcript).toContain('fix the bug')
      expect(transcript).toContain('I will fix it')
    })
  })

  describe('default mode', () => {
    it('blanket denies all tools', async () => {
      const canUseTool = buildCanUseTool('default', messages, classifierId)

      for (const tool of ['Read', 'Bash', 'Edit', 'Write', 'mcp__claude-ui__render_mermaid']) {
        const result = await canUseTool(tool, {})
        expect(result.behavior).toBe('deny')
        expect((result as Extract<CanUseToolResult, { behavior: 'deny' }>).message).toContain(
          'no user is present'
        )
      }
      expect(mockClassify).not.toHaveBeenCalled()
    })
  })
})
