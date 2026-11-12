/**
 * The kind and the header label of every tool name the engine tool maps know, on every
 * engine, pinned as one table.
 *
 * The pi column is also what the permission ladder reads (`piToolKind`, the first line
 * of `decideWithSource` in `src/core/pi/permission-engine.ts`): a kind that moves here
 * is a permission change, so a diff in this snapshot needs the review a ladder change gets.
 *
 * The name list is written by hand so it does not follow the tables it checks. Every
 * ClaudeUI-hosted tool is listed in all three spellings (Claude `mcp__<server>__<tool>`,
 * opencode `claudeui_<tool>`, pi bare), followed by each engine's own tools and by names
 * that must NOT be recognised (a hosted tool on the wrong server, prototype members).
 */
import { describe, expect, it } from 'vitest'
import { piToolKind } from '../../../../../../core/pi/permission-engine'
import { HOSTED_TOOL_NAMES } from '../../../../../../shared/hosted-tools'
import { SESSION_TOOL_NAMES } from '../../../../../../shared/session-tools-description'
import { hostedMcpKind } from '../../../../../../shared/tool-kinds'
import { ClaudeEngineToolMap } from '../ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../OpencodeEngineToolMap'
import { PiEngineToolMap } from '../PiEngineToolMap'

const SESSION_TOOLS = [
  'session_list',
  'session_get',
  'session_read',
  'session_message',
  'session_start',
  'session_dismiss_proposal',
  'session_hand_off',
  'session_usage',
  'session_stop'
]

/** Bare name and the MCP server Claude names it under. */
const HOSTED: [string, string][] = [
  ['render_mermaid', 'claude-ui'],
  ['create_mockup', 'claude-ui-mockup'],
  ['show_mockup', 'claude-ui-mockup'],
  ['dispatch_agent', 'claude-ui-collab'],
  ['hand_back', 'claude-ui-handback'],
  ...SESSION_TOOLS.map((name): [string, string] => [name, 'claude-ui-sessions'])
]

const CLAUDE_TOOLS = [
  'Bash',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Write',
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'ExitPlanMode',
  'AskUserQuestion',
  'TodoWrite',
  'Agent',
  'Task',
  'EnterPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'Skill',
  'Monitor',
  'TaskOutput',
  'Workflow',
  'Artifact',
  'ListAgents',
  'SendMessage',
  'ScheduleWakeup',
  'CronCreate',
  'RemoteTrigger',
  'EnterWorktree',
  'ShareOnboardingGuide',
  'DesignSync',
  'SubagentHandback',
  'ReportFindings',
  'ToolSearch',
  'TaskStop',
  'PushNotification',
  'CronDelete',
  'CronList',
  'ExitWorktree',
  'SendUserFile'
]

const OPENCODE_TOOLS = [
  'bash',
  'shell',
  'edit',
  'apply_patch',
  'patch',
  'write',
  'read',
  'glob',
  'grep',
  'list',
  'webfetch',
  'websearch',
  'task',
  'subagent',
  'todowrite',
  'question',
  'plan_exit',
  'execute',
  'skill',
  'lsp',
  'invalid'
]

const PI_TOOLS = ['find', 'ls', 'exit_plan', 'agent', 'send_message', 'task_stop', 'list_models']

const NOT_OURS = [
  'mcp__github__create_issue',
  'mcp__some-server__tool',
  'mcp__claude-ui__dispatch_agent',
  'mcp__claude-ui-collab__render_mermaid',
  'mcp__claude-ui-collab__session_start',
  'mcp__claude-ui-sessions__dispatch_agent',
  'mcp__claude-ui-sessions__session_nope',
  'mcp__github__hand_back',
  'mcp__claude-ui-collab__dispatch_agent__x',
  'mcp__claude-ui__render_mermaid__',
  'mcp____render_mermaid',
  'mcp__claude-ui__',
  'mcp__',
  'mcp_claude-ui_render_mermaid',
  // pi's sanitised MCP spelling (`-` becomes `_`): a foreign server name, not ours.
  'mcp__claude_ui__render_mermaid',
  'mcp__claude_ui_sessions__session_list',
  'claudeui_',
  'claudeui_bash',
  'claudeui_session_nope',
  'claudeui_claudeui_render_mermaid',
  'claudeui_mcp__claude-ui__render_mermaid',
  'session_nope',
  'session_',
  'RENDER_MERMAID',
  'render_mermaid ',
  'mystery',
  '',
  'constructor',
  'toString',
  'hasOwnProperty',
  '__proto__',
  'claudeui_constructor',
  'claudeui___proto__',
  'mcp__claude-ui__constructor',
  'mcp__constructor__constructor',
  'mcp____proto____render_mermaid'
]

