/**
 * Factory functions for creating SDK event sequences.
 *
 * These mirror what the real SDK yields via sdkQuery()'s async generator.
 * Integration tests (Layer 4) verify these match actual SDK output.
 */

import type { SDKMessage } from '../stubs/sdk-stub'

/**
 * System init event — first event yielded by SDK after session starts.
 * Contains session ID, slash commands, skills, MCP servers, permission mode.
 */
export function initEvent(sessionId: string, overrides?: Record<string, unknown>): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    permission_mode: 'default',
    ...overrides,
  }
}

/**
 * Stream event — text being streamed from the model.
 */
export function streamTextEvent(text: string): SDKMessage {
  return {
    type: 'stream_event',
    subtype: 'text',
    text,
  }
}

/**
 * Stream event — thinking text being streamed.
 */
export function streamThinkingEvent(text: string): SDKMessage {
  return {
    type: 'stream_event',
    subtype: 'thinking',
    text,
  }
}

/**
 * Assistant message — a complete or partial message from Claude.
 */
export function assistantMessageEvent(
  sessionId: string,
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>,
  messageId?: string
): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id: messageId ?? `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  }
}

/**
 * User message echo — the SDK echoes back the user's message.
 */
export function userMessageEvent(content: string): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  }
}

/**
 * Result event — marks end of a turn.
 */
export function resultEvent(sessionId: string, overrides?: Record<string, unknown>): SDKMessage {
  return {
    type: 'result',
    session_id: sessionId,
    result: 'success',
    duration_ms: 1000,
    total_cost_usd: 0.001,
    ...overrides,
  }
}

/**
 * Status event with session ID — triggers rekey in ClaudeSession.
 */
export function statusEvent(sessionId: string, state: 'running' | 'idle' = 'running'): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    session_id: sessionId,
    state,
  }
}

// ---------------------------------------------------------------------------
// Composite event sequences
// ---------------------------------------------------------------------------

/**
 * A simple text response conversation.
 * init → stream chunks → assistant message → result
 */
export function textResponseSequence(sessionId: string, responseText: string): SDKMessage[] {
  return [
    initEvent(sessionId),
    streamTextEvent(responseText.slice(0, Math.ceil(responseText.length / 2))),
    streamTextEvent(responseText.slice(Math.ceil(responseText.length / 2))),
    assistantMessageEvent(sessionId, [{ type: 'text', text: responseText }]),
    resultEvent(sessionId),
  ]
}

/**
 * A tool use conversation where the tool needs approval.
 * init → assistant with tool_use → (canUseTool callback fires) → tool result → assistant text → result
 */
export function toolUseSequence(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
  responseText: string
): SDKMessage[] {
  const toolUseId = `toolu_test_${Date.now()}`
  return [
    initEvent(sessionId),
    // Assistant decides to use a tool
    assistantMessageEvent(sessionId, [
      { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
    ]),
    // After approval, user message with tool result
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUseId, content: toolResult }],
      },
    },
    // Assistant responds with text
    assistantMessageEvent(sessionId, [{ type: 'text', text: responseText }]),
    resultEvent(sessionId),
  ]
}

/**
 * A conversation with thinking blocks.
 */
export function thinkingSequence(sessionId: string, thinking: string, responseText: string): SDKMessage[] {
  return [
    initEvent(sessionId),
    streamThinkingEvent(thinking),
    streamTextEvent(responseText),
    assistantMessageEvent(sessionId, [
      { type: 'thinking', text: thinking },
      { type: 'text', text: responseText },
    ]),
    resultEvent(sessionId),
  ]
}
