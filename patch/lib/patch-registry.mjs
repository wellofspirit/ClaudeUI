/**
 * The cli.js patch registry, and how a build records which patches it carries.
 *
 * `patch/apply-all.mjs` runs `PATCH_REGISTRY` in order. Afterwards it asks
 * `patchesPresent()` which patches the patched `cli.js` actually contains and
 * merges that list into `vendor/claude-cli/version.json` as `patches`. The app
 * reads it back (`src/core/sdk/harness.ts`) to decide which patch-dependent
 * surfaces to offer (ADR-030).
 *
 * The list comes from the bytes, not from the registry: a patch whose apply
 * script found nothing to do (its fix is upstream now) leaves no marker and is
 * not listed. Every apply script tags each injection with a
 * `/*PATCHED:<marker>*\/` comment; `marker` below matches the family of those
 * comments that one patch writes.
 *
 * This module has no side effects on import, so vitest can load it
 * (src/main/__tests__/patch-registry.test.ts).
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const applyScript = (name) => fileURLToPath(new URL(`../${name}/apply.mjs`, import.meta.url))

/** `/*PATCHED:<one of the names>*\/`, anchored on both comment delimiters. */
const markerRe = (namePattern) => new RegExp(`/\\*PATCHED:(?:${namePattern})\\*/`)

/**
 * Apply order matters: later patches anchor on code earlier ones leave intact.
 *
 * @type {ReadonlyArray<{ name: string, apply: string, marker: RegExp }>}
 */
export const PATCH_REGISTRY = Object.freeze(
  [
    // subagent-A … subagent-G, plus subagent-F2.
    { name: 'subagent-streaming', marker: markerRe('subagent-[A-G]\\d?') },
    { name: 'taskstop-notification', marker: markerRe('taskstop-notification-[AB]') },
    { name: 'queue-control', marker: markerRe('queue-control-(?:dequeue|consumed|drained)') },
    { name: 'mcp-status', marker: markerRe('mcp-status-(?:store-promise|await-refresh)') },
    { name: 'mcp-tool-refresh', marker: markerRe('mcp-tool-refresh-[AB]') },
    { name: 'background-task', marker: markerRe('background-task') },
    { name: 'usage-relay', marker: markerRe('usage-relay') },
    { name: 'request-usage', marker: markerRe('request-usage') },
    { name: 'rate-limit-relay', marker: markerRe('rate-limit-relay') },
    { name: 'incomplete-session-resume-fix', marker: markerRe('incomplete-session-resume-fix') },
    { name: 'voice-server', marker: markerRe('voice-server') },
    { name: 'bash-output-streaming', marker: markerRe('bash-output-streaming|bash-early-poll') },
    { name: 'subprocess-proxy-strip', marker: markerRe('subprocess-proxy-strip') },
    { name: 'skip-securestorage', marker: markerRe('skip-securestorage') }
    // ci-path-remap retired: cli.js now runs inside a rebundled Bun binary,
    // which resolves baked file:// URLs natively via its module graph. The
    // Node-compatibility shim is no longer needed.
  ].map((entry) => Object.freeze({ ...entry, apply: applyScript(entry.name) }))
)

/**
 * Names of the registry entries whose marker occurs in `src`, in registry order.
 *
 * `String.prototype.search` ignores `lastIndex`, so a marker built with the `g`
 * flag cannot make the answer depend on an earlier call.
 *
 * @param {string} src the patched cli.js text
 * @param {ReadonlyArray<{ name: string, marker: RegExp }>} [registry]
 * @returns {string[]}
 */
export function patchesPresent(src, registry = PATCH_REGISTRY) {
  return registry.filter((entry) => src.search(entry.marker) !== -1).map((entry) => entry.name)
}

/**
 * Merge `fields` into the JSON object at `versionPath`, keeping every other
 * field. The file is replaced by a rename, so a reader never sees half a file.
 *
 * Throws when the file is missing or is not a JSON object: `extract-cli.mjs`
 * writes it before any patch runs, and a build without it would ship a binary
 * the app cannot describe.
 *
 * @param {string} versionPath
 * @param {Record<string, unknown>} fields
 */
export function mergeIntoVersionJson(versionPath, fields) {
  const meta = JSON.parse(readFileSync(versionPath, 'utf8'))
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new Error(`${versionPath} does not hold a JSON object`)
  }
  const tmp = `${versionPath}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ ...meta, ...fields }, null, 2) + '\n')
    renameSync(tmp, versionPath)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
