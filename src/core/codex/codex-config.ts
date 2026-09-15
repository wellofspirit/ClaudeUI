/**
 * Codex's own `config.toml`, read and written through the app-server
 * (ADR-068 §6, Slice 5a).
 *
 * ## The one rule this module exists to keep
 *
 * ClaudeUI never parses, edits or re-emits TOML. Reads go through `config/read`
 * with layers; writes go through ONE `config/batchWrite`, whose writer is
 * `toml_edit`-based inside Codex — which is why a ClaudeUI write keeps the
 * user's comments, key order and every sibling table. The opencode and pi panes
 * get the same property from ClaudeUI's own byte-preserving leaf writers; here
 * it is the engine's writer, and that is strictly better: the file's schema
 * belongs to Codex and only Codex validates it.
 *
 * ## What the real binary answered (probe, `docs/codex-spike.md` §
 * "`config/batchWrite` probe", 0.154.0, 2026-09-14)
 *
 *  · A write names ONE key path at a time; `mergeStrategy: 'replace'` sets it.
 *  · `value: null` REMOVES the key — not refused, not written as a literal
 *    `null`. That is what makes "Reset to default" on the page a real removal,
 *    and what lets `modified` keep meaning "present in the base user layer".
 *  · A stale `expectedVersion` is refused with the camelCase tag
 *    `configVersionConflict` in `error.data.config_write_error_code` (NOT the
 *    Rust variant spelling), and nothing is written.
 *  · A dotted key path addresses a nested table and creates it when absent;
 *    array values round-trip verbatim; removing a nested leaf leaves the
 *    now-empty table behind, so `modified` is computed per LEAF.
 *
 * ## On the active account's host
 *
 * The service is built with `identity: { accountId: null }` — the active vault
 * account — like every other reader (ADR-069 §3). Reading and writing a local
 * config file is not an act of the ChatGPT account, and before the host model
 * this service deliberately carried no identity so that opening the settings page
 * never cost a vault read. That reasoning does not survive the move: the host is
 * ALREADY running and already injected, so asking for the uninjected one would
 * start a SECOND app-server on the home purely to avoid an identity nothing here
 * uses. One host per home is worth more than that, and `config/read` and
 * `config/batchWrite` answer identically either way — they are per-`cwd` file
 * operations with no account in them.
 */

import { homedir } from 'node:os'
import { CodexService } from './CodexService'
import { CodexTransportError } from './CodexAppServerClient'
import { codexBinaryAvailable } from './codex-locate'
import type { ConfigEdit } from './protocol/v2/ConfigEdit'
import type { ConfigLayer } from './protocol/v2/ConfigLayer'
import type { ConfigReadResponse } from './protocol/v2/ConfigReadResponse'
import type { JsonValue } from './protocol/serde_json/JsonValue'
import type {
  CodexConfigEdit,
  CodexConfigSnapshot,
  CodexConfigValue,
  CodexConfigWriteResult
} from '../../shared/codex-types'

/** The native tag `config_write_error_code` carries for a stale version. */
export const CODEX_VERSION_CONFLICT = 'configVersionConflict'

/**
 * How a Codex config read/write client is built. Injected so the unit suite can
 * drive the mapping without a binary; production passes nothing.
 */
export interface CodexConfigDeps {
  service?: () => Pick<CodexService, 'readConfigLayers' | 'batchWriteConfigAndRead' | 'dispose'>
  /** Overridable so a test never has to own a Codex installation. */
  available?: () => boolean
}

function build(deps: CodexConfigDeps): {
  service: Pick<CodexService, 'readConfigLayers' | 'batchWriteConfigAndRead' | 'dispose'>
} {
  const service = deps.service
    ? deps.service()
    : // `cwd: homedir()` deliberately: the page edits the USER layer, so it must
      // not resolve a project `.codex/` layer between a working directory and a
      // repo root — that layer is not ours to write and would change what
      // `effective` shows depending on which session happened to be open.
      new CodexService({ cwd: homedir(), identity: { accountId: null }, label: 'config' })
  return { service }
}

const record = (value: unknown): value is Record<string, CodexConfigValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The BASE user layer: `type: 'user'` with NO profile.
 *
 * A profile-v2 layer is also `type: 'user'` (with `profile` set) and sits at a
 * HIGHER precedence, so picking the first `user` layer would hand the page a
 * layer it must never write. `ConfigLayerSource::precedence` gives 20 to the
 * base and 21 to the profile; the discriminator here is the `profile` field,
 * which is the same distinction without depending on ordering.
 */
function baseUserLayer(response: ConfigReadResponse): ConfigLayer | undefined {
  return (response.layers ?? []).find(
    (layer) => layer.name.type === 'user' && layer.name.profile === null
  )
}

