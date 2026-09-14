/**
 * CodexConfigPanes.tsx
 *
 * The Engines › Codex page's group bodies (ADR-065 row vocabulary, ADR-068 §6's
 * one-home table): curated panes over the `config.toml` keys worth a real
 * control, a Managed group for the values ClaudeUI forces, and a read-only Raw
 * config view for everything else.
 *
 * ## What makes these different from the pi and opencode panes
 *
 * Those two write their engine's file through ClaudeUI's own byte-preserving
 * leaf writers. Codex's file is TOML and **ClaudeUI never parses or writes
 * TOML** (ADR-068 §6): every read is `config/read` with layers and every write
 * is one `config/batchWrite` through the app-server, whose own `toml_edit`
 * writer keeps the user's comments, key order and untouched tables. That is
 * strictly better — Codex owns its schema and is the only thing that should
 * re-emit it — and it is why the version token, not a file mtime, is what makes
 * concurrent edits safe.
 *
 * ## The conventions, and what the real binary proved about each
 *
 * Everything below is recorded in `docs/codex-spike.md` §
 * "`config/batchWrite` probe" and pinned by
 * `src/integration/codex/codex-config-write.integration.test.ts` (0.154.0,
 * Windows x64, 2026-09-14).
 *
 *  · IMMEDIATE SAVES, as on the other two engine pages. No Save button: a
 *    toggle, chip, segment or select click commits at once; number and text
 *    inputs commit on blur AND Enter.
 *  · ABSENT MEANS DEFAULT. A key whose absence already gives the wanted
 *    behaviour is REMOVED rather than written with its default value — probe
 *    (c): `value: null` deletes the key, so a row's Reset is a real removal and
 *    "changed from default" can keep meaning "present in the base user layer".
 *  · LEAF PATHS. `sandbox_workspace_write.network_access` is written at its own
 *    dotted key path, never by writing the parent table — probe (d): the writer
 *    creates the table when it is absent, and removing one leaf leaves the
 *    siblings alone. A whole-table write would erase keys these panes do not
 *    model.
 *  · ONE CONFIG OBJECT. Every pane shares `useCodexConfig` — eleven cards over
 *    one file, and each write carries the version the last read produced. See
 *    that module for why per-pane copies cannot work here.
 *
 * ## Key selection
 *
 * The key list comes from `config/src/config_toml.rs` and the generated
 * `protocol/v2/*Config.ts`, NOT from the ADR-068 §6 table, because probe (e)
 * showed `batchWrite` does not validate a key against the schema: a
 * misremembered key is accepted, written, and then breaks the loader on the next
 * session. Two keys the ADR named do not exist on this binary
 * (`browser_use.enabled`, `computer_use.enabled`); the switches that gate those
 * tools are `features.browser_use` / `features.computer_use`, and those are what
 * the Tools group writes.
 */

import { useEffect, useState } from 'react'
import { Button, ListEditor, Segmented, SelectField, SettingRow } from './settings-controls'
import { LeafNumberInput, LeafRow, StackedRow, ToggleRow } from './OpencodeConfigPanes'
import {
  codexPathId,
  useCodexConfig,
  type CodexConfigApi,
  type CodexLeafPath
} from './use-codex-config'
import type { CodexConfigValue } from '../../../../shared/codex-types'
import type { ModelInfo } from '../../../../shared/types'

/** Testid namespace for every control these panes render (ADR-027 tier 2). */
const PANE = 'CodexConfigPane'

/** A select's "leave it to Codex" option. Choosing it REMOVES the key. */
const UNSET = ''

// ── Pane shell ───────────────────────────────────────────────────────────────

/**
 * Loading / not-installed gating and the hairline between rows.
 *
 * A group CARD divides its items (View.tsx), but a whole pane is one item, so
 * the rows inside it need the same divider to read as the card's rows. There is
 * no footer: what the group applies to and where it is stored are the card
 * header's storage tag and note (ADR-065).
 *
 * The version-conflict notice lives here rather than on a row: it is not any
 * one row's failure — the file moved under the whole page — and it must be
 * visible whichever group the user happens to be looking at.
 */
