/**
 * The model-catalog, opencode-provider and title/commit-message channels — ONE declaration,
 * both transports.
 *
 * The two transports differ in exactly one dependency: how they ask Claude Code for its model
 * list. The desktop's read (`fetchModels` in `session.ipc.ts`: TTL cache, login-status report)
 * also reports login status from the init response; the remote one (`queryClaudeModels`) has no
 * auth side effects. The registrar passes its fetcher in, the way `listEngineModels` takes it.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { query as sdkQuery } from '../sdk'
import { ensureHostTokenFresh } from '../sdk/host-token'
import { getSdkExecutableOpts } from '../services/claude-session'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { assertSafePathSegment } from '../services/path-containment'
import { generateCommitMessage } from '../services/commit-message'
import { logger } from '../services/logger'
import {
  discoverOpencodeProviderCatalog,
  getOpencodeProviderModels
} from '../opencode/model-discovery'
import {
  removeOpencodeProvider,
  setOpencodeProviderDisabled
} from '../opencode/provider-management'
import { opencodeServerManager } from '../opencode/OpencodeServerManager'
import { getPiModelCatalogGroups } from '../pi/model-discovery'
import { decorateSharedProviderClaims } from '../shared-providers/opencode-claims'
import type { EngineModelGroup, ModelInfo, ProviderRemoveKind } from '../../shared/types'
import type { CommandRegistration } from './command-registry'
import { listEngineModels } from './engine-models'
import { judgeModelSupport, judgeRouteResting } from './handlers-core'

/**
 * Ask cli.js to generate a session title for the given conversation text.
 *
 * Delegates to the `generate_session_title` control request (anchor ~12854900
 * in cli.js), which runs the model with cli.js's own sentence-case 3-7 word
 * prompt and returns a JSON-schema validated `{title: string | null}`.
 *
 * `persist:false` — we track our manual regenerations through the custom-title
 * file path; letting cli.js also persist would create two sources of truth.
 */
async function generateTitle(conversationText: string): Promise<string | null> {
  const abort = new AbortController()
  logger.debug('generateTitle', `request: ${conversationText.length} chars`)

  await ensureHostTokenFresh()
  const q = sdkQuery({
    prompt: '',
    options: {
      ...getSdkExecutableOpts(),
      cwd: PERSISTED_SESSIONS_DIR,
      abortController: abort,
      // A control request, then abort: no turn to use a plugin's tools.
      reloadPlugins: false
    }
  })

  try {
    const handle = q as unknown as {
      generateSessionTitle(
        desc: string,
        opts?: { persist?: boolean }
      ): Promise<{ title?: string | null } | unknown>
    }
    const result = await handle.generateSessionTitle(conversationText, { persist: false })
    const title =
      result && typeof result === 'object' && 'title' in result
        ? (result as { title?: string | null }).title
        : null
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (trimmed.length >= 2) {
      logger.debug('generateTitle', `title: ${trimmed}`)
      return trimmed
    }
    logger.debug('generateTitle', 'cli.js returned no usable title')
    return null
  } catch (err) {
    logger.error('generateTitle', 'Failed to generate title', err)
    return null
  } finally {
    abort.abort()
  }
}

