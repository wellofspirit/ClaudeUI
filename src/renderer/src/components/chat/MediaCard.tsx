/**
 * MediaCard — the card of a hosted `generate_image` / `generate_video` call, the same on
 * every engine. Its state is the session's task records for the call's tool_use id
 * (`activeTasks`, `taskNotifications`; the host job service emits them), like TaskCard:
 * approval, running (clock, Stop), done (picture or player, chips), failed (the provider's
 * words, "Change model…"). Finished cards of older calls shrink to one row.
 *
 * The picture is the blob the notification names (`media.blobId`, ADR-087), never re-sent to
 * the model. A video plays from the authenticated media file route (`mediaFileUrl`).
 */
import { useEffect, useState } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionMode,
  PermissionSuggestion
} from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'
import type { MediaCatalog, MediaJobResult } from '../../../../shared/media-generation'
import { CHATGPT_PLAN_MODEL_REF, resolveMediaGeneration } from '../../../../shared/media-generation'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { useMediaCatalog } from '../../hooks/useMediaCatalog'
import { armStopPillFallback } from '../../lib/stop-pill'
import { formatBytes, formatCostUsd, mediaFileUrl, planUsageLine } from '../../lib/media-file-url'
import { BlobImage } from '../shared/BlobImage'
import { ApprovalButtons } from './ApprovalButtons'
import { TOOL_OUTPUT_SCOPE } from './ChatSearch/search-scope'
import { formatDuration, formatElapsed, useTicker } from '../../lib/elapsed'
import { latestNotification } from './task-state'
import { deriveMediaState, isRecentMediaCall, type MediaCardState } from './media-card-state'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type MediaView = Extract<ToolView, { kind: 'media' }>

export interface MediaCardProps {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: MediaView
  approval?: PendingApproval
  isPendingApproval: boolean
  permissionMode: PermissionMode
  onApproval: (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ) => Promise<void>
}

const CHIP =
  'text-[10.5px] leading-4 px-[7px] rounded-full border border-border text-text-secondary whitespace-nowrap'
const CHIP_GOOD =
  'text-[10.5px] leading-4 px-[7px] rounded-full border border-success/40 text-success whitespace-nowrap'
const CHIP_WARN =
  'text-[10.5px] leading-4 px-[7px] rounded-full border border-warning/40 text-warning whitespace-nowrap'
const BTN =
  'text-[11px] px-2 py-0.5 rounded border border-border text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer'
const LABEL = 'text-[10.5px] uppercase tracking-wider text-text-muted mb-1'

const SOURCE_LABEL = { 'chatgpt-plan': 'ChatGPT Plan', openai: 'OpenAI', openrouter: 'OpenRouter' }

/** `ChatGPT Plan` or `OpenRouter · qwen-image-3`. */
function modelChipText(media: Pick<MediaJobResult, 'source' | 'modelLabel'>): string {
  return media.source === 'chatgpt-plan'
    ? 'ChatGPT Plan'
    : `${SOURCE_LABEL[media.source]} · ${media.modelLabel}`
}

const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p

function Icon({ video }: { video: boolean }): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="text-accent shrink-0"
      aria-hidden="true"
    >
      {video ? (
        <>
          <rect x="2" y="5" width="14" height="14" rx="2" />
          <path d="M16 10l6-3v10l-6-3z" />
        </>
      ) : (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </>
      )}
    </svg>
  )
}

/** A local image (a source picture) through the host's file preview; its path when none comes. */
function LocalImage({ path, className }: { path: string; className: string }): React.JSX.Element {
  const sessionKey = useSessionStore((s) => s.activeSessionId)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSrc(null)
    const preview = window.api?.getSentFilePreview
    if (!preview) return
    preview(sessionKey ?? '', path)
      .then((res) => {
        if (live && 'src' in res) setSrc(res.src)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [sessionKey, path])
  return src ? (
    <img data-testid="MediaCard.source" src={src} alt={basename(path)} className={className} />
  ) : (
    <div
      data-testid="MediaCard.sourcePath"
      className="text-[11px] font-mono text-text-muted break-all max-w-[160px]"
    >
      {path}
    </div>
  )
}

/** The prompt, clamped, with its own expander. */
function PromptText({ text, clamp }: { text: string; clamp: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n').length
  const long = lines > 4 || text.length > 320
  return (
    <div>
      <div
        data-testid="MediaCard.prompt"
        className={`text-[12.5px] leading-[1.5] text-text-primary whitespace-pre-wrap break-words ${
          clamp && !open ? 'line-clamp-4' : ''
        }`}
      >
        {text}
      </div>
      {clamp && long && (
        <button
          type="button"
          data-testid="MediaCard.promptToggle"
          onClick={() => setOpen(!open)}
          className="text-[11px] text-accent cursor-pointer"
        >
          {open ? 'Show less' : `Show all (${lines} lines)`}
        </button>
      )}
    </div>
  )
}

function openSettings(group: string): void {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { page: 'media', group } }))
}

