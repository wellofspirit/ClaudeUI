/**
 * The unified provider READ MODEL (ADR-065 § "Providers: one list").
 *
 * Settings v2 collapses the three provider surfaces — the shared vault
 * (`shared-provider:*`), opencode's catalog + `auth.json`
 * (`session:get-opencode-providers`), and pi's `auth.json` keys
 * (`vendor-auth:*`) — into ONE list. `ProviderEntry` is what that list renders:
 * one row per provider IDENTITY, whatever store backs it.
 *
 * It is a read model and nothing else. Every mutation the Manage/Add sheets
 * perform routes to an EXISTING writer (`shared-provider:set-route`,
 * `session:set-opencode-provider-disabled`, `vendor-auth:set-key`, …); this file
 * introduces no new write surface and no new persistence.
 *
 * Lives beside `shared-provider.ts` rather than inside it because the two are
 * opposite directions: that file is the shared-provider DEFINITION (what is
 * written to `~/.claude/ui/providers/*.json`), this one is a derived projection
 * over three stores that is never persisted.
 */

import type { SharedProviderRouteDiagnosis } from './shared-provider'
import type { EngineId } from './types'

/** Which store the row's identity comes from. Decides the actions the sheet offers. */
export type ProviderOrigin = 'anthropic' | 'shared' | 'opencode-native' | 'pi-native'

/**
 * The credential badge on the row.
 *
 * - `signed-in` — the native Claude account (Anthropic only).
 * - `connected`  — an OAuth/subscription credential (ChatGPT, pi's Codex entry).
 * - `api-key`    — a key ClaudeUI can see in a store it reads.
 * - `free`       — needs no credential at all (opencode's bundled zen gateway).
 * - `custom`     — configured OUTSIDE ClaudeUI's stores: opencode reports the
 *                  provider as usable but no `auth.json` entry backs it, so the
 *                  key comes from an env var or another config file.
 * - `none`       — nothing configured.
 */
export type ProviderCredential = 'signed-in' | 'connected' | 'api-key' | 'free' | 'custom' | 'none'

/** What one engine's chip on the row says. */
export interface ProviderEngineFacts {
  /** The provider currently reaches this engine's picker. */
  enabled: boolean
  /**
   * Models this provider surfaces to the engine, as far as the source can tell.
   * See `buildProviderRegistry` for the per-origin derivation — absent when no
   * source can answer (a pi row with no ClaudeUI allowlist, for instance).
   */
  modelCount?: number
  /** A ClaudeUI model allowlist restricts what this provider shows in the picker. */
  curated?: boolean
  /** The engine's OWN store holds an entry for this provider (not only ClaudeUI's). */
  native?: boolean
}

export interface ProviderEntry {
  /** `'anthropic'` | shared definition id | `opencode:<catalogId>` | `pi:<vendorId>`. */
  id: string
  name: string
  origin: ProviderOrigin
  credential: ProviderCredential
  engines: Partial<Record<EngineId, ProviderEngineFacts>>
  /** One line under the name, e.g. `"2 of 300 models shown in the picker"`. */
  detail?: string
  /** Why an enabled, credentialed shared route surfaces zero models. */
  diagnosis?: SharedProviderRouteDiagnosis
}

export interface ProviderRegistrySnapshot {
  entries: ProviderEntry[]
  /**
   * False only when the opencode BINARY is absent — the one degraded case
   * (owner ruling, 2026-09-08). A stopped server is not degraded: catalog
   * discovery acquires one itself. False means no opencode-native rows and no
   * catalog section in the Add sheet.
   */
  opencodeInstalled: boolean
}
