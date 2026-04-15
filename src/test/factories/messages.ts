/**
 * Factory functions for creating test ChatMessage and ContentBlock instances.
 */

import type { ChatMessage, ContentBlock, PendingApproval, SessionStatus, TaskNotification, TodoItem } from '../../shared/types'

let messageCounter = 0

export function makeChatMessage(overrides?: Partial<ChatMessage>): ChatMessage {
  messageCounter++
  return {
    id: `msg-test-${messageCounter}`,
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    timestamp: Date.now(),
    ...overrides,
  }
}

export function makeUserMessage(text: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return makeChatMessage({
    role: 'user',
    content: [{ type: 'text', text }],
    ...overrides,
  })
}

export function makeAssistantMessage(text: string, overrides?: Partial<ChatMessage>): ChatMessage {
  return makeChatMessage({
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...overrides,
  })
}

// --- ContentBlock factories ---

export function makeTextBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

export function makeToolUseBlock(
  toolName: string,
  toolInput?: Record<string, unknown>,
  toolUseId?: string
): ContentBlock {
  return {
    type: 'tool_use',
    toolUseId: toolUseId ?? `toolu_test_${++messageCounter}`,
    toolName,
    toolInput,
  }
}

export function makeToolResultBlock(
  toolUseId: string,
  result: string,
  isError = false
): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId,
    toolResult: result,
    isError,
  }
}

export function makeThinkingBlock(text: string): ContentBlock {
  return { type: 'thinking', text }
}

// --- Session state factories ---

export function makeSessionStatus(overrides?: Partial<SessionStatus>): SessionStatus {
  return {
    state: 'idle',
    sessionId: null,
    model: 'claude-sonnet-4-6',
    cwd: '/test/project',
    totalCostUsd: 0,
    ...overrides,
  }
}

export function makePendingApproval(overrides?: Partial<PendingApproval>): PendingApproval {
  return {
    requestId: `req-test-${++messageCounter}`,
    toolName: 'Bash',
    input: { command: 'echo hello' },
    ...overrides,
  }
}

export function makeTaskNotification(overrides?: Partial<TaskNotification>): TaskNotification {
  return {
    taskId: `task-test-${++messageCounter}`,
    toolUseId: null,
    status: 'completed',
    outputFile: '/tmp/test-output',
    summary: 'Task completed',
    ...overrides,
  }
}

export function makeTodoItem(content: string, status: 'pending' | 'in_progress' | 'completed' = 'pending'): TodoItem {
  return {
    content,
    status,
    activeForm: content,
  }
}

/** Reset the counter between tests */
export function resetFactoryCounter(): void {
  messageCounter = 0
}