/** The active profile-v2 layer's name, or null. Shown, never written. */
function activeProfile(response: ConfigReadResponse): string | null {
  for (const layer of response.layers ?? []) {
    if (layer.name.type === 'user' && layer.name.profile) return layer.name.profile
  }
  return null
}

/**
 * `config/read` -> the page's snapshot.
 *
 * Shared by the read path and the write path, so a snapshot that comes back with
 * a write is shaped by exactly the same rules — including the base-layer pick,
 * which is the one place a profile layer could be mistaken for the writable
 * file.
 */
function shapeSnapshot(response: ConfigReadResponse): CodexConfigSnapshot {
  const layer = baseUserLayer(response)
  if (!layer || typeof layer.version !== 'string' || layer.name.type !== 'user')
    throw new Error('Codex returned no writable user config layer')
  return {
    version: layer.version,
    file: layer.name.file,
    profile: activeProfile(response),
    // An absent `config.toml` reads back as an empty table, but the layer's
    // `config` is a bare `JsonValue`: a non-object (a corrupted layer) becomes
    // `{}` rather than propagating something the panes would index into.
    user: record(layer.config) ? layer.config : {},
    effective: record(response.config) ? response.config : {},
    origins: Object.fromEntries(
      Object.entries(response.origins ?? {}).flatMap(([key, meta]) =>
        meta ? [[key, { layer: meta.name.type, version: meta.version }] as const] : []
      )
    )
  }
}

/**
 * Read `config.toml` as the settings page sees it.
 *
 * Throws when the binary is missing or the read fails; the command wrapper turns
 * that into the page's "Codex is not installed" state rather than an error
 * dialog, exactly as the pi and opencode panes self-gate.
 */
export async function readCodexConfig(deps: CodexConfigDeps = {}): Promise<CodexConfigSnapshot> {
  if (!(deps.available ?? codexBinaryAvailable)()) throw new Error('Codex is not installed')
  const { service } = build(deps)
  try {
    return shapeSnapshot(await service.readConfigLayers(homedir()))
  } finally {
    if (!deps.service) service.dispose()
  }
}

/**
 * Apply edits to `config.toml` in ONE `batchWrite`, and answer with the snapshot
 * that write produced.
 *
 * `null` in an edit removes the key (probe (c)). `expectedVersion` is the
 * version the caller last READ: a mismatch is answered `version-conflict` and
 * nothing is written, which is the whole point — an edit made in a terminal
 * between the page's read and its write must not be silently discarded.
 *
 * The fresh snapshot rides back on the RESULT rather than being fetched by the
 * caller afterwards: the write and the read that shows it run on ONE app-server
 * child (`batchWriteConfigAndRead`), so a settings click costs one process start
 * instead of two. It also closes a window — between a separate write and a
 * separate read the file could move again, and the page would then be showing a
 * third state nobody asked for.
 *
 * Never throws: every outcome is a result object, because a settings row has to
 * render a failure inline and has nowhere to put an exception.
 */
export async function writeCodexConfig(
  edits: CodexConfigEdit[],
  expectedVersion: string,
  deps: CodexConfigDeps = {}
): Promise<CodexConfigWriteResult> {
  if (edits.length === 0) return { status: 'refused', message: 'No edits' }
  if (!(deps.available ?? codexBinaryAvailable)()) return { status: 'unavailable' }
  const { service } = build(deps)
  try {
    const result = await service.batchWriteConfigAndRead(
      {
        edits: edits.map((edit): ConfigEdit => ({
          keyPath: edit.keyPath,
          // `null` is a legal `JsonValue`, and it is the REMOVAL sentinel the
          // binary already understands; no separate delete verb exists.
          value: edit.value as JsonValue,
          mergeStrategy: 'replace'
        })),
        expectedVersion,
        // Hot-reload what can be hot-reloaded. Session-static keys (model,
        // effort, service tier, personality) are explicitly NOT reloaded by the
        // binary, which is why every group on the page wears the "Next session"
        // badge.
        reloadUserConfig: true
      },
      homedir()
    )
    const snapshot = shapeSnapshot(result.read)
    // The snapshot's version is the authority, not the write response's: the two
    // agree (probe (a)), and taking it from the layer the page is about to show
    // is what keeps the token and the content from ever disagreeing.
    return { status: 'ok', version: snapshot.version, snapshot }
  } catch (error) {
    if (error instanceof CodexTransportError) {
      if (error.nativeCode === CODEX_VERSION_CONFLICT) return { status: 'version-conflict' }
      // A refusal's reason is Codex's to state: an unknown key, an invalid
      // value, a requirements-locked field. Passed through verbatim — these
      // sentences name config fields, never credentials.
      if (error.nativeMessage) return { status: 'refused', message: error.nativeMessage }
    }
    return { status: 'unavailable' }
  } finally {
    if (!deps.service) service.dispose()
  }
}
