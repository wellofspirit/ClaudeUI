import { createContext, memo, useContext, useState } from 'react'
import type {
  ChatMessage,
  ContentBlock,
  PendingApproval,
  ToolReviewBlock,
  PermissionDenialBlock
} from '../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'
import { ExitPlanModeCard } from './ExitPlanModeCard'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { TodoToolBlock } from './TodoToolBlock'
import { SleepRow } from './SleepRow'
import { ToolNoteRow } from './ToolNoteRow'
import { ContextNoteBlock } from './ContextNoteBlock'
import { ReviewResultCard } from './ReviewResultCard'
import { TaskCard } from './TaskCard'
import { hostedMcpKind } from '../../../../shared/tool-kinds'
import type { EngineToolMap } from '../../../../shared/tool-kinds'
import { engineToolMap } from './tool-registry/engine-tool-maps'
import { useImageGallery } from '../shared/ImageViewer'
import { isDrivableProvider, providerDisplayName } from '../../utils/sign-in-provider'
import { openProviderSettings } from '../SettingsDialog/settings-target'

// ---------------------------------------------------------------------------
// Unified tool-block dispatch
// ---------------------------------------------------------------------------

type ToolUseBlockForDispatch = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlockForDispatch = Extract<ContentBlock, { type: 'tool_result' }>

/**
 * Unified tool-block renderer. Replaces the per-toolName switch that previously
 * lived in each of MessageBubble's single + grouped render paths.
 *
 * Resolution order:
 *   1. `hostedMcpKind` — engine-independent MCP tool classification
 *   2. `toolMap.kindOf` — engine's own classification
 *   3. Lifted kinds (plan/question/todo/task) → their interaction components
 *   4. All passive kinds → ToolCallBlock (which computes the same kind + the
 *      neutral ToolView and renders the shared ToolCard shell + kind body)
 *
 * The `toolMap.hidden` suppression has already been applied by the caller
 * (filtered out before grouping). This function does NOT need to re-check it.
 */
function renderToolBlock(
  toolMap: EngineToolMap,
  block: ToolUseBlockForDispatch,
  result: ToolResultBlockForDispatch | undefined,
  approval: PendingApproval | undefined,
  key: number | string,
  // What the permission system decided about this call before it ran — a
  // judge's verdict (F18) or a pre-ask refusal nothing judged. ONE param, not
  // two, because cli.js decides each call once: it is either weighed or looked
  // up. Only the passive card shows it: the lifted kinds below are interactions
  // (a plan, a question, a todo list), and none of them is an action a judge
  // gates.
  decision?: ToolReviewBlock | PermissionDenialBlock,
  // Whether this block is on the LAST assistant message — read only by the plan
  // card, whose no-approval action set (Codex, F20) belongs to the latest plan
  // and to no earlier one.
  isLastAssistant = false
): React.JSX.Element {
  const kind = hostedMcpKind(block.toolName) ?? toolMap.kindOf(block.toolName)

  // Compute the engine-neutral ToolView once and pass it to lifted components.
  // Passive kinds (command/fileEdit/…) still compute their view inside ToolCallBlock.
  const view = toolMap.normalize(kind, block.toolInput, result, block.toolName)

  // Lifted interaction components — consume the neutral view, not block.toolInput.
  if (kind === 'plan' && view.kind === 'plan') {
    return (
      <ExitPlanModeCard
        key={key}
        block={block}
        view={view}
        approval={approval}
        isLatest={isLastAssistant}
      />
    )
  }
  if (kind === 'question' && view.kind === 'question') {
    return (
      <AskUserQuestionBlock
        key={key}
        block={block}
        result={result}
        view={view}
        approval={approval}
      />
    )
  }
  if (kind === 'todo' && view.kind === 'todo') {
    return <TodoToolBlock key={key} block={block} result={result} view={view} />
  }
  if (kind === 'sleep' && view.kind === 'sleep') {
    return <SleepRow key={key} block={block} result={result} view={view} />
  }
  if (kind === 'note' && view.kind === 'note') {
    return (
      <ToolNoteRow
        key={key}
        block={block}
        result={result}
        view={view}
        displayName={toolMap.displayName(block.toolName)}
      />
    )
  }
  if (kind === 'task' && view.kind === 'task') {
    return <TaskCard key={key} block={block} result={result} view={view} approval={approval} />
  }

  // Passive kinds → ToolCallBlock host → ToolCard + kind body
  // (command/fileEdit/fileWrite/fileRead/search/web/diagram/mockup/mcp/unknown).
  return (
    <ToolCallBlock
      key={key}
      block={block}
      result={result}
      approval={approval}
      review={decision?.type === 'tool_review' ? decision : undefined}
      denial={decision?.type === 'permission_denial' ? decision : undefined}
    />
  )
}

