// Write a seeded synthetic Claude Code transcript for the chat-scroll bench
// (scripts/scroll-bench.mjs). The generator lives in scripts/lib/scroll-bench/transcript-gen.mjs;
// this is its CLI.
//
// Usage:
//   node scripts/gen-synthetic-transcript.mjs --messages <n> (--home <dir> | --out <file>)
//        [--seed <n>] [--cwd <path>] [--session-id <uuid>] [--images] [--marker <word>]
//
// --messages <n>     chat messages the app will render (user prompts + assistant API messages)
// --home <dir>       an ISOLATED profile root: writes <dir>/.claude/projects/<key>/<sid>.jsonl,
//                    where <key> is the cwd's project key, so the app launched with that home
//                    lists it in the sidebar. Refuses the real profile.
// --out <file>       write the .jsonl to an explicit path instead
// --cwd <path>       the cwd recorded in the transcript (default: <home>/work/synthetic)
// --images           include occasional image tool results (a generated solid-colour PNG)
// --marker <word>    rare search term planted in text/bash/edits (default: zephyrquartz)
//
// Prints one JSON line: the manifest (counts per tool, marker hits, file path).
// Exit codes: 0 ok, 2 bad arguments.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { generateTranscript } from './lib/scroll-bench/transcript-gen.mjs'

export function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Write a transcript into an isolated home (or an explicit path); returns the manifest. */
export async function writeSyntheticTranscript({
  messages,
  seed = 1,
  home,
  out,
  cwd,
  sessionId = randomUUID(),
  images = false,
  marker
}) {
  const sessionCwd = cwd ?? join(home ?? dirname(out), 'work', 'synthetic')
  mkdirSync(sessionCwd, { recursive: true })
  const file =
    out ?? join(home, '.claude', 'projects', projectKey(sessionCwd), `${sessionId}.jsonl`)
  const { lines, manifest } = await generateTranscript({
    messages,
    seed,
    cwd: sessionCwd,
    sessionId,
    images,
    marker
  })
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, lines.join('\n') + '\n')
  return { ...manifest, file, projectKey: projectKey(sessionCwd) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
  }
  const messages = Number(arg('messages', ''))
  const home = arg('home', undefined)
  const out = arg('out', undefined)
  const errors = []
  if (!Number.isInteger(messages) || messages < 2) errors.push('--messages must be an integer >= 2')
  if (!home && !out) errors.push('one of --home or --out is required')
  if (home) {
    const rel = relative(resolve(home), resolve(homedir()))
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
      errors.push('--home must not be the real profile or an ancestor of it')
  }
  if (errors.length) {
    for (const e of errors) console.error(`ERROR ${e}`)
    process.exit(2)
  }
  const manifest = await writeSyntheticTranscript({
    messages,
    seed: Number(arg('seed', '1')),
    home: home && resolve(home),
    out: out && resolve(out),
    cwd: arg('cwd', undefined),
    sessionId: arg('session-id', undefined),
    images: argv.includes('--images'),
    marker: arg('marker', undefined)
  })
  console.log(JSON.stringify(manifest))
}
