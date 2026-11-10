/**
 * @vitest-environment node
 *
 * A shared Claude skill typed as `/name args` reaches opencode as cli.js's envelope plus the
 * expansion (OpencodeSession.postPromptNow); a reopened chat shows the typed command as the
 * `cli_command` block Claude's own history shows. The envelope parser is slice A's (its own
 * suite): here it is the wire, the mapping into the row is what is under test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Session_Message_Info } from '../protocol-v2/openapi'

vi.mock('../../auth/OpencodeAuthProvider', () => ({
  opencodeAuthProvider: { buildAccountRef: () => ({ billingType: 'api' }) }
}))
vi.mock('../model-discovery', () => ({ getOpencodeModelContextWindow: () => 1_000 }))
vi.mock('../../services/claude-skill-invoke', () => ({
  parseSkillInvocationEnvelope: (text: string) => {
    const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)
    return name ? { commandName: name[1], ...(args ? { commandArgs: args[1] } : {}) } : null
  }
}))

import { convertOpencodeHistory } from '../history'

const user = (id: string, created: number, text: string): Session_Message_Info => ({
  id,
  type: 'user',
  text,
  time: { created }
})

describe('opencode history: a skill envelope', () => {
  it('renders as a cli_command block (a system row); a plain prompt beside it stays a user row', () => {
    const envelope =
      '<command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>prod</command-args>\n\nBase directory for this skill: /s\n\nDeploy it.'
    const { messages } = convertOpencodeHistory([user('m1', 1, envelope), user('m2', 2, 'thanks')])
    expect(messages).toEqual([
      {
        id: 'm1',
        role: 'system',
        content: [{ type: 'cli_command', commandName: '/deploy', commandArgs: 'prod' }],
        timestamp: 1
      },
      { id: 'm2', role: 'user', content: [{ type: 'text', text: 'thanks' }], timestamp: 2 }
    ])
  })

  it('an envelope without args carries no commandArgs', () => {
    const { messages } = convertOpencodeHistory([
      user('m1', 1, '<command-message>x</command-message>\n<command-name>/x</command-name>\n\nBody')
    ])
    expect(messages[0].content).toEqual([{ type: 'cli_command', commandName: '/x' }])
  })
})
