/**
 * The session tools' schemas, once (slice 2): the zod shapes Claude and opencode
 * register and the JSON specs pi's bridge and Codex's `dynamicTools` take must
 * describe the same nine tools.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SESSION_TOOL_NAMES,
  sessionToolDescriptions
} from '../../../shared/session-tools-description'
import {
  SESSION_TOOL_SHAPES,
  sessionToolJsonSchema,
  sessionToolJsonSpecs
} from '../session-tool-specs'
import { createSessionToolsServer } from '../session-tools-server'

describe('SESSION_TOOL_SHAPES', () => {
  it('has a shape for exactly the nine tools', () => {
    expect(Object.keys(SESSION_TOOL_SHAPES).sort()).toEqual([...SESSION_TOOL_NAMES].sort())
  })

  it("Claude's server registers these shapes and the shared descriptions, in the tools' order", () => {
    const server = createSessionToolsServer({ getCaller: () => ({}) as never })
    const descriptions = sessionToolDescriptions({ ownMessageTool: 'SendMessage' })
    expect(server.tools.map((tool) => tool.name)).toEqual([...SESSION_TOOL_NAMES])
    for (const tool of server.tools) {
      expect(tool.inputSchema).toBe(
        SESSION_TOOL_SHAPES[tool.name as keyof typeof SESSION_TOOL_SHAPES]
      )
      expect(tool.description).toBe(descriptions[tool.name as keyof typeof descriptions])
      expect(tool.alwaysLoad).toBe(true)
    }
  })
})

describe('sessionToolJsonSchema', () => {
  it('is a closed object schema with no zod noise', () => {
    for (const name of SESSION_TOOL_NAMES) {
      const schema = sessionToolJsonSchema(name)
      expect(schema.type, name).toBe('object')
      expect(schema.additionalProperties, name).toBe(false)
      expect(JSON.stringify(schema), name).not.toMatch(/\$schema|9007199254740991/)
      // Same property names as the zod shape, so the carriers cannot drift.
      expect(Object.keys(schema.properties).sort(), name).toEqual(
        Object.keys(SESSION_TOOL_SHAPES[name]).sort()
      )
    }
  })

  it('requires exactly the fields the zod shape does not mark optional', () => {
    for (const name of SESSION_TOOL_NAMES) {
      const required = Object.entries(SESSION_TOOL_SHAPES[name])
        .filter(([, field]) => !field.safeParse(undefined).success)
        .map(([key]) => key)
        .sort()
      expect([...(sessionToolJsonSchema(name).required ?? [])].sort(), name).toEqual(required)
    }
    expect(sessionToolJsonSchema('session_message').required).toEqual(['session', 'message'])
    expect(sessionToolJsonSchema('session_hand_off').required).toEqual(['title', 'handoff'])
    expect(sessionToolJsonSchema('session_list').required).toBeUndefined()
  })

  it('keeps the enums, integers and descriptions the model needs', () => {
    const start = sessionToolJsonSchema('session_start').properties as Record<
      string,
      Record<string, unknown>
    >
    expect(start.mode).toMatchObject({ type: 'string', enum: ['start', 'propose'] })
    expect(start.engine).toMatchObject({ enum: ['claude', 'opencode', 'pi', 'codex'] })
    expect(start.permission_mode).toMatchObject({
      enum: ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']
    })
    expect(start.wake_when_done).toMatchObject({ type: 'boolean' })
    expect(start.cwd.description).toContain('working tree')
    const list = sessionToolJsonSchema('session_list').properties as Record<
      string,
      Record<string, unknown>
    >
    expect(list.limit).toEqual({ type: 'integer' })
  })

  it('accepts and rejects the same arguments as the zod shape (spot check of the contract)', () => {
    const shape = z.object(SESSION_TOOL_SHAPES.session_message)
    expect(shape.safeParse({ session: 's-a', message: 'hi' }).success).toBe(true)
    expect(shape.safeParse({ session: 's-a' }).success).toBe(false)
  })
})

describe('sessionToolJsonSpecs', () => {
  it("lists the nine tools with the shared descriptions, naming the engine's own messaging tool only when given", () => {
    const plain = sessionToolJsonSpecs({})
    expect(plain.map((spec) => spec.name)).toEqual([...SESSION_TOOL_NAMES])
    const descriptions = sessionToolDescriptions({})
    for (const spec of plain) expect(spec.description).toBe(descriptions[spec.name])
    const pi = sessionToolJsonSpecs({ ownMessageTool: 'send_message' })
    expect(pi.find((spec) => spec.name === 'session_message')!.description).toContain(
      'reached with send_message, not with this tool'
    )
    expect(plain.find((spec) => spec.name === 'session_message')!.description).not.toContain(
      'reached with'
    )
  })
})