function PaneShell({
  testid,
  api,
  children
}: {
  testid: string
  api: CodexConfigApi
  children: React.ReactNode
}): React.JSX.Element {
  if (api.status === 'loading') {
    return (
      <div data-testid={testid}>
        <SettingRow testid={`${PANE}.status`} dataId="loading" description="Loading…" />
      </div>
    )
  }
  if (api.status === 'unavailable') {
    return (
      <div data-testid={testid}>
        <SettingRow
          testid={`${PANE}.status`}
          dataId="unavailable"
          dimmed
          description={
            api.unavailable
              ? `Codex's configuration could not be read: ${api.unavailable}`
              : "Codex's configuration could not be read."
          }
        />
      </div>
    )
  }
  return (
    <div data-testid={testid} className="divide-y divide-border/55">
      {api.notice && (
        <SettingRow testid={`${PANE}.notice`} dataId="conflict" description={api.notice}>
          <Button variant="link" testid={`${PANE}.noticeDismiss`} onClick={api.dismissNotice}>
            Dismiss
          </Button>
        </SettingRow>
      )}
      {children}
    </div>
  )
}

// ── Row bindings ─────────────────────────────────────────────────────────────

interface Bound {
  api: CodexConfigApi
  path: CodexLeafPath
  label: string
  helper: string
}

/** The shared half of every row: key line, inline error, hover Reset. */
function rowProps(api: CodexConfigApi, path: CodexLeafPath, indent = false) {
  const key = codexPathId(path)
  return {
    testidPrefix: PANE,
    configKey: key,
    error: api.errorAt(path),
    modified: api.modified(path),
    onReset: () => api.patch(path, undefined),
    indent
  }
}

/**
 * Toggle over a key whose ABSENCE already means `defaultOn`. Switching TO the
 * default REMOVES the key, so the file keeps only real overrides and follows
 * Codex if the default ever moves.
 *
 * `invert` draws the control as the OPPOSITE of the stored key — Codex spells
 * two of these as exclusions (`exclude_slash_tmp`, `ignore_default_excludes`)
 * and a settings row reads better as the thing it permits.
 */
function BoolRow({
  api,
  path,
  label,
  helper,
  defaultOn,
  invert = false,
  indent = false
}: Bound & { defaultOn: boolean; invert?: boolean; indent?: boolean }): React.JSX.Element {
  const raw = api.read(path)
  const stored = typeof raw === 'boolean' ? raw : defaultOn
  return (
    <ToggleRow
      {...rowProps(api, path, indent)}
      label={label}
      helper={helper}
      checked={invert ? !stored : stored}
      onChange={(next) => {
        const value = invert ? !next : next
        api.patch(path, value === defaultOn ? undefined : value)
      }}
    />
  )
}

/** Number row bound to one leaf; an emptied field removes the key. */
function NumberRow({
  api,
  path,
  label,
  helper,
  placeholder,
  unit,
  indent = false
}: Bound & { placeholder: string; unit?: string; indent?: boolean }): React.JSX.Element {
  const raw = api.read(path)
  return (
    <LeafRow {...rowProps(api, path, indent)} label={label} helper={helper}>
      <LeafNumberInput
        testid={`${PANE}.number`}
        configKey={codexPathId(path)}
        value={raw}
        placeholder={placeholder}
        unit={unit}
        onCommit={(value) => api.patch(path, value)}
      />
    </LeafRow>
  )
}

/**
 * Segmented row over a small closed set (ADR-065: five options or fewer).
 * `defaultValue` is what Codex already does when the key is ABSENT, so choosing
 * it removes the key rather than writing Codex's own default back into the file.
 */
function SegmentedRow({
  api,
  path,
  label,
  helper,
  options,
  defaultValue,
  indent = false
}: Bound & {
  options: Array<{ value: string; label: string }>
  defaultValue: string
  indent?: boolean
}): React.JSX.Element {
  const raw = api.read(path)
  return (
    <LeafRow {...rowProps(api, path, indent)} label={label} helper={helper}>
      <Segmented
        value={typeof raw === 'string' ? raw : defaultValue}
        options={options}
        onChange={(value) => api.patch(path, value === defaultValue ? undefined : value)}
        testid={`${PANE}.segmented`}
        optionTestid={`${PANE}.segment`}
      />
    </LeafRow>
  )
}

/**
 * Select row for a set too large or too wide for a segmented control. The first
 * option is always {@link UNSET} — "leave it to Codex" — and choosing it REMOVES
 * the key, which is the only honest way to express "no opinion" in a file whose
 * defaults are the engine's to move.
 */
function SelectRow({
  api,
  path,
  label,
  helper,
  options,
  unsetLabel,
  width,
  indent = false
}: Bound & {
  options: Array<{ value: string; label: string }>
  unsetLabel: string
  width?: string
  indent?: boolean
}): React.JSX.Element {
  const raw = api.read(path)
  return (
    <LeafRow {...rowProps(api, path, indent)} label={label} helper={helper}>
      <SelectField
        testid={`${PANE}.select`}
        dataId={codexPathId(path)}
        value={typeof raw === 'string' ? raw : UNSET}
        options={[{ value: UNSET, label: unsetLabel }, ...options]}
        width={width}
        onChange={(value) => api.patch(path, value === UNSET ? undefined : value)}
      />
    </LeafRow>
  )
}

