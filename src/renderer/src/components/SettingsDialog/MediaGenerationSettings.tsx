/**
 * Settings › Media generation: ClaudeUI's hosted `generate_image` / `generate_video` tools
 * (engines, default models, background-job limits, where files go).
 *
 * One value, `mediaGeneration`, written partially: `resolveMediaGeneration` fills what is
 * missing, so a row that equals its default simply stores it. The model pickers list only what
 * the connected sign-ins and keys cover (`window.api.listMediaModels`, served to the web client
 * too); a saved model the catalog no longer lists is flagged, and Automatic is what the job
 * service uses until the user picks another.
 */
import type {
  MediaCatalog,
  MediaCatalogModel,
  MediaGenerationSettings as Resolved,
  MediaKind,
  MediaModelChoice,
  MediaSource
} from '../../../../shared/media-generation'
import {
  CHATGPT_PLAN_MODEL_REF,
  DEFAULT_MEDIA_GENERATION,
  resolveMediaGeneration
} from '../../../../shared/media-generation'
import { useMediaCatalog } from '../../hooks/useMediaCatalog'
import type { SelectMenuOption } from '../shared/SelectMenu'
import type { AppSettings } from '../../stores/session-store'
import {
  NumberField,
  Segmented,
  SelectField,
  SettingRow,
  SettingsToggle
} from './settings-controls'

type Update = (p: Partial<AppSettings>) => void
interface Props {
  settings: AppSettings
  update: Update
}

const resolved = (s: AppSettings): Resolved => resolveMediaGeneration(s.mediaGeneration)

/** Writes the resolved value with `patch` applied, so the saved object is always whole. */
function write(s: AppSettings, update: Update, patch: Partial<Resolved>): void {
  update({ mediaGeneration: { ...resolved(s), ...patch } })
}

// ── Offer the tools to ────────────────────────────────────────────────

const ENGINE_ROWS = [
  {
    id: 'claude',
    label: 'Claude Code',
    description: "Through ClaudeUI's MCP server. Claude has no image tool of its own."
  },
  { id: 'pi', label: 'pi', description: 'Through the ClaudeUI bridge extension.' },
  {
    id: 'opencode',
    label: 'opencode',
    description:
      "Replaces opencode's own generate_image and generate_video, which are hidden while this is on."
  }
] as const

export function MediaEnginesSettings({ settings, update }: Props): React.JSX.Element {
  const r = resolved(settings)
  return (
    <div data-testid="MediaGenerationSection.engines" className="divide-y divide-border/55">
      {ENGINE_ROWS.map(({ id, label, description }) => (
        <SettingsToggle
          key={id}
          testid="MediaGenerationSection.engine"
          dataId={id}
          label={label}
          description={description}
          modified={r.engines[id] !== DEFAULT_MEDIA_GENERATION.engines[id]}
          onReset={() => write(settings, update, { engines: { ...r.engines, [id]: true } })}
          checked={r.engines[id]}
          onChange={(v) => write(settings, update, { engines: { ...r.engines, [id]: v } })}
        />
      ))}
    </div>
  )
}

// ── Models ────────────────────────────────────────────────────────────

const SOURCE_ORDER: MediaSource[] = ['chatgpt-plan', 'openai', 'openrouter']

function sectionLabel(source: MediaSource, kind: MediaKind): string {
  if (source === 'chatgpt-plan') return 'ChatGPT · included in your plan'
  const unit = kind === 'image' ? 'image' : 'clip'
  return `${source === 'openai' ? 'OpenAI' : 'OpenRouter'} · API key · billed per ${unit}`
}

/** What Automatic picks for `kind` from this catalog (the job service's rule, for the label). */
function automaticName(catalog: MediaCatalog | null, kind: MediaKind): string | undefined {
  if (!catalog) return undefined
  const models = catalog.models.filter((m) => m.kind === kind)
  const plan = models.find((m) => m.ref === CHATGPT_PLAN_MODEL_REF)
  return (plan ?? models[0])?.name
}

