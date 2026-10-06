/**
 * `estimateMessageHeight` — what a chat message is likely to measure, from its
 * data alone, for `contain-intrinsic-size`.
 *
 * Every message is a `content-visibility: auto` box. One that has never been
 * rendered is skipped, and occupies its `contain-intrinsic-size` (`auto <n>px`:
 * the browser swaps in the REAL height once it has rendered, so the estimate only
 * ever matters for a message the user has not seen). With a flat 100px the
 * scrollbar and scroll anchoring are wrong by the ratio between 100px and what
 * real messages measure (p50 450-730px, p90 1.3-2.5k, max 5-13k, baseline
 * 2026-10-07), which is where the thumb drift and the multi-thousand-px anchoring
 * jumps came from. The goal is the right order of magnitude per block type, not a
 * layout engine: a text/line count scaled by the column width, plus the
 * component's own paddings, caps and defaults — each constant below names the
 * source it was read from.
 *
 * UNITS. The wrapper this size goes on lives INSIDE the zoomed content div
 * (`ChatPanel`: `zoom: chatFontScale / uiFontScale`). A length on the wrapper is
 * scaled by that zoom exactly as the lengths of its children are, so the estimate
 * is expressed in the children's own CSS px: every constant below is the number in
 * the component's class list (`h-9` = 36, `text-[13px]`), with NO zoom division.
 * The column width fed in must be in the same units — `clientWidth` of a message
 * wrapper is (see ChatPanel).
 *
 * Pure: no DOM, no store. `options` carries the settings that change what a card
 * renders by default.
 */

import type { ChatMessage, ContentBlock, EngineId } from '../../../../../shared/types'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { engineToolMap } from '../tool-registry/engine-tool-maps'
import { detectOutputFormat } from '../../../lib/shell-highlight'
import { groupSearchResult } from '../tool-registry/kinds/SearchBody'

// ── Settings that change the default rendering ───────────────────────────────

export interface EstimateOptions {
  /** Whose tool map classifies the calls. */
  engineId: EngineId
  /** Settings `expandToolCalls`: cards open by default (DEFAULT_SETTINGS: true). */
  expandToolCalls: boolean
  /** Settings `expandReadResults`: a Read card opens too (DEFAULT_SETTINGS: false). */
  expandReadResults: boolean
  /** Settings `expandThinking`: thinking blocks open (DEFAULT_SETTINGS: false). */
  expandThinking: boolean
  /** Settings `hideToolInput` drops the INPUT/RESULT labels (DEFAULT_SETTINGS: false). */
  hideToolInput: boolean
  /** Settings `toolOutputMaxChars` caps Read/Write bodies (DEFAULT_SETTINGS: 5000). */
  toolOutputMaxChars: number
  /** The engine offers fork-from-message: assistant messages carry the (invisible) Fork row. */
  forkRow: boolean
}

export const DEFAULT_ESTIMATE_OPTIONS: EstimateOptions = {
  engineId: 'claude',
  expandToolCalls: true,
  expandReadResults: false,
  expandThinking: false,
  hideToolInput: false,
  toolOutputMaxChars: 5000,
  forkRow: false
}

// ── Typography (px) ──────────────────────────────────────────────────────────
// body { font-size: 13px; line-height: 1.5 } (assets/app.css); the UI font is the
// system sans (Segoe UI / -apple-system / Noto Sans); mono is JetBrains Mono.

/**
 * Mean advance of the sans UI font per character, 13px prose incl. spaces and
 * ragged-right waste. Measured against real renders (estimate-height.browser
 * test): Segoe UI ~6.2-6.3, so 6.4 leaves room for the wider SF / Noto stacks.
 */
export const PROSE_CHAR_PX = 6.4
/** JetBrains Mono advances 0.6em (assets/app.css @font-face). */
const MONO_EM = 0.6

/** Tailwind v4 arbitrary `text-[Npx]` sets no line-height, so it inherits body's 1.5. */
const INHERITED_LINE = 1.5

// ── Markdown (MarkdownRenderer.tsx `components`) ─────────────────────────────

