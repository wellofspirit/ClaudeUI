/**
 * TOOL_RENDERERS — the passive-kind → body registry.
 *
 * Keyed on ToolKind. Each entry declares its layout (standard = ToolCard chrome,
 * custom = body renders its own card) and the Body component. The lifted kinds
 * (plan/question/todo/task) are NOT in this map — they route out to their
 * interaction components in renderToolBlock.
 */

import type { ToolKind } from '../../../../../../shared/tool-kinds'
import type { KindRenderer } from './types'
import { CommandBody } from './CommandBody'
import { FileEditBody } from './FileEditBody'
import { FileWriteBody } from './FileWriteBody'
import { FileReadBody } from './FileReadBody'
import { GenericBody } from './GenericBody'
import { DiagramBody } from './DiagramBody'
import { MockupBody } from './MockupBody'

/** Passive kinds the registry can render. Lifted kinds are routed elsewhere. */
export type PassiveToolKind = Exclude<ToolKind, 'plan' | 'question' | 'todo' | 'task'>

export const TOOL_RENDERERS: Record<PassiveToolKind, KindRenderer> = {
  command: { layout: 'standard', Body: CommandBody },
  fileEdit: { layout: 'standard', Body: FileEditBody },
  fileWrite: { layout: 'standard', Body: FileWriteBody },
  fileRead: { layout: 'standard', Body: FileReadBody },
  search: { layout: 'standard', Body: GenericBody },
  web: { layout: 'standard', Body: GenericBody },
  mcp: { layout: 'standard', Body: GenericBody },
  unknown: { layout: 'standard', Body: GenericBody },
  diagram: { layout: 'custom', Body: DiagramBody },
  mockup: { layout: 'custom', Body: MockupBody }
}

export type { KindRenderer, KindBodyProps } from './types'
