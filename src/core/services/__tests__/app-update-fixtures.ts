/**
 * Fixtures for the app-update specs: an Ed25519 key pair made per run, signed
 * manifests, and GitHub release-list entries. Nothing here touches the network.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import {
  UPDATE_MANIFEST_FILE,
  UPDATE_MANIFEST_SIG_FILE,
  serializeManifest,
  type UpdateManifest,
  type UpdateTarget
} from '../../../shared/update-manifest'
import type { PinnedKey } from '../app-update-feed'

export const TARGET: UpdateTarget = 'desktop-darwin-arm64'

export interface TestKey {
  key: PinnedKey
  privateKey: KeyObject
}

export function makeKey(id = 'test-key'): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  return { key: { id, spki }, privateKey }
}

export const sha256 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex')

export const assetName = (version: string): string => `ClaudeUI-${version}-mac-arm64.zip`

export const downloadUrl = (version: string, name: string): string =>
  `https://github.com/wellofspirit/ClaudeUI/releases/download/v${version}/${name}`

/** The archive a release ships for {@link TARGET}. */
export const archiveFor = (version: string): Buffer =>
  Buffer.from(`pretend zip of ClaudeUI ${version} `.repeat(64))

export function manifestFor(
  version: string,
  patch: Partial<UpdateManifest> = {},
  archive: Buffer = archiveFor(version)
): UpdateManifest {
  return {
    schema: 1,
    version,
    tag: `v${version}`,
    channel: version.includes('-') ? 'pre-release' : 'stable',
    publishedAt: '2026-11-20T10:00:00.000Z',
    claudeCodeVersion: '2.1.341',
    assets: {
      [TARGET]: { name: assetName(version), size: archive.length, sha256: sha256(archive) }
    },
    ...patch
  }
}

/** `bytes` and their base64 signature, as the release step writes them. */
export function signedBytes(
  manifestBytes: Buffer,
  key: TestKey
): { manifestBytes: Buffer; sigText: string } {
  return {
    manifestBytes,
    sigText: sign(null, manifestBytes, key.privateKey).toString('base64') + '\n'
  }
}

export function signed(
  manifest: UpdateManifest,
  key: TestKey
): { manifestBytes: Buffer; sigText: string } {
  return signedBytes(Buffer.from(serializeManifest(manifest), 'utf8'), key)
}

/** One entry of GitHub's release list, as the API answers it. */
export function releaseJson(
  version: string,
  opts: { draft?: boolean; prerelease?: boolean; assets?: string[]; tag?: string } = {}
): Record<string, unknown> {
  const names = opts.assets ?? [UPDATE_MANIFEST_FILE, UPDATE_MANIFEST_SIG_FILE, assetName(version)]
  return {
    tag_name: opts.tag ?? `v${version}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? version.includes('-'),
    html_url: `https://github.com/wellofspirit/ClaudeUI/releases/tag/v${version}`,
    assets: names.map((name) => ({ name, browser_download_url: downloadUrl(version, name) }))
  }
}
