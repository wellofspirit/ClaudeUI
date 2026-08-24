/**
 * Unit tests for the extracted <ApprovalButtons> component.
 *
 * Verifies that decision + suggestions wiring is identical to the 3 former
 * sites in ToolCallBlock/View.tsx:
 *   1. Main site: shows decisionReason + AlwaysAllowSection + Deny/Allow
 *   2. Mermaid/mockup sites (showSuggestions=false): shows only Deny/Allow
 *
 * The `onApproval` callback receives the decision and the selected (checked)
 * suggestions, mirroring the exact contract from ToolCallBlock.tsx's
 * handleApproval.
 */

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ApprovalButtons } from '../ApprovalButtons'
import type { PendingApproval, PermissionSuggestion } from '../../../../../shared/types'

function makeApproval(overrides?: Partial<PendingApproval>): PendingApproval {
  return {
    requestId: 'req-test',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    ...overrides
  }
}

describe('ApprovalButtons', () => {
  it('renders Deny and Allow buttons', () => {
    const approval = makeApproval()
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByText('Deny')).toBeInTheDocument()
    expect(screen.getByText('Allow')).toBeInTheDocument()
  })

  it('calls onApproval with allow decision when Allow clicked', async () => {
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval()
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })
    expect(onApproval).toHaveBeenCalledWith('allow', undefined)
  })

  it('calls onApproval with deny decision when Deny clicked', async () => {
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval()
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)
    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })
    expect(onApproval).toHaveBeenCalledWith('deny', undefined)
  })

  it('renders decisionReason when showSuggestions=true (default)', () => {
    const approval = makeApproval({ decisionReason: 'This command modifies files' })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    expect(screen.getByText('This command modifies files')).toBeInTheDocument()
  })

  it('does NOT render decisionReason when showSuggestions=false (mermaid/mockup)', () => {
    const approval = makeApproval({ decisionReason: 'This command modifies files' })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
        showSuggestions={false}
      />
    )
    expect(screen.queryByText('This command modifies files')).not.toBeInTheDocument()
  })

  it('renders AlwaysAllowSection when suggestions present and showSuggestions=true', () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const approval = makeApproval({ suggestions })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
      />
    )
    // AlwaysAllowSection renders "Permission rules" label
    expect(screen.getByText(/Permission rules/i)).toBeInTheDocument()
  })

  it('does NOT render AlwaysAllowSection when showSuggestions=false', () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const approval = makeApproval({ suggestions })
    render(
      <ApprovalButtons
        approval={approval}
        permissionMode="default"
        onApproval={vi.fn().mockResolvedValue(undefined)}
        showSuggestions={false}
      />
    )
    expect(screen.queryByText(/Permission rules/i)).not.toBeInTheDocument()
  })

  it('forwards checked suggestions on Allow', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      },
      {
        type: 'addRules',
        destination: 'userSettings',
        rules: [{ toolName: 'Read', ruleContent: '/tmp/*' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Check the second suggestion checkbox
    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[1])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(onApproval).toHaveBeenCalledWith('allow', [suggestions[1]])
  })

  it('omits suggestions on Deny even when checkboxes are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Check the checkbox
    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[0])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })

    expect(onApproval).toHaveBeenCalledWith('deny', undefined)
  })

  it('omits suggestions when none are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    const onApproval = vi.fn().mockResolvedValue(undefined)
    const approval = makeApproval({ suggestions })
    render(<ApprovalButtons approval={approval} permissionMode="default" onApproval={onApproval} />)

    // Leave checkboxes unchecked, click Allow
    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(onApproval).toHaveBeenCalledWith('allow', undefined)
  })
})