/** String-list row (paths, filenames, environment patterns). Emptied = removed. */
function ListRow({
  api,
  path,
  label,
  helper,
  placeholder
}: Bound & { placeholder: string }): React.JSX.Element {
  const raw = api.read(path)
  const items = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : []
  // Entries the chips cannot render (a table inside a list) are carried through
  // untouched rather than dropped on the next edit, as the pi panes do.
  const opaque = Array.isArray(raw) ? raw.filter((v) => typeof v !== 'string') : []
  return (
    <StackedRow {...rowProps(api, path)} label={label} helper={helper}>
      <ListEditor
        items={items}
        placeholder={placeholder}
        onUpdate={(next) => {
          const merged: CodexConfigValue[] = [...next, ...opaque]
          api.patch(path, merged.length > 0 ? merged : undefined)
        }}
        testid={`${PANE}.list`}
      />
      {opaque.length > 0 && (
        <span
          data-testid={`${PANE}.opaqueNote`}
          data-id={codexPathId(path)}
          className="block mt-2 text-[12px] leading-4 text-text-secondary"
        >
          {opaque.length} advanced {opaque.length === 1 ? 'entry' : 'entries'} in this list are kept
          as-is and not shown here.
        </span>
      )}
    </StackedRow>
  )
}

/** Multi-line text row (instructions, the compaction prompt). Emptied = removed. */
function TextAreaRow({
  api,
  path,
  label,
  helper,
  placeholder,
  rows = 6
}: Bound & { placeholder: string; rows?: number }): React.JSX.Element {
  const raw = api.read(path)
  const committed = typeof raw === 'string' ? raw : ''
  const [draft, setDraft] = useState(committed)
  // Re-seed when the committed value moves — i.e. after our own write + re-read.
  useEffect(() => setDraft(typeof raw === 'string' ? raw : ''), [raw])
  return (
    <StackedRow {...rowProps(api, path)} label={label} helper={helper}>
      <textarea
        data-testid={`${PANE}.textarea`}
        data-id={codexPathId(path)}
        value={draft}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => api.patch(path, draft.trim() === '' ? undefined : draft)}
        className="w-full bg-bg-input border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors resize-y"
      />
    </StackedRow>
  )
}

/** A value ClaudeUI forces. The control is shown and is not interactive. */
function ManagedRow({
  configKey,
  label,
  why,
  value,
  locked
}: {
  configKey: string
  label: string
  why: string
  value: string
  locked: string
}): React.JSX.Element {
  return (
    <SettingRow
      testid={`${PANE}.managedRow`}
      dataId={configKey}
      label={label}
      description={why}
      keyText={configKey}
      locked={locked}
    >
      <span className="text-[12px] text-text-secondary font-mono">{value}</span>
    </SettingRow>
  )
}

// ── The Codex model catalog, for the model and effort selects ─────────────────

/**
 * Codex's own models and the reasoning-effort tiers they publish.
 *
 * `review_model` and `agents.default_subagent_model` name a MODEL, and
 * `plan_mode_reasoning_effort` / `agents.default_subagent_reasoning_effort` name
 * a native tier — both sets are the catalog's, not ClaudeUI's, so they are read
 * rather than hard-coded. Discovery failing leaves the select empty except for
 * its "leave it to Codex" option, which is the honest state: nothing can be
 * offered that the catalog did not.
 */
function useCodexCatalog(): { models: ModelInfo[]; efforts: string[] } {
  const [models, setModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    let cancelled = false
    window.api
      .getEngineModels()
      .then((groups) => {
        if (cancelled) return
        setModels(groups.filter((g) => g.engineId === 'codex').flatMap((g) => g.models))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const efforts = [
    ...new Set(models.flatMap((m) => (m.nativeEffortOptions ?? []).map((o) => o.value)))
  ]
  return { models, efforts }
}

const modelOptions = (models: ModelInfo[]): Array<{ value: string; label: string }> =>
  models.map((model) => ({ value: model.value, label: model.displayName || model.value }))

const effortOptions = (efforts: string[]): Array<{ value: string; label: string }> =>
  efforts.map((value) => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1) }))

// ── Model behaviour ──────────────────────────────────────────────────────────

