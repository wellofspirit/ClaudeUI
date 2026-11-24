/**
 * The media catalog: image and video models for the CONNECTED sources only
 * (ChatGPT signed in; an OpenAI or OpenRouter key present and enabled), and the
 * resolution of a job's model (explicit → setting → Automatic).
 *
 * Credentials are only checked for presence here (`getStatus`, `hasApiKey`): a token or key is read
 * by the provider client at call time. models.dev rows come from `opencode-pricing.ts`'s refresh.
 */
import {
  CHATGPT_PLAN_MODEL_REF,
  resolveMediaGeneration,
  type MediaCatalog,
  type MediaCatalogModel,
  type MediaKind,
  type MediaModelRef,
  type MediaSource
} from '../../shared/media-generation'
import { deliveredDefinition } from '../../shared/shared-provider'
import { authVault } from '../auth/vault/AuthVault'
import { credentialSync } from '../auth/vault/CredentialSync'
import { SharedProviderRepository } from '../shared-providers/SharedProviderRepository'
import { appSetting } from './app-settings'
import { logger } from './logger'
import { getPlanUsage } from './media-providers/plan-usage'
import { getMediaModelRows, type MediaModelRow } from './opencode-pricing'

export interface ResolvedMediaModel {
  ref: MediaModelRef
  source: MediaSource
  /** The provider's own id (ignored for the ChatGPT plan). */
  modelId: string
  /** The card's name for it ("ChatGPT Plan"). */
  label: string
  acceptsImages: boolean
}

type KeyedSource = 'openai' | 'openrouter'
const KEYED_SOURCES: readonly KeyedSource[] = ['openai', 'openrouter']

/** What the catalog reads; the defaults are the real vault, provider files, settings and models.dev rows. */
export interface MediaCatalogDeps {
  /** Signed in and usable: connected, a workspace id, no re-auth pending (as the judge route reads it). */
  chatgptConnected(): Promise<boolean>
  hasApiKey(providerId: KeyedSource): Promise<boolean>
  /** False when the provider is switched off as a shared provider. */
  providerEnabled(providerId: KeyedSource): boolean
  mediaRows(): MediaModelRow[]
  setting(): unknown
}

let repository: SharedProviderRepository | undefined

const defaultDeps: MediaCatalogDeps = {
  chatgptConnected: async () => {
    const status = await credentialSync.getStatus()
    return status.connected && Boolean(status.accountId) && !status.needsReauth
  },
  hasApiKey: (id) => authVault.hasApiKey(id),
  providerEnabled: (id) => {
    try {
      repository ??= new SharedProviderRepository()
      const definition = repository.list().find((d) => d.id === id)
      return !definition || !deliveredDefinition(definition).disabled
    } catch (err) {
      logger.warn('media-catalog', `shared provider read failed: ${err}`)
      return true
    }
  },
  mediaRows: getMediaModelRows,
  setting: () => appSetting('mediaGeneration')
}

function isFree(row: MediaModelRow): boolean {
  if (row.id.endsWith(':free')) return true
  return row.cost?.input === 0 && row.cost?.output === 0
}

/** Newest first: release date, then id for a stable order. */
function newestFirst(a: MediaModelRow, b: MediaModelRow): number {
  return (b.releaseDate ?? '').localeCompare(a.releaseDate ?? '') || a.id.localeCompare(b.id)
}

interface Entry {
  model: MediaCatalogModel
  /** The provider's own id. */
  modelId: string
}

