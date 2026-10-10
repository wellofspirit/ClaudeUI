#!/usr/bin/env bun
/**
 * `bun run ensure-opencode` / `update-opencode`: install the tested opencode into ClaudeUI's
 * managed store (ADR-082 §8). The work is `./ensure-harness.mjs`, over the
 * app's own installer; see there for the flags.
 */
import { runEnsure } from './ensure-harness.mjs'

await runEnsure('opencode')
