/**
 * Agent colours (ADR-094): Settings › <engine> › Agent colours, and the one
 * colour of the cross-engine dispatch tile on Cross-engine dispatch.
 *
 * Each engine lists the agent types it knows (`config:list-agent-types`): a
 * tile preview, the name, where the type comes from, a swatch from the ONE
 * palette every engine shares, and Auto / Reset. A type with no override is
 * coloured by its engine's own agent colour (Claude Code's and opencode's agent
 * files name one), else by a stable hash of its name, which is what "Auto"
 * means. The engine's default type has no tile and is listed greyed.
 *
 * The overrides live in ClaudeUI's own settings (`agentTypeColors`,
 * `dispatchTileColor`) and travel through the normal `update` write, so they
 * replicate to every client like any other setting. The rows are the ADR-065
 * vocabulary (`SettingRow`); the swatches wrap, so the same body serves the
 * phone's settings view.
 */
import type { AgentTypeInfo, EngineId } from '../../../../shared/types'
import {
  AGENT_COLOR_IDS,
  DEFAULT_DISPATCH_TILE_COLOR,
  DISPATCH_TILE_LETTER,
  agentColorOverride,
  dispatchTileTitle,
  isAgentColorId,
  isDefaultSubagentType,
  resolveAgentTypeColor,
  tileLetter,
  withAgentColorOverride,
  type AgentColorId
} from '../../../../shared/agent-type-colors'
import { engineMeta } from '../../../../shared/engine-meta'
import { useActiveSession, type AppSettings } from '../../stores/session-store'
import { useAgentTypeCatalog } from '../../hooks/useAgentTypeCatalog'
import { AgentTile } from '../agents/AgentTypeTile'
import { SettingRow } from './settings-controls'

/** The swatch fill, per palette colour: whole class names, since Tailwind reads source text. */
const SWATCH_CLASS: Record<AgentColorId, string> = {
  sky: 'bg-agent-sky',
  violet: 'bg-agent-violet',
  green: 'bg-agent-green',
  orange: 'bg-agent-orange',
  rose: 'bg-agent-rose',
  amber: 'bg-agent-amber',
  teal: 'bg-agent-teal',
  pink: 'bg-agent-pink'
}

const SOURCE_LABEL: Record<AgentTypeInfo['source'], string> = {
  builtin: 'Built-in',
  user: 'User agent',
  project: 'Project agent'
}

const capitalise = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1)

/**
 * The eight swatches. A swatch is a 24px touch target around a 14px dot; the
 * picked one carries a ring. `value` is the override: none picked means Auto.
 * Wide they are one row; on a phone (the primitive's `max-md` edge, the same one
 * that caps its control column) they wrap to two rows of four, so the name keeps
 * a readable share of the row. Auto and Reset live in the row's second line
 * (`ResetLink`), not here.
 */
function SwatchPicker({
  value,
  onPick,
  testid,
  subject
}: {
  value: AgentColorId | undefined
  onPick: (color: AgentColorId) => void
  testid: string
  /** The thing being coloured, for the swatches' accessible names. */
  subject: string
}): React.JSX.Element {
  return (
    // An inner box: the primitive's `max-md:[&>*]:max-w-full` reaches its direct children
    // only, and would beat a cap set on the outer one.
    <span className="flex justify-end">
      <span className="flex flex-wrap items-center justify-end gap-0.5 max-w-[104px] md:max-w-[212px]">
        {AGENT_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-testid={`${testid}.swatch`}
            data-id={id}
            aria-pressed={value === id}
            aria-label={`${subject}: ${capitalise(id)}`}
            title={capitalise(id)}
            onClick={() => onPick(id)}
            className="h-6 w-6 shrink-0 inline-flex items-center justify-center cursor-default"
          >
            <span
              className={`h-3.5 w-3.5 rounded-full ${SWATCH_CLASS[id]} ${
                value === id
                  ? 'ring-2 ring-offset-1 ring-offset-bg-secondary ring-text-primary'
                  : ''
              }`}
            />
          </button>
        ))}
      </span>
    </span>
  )
}

/** The row's Reset: only while there is an override to drop. */
function ResetLink({
  testid,
  onReset
}: {
  testid: string
  onReset: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={`${testid}.reset`}
      onClick={onReset}
      className="ml-1 text-accent hover:text-accent-hover cursor-default"
    >
      Reset
    </button>
  )
}

