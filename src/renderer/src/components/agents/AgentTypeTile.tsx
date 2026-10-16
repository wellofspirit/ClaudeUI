/**
 * The agent tile (ADR-094): a 16px rounded square holding a small bot and, for a
 * typed agent, the type's letters, in the type's colour on a tint of itself. The
 * ONE renderer for every surface that shows an agent: the agent list
 * (`AgentRow`), the Task card's footer and Settings › <engine> › Agent colours.
 * Which letters, which colour and what the tile says are `shared/agent-type-colors`
 * and `useAgentTile`; this file only draws.
 *
 * Every agent has one. A typed agent is the bot and its letters in its colour; a
 * cross-engine dispatch is the bot and an X in the dispatch colour; the engine's
 * default type, and an agent that named no type at all, is the bot alone, muted.
 *
 * `title` and `aria-label` carry the full type name (or `Dispatch → <engine> ·
 * <model>`), since the letters alone are not enough to tell two types apart.
 * Centring is the point of the markup: the bot is `display: block` and its
 * drawing is optically centred inside its viewBox, and the letters are trimmed to
 * cap height (`.agent-tile-letter`), so both sit on the tile's centre line.
 * Class names are written out whole: Tailwind reads source text, so a template
 * like `bg-agent-${id}/18` would emit nothing.
 */
import type { EngineId } from '../../../../shared/types'
import {
  DEFAULT_DISPATCH_TILE_COLOR,
  DISPATCH_TILE_LETTER,
  agentColorOverride,
  dispatchTileTitle,
  isAgentColorId,
  hasTypeTile,
  resolveAgentTypeColor,
  agentTileLetter,
  type AgentColorId
} from '../../../../shared/agent-type-colors'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { nativeColorOf, useAgentTypeCatalog } from '../../hooks/useAgentTypeCatalog'

/** The tile's tint and letter, per palette colour. */
export const AGENT_TILE_CLASS: Record<AgentColorId, string> = {
  sky: 'bg-agent-sky/18 text-agent-sky',
  violet: 'bg-agent-violet/18 text-agent-violet',
  green: 'bg-agent-green/18 text-agent-green',
  orange: 'bg-agent-orange/18 text-agent-orange',
  rose: 'bg-agent-rose/18 text-agent-rose',
  amber: 'bg-agent-amber/18 text-agent-amber',
  teal: 'bg-agent-teal/18 text-agent-teal',
  pink: 'bg-agent-pink/18 text-agent-pink'
}

/** The Task card's wide type chip, in the same colour: a fainter tint, the letter colour as text. */
export const AGENT_CHIP_CLASS: Record<AgentColorId, string> = {
  sky: 'bg-agent-sky/14 text-agent-sky',
  violet: 'bg-agent-violet/14 text-agent-violet',
  green: 'bg-agent-green/14 text-agent-green',
  orange: 'bg-agent-orange/14 text-agent-orange',
  rose: 'bg-agent-rose/14 text-agent-rose',
  amber: 'bg-agent-amber/14 text-agent-amber',
  teal: 'bg-agent-teal/14 text-agent-teal',
  pink: 'bg-agent-pink/14 text-agent-pink'
}

/**
 * The bot: an antenna, a rounded head, two ears and two eyes, strokes in
 * `currentColor`, 11px. The drawing spans y 1.9 to 21.2 of its 24-unit box with
 * its strokes (1.9 to 20 without them), so the viewBox starts at -0.75 to put the
 * middle of the two (11.25) on the box's own middle: the tile centres the box, so
 * the drawing is centred with it. A viewBox from 0 sits half a pixel high.
 */
export function AgentBotIcon(): React.JSX.Element {
  return (
    <svg
      data-testid="AgentTile.bot"
      width="11"
      height="11"
      viewBox="0 -0.75 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className="block shrink-0"
    >
      <g data-testid="AgentTile.bot.shape">
        <path d="M12 8V5.2" />
        <circle cx="12" cy="3.4" r="1.5" fill="currentColor" stroke="none" />
        <rect x="4" y="8" width="16" height="12" rx="3.5" />
        <path d="M1.8 13.5v3M22.2 13.5v3" />
        <circle cx="9" cy="14.2" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="15" cy="14.2" r="1.4" fill="currentColor" stroke="none" />
      </g>
    </svg>
  )
}

/**
 * A tile, drawn: no resolution, no store. The settings page draws previews with
 * it. The bot always; the letters after it, if any (an agent of the default
 * type has none).
 */
