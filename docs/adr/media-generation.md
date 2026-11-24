# Media generation

Governs: `src/core/services/media-jobs.ts`, `src/core/services/media-path.ts`, `src/core/services/media-files.ts`, `src/core/services/media-job-ledger.ts`, `src/core/services/media-catalog.ts`, `src/core/services/media-tool.ts`, `src/core/services/media-providers/`, `src/core/ipc/media-commands.ts`, `src/shared/media-generation.ts`, `src/shared/media-tool-view.ts`, `src/shared/media-tools-description.ts`, `src/main/services/media-protocol.ts`, `src/renderer/src/components/chat/MediaCard.tsx`, `src/renderer/src/components/SettingsDialog/MediaGenerationSettings.tsx`

ClaudeUI's own image and video generation, offered to every engine. The as-built mechanics are in the file headers
of `media-jobs.ts`, `media-path.ts` and `media-files.ts`. The permission ladders the tools ride are
`permissions.md`; the notice reuses the dispatch-result delivery of ADR-105 (dispatch.md); the file route sits
behind the remote server's file token (`remote-access.md`).

## ClaudeUI hosts image and video generation for every engine, as background jobs (ADR-118)

**§1.** One pair of tools, `generate_image` and `generate_video`, is ClaudeUI's own and is offered to Claude (its own
`claude-ui-media` MCP server, outside the pre-allowed tools), opencode (`claudeui_generate_*` on the hosted MCP
server) and pi (the bridge extension). The main process calls the provider with the credentials ClaudeUI already
holds: the ChatGPT sign-in, an OpenAI key or an OpenRouter key. Claude Code has no image generation of its own, and one
implementation keeps the three engines alike. While ours is usable for a kind, opencode's own `generate_image` /
`generate_video` is hidden, so an agent never sees two.

**§2.** The ChatGPT plan's image generation is one entry named "ChatGPT Plan", never a model id. The plan's endpoint
(`chatgpt.com/backend-api/codex/images/*`) fixes the model, quality and size server-side whatever a request names
(probed 2026-11-24: any model name, `quality: "high"` and any size returned the same low-quality ~1.5 MP image), so a
picker offering plan models would offer a choice that does not exist. Model choice and quality are for keyed
providers. The models of a keyed provider are its models.dev `image` / `video` rows, listed only while that provider
is connected. Video is OpenRouter only: no OpenAI or ChatGPT video API exists.

**§3.** A call is a background job: the tool returns at once with the job and its provisional path, and when the job
ends the agent gets a notice on the dispatch-result path (it wakes an idle session, joins a running turn, or waits in
the inbox) with its own wording, and the card updates. The agent can start several jobs, under a concurrency cap and
a give-up timeout from Settings. A subagent's call waits for its result instead, so the notice never reaches a parent
that did not ask. Jobs live in the `media_job` ledger: a job running at quit is marked interrupted at the next boot
by an owner that is gone (two hosts share the database), and a reopened session rebuilds its cards from the ledger.
Only closing or deleting the session cancels a job; an idle timeout, an effort respawn or Esc does not.

**§4.** Permissions follow the normal model. Default and acceptEdits ask; auto mode goes to the auto-mode judge
(Claude's own classifier on Claude); bypass runs them unasked like every tool. The approval card offers the usual
persistent allow (local, project, global) as the Claude-spelling rule `mcp__claude-ui-media__generate_*`, which all
three ladders honour. Plan mode denies both tools even under an allow rule: on Claude the tool refuses in plan mode
itself, because cli.js skips the host check for an allowed tool. X-Agent dispatch targets never get the tools. A
model set to Off removes that kind's tool and refuses a job even when the agent names a model, so Off is a cost
guardrail.

**§5.** Paths are contained. Output and input paths must resolve (real path, links, junctions and 8.3 names
included) inside the session's working directory or the user's additional directories. Agent-configuration
locations are refused. A path the agent names may only create a file or replace an image or video of the same
type, and a result whose format changes the extension never lands on a file the agent did not name. The default is
`<workdir>/.claude/ui/media/<session>/<job>.<ext>`. A saved file is served by job id only, never by path: on the
desktop through `claudeui-media://`, to the browser client through `/media-file` behind the remote file token, both
with Range so video seeks.

Consequences: Claude, opencode and pi generate images the same way with no per-engine setup, and a batch of jobs
runs without blocking the agent. Plan image generation depends on an unpublished ChatGPT endpoint that could change
without notice. The ChatGPT token gains a caller beyond the auto-mode judge and the usage read.
