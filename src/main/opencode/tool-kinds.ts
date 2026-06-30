/**
 * Basic tool → kind map for opencode tool parts.
 * Phase 6 will expand this into a full ToolKind registry.
 */
export function opencodeToolKind(toolName: string): string {
  switch (toolName) {
    case 'bash': return 'bash'
    case 'read': return 'read'
    case 'edit':
    case 'write': return 'edit'
    case 'glob':
    case 'grep':
    case 'list': return 'search'
    case 'task': return 'task'
    default: return 'other'
  }
}