export function AgentTile({
  letter,
  colorId,
  title,
  testId,
  className = ''
}: {
  /** The type's letters (at most two) or the dispatch X; omit for the bot alone. */
  letter?: string
  /** A palette colour; omit for the muted grey of the default type and of an untyped agent. */
  colorId?: AgentColorId
  title: string
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      data-color={colorId}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center gap-0.5 h-4 min-w-5 ${
        letter ? 'px-1' : 'px-[3px]'
      } rounded font-mono text-[10px] leading-none font-bold shrink-0 select-none ${
        colorId ? AGENT_TILE_CLASS[colorId] : 'bg-bg-tertiary text-text-muted'
      } ${className}`}
    >
      <AgentBotIcon />
      {letter && <span className="agent-tile-letter">{letter}</span>}
    </span>
  )
}

/**
 * The roster's type column: 36px, wide enough for the bot and two letters (33px),
 * so labels line up across bot-only, bot + 1 and bot + 2 rows. The tile, a shell's
 * `$` glyph, whatever the row has, is left-aligned in it.
 *
 * Under 300px of roster width the column is 16px, what it was before the bot, and
 * the tile compacts (`AGENT_TILE_COMPACT_CLASS`): a lettered tile drops its bot,
 * and every tile trims to 16px. The 240px row (resumed chip, Stop, 3rem name and
 * metrics floors) has nothing left over, so it keeps fitting on one line only
 * with the column at 16px.
 */
export const AGENT_TYPE_SLOT_CLASS = 'inline-flex w-9 @max-[300px]/roster:w-4 shrink-0 items-center'

/** A tile in the roster's type column, under 300px of roster width: 16px wide, whatever it holds. */
export const AGENT_TILE_COMPACT_CLASS = '@max-[300px]/roster:min-w-4 @max-[300px]/roster:px-[2px]'

/** Added for a lettered tile: the letters carry the type, so the bot goes when there is no room. */
export const AGENT_TILE_NO_BOT_COMPACT_CLASS = '@max-[300px]/roster:[&>svg]:hidden'

export interface AgentTileSpec {
  /** The type's letters or the dispatch X; empty for the bot alone (the default type, an untyped agent). */
  letter: string
  /** Undefined for the bot alone, drawn muted. */
  colorId?: AgentColorId
  /** The tooltip and aria-label: the full type name, or `Dispatch → <engine> · <model>`. */
  title: string
  /** The type's name for a wide chip; the word "dispatch" for a dispatch; empty for the bot alone, which names nothing. */
  label: string
}

/**
 * What tile an agent gets. Every agent has one: a dispatch is the bot and an X
 * in the one configurable dispatch colour; a typed agent is the bot and its
 * letters, coloured by the user's override, else the engine's native agent colour
 * mapped to the nearest palette colour, else a stable hash of the name; the
 * engine's default type, and an agent with no (single) type, is the bot alone,
 * muted.
 *
 * The letters are the type's initials, minus a prefix shared with another known
 * type (`agentTileLetter`). The known types are the engine's catalog plus
 * `knownTypes`, the types the calling surface shows: an empty catalog (a host
 * that cannot list types) still tells `orch-reader` from `orch-verifier` there.
 */
export function useAgentTile(
  engine: EngineId | undefined,
  type: string | undefined,
  dispatch?: { engine: string; model?: string },
  knownTypes?: readonly string[]
): AgentTileSpec {
  const overrides = useSessionStore((s) => s.settings.agentTypeColors)
  const dispatchColor = useSessionStore((s) => s.settings.dispatchTileColor)
  const cwd = useActiveSession((s) => s.cwd)
  const typed = !dispatch && hasTypeTile(engine, type)
  const catalog = useAgentTypeCatalog(engine, cwd, { enabled: typed })

  if (dispatch) {
    return {
      letter: DISPATCH_TILE_LETTER,
      colorId: isAgentColorId(dispatchColor) ? dispatchColor : DEFAULT_DISPATCH_TILE_COLOR,
      title: dispatchTileTitle(dispatch),
      label: 'dispatch'
    }
  }
  if (!typed || !type) {
    // The default type, or no usable type: the bot alone. The tooltip still names
    // the type when there is one.
    return { letter: '', title: type?.trim() || 'Agent', label: '' }
  }
  return {
    letter: agentTileLetter(type, [...catalog.map((entry) => entry.type), ...(knownTypes ?? [])]),
    colorId: resolveAgentTypeColor(type, {
      override: agentColorOverride(overrides, engine, type),
      native: nativeColorOf(catalog, type)
    }),
    title: type,
    label: type
  }
}

/** The tile for one agent. `testId` is the surface's own (ADR-027). */
export function AgentTypeTile({
  engine,
  type,
  dispatch,
  testId,
  className
}: {
  engine: EngineId | undefined
  type: string | undefined
  dispatch?: { engine: string; model?: string }
  testId?: string
  className?: string
}): React.JSX.Element {
  const tile = useAgentTile(engine, type, dispatch)
  return (
    <AgentTile
      letter={tile.letter}
      colorId={tile.colorId}
      title={tile.title}
      testId={testId}
      className={className}
    />
  )
}