export function CodexModelBehaviorSection(): React.JSX.Element {
  const api = useCodexConfig()
  const { models, efforts } = useCodexCatalog()
  return (
    <PaneShell testid="CodexModelBehaviorSection" api={api}>
      <SelectRow
        api={api}
        path={['model_reasoning_summary']}
        label="Reasoning summaries"
        helper="How much of the model's reasoning Codex asks the API to summarise."
        unsetLabel="Codex default"
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'concise', label: 'Concise' },
          { value: 'detailed', label: 'Detailed' },
          { value: 'none', label: 'None' }
        ]}
      />
      <SegmentedRow
        api={api}
        path={['model_verbosity']}
        label="Answer verbosity"
        helper="How long the model's written answers are."
        defaultValue={UNSET}
        options={[
          { value: UNSET, label: 'Default' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ]}
      />
      <SelectRow
        api={api}
        path={['plan_mode_reasoning_effort']}
        label="Plan-mode effort"
        helper="Reasoning effort while a thread is in plan mode. Blank follows the session's own effort."
        unsetLabel="Follow the session"
        options={effortOptions(efforts)}
      />
      <SegmentedRow
        api={api}
        path={['service_tier']}
        label="Service tier"
        helper="Which OpenAI service tier new turns request."
        defaultValue={UNSET}
        options={[
          { value: UNSET, label: 'Default' },
          { value: 'priority', label: 'Priority' },
          { value: 'flex', label: 'Flex' }
        ]}
      />
      <SelectRow
        api={api}
        path={['personality']}
        label="Personality"
        helper="The tone preset Codex asks the model for."
        unsetLabel="Codex default"
        options={[
          { value: 'none', label: 'None' },
          { value: 'friendly', label: 'Friendly' },
          { value: 'pragmatic', label: 'Pragmatic' }
        ]}
      />
      <SelectRow
        api={api}
        path={['review_model']}
        label="Review model"
        helper="The model Codex's own reviewer runs on. Blank uses the session's model."
        unsetLabel="Session model"
        width="min-w-[190px]"
        options={modelOptions(models)}
      />
    </PaneShell>
  )
}

// ── Context & compaction ─────────────────────────────────────────────────────

export function CodexContextSection(): React.JSX.Element {
  const api = useCodexConfig()
  return (
    <PaneShell testid="CodexContextSection" api={api}>
      <NumberRow
        api={api}
        path={['model_context_window']}
        label="Context window"
        helper="Overrides the window the catalog publishes for the selected model."
        placeholder="catalog"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['model_auto_compact_token_limit']}
        label="Auto-compact at"
        helper="Codex compacts the thread once it passes this many tokens."
        placeholder="catalog"
        unit="tokens"
      />
      <SegmentedRow
        api={api}
        path={['model_auto_compact_token_limit_scope']}
        label="Counted against"
        helper="Whether the limit measures the whole context or only what follows the carried prefix."
        indent
        defaultValue="total"
        options={[
          { value: 'total', label: 'Total' },
          { value: 'body_after_prefix', label: 'After prefix' }
        ]}
      />
      <NumberRow
        api={api}
        path={['tool_output_token_limit']}
        label="Tool output budget"
        helper="Token budget applied when a tool's output is stored in the context."
        placeholder="default"
        unit="tokens"
      />
      <NumberRow
        api={api}
        path={['project_doc_max_bytes']}
        label="Project instructions size"
        helper="Maximum total bytes of AGENTS.md content Codex reads for a thread."
        placeholder="default"
        unit="bytes"
      />
      <ListRow
        api={api}
        path={['project_doc_fallback_filenames']}
        label="Project instruction fallbacks"
        helper="Filenames Codex looks for when a directory has no AGENTS.md, in order."
        placeholder="CLAUDE.md"
      />
      <TextAreaRow
        api={api}
        path={['compact_prompt']}
        label="Compaction prompt"
        helper="Replaces the prompt Codex uses when it compacts a thread's history."
        placeholder="Codex's built-in compaction prompt"
      />
    </PaneShell>
  )
}

// ── Instructions ─────────────────────────────────────────────────────────────

