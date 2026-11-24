import type { InstallMarker, InstallMarkerPlatform } from '../src/shared/install-marker'

export interface BuildIdentity {
  version: string
  buildId?: string
}

export function buildIdentity(buildInfoFile: string): BuildIdentity
export function installMarkerFor(
  packagedPath: string,
  platform: InstallMarkerPlatform,
  identity: BuildIdentity
): InstallMarker
export function writeInstallMarker(
  packagedPath: string,
  platform: InstallMarkerPlatform,
  buildInfoFile?: string
): string
