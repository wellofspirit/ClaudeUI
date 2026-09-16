import { memo, useState } from 'react'
import type {
  ChatMessage,
  ContentBlock,
  PendingApproval,
  ToolReviewBlock
} from '../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'
import { ExitPlanModeCard } from './ExitPlanModeCard'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { TodoToolBlock } from './TodoToolBlock'
import { SleepRow } from './SleepRow'
import { ContextNoteBlock } from './ContextNoteBlock'
import { ReviewResultCard } from './ReviewResultCard'
import { TaskCard } from './TaskCard'
import { hostedMcpKind } from '../../../../shared/tool-kinds'
import type { EngineToolMap } from '../../../../shared/tool-kinds'
import { engineToolMap } from './tool-registry/engine-tool-maps'
import { useImageGallery } from '../shared/ImageViewer'

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
  // A permission judge's verdict on this call (F18). Only the passive card shows
  // it: the lifted kinds below are interactions (a plan, a question, a todo
  // list), and none of them is an action a judge gates.
  review?: ToolReviewBlock,
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
  if (kind === 'task' && view.kind === 'task') {
    return <TaskCard key={key} block={block} result={result} view={view} approval={approval} />
  }

  // Passive kinds → ToolCallBlock host → ToolCard + kind body
  // (command/fileEdit/fileWrite/fileRead/search/web/diagram/mockup/mcp/unknown).
  return (
    <ToolCallBlock key={key} block={block} result={result} approval={approval} review={review} />
  )
}

interface MessageBubbleProps {
  message: ChatMessage
  pendingApprovals: PendingApproval[]
  isLastAssistant: boolean
  thinkingStartedAt: number | null
}

export const MessageBubble = memo(function MessageBubble({
  message,
  pendingApprovals,
  isLastAssistant,
  thinkingStartedAt
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
              <AuthErrorBlock key={i} block={block} />
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
  // …and with a permission judge's verdict on them (F18). LAST one wins: a
  // re-review after "approve anyway" is a new decision, not a second opinion.
  const reviewMap = new Map<string, ToolReviewBlock>()
  for (const block of message.content) {
    if (block.type === 'tool_result') {
      resultMap.set(block.toolUseId, block)
    } else if (block.type === 'tool_review') {
      reviewMap.set(block.toolUseId, block)
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
      // A verdict renders ON its card, never as a row of its own — and never as
      // a gap that would split a run of tool calls into two groups.
      b.type !== 'tool_review' &&
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
      items.push({ kind: 'thinking', block, index: i })
    } else {
      items.push({ kind: 'other', block, index: i })
    }
  }

  // Find the last thinking item so only it can be "active"
  const lastThinkingGi = items.reduce((acc, item, i) => (item.kind === 'thinking' ? i : acc), -1)

  return (
    <div
      data-testid="MessageBubble"
      data-id={message.id}
      className="group/msg flex flex-col gap-2 animate-fade-in"
    >
      {items.map((item, gi) => {
        if (item.kind === 'thinking') {
          const isLast = gi === lastThinkingGi
          // Only hide if this message was updated during the current thinking session
          // (meaning the SDK sent a partial with this thinking block for the active turn)
          const isActive =
            isLast &&
            isLastAssistant &&
            !!thinkingStartedAt &&
            message.timestamp >= thinkingStartedAt
          // Active thinking is rendered by the standalone ThinkingBlock in ChatPanel
          if (isActive) return null
          return (
            <ThinkingBlock
              key={item.index}
              text={item.block.text || ''}
              isActive={false}
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
          const review = reviewMap.get(block.toolUseId)
          return renderToolBlock(toolMap, block, result, approval, index, review, isLastAssistant)
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
              const review = block.toolUseId ? reviewMap.get(block.toolUseId) : undefined
              return renderToolBlock(
                toolMap,
                block,
                result,
                approval,
                index,
                review,
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

// Small button helpers — match FloatingApproval styling.
function PrimaryBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...props}
      className="text-[12px] font-medium rounded-md px-3.5 py-1.5 bg-accent text-bg-primary hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
    />
  )
}
function GhostBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      {...props}
      className="text-[12px] font-medium rounded-md px-3.5 py-1.5 border border-border-bright text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
    />
  )
}

/**
 * Authentication-error variant of the API error card (ADR-014 / ADR-068 §3).
 *
 * A compact row, not a flow. It used to walk the whole OAuth state machine
 * inline — waiting, manual paste, success, retry — which made the transcript the
 * fourth place the Claude sign-in was implemented. Everything that MOVES now
 * lives in `SignInDialog`; what stays here is the fact the turn reports: this
 * credential was rejected, here is the action.
 *
 * "Sign in" captures the session's last user prompt and hands it to the dialog,
 * whose done state offers to re-send it through the respawn-aware `retrySend` —
 * the same recovery the old inline card's Retry gave, one surface further up.
 */
function AuthErrorBlock({
  block
}: {
  block: Extract<ContentBlock, { type: 'api_error' }>
}): React.JSX.Element | null {
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  const startSignIn = (): void => {
    const state = useSessionStore.getState()
    const routingId = state.activeSessionId
    const messages = routingId ? (state.sessions[routingId]?.messages ?? []) : []
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    const prompt = (lastUser?.content ?? [])
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    openSignIn({
      providerId: 'anthropic',
      mode: 'reauth',
      ...(routingId && prompt ? { retry: { routingId, prompt } } : {})
    })
  }

  return (
    <div
      data-testid="AuthErrorBlock"
      className="rounded-lg border border-danger/30 bg-bg-secondary overflow-hidden animate-fade-in"
    >
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-danger shrink-0 mt-0.5"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-danger">
            Turn stopped: Claude rejected the credential
          </div>
          <div className="text-[12px] text-text-secondary mt-0.5 break-words">
            {block.errorMessage}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-border">
        <GhostBtn data-testid="AuthErrorBlock.dismiss" onClick={() => setDismissed(true)}>
          Dismiss
        </GhostBtn>
        <PrimaryBtn data-testid="AuthErrorBlock.signIn" onClick={startSignIn}>
          Sign in
        </PrimaryBtn>
      </div>
    </div>
  )
}
