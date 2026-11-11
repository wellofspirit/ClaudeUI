import type { Automation, AutomationRun } from '../automation'
import type { ChatMessage } from '../content'

export interface AutomationAPI {
  listAutomations(): Promise<Automation[]>
  saveAutomation(automation: Automation): Promise<void>
  deleteAutomation(id: string): Promise<void>
  runAutomationNow(id: string): Promise<void>
  toggleAutomation(id: string, enabled: boolean): Promise<void>
  listAutomationRuns(automationId: string): Promise<AutomationRun[]>
  loadAutomationRunHistory(automationId: string, runId: string): Promise<ChatMessage[]>
  cancelAutomationRun(automationId: string): Promise<void>
  dismissAutomationRun(automationId: string, runId: string): Promise<void>
  sendAutomationMessage(automationId: string, prompt: string): Promise<void>
}
