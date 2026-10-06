/**
 * The agent type tile (ADR-094): a 16px rounded square, a bold mono letter, the
 * type's colour on a tint of itself. The ONE renderer for every surface that
 * shows an agent's type: the agent list (`AgentRow`), the Task card's footer and
 * Settings › <engine> › Agent colours. Which letter, which colour and whether
 * there is a tile at all are `shared/agent-type-colors`; this file only draws.
 *
 * `title` and `aria-label` carry the full type name (or `Dispatch → <engine> ·
 * <model>`), since the letter alone is not enough to tell two types apart.
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
  tileLetter,
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

/** A tile, drawn: no resolution, no store. The settings page draws previews with it. */
export function AgentTile({
  letter,
  colorId,
  title,
  testId,
  className = ''
}: {
  letter: string
  /** A palette colour; omit for the neutral grey of "no tile for this type". */
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
      className={`inline-flex items-center justify-center h-4 min-w-4 px-[3px] rounded font-mono text-[10px] leading-none font-bold shrink-0 select-none ${
        colorId ? AGENT_TILE_CLASS[colorId] : 'bg-bg-tertiary text-text-muted'
      } ${className}`}
    >
      {letter}
    </span>
  )
}

export interface AgentTileSpec {
  letter: string
  colorId: AgentColorId
  /** The tooltip and aria-label: the full type name, or `Dispatch → <engine> · <model>`. */
  title: string
  /** The type's name for a wide chip; the word "dispatch" for a dispatch. */
  label: string
}

/**
 * What tile an agent gets, or `null` for none: no type, or the engine's default
 * type (it is the unremarkable case). A dispatch is always the letter X, in the
 * one configurable dispatch colour. Otherwise the colour is the user's override,
 * else the engine's native agent colour mapped to the nearest palette colour,
 * else a stable hash of the name.
 */
export function useAgentTile(
  engine: EngineId | undefined,
  type: string | undefined,
  dispatch?: { engine: string; model?: string }
): AgentTileSpec | null {
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
  if (!typed || !type) return null
  return {
    letter: tileLetter(type),
    colorId: resolveAgentTypeColor(type, {
      override: agentColorOverride(overrides, engine, type),
      native: nativeColorOf(catalog, type)
    }),
    title: type,
    label: type
  }
}

/** The tile for one agent, or nothing for the default type. `testId` is the surface's own (ADR-027). */
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
}): React.JSX.Element | null {
  const tile = useAgentTile(engine, type, dispatch)
  if (!tile) return null
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