export function modelOptions(catalog: MediaCatalog | null, kind: MediaKind): SelectMenuOption[] {
  const auto = automaticName(catalog, kind)
  const options: SelectMenuOption[] = [
    {
      value: 'auto',
      label: 'Automatic',
      selectedLabel: auto ? `Automatic · ${auto}` : 'Automatic'
    },
    { value: 'off', label: 'Off', description: `No ${kind} tool for any engine` }
  ]
  const models: MediaCatalogModel[] = catalog?.models.filter((m) => m.kind === kind) ?? []
  for (const source of SOURCE_ORDER) {
    models
      .filter((m) => m.source === source)
      .forEach((m, i) => {
        options.push({
          value: m.ref,
          label: m.name,
          section: i === 0 ? sectionLabel(source, kind) : undefined,
          description:
            source === 'chatgpt-plan'
              ? 'OpenAI picks the model; size and quality are fixed by the plan'
              : undefined,
          trailing:
            source === 'chatgpt-plan' ? (
              <span className="text-[11px] text-success">signed in</span>
            ) : (
              <span className="text-[11px] text-text-muted">
                {m.free && <span className="mr-1.5">free</span>}
                {m.ref.replace(/^[^/]+\//, '')}
              </span>
            )
        })
      })
  }
  return options
}

/** The saved choice names a model the catalog does not list (only once the catalog is known). */
function isStale(catalog: MediaCatalog | null, kind: MediaKind, choice: MediaModelChoice): boolean {
  if (!catalog || choice === 'auto' || choice === 'off') return false
  return !catalog.models.some((m) => m.kind === kind && m.ref === choice)
}

const QUALITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
] as const

export function MediaModelsSettings({ settings, update }: Props): React.JSX.Element {
  const r = resolved(settings)
  const { catalog, refresh } = useMediaCatalog()

  const modelRow = (
    kind: MediaKind,
    field: 'imageModel' | 'videoModel',
    label: string,
    description: string
  ): React.JSX.Element => {
    const choice = r[field]
    const stale = isStale(catalog, kind, choice)
    return (
      <>
        <SettingRow
          testid="MediaGenerationSection.row"
          dataId={kind}
          label={label}
          description={description}
          modified={choice !== DEFAULT_MEDIA_GENERATION[field]}
          onReset={() => write(settings, update, { [field]: DEFAULT_MEDIA_GENERATION[field] })}
        >
          <SelectField
            testid={`MediaGenerationSection.${field}`}
            value={choice}
            options={modelOptions(catalog, kind)}
            placeholder={choice}
            width="w-[280px]"
            onChange={(v) => write(settings, update, { [field]: v })}
          />
        </SettingRow>
        {stale && (
          <div
            data-testid="MediaGenerationSection.stale"
            data-id={kind}
            className="mx-4 mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] text-warning"
          >
            The saved {kind} model <code>{choice}</code> is not available: its sign-in or API key is
            no longer connected. Automatic is used until you pick another.{' '}
            <button
              type="button"
              data-testid="MediaGenerationSection.staleReset"
              data-id={kind}
              className="underline cursor-default"
              onClick={() => write(settings, update, { [field]: 'auto' })}
            >
              Reset
            </button>
          </div>
        )}
      </>
    )
  }

  return (
    <div data-testid="MediaGenerationSection.models" className="divide-y divide-border/55">
      {modelRow(
        'image',
        'imageModel',
        'Image model',
        "Automatic uses ChatGPT Plan when you're signed in, otherwise the newest model on a connected key."
      )}
      <SettingRow
        testid="MediaGenerationSection.row"
        dataId="imageQuality"
        label="Image quality"
        description="For keyed models. ChatGPT Plan ignores it."
        modified={r.imageQuality !== DEFAULT_MEDIA_GENERATION.imageQuality}
        onReset={() =>
          write(settings, update, { imageQuality: DEFAULT_MEDIA_GENERATION.imageQuality })
        }
      >
        <Segmented
          testid="MediaGenerationSection.imageQuality"
          value={r.imageQuality}
          options={[...QUALITY_OPTIONS]}
          onChange={(v) => write(settings, update, { imageQuality: v })}
        />
      </SettingRow>
      {modelRow(
        'video',
        'videoModel',
        'Video model',
        'Slow and billed per clip. ChatGPT Plan has no video generation.'
      )}
      <div className="px-4 py-2 flex justify-end">
        <button
          type="button"
          data-testid="MediaGenerationSection.refresh"
          onClick={refresh}
          className="text-[11px] text-text-secondary hover:text-text-primary cursor-default"
        >
          Refresh models
        </button>
      </div>
    </div>
  )
}

// ── Background jobs ───────────────────────────────────────────────────

/** "4 h" / "12 min" for a reset horizon. */
export function formatReset(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`
  return `${Math.max(1, Math.round(seconds / 60))} min`
}

export function MediaJobsSettings({ settings, update }: Props): React.JSX.Element {
  const r = resolved(settings)
  const { catalog } = useMediaCatalog()
  const usage = catalog?.planUsage
  const used = usage?.usedPercent
  return (
    <div data-testid="MediaGenerationSection.jobs" className="divide-y divide-border/55">
      <SettingRow
        testid="MediaGenerationSection.row"
        dataId="concurrency"
        label="Run at most"
        description="Jobs beyond this wait in a queue, so a batch doesn't burn the plan limit or hit provider rate limits all at once."
        modified={r.concurrency !== DEFAULT_MEDIA_GENERATION.concurrency}
        onReset={() =>
          write(settings, update, { concurrency: DEFAULT_MEDIA_GENERATION.concurrency })
        }
      >
        <NumberField
          testid="MediaGenerationSection.concurrency"
          value={r.concurrency}
          min={1}
          max={16}
          unit="at once"
          onChange={(v) =>
            write(settings, update, { concurrency: v ?? DEFAULT_MEDIA_GENERATION.concurrency })
          }
        />
      </SettingRow>
      <SettingRow
        testid="MediaGenerationSection.row"
        dataId="timeout"
        label="Give up after"
        description="A job still running then fails and the agent is told."
        modified={r.timeoutMinutes !== DEFAULT_MEDIA_GENERATION.timeoutMinutes}
        onReset={() =>
          write(settings, update, { timeoutMinutes: DEFAULT_MEDIA_GENERATION.timeoutMinutes })
        }
      >
        <NumberField
          testid="MediaGenerationSection.timeout"
          value={r.timeoutMinutes}
          min={1}
          max={120}
          unit="min"
          onChange={(v) =>
            write(settings, update, {
              timeoutMinutes: v ?? DEFAULT_MEDIA_GENERATION.timeoutMinutes
            })
          }
        />
      </SettingRow>
      {usage && (
        <SettingRow
          testid="MediaGenerationSection.row"
          dataId="planUsage"
          label="Plan usage"
          description="From the last ChatGPT Plan response."
        >
          <div
            data-testid="MediaGenerationSection.planUsage"
            className="flex items-center gap-2 text-[12px]"
          >
            {used != null && (
              <div className="w-32 h-1.5 rounded bg-bg-tertiary overflow-hidden">
                <div
                  data-testid="MediaGenerationSection.planUsageBar"
                  className="h-1.5 rounded bg-success"
                  style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
                />
              </div>
            )}
            <span className="text-text-primary">
              {used != null ? `${Math.round(used)}% used` : 'usage unknown'}
            </span>
            {usage.resetsInSeconds != null && (
              <span className="text-text-muted">
                · resets in {formatReset(usage.resetsInSeconds)}
              </span>
            )}
          </div>
        </SettingRow>
      )}
    </div>
  )
}

// ── Output ────────────────────────────────────────────────────────────

export function MediaOutputSettings({ settings, update }: Props): React.JSX.Element {
  const r = resolved(settings)
  return (
    <SettingRow
      testid="MediaGenerationSection.row"
      dataId="saveTo"
      label="Save to"
      description="Where a file goes when the agent gives no path. A path the agent gives must be inside the workspace and asks like an edit."
      layout="stacked"
      modified={r.saveTo !== DEFAULT_MEDIA_GENERATION.saveTo}
      onReset={() => write(settings, update, { saveTo: DEFAULT_MEDIA_GENERATION.saveTo })}
    >
      <Segmented
        testid="MediaGenerationSection.saveTo"
        value={r.saveTo}
        options={[
          { value: 'media', label: 'Workspace .claude/ui/media' },
          { value: 'generated', label: 'Workspace generated/' }
        ]}
        onChange={(v) => write(settings, update, { saveTo: v })}
      />
    </SettingRow>
  )
}