export function modelCommands(
  claudeModels: () => Promise<ModelInfo[]>
): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    {
      channel: 'session:get-models',
      capability: 'config',
      kind: 'query',
      handler: async () => claudeModels()
    },
    // Cross-engine model catalog (Claude + opencode + pi, or one engine's share of it) for
    // the model picker. One engine, or all of them concurrently; `listEngineModels` also
    // validates the client's engine id.
    {
      channel: 'session:get-engine-models',
      capability: 'config',
      kind: 'query',
      handler: (engineId?: unknown): Promise<EngineModelGroup[]> =>
        listEngineModels(claudeModels, engineId)
    },
    // Which judge-picker values ClaudeUI can call for the auto-mode judge
    // (ADR-081 §3). Read-only and token-free, so the same class as
    // get-engine-models above.
    {
      channel: 'automode:judge-model-support',
      capability: 'config',
      kind: 'query',
      handler: (engineId: unknown, values: unknown) => judgeModelSupport(engineId, values)
    },
    // When a judge model's route recovers from a rate limit (the process-wide cooldown the
    // judge transport files a 429 under). Read-only and token-free: only a time leaves.
    {
      channel: 'automode:judge-route-resting',
      capability: 'config',
      kind: 'query',
      handler: (engineId: unknown, model: unknown, accountId?: unknown) =>
        judgeRouteResting(engineId, model, accountId)
    },
    // Full opencode provider catalog for the settings provider manager. Returns []
    // when opencode isn't installed or discovery fails (opencode is optional).
    {
      channel: 'session:get-opencode-providers',
      capability: 'config',
      kind: 'query',
      handler: async () => {
        if (!opencodeServerManager.isBinaryAvailable()) return []
        const catalog = await discoverOpencodeProviderCatalog()
        // Decorate with shared-provider ownership HERE rather than inside discovery:
        // shared-providers/index → OpencodeSharedProviderAdapter → model-discovery,
        // so a shared-provider import inside model-discovery would be a cycle. A browser or
        // phone must see the same "vended by a shared provider" warning (and the same
        // refused Remove) as the desktop.
        return decorateSharedProviderClaims(catalog)
      }
    },
    // Enable/disable is a reversible veto (opencode's disabled_providers) and is
    // deliberately NOT the same operation as removal — see provider-management.ts.
    {
      channel: 'session:set-opencode-provider-disabled',
      capability: 'config',
      kind: 'command',
      handler: async (providerId: string, disabled: boolean) => {
        setOpencodeProviderDisabled(providerId, disabled)
      }
    },
    // Deletes the credential and/or the provider declaration ClaudeUI
    // owns. `kind` must come from the entry's resolved actions — widening it here
    // would delete something the UI never warned about. `settings` clears only
    // disabled-list membership/curation, revalidating at the write boundary.
    {
      channel: 'session:remove-opencode-provider',
      capability: 'config',
      kind: 'command',
      handler: async (providerId: string, kind: ProviderRemoveKind) => {
        await removeOpencodeProvider(providerId, kind)
      }
    },
    // All catalog models for one provider (drives the model-allowlist dialog).
    {
      channel: 'session:get-opencode-provider-models',
      capability: 'config',
      kind: 'query',
      handler: async (providerId: string) => {
        if (!opencodeServerManager.isBinaryAvailable()) return []
        return await getOpencodeProviderModels(providerId)
      }
    },
    // Unfiltered authenticated pi catalog for the model-allowlist dialog.
    {
      channel: 'session:get-pi-model-catalog',
      capability: 'config',
      kind: 'query',
      handler: async () => getPiModelCatalogGroups()
    },
    // Title / commit-message generation (throwaway SDK queries).
    {
      channel: 'session:generate-title',
      capability: 'chat',
      kind: 'command',
      handler: async (conversationText: string) => {
        return await generateTitle(conversationText)
      }
    },
    {
      channel: 'session:generate-commit-message',
      capability: 'chat',
      kind: 'command',
      handler: async (diff: string) => {
        return await generateCommitMessage(diff)
      }
    },
    // Persist a custom session title (appends a custom-title JSONL entry).
    {
      channel: 'session:write-custom-title',
      capability: 'config',
      kind: 'command',
      handler: async (sessionId: string, projectKey: string, title: string) => {
        // LOW-RW3: both identifiers are caller-supplied (and reachable by any token-holding
        // remote client) and interpolated straight into a path — a `..`/separator segment
        // would append attacker-controlled JSON to any *.jsonl on disk. Same check as
        // deleteSessionFiles().
        assertSafePathSegment(sessionId, 'sessionId')
        assertSafePathSegment(projectKey, 'projectKey')
        const filePath = path.join(
          os.homedir(),
          '.claude',
          'projects',
          projectKey,
          `${sessionId}.jsonl`
        )
        const entry = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })
        await fs.promises.appendFile(filePath, entry + '\n', { mode: 0o600 })
      }
    }
  ]
}