/** `p`: mb-2 (the last child has last:mb-0). */
const MD_P_MARGIN = 8
/** `ul`/`ol`: pl-5 (20px indent), mb-2, li spaced by space-y-0.5 (2px). */
const MD_LIST_INDENT = 20
const MD_LIST_ITEM_GAP = 2
const MD_LIST_MARGIN = 8
/** `pre`: p-3 (24) + border (2), my-2; text-[11px] font-mono leading-[1.6]; overflow-x-auto, so lines do NOT wrap. */
const MD_CODE_CHROME = 26
const MD_CODE_MARGIN = 8
const MD_CODE_FONT = 11
const MD_CODE_LINE = MD_CODE_FONT * 1.6
/** Headings h1/h2/h3: [font px, margin-top, margin-bottom] (first child: mt-0). Line height inherits 1.6. */
const MD_HEADINGS: Record<number, readonly [number, number, number]> = {
  1: [15, 12, 8],
  2: [14, 10, 6],
  3: [13, 8, 4]
}
/** `blockquote`: border-l-2 + pl-3 (14px), my-2. */
const MD_QUOTE_INDENT = 14
const MD_QUOTE_MARGIN = 8
/** `hr`: my-3 and a 1px border. */
const MD_HR = { height: 1, margin: 12 }
/** `table`: wrapper my-2 + 2px border; th: py-1.5 + 1px border, 11px; td: py-1.5 + 1px border, 12px; lh 1.6. */
const MD_TABLE_CHROME = 2
const MD_TABLE_MARGIN = 8
const MD_TH_ROW = 11 * 1.6 + 12 + 1
const MD_TD_ROW = 12 * 1.6 + 12 + 1

// ── Cards (ToolCard.tsx and the kind bodies) ─────────────────────────────────

/** Card header `h-9`. */
const CARD_HEADER = 36
/** Card border: `border` (1px) when idle, `border-2` for the coloured states (success/error/running/pending). */
const CARD_BORDER_IDLE = 2
const CARD_BORDER_COLOURED = 4
/** The body wrapper's `border-t`. */
const SECTION_RULE = 1
/** A body section: `px-3 py-2.5`. */
const SECTION_PAD_Y = 20
const SECTION_PAD_X = 24
/** The `Input`/`Result` label: text-[11px] (lh 1.5) + mb-1.5. */
const LABEL = 11 * INHERITED_LINE + 6
/** A boxed `pre`/TerminalView: `p-2` (16) + 1px border each side. */
const BOX_CHROME_Y = 18
const BOX_CHROME_X = 18
/** The 12px mono box line: `text-[12px] leading-[1.3]`. */
const BOX_FONT = 12
/** Input `pre`s (ShellCode, JSON dump): `max-h-32` (border-box). */
const INPUT_BOX_MAX = 128
/** TerminalView: MAX_VISIBLE_HEIGHT = 10 * 12 * 1.3 + 16 (TerminalView.tsx). */
const TERMINAL_MAX = 10 * 12 * 1.3 + 16
/** OutputView boxes a detected grep / diff / JSON / file output at `maxHeight: 260` (OutputView.tsx). */
const OUTPUT_VIEW_MAX = 260
/** CodeView (Read/Write result): 11px mono, leading-[1.3], NO max-height, 1px border; line-number gutter. */
const CODE_LINE = 11 * 1.3
const CODE_CHROME = 2
/** The Show more/less link under a truncated Read: text-[11px] + flex gap-1. */
const SHOW_MORE = 11 * INHERITED_LINE + 4
/** SearchBody rows: `py-1` + border, the 11.5px path line, 11px match lines (lh 1.5), "+N more". */
const SEARCH_FILE_PAD = 9
const SEARCH_FILE_LINE = 11.5 * INHERITED_LINE
const SEARCH_MATCH_LINE = 11 * INHERITED_LINE
/** WebBody result entry: title (12px, lh 1.4) + url (11px, lh 1.4). */
const WEB_RESULT_LINES = 12 * 1.4 + 11 * 1.4
/** DiffViewer rows: --diff-line-height 16px (diff.css); a hunk header and the path line above it. */
const DIFF_ROW = 16
const DIFF_FRAME = 8 + 11 * INHERITED_LINE + 6
/** ToolResultImages: `px-3 py-2.5 flex gap-2 flex-wrap`, thumbnails `max-h-[120px]`. */
const RESULT_IMAGE = 120
const RESULT_IMAGE_GAP = 8
/** Review/denial strip shown between header and body when expanded. */
const DECISION_STRIP = 32
/** One-row cards: TodoToolBlock / SleepRow `h-7`, ToolNoteRow `min-h-7`. */
const ROW_CARD = 28
/** TaskCard collapsed: header h-9 + border-b, then the footer strip (px-3 py-1.5 + chips). */
const TASK_CARD = 36 + 1 + 31 + 2
/** Header-only lifted cards (ExitPlanModeCard / AskUserQuestionBlock collapsed): h-9 + borders. */
const LIFTED_HEADER = 38
/** AskUserQuestionBlock while a question is open: header + question + options. A coarse constant. */
const QUESTION_OPEN = 220
/** Diagram / mockup / image cards: h-9 header plus a body that renders asynchronously (SVG, iframe). A coarse constant. */
const MEDIA_CARD = 36 + 2 + 260

