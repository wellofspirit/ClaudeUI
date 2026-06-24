/**
 * Shared types for kind bodies — the per-ToolKind renderers that consume a
 * neutral `ToolView` and produce the body content for a ToolCard (or, for the
 * custom-layout diagram/mockup kinds, the entire card).
 *
 * Behavior-preserving note: these bodies are a code-MOVE of the input/result
 * switches that used to live in ToolCallBlock/View.tsx. They keep the exact same
 * truncation (5000/2000), markup, and streaming-by-`block.toolUseId` wiring.
 */

import type {
  ContentBlock,
  PendingApproval,
  PermissionMode,
  PermissionSuggestion
} from '../../../../../../shared/types'
import type { ToolView } from '../../../../../../shared/tool-kinds'
import type { ThemeId } from '../../../../stores/session-store'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export interface BashOutputSlice {
  output: string
  totalLines: number
  totalBytes: number
}

export interface BgOutputSlice {
  tail: string
  totalSize: number
}

/**
 * Props passed to every kind body. A superset — each body uses what it needs.
 *
 * `view` is the neutral, normalized shape (the body never reads engine field
 * names). `block`/`result` are passed through for streaming join keys
 * (`block.toolUseId`) and the raw result text + `isError` flag.
 */
export interface KindBodyProps {
  view: ToolView
  block: ToolUseBlock
  result?: ToolResultBlock
  /** Whether the card is currently expanded (standard kinds gate body on this). */
  expanded: boolean
  hideToolInput: boolean
  theme: ThemeId
  isError: boolean
  // --- command-only streaming/background state (read by CommandBody) ---
  isBackgroundBash: boolean
  isForegroundBashRunning: boolean
  bashOutput?: BashOutputSlice
  bgOutput?: BgOutputSlice
  // --- approval (only the custom-layout diagram/mockup bodies render their own
  //     ApprovalButtons; standard kinds let ToolCard place them) ---
  isPendingApproval: boolean
  approval?: PendingApproval
  permissionMode: PermissionMode
  onApproval: (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ) => Promise<void>
  // --- custom-layout chrome (diagram/mockup render their own card) ---
  /** Border class from the resolved visual state (custom bodies build their own card). */
  borderColor: string
  /** Status icon element from the resolved visual state (custom bodies reuse it). */
  statusIcon: React.JSX.Element
  /**
   * Max chars to show before the "Show more" toggle. From AppSettings.toolOutputMaxChars.
   * Passed through from ToolCallBlock → ToolCard → body props.
   */
  toolOutputMaxChars?: number
}

/**
 * A kind renderer. `layout`:
 *  - `standard`: ToolCard renders the header/expand chrome + ApprovalButtons +
 *    background-task controls. `Body` renders only the inner expand-region
 *    content (input + optional live output + result).
 *  - `custom`: the diagram/mockup kinds render their own full card (custom
 *    header + always-visible content + shared `<ApprovalButtons>`); ToolCard
 *    renders nothing around them.
 */
export interface KindRenderer {
  layout: 'standard' | 'custom'
  Body: (props: KindBodyProps) => React.JSX.Element | null
}
