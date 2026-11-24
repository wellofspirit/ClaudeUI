import type { UpdateManifest } from '../../src/shared/update-manifest'

export function keyIdFor(spkiBase64: string): string
export function buildManifest(opts: {
  dir: string
  version: string
  channel: string
  claudeCodeVersion: string
  publishedAt: string
}): Promise<UpdateManifest>
export function signBytes(bytes: Buffer, privateKeyPem: string): string
export function verifyPinned(
  bytes: Buffer,
  sigBase64: string,
  keys?: readonly { id: string; spki: string }[]
): string | null
export function writeSignedManifest(opts: {
  dir: string
  version: string
  channel: string
  outDir: string
  signingKey: string | undefined
  keys?: readonly { id: string; spki: string }[]
  now?: Date
}): Promise<boolean>