// ── Messages (MessageBubble.tsx) ─────────────────────────────────────────────

/** Items inside an assistant message: `flex flex-col gap-2`. */
const ITEM_GAP = 8
/** A multi-call group: `rounded-xl border p-2 flex flex-col gap-2`. */
const GROUP_CHROME = 18
/** ThinkingBlock toggle: text-[13px] button, lh 1.5. */
const THINKING_TOGGLE = 13 * INHERITED_LINE
/** ThinkingBlock body: mt-2, `max-h-80`, border-l-2 + pl-3 (14px), 13px/1.6 pre-wrap. */
const THINKING_BODY_MARGIN = 8
const THINKING_BODY_MAX = 320
const THINKING_INDENT = 14
/** The Fork row (opacity-0 but laid out): text-[10px] button + the container's gap-2. */
const FORK_ROW = 10 * INHERITED_LINE + ITEM_GAP
/** User bubble: `max-w-[85%] px-4 py-2.5`. */
const USER_MAX_FRACTION = 0.85
const USER_PAD_X = 32
const USER_PAD_Y = 20
/** Attachments in a user bubble: `flex gap-2 flex-wrap mb-2`; thumbnails max 200 (120 placeholder), PDF pill ~28. */
const USER_IMAGE = 160
const USER_DOC = 28
const USER_ATTACH_GAP = 8
/** Compact separator without a summary: `py-1` + a text-[11px] row. */
const COMPACT_SEPARATOR = 8 + 11 * INHERITED_LINE
/** api_error / compacted-with-summary header (`h-9` + the border). */
const COLLAPSED_ROW = 38
/** AuthTranscriptRow: sentence + the action row (py-0.5, mt-1.5, 12px lines). */
const AUTH_ROW = 4 + 12 * INHERITED_LINE + 6 + 24
/** ContextNoteBlock collapsed. */
const CONTEXT_NOTE = 30
/** ReviewResultCard: expanded by default, `max-h-96` body under an h-9 header. */
const REVIEW_BODY_MAX = 384
/** Fallback for a role/shape this module does not know. */
const UNKNOWN_HEIGHT = 100

// ── Text measurement ─────────────────────────────────────────────────────────

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Characters per line for `widthPx` of text at `charPx` per char (at least 1). */
function charsPerLine(widthPx: number, charPx: number): number {
  return Math.max(1, Math.floor(widthPx / charPx))
}

/** Visual lines of `text` wrapped at `cpl`: each explicit line is at least one. */
export function wrappedLineCount(text: string, cpl: number): number {
  if (text === '') return 0
  let lines = 0
  for (const line of text.split('\n')) lines += Math.max(1, Math.ceil(line.length / cpl))
  return lines
}

/** Explicit lines only (no wrapping): code that scrolls sideways. */
function plainLineCount(text: string): number {
  if (text === '') return 0
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed.split('\n').length
}

