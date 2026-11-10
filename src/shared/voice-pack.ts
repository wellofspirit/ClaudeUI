/**
 * The speech pack's pins — ADR-101 §5. One manifest, no logic beyond the host
 * lookup, so a sherpa-onnx or model bump is an edit here and nowhere else.
 *
 * The pack is what makes voice work for opencode and pi sessions: the
 * `sherpa-onnx-node` addon (plus its per-platform native package) and the four
 * Parakeet TDT 0.6B v2 int8 model files. Nothing here is bundled with the app;
 * the installer downloads it into `~/.claude/ui/voice/` and verifies every byte
 * against these digests:
 *
 *  - npm tarballs by `sha512` integrity (the registry's own `dist.integrity`);
 *  - model files by `sha256` and size, at a pinned Hugging Face revision (a
 *    branch name would let the model change under a verified digest).
 *
 * Kept in `shared/` because the UI quotes the label and the size, and the core
 * installer and resolver read the pins; neither side owns them.
 */

export const VOICE_PACK = {
  id: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2 (English)',
  runtime: {
    version: '1.13.8',
    wrapper: {
      package: 'sherpa-onnx-node',
      tarball: 'https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.8.tgz',
      integrity:
        'sha512-MsDMBdhLFTZ1GwvcGSSQhnS7g/EA8OMH6IYysCVUOM7j8Icty9KRc0E6YT1A5fWBsZwRfKOeh88QC95aRvS8ag=='
    },
    platforms: {
      'win32-x64': {
        package: 'sherpa-onnx-win-x64',
        tarball: 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-1.13.8.tgz',
        integrity:
          'sha512-oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g=='
      },
      'darwin-arm64': {
        package: 'sherpa-onnx-darwin-arm64',
        tarball:
          'https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-1.13.8.tgz',
        integrity:
          'sha512-FPNgJMgnWVl/KhRTIhG3KL3A4Om63Rn4YKXc9/uHY7SzLcvqLJLc/h7UBWJwduXvv7K18t5NpxHR6XgXn4sjWw=='
      },
      'darwin-x64': {
        package: 'sherpa-onnx-darwin-x64',
        tarball:
          'https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-1.13.8.tgz',
        integrity:
          'sha512-7BLRpjM6w4f9W46/nmkmq8lEKUayhebvcpslCVQ+6QN2uReYlZEMDZlSpXMjme+hUFrPfRz8P3UNq8ep/4d19g=='
      },
      'linux-x64': {
        package: 'sherpa-onnx-linux-x64',
        tarball:
          'https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.8.tgz',
        integrity:
          'sha512-6plnhjagsSeTntCgnlag86hWbs/uZE9Crms1LgOb68/1nKsIQjMd+WG519m+aPwT6TrsBOiEMzrx41t8sL5L5g=='
      },
      'linux-arm64': {
        package: 'sherpa-onnx-linux-arm64',
        tarball:
          'https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-1.13.8.tgz',
        integrity:
          'sha512-Tlg7a70b/Wge3OF8IgTHF9jhSVCsLyKQKhwc4BsJ5A+dL/SrFtGBjzuHp4XeLhiiOT7afCxX5PdSn/D4c8Lnuw=='
      }
    }
  },
  model: {
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    revision: '1ab9323565ddb038682214b292f588070a538ce2',
    files: [
      {
        name: 'encoder.int8.onnx',
        size: 652184296,
        sha256: 'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab'
      },
      {
        name: 'decoder.int8.onnx',
        size: 7257753,
        sha256: 'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e'
      },
      {
        name: 'joiner.int8.onnx',
        size: 1739080,
        sha256: '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2'
      },
      {
        name: 'tokens.txt',
        size: 9384,
        sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d'
      }
    ]
  }
} as const

/** `<platform>-<arch>` keys the pack ships a native runtime for. */
export type VoicePackPlatformKey = keyof typeof VOICE_PACK.runtime.platforms

/** The download's size for UI copy ("~700 MB"); the exact figure is the sum of the files. */
export const VOICE_PACK_APPROX_BYTES = 700_000_000

/**
 * The manifest key for this host, or null where the pack has no runtime
 * (ADR-101 §8: `capabilities.voice` is false there). Defaults are the running
 * process; the parameters exist so tests and a remote host's description can ask
 * about another one.
 */
export function voicePackPlatformKey(
  platform: string = process.platform,
  arch: string = process.arch
): VoicePackPlatformKey | null {
  const key = `${platform}-${arch}`
  return Object.prototype.hasOwnProperty.call(VOICE_PACK.runtime.platforms, key)
    ? (key as VoicePackPlatformKey)
    : null
}

/**
 * Why voice input is unavailable on a host with no speech runtime (ADR-101 §8) —
 * the one wording for the refusal at the gate and the error from the worker host.
 */
export function voicePlatformUnsupportedMessage(
  platform: string = process.platform,
  arch: string = process.arch
): string {
  return `On-device voice input is not available on this host (${platform}-${arch})`
}

/** A model file's download URL at the pinned revision. */
export function voicePackModelUrl(name: string): string {
  return `https://huggingface.co/${VOICE_PACK.model.repo}/resolve/${VOICE_PACK.model.revision}/${name}`
}

// ---------------------------------------------------------------------------
// Pack status, commands and events (docs/architecture/local-voice.md C6)
// ---------------------------------------------------------------------------

/**
 * Where the speech pack stands on this host. `unsupported` is a host with no
 * speech runtime (nothing to install); `failed` is the last install's error,
 * kept until the next install or removal so a client that connects afterwards
 * still sees why there is no pack.
 */
export type VoicePackState = 'unsupported' | 'missing' | 'installing' | 'ready' | 'failed'

export interface VoicePackStatus {
  state: VoicePackState
  packId: string
  label: string
  /** The download's size for UI copy. */
  approxBytes: number
  /** `installing` only. `totalBytes` can grow once, when a runtime tarball's size becomes known. */
  progress?: { receivedBytes: number; totalBytes: number }
  /** `failed` only. */
  error?: string
}

/** `voice:pack-install`. No `ok` key: the transports' `unwrap` would take it for their envelope. */
export interface VoicePackInstallResult {
  status: 'installed' | 'satisfied' | 'cancelled' | 'failed'
  /** `failed` only: why. */
  message?: string
}

export interface VoicePackInstallCancelResult {
  status: 'cancelled' | 'not-running'
}

export interface VoicePackRemoveResult {
  status: 'removed' | 'not-installed'
}
