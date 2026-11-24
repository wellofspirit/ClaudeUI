import type { InstallMarker, InstallMarkerPlatform } from '../src/shared/install-marker'

export function installMarkerFor(
  packagedPath: string,
  platform: InstallMarkerPlatform
): InstallMarker
export function writeInstallMarker(packagedPath: string, platform: InstallMarkerPlatform): string