const NAMES = [
  ...HOSTED.flatMap(([bare, server]) => [`mcp__${server}__${bare}`, `claudeui_${bare}`, bare]),
  ...CLAUDE_TOOLS,
  ...OPENCODE_TOOLS,
  ...PI_TOOLS,
  ...NOT_OURS
]

function table(row: (name: string) => string[]): string {
  return NAMES.map((name) => `${JSON.stringify(name)}: ${row(name).join(' | ')}`).join('\n')
}

describe('tool kinds and labels, every known name on every engine', () => {
  it('lists every hosted tool and every session tool', () => {
    expect(SESSION_TOOLS).toEqual([...SESSION_TOOL_NAMES])
    // A new row in HOSTED_TOOLS must be added to HOSTED above, so its kind and label are pinned.
    expect(HOSTED.map(([bare]) => bare).sort()).toEqual([...HOSTED_TOOL_NAMES].sort())
    expect(new Set(NAMES).size).toBe(NAMES.length)
  })

  it('kinds: hostedMcpKind | claude | opencode | pi (renderer) | pi (permission ladder)', () => {
    expect(
      table((name) => [
        hostedMcpKind(name) ?? '-',
        ClaudeEngineToolMap.kindOf(name),
        OpencodeEngineToolMap.kindOf(name),
        PiEngineToolMap.kindOf(name),
        piToolKind(name)
      ])
    ).toMatchInlineSnapshot(`
      ""mcp__claude-ui__render_mermaid": diagram | diagram | diagram | diagram | diagram
      "claudeui_render_mermaid": - | unknown | diagram | unknown | unknown
      "render_mermaid": - | unknown | unknown | diagram | diagram
      "mcp__claude-ui-mockup__create_mockup": mockup | mockup | mockup | mockup | mockup
      "claudeui_create_mockup": - | unknown | mockup | unknown | unknown
      "create_mockup": - | unknown | unknown | mockup | mockup
      "mcp__claude-ui-mockup__show_mockup": mockup | mockup | mockup | mockup | mockup
      "claudeui_show_mockup": - | unknown | mockup | unknown | unknown
      "show_mockup": - | unknown | unknown | mockup | mockup
      "mcp__claude-ui-collab__dispatch_agent": task | task | task | task | task
      "claudeui_dispatch_agent": - | unknown | task | unknown | unknown
      "dispatch_agent": - | unknown | unknown | task | task
      "mcp__claude-ui-handback__hand_back": mcp | mcp | mcp | mcp | mcp
      "claudeui_hand_back": - | unknown | unknown | unknown | unknown
      "hand_back": - | unknown | unknown | unknown | unknown
      "mcp__claude-ui-sessions__session_list": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_list": - | unknown | mcp | unknown | unknown
      "session_list": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_get": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_get": - | unknown | mcp | unknown | unknown
      "session_get": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_read": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_read": - | unknown | mcp | unknown | unknown
      "session_read": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_message": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_message": - | unknown | mcp | unknown | unknown
      "session_message": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_start": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_start": - | unknown | mcp | unknown | unknown
      "session_start": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_dismiss_proposal": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_dismiss_proposal": - | unknown | mcp | unknown | unknown
      "session_dismiss_proposal": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_hand_off": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_hand_off": - | unknown | mcp | unknown | unknown
      "session_hand_off": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_usage": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_usage": - | unknown | mcp | unknown | unknown
      "session_usage": - | unknown | unknown | mcp | mcp
      "mcp__claude-ui-sessions__session_stop": mcp | mcp | mcp | mcp | mcp
      "claudeui_session_stop": - | unknown | mcp | unknown | unknown
      "session_stop": - | unknown | unknown | mcp | mcp
      "Bash": - | command | unknown | unknown | unknown
      "Edit": - | fileEdit | unknown | unknown | unknown
      "MultiEdit": - | fileEdit | unknown | unknown | unknown
      "NotebookEdit": - | fileEdit | unknown | unknown | unknown
      "Write": - | fileWrite | unknown | unknown | unknown
      "Read": - | fileRead | unknown | unknown | unknown
      "Glob": - | search | unknown | unknown | unknown
      "Grep": - | search | unknown | unknown | unknown
      "WebFetch": - | web | unknown | unknown | unknown
      "WebSearch": - | web | unknown | unknown | unknown
      "ExitPlanMode": - | plan | unknown | unknown | unknown
      "AskUserQuestion": - | question | unknown | unknown | unknown
      "TodoWrite": - | todo | unknown | unknown | unknown
      "Agent": - | task | unknown | unknown | unknown
      "Task": - | task | unknown | unknown | unknown
      "EnterPlanMode": - | unknown | unknown | unknown | unknown
      "TaskCreate": - | unknown | unknown | unknown | unknown
      "TaskUpdate": - | unknown | unknown | unknown | unknown
      "TaskList": - | unknown | unknown | unknown | unknown
      "TaskGet": - | unknown | unknown | unknown | unknown
      "Skill": - | detail | unknown | unknown | unknown
      "Monitor": - | detail | unknown | unknown | unknown
      "TaskOutput": - | detail | unknown | unknown | unknown
      "Workflow": - | detail | unknown | unknown | unknown
      "Artifact": - | detail | unknown | unknown | unknown
      "ListAgents": - | detail | unknown | unknown | unknown
      "SendMessage": - | detail | unknown | unknown | unknown
      "ScheduleWakeup": - | detail | unknown | unknown | unknown
      "CronCreate": - | detail | unknown | unknown | unknown
      "RemoteTrigger": - | detail | unknown | unknown | unknown
      "EnterWorktree": - | detail | unknown | unknown | unknown
      "ShareOnboardingGuide": - | detail | unknown | unknown | unknown
      "DesignSync": - | detail | unknown | unknown | unknown
      "SubagentHandback": - | detail | unknown | unknown | unknown
      "ReportFindings": - | findings | unknown | unknown | unknown
      "ToolSearch": - | note | unknown | unknown | unknown
      "TaskStop": - | note | unknown | unknown | unknown
      "PushNotification": - | note | unknown | unknown | unknown
      "CronDelete": - | note | unknown | unknown | unknown
      "CronList": - | note | unknown | unknown | unknown
      "ExitWorktree": - | note | unknown | unknown | unknown
      "SendUserFile": - | note | unknown | unknown | unknown
      "bash": - | unknown | command | command | command
      "shell": - | unknown | command | unknown | unknown
      "edit": - | unknown | fileEdit | fileEdit | fileEdit
      "apply_patch": - | unknown | fileEdit | unknown | unknown
      "patch": - | unknown | fileEdit | unknown | unknown
      "write": - | unknown | fileWrite | fileWrite | fileWrite
      "read": - | unknown | fileRead | fileRead | fileRead
      "glob": - | unknown | search | unknown | unknown
      "grep": - | unknown | search | search | search
      "list": - | unknown | unknown | unknown | unknown
      "webfetch": - | unknown | web | unknown | unknown
      "websearch": - | unknown | web | unknown | unknown
      "task": - | unknown | task | unknown | unknown
      "subagent": - | unknown | task | task | task
      "todowrite": - | unknown | todo | unknown | unknown
      "question": - | unknown | question | unknown | unknown
      "plan_exit": - | unknown | plan | unknown | unknown
      "execute": - | unknown | unknown | unknown | unknown
      "skill": - | unknown | unknown | unknown | unknown
      "lsp": - | unknown | unknown | unknown | unknown
      "invalid": - | unknown | unknown | unknown | unknown
      "find": - | unknown | unknown | search | search
      "ls": - | unknown | unknown | search | search
      "exit_plan": - | unknown | unknown | plan | plan
      "agent": - | unknown | unknown | task | task
      "send_message": - | unknown | unknown | detail | detail
      "task_stop": - | unknown | unknown | note | note
      "list_models": - | unknown | unknown | note | note
      "mcp__github__create_issue": mcp | mcp | mcp | mcp | mcp
      "mcp__some-server__tool": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui__dispatch_agent": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui-collab__render_mermaid": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui-collab__session_start": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui-sessions__dispatch_agent": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui-sessions__session_nope": mcp | mcp | mcp | mcp | mcp
      "mcp__github__hand_back": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui-collab__dispatch_agent__x": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui__render_mermaid__": mcp | mcp | mcp | mcp | mcp
      "mcp____render_mermaid": mcp | mcp | mcp | mcp | mcp
      "mcp__claude-ui__": mcp | mcp | mcp | mcp | mcp
      "mcp__": mcp | mcp | mcp | mcp | mcp
      "mcp_claude-ui_render_mermaid": - | unknown | unknown | unknown | unknown
      "mcp__claude_ui__render_mermaid": mcp | mcp | mcp | mcp | mcp
      "mcp__claude_ui_sessions__session_list": mcp | mcp | mcp | mcp | mcp
      "claudeui_": - | unknown | unknown | unknown | unknown
      "claudeui_bash": - | unknown | unknown | unknown | unknown
      "claudeui_session_nope": - | unknown | unknown | unknown | unknown
      "claudeui_claudeui_render_mermaid": - | unknown | unknown | unknown | unknown
      "claudeui_mcp__claude-ui__render_mermaid": - | unknown | unknown | unknown | unknown
      "session_nope": - | unknown | unknown | unknown | unknown
      "session_": - | unknown | unknown | unknown | unknown
      "RENDER_MERMAID": - | unknown | unknown | unknown | unknown
      "render_mermaid ": - | unknown | unknown | unknown | unknown
      "mystery": - | unknown | unknown | unknown | unknown
      "": - | unknown | unknown | unknown | unknown
      "constructor": - | unknown | unknown | unknown | unknown
      "toString": - | unknown | unknown | unknown | unknown
      "hasOwnProperty": - | unknown | unknown | unknown | unknown
      "__proto__": - | unknown | unknown | unknown | unknown
      "claudeui_constructor": - | unknown | unknown | unknown | unknown
      "claudeui___proto__": - | unknown | unknown | unknown | unknown
      "mcp__claude-ui__constructor": mcp | mcp | mcp | mcp | mcp
      "mcp__constructor__constructor": mcp | mcp | mcp | mcp | mcp
      "mcp____proto____render_mermaid": mcp | mcp | mcp | mcp | mcp"
    `)
  })

  it('labels: claude | opencode | pi', () => {
    expect(
      table((name) => [
        ClaudeEngineToolMap.displayName(name),
        OpencodeEngineToolMap.displayName(name),
        PiEngineToolMap.displayName(name)
      ])
    ).toMatchInlineSnapshot(`
      ""mcp__claude-ui__render_mermaid": Diagram | mcp__claude-ui__render_mermaid | mcp__claude-ui__render_mermaid
      "claudeui_render_mermaid": claudeui_render_mermaid | Diagram | claudeui_render_mermaid
      "render_mermaid": render_mermaid | render_mermaid | Diagram
      "mcp__claude-ui-mockup__create_mockup": Mockup | mcp__claude-ui-mockup__create_mockup | mcp__claude-ui-mockup__create_mockup
      "claudeui_create_mockup": claudeui_create_mockup | Mockup | claudeui_create_mockup
      "create_mockup": create_mockup | create_mockup | Mockup
      "mcp__claude-ui-mockup__show_mockup": Mockup | mcp__claude-ui-mockup__show_mockup | mcp__claude-ui-mockup__show_mockup
      "claudeui_show_mockup": claudeui_show_mockup | Mockup | claudeui_show_mockup
      "show_mockup": show_mockup | show_mockup | Mockup
      "mcp__claude-ui-collab__dispatch_agent": X-Agent | mcp__claude-ui-collab__dispatch_agent | mcp__claude-ui-collab__dispatch_agent
      "claudeui_dispatch_agent": claudeui_dispatch_agent | X-Agent | claudeui_dispatch_agent
      "dispatch_agent": dispatch_agent | dispatch_agent | X-Agent
      "mcp__claude-ui-handback__hand_back": Hand back | mcp__claude-ui-handback__hand_back | mcp__claude-ui-handback__hand_back
      "claudeui_hand_back": claudeui_hand_back | Hand back | claudeui_hand_back
      "hand_back": hand_back | hand_back | Hand back
      "mcp__claude-ui-sessions__session_list": Session · list | mcp__claude-ui-sessions__session_list | mcp__claude-ui-sessions__session_list
      "claudeui_session_list": claudeui_session_list | Session · list | claudeui_session_list
      "session_list": session_list | session_list | Session · list
      "mcp__claude-ui-sessions__session_get": Session · get | mcp__claude-ui-sessions__session_get | mcp__claude-ui-sessions__session_get
      "claudeui_session_get": claudeui_session_get | Session · get | claudeui_session_get
      "session_get": session_get | session_get | Session · get
      "mcp__claude-ui-sessions__session_read": Session · read | mcp__claude-ui-sessions__session_read | mcp__claude-ui-sessions__session_read
      "claudeui_session_read": claudeui_session_read | Session · read | claudeui_session_read
      "session_read": session_read | session_read | Session · read
      "mcp__claude-ui-sessions__session_message": Session · message | mcp__claude-ui-sessions__session_message | mcp__claude-ui-sessions__session_message
      "claudeui_session_message": claudeui_session_message | Session · message | claudeui_session_message
      "session_message": session_message | session_message | Session · message
      "mcp__claude-ui-sessions__session_start": Session · start | mcp__claude-ui-sessions__session_start | mcp__claude-ui-sessions__session_start
      "claudeui_session_start": claudeui_session_start | Session · start | claudeui_session_start
      "session_start": session_start | session_start | Session · start
      "mcp__claude-ui-sessions__session_dismiss_proposal": Session · dismiss proposal | mcp__claude-ui-sessions__session_dismiss_proposal | mcp__claude-ui-sessions__session_dismiss_proposal
      "claudeui_session_dismiss_proposal": claudeui_session_dismiss_proposal | Session · dismiss proposal | claudeui_session_dismiss_proposal
      "session_dismiss_proposal": session_dismiss_proposal | session_dismiss_proposal | Session · dismiss proposal
      "mcp__claude-ui-sessions__session_hand_off": Session · hand off | mcp__claude-ui-sessions__session_hand_off | mcp__claude-ui-sessions__session_hand_off
      "claudeui_session_hand_off": claudeui_session_hand_off | Session · hand off | claudeui_session_hand_off
      "session_hand_off": session_hand_off | session_hand_off | Session · hand off
      "mcp__claude-ui-sessions__session_usage": Session · usage | mcp__claude-ui-sessions__session_usage | mcp__claude-ui-sessions__session_usage
      "claudeui_session_usage": claudeui_session_usage | Session · usage | claudeui_session_usage
      "session_usage": session_usage | session_usage | Session · usage
      "mcp__claude-ui-sessions__session_stop": Session · stop | mcp__claude-ui-sessions__session_stop | mcp__claude-ui-sessions__session_stop
      "claudeui_session_stop": claudeui_session_stop | Session · stop | claudeui_session_stop
      "session_stop": session_stop | session_stop | Session · stop
      "Bash": Bash | Bash | Bash
      "Edit": Edit | Edit | Edit
      "MultiEdit": MultiEdit | MultiEdit | MultiEdit
      "NotebookEdit": NotebookEdit | NotebookEdit | NotebookEdit
      "Write": Write | Write | Write
      "Read": Read | Read | Read
      "Glob": Glob | Glob | Glob
      "Grep": Grep | Grep | Grep
      "WebFetch": WebFetch | WebFetch | WebFetch
      "WebSearch": WebSearch | WebSearch | WebSearch
      "ExitPlanMode": ExitPlanMode | ExitPlanMode | ExitPlanMode
      "AskUserQuestion": AskUserQuestion | AskUserQuestion | AskUserQuestion
      "TodoWrite": TodoWrite | TodoWrite | TodoWrite
      "Agent": Agent | Agent | Agent
      "Task": Task | Task | Task
      "EnterPlanMode": EnterPlanMode | EnterPlanMode | EnterPlanMode
      "TaskCreate": TaskCreate | TaskCreate | TaskCreate
      "TaskUpdate": TaskUpdate | TaskUpdate | TaskUpdate
      "TaskList": TaskList | TaskList | TaskList
      "TaskGet": TaskGet | TaskGet | TaskGet
      "Skill": Skill | Skill | Skill
      "Monitor": Monitor | Monitor | Monitor
      "TaskOutput": TaskOutput | TaskOutput | TaskOutput
      "Workflow": Workflow | Workflow | Workflow
      "Artifact": Artifact | Artifact | Artifact
      "ListAgents": ListAgents | ListAgents | ListAgents
      "SendMessage": SendMessage | SendMessage | SendMessage
      "ScheduleWakeup": ScheduleWakeup | ScheduleWakeup | ScheduleWakeup
      "CronCreate": CronCreate | CronCreate | CronCreate
      "RemoteTrigger": RemoteTrigger | RemoteTrigger | RemoteTrigger
      "EnterWorktree": EnterWorktree | EnterWorktree | EnterWorktree
      "ShareOnboardingGuide": ShareOnboardingGuide | ShareOnboardingGuide | ShareOnboardingGuide
      "DesignSync": DesignSync | DesignSync | DesignSync
      "SubagentHandback": Hand back | SubagentHandback | SubagentHandback
      "ReportFindings": ReportFindings | ReportFindings | ReportFindings
      "ToolSearch": ToolSearch | ToolSearch | ToolSearch
      "TaskStop": TaskStop | TaskStop | TaskStop
      "PushNotification": PushNotification | PushNotification | PushNotification
      "CronDelete": CronDelete | CronDelete | CronDelete
      "CronList": CronList | CronList | CronList
      "ExitWorktree": ExitWorktree | ExitWorktree | ExitWorktree
      "SendUserFile": SendUserFile | SendUserFile | SendUserFile
      "bash": bash | Bash | Bash
      "shell": shell | Bash | shell
      "edit": edit | Edit | Edit
      "apply_patch": apply_patch | Patch | apply_patch
      "patch": patch | Patch | patch
      "write": write | Write | Write
      "read": read | Read | Read
      "glob": glob | Glob | glob
      "grep": grep | Grep | Grep
      "list": list | list | list
      "webfetch": webfetch | WebFetch | webfetch
      "websearch": websearch | WebSearch | websearch
      "task": task | Task | task
      "subagent": subagent | Task | Subagent
      "todowrite": todowrite | TodoWrite | todowrite
      "question": question | AskUserQuestion | question
      "plan_exit": plan_exit | plan_exit | plan_exit
      "execute": execute | Execute | execute
      "skill": skill | skill | skill
      "lsp": lsp | lsp | lsp
      "invalid": invalid | invalid | invalid
      "find": find | find | Find
      "ls": ls | ls | Ls
      "exit_plan": exit_plan | exit_plan | exit_plan
      "agent": agent | agent | Agent
      "send_message": send_message | send_message | send_message
      "task_stop": task_stop | task_stop | task_stop
      "list_models": list_models | list_models | Models
      "mcp__github__create_issue": mcp__github__create_issue | mcp__github__create_issue | mcp__github__create_issue
      "mcp__some-server__tool": mcp__some-server__tool | mcp__some-server__tool | mcp__some-server__tool
      "mcp__claude-ui__dispatch_agent": mcp__claude-ui__dispatch_agent | mcp__claude-ui__dispatch_agent | mcp__claude-ui__dispatch_agent
      "mcp__claude-ui-collab__render_mermaid": mcp__claude-ui-collab__render_mermaid | mcp__claude-ui-collab__render_mermaid | mcp__claude-ui-collab__render_mermaid
      "mcp__claude-ui-collab__session_start": mcp__claude-ui-collab__session_start | mcp__claude-ui-collab__session_start | mcp__claude-ui-collab__session_start
      "mcp__claude-ui-sessions__dispatch_agent": mcp__claude-ui-sessions__dispatch_agent | mcp__claude-ui-sessions__dispatch_agent | mcp__claude-ui-sessions__dispatch_agent
      "mcp__claude-ui-sessions__session_nope": mcp__claude-ui-sessions__session_nope | mcp__claude-ui-sessions__session_nope | mcp__claude-ui-sessions__session_nope
      "mcp__github__hand_back": mcp__github__hand_back | mcp__github__hand_back | mcp__github__hand_back
      "mcp__claude-ui-collab__dispatch_agent__x": mcp__claude-ui-collab__dispatch_agent__x | mcp__claude-ui-collab__dispatch_agent__x | mcp__claude-ui-collab__dispatch_agent__x
      "mcp__claude-ui__render_mermaid__": mcp__claude-ui__render_mermaid__ | mcp__claude-ui__render_mermaid__ | mcp__claude-ui__render_mermaid__
      "mcp____render_mermaid": mcp____render_mermaid | mcp____render_mermaid | mcp____render_mermaid
      "mcp__claude-ui__": mcp__claude-ui__ | mcp__claude-ui__ | mcp__claude-ui__
      "mcp__": mcp__ | mcp__ | mcp__
      "mcp_claude-ui_render_mermaid": mcp_claude-ui_render_mermaid | mcp_claude-ui_render_mermaid | mcp_claude-ui_render_mermaid
      "mcp__claude_ui__render_mermaid": mcp__claude_ui__render_mermaid | mcp__claude_ui__render_mermaid | mcp__claude_ui__render_mermaid
      "mcp__claude_ui_sessions__session_list": mcp__claude_ui_sessions__session_list | mcp__claude_ui_sessions__session_list | mcp__claude_ui_sessions__session_list
      "claudeui_": claudeui_ | claudeui_ | claudeui_
      "claudeui_bash": claudeui_bash | claudeui_bash | claudeui_bash
      "claudeui_session_nope": claudeui_session_nope | claudeui_session_nope | claudeui_session_nope
      "claudeui_claudeui_render_mermaid": claudeui_claudeui_render_mermaid | claudeui_claudeui_render_mermaid | claudeui_claudeui_render_mermaid
      "claudeui_mcp__claude-ui__render_mermaid": claudeui_mcp__claude-ui__render_mermaid | claudeui_mcp__claude-ui__render_mermaid | claudeui_mcp__claude-ui__render_mermaid
      "session_nope": session_nope | session_nope | session_nope
      "session_": session_ | session_ | session_
      "RENDER_MERMAID": RENDER_MERMAID | RENDER_MERMAID | RENDER_MERMAID
      "render_mermaid ": render_mermaid  | render_mermaid  | render_mermaid 
      "mystery": mystery | mystery | mystery
      "":  |  | 
      "constructor": constructor | constructor | constructor
      "toString": toString | toString | toString
      "hasOwnProperty": hasOwnProperty | hasOwnProperty | hasOwnProperty
      "__proto__": __proto__ | __proto__ | __proto__
      "claudeui_constructor": claudeui_constructor | claudeui_constructor | claudeui_constructor
      "claudeui___proto__": claudeui___proto__ | claudeui___proto__ | claudeui___proto__
      "mcp__claude-ui__constructor": mcp__claude-ui__constructor | mcp__claude-ui__constructor | mcp__claude-ui__constructor
      "mcp__constructor__constructor": mcp__constructor__constructor | mcp__constructor__constructor | mcp__constructor__constructor
      "mcp____proto____render_mermaid": mcp____proto____render_mermaid | mcp____proto____render_mermaid | mcp____proto____render_mermaid"
    `)
  })
})
