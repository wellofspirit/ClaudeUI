#!/usr/bin/env node
// Spawn the given Bun binary with argv0 set to "rg" — this is how cli.js
// dispatches into its embedded ripgrep. If the binary responds with
// ripgrep-style output, the embedded ripgrep path is intact.

import { spawn } from 'node:child_process'

const exe = process.argv[2]
if (!exe) {
  console.error('usage: test-rg-argv0.mjs <path-to-claude.exe> [rg-args...]')
  process.exit(1)
}
const rgArgs = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['--version']

const child = spawn(exe, rgArgs, {
  argv0: 'rg',
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
let err = ''
child.stdout.on('data', (c) => (out += c))
child.stderr.on('data', (c) => (err += c))
child.on('close', (code) => {
  console.log(`exit=${code}`)
  console.log('--- stdout ---')
  console.log(out)
  if (err) {
    console.log('--- stderr ---')
    console.log(err)
  }
})