/** Where a type's colour comes from right now, for the row's second line. */
function statusOf(override: AgentColorId | undefined, native: string | undefined): string {
  if (override) return 'custom colour'
  return native ? "Auto, from the agent's own colour" : 'Auto'
}

function TypeRow({
  engine,
  info,
  override,
  onPick
}: {
  engine: EngineId
  info: AgentTypeInfo
  override: AgentColorId | undefined
  onPick: (color: AgentColorId | undefined) => void
}): React.JSX.Element {
  const testid = 'AgentColours.row'
  if (isDefaultSubagentType(engine, info.type)) {
    return (
      <SettingRow
        testid={testid}
        dataId={info.type}
        dimmed
        leading={
          <AgentTile
            testId="AgentColours.tile"
            letter={'–'}
            title={`${info.type}: default type, no tile`}
          />
        }
        label={info.type}
        description="Default type, no tile."
      />
    )
  }
  const colorId = resolveAgentTypeColor(info.type, { override, native: info.nativeColor })
  return (
    <SettingRow
      testid={testid}
      dataId={info.type}
      leading={
        <AgentTile
          testId="AgentColours.tile"
          letter={tileLetter(info.type)}
          colorId={colorId}
          title={info.type}
        />
      }
      label={info.type}
      description={
        <>
          {SOURCE_LABEL[info.source]} · {statusOf(override, info.nativeColor)}
          {override && <ResetLink testid="AgentColours" onReset={() => onPick(undefined)} />}
        </>
      }
    >
      <SwatchPicker
        value={override}
        onPick={onPick}
        testid="AgentColours"
        subject={`${info.type} colour`}
      />
    </SettingRow>
  )
}

/** One engine's agent types and their tile colours. */
export function AgentColoursSection({
  engine,
  settings,
  update
}: {
  engine: EngineId
  settings: AppSettings
  update: (p: Partial<AppSettings>) => void
}): React.JSX.Element {
  // Project agents belong to a working directory: the open session's, if any.
  const cwd = useActiveSession((s) => s.cwd)
  // `fresh`: the page is where a just-edited agent file is expected to show up.
  const types = useAgentTypeCatalog(engine, cwd || undefined, { fresh: true })
  const overrides = settings.agentTypeColors

  return (
    <div
      data-testid="AgentColoursSection"
      data-engine={engine}
      className="divide-y divide-border/55"
    >
      {types.length === 0 && (
        <SettingRow
          testid="AgentColours.empty"
          dimmed
          description={`No ${engineMeta(engine).label} agent types listed.`}
        />
      )}
      {types.map((info) => (
        <TypeRow
          key={info.type}
          engine={engine}
          info={info}
          override={agentColorOverride(overrides, engine, info.type)}
          onPick={(color) =>
            update({
              agentTypeColors: withAgentColorOverride(overrides, engine, info.type, color)
            })
          }
        />
      ))}
    </div>
  )
}

/** The one colour of the cross-engine dispatch tile (the letter X), on every engine. */
export function DispatchTileColourSection({
  settings,
  update
}: {
  settings: AppSettings
  update: (p: Partial<AppSettings>) => void
}): React.JSX.Element {
  const override = isAgentColorId(settings.dispatchTileColor)
    ? settings.dispatchTileColor
    : undefined
  return (
    <div data-testid="DispatchTileColourSection" className="divide-y divide-border/55">
      <SettingRow
        testid="DispatchTileColourSection.row"
        leading={
          <AgentTile
            testId="DispatchTileColourSection.tile"
            letter={DISPATCH_TILE_LETTER}
            colorId={override ?? DEFAULT_DISPATCH_TILE_COLOR}
            title={dispatchTileTitle({ engine: '<engine>', model: '<model>' })}
          />
        }
        label="Cross-engine dispatch (X)"
        description={
          <>
            One colour for the X tile on an agent dispatched to another harness, whichever harness
            it came from. {override ? 'Custom colour.' : 'Default.'}
            {override && (
              <ResetLink
                testid="DispatchTileColour"
                onReset={() => update({ dispatchTileColor: undefined })}
              />
            )}
          </>
        }
      >
        <SwatchPicker
          value={override}
          onPick={(color) => update({ dispatchTileColor: color })}
          testid="DispatchTileColour"
          subject="Dispatch tile colour"
        />
      </SettingRow>
    </div>
  )
}
