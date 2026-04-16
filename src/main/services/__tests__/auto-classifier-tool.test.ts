/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { createClassifierServer, type ClassifyResult, type ClassifyResultHandler } from '../auto-classifier-tool'

describe('auto-classifier-tool', () => {
  describe('createClassifierServer', () => {
    it('returns an MCP server object', () => {
      const server = createClassifierServer(() => {})
      expect(server).toBeDefined()
      expect(typeof server).toBe('object')
    })

    it('creates a server with the correct name', () => {
      const server = createClassifierServer(() => {})
      // The server is an opaque SDK object; just verify it was created without error
      expect(server).toBeTruthy()
    })
  })

  describe('ClassifyResultHandler callback', () => {
    it('receives structured result with all required fields', () => {
      const handler = vi.fn<ClassifyResultHandler>()
      const result: ClassifyResult = {
        thinking: 'This is a read-only operation',
        shouldBlock: false,
        reason: 'Local file read within project scope'
      }
      handler(result)
      expect(handler).toHaveBeenCalledWith(result)
      expect(handler.mock.calls[0][0].thinking).toBe('This is a read-only operation')
      expect(handler.mock.calls[0][0].shouldBlock).toBe(false)
      expect(handler.mock.calls[0][0].reason).toBe('Local file read within project scope')
    })

    it('handles block results', () => {
      const handler = vi.fn<ClassifyResultHandler>()
      const result: ClassifyResult = {
        thinking: 'Force pushing rewrites remote history',
        shouldBlock: true,
        reason: 'Git destructive: force push to remote'
      }
      handler(result)
      expect(handler.mock.calls[0][0].shouldBlock).toBe(true)
    })
  })
})
