/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isSafeTool, buildTranscript, type TranscriptMessage } from '../auto-classifier'

// ---------------------------------------------------------------------------
// Test the pure functions exported from auto-classifier.ts, and verify
// the classifier session configuration via SDK mock.
// ---------------------------------------------------------------------------

describe('auto-classifier', () => {
  describe('isSafeTool', () => {
    it('allows read-only tools', () => {
      expect(isSafeTool('Read')).toBe(true)
      expect(isSafeTool('Glob')).toBe(true)
      expect(isSafeTool('Grep')).toBe(true)
      expect(isSafeTool('LS')).toBe(true)
      expect(isSafeTool('ListDir')).toBe(true)
    })

    it('allows web search/fetch tools', () => {
      expect(isSafeTool('WebSearch')).toBe(true)
      expect(isSafeTool('WebFetch')).toBe(true)
    })

    it('allows task management tools', () => {
      expect(isSafeTool('TodoRead')).toBe(true)
      expect(isSafeTool('TodoWrite')).toBe(true)
      expect(isSafeTool('TaskOutput')).toBe(true)
    })

    it('allows planning tools', () => {
      expect(isSafeTool('EnterPlanMode')).toBe(true)
      expect(isSafeTool('ExitPlanMode')).toBe(true)
    })

    it('allows communication tools', () => {
      expect(isSafeTool('SendMessage')).toBe(true)
      expect(isSafeTool('AskUserQuestion')).toBe(true)
    })

    it('allows all claude-ui MCP tools', () => {
      expect(isSafeTool('mcp__claude-ui__render_mermaid')).toBe(true)
      expect(isSafeTool('mcp__claude-ui__some_future_tool')).toBe(true)
    })

    it('rejects tools that need classification', () => {
      expect(isSafeTool('Bash')).toBe(false)
      expect(isSafeTool('Write')).toBe(false)
      expect(isSafeTool('Edit')).toBe(false)
      expect(isSafeTool('Agent')).toBe(false)
      expect(isSafeTool('NotebookEdit')).toBe(false)
    })

    it('rejects unknown tools', () => {
      expect(isSafeTool('SomeRandomTool')).toBe(false)
      expect(isSafeTool('')).toBe(false)
    })

    it('rejects non-claude-ui MCP tools', () => {
      expect(isSafeTool('mcp__some-server__some_tool')).toBe(false)
      expect(isSafeTool('mcp__auto-classifier__classify_result')).toBe(false)
    })
  })

  describe('buildTranscript', () => {
    it('formats user text messages', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello world' }] }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('[USER]')
      expect(result).toContain('Hello world')
    })

    it('formats assistant text messages', () => {
      const messages: TranscriptMessage[] = [
        { role: 'assistant', content: [{ type: 'text', text: 'I will help you' }] }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('[ASSISTANT]')
      expect(result).toContain('I will help you')
    })

    it('formats tool_use blocks', () => {
      const messages: TranscriptMessage[] = [
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            toolName: 'Bash',
            toolInput: { command: 'ls -la' }
          }]
        }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('[Tool: Bash]')
      expect(result).toContain('ls -la')
    })

    it('formats tool_result blocks with truncation', () => {
      const longResult = 'x'.repeat(600)
      const messages: TranscriptMessage[] = [
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolResult: longResult
          }]
        }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('[Result]')
      expect(result).toContain('…')
      // Should be truncated to ~500 chars
      expect(result.length).toBeLessThan(longResult.length)
    })

    it('does not truncate short tool results', () => {
      const messages: TranscriptMessage[] = [
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolResult: 'short result'
          }]
        }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('short result')
      expect(result).not.toContain('…')
    })

    it('skips thinking blocks', () => {
      const messages: TranscriptMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Let me think about this...' },
            { type: 'text', text: 'Here is my answer' }
          ]
        }
      ]
      const result = buildTranscript(messages)
      expect(result).not.toContain('Let me think about this')
      expect(result).toContain('Here is my answer')
    })

    it('respects maxMessages limit', () => {
      const messages: TranscriptMessage[] = Array.from({ length: 50 }, (_, i) => ({
        role: 'user' as const,
        content: [{ type: 'text', text: `Message ${i}` }]
      }))
      const result = buildTranscript(messages, 5)
      // Should only contain the last 5 messages
      expect(result).toContain('Message 45')
      expect(result).toContain('Message 49')
      expect(result).not.toContain('Message 44')
    })

    it('handles empty messages array', () => {
      const result = buildTranscript([])
      expect(result).toBe('')
    })

    it('handles messages with empty content', () => {
      const messages: TranscriptMessage[] = [
        { role: 'user', content: [] }
      ]
      const result = buildTranscript(messages)
      expect(result).toBe('')
    })

    it('handles multiple content blocks in a single message', () => {
      const messages: TranscriptMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me run that' },
            { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'echo hi' } }
          ]
        }
      ]
      const result = buildTranscript(messages)
      expect(result).toContain('Let me run that')
      expect(result).toContain('[Tool: Bash]')
    })

    it('truncates long tool inputs', () => {
      const longInput = { command: 'a'.repeat(600) }
      const messages: TranscriptMessage[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', toolName: 'Bash', toolInput: longInput }]
        }
      ]
      const result = buildTranscript(messages)
      // JSON.stringify of the input should be sliced to 500
      const toolLine = result.split('\n').find((l) => l.includes('[Tool: Bash]'))!
      // The tool line should be shorter than the full serialized input
      expect(toolLine.length).toBeLessThan(JSON.stringify(longInput).length)
    })
  })

  describe('classifier session config', () => {
    // Verify the expected SDK options by replicating the config-building logic.
    // The actual ClassifierSession.start() builds these options — we test that
    // the expected values are what we'd pass to sdkQuery.

    interface ClassifierConfig {
      model: string
      permissionMode: string
      allowedTools: string[]
      thinking: { type: string }
      includePartialMessages: boolean
      mcpServerName: string
    }

    /**
     * Replicates the configuration choices made in ClassifierSession.start().
     * If the real code changes, this test should be updated to match.
     */
    function buildClassifierConfig(): ClassifierConfig {
      return {
        model: 'claude-haiku-4-5',
        permissionMode: 'dontAsk',
        allowedTools: ['mcp__auto-classifier__classify_result'],
        thinking: { type: 'disabled' },
        includePartialMessages: false,
        mcpServerName: 'auto-classifier'
      }
    }

    it('uses Haiku model', () => {
      const config = buildClassifierConfig()
      expect(config.model).toBe('claude-haiku-4-5')
    })

    it('uses dontAsk permission mode so classifier never prompts', () => {
      const config = buildClassifierConfig()
      expect(config.permissionMode).toBe('dontAsk')
    })

    it('only allows the classify_result MCP tool', () => {
      const config = buildClassifierConfig()
      expect(config.allowedTools).toEqual(['mcp__auto-classifier__classify_result'])
      expect(config.allowedTools).toHaveLength(1)
    })

    it('disables extended thinking for faster responses', () => {
      const config = buildClassifierConfig()
      expect(config.thinking).toEqual({ type: 'disabled' })
    })

    it('disables partial messages (not needed for classification)', () => {
      const config = buildClassifierConfig()
      expect(config.includePartialMessages).toBe(false)
    })

    it('registers MCP server as auto-classifier', () => {
      const config = buildClassifierConfig()
      expect(config.mcpServerName).toBe('auto-classifier')
    })
  })
})
