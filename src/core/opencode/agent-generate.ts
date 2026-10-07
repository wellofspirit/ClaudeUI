/**
 * agent-generate.ts
 *
 * AI-assisted agent authoring: one transient completion from opencode 2.x
 * (`POST /api/session/{id}/generate`, ADR-097 S5) on a throwaway session, with
 * the meta-prompt below, parsed into a structured agent config.
 *
 * 2.x has no synchronous prompt (`session.prompt` only enqueues), and
 * `generate` has no `system` field: the throwaway session is created with the
 * model and a ruleset that hides every tool (`THROWAWAY_RULESET`), and the
 * meta-prompt rides in the prompt text. `generate` writes nothing to the
 * session and is the only model-waiting call (240 s, under undici's 300 s
 * header timeout).
 */

import { opencodeServerManager } from './OpencodeServerManager'
import { OpencodeClient } from './OpencodeClient'
import { THROWAWAY_RULESET } from './permission-v2'
import { resolveOpencodeSpawnModel, parseModelString } from './model-discovery'
import { PERSISTED_SESSIONS_DIR } from '../services/persisted-sessions-dir'
import { logger } from '../services/logger'
import { OPENCODE_AGENT_GENERATE_TITLE } from '../../shared/dispatch-session'

// ─── Meta-prompt ──────────────────────────────────────────────────────────────

const AGENT_GENERATE_PROMPT = `You are an elite AI agent architect specializing in crafting high-performance agent configurations. Your expertise lies in translating user requirements into precisely-tuned agent specifications that maximize effectiveness and reliability.

When a user describes what they want an agent to do, you will:

1. **Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and success criteria for the agent. Look for both explicit requirements and implicit needs. For agents that are meant to review code, you should assume that the user is asking to review recently written code and not the whole codebase, unless the user has explicitly instructed you otherwise.

2. **Design Expert Persona**: Create a compelling expert identity that embodies deep domain knowledge relevant to the task. The persona should inspire confidence and guide the agent's decision-making approach.

3. **Architect Comprehensive Instructions**: Develop a system prompt that:

   - Establishes clear behavioral boundaries and operational parameters
   - Provides specific methodologies and best practices for task execution
   - Anticipates edge cases and provides guidance for handling them
   - Incorporates any specific requirements or preferences mentioned by the user
   - Defines output format expectations when relevant

4. **Optimize for Performance**: Include:

   - Decision-making frameworks appropriate to the domain
   - Quality control mechanisms and self-verification steps
   - Efficient workflow patterns
   - Clear escalation or fallback strategies

5. **Create Identifier**: Design a concise, descriptive identifier that:
   - Uses lowercase letters, numbers, and hyphens only
   - Is typically 2-4 words joined by hyphens
   - Clearly indicates the agent's primary function
   - Is memorable and easy to type
   - Avoids generic terms like "helper" or "assistant"

6 **Example agent descriptions**:

- in the 'whenToUse' field of the JSON object, you should include examples of when this agent should be used.
- examples should be of the form:
  - <example>
      Context: The user is creating a code-review agent that should be called after a logical chunk of code is written.
      user: "Please write a function that checks if a number is prime"
      assistant: "Here is the relevant function: "
      <function call omitted for brevity only for this example>
      <commentary>
      Since the user is greeting, use the Task tool to launch the greeting-responder agent to respond with a friendly joke.
      </commentary>
      assistant: "Now let me use the code-reviewer agent to review the code"
    </example>
  - <example>
      Context: User is creating an agent to respond to the word "hello" with a friendly jok.
      user: "Hello"
      assistant: "I'm going to use the Task tool to launch the greeting-responder agent to respond with a friendly joke"
      <commentary>
      Since the user is greeting, use the greeting-responder agent to respond with a friendly joke.
      </commentary>
    </example>
- If the user mentioned or implied that the agent should be used proactively, you should include examples of this.
- NOTE: Ensure that in the examples, you are making the assistant use the Agent tool and not simply respond directly to the task.

Your output must be a valid JSON object with exactly these fields:
{
"identifier": "A unique, descriptive identifier using lowercase letters, numbers, and hyphens (e.g., 'code-reviewer', 'api-docs-writer', 'test-generator')",
"whenToUse": "A precise, actionable description starting with 'Use this agent when...' that clearly defines the triggering conditions and use cases. Ensure you include examples as described above.",
"systemPrompt": "The complete system prompt that will govern the agent's behavior, written in second person ('You are...', 'You will...') and structured for maximum clarity and effectiveness"
}

Key principles for your system prompts:

- Be specific rather than generic - avoid vague instructions
- Include concrete examples when they would clarify behavior
- Balance comprehensiveness with clarity - every instruction should add value
- Ensure the agent has enough context to handle variations of the core task
- Make the agent proactive in seeking clarification when needed
- Build in quality assurance and self-correction mechanisms

Remember: The agents you create should be autonomous experts capable of handling their designated tasks with minimal additional guidance. Your system prompts are their complete operational manual.`

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an agent configuration from a natural-language description.
 * Creates a throwaway opencode session, asks `generate` with the meta-prompt +
 * description, parses the JSON answer, and deletes the session.
 */
export async function generateAgent(
  description: string,
  cwd?: string
): Promise<{ identifier: string; whenToUse: string; systemPrompt: string }> {
  const dir = cwd ?? PERSISTED_SESSIONS_DIR
  // No turn runs and every tool is hidden: do not wait for the hosted MCP tools.
  const conn = await opencodeServerManager.acquire(dir, { waitForHostedTools: false })
  const client = new OpencodeClient(conn)
  let sessionID: string | null = null
  try {
    // A concrete model: the throwaway has no chat behind it to inherit one from.
    const modelStr = await resolveOpencodeSpawnModel()
    const parsedModel = modelStr ? parseModelString(modelStr) : undefined
    // Every tool hidden (THROWAWAY_RULESET): the model answers from text
    // alone, and nothing it proposes can run. NOT swallowed: without the
    // ruleset the session would offer every tool.
    const session = await client.createSession({
      title: OPENCODE_AGENT_GENERATE_TITLE,
      permissions: [...THROWAWAY_RULESET],
      ...(parsedModel
        ? { model: { providerID: parsedModel.providerID, id: parsedModel.modelID } }
        : {})
    })
    sessionID = session.id

    const text = await client.generate(
      session.id,
      `${AGENT_GENERATE_PROMPT}\n\nCreate an agent configuration based on this request: "${description}". Return ONLY the JSON object, no backticks.`
    )

    // Strip markdown fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/m, '')
      .replace(/\n?```\s*$/m, '')
      .trim()

    const parsed = JSON.parse(cleaned) as unknown

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>).identifier !== 'string' ||
      typeof (parsed as Record<string, unknown>).whenToUse !== 'string' ||
      typeof (parsed as Record<string, unknown>).systemPrompt !== 'string'
    ) {
      throw new Error(
        'generateAgent: response missing required fields (identifier, whenToUse, systemPrompt)'
      )
    }

    const result = parsed as { identifier: string; whenToUse: string; systemPrompt: string }
    return {
      identifier: result.identifier,
      whenToUse: result.whenToUse,
      systemPrompt: result.systemPrompt
    }
  } finally {
    // Delete BEFORE the lease ends (a last-lease release ends the server): an
    // orphaned throwaway would land in the data dir shared with the user's opencode.
    if (sessionID)
      await client.deleteSession(sessionID).catch((err: unknown) => {
        logger.warn(
          'agent-generate',
          `throwaway session not deleted: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    opencodeServerManager.releaseIfCurrent(dir, conn)
  }
}