/** Prose height: `text` at `fontPx` over `widthPx`, line-height `lh` (a multiplier). */
function proseHeight(text: string, widthPx: number, fontPx = 13, lh = 1.6): number {
  const cpl = charsPerLine(widthPx, PROSE_CHAR_PX * (fontPx / 13))
  return wrappedLineCount(text, cpl) * fontPx * lh
}

// ── Markdown ─────────────────────────────────────────────────────────────────

interface MdBlock {
  height: number
  top: number
  bottom: number
}

const FENCE = /^\s*(```|~~~)/
const HEADING = /^(#{1,6})\s+(.*)$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Strip the inline markup that costs characters but renders no glyphs. */
function visibleText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*`]|~~/g, '')
}

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    LIST_ITEM.test(line) ||
    QUOTE.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_RULE.test(next))
  )
}

/** Height in px of `markdown` rendered by MarkdownRenderer at `widthPx`. */
export function estimateMarkdownHeight(markdown: string, widthPx: number): number {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MdBlock[] = []

  for (let i = 0; i < lines.length;) {
    const line = lines[i]
    if (line.trim() === '') {
      i++
      continue
    }

    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      i++ // closing fence
      const rows = Math.max(1, body.length)
      blocks.push({
        height: rows * MD_CODE_LINE + MD_CODE_CHROME,
        top: MD_CODE_MARGIN,
        bottom: MD_CODE_MARGIN
      })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const [fontPx, top, bottom] = MD_HEADINGS[Math.min(3, heading[1].length)]
      blocks.push({
        height: proseHeight(visibleText(heading[2]), widthPx, fontPx),
        top,
        bottom
      })
      i++
      continue
    }

    if (HR.test(line) && !LIST_ITEM.test(line)) {
      blocks.push({ height: MD_HR.height, top: MD_HR.margin, bottom: MD_HR.margin })
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      let rows = 0
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows++
        i++
      }
      blocks.push({
        height: MD_TH_ROW + rows * MD_TD_ROW + MD_TABLE_CHROME,
        top: MD_TABLE_MARGIN,
        bottom: MD_TABLE_MARGIN
      })
      continue
    }

    if (QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1])
      blocks.push({
        height: estimateMarkdownHeight(inner.join('\n'), widthPx - MD_QUOTE_INDENT),
        top: MD_QUOTE_MARGIN,
        bottom: MD_QUOTE_MARGIN
      })
      continue
    }

    if (LIST_ITEM.test(line)) {
      let height = 0
      let items = 0
      while (i < lines.length) {
        const item = LIST_ITEM.exec(lines[i])
        if (item) {
          const depth = Math.floor(item[1].replace(/\t/g, '    ').length / 2) + 1
          height += proseHeight(visibleText(item[3]), widthPx - depth * MD_LIST_INDENT)
          items++
          i++
        } else if (lines[i].trim() !== '' && /^\s+\S/.test(lines[i])) {
          // A continuation line of the previous item.
          height += proseHeight(visibleText(lines[i].trim()), widthPx - MD_LIST_INDENT)
          i++
        } else if (lines[i].trim() === '' && LIST_ITEM.test(lines[i + 1] ?? '')) {
          i++ // a loose list: the blank line between items
        } else break
      }
      height += Math.max(0, items - 1) * MD_LIST_ITEM_GAP
      blocks.push({ height, top: 0, bottom: MD_LIST_MARGIN })
      continue
    }

    // Paragraph: consecutive lines until a blank line or another block starts.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '') {
      if (para.length > 0 && startsBlock(lines[i], lines[i + 1])) break
      para.push(lines[i++].trim())
    }
    blocks.push({
      height: proseHeight(visibleText(para.join(' ')), widthPx),
      top: 0,
      bottom: MD_P_MARGIN
    })
  }

  if (blocks.length === 0) return 0
  // Sibling margins collapse (max, not sum); the container is a BFC root, so the
  // first top margin and the last bottom margin stay inside it. `p:last-child`
  // has mb-0 and `h*:first-child` has mt-0.
  const last = blocks[blocks.length - 1]
  let total = blocks[0].top
  for (let b = 0; b < blocks.length; b++) {
    total += blocks[b].height
    if (b < blocks.length - 1) total += Math.max(blocks[b].bottom, blocks[b + 1].top)
  }
  const lastIsParagraph = last.bottom === MD_P_MARGIN && last.top === 0 && last.height > 0
  return total + (lastIsParagraph ? 0 : last.bottom)
}

