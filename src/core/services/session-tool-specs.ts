import { z } from 'zod'
import {
  OWN_TEAMMATE_MESSAGE_TOOL,
  sessionToolDescriptions,
  sessionToolsGuidanceParts,
  SESSION_TOOL_NAMES,
  type SessionToolName
} from '../../shared/session-tools-description'

/**
 * The session tools' input schemas, once (session tools, slice 2). Claude's
 * `claude-ui-sessions` server and opencode's hosted `claudeui` server register
 * these zod shapes directly; pi's bridge and Codex's `dynamicTools` take the same
 * schemas as JSON ({@link sessionToolJsonSpecs}), so the four carriers cannot
 * describe different tools.
 */
const engine = z.enum(['claude', 'opencode', 'pi', 'codex'])

export const SESSION_TOOL_SHAPES: Record<SessionToolName, Record<string, z.ZodType>> = {
  session_list: {
    scope: z.enum(['linked', 'project', 'all']).optional(),
    limit: z.number().int().optional(),
    include_archived: z.boolean().optional()
  },
  session_get: {
    session: z.string().describe('A session ref, self, origin or an exact unique title')
  },
  session_read: {
    session: z.string().describe('A session ref, self, origin or an exact unique title'),
    before: z.number().int().optional().describe('A message number: return the ones before it'),
    limit: z.number().int().optional()
  },
  session_message: {
    session: z.string().describe('A session ref, origin or an exact unique title'),
    message: z.string().describe('What to tell that session')
  },
  session_start: {
    mode: z.enum(['start', 'propose']).optional(),
    proposal_id: z
      .string()
      .optional()
      .describe('Start a proposal the user approved in chat; use it alone'),
    title: z.string().optional().describe('A short name for the new session (under 60 characters)'),
    prompt: z.string().optional().describe('The task: the area, and what done looks like'),
    background: z
      .string()
      .optional()
      .describe('Everything the new session cannot see and needs (at least 80 characters)'),
    engine: engine.optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    permission_mode: z
      .enum(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'])
      .optional(),
    cwd: z.string().optional().describe('Inside your own working tree'),
    worktree: z.string().optional().describe('A name: start it in a new git worktree'),
    relation: z
      .enum(['standalone', 'same_work'])
      .optional()
      .describe(
        'same_work: this continues the current work (the new session joins its group). Default standalone: separate work.'
      )
  },
  session_dismiss_proposal: {
    proposal_id: z.string().describe('The id session_start returned (p-…)'),
    reason: z.string().optional()
  },
  session_hand_off: {
    title: z.string().describe('A short name for the continuing session (under 60 characters)'),
    handoff: z
      .string()
      .describe(
        'The complete write-up: goal, state, decisions, remaining plan, files touched, how to verify'
      ),
    engine: engine.optional(),
    model: z.string().optional(),
    effort: z.string().optional()
  },
  session_usage: { session: z.string().optional().describe('Default: self') },
  session_stop: {
    session: z.string().describe('A session ref or an exact unique title')
  }
}

/** One tool as pi's `registerTool` and Codex's `DynamicToolSpec` take it. */
export interface SessionToolJsonSpec {
  name: SessionToolName
  description: string
  /** JSON Schema of the arguments; closed (`additionalProperties: false`). */
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
  }
}

/** The JSON Schema of one tool's arguments, without zod's `$schema` and safe-integer bounds. */
export function sessionToolJsonSchema(name: SessionToolName): SessionToolJsonSpec['parameters'] {
  const { properties, required } = z.toJSONSchema(z.object(SESSION_TOOL_SHAPES[name]), {
    io: 'input'
  }) as { properties: Record<string, Record<string, unknown>>; required?: string[] }
  for (const property of Object.values(properties)) {
    // `z.number().int()` adds the safe-integer range; the model needs "integer" only.
    // (`z.toJSONSchema` builds a fresh object on every call, so mutating it here is safe.)
    if (property.type === 'integer') {
      delete property.minimum
      delete property.maximum
    }
  }
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: false
  }
}

/** All nine tools as JSON specs, with the shared descriptions. */
export function sessionToolJsonSpecs(opts: { ownMessageTool?: string }): SessionToolJsonSpec[] {
  const descriptions = sessionToolDescriptions(opts)
  return SESSION_TOOL_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    parameters: sessionToolJsonSchema(name)
  }))
}

/**
 * The session tools for pi's bridge (`CLAUDEUI_PI_SESSION_TOOLS`, bridge v15): the JSON
 * specs with pi's own teammate tool named in `session_message`, plus the guidance as
 * `promptGuidelines` (pi's carrier for text that belongs in the system prompt) on
 * `session_list`: the tools are registered together, so one carries it for all. The
 * bridge registers exactly what is in here.
 */
export function piSessionToolsEnv(): string {
  const { intro, bullets } = sessionToolsGuidanceParts({ toolPrefix: '' })
  return JSON.stringify(
    sessionToolJsonSpecs({ ownMessageTool: OWN_TEAMMATE_MESSAGE_TOOL.pi }).map((spec) =>
      spec.name === 'session_list' ? { ...spec, promptGuidelines: [intro, ...bullets] } : spec
    )
  )
}
