/**
 * pi-models-raw.ts
 *
 * Non-lossy reader / leaf-patcher for pi's model catalog file,
 * `~/.pi/agent/models.json` (vendor/pi-cli/docs/models.md). It is the settings
 * twin of `pi-native-raw.ts` — same mechanics, same file-generic core
 * (`pi-json-raw.ts`) — with one thing settings.json does not have: **models.json
 * already has a ClaudeUI writer.**
 *
 * `shared-providers/PiSharedProviderAdapter.ts` PROJECTS every enabled custom
 * shared provider into a `providers.<nativeProviderId>` entry and rewrites the
 * whole file (JSON.stringify, atomic rename) on every sync. Two consequences the
 * panes on top of this module have to live with:
 *
 *  - **Projected entries are not editable here.** A raw leaf write into one
 *    would survive exactly until the next `applyDefinition` — and worse, the
 *    adapter compares the entry against its own compiled projection before
 *    touching it, so an out-of-band edit turns the user's next provider save
 *    into a "changed outside ClaudeUI" refusal. {@link patchPiModelsRaw} rejects
 *    those paths outright, and {@link readPiModelsRaw} hands the UI the same id
 *    set so it can say WHY a row is read-only rather than failing on save.
 *  - **The rest of the file is fair game**, including the documented
 *    `modelOverrides` mechanism under pi's own built-in provider ids (models.md
 *    "Per-model Overrides" — e.g. `providers.openai.modelOverrides.gpt-5.6-sol.
 *    contextWindow`). Only WHOLE-ENTRY creation at a built-in id is refused: that
 *    replaces pi's built-in provider definition wholesale, which is the shape the
 *    shared-provider layer already rejects as a collision (M-AT4).
 *
 * Comment/format preservation is why this is a jsonc leaf patcher rather than a
 * read-modify-write of the parsed object: the adapter reserialises the file when
 * IT writes, but nothing ClaudeUI does should reformat a hand-written models.json
 * as a side effect of one capability edit.
 */

import { join } from 'node:path'
import { piAgentDir } from '../services/pi-session-list'
import { invalidatePiModelCache } from './model-discovery'
import { patchPiJsonRaw, readPiJsonRaw } from './pi-json-raw'
import { PI_NATIVE_VENDOR_IDS } from '../auth/pi-vendor-ids'
import { managedPiProviderIds } from '../shared-providers/PiSharedProviderAdapter'
import { SharedProviderRepository } from '../shared-providers/SharedProviderRepository'
import type { PiModelsRaw, RawConfigPatch } from '../../shared/types'

/** `~/.pi/agent/models.json` — pi's model catalog file. */
export function piModelsFile(): string {
  return join(piAgentDir(), 'models.json')
}

/** Names models.json in every refusal this module can raise. */
const LABEL = 'pi models'

/**
 * The provider ids the shared-provider projection owns right now.
 *
 * Read from `SharedProviderRepository` — the same store `shared-provider:list`
 * answers from (`SharedProviderService.listDefinitions()` is exactly
 * `repository.list()`). The repository rather than the service singleton because
 * the singleton composes the auth vault, credential sync and model discovery,
 * none of which an ownership question needs; the repository is a directory read.
 *
 * Deliberately NOT wrapped in a try/catch. A failure to determine ownership must
 * not degrade to "nothing is managed" — that would let the guard below wave
 * through the very writes it exists to stop. (The repository already swallows a
 * missing directory and individual malformed files, so the realistic failure
 * modes resolve to a list, not a throw.)
 */
function managedProviderIds(): string[] {
  return managedPiProviderIds(new SharedProviderRepository().list())
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read models.json as its RAW parsed object AND raw text, plus the provider ids
 * the shared-provider projection currently owns. Absent / unreadable /
 * unparseable → `{}` and `''`, and the file is NEVER created by a read.
 */
export function readPiModelsRaw(): PiModelsRaw {
  return { ...readPiJsonRaw(piModelsFile()), managedProviderIds: managedProviderIds() }
}

// ─── Write (leaf patches) ─────────────────────────────────────────────────────

/**
 * Reject any patch the projection or pi's own built-ins own. Runs once per call,
 * after path validation and before the file is read or written, so a rejected
 * set leaves models.json byte-identical.
 */
function assertNotOwnedElsewhere(patches: RawConfigPatch[]): void {
  // `providers.<id>[.…]` is the only shape either rule can apply to, so a set
  // that touches nothing else skips the directory read entirely.
  const providerPatches = patches.filter(
    (patch) => patch.path[0] === 'providers' && patch.path.length >= 2
  )
  if (providerPatches.length === 0) return

  const managed = new Set(managedProviderIds())
  for (const patch of providerPatches) {
    const providerId = String(patch.path[1])
    if (managed.has(providerId)) {
      throw new Error(
        `Refusing to edit pi provider "${providerId}": it is projected from a shared provider. ` +
          'Edit it under Settings › Providers — a raw write here is overwritten on the next sync.'
      )
    }
    // Whole-entry creation ONLY. Leaf writes UNDER a built-in id (the documented
    // `modelOverrides` mechanism, or a provider-level `baseUrl`/`headers`) are
    // exactly what pi's docs tell users to do and must pass.
    const isWrite = 'value' in patch && patch.value !== undefined
    if (isWrite && patch.path.length === 2 && PI_NATIVE_VENDOR_IDS.has(providerId)) {
      throw new Error(
        `Refusing to replace built-in pi provider "${providerId}": choose a different provider id, ` +
          'or override individual models under it (providers.' +
          providerId +
          '.modelOverrides).'
      )
    }
  }
}

/**
 * Apply leaf patches to models.json — see {@link patchPiJsonRaw} for the shared
 * guarantees (validation, delete invariant, BOM/EOL preservation,
 * create-nothing-on-a-no-op, byte-compare write gate) and
 * {@link assertNotOwnedElsewhere} for the two ownership rules on top of them.
 *
 * A patch set that actually changes bytes invalidates the pi model cache, the
 * same way the projection writer does: models.json feeds `get_available_models`,
 * so an edit the picker cannot see until an app restart is an edit that looks
 * broken. A no-op write skips it — nothing changed to re-discover.
 */
export function patchPiModelsRaw(patches: RawConfigPatch[]): void {
  const wrote = patchPiJsonRaw({
    filePath: piModelsFile(),
    label: LABEL,
    patches,
    guard: assertNotOwnedElsewhere
  })
  if (wrote) invalidatePiModelCache()
}