/**
 * WHICH session's transcript these bubbles belong to — the chat message list
 * provides its own routing id; every other host leaves it `null`.
 *
 * `MessageBubble` is not the chat's alone: automation-run history replays a
 * recorded run through it. Anything inside a bubble that needs a session was
 * therefore reading `activeSessionId`, which for a replayed run is an unrelated
 * chat — so its auth row showed that session's lifetime and its Retry re-sent
 * the prompt into a session the user was not looking at.
 *
 * `null` is a real answer, not a missing one: a transcript that belongs to no
 * open session has no live fact to read and nothing it could correctly act on.
 * Consumers render history.
 */
const TranscriptSessionContext = createContext<string | null>(null)

/** Mounted by a message list that IS a session's transcript. */
export const TranscriptSessionProvider = TranscriptSessionContext.Provider

/** The routing id of the transcript this bubble is in, or `null`. */
export function useTranscriptSessionId(): string | null {
  return useContext(TranscriptSessionContext)
}

/** Stable identity so the default never re-renders a memoised bubble. */
const EMPTY_ACTIVE_THINKING: ReadonlyArray<{ index: number; startedAt?: number }> = []

interface MessageBubbleProps {
  message: ChatMessage
  pendingApprovals: PendingApproval[]
  isLastAssistant: boolean
  /**
   * The message's currently-streaming thinking slots, each with the item's own
   * start clock when the engine measured one (`ActiveItemStream.startedAt`).
   * `undefined` — not `[]` — for a message with none, so `memo` keeps holding.
   */
  activeThinking?: ReadonlyArray<{ index: number; startedAt?: number }>
}