export function CodexInstructionsSection(): React.JSX.Element {
  const api = useCodexConfig()
  return (
    <PaneShell testid="CodexInstructionsSection" api={api}>
      <TextAreaRow
        api={api}
        path={['developer_instructions']}
        label="Developer instructions"
        helper="Inserted as a developer-role message at the top of every thread."
        placeholder="None"
      />
      <TextAreaRow
        api={api}
        path={['instructions']}
        label="System instructions"
        helper="Replaces Codex's own system instructions. Deviating from them degrades the model."
        placeholder="Codex's built-in instructions"
      />
      {/* Every `include_*` default is `true` (`core/src/config/mod.rs`
          `unwrap_or(true)`), so turning one back ON removes the key. */}
      <BoolRow
        api={api}
        path={['include_environment_context']}
        label="Send environment context"
        helper="The <environment_context> block: working directory, platform, sandbox state."
        defaultOn
      />
      <BoolRow
        api={api}
        path={['include_permissions_instructions']}
        label="Send permission instructions"
        helper="The <permissions instructions> block describing what the model may do unasked."
        defaultOn
      />
      <BoolRow
        api={api}
        path={['include_collaboration_mode_instructions']}
        label="Send collaboration-mode instructions"
        helper="The <collaboration_mode> block for the thread's current mode."
        defaultOn
      />
      <BoolRow
        api={api}
        path={['include_apps_instructions']}
        label="Send apps instructions"
        helper="The <apps_instructions> block. Only meaningful when Codex apps are enabled."
        defaultOn
      />
    </PaneShell>
  )
}

// ── Workspace sandbox ────────────────────────────────────────────────────────

export function CodexSandboxSection(): React.JSX.Element {
  const api = useCodexConfig()
  const windows = window.api.platform === 'win32'
  return (
    <PaneShell testid="CodexSandboxSection" api={api}>
      {/* The mock's first row: this group tunes the workspace-write profile;
          WHETHER a turn runs under it is the session's permission mode
          (ADR-067), which is not set here. */}
      <SettingRow
        testid={`${PANE}.explain`}
        dataId="sandbox"
        dimmed
        description="These tune Codex's workspace-write sandbox. Which sandbox a turn runs under is the session's permission mode, not a setting here."
      />
      <BoolRow
        api={api}
        path={['sandbox_workspace_write', 'network_access']}
        label="Allow network access"
        helper="Lets sandboxed commands reach the network. Off is Codex's default."
        defaultOn={false}
      />
      <ListRow
        api={api}
        path={['sandbox_workspace_write', 'writable_roots']}
        label="Extra writable roots"
        helper="Directories outside the workspace that sandboxed commands may write to."
        placeholder="/absolute/path"
      />
      <BoolRow
        api={api}
        path={['sandbox_workspace_write', 'exclude_tmpdir_env_var']}
        label="Keep $TMPDIR writable"
        helper="Off removes the directory $TMPDIR points at from the writable set."
        invert
        defaultOn={false}
      />
      <BoolRow
        api={api}
        path={['sandbox_workspace_write', 'exclude_slash_tmp']}
        label="Keep /tmp writable"
        helper="Off removes /tmp from the writable set."
        invert
        defaultOn={false}
      />
      <BoolRow
        api={api}
        path={['allow_login_shell']}
        label="Allow a login shell"
        helper="Lets shell tools start a login shell, so your profile scripts run."
        defaultOn
      />
      <ListRow
        api={api}
        path={['project_root_markers']}
        label="Project root markers"
        helper="Filenames that mark a project root when Codex walks up from the working directory."
        placeholder=".git"
      />
      {windows && (
        <SelectRow
          api={api}
          path={['windows', 'sandbox']}
          label="Windows sandbox"
          helper="How the Windows sandbox launches its child process."
          unsetLabel="Codex default"
          options={[
            { value: 'elevated', label: 'Elevated' },
            { value: 'unelevated', label: 'Unelevated' }
          ]}
        />
      )}
      {windows && (
        <BoolRow
          api={api}
          path={['windows', 'sandbox_private_desktop']}
          label="Use a private desktop"
          helper="Off runs the sandboxed child on the interactive desktop instead."
          defaultOn
        />
      )}
    </PaneShell>
  )
}

// ── Shell environment ────────────────────────────────────────────────────────

