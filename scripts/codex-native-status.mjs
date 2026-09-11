#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { root, cacheValid, assertPin } from './ensure-codex.mjs'

// CLI status may contain key fragments. Neither captured stream nor errors leave this function.
export function classifyStatus(code, output) {
  const kinds = [
    ['Logged in using ChatGPT', 'chatgpt'],
    ['Logged in using an API key - ', 'apiKey'],
    ['Logged in using access token', 'accessToken'],
    ['Logged in using personal access token', 'personalAccessToken'],
    ['Logged in using workload identity', 'workloadIdentity'],
    ['Logged in using Amazon Bedrock API key', 'amazonBedrock'],
    ['Logged in using Amazon Bedrock AWS access keys', 'amazonBedrock']
  ]
  const lines = output.split(/\r?\n/)
  const match = kinds.find(([prefix]) =>
    lines.some((line) => (prefix.endsWith(' - ') ? line.startsWith(prefix) : line === prefix))
  )
  if (code === 0 && match) return { authenticated: true, authKind: match[1], requiresLogin: false }
  if (code === 1 && lines.includes('Not logged in'))
    return { authenticated: false, authKind: null, requiresLogin: true }
  return { failure: 'native-status-failed' }
}

export async function nativeStatus() {
  try {
    assertPin()
    if (!cacheValid(join(root, 'vendor/codex-cli'))) return { failure: 'binary-unavailable' }
    return await new Promise((resolve) => {
      execFile(
        join(root, 'vendor/codex-cli/codex'),
        ['login', 'status'],
        {
          // Preserve native identity/storage selection. Do not import any shared vault credentials.
          env: process.env,
          timeout: 15_000,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          if (error?.killed || (error && typeof error.code !== 'number')) {
            resolve({ failure: 'native-status-failed' })
          } else resolve(classifyStatus(error?.code ?? 0, stdout + '\n' + stderr))
        }
      )
    })
  } catch {
    return { failure: 'native-status-failed' }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await nativeStatus()))
}
