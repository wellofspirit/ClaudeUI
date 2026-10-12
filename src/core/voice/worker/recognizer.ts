/**
 * The recognizer the voice worker decodes with — ADR-101 §1, local-voice-spec C3.
 *
 * {@link Recognizer} is the seam: the protocol server (`server.ts`) takes one and
 * never learns what is behind it, so its tests run against a fake that needs no
 * model, no addon and no network. {@link loadSherpaRecognizer} is the real one,
 * Parakeet TDT 0.6B v2 int8 on sherpa-onnx's CPU provider with the model config
 * the spike and the bake-off measured.
 *
 * ## Loading the addon
 *
 * `sherpa-onnx-node` is not a dependency of ClaudeUI and never will be: the speech
 * pack downloads it into `~/.claude/ui/voice/` (ADR-101 §5), so it is required at
 * runtime from an ABSOLUTE directory. That has to survive two bundlers — the
 * electron-vite main build (CJS output) and `bun build` (ESM-shaped, `--compile`
 * too) — which disagree about `require`, `__filename` and `import.meta.url`. So
 * it uses none of them: `createRequire` from `node:module` (a builtin both leave
 * alone) anchored at a file INSIDE the addon directory. The anchor is only a
 * resolution base; nothing reads it, and an absolute specifier ignores it anyway.
 * Electron run as Node, Node and bun all load the addon this way
 * (spike, ADR-101 Context).
 *
 * What is required is the package's MAIN FILE, not its directory: a
 * `bun build --compile` executable (the headless server's launcher) cannot
 * resolve a directory specifier — "Cannot find module '<dir>'" — though it
 * loads the same package by file. Electron and Node accept either, so the file
 * is the form that works everywhere ({@link addonEntry}).
 *
 * ## Buffers
 *
 * Electron's V8 sandbox forbids external buffers, so the worker hands sherpa only
 * `Float32Array`s it allocated itself. The calls used here (`acceptWaveform`,
 * `decodeAsync`, `getResult`) take no `enableExternalBuffer` option and return
 * JSON strings, so there is nothing to switch off; the rule is that this module
 * must not start using an API that does (`readWave`, VAD) without passing `false`.
 */

import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Word } from './preview'

export const SAMPLE_RATE = 16_000

/** What the protocol server needs from a speech recognizer. */
export interface Recognizer {
  /**
   * Decode one utterance of 16 kHz mono samples in [-1, 1]. Word times are in
   * seconds from the start of `samples`. Calls may overlap; the SERVER serializes
   * them (one recognizer, many connections), so an implementation need not.
   */
  decode(samples: Float32Array): Promise<{ text: string; words: Word[] }>
}

/**
 * Turn sherpa's per-token result into words. A token that starts with a space
 * starts a new word; the others continue the word before them. `durations` is
 * what makes a word's END known (the preview's guard depends on it); a result
 * without it ends each token where it starts.
 */
export function wordsFromTokens(
  tokens: readonly string[],
  timestamps: readonly number[],
  durations?: readonly number[]
): Word[] {
  const words: Word[] = []
  // A bare-space token starts nothing itself but still ends the word before it.
  let startNew = true
  tokens.forEach((token, i) => {
    const start = timestamps[i] ?? 0
    const end = start + (durations?.[i] ?? 0)
    if (token.startsWith(' ')) startNew = true
    const text = token.trim()
    if (!text) return
    const last = words[words.length - 1]
    if (startNew || !last) words.push({ word: text, start, end })
    else {
      last.word += text
      last.end = end
    }
    startNew = false
  })
  return words
}

// The slice of sherpa-onnx-node's API this module touches (its own types.js is
// untyped JSDoc and the package is not installed here).
interface SherpaStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
}
interface SherpaResult {
  text: string
  tokens: string[]
  timestamps: number[]
  durations?: number[]
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decodeAsync(stream: SherpaStream): Promise<unknown>
  getResult(stream: SherpaStream): SherpaResult
}
interface SherpaModule {
  OfflineRecognizer: { createAsync(config: unknown): Promise<SherpaRecognizer> }
}

/**
 * The file `require(addonDir)` would load: the package.json `main`, else
 * `index.js`, as an absolute path, and always inside `addonDir`. Resolved by
 * hand because the directory form fails inside a compiled bun executable (see
 * the module header).
 */
export function addonEntry(addonDir: string): string {
  let main = 'index.js'
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(addonDir, 'package.json'), 'utf-8')) as {
      main?: unknown
    }
    if (typeof manifest.main === 'string' && manifest.main !== '') main = manifest.main
  } catch {
    /* no readable manifest: the default entry, and the loader names what is missing */
  }
  const entry = path.resolve(addonDir, main)
  // The manifest is data from a downloaded package: a `main` that climbs out of
  // the addon directory is not an entry of it.
  const inside = path.relative(path.resolve(addonDir), entry)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
    return path.join(addonDir, 'index.js')
  }
  return entry
}

/**
 * Load `sherpa-onnx-node` from `addonDir` and the Parakeet model from `modelDir`.
 * Slow (seconds) and memory-hungry (~0.8 GB resident); the worker calls it once.
 * Rejects with the loader's own error, which names the missing library.
 */
export async function loadSherpaRecognizer(
  addonDir: string,
  modelDir: string,
  threads: number
): Promise<Recognizer> {
  const addon = path.resolve(addonDir)
  const sherpa = createRequire(path.join(addon, 'package.json'))(addonEntry(addon)) as SherpaModule
  const file = (name: string): string => path.join(modelDir, name)

  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: file('encoder.int8.onnx'),
        decoder: file('decoder.int8.onnx'),
        joiner: file('joiner.int8.onnx')
      },
      tokens: file('tokens.txt'),
      numThreads: threads,
      modelType: 'nemo_transducer',
      provider: 'cpu'
    },
    decodingMethod: 'greedy_search'
  })

  return {
    async decode(samples) {
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      await recognizer.decodeAsync(stream)
      const result = recognizer.getResult(stream)
      return {
        text: result.text.trim(),
        words: wordsFromTokens(result.tokens, result.timestamps, result.durations)
      }
    }
  }
}