export const MessageBubble = memo(function MessageBubble({
  message,
  pendingApprovals,
  isLastAssistant,
  activeThinking = EMPTY_ACTIVE_THINKING
}: MessageBubbleProps): React.JSX.Element {
  // Hooks must run unconditionally — declared before the role-based early returns.
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const forkFromMessage = useSessionStore((s) => s.forkFromMessage)
  const forkCapability = useActiveSession((s) => s.status.capabilities.forkFromMessage)
  const engineId = useActiveSession((s) => s.status.engineId)
  const [forking, setForking] = useState(false)
  // No-op + `enabled: false` when no ImageGalleryProvider is mounted above, so
  // an unwrapped MessageBubble still renders its thumbnails (just inert).
  const { openAttachment, enabled: galleryEnabled } = useImageGallery()

  const handleFork = async (): Promise<void> => {
    if (!activeSessionId || forking) return
    setForking(true)
    try {
      await forkFromMessage(activeSessionId, message.id)
    } finally {
      setForking(false)
    }
  }

  // System messages (compact separators, CLI commands, API errors)
  if (message.role === 'system') {
    return (
      <div
        data-testid="MessageBubble"
        data-id={message.id}
        className="flex flex-col gap-2 animate-fade-in"
      >
        {message.content.map((block, i) => {
          if (block.type === 'compact_separator') {
            return <CompactSeparator key={i} summary={block.text} />
          }
          if (block.type === 'cli_command') {
            return <CliCommandBlock key={i} block={block} />
          }
          if (block.type === 'api_error') {
            return block.errorType === 'authentication' ? (
              <AuthTranscriptRow key={i} block={block} />
            ) : (
              <ApiErrorBlock key={i} block={block} />
            )
          }
          // Context an ENGINE injected into the model's prompt — Codex hook
          // fragments today. Verbatim, never markdown (the fragments are
          // third-party text).
          if (block.type === 'context_note') {
            return <ContextNoteBlock key={i} block={block} />
          }
          // A code review's findings. The one untrusted-text block that DOES go
          // through markdown, by decision (F20) — see ReviewResultCard.
          if (block.type === 'review_result') {
            return <ReviewResultCard key={i} block={block} />
          }
          // A bare notice the engine wants in the transcript — Codex's `auto`
          // guardian decisions are the current producer. Rendered VERBATIM and
          // never through the markdown pipeline: the text can quote a
          // model-authored rationale from a reviewer thread the user never saw.
          if (block.type === 'text') {
            return (
              <div
                key={i}
                data-testid="MessageBubble.systemNotice"
                className="text-[12px] text-text-muted leading-[1.6] whitespace-pre-wrap break-words border-l-2 border-border pl-3 py-0.5"
              >
                {block.text}
              </div>
            )
          }
          return null
        })}
      </div>
    )
  }

  if (message.role === 'user') {
    // User message with planContent: show plan block instead of raw text
    if (message.planContent) {
      const planBlock: ContentBlock = {
        type: 'tool_use',
        toolName: 'ExitPlanMode',
        toolInput: { plan: message.planContent },
        toolUseId: `plan-${message.id}`
      }
      const syntheticPlanView = { kind: 'plan' as const, plan: message.planContent }
      return (
        <div data-testid="MessageBubble" data-id={message.id} className="animate-fade-in">
          <ExitPlanModeCard block={planBlock} view={syntheticPlanView} />
        </div>
      )
    }

    const imageBlocks = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image'
    )
    const docBlocks = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'document' }> => b.type === 'document'
    )
    const textBlocks = message.content.filter(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text'
    )
    const hasAttachments = imageBlocks.length > 0 || docBlocks.length > 0
    const userMarkdown = textBlocks.map((b) => b.text).join('\n\n')

    return (
      <div
        data-testid="MessageBubble"
        data-id={message.id}
        className="flex justify-end animate-fade-in"
      >
        <div
          className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]"
          data-markdown-source={userMarkdown || undefined}
        >
          {hasAttachments && (
            <div className="flex gap-2 flex-wrap mb-2">
              {imageBlocks.map((block, i) => (
                <button
                  key={`img-${i}`}
                  type="button"
                  data-testid="MessageBubble.imageThumb"
                  data-id={String(i)}
                  disabled={!galleryEnabled}
                  onClick={() => openAttachment(message.id, i)}
                  aria-label={
                    block.fileName ? `View image ${block.fileName}` : 'View attached image'
                  }
                  title={block.fileName}
                  className={`block rounded-lg leading-none ${
                    galleryEnabled ? 'cursor-zoom-in' : 'cursor-default'
                  }`}
                >
                  <img
                    src={`data:${block.mediaType};base64,${block.base64Data}`}
                    alt={block.fileName || 'Attached'}
                    className="max-w-[200px] max-h-[200px] rounded-lg object-contain"
                  />
                </button>
              ))}
              {docBlocks.map((block, i) => (
                <div
                  key={`doc-${i}`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-bg-hover"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className="text-red-400 shrink-0"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="text-[11px] text-text-secondary">
                    {block.fileName || 'Document'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {textBlocks.map((block, i) => (
            <span key={i} className="whitespace-pre-wrap">
              {block.text}
            </span>
          ))}
        </div>
      </div>
    )
  }

  type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
  type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

  // Pair tool_use blocks with their tool_result
  const resultMap = new Map<string, ToolResultBlock>()
  // …and with what the permission system decided about them: a judge's verdict
  // (F18) or a pre-ask refusal nothing judged. LAST one wins — a re-review after
  // "approve anyway" is a new decision, not a second opinion — and the two kinds
  // share a map because a call only ever carries one of them.
  const decisionMap = new Map<string, ToolReviewBlock | PermissionDenialBlock>()
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      resultMap.set(block.toolUseId, block)
    } else if (block.type === 'tool_review' || block.type === 'permission_denial') {
      decisionMap.set(block.toolUseId, block)
    }
  }

  // Match pending approvals to tool_use blocks by tool_use_id — the
  // authoritative id cli.js assigns to each invocation. Previously this
  // used (toolName + input) signature, which collapses repeated identical
  // calls onto the same approval and shows the prompt on every prior
  // tool_use card when the latest one needs approval.
  //
  // Older main-process builds may not include toolUseId on PendingApproval
  // (field was added alongside this fix). Fall back to signature match
  // only for approvals that lack the id, so a mixed-version setup still
  // renders a prompt somewhere instead of dropping it.
  const approvalMap = new Map<string, PendingApproval>()
  const matchedApprovalIds = new Set<string>()
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue
    const byId = pendingApprovals.find((a) => a.toolUseId && a.toolUseId === block.toolUseId)
    if (byId) {
      approvalMap.set(block.toolUseId, byId)
      matchedApprovalIds.add(byId.requestId)
      continue
    }
    const legacy = pendingApprovals.find(
      (a) =>
        !a.toolUseId &&
        !matchedApprovalIds.has(a.requestId) &&
        a.toolName === block.toolName &&
        JSON.stringify(a.input) === JSON.stringify(block.toolInput)
    )
    if (legacy) {
      approvalMap.set(block.toolUseId, legacy)
      matchedApprovalIds.add(legacy.requestId)
    }
  }

  // Group consecutive tool_use blocks so we can wrap them in a bordered container
  type RenderItem =
    | { kind: 'tool_group'; blocks: { block: ToolUseBlock; index: number }[] }
    | { kind: 'thinking'; block: Extract<ContentBlock, { type: 'thinking' }>; index: number }
    | { kind: 'other'; block: ContentBlock; index: number }
  const items: RenderItem[] = []

  const toolMap = engineToolMap(engineId)

  const visible = message.content.filter(
    (b) =>
      b.type !== 'tool_result' &&
      // A decision renders ON its card, never as a row of its own — and never as
      // a gap that would split a run of tool calls into two groups.
      b.type !== 'tool_review' &&
      b.type !== 'permission_denial' &&
      !(b.type === 'tool_use' && b.toolName && toolMap.hidden.has(b.toolName))
  )
  for (let i = 0; i < visible.length; i++) {
    const block = visible[i]
    if (block.type === 'tool_use') {
      const last = items[items.length - 1]
      if (last?.kind === 'tool_group') {
        last.blocks.push({ block, index: i })
      } else {
        items.push({ kind: 'tool_group', blocks: [{ block, index: i }] })
      }
    } else if (block.type === 'thinking') {
      if (!block.text && !activeThinking.some((slot) => slot.index === i)) continue
      items.push({ kind: 'thinking', block, index: i })
    } else {
      items.push({ kind: 'other', block, index: i })
    }
  }

  return (
    <div
      data-testid="MessageBubble"
      data-id={message.id}
      className="group/msg flex flex-col gap-2 animate-fade-in"
    >
      {items.map((item, gi) => {
        if (item.kind === 'thinking') {
          const active = activeThinking.find((slot) => slot.index === item.index)
          return (
            <ThinkingBlock
              key={item.index}
              text={item.block.text || ''}
              isActive={!!active}
              // The item's own clock when the engine measured one; the message
              // timestamp is only right for a thought that opened the message.
              startedAt={active ? (active.startedAt ?? message.timestamp) : undefined}
              durationMs={item.block.durationMs}
            />
          )
        }
        if (item.kind === 'other') {
          return <ContentBlockView key={item.index} block={item.block} />
        }
        // Single tool call — render directly
        if (item.blocks.length === 1) {
          const { block, index } = item.blocks[0]
          const result = resultMap.get(block.toolUseId)
          const approval = approvalMap.get(block.toolUseId)
          const decision = decisionMap.get(block.toolUseId)
          return renderToolBlock(toolMap, block, result, approval, index, decision, isLastAssistant)
        }
        // Multiple tool calls — wrap in bordered group
        return (
          <div
            key={`group-${gi}`}
            className="rounded-xl border border-border p-2 flex flex-col gap-2"
          >
            {item.blocks.map(({ block, index }) => {
              const result = block.toolUseId ? resultMap.get(block.toolUseId) : undefined
              const approval = block.toolUseId ? approvalMap.get(block.toolUseId) : undefined
              const decision = block.toolUseId ? decisionMap.get(block.toolUseId) : undefined
              return renderToolBlock(
                toolMap,
                block,
                result,
                approval,
                index,
                decision,
                isLastAssistant
              )
            })}
          </div>
        )
      })}
      {/* Branch off: hidden until the message is hovered. Spins a new session
          seeded with everything up to and including this assistant turn.
          Gated on capabilities.forkFromMessage so engines that don't support
          turn-granular forking never show this button. */}
      {activeSessionId && forkCapability && (
        <div className="opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            data-testid="MessageBubble.fork"
            onClick={handleFork}
            disabled={forking}
            title="Fork a new session from this point"
            className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="rotate-90"
            >
              <circle cx="12" cy="18" r="3" />
              <circle cx="6" cy="6" r="3" />
              <circle cx="18" cy="6" r="3" />
              <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
              <path d="M12 12v3" />
            </svg>
            <span>Fork</span>
          </button>
        </div>
      )}
    </div>
  )
})

