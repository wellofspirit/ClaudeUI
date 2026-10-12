/**
 * The desktop's voice-worker entry — a second electron-vite main entry, built to
 * `out/main/voice-worker.js` beside `index.js` (ADR-101 §4).
 *
 * The host runs it as `process.execPath <this file> --addon … --model …` with
 * `ELECTRON_RUN_AS_NODE=1`, i.e. Electron's own binary acting as plain Node, so
 * the app needs no system Node and ships no native addon. It must therefore
 * never import `electron` (there is no Electron API in that mode) nor anything
 * that does: the whole import graph is the worker (`core/voice/worker/`).
 */
import { runVoiceWorker } from '../core/voice/worker/main'

void runVoiceWorker()
