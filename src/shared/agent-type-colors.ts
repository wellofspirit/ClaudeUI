/**
 * Agent type colour coding (ADR-093): the pure half.
 *
 * Every surface that shows which TYPE of agent a card or roster row is (the
 * agent list, the Task card, Settings › <engine> › Agent colours) reads its
 * letter, its colour and its "no tile for the default type" rule from here,
 * so they cannot disagree. The renderer's `AgentTypeTile` is the one renderer.
 *
 * One shared palette for every engine. Eight named colours, each a theme token
 * (`--color-agent-<id>` in `main.css`, defined for the dark and the light
 * themes): a free hex would be unreadable in one of the two. The palette ids
 * live here, the hues live in CSS; {@link PALETTE_HUE} mirrors the dark hues so
 * a native colour can be mapped to the nearest one without a DOM.
 */
import type { EngineId } from './types'

export const AGENT_COLOR_IDS = [
  'sky',
  'violet',
  'green',
  'orange',
  'rose',
  'amber',
  'teal',
  'pink'
] as const

export type AgentColorId = (typeof AGENT_COLOR_IDS)[number]

export function isAgentColorId(value: unknown): value is AgentColorId {
  return typeof value === 'string' && (AGENT_COLOR_IDS as readonly string[]).includes(value)
}

/** The cross-engine dispatch tile (the letter X) until the user picks another colour. */
export const DEFAULT_DISPATCH_TILE_COLOR: AgentColorId = 'orange'

/**
 * The agent type each engine uses when a spawn call names none. Its card and
 * row carry no tile: the default is the unremarkable case, and a tile on every
 * agent would be noise that drowns the ones worth telling apart.
 *
 * Claude Code: `general-purpose`. pi: ClaudeUI's own `general-purpose`
 * (`core/pi/pi-agent-registry.ts`). opencode: `general`. Codex: the role
 * `default` (`DEFAULT_ROLE_NAME`, codex-rs/core/src/agent/role.rs).
 */
export const DEFAULT_SUBAGENT_TYPE: Record<EngineId, string> = {
  claude: 'general-purpose',
  opencode: 'general',
  pi: 'general-purpose',
  codex: 'default'
}

/**
 * Whether `type` is the engine's default. Case-insensitive: pi matches agent
 * names that way, and a transcript's casing is not worth a stray tile.
 */
export function isDefaultSubagentType(engine: EngineId | undefined, type: string): boolean {
  return type.trim().toLowerCase() === DEFAULT_SUBAGENT_TYPE[engine ?? 'claude'].toLowerCase()
}

/**
 * Whether `type` gets a tile at all: it is a single type, and not the engine's
 * default. A comma means it is not one type: pi's legacy parallel `subagent` call
 * carries "scout, planner" as one card, and a tile for it would name neither.
 */
export function hasTypeTile(engine: EngineId | undefined, type: string | undefined): boolean {
  return !!type && !type.includes(',') && !isDefaultSubagentType(engine, type)
}

/**
 * The tile's one character: the type's initial, uppercased. `Explore` is E,
 * `migration-reviewer` is M. Colour and the tooltip tell two types with the
 * same initial apart; a second letter would not fit a 16px tile.
 */
export function tileLetter(type: string): string {
  const name = type.trim()
  const letter = name.match(/[\p{L}\p{N}]/u)?.[0] ?? [...name][0]
  return letter ? letter.toUpperCase() : '?'
}

/** The cross-engine dispatch tile's letter. */
export const DISPATCH_TILE_LETTER = 'X'

/** The tooltip of a dispatch tile: `Dispatch → <engine> · <model>`. */
export function dispatchTileTitle(dispatch: { engine: string; model?: string }): string {
  return `Dispatch → ${dispatch.engine}${dispatch.model ? ` · ${dispatch.model}` : ''}`
}

// ── Native colours → the nearest palette colour ──────────────────────

/** The dark-theme hue of each palette colour, in degrees (see `--color-agent-*` in main.css). */
const PALETTE_HUE: Record<AgentColorId, number> = {
  sky: 194,
  violet: 266,
  green: 123,
  orange: 24,
  rose: 349,
  amber: 47,
  teal: 169,
  pink: 321
}

/**
 * Claude Code's `color` frontmatter takes exactly these eight names, and they map
 * ONE-TO-ONE onto the eight palette colours, so two native colours never share a
 * tile colour and every palette colour is reachable natively (cyan is teal; a
 * hue match would have put blue and cyan both on sky and left teal unreachable).
 */
const CLAUDE_COLOR: Record<string, AgentColorId> = {
  red: 'rose',
  blue: 'sky',
  green: 'green',
  yellow: 'amber',
  purple: 'violet',
  orange: 'orange',
  pink: 'pink',
  cyan: 'teal'
}

