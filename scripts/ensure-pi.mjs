#!/usr/bin/env bun
/**
 * `bun run ensure-pi` / `update-pi`: install the tested pi into ClaudeUI's
 * managed store (ADR-082 §8). The work is `./ensure-harness.mjs`, over the
 * app's own installer; see there for the flags.
 */
import { runEnsure } from './ensure-harness.mjs'

await runEnsure('pi')
