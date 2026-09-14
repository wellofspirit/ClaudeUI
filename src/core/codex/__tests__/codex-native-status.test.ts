import { expect, it } from 'vitest'
import { classifyStatus } from '../../../../scripts/codex-native-status.mjs'

it('whitelists native status without printing fragments, account text or errors', () => {
  expect(classifyStatus(0, 'Logged in using an API key - synthetic-fragment\n')).toEqual({
    authenticated: true,
    authKind: 'apiKey',
    requiresLogin: false
  })
  expect(classifyStatus(0, 'Logged in using ChatGPT\n')).toEqual({
    authenticated: true,
    authKind: 'chatgpt',
    requiresLogin: false
  })
  expect(classifyStatus(1, 'Not logged in\n')).toEqual({
    authenticated: false,
    authKind: null,
    requiresLogin: true
  })
  expect(classifyStatus(1, 'Error checking login status: synthetic-secret')).toEqual({
    failure: 'native-status-failed'
  })
  expect(classifyStatus(1, 'Logged in using ChatGPT')).toEqual({ failure: 'native-status-failed' })
})