const ContentBlockView = memo(function ContentBlockView({
  block
}: {
  block: ContentBlock
}): React.JSX.Element | null {
  if (block.type === 'text' && block.text) {
    return (
      <div
        className="text-[13px] text-text-primary leading-[1.6]"
        data-markdown-source={block.text}
      >
        <MarkdownRenderer content={block.text} />
      </div>
    )
  }

  return null
})

function CompactSeparator({ summary }: { summary?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasSummary = !!summary?.trim()

  if (!hasSummary) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-border" />
        <span className="text-[11px] text-text-muted font-mono">compacted</span>
        <div className="flex-1 h-px bg-border" />
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-warning/30 bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] bg-warning/5 hover:bg-warning/10 transition-colors cursor-pointer"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-warning shrink-0"
        >
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <span className="font-mono font-medium text-warning">Compacted</span>
        <span className="text-text-secondary text-[12px] truncate flex-1 text-left">
          Context summary
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="text-[12px] leading-[1.6] max-h-80 overflow-y-auto">
            <MarkdownRenderer content={summary!} />
          </div>
        </div>
      )}
    </div>
  )
}

function CliCommandBlock({
  block
}: {
  block: Extract<ContentBlock, { type: 'cli_command' }>
}): React.JSX.Element {
  const name = block.commandName
  const args = block.commandArgs || ''
  const output = block.commandOutput || ''

  // "output" type is just stdout/stderr from a previous command — show inline
  if (name === 'output') {
    if (!output) return <></>
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]">
          <pre className="font-mono text-[12px] text-text-primary/70 whitespace-pre-wrap break-words">
            {output}
          </pre>
        </div>
      </div>
    )
  }

  // Command execution — show as user bubble with code block
  const display = args ? `/${name} ${args}` : `/${name}`
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]">
        <pre className="font-mono text-[12px] text-accent whitespace-pre-wrap break-words">
          {display}
        </pre>
      </div>
    </div>
  )
}