export function CodexShellEnvSection(): React.JSX.Element {
  const api = useCodexConfig()
  return (
    <PaneShell testid="CodexShellEnvSection" api={api}>
      <SegmentedRow
        api={api}
        path={['shell_environment_policy', 'inherit']}
        label="Inherit environment"
        helper="Which of ClaudeUI's environment variables a Codex shell tool starts with."
        defaultValue="all"
        options={[
          { value: 'all', label: 'All' },
          { value: 'core', label: 'Core' },
          { value: 'none', label: 'None' }
        ]}
      />
      {/* Codex resolves this key with `unwrap_or(true)`
          (`config/src/shell_environment_policy.rs`): with the key ABSENT the
          default excludes are IGNORED, i.e. nothing is stripped. The row shows
          the filter, so it renders OFF by default and turning it on writes
          `false`. */}
      <BoolRow
        api={api}
        path={['shell_environment_policy', 'ignore_default_excludes']}
        label="Strip secret-looking variables"
        helper="Off by default. On, Codex's own filter removes names that look like keys and tokens before a command runs."
        invert
        defaultOn
      />
      <ListRow
        api={api}
        path={['shell_environment_policy', 'exclude']}
        label="Also exclude"
        helper="Extra variable-name patterns to remove."
        placeholder="AWS_*"
      />
      <ListRow
        api={api}
        path={['shell_environment_policy', 'include_only']}
        label="Include only"
        helper="When set, ONLY variables matching these patterns survive."
        placeholder="PATH"
      />
    </PaneShell>
  )
}

// ── Tools & search ───────────────────────────────────────────────────────────

export function CodexToolsSection(): React.JSX.Element {
  const api = useCodexConfig()
  return (
    <PaneShell testid="CodexToolsSection" api={api}>
      <SegmentedRow
        api={api}
        path={['web_search']}
        label="Web search"
        helper="Which web-search mode the model's search tool runs in."
        defaultValue={UNSET}
        options={[
          { value: UNSET, label: 'Default' },
          { value: 'disabled', label: 'Off' },
          { value: 'cached', label: 'Cached' },
          { value: 'indexed', label: 'Indexed' },
          { value: 'live', label: 'Live' }
        ]}
      />
      <BoolRow
        api={api}
        path={['tools', 'update_plan', 'enabled']}
        label="Plan tool"
        helper="Lets the model keep a visible plan for the turn."
        defaultOn={false}
      />
      <BoolRow
        api={api}
        path={['tools', 'experimental_request_user_input', 'enabled']}
        label="Ask-the-user tool"
        helper="Lets the model stop and ask a question mid-turn."
        defaultOn
      />
      {/* `browser_use.enabled` / `computer_use.enabled` do NOT exist on 0.154.0
          (`v2/BrowserUseConfig.ts`, `v2/ComputerUseConfig.ts`); the switches are
          in the `features` table, and probe (e) showed a write to a key that
          does not exist is ACCEPTED and then breaks the loader — so these two
          rows use the keys the binary reads. */}
      <BoolRow
        api={api}
        path={['features', 'browser_use']}
        label="Browser tool"
        helper="Lets Codex drive a browser. Its per-origin policy lives in Raw config."
        defaultOn={false}
      />
      <BoolRow
        api={api}
        path={['features', 'computer_use']}
        label="Computer-use tool"
        helper="Lets Codex drive desktop applications. Its per-app policy lives in Raw config."
        defaultOn={false}
      />
      <NumberRow
        api={api}
        path={['background_terminal_max_timeout']}
        label="Background terminal poll window"
        helper="How long Codex will wait for output from a background terminal."
        placeholder="default"
        unit="ms"
      />
      <SettingRow
        testid={`${PANE}.managedRow`}
        dataId="hostedTools"
        label="Hosted tools"
        description="ClaudeUI's own tools (mockups, cross-engine dispatch) reach Codex as dynamic tools, not as config. They are configured on their own pages."
        locked="ClaudeUI"
      />
    </PaneShell>
  )
}

// ── Native agents ────────────────────────────────────────────────────────────

export function CodexAgentsSection(): React.JSX.Element {
  const api = useCodexConfig()
  const { models, efforts } = useCodexCatalog()
  const enabled = api.read(['agents', 'enabled'])
  // `agents.enabled` defaults to TRUE (`AgentsToml`, "Defaults to true"), so the
  // nested rows are live unless the user has explicitly turned the tools off.
  const on = typeof enabled === 'boolean' ? enabled : true
  return (
    <PaneShell testid="CodexAgentsSection" api={api}>
      <BoolRow
        api={api}
        path={['agents', 'enabled']}
        label="Multi-agent tools"
        helper="Lets a Codex thread spawn its own subagent threads."
        defaultOn
      />
      {on && (
        <NumberRow
          api={api}
          path={['agents', 'max_concurrent_threads_per_session']}
          label="Concurrent subagents"
          helper="How many spawned threads one session may have open at once."
          placeholder="backend default"
          indent
        />
      )}
      {on && (
        <NumberRow
          api={api}
          path={['agents', 'max_depth']}
          label="Nesting depth"
          helper="How deep a subagent may spawn another."
          placeholder="backend default"
          indent
        />
      )}
      {on && (
        <SelectRow
          api={api}
          path={['agents', 'default_subagent_model']}
          label="Subagent model"
          helper="The model a spawn uses when it names none."
          unsetLabel="Session model"
          width="min-w-[190px]"
          options={modelOptions(models)}
          indent
        />
      )}
      {on && (
        <SelectRow
          api={api}
          path={['agents', 'default_subagent_reasoning_effort']}
          label="Subagent effort"
          helper="The reasoning effort a spawn uses when it names none."
          unsetLabel="Session effort"
          options={effortOptions(efforts)}
          indent
        />
      )}
    </PaneShell>
  )
}

