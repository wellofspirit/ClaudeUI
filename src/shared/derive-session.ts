/**
 * Transcript → derived per-session state.
 *
 * Relocated out of the renderer store by SyncCore phase 4a: derived state
 * (`todos`, `sentFiles`) is **reducer-internal** now (ADR-051, ratified §2) —
 * derived on message-apply inside `applyEvent`, replicated, and snapshot-carried.
 * Core and the renderer must therefore derive IDENTICALLY, which two copies of
 * these scanners could not guarantee. The dev-mode tripwire in
 * `shared/sync/reducer.ts` asserts snapshot-carried values equal a fresh
 * derivation, so a single definition is what makes that assertion meaningful
 * rather than a diff of two implementations.
 *
 * `renderer/src/stores/session-store` re-exports both functions, so every
 * existing import site is unchanged.
 */

import type { ChatMessage, TodoItem, SentFile } from './types'

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])

/**
 * Scan messages for TaskCreate/TaskUpdate/TodoWrite tool calls and build the
 * final TodoItem[] state. Returns null if no relevant tool calls found.
 */
export function buildTodosFromMessages(messages: ChatMessage[]): TodoItem[] | null {
  const tasks = new Map<string, TodoItem>()
  let hasTaskCalls = false

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || !block.toolName || !TASK_TOOL_NAMES.has(block.toolName))
        continue
      const input = block.toolInput || {}

      if (block.toolName === 'TodoWrite') {
        hasTaskCalls = true
        tasks.clear()
        if (Array.isArray(input.todos)) {
          ;(input.todos as Record<string, unknown>[]).forEach((t, i) => {
            tasks.set(String(i), {
              content: String(t.content || ''),
              status: (t.status as TodoItem['status']) || 'pending',
              activeForm: String(t.activeForm || '')
            })
          })
        }
      } else if (block.toolName === 'TaskCreate') {
        hasTaskCalls = true
        // New batch: if all existing tasks are completed/empty, start fresh
        if (tasks.size > 0) {
          const allDone = Array.from(tasks.values()).every((t) => t.status === 'completed')
          if (allDone) tasks.clear()
        }
        // Extract ID from the tool_result in the same message
        const resultBlock = msg.content.find(
          (b) => b.type === 'tool_result' && b.toolUseId === block.toolUseId
        )
        const idMatch =
          resultBlock?.type === 'tool_result' ? resultBlock.toolResult.match(/Task #(\w+)/) : null
        const id = idMatch ? idMatch[1] : block.toolUseId || String(tasks.size)
        tasks.set(id, {
          content: String(input.subject || ''),
          status: 'pending',
          activeForm: String(input.activeForm || '')
        })
      } else if (block.toolName === 'TaskUpdate') {
        hasTaskCalls = true
        const id = String(input.taskId || '')
        const existing = tasks.get(id)
        if (existing) {
          if (input.status === 'deleted') {
            tasks.delete(id)
          } else if (input.status) {
            existing.status = input.status as TodoItem['status']
          }
          if (input.subject) existing.content = String(input.subject)
          if (input.activeForm) existing.activeForm = String(input.activeForm)
        }
      }
    }
  }

  if (!hasTaskCalls) return null
  return Array.from(tasks.values())
}

/** Max chars of a SendUserFile error result kept for display. */
const SENT_FILE_ERROR_MAX = 500

/**
 * Scan messages for Claude Code `SendUserFile` tool calls and build the list of
 * files the agent has handed to the user. Returns null if there are none —
 * mirroring {@link buildTodosFromMessages}'s contract, so a rebuild never
 * clobbers existing state when the transcript has nothing to say.
 *
 * Semantics that differ from todos:
 *  - the list is cumulative for the whole session and is NEVER cleared;
 *  - a re-send of the same path replaces the earlier entry and moves it to the
 *    end (latest send wins — its caption/display/error are the current truth);
 *  - a call whose tool_result hasn't landed yet is still included (in-flight),
 *    and the rebuild triggered by the result later fills in `error`.
 */
export function buildSentFilesFromMessages(messages: ChatMessage[]): SentFile[] | null {
  const byPath = new Map<string, SentFile>()
  let hasSendCalls = false

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || block.toolName !== 'SendUserFile') continue
      hasSendCalls = true
      const input = block.toolInput || {}

      // cli.js coerces a bare string to [string]; accept both shapes.
      const raw = input.files
      const paths = (Array.isArray(raw) ? raw : [raw]).filter(
        (p): p is string => typeof p === 'string' && p.trim().length > 0
      )
      if (paths.length === 0) continue

      const resultBlock = msg.content.find(
        (b) => b.type === 'tool_result' && b.toolUseId === block.toolUseId
      )
      const error =
        resultBlock?.type === 'tool_result' && resultBlock.isError
          ? resultBlock.toolResult.trim().slice(0, SENT_FILE_ERROR_MAX)
          : undefined

      const caption = typeof input.caption === 'string' ? input.caption : undefined
      const display =
        input.display === 'render' || input.display === 'attach' ? input.display : undefined

      for (const p of paths) {
        // Delete first so a re-sent path moves to the end of the insertion order.
        byPath.delete(p)
        byPath.set(p, {
          path: p,
          ...(caption ? { caption } : {}),
          ...(display ? { display } : {}),
          toolUseId: block.toolUseId,
          ...(error ? { error } : {})
        })
      }
    }
  }

  if (!hasSendCalls) return null
  return Array.from(byPath.values())
}

/** Tool names whose presence in a message triggers a todo re-derivation. */
export const TODO_TRIGGER_TOOLS: ReadonlySet<string> = TASK_TOOL_NAMES

/** Claude Code's file-delivery tool — triggers a sentFiles re-derivation. */
export const SEND_USER_FILE_TOOL = 'SendUserFile'