async function build(deps: MediaCatalogDeps): Promise<{ catalog: MediaCatalog; entries: Entry[] }> {
  const connected: Record<MediaSource, boolean> = {
    'chatgpt-plan': false,
    openai: false,
    openrouter: false
  }
  try {
    connected['chatgpt-plan'] = await deps.chatgptConnected()
  } catch (err) {
    logger.warn('media-catalog', `ChatGPT status read failed: ${err}`)
  }
  for (const id of KEYED_SOURCES) {
    try {
      connected[id] = deps.providerEnabled(id) && (await deps.hasApiKey(id))
    } catch (err) {
      logger.warn('media-catalog', `${id} key check failed: ${err}`)
    }
  }

  const entries: Entry[] = []
  if (connected['chatgpt-plan']) {
    entries.push({
      model: {
        ref: CHATGPT_PLAN_MODEL_REF,
        kind: 'image',
        source: 'chatgpt-plan',
        name: 'ChatGPT Plan',
        acceptsImages: true
      },
      modelId: 'gpt-image-2'
    })
  }
  const rows = deps
    .mediaRows()
    // Video is OpenRouter only: OpenAI has no video API this client calls.
    .filter((r) => connected[r.providerId] && (r.type === 'image' || r.providerId === 'openrouter'))
    .sort(newestFirst)
  for (const row of rows) {
    entries.push({
      model: {
        ref: `${row.providerId}/${row.id}`,
        kind: row.type,
        source: row.providerId,
        name: row.name,
        acceptsImages: row.acceptsImages,
        ...(isFree(row) ? { free: true } : {})
      },
      modelId: row.id
    })
  }
  const planUsage = getPlanUsage()
  return {
    catalog: {
      models: entries.map((e) => e.model),
      connected,
      ...(planUsage ? { planUsage } : {})
    },
    entries
  }
}

/** Every selectable model of the connected sources, plus which sources are connected. */
export async function listMediaModels(deps: MediaCatalogDeps = defaultDeps): Promise<MediaCatalog> {
  return (await build(deps)).catalog
}

const NOT_CONNECTED: Record<MediaKind, string> = {
  image:
    'No image model is connected. Sign in to ChatGPT or add an OpenAI or OpenRouter key in Settings.',
  video: 'No video model is connected. Add an OpenRouter key in Settings.'
}

/**
 * The model a job runs on: Off in the setting refuses everything (even an explicit model); else
 * `explicit` (the tool's `model` argument) when given and available, else the setting, else Automatic. `{ error }` names why none fits
 * (nothing connected, the setting is Off, an unknown or unavailable model, no model
 * that takes input images when `needsImages`).
 */
export async function resolveMediaModel(
  kind: MediaKind,
  explicit: MediaModelRef | undefined,
  needsImages: boolean,
  deps: MediaCatalogDeps = defaultDeps
): Promise<ResolvedMediaModel | { error: string }> {
  const { entries } = await build(deps)
  const ofKind = entries.filter((e) => e.model.kind === kind)
  const resolved = (e: Entry): ResolvedMediaModel => ({
    ref: e.model.ref,
    source: e.model.source,
    modelId: e.modelId,
    label: e.model.name,
    acceptsImages: e.model.acceptsImages
  })
  const check = (e: Entry): ResolvedMediaModel | { error: string } =>
    needsImages && !e.model.acceptsImages
      ? {
          error: `${e.model.name} does not take input images; pick another model or drop the images.`
        }
      : resolved(e)

  const settings = resolveMediaGeneration(deps.setting())
  const choice = kind === 'image' ? settings.imageModel : settings.videoModel
  if (choice === 'off') {
    return {
      error: `${kind === 'image' ? 'Image' : 'Video'} generation is turned off in Settings.`
    }
  }
  const wanted = explicit?.trim()
  if (wanted) {
    const hit = ofKind.find((e) => e.model.ref === wanted)
    return hit
      ? check(hit)
      : { error: `Model "${wanted}" is not available for ${kind} generation; leave model unset.` }
  }

  if (choice !== 'auto') {
    const hit = ofKind.find((e) => e.model.ref === choice)
    return hit
      ? check(hit)
      : {
          error: `The ${kind} model chosen in Settings (${choice}) is not connected; connect it or pick another.`
        }
  }

  if (ofKind.length === 0) return { error: NOT_CONNECTED[kind] }
  // Automatic: the ChatGPT plan first (it is listed first), then the newest keyed model.
  const pick = ofKind.find((e) => !needsImages || e.model.acceptsImages)
  return pick ? resolved(pick) : { error: `No connected ${kind} model takes input images.` }
}