// ── MCP servers ──────────────────────────────────────────────────────────────

export function CodexMcpSection(): React.JSX.Element {
  const api = useCodexConfig()
  const native = api.read(['mcp_servers'])
  const nativeNames =
    typeof native === 'object' && native !== null && !Array.isArray(native)
      ? Object.keys(native).sort()
      : []
  const { inherited, skipped } = api.mcp
  return (
    <PaneShell testid="CodexMcpSection" api={api}>
      <SettingRow
        testid={`${PANE}.row`}
        dataId="inherited"
        label="Inherited from Claude"
        description={
          inherited.length === 0
            ? 'No MCP servers are configured in Claude, so Codex threads start with none.'
            : `${inherited.length} server${inherited.length === 1 ? '' : 's'} — ${inherited.join(', ')} — start with every Codex thread. Read when a thread starts, so a change applies to the next session.`
        }
        error={
          skipped.length > 0
            ? `Codex has no SSE transport, so ${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} skipped.`
            : undefined
        }
        errorTestid={`${PANE}.error`}
      >
        <Button
          variant="link"
          testid={`${PANE}.openMcp`}
          onClick={() => window.dispatchEvent(new CustomEvent('open-mcp-servers'))}
        >
          Open MCP servers ›
        </Button>
      </SettingRow>
      <SettingRow
        testid={`${PANE}.row`}
        dataId="mcp_servers"
        label="Declared in config.toml"
        description={
          nativeNames.length === 0
            ? 'None. Servers you declare in Codex’s own file — including OAuth ones Claude’s format cannot express — keep working alongside the inherited list.'
            : `${nativeNames.join(', ')}. These keep working alongside the inherited list; edit them in Raw config.`
        }
        keyText="mcp_servers"
      />
      <NumberRow
        api={api}
        path={['mcp_optional_startup_grace_ms']}
        label="Optional server grace"
        helper="How long Codex waits for optional MCP servers while building its first tool catalog."
        placeholder="default"
        unit="ms"
      />
    </PaneShell>
  )
}

// ── History & privacy ────────────────────────────────────────────────────────

export function CodexHistorySection(): React.JSX.Element {
  const api = useCodexConfig()
  return (
    <PaneShell testid="CodexHistorySection" api={api}>
      <SegmentedRow
        api={api}
        path={['history', 'persistence']}
        label="Command history"
        helper="Whether Codex writes its own history file to disk. ClaudeUI's transcripts are separate."
        defaultValue="save-all"
        options={[
          { value: 'save-all', label: 'Save all' },
          { value: 'none', label: 'None' }
        ]}
      />
      {/* `codex app-server` turns analytics on by default ONLY when started with
          `--analytics-default-enabled` (`cli/src/main.rs`); ClaudeUI spawns it
          without that flag (`CodexAppServerClient`), so with the key absent
          analytics are OFF under ClaudeUI. */}
      <BoolRow
        api={api}
        path={['analytics', 'enabled']}
        label="Analytics"
        helper="Codex's own product analytics. Off under ClaudeUI unless turned on here."
        defaultOn={false}
      />
      <BoolRow
        api={api}
        path={['feedback', 'enabled']}
        label="Feedback"
        helper="Codex's own in-product feedback flow."
        defaultOn
      />
      <NumberRow
        api={api}
        path={['thread_unload_delay_secs']}
        label="Unload idle threads after"
        helper="How long an idle thread stays loaded. Takes effect when the Codex server next starts."
        placeholder="60"
        unit="s"
      />
    </PaneShell>
  )
}

// ── Managed ──────────────────────────────────────────────────────────────────