function ApiErrorBlock({
  block
}: {
  block: Extract<ContentBlock, { type: 'api_error' }>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const errorType = block.errorType
  const errorMessage = block.errorMessage

  const label =
    errorType === 'rate_limit'
      ? 'Rate Limited'
      : errorType === 'invalid_request'
        ? 'Invalid Request'
        : errorType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <div className="rounded-lg border border-danger/30 bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-danger shrink-0"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span className="font-medium text-danger">API Error</span>
        <span className="text-text-secondary truncate flex-1 text-left text-[12px]">{label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && errorMessage && (
        <div className="border-t border-border px-3 py-2.5">
          <pre className="text-[12px] font-mono text-danger/80 whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.5]">
            {errorMessage}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * The transcript's engine-neutral "a credential was rejected" row (ADR-070 §4),
 * replacing `AuthErrorBlock`.
 *
 * Every engine emits this block now (`api_error` / `errorType:
 * 'authentication'`), so the failure is anchored where it happened on all four
 * instead of Claude having history and the rest a floating card that vanished.
 *
 * THREE LIFETIMES, read off the session's `authRequired` (ADR-070 §2), because
 * the block itself is transcript DATA and outlives the problem:
 *
 *  · `broken`   — a rejection nobody has fixed: Sign in + the disclosure;
 *  · `resolved` — `provider:auth-resolved` landed and the prompt is still
 *                 un-sent: the retry, which is the only work left;
 *  · `settled`  — no owed sign-in, which is what a RELOADED transcript always
 *                 restores to. It has **no action at all**. That is the specific
 *                 bug this rewrite fixes: the old row kept a live "Sign in" for
 *                 a credential fixed three days ago, and a component-local
 *                 `dismissed` was its only answer — so the row came back on the
 *                 next reload, permanently. A settled row is history; history
 *                 has nothing to dismiss and nothing to act on.
 *
 * EXACTLY TWO hit areas in `broken` — the Sign in link and the disclosure
 * toggle. The sentence is inert, selectable text and there is no whole-row
 * onClick: a whole-row target beside two real actions is how a user gets an
 * accidental dialog while trying to copy an error out of permanent history.
 *
 * The retry prompt comes from `authRequired.retryPrompt`, captured by the
 * reducer at failure time. There is deliberately no message walk here — this
 * component and the deleted `AuthRequiredRow` each grew their own, and they
 * disagreed.
 */
function AuthTranscriptRow({
  block
}: {
  block: Extract<ContentBlock, { type: 'api_error' }>
}): React.JSX.Element {
  // The session whose TRANSCRIPT this is — never the active one. See
  // {@link TranscriptSessionContext}: `null` (automation-run history, or any
  // other host) has no live fact and gets the settled row.
  const routingId = useTranscriptSessionId()
  const sessionFact = useSessionStore((s) =>
    routingId ? (s.sessions[routingId]?.authRequired ?? null) : null
  )
  const providerAccounts = useSessionStore((s) => s.providerAccounts)
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const retrySend = useSessionStore((s) => s.retrySend)
  const clearAuthRequired = useSessionStore((s) => s.clearAuthRequired)
  const [expanded, setExpanded] = useState(false)

  // The session's fact is THIS row's lifetime only while the two are about the
  // same credential. ADR-070 §4 matches per session rather than per block and
  // accepts the resulting duplication — but only between rows that name the
  // SAME provider. A session that failed on Anthropic and later on ChatGPT
  // otherwise rendered its Anthropic row saying "Claude rejected the
  // credential" above a Sign in that opened ChatGPT: named one, acted on
  // another. A block that names nobody predates the field and still defers.
  const authRequired =
    sessionFact && (block.providerId === undefined || block.providerId === sessionFact.providerId)
      ? sessionFact
      : null

  const lifetime = !authRequired
    ? 'settled'
    : authRequired.resolved === true
      ? 'resolved'
      : 'broken'
  // WHOSE credential was refused is a property of the BLOCK, not of the
  // session: `authRequired` is nulled the moment the failure settles, and
  // settled is what a reloaded session always restores to — so reading the name
  // from the session alone made a Claude failure read "the credential was
  // rejected", provider unknown, for the rest of that transcript's life. The
  // session's live fact is the fallback, for blocks written before the field
  // existed (it is optional exactly so those stay valid).
  const named = block.providerId ?? authRequired?.providerId
  const providerId = authRequired?.providerId
  const drivable = providerId !== undefined && isDrivableProvider(providerId)
  // Verbatim, and THIS block's words win: they are per-block correct, while the
  // event's message describes whatever the session failed on last. The message
  // is the fallback for a block that carried no text of its own.
  const detail = block.errorMessage || authRequired?.message
  const sentence = named
    ? `Turn stopped — ${providerDisplayName(named)} rejected the credential.`
    : 'Turn stopped — the credential was rejected.'

  const rule =
    lifetime === 'broken'
      ? 'border-danger/50'
      : lifetime === 'resolved'
        ? 'border-success/50'
        : 'border-border'

  const signIn = (): void => {
    if (!providerId) return
    if (!drivable) {
      // No ClaudeUI flow owns an engine-native credential, so offering a dialog
      // would be a dead affordance (ADR-030).
      openProviderSettings()
      return
    }
    openSignIn({
      providerId,
      mode: 'reauth',
      ...(authRequired?.accountId ? { accountId: authRequired.accountId } : {}),
      ...(authRequired?.retryPrompt && routingId
        ? { retry: { routingId, prompt: authRequired.retryPrompt } }
        : {})
    })
  }

  const retry = (): void => {
    if (!routingId || !authRequired?.retryPrompt) return
    void retrySend(routingId, authRequired.retryPrompt)
    // Performing the retry IS lifetime 3 (ADR-070 §2) — don't wait for the
    // respawned turn to start running before the row stops offering it.
    clearAuthRequired(routingId)
  }

  /** The account a resolution signed in as, when the vault's list names one. */
  const signedInAs =
    providerId === 'chatgpt' && authRequired?.accountId
      ? providerAccounts?.accounts.find((account) => account.id === authRequired.accountId)?.email
      : undefined

  return (
    <div
      data-testid="AuthTranscriptRow"
      data-lifetime={lifetime}
      {...(named ? { 'data-id': named } : {})}
      className={`border-l-2 ${rule} pl-3 py-0.5 animate-fade-in`}
    >
      <div
        className={`text-[12px] ${lifetime === 'settled' ? 'text-text-muted' : 'text-text-primary'}`}
      >
        {sentence}
      </div>
      <div className="mt-1.5 flex items-center gap-3 flex-wrap">
        {lifetime === 'resolved' && (
          <span data-testid="AuthTranscriptRow.signedIn" className="text-[11px] text-success">
            ✓ signed in{signedInAs ? ` as ${signedInAs}` : ''}
          </span>
        )}
        {lifetime === 'resolved' && authRequired?.retryPrompt && (
          <button
            type="button"
            data-testid="AuthTranscriptRow.retry"
            onClick={retry}
            className="text-[12px] font-medium rounded-md px-2.5 py-1 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer"
          >
            Retry this prompt
          </button>
        )}
        {lifetime === 'broken' && (
          <button
            type="button"
            data-testid={drivable ? 'AuthTranscriptRow.signIn' : 'AuthTranscriptRow.settings'}
            data-id={providerId}
            onClick={signIn}
            className="text-[12px] text-accent underline decoration-dotted cursor-pointer"
          >
            {drivable ? 'Sign in' : 'Open provider settings'}
          </button>
        )}
        {detail && (
          <button
            type="button"
            data-testid="AuthTranscriptRow.disclose"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="text-[11px] text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
          >
            {expanded ? '▴' : '▾'} what the engine said
          </button>
        )}
      </div>
      {expanded && detail && (
        <pre
          data-testid="AuthTranscriptRow.message"
          className="mt-2 text-[11px] font-mono text-danger/80 whitespace-pre-wrap break-words bg-bg-secondary rounded-md p-2.5 border border-border max-h-64 overflow-y-auto"
        >
          {detail}
        </pre>
      )}
    </div>
  )
}