/**
 * opencode's theme names (its `color` takes a hex or one of these), by hue:
 * approximations, since a theme name has no fixed colour of its own.
 */
const THEME_HUE: Record<string, number> = {
  primary: 217,
  secondary: 271,
  accent: 330,
  success: 142,
  warning: 45,
  error: 0,
  info: 217
}

/** Below this saturation a colour has no usable hue (greys): leave it to the hash. */
const MIN_SATURATION = 0.15

function hueOf(r: number, g: number, b: number): number | undefined {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const lightness = (max + min) / 2 / 255
  const saturation = delta === 0 ? 0 : delta / 255 / (1 - Math.abs(2 * lightness - 1))
  if (saturation < MIN_SATURATION) return undefined
  const h =
    max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return (h * 60 + 360) % 360
}

function hexHue(css: string): number | undefined {
  const m = css.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (!m) return undefined
  const hex =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]
  return hueOf(
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16)
  )
}

/**
 * The palette colour for an engine's own agent colour. Claude Code's eight names
 * map one-to-one ({@link CLAUDE_COLOR}); a hex (opencode, `#22d3ee`) or an
 * opencode theme name goes to the palette colour nearest by hue. Case-insensitive,
 * quotes and a trailing ` # comment` ignored. `undefined` for a colour it cannot
 * read, or a grey: the caller falls through to the stable hash.
 */
export function nearestPaletteColor(css: string): AgentColorId | undefined {
  const text = css
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^['"]|['"]$/g, '')
  const name = text.toLowerCase()
  if (Object.hasOwn(CLAUDE_COLOR, name)) return CLAUDE_COLOR[name]
  const hue = (Object.hasOwn(THEME_HUE, name) ? THEME_HUE[name] : undefined) ?? hexHue(text)
  if (hue === undefined) return undefined
  let best: AgentColorId | undefined
  let bestDistance = Infinity
  for (const id of AGENT_COLOR_IDS) {
    const d = Math.abs(hue - PALETTE_HUE[id])
    const distance = Math.min(d, 360 - d)
    if (distance < bestDistance) {
      best = id
      bestDistance = distance
    }
  }
  return best
}

/**
 * A stable palette colour for a type name: FNV-1a over the lowercased name, so
 * the same type is the same colour on every machine and in every session, with
 * nothing stored.
 */
export function stableHashColor(type: string): AgentColorId {
  let hash = 0x811c9dc5
  for (const ch of type.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return AGENT_COLOR_IDS[hash % AGENT_COLOR_IDS.length]
}

/**
 * The colour of one agent type: the user's override, else the engine's native
 * agent colour mapped to the nearest palette colour, else a stable hash. The
 * default type has no tile, so it never reaches here.
 */
export function resolveAgentTypeColor(
  type: string,
  sources: { override?: string; native?: string } = {}
): AgentColorId {
  if (isAgentColorId(sources.override)) return sources.override
  return (sources.native ? nearestPaletteColor(sources.native) : undefined) ?? stableHashColor(type)
}

/** The stored per-engine overrides (`AppSettings.agentTypeColors`): engine → type → colour id. */
export type AgentTypeColorOverrides = Partial<Record<EngineId, Record<string, string>>>

/**
 * One override, or undefined when the engine has none for the type or it is not
 * a palette id. Exact name first, then case-insensitively: pi matches agent names
 * that way, so an `Explore` override must colour a transcript's `explore`.
 */
export function agentColorOverride(
  overrides: AgentTypeColorOverrides | undefined,
  engine: EngineId | undefined,
  type: string
): AgentColorId | undefined {
  const table = overrides?.[engine ?? 'claude']
  if (!table) return undefined
  const lower = type.trim().toLowerCase()
  const value = Object.hasOwn(table, type)
    ? table[type]
    : table[Object.keys(table).find((key) => key.trim().toLowerCase() === lower) ?? '']
  return isAgentColorId(value) ? value : undefined
}

/**
 * The overrides after setting (or, with `color` undefined, clearing) one type's
 * colour for one engine. Prunes what it empties, so Reset on the last override
 * leaves the settings file with no `agentTypeColors` key at all (`undefined`),
 * not an empty shell. Never mutates its input.
 */
export function withAgentColorOverride(
  overrides: AgentTypeColorOverrides | undefined,
  engine: EngineId,
  type: string,
  color: AgentColorId | undefined
): AgentTypeColorOverrides | undefined {
  const forEngine = { ...(overrides?.[engine] ?? {}) }
  if (color) forEngine[type] = color
  else delete forEngine[type]
  const next: AgentTypeColorOverrides = { ...(overrides ?? {}) }
  if (Object.keys(forEngine).length > 0) next[engine] = forEngine
  else delete next[engine]
  return Object.keys(next).length > 0 ? next : undefined
}
