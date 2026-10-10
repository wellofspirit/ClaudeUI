import { describe, expect, it } from 'vitest'
import { ipcErrorMessage, isInvokeTimeout, isPermissionDenied } from '../ipc-error'

describe('ipcErrorMessage', () => {
  it("strips the desktop invoke wrapper and the handler's error class", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'usage-hub:configure': HubUrlError: the hub must be https, or http on localhost"
        )
      )
    ).toBe('the hub must be https, or http on localhost')
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'harness:install': Error: pi 0.1.0 is not supported"
        )
      )
    ).toBe('pi 0.1.0 is not supported')
  })

  it('leaves a web rejection, which carries the bare message, as it is', () => {
    expect(ipcErrorMessage(new Error('the hub refused the service token'))).toBe(
      'the hub refused the service token'
    )
  })

  it('reads a non-Error rejection as text', () => {
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})

describe('isPermissionDenied', () => {
  it("recognises the registry's refusal on either transport", () => {
    const message = 'Permission denied: "harness:install" requires the "admin" capability'
    expect(isPermissionDenied(new Error(message))).toBe(true)
    expect(
      isPermissionDenied(
        new Error(`Error invoking remote method 'harness:install': Error: ${message}`)
      )
    ).toBe(true)
  })

  it('is false for any other failure', () => {
    expect(isPermissionDenied(new Error('opencode 9.9.9 is not supported'))).toBe(false)
  })
})

describe('isInvokeTimeout', () => {
  it("recognises the web transport's timeout", () => {
    expect(isInvokeTimeout(new Error('Timeout: harness:install'))).toBe(true)
  })

  it('is false for a handler error that merely mentions a timeout', () => {
    expect(isInvokeTimeout(new Error('The download timed out'))).toBe(false)
  })
})