// ── Tool cards ───────────────────────────────────────────────────────────────

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlockLike = Extract<ContentBlock, { type: 'tool_result' }>

/** A bordered mono box (pre / TerminalView) holding `text`, inside a body section. */
function monoBoxHeight(
  text: string,
  columnPx: number,
  maxHeight: number | undefined,
  fontPx = BOX_FONT
): number {
  const inner = columnPx - SECTION_PAD_X - BOX_CHROME_X
  const lines = wrappedLineCount(text, charsPerLine(inner, fontPx * MONO_EM))
  const h = lines * fontPx * 1.3 + BOX_CHROME_Y
  return maxHeight === undefined ? h : Math.min(h, maxHeight)
}

/** `JSON.stringify(input, null, 2)`, the generic input dump. */
function jsonDump(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2) ?? ''
  } catch {
    return ''
  }
}

/** A body section: padding, optional label, content, optional top rule. */
function section(content: number, o: EstimateOptions, opts: { label?: boolean; rule?: boolean }) {
  const label = opts.label !== false && !o.hideToolInput ? LABEL : 0
  return SECTION_PAD_Y + label + content + (opts.rule ? SECTION_RULE : 0)
}

function truncated(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** The Result part shared by every kind that prints text: TerminalView, or the red pre on error. */
function resultSection(
  result: ToolResultBlockLike,
  columnPx: number,
  o: EstimateOptions,
  hasInputAbove: boolean,
  /** The text goes through OutputView (command / detail), which boxes a detected shape at 260. */
  command?: string
): number {
  const text = result.toolResult
  const structured = command !== undefined && detectOutputFormat(text, command).kind !== 'plain'
  const content = result.isError
    ? monoBoxHeight(truncated(text, 2000), columnPx, undefined)
    : monoBoxHeight(text, columnPx, structured ? OUTPUT_VIEW_MAX : TERMINAL_MAX)
  return section(content, o, { rule: hasInputAbove && !o.hideToolInput })
}

/** CodeView: no max-height, no wrapping; one row per line. */
function codeViewHeight(code: string): number {
  return plainLineCount(code) * CODE_LINE + CODE_CHROME
}

function bodyHeight(
  view: ToolView,
  block: ToolUseBlock,
  result: ToolResultBlockLike | undefined,
  columnPx: number,
  o: EstimateOptions
): number {
  const hasText = !!result?.toolResult
  const dump = (): number =>
    section(monoBoxHeight(jsonDump(block.toolInput), columnPx, INPUT_BOX_MAX), o, {})

  switch (view.kind) {
    case 'command': {
      const input = section(
        monoBoxHeight(`$ ${view.command || jsonDump(block.toolInput)}`, columnPx, INPUT_BOX_MAX),
        o,
        { label: !o.hideToolInput }
      )
      const bg = !!block.toolInput?.run_in_background
      return input + (hasText && !bg ? resultSection(result!, columnPx, o, true, view.command) : 0)
    }
    case 'fileRead': {
      const input = o.hideToolInput ? 0 : section(SHOW_MORE - 4, o, {})
      if (!hasText) return input
      const text = result!.toolResult
      const long = !result!.isError && text.length > o.toolOutputMaxChars
      const content = result!.isError
        ? monoBoxHeight(truncated(text, 2000), columnPx, undefined)
        : codeViewHeight(truncated(text, o.toolOutputMaxChars)) + (long ? SHOW_MORE : 0)
      return input + section(content, o, { rule: !o.hideToolInput })
    }
    case 'fileWrite': {
      const input = o.hideToolInput ? 0 : section(SHOW_MORE - 4, o, {})
      if (!hasText) return input
      const content = view.content
        ? /\.(md|markdown)$/i.test(view.path)
          ? 32 + estimateMarkdownHeight(truncated(view.content, 5000), columnPx - SECTION_PAD_X)
          : codeViewHeight(truncated(view.content, 5000))
        : monoBoxHeight(result!.toolResult, columnPx, TERMINAL_MAX)
      return input + section(content, o, { rule: !o.hideToolInput })
    }
    case 'fileEdit': {
      const patchRows = view.files?.reduce((n, f) => n + plainLineCount(f.patch ?? ''), 0)
      const rows =
        patchRows ??
        (view.before ? plainLineCount(view.before) : 0) +
          (view.after ? plainLineCount(view.after) : 0)
      const hasDiff = rows > 0
      const input = o.hideToolInput
        ? 0
        : hasDiff
          ? section(DIFF_FRAME + rows * DIFF_ROW, o, {})
          : dump()
      return input + (hasText ? resultSection(result!, columnPx, o, true) : 0)
    }
    case 'search': {
      // SearchBody: a grouped result REPLACES the input dump (`showInput` is false
      // when the parse succeeds) and renders one row per file, no label.
      const grouped = result?.isError ? null : groupSearchResult(result?.toolResult ?? '')
      if (!grouped) break
      const rows = grouped.reduce(
        (h, hit) =>
          h +
          SEARCH_FILE_PAD +
          SEARCH_FILE_LINE +
          Math.min(5, hit.lines.length) * SEARCH_MATCH_LINE +
          (hit.lines.length > 5 ? SEARCH_MATCH_LINE : 0),
        0
      )
      return section(rows, o, { label: false })
    }
    case 'web': {
      // WebBody: label + the target (12px mono, lh 1.4); then the structured
      // results (title / url / snippet, gap-2.5) or the result text.
      const target = o.hideToolInput
        ? 0
        : section(
            wrappedLineCount(
              view.target,
              charsPerLine(columnPx - SECTION_PAD_X, BOX_FONT * MONO_EM)
            ) *
              BOX_FONT *
              1.4,
            o,
            {}
          )
      const entries = view.results ?? []
      if (entries.length > 0) {
        const list = entries.reduce(
          (h, entry) =>
            h +
            WEB_RESULT_LINES +
            (entry.snippet ? proseHeight(entry.snippet, columnPx - SECTION_PAD_X, 11, 1.5) : 0),
          0
        )
        return (
          target +
          section(LABEL - 6 + list + (entries.length - 1) * 10 + 6, o, {
            label: false,
            rule: !o.hideToolInput
          })
        )
      }
      return target + (hasText ? resultSection(result!, columnPx, o, true) : 0)
    }
    case 'mcp': {
      // McpBody: the server / tool row (11px, mb-1.5), the label, the JSON args.
      const row = view.server || view.tool ? 11 * INHERITED_LINE + 6 : 0
      const args = o.hideToolInput
        ? 0
        : section(
            row + monoBoxHeight(jsonDump(view.input ?? block.toolInput), columnPx, INPUT_BOX_MAX),
            o,
            {}
          )
      return args + (hasText ? resultSection(result!, columnPx, o, true) : 0)
    }
    default:
      break
  }
  // search without rows, detail, image, unknown: the generic JSON input + result text.
  return (o.hideToolInput ? 0 : dump()) + (hasText ? resultSection(result!, columnPx, o, true) : 0)
}

/** One passive tool card (ToolCard shell + kind body + the result image strip). */
function passiveCardHeight(
  kind: ToolKind,
  view: ToolView,
  block: ToolUseBlock,
  result: ToolResultBlockLike | undefined,
  decided: boolean,
  columnPx: number,
  o: EstimateOptions
): number {
  const isRead = kind === 'fileRead'
  const expanded = isRead ? o.expandToolCalls && o.expandReadResults : o.expandToolCalls
  const border = result && !result.isError ? CARD_BORDER_COLOURED : CARD_BORDER_IDLE
  let h = border + CARD_HEADER
  if (expanded) {
    h += SECTION_RULE + bodyHeight(view, block, result, columnPx - border, o)
    if (decided) h += DECISION_STRIP
  }
  const images = result?.images?.length ?? 0
  if (images > 0) {
    const perRow = Math.max(
      1,
      Math.floor((columnPx - SECTION_PAD_X + RESULT_IMAGE_GAP) / (RESULT_IMAGE + RESULT_IMAGE_GAP))
    )
    h +=
      SECTION_RULE +
      SECTION_PAD_Y +
      Math.ceil(images / perRow) * RESULT_IMAGE +
      (Math.ceil(images / perRow) - 1) * RESULT_IMAGE_GAP
  }
  return h
}

function toolHeight(
  block: ToolUseBlock,
  result: ToolResultBlockLike | undefined,
  decided: boolean,
  columnPx: number,
  o: EstimateOptions
): number {
  const toolMap = engineToolMap(o.engineId)
  const kind = hostedMcpKind(block.toolName) ?? toolMap.kindOf(block.toolName)
  let view: ToolView
  try {
    view = toolMap.normalize(kind, block.toolInput, result, block.toolName)
  } catch {
    return CARD_HEADER + CARD_BORDER_IDLE
  }
  switch (view.kind) {
    case 'todo':
    case 'sleep':
    case 'note':
      return ROW_CARD
    case 'task':
      return TASK_CARD
    case 'plan':
      return (
        LIFTED_HEADER +
        SECTION_RULE +
        SECTION_PAD_Y +
        estimateMarkdownHeight(view.plan, columnPx - SECTION_PAD_X)
      )
    case 'question':
      return result ? LIFTED_HEADER : QUESTION_OPEN
    case 'diagram':
    case 'mockup':
      return MEDIA_CARD
    default:
      return passiveCardHeight(kind, view, block, result, decided, columnPx, o)
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────

function userHeight(message: ChatMessage, columnPx: number): number {
  if (message.planContent) {
    return (
      LIFTED_HEADER +
      SECTION_RULE +
      SECTION_PAD_Y +
      estimateMarkdownHeight(message.planContent, columnPx - SECTION_PAD_X)
    )
  }
  const bubble = columnPx * USER_MAX_FRACTION
  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const images = message.content.filter((b) => b.type === 'image').length
  const docs = message.content.filter((b) => b.type === 'document').length
  let attachments = 0
  if (images > 0) {
    const perRow = Math.max(1, Math.floor((bubble - USER_PAD_X) / (120 + USER_ATTACH_GAP)))
    attachments += Math.ceil(images / perRow) * USER_IMAGE
  }
  if (docs > 0) attachments += USER_DOC
  const textHeight = proseHeight(text, bubble - USER_PAD_X)
  // The attachment row's mb-2 only exists when there is something under it.
  const gap = attachments > 0 && textHeight > 0 ? USER_ATTACH_GAP : 0
  return USER_PAD_Y + attachments + gap + textHeight
}

function systemHeight(message: ChatMessage, columnPx: number): number {
  const parts: number[] = []
  for (const block of message.content) {
    if (block.type === 'compact_separator') {
      parts.push(block.text?.trim() ? COLLAPSED_ROW : COMPACT_SEPARATOR)
    } else if (block.type === 'cli_command') {
      const inner = columnPx * USER_MAX_FRACTION - USER_PAD_X
      const cpl = charsPerLine(inner, BOX_FONT * MONO_EM)
      const display =
        block.commandName === 'output'
          ? (block.commandOutput ?? '')
          : block.commandArgs
            ? `/${block.commandName} ${block.commandArgs}`
            : `/${block.commandName}`
      if (display) parts.push(USER_PAD_Y + wrappedLineCount(display, cpl) * BOX_FONT * 1.6)
    } else if (block.type === 'api_error') {
      parts.push(block.errorType === 'authentication' ? AUTH_ROW : COLLAPSED_ROW)
    } else if (block.type === 'context_note') {
      parts.push(CONTEXT_NOTE)
    } else if (block.type === 'review_result') {
      parts.push(
        COLLAPSED_ROW +
          Math.min(REVIEW_BODY_MAX, estimateMarkdownHeight(block.text, columnPx - SECTION_PAD_X)) +
          SECTION_PAD_Y
      )
    } else if (block.type === 'text') {
      // `border-l-2 pl-3 py-0.5`, 12px at leading 1.6, pre-wrap.
      parts.push(4 + proseHeight(block.text, columnPx - 14, 12))
    }
  }
  return parts.length === 0 ? 0 : parts.reduce((a, b) => a + b, 0) + (parts.length - 1) * ITEM_GAP
}

function assistantHeight(message: ChatMessage, columnPx: number, o: EstimateOptions): number {
  const toolMap = engineToolMap(o.engineId)
  const results = new Map<string, ToolResultBlockLike>()
  const decided = new Set<string>()
  for (const block of message.content) {
    if (block.type === 'tool_result') results.set(block.toolUseId, block)
    else if (block.type === 'tool_review' || block.type === 'permission_denial') {
      decided.add(block.toolUseId)
    }
  }

  // The same visible set MessageBubble renders (results, decisions and hidden
  // tools are not rows of their own).
  const items: number[] = []
  let group: number[] = []
  const flush = (): void => {
    if (group.length === 1) items.push(group[0])
    else if (group.length > 1) {
      items.push(group.reduce((a, b) => a + b, 0) + (group.length - 1) * ITEM_GAP + GROUP_CHROME)
    }
    group = []
  }
  for (const block of message.content) {
    if (block.type === 'tool_use') {
      if (block.toolName && toolMap.hidden.has(block.toolName)) continue
      // Inside a multi-call group the cards sit in the group's p-2 box.
      group.push(
        toolHeight(block, results.get(block.toolUseId), decided.has(block.toolUseId), columnPx, o)
      )
      continue
    }
    if (
      block.type === 'tool_result' ||
      block.type === 'tool_review' ||
      block.type === 'permission_denial'
    ) {
      continue
    }
    flush()
    if (block.type === 'thinking') {
      if (!block.text) continue
      const body = o.expandThinking
        ? THINKING_BODY_MARGIN +
          Math.min(THINKING_BODY_MAX, proseHeight(block.text, columnPx - THINKING_INDENT))
        : 0
      items.push(THINKING_TOGGLE + body)
    } else if (block.type === 'text' && block.text) {
      items.push(estimateMarkdownHeight(block.text, columnPx))
    }
  }
  flush()

  const body =
    items.length === 0 ? 0 : items.reduce((a, b) => a + b, 0) + (items.length - 1) * ITEM_GAP
  return body + (o.forkRow ? FORK_ROW : 0)
}

/**
 * Estimated height, in the children's CSS px, of `message` rendered in a column
 * whose content is `columnWidthPx` wide.
 */
export function estimateMessageHeight(
  message: ChatMessage,
  columnWidthPx: number,
  options: Partial<EstimateOptions> = {}
): number {
  const o = { ...DEFAULT_ESTIMATE_OPTIONS, ...options }
  const width = Math.max(columnWidthPx, 120)
  let h: number
  switch (message.role) {
    case 'user':
      h = userHeight(message, width)
      break
    case 'system':
      h = systemHeight(message, width)
      break
    case 'assistant':
      h = assistantHeight(message, width, o)
      break
    default:
      h = UNKNOWN_HEIGHT
  }
  return Math.round(clamp(h, 0, 200_000))
}

// ── Column width ─────────────────────────────────────────────────────────────

/** Width buckets: a resize inside one bucket changes no estimate and re-renders nothing. */
export const COLUMN_BUCKET_PX = 50
export const MIN_COLUMN_PX = 200

export function bucketColumnWidth(widthPx: number): number {
  return Math.max(MIN_COLUMN_PX, Math.round(widthPx / COLUMN_BUCKET_PX) * COLUMN_BUCKET_PX)
}

/**
 * The column before anything is measured, from the chat width settings. `px`
 * mode names the column; `percent` depends on the window, so it takes a typical
 * desktop content width. Mobile spans the phone (SessionView at 412px).
 */
export function defaultColumnWidth(opts: {
  isMobile: boolean
  mode: 'px' | 'percent'
  px: number
}): number {
  if (opts.isMobile) return bucketColumnWidth(412 - 8 - 24)
  // ChatPanel's content div is `px-8`: 32px each side.
  return bucketColumnWidth(opts.mode === 'px' ? opts.px - 64 : 700)
}
