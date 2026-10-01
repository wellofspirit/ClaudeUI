/**
 * Can ClaudeUI install its own copy of a harness on this host (ADR-082 §4, §8)?
 *
 *   opencode  the manifest has a package for the host's platform key
 *             (`opencodePlatformKey`: Windows on arm64 runs the x64 build);
 *   pi        the manifest has a release asset for the host's platform key
 *             (`piPlatformKey`);
 *   Codex     the host has reviewed digests (`codexHostSupported`);
 *   Claude Code never: it is bundled, not downloaded.
 *
 * The one answer the state snapshot (`HarnessStateEntry.installable`), the
 * upgrade sheet's candidates and `scripts/ensure-harness.mjs` share. No
 * filesystem or network work.
 */
import type { HarnessId } from '../../shared/harness-types'
import { opencodePlatformKey, piPlatformKey } from './install/sources'
import { harnessManifest } from './manifests'
import { codexHostSupported } from './resolve'

function manifestHas(id: HarnessId, key: string | null): boolean {
  return key !== null && Object.hasOwn(harnessManifest(id).platforms, key)
}

export function harnessInstallable(
  id: HarnessId,
  platform: string = process.platform,
  arch: string = process.arch
): boolean {
  switch (id) {
    case 'claude':
      return false
    case 'codex':
      return codexHostSupported(platform, arch)
    case 'opencode':
      return manifestHas(id, opencodePlatformKey(platform, arch))
    case 'pi':
      return manifestHas(id, piPlatformKey(platform, arch))
  }
}