export function CodexManagedSection(): React.JSX.Element {
  const api = useCodexConfig()
  const rules = api.rules
  return (
    <PaneShell testid="CodexManagedSection" api={api}>
      <ManagedRow
        configKey="model_provider"
        label="Model provider"
        why="ClaudeUI runs Codex against native OpenAI only; another provider would leave the catalog and the account it vends unrelatable."
        value="openai"
        locked="Forced"
      />
      <ManagedRow
        configKey="check_for_update_on_startup"
        label="Self-update check"
        why="The Codex binary is vendored and pinned, so an update check could only offer one ClaudeUI would not run."
        value="false"
        locked="Forced off"
      />
      <ManagedRow
        configKey="approval_policy"
        label="Approval policy"
        why="Set per session from ClaudeUI's permission mode (ADR-067), not from this file."
        value={String(api.effective(['approval_policy']) ?? 'per session')}
        locked="Per session"
      />
      <ManagedRow
        configKey="sandbox_mode"
        label="Sandbox mode"
        why="Set per session from ClaudeUI's permission mode (ADR-067)."
        value={String(api.effective(['sandbox_mode']) ?? 'per session')}
        locked="Per session"
      />
      <ManagedRow
        configKey="approvals_reviewer"
        label="Approvals reviewer"
        why="Who answers an approval — you, or Codex's own guardian — follows the session's mode (ADR-067)."
        value={String(api.effective(['approvals_reviewer']) ?? 'per session')}
        locked="Per session"
      />
      {api.snapshot?.profile && (
        <ManagedRow
          configKey="profile"
          label="Active profile"
          why="A profile layer sits above your config.toml and overrides the rows on this page. ClaudeUI never writes it."
          value={api.snapshot.profile}
          locked="Read-only"
        />
      )}
      <SettingRow
        testid={`${PANE}.row`}
        dataId="rules"
        label="Compiled Bash rules"
        description={
          rules
            ? `${rules.rules} rule${rules.rules === 1 ? '' : 's'} compiled from your Claude permission rules${rules.skipped > 0 ? `, ${rules.skipped} skipped` : ''}. ${
                rules.syncedAt
                  ? `Last written ${new Date(rules.syncedAt).toLocaleString()}.`
                  : 'Not written yet.'
              }${rules.upToDate ? '' : ' The file on disk is out of date.'}`
            : 'Compiled from your Claude permission rules.'
        }
        keyText={rules?.path || 'rules/claudeui.rules'}
      >
        <Button variant="tinted" testid={`${PANE}.recompileRules`} onClick={api.recompileRules}>
          Recompile
        </Button>
      </SettingRow>
    </PaneShell>
  )
}

// ── Raw config ───────────────────────────────────────────────────────────────

/**
 * READ-ONLY, and the kickoff asked to say which and why.
 *
 * The pi Raw pane is a text editor because pi's file is JSON and ClaudeUI writes
 * it verbatim. Codex's file is TOML, and the two rules in force here make an
 * editor unsafe rather than merely awkward:
 *
 *  1. ClaudeUI must not parse or emit TOML (ADR-068 §6), so the only thing it
 *     could offer to edit is the JSON PROJECTION `config/read` hands back;
 *  2. `batchWrite` has no whole-file form — probe (a): it edits per key path.
 *     Writing an edited projection back would mean diffing top-level keys and
 *     replacing each changed TABLE wholesale, which silently reformats and
 *     strips the comments inside every table the user touched.
 *
 * The kickoff's own fallback therefore applies: a read-only view with the file
 * path. The keys that live only here — hooks, plugins, marketplaces, skills,
 * otel, notify, model_providers, profiles, projects, mcp_oauth_*, apps — are
 * edited in `config.toml` itself, and this view is how the user reads what is
 * there without leaving Settings. Making it writable needs a TOML-aware editor
 * or a whole-file write verb, and is a decision, not an oversight.
 */
export function CodexRawConfigSection(): React.JSX.Element {
  const api = useCodexConfig()
  const text = api.snapshot ? JSON.stringify(api.snapshot.user, null, 2) : ''
  return (
    <PaneShell testid="CodexRawConfigSection" api={api}>
      <SettingRow
        testid={`${PANE}.row`}
        dataId="rawText"
        layout="stacked"
        label="config.toml"
        description="Everything you have set, as Codex parses it. Read-only: ClaudeUI writes one key at a time through Codex's own writer and never re-emits your TOML, so keys without a row above are edited in the file itself."
        keyText={api.snapshot?.file || 'config.toml'}
      >
        <textarea
          data-testid={`${PANE}.rawText`}
          value={text}
          rows={18}
          readOnly
          spellCheck={false}
          className="w-full bg-bg-input border border-border rounded-md px-2.5 py-1.5 font-mono text-[12px] text-text-secondary outline-none resize-y"
        />
      </SettingRow>
    </PaneShell>
  )
}