/** The ref the call will run on, as the approval chip names it. */
function approvalModel(
  view: MediaView,
  catalog: MediaCatalog | null,
  setting: string
): { text: string; included: boolean } | null {
  let ref = view.model ?? setting
  if (ref === 'off') return null
  if (ref === 'auto') {
    const models = catalog?.models.filter((m) => m.kind === view.media) ?? []
    ref = (models.find((m) => m.ref === CHATGPT_PLAN_MODEL_REF) ?? models[0])?.ref ?? 'auto'
  }
  if (ref === CHATGPT_PLAN_MODEL_REF) return { text: 'ChatGPT Plan · included', included: true }
  if (ref === 'auto') return { text: 'Automatic', included: false }
  const name = catalog?.models.find((m) => m.ref === ref)?.name ?? ref
  return { text: name, included: false }
}

function ApprovalBody({
  view,
  approval,
  permissionMode,
  onApproval
}: Pick<MediaCardProps, 'view' | 'approval' | 'permissionMode' | 'onApproval'>): React.JSX.Element {
  const settings = useSessionStore((s) => s.settings)
  const { catalog } = useMediaCatalog()
  const r = resolveMediaGeneration(settings.mediaGeneration)
  const model = approvalModel(view, catalog, view.media === 'image' ? r.imageModel : r.videoModel)
  const usage = model?.included ? planUsageLine(catalog?.planUsage) : null
  const images = view.images ?? []
  return (
    <>
      <div className="p-3 flex gap-3">
        {images.length > 0 && (
          <div className="shrink-0 flex flex-col gap-2" data-testid="MediaCard.sources">
            <div className={LABEL}>{view.media === 'video' ? 'Frames' : 'Source'}</div>
            {images.map((p) => (
              <div key={p}>
                <LocalImage path={p} className="w-40 rounded border border-border" />
                <div className="text-[11px] text-text-muted mt-1 font-mono truncate max-w-[160px]">
                  {basename(p)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className={LABEL}>Prompt</div>
          <PromptText text={view.prompt ?? ''} clamp />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {view.path && (
              <span data-testid="MediaCard.savePath" className={CHIP}>
                Save to <span className="font-mono text-text-primary">{view.path}</span>
              </span>
            )}
            {model && (
              <span data-testid="MediaCard.model" className={model.included ? CHIP_GOOD : CHIP}>
                {model.text}
              </span>
            )}
          </div>
        </div>
      </div>
      {usage && (
        <div data-testid="MediaCard.planUsage" className="px-3 pb-2 text-[11px] text-text-muted">
          {usage}
        </div>
      )}
      {approval && (
        <ApprovalButtons
          approval={approval}
          permissionMode={permissionMode}
          onApproval={onApproval}
        />
      )}
    </>
  )
}

function OpenActions({ media }: { media: MediaJobResult }): React.JSX.Element {
  const canOpen = typeof window.api?.openPath === 'function'
  const canReveal = typeof window.api?.showInFolder === 'function'
  return (
    <>
      {canOpen && (
        <button
          type="button"
          data-testid="MediaCard.open"
          className={BTN}
          onClick={() => void window.api.openPath?.(media.path)}
        >
          Open
        </button>
      )}
      {canReveal && (
        <button
          type="button"
          data-testid="MediaCard.reveal"
          className={BTN}
          onClick={() => void window.api.showInFolder?.(media.path)}
        >
          Reveal
        </button>
      )}
      <button
        type="button"
        data-testid="MediaCard.copyPath"
        className={BTN}
        onClick={() => void navigator.clipboard?.writeText(media.path).catch(() => undefined)}
      >
        Copy path
      </button>
    </>
  )
}

type Compare = 'before' | 'after' | 'side'

function DoneBody({ media, view }: { media: MediaJobResult; view: MediaView }): React.JSX.Element {
  const [compare, setCompare] = useState<Compare>('after')
  const [showPrompt, setShowPrompt] = useState(false)
  const inputs = media.inputs ?? []
  const prompt = media.revisedPrompt ?? view.prompt
  const frame = 'w-full rounded border border-border'
  const picture =
    media.kind === 'video' ? (
      (() => {
        const url = media.fileId ? mediaFileUrl(media.fileId) : null
        return url ? (
          <video
            data-testid="MediaCard.video"
            src={url}
            controls
            preload="metadata"
            className="w-full rounded border border-border bg-bg-primary"
          />
        ) : (
          <div
            data-testid="MediaCard.videoPath"
            className="rounded border border-border px-3 py-6 text-center text-[12px] text-text-secondary"
          >
            Saved to <span className="font-mono break-all">{media.path}</span>
          </div>
        )
      })()
    ) : media.blobId ? (
      <BlobImage
        blobId={media.blobId}
        mediaType={media.mime}
        alt={view.prompt ?? 'Generated image'}
        className={`${frame} object-contain`}
        placeholderSize={240}
      />
    ) : (
      <div
        data-testid="MediaCard.imagePath"
        className="rounded border border-border px-3 py-6 text-center text-[12px] text-text-secondary"
      >
        Image unavailable. Saved to <span className="font-mono break-all">{media.path}</span>
      </div>
    )
  const before = inputs[0] ? (
    <LocalImage path={inputs[0]} className={`${frame} object-contain`} />
  ) : null

  const size = media.width && media.height ? `${media.width}×${media.height} ` : ''
  const ext = (media.mime.split('/')[1] ?? '').toUpperCase()
  const detail =
    media.kind === 'video' && media.durationSeconds
      ? `${formatElapsed(media.durationSeconds)} · ${size}${ext} · ${formatBytes(media.bytes)}`
      : `${size}${ext} · ${formatBytes(media.bytes)}`

  return (
    <div className="p-3">
      {inputs.length > 0 && (
        <div className="mb-2 flex" data-testid="MediaCard.compare">
          {(
            [
              ['before', 'Before'],
              ['after', 'After'],
              ['side', 'Side by side']
            ] as const
          ).map(([id, label], i) => (
            <button
              key={id}
              type="button"
              data-testid="MediaCard.compareOption"
              data-id={id}
              aria-pressed={compare === id}
              onClick={() => setCompare(id)}
              className={`px-2.5 py-0.5 text-[11px] border border-border ${i > 0 ? '-ml-px' : 'rounded-l'} ${
                i === 2 ? 'rounded-r' : ''
              } ${compare === id ? 'bg-accent/15 text-text-primary border-accent/50' : 'text-text-secondary'}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="relative group">
        {compare === 'side' && before ? (
          <div className="grid grid-cols-2 gap-2" data-testid="MediaCard.image">
            {before}
            {picture}
          </div>
        ) : (
          <div data-testid="MediaCard.image">
            {compare === 'before' && before ? before : picture}
          </div>
        )}
        <div className="absolute top-2 right-2 hidden group-hover:flex gap-1 [&>button]:bg-bg-primary/80">
          <OpenActions media={media} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span data-testid="MediaCard.chip" data-id="format" className={CHIP}>
          {detail}
        </span>
        <span data-testid="MediaCard.chip" data-id="elapsed" className={CHIP}>
          {formatDuration(media.elapsedMs)}
        </span>
        {media.source === 'chatgpt-plan' ? (
          <>
            <span data-testid="MediaCard.chip" data-id="model" className={CHIP_GOOD}>
              ChatGPT Plan · included
            </span>
            {media.kind === 'image' && (
              <span
                data-testid="MediaCard.chip"
                data-id="planSet"
                className={CHIP_WARN}
                title="The ChatGPT plan fixes the size and quality whatever is asked"
              >
                size &amp; quality set by plan
              </span>
            )}
          </>
        ) : (
          <>
            <span data-testid="MediaCard.chip" data-id="model" className={CHIP}>
              {modelChipText(media)}
            </span>
            {media.costUsd != null && (
              <span data-testid="MediaCard.chip" data-id="cost" className={CHIP}>
                {formatCostUsd(media.costUsd)}
              </span>
            )}
          </>
        )}
        {prompt && (
          <button
            type="button"
            data-testid="MediaCard.promptToggle"
            onClick={() => setShowPrompt(!showPrompt)}
            className="ml-auto text-[11px] text-accent cursor-pointer"
          >
            {media.revisedPrompt ? 'Revised prompt' : 'Prompt'} {showPrompt ? '▴' : '▾'}
          </button>
        )}
      </div>
      {showPrompt && prompt && (
        <div className="mt-2">
          <PromptText text={prompt} clamp={false} />
        </div>
      )}
    </div>
  )
}

function title(view: MediaView, state: MediaCardState): string {
  const noun = view.media === 'video' ? 'video' : 'image'
  const edit = view.media === 'image' && (view.images?.length ?? 0) > 0
  switch (state) {
    case 'running':
      return edit ? 'Editing image' : `Generating ${noun}`
    case 'done':
      return edit ? 'Edited image' : `Generated ${noun}`
    case 'error':
      return `${edit ? 'Edit' : 'Generate'} ${noun} failed`
    case 'stopped':
      return `${edit ? 'Edit' : 'Generate'} ${noun} stopped`
    default:
      return edit ? 'Edit image' : `Generate ${noun}`
  }
}

export function MediaCard({
  block,
  result,
  view,
  approval,
  isPendingApproval,
  permissionMode,
  onApproval
}: MediaCardProps): React.JSX.Element {
  const toolUseId = block.toolUseId
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const recent = useActiveSession((s) => isRecentMediaCall(s.messages, toolUseId))
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const [expanded, setExpanded] = useState<boolean | null>(null)

  const notification = latestNotification(taskNotifications, toolUseId)
  const activeTask = activeTasks[toolUseId]
  const state = deriveMediaState({
    isPendingApproval: isPendingApproval && !!approval,
    isHistorical,
    activeTask,
    notification,
    hasResult: !!result,
    resultIsError: !!result?.isError
  })
  const media = notification?.media
  const startedAt = state === 'running' ? activeTask?.startedAt : undefined
  const now = useTicker(startedAt !== undefined)
  const isStopping = stoppingTaskIds.includes(toolUseId)

  const stop = async (): Promise<void> => {
    if (!activeSessionId) return
    const rid = activeSessionId
    setTaskStopping(rid, toolUseId)
    const res = await window.api.stopTask(rid, toolUseId, false)
    if (!res.success) {
      window.api.logError('MediaCard', `Failed to stop job: ${res.error}`)
      clearTaskStopping(rid, toolUseId)
      return
    }
    armStopPillFallback(rid, toolUseId)
  }

  const collapsed = state === 'done' && !(expanded ?? recent)
  const border =
    state === 'approval'
      ? 'border-warning/40'
      : state === 'running'
        ? 'border-accent/30'
        : state === 'error'
          ? 'border-danger/30'
          : 'border-border'
  const subtitle = media ? basename(media.path) : view.path ? view.path : (view.prompt ?? '')
  const errorText = notification?.summary || (result?.isError ? result.toolResult : '') || ''
  const modelRef = view.model
  const showsOpenRouter = media?.source === 'openrouter' || modelRef?.startsWith('openrouter/')

  const header = (
    <div className="flex items-center gap-2 px-3 min-h-9 py-1.5 text-[13px]">
      <Icon video={view.media === 'video'} />
      <span className="font-medium text-text-primary shrink-0">{title(view, state)}</span>
      <span className="text-text-secondary truncate min-w-0">{subtitle}</span>
      <div className="flex-1" />
      {media && state === 'done' && (
        <span
          data-testid="MediaCard.headerModel"
          className={media.source === 'chatgpt-plan' ? CHIP_GOOD : CHIP}
        >
          {modelChipText(media)}
        </span>
      )}
      {state === 'error' && (media?.modelLabel || modelRef) && (
        <span data-testid="MediaCard.headerModel" className={CHIP}>
          {media ? modelChipText(media) : modelRef}
        </span>
      )}
      {state === 'running' && (
        <>
          {startedAt !== undefined && (
            <span
              data-testid="MediaCard.elapsed"
              className="text-[11px] text-text-secondary tabular-nums"
            >
              {formatElapsed(Math.floor(Math.max(0, (now - startedAt) / 1000)))}
            </span>
          )}
          {isStopping ? (
            <span className="text-[11px] text-text-muted">stopping...</span>
          ) : (
            <button
              type="button"
              data-testid="MediaCard.stop"
              className={BTN}
              onClick={() => void stop()}
            >
              Stop
            </button>
          )}
        </>
      )}
      {state === 'done' && collapsed === false && expanded === true && !recent && (
        <button
          type="button"
          data-testid="MediaCard.collapse"
          className={BTN}
          onClick={() => setExpanded(false)}
        >
          Collapse
        </button>
      )}
    </div>
  )

  return (
    <div
      data-testid="MediaCard"
      data-state={collapsed ? 'collapsed' : state}
      data-media={view.media}
      className={`rounded-lg border ${border} bg-bg-secondary overflow-hidden`}
    >
      {collapsed && media ? (
        <button
          type="button"
          data-testid="MediaCard.expand"
          onClick={() => setExpanded(true)}
          className="w-full flex items-center gap-2 px-3 min-h-9 py-1.5 text-[13px] text-left cursor-pointer hover:bg-bg-hover/40"
        >
          {media.blobId && media.kind === 'image' ? (
            <BlobImage
              blobId={media.blobId}
              mediaType={media.mime}
              alt=""
              className="w-12 h-8 rounded border border-border object-cover"
              placeholderSize={32}
            />
          ) : (
            <Icon video={media.kind === 'video'} />
          )}
          <span className="font-medium text-text-primary shrink-0">{title(view, state)}</span>
          <span className="text-text-secondary truncate min-w-0">{basename(media.path)}</span>
          <div className="flex-1" />
          <span className={media.source === 'chatgpt-plan' ? CHIP_GOOD : CHIP}>
            {modelChipText(media)}
          </span>
          {media.costUsd != null && <span className={CHIP}>{formatCostUsd(media.costUsd)}</span>}
          <span className="text-[11px] text-text-muted tabular-nums">
            {formatDuration(media.elapsedMs)}
          </span>
          <span className="text-text-muted">▸</span>
        </button>
      ) : (
        <>
          {header}
          {state === 'approval' && (
            <div className="border-t border-border">
              <ApprovalBody
                view={view}
                approval={approval}
                permissionMode={permissionMode}
                onApproval={onApproval}
              />
            </div>
          )}
          {state === 'running' && (
            <div className="border-t border-border p-3 flex items-center gap-3">
              <div
                data-testid="MediaCard.placeholder"
                className="w-56 aspect-[3/2] rounded border border-border bg-bg-tertiary animate-pulse flex items-center justify-center text-[11px] text-text-secondary"
              >
                {view.media === 'video' ? 'usually a few minutes' : 'usually 20–60 s'}
              </div>
            </div>
          )}
          {state === 'done' && media && (
            <div className="border-t border-border">
              <DoneBody media={media} view={view} />
            </div>
          )}
          {state === 'unavailable' && (
            <div
              data-testid="MediaCard.unavailable"
              className="border-t border-border px-3 py-2.5 text-[12px] text-text-secondary"
            >
              The {view.media} is no longer available.
            </div>
          )}
          {(state === 'error' || state === 'stopped') && (
            <div className="border-t border-border p-3 text-[12px]">
              {errorText && (
                <div
                  data-testid="MediaCard.error"
                  {...TOOL_OUTPUT_SCOPE}
                  className={`whitespace-pre-wrap break-words ${state === 'error' ? 'text-danger' : 'text-text-secondary'}`}
                >
                  {errorText}
                </div>
              )}
              {state === 'error' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="MediaCard.changeModel"
                    className={BTN}
                    onClick={() => openSettings('models')}
                  >
                    Change {view.media} model…
                  </button>
                  {showsOpenRouter && (
                    <a
                      data-testid="MediaCard.guardrails"
                      href="https://openrouter.ai/settings/privacy"
                      target="_blank"
                      rel="noreferrer"
                      className={BTN}
                    >
                      Open OpenRouter guardrails ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
          {state === 'unknown' && result?.toolResult && (
            <div
              {...TOOL_OUTPUT_SCOPE}
              className="border-t border-border px-3 py-2 text-[12px] text-text-secondary whitespace-pre-wrap break-words"
            >
              {result.toolResult}
            </div>
          )}
        </>
      )}
    </div>
  )
}
