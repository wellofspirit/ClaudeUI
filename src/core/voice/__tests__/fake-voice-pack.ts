/**
 * A tiny stand-in for the speech pack's manifest and for the bytes its URLs
 * serve, so the installer's tests run the real download, extraction, hashing and
 * commit code over a few hundred bytes instead of 700 MB. The manifest is swapped
 * in with `vi.mock('../../../shared/voice-pack', …)` (see `pack-installer.test.ts`);
 * this module is what that factory and the tests share, so the digests the
 * manifest pins are the digests of the bytes the fake fetch serves.
 */
import { gzipSync } from 'node:zlib'
import { sha256, sha512b64, tar, tarEntry } from '../../harness/install/__tests__/fixtures'

export const FAKE_PLATFORM = 'linux-x64'
export const WRAPPER = 'sherpa-onnx-node'
export const PLATFORM_PACKAGE = 'sherpa-onnx-linux-x64'

/** An npm-shaped tarball: everything under `package/`. */
export function fakeTarball(pkg: string, extra: Record<string, string> = {}): Buffer {
  const files: Record<string, string> =
    pkg === WRAPPER
      ? { 'package.json': `{"name":"${pkg}"}`, 'sherpa-onnx.js': '// wrapper' }
      : {
          'package.json': `{"name":"${pkg}"}`,
          'sherpa-onnx.node': 'native-binary',
          'lib.so': 'lib'
        }
  return gzipSync(
    tar([
      tarEntry('package/', '', { type: '5', mode: 0o755 }),
      ...Object.entries({ ...files, ...extra }).map(([name, body]) =>
        tarEntry(`package/${name}`, body)
      )
    ])
  )
}

/** Model files, smallest-first order differing from the manifest's on purpose. */
export const MODEL_BODIES: Record<string, Buffer> = {
  'encoder.int8.onnx': Buffer.from('E'.repeat(300)),
  'decoder.int8.onnx': Buffer.from('D'.repeat(120)),
  'joiner.int8.onnx': Buffer.from('J'.repeat(60)),
  'tokens.txt': Buffer.from('<blk> 0\na 1\n')
}

/** The fake `VOICE_PACK`: the real one with the digests and sizes of the fake bytes. */
export function fakeVoicePack<T extends { runtime: any; model: any }>(actual: T): T {
  const wrapperTgz = fakeTarball(WRAPPER)
  const platformTgz = fakeTarball(PLATFORM_PACKAGE)
  return {
    ...actual,
    runtime: {
      ...actual.runtime,
      wrapper: {
        ...actual.runtime.wrapper,
        integrity: `sha512-${sha512b64(wrapperTgz)}`
      },
      platforms: {
        ...actual.runtime.platforms,
        [FAKE_PLATFORM]: {
          ...actual.runtime.platforms[FAKE_PLATFORM],
          integrity: `sha512-${sha512b64(platformTgz)}`
        }
      }
    },
    model: {
      ...actual.model,
      files: Object.entries(MODEL_BODIES).map(([name, body]) => ({
        name,
        size: body.length,
        sha256: sha256(body)
      }))
    }
  }
}
