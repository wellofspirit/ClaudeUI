/**
 * Run `fn` as if the process were on `platform`/`arch`, restoring both after.
 *
 * `process.platform` and `process.arch` are plain data properties, so redefining
 * them is enough for code that reads them at call time (`voicePackPlatformKey`).
 * Synchronous on purpose: an async body would leave the override in place across
 * awaits other tests could interleave with.
 */
export function onHostPlatform<T>(platform: string, arch: string, fn: () => T): T {
  const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const savedArch = Object.getOwnPropertyDescriptor(process, 'arch')!
  Object.defineProperty(process, 'platform', { ...savedPlatform, value: platform })
  Object.defineProperty(process, 'arch', { ...savedArch, value: arch })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', savedPlatform)
    Object.defineProperty(process, 'arch', savedArch)
  }
}
