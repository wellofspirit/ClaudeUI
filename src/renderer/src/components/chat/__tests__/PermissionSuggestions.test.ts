/**
 * Layer 1: Unit tests for formatSuggestionLabel in PermissionSuggestions.tsx.
 *
 * Tests pure formatting logic: given a PermissionSuggestion, produces the
 * correct human-readable label string. No rendering, no DOM.
 */

import { describe, it, expect } from 'vitest'
import { formatSuggestionLabel } from '../PermissionSuggestions'
import type { PermissionSuggestion } from '../../../../../shared/types'

describe('formatSuggestionLabel', () => {
  describe('setMode', () => {
    it('setMode_knownDestination_includesModeAndDestLabel', () => {
      const s: PermissionSuggestion = { type: 'setMode', destination: 'userSettings', mode: 'auto' }
      expect(formatSuggestionLabel(s)).toBe('Set mode to "auto" in user settings')
    })

    it('setMode_projectSettings_usesProjectLabel', () => {
      const s: PermissionSuggestion = { type: 'setMode', destination: 'projectSettings', mode: 'acceptEdits' }
      expect(formatSuggestionLabel(s)).toBe('Set mode to "acceptEdits" in project settings')
    })

    it('setMode_sessionDestination_usesThisSessionLabel', () => {
      const s: PermissionSuggestion = { type: 'setMode', destination: 'session', mode: 'plan' }
      expect(formatSuggestionLabel(s)).toBe('Set mode to "plan" in this session')
    })
  })

  describe('addDirectories', () => {
    it('addDirectories_multipleDirectories_listsAllInBrackets', () => {
      const s: PermissionSuggestion = {
        type: 'addDirectories',
        destination: 'projectSettings',
        directories: ['/src', '/lib'],
      }
      expect(formatSuggestionLabel(s)).toBe('Add directories [/src, /lib] in project settings')
    })

    it('addDirectories_singleDirectory_noTrailingComma', () => {
      const s: PermissionSuggestion = {
        type: 'addDirectories',
        destination: 'userSettings',
        directories: ['/home/user/project'],
      }
      expect(formatSuggestionLabel(s)).toBe('Add directories [/home/user/project] in user settings')
    })

    it('addDirectories_emptyDirectoriesArray_showsEllipsis', () => {
      const s: PermissionSuggestion = {
        type: 'addDirectories',
        destination: 'localSettings',
        directories: [],
      }
      expect(formatSuggestionLabel(s)).toBe('Add directories [...] in local settings')
    })

    it('addDirectories_undefinedDirectories_showsEllipsis', () => {
      const s: PermissionSuggestion = { type: 'addDirectories', destination: 'session' }
      expect(formatSuggestionLabel(s)).toBe('Add directories [...] in this session')
    })
  })

  describe('removeDirectories', () => {
    it('removeDirectories_singleDir_usesRemoveVerb', () => {
      const s: PermissionSuggestion = {
        type: 'removeDirectories',
        destination: 'localSettings',
        directories: ['/tmp'],
      }
      expect(formatSuggestionLabel(s)).toBe('Remove directories [/tmp] in local settings')
    })
  })

  describe('addRules', () => {
    it('addRules_withRuleContent_formatsAsToolNameParenContent', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'userSettings',
        behavior: 'allow',
        rules: [{ toolName: 'Bash', ruleContent: 'npm install' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow Bash(npm install) in user settings')
    })

    it('addRules_withoutRuleContent_showsToolNameOnly', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'session',
        rules: [{ toolName: 'Read' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow Read in this session')
    })

    it('addRules_noBehaviorSpecified_defaultsToAllow', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Write', ruleContent: 'src/**' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow Write(src/**) in project settings')
    })

    it('addRules_multipleRules_commaJoined', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'userSettings',
        behavior: 'allow',
        rules: [
          { toolName: 'Bash', ruleContent: 'npm run test' },
          { toolName: 'Read' },
          { toolName: 'Write', ruleContent: 'src/**' },
        ],
      }
      expect(formatSuggestionLabel(s)).toBe(
        'Allow Bash(npm run test), Read, Write(src/**) in user settings'
      )
    })

    it('addRules_emptyRulesArray_showsEllipsis', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'session',
        behavior: 'allow',
        rules: [],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow ... in this session')
    })
  })

  describe('removeRules', () => {
    it('removeRules_alwaysUsesRemoveVerb_regardlessOfBehavior', () => {
      const s: PermissionSuggestion = {
        type: 'removeRules',
        destination: 'userSettings',
        behavior: 'allow', // behavior is ignored for removeRules
        rules: [{ toolName: 'Bash', ruleContent: 'rm -rf' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Remove Bash(rm -rf) in user settings')
    })
  })

  describe('replaceRules', () => {
    it('replaceRules_withDenyBehavior_capitalizesDeny', () => {
      const s: PermissionSuggestion = {
        type: 'replaceRules',
        destination: 'localSettings',
        behavior: 'deny',
        rules: [{ toolName: 'Write' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Deny Write in local settings')
    })

    it('replaceRules_withAskBehavior_capitalizesAsk', () => {
      const s: PermissionSuggestion = {
        type: 'replaceRules',
        destination: 'userSettings',
        behavior: 'ask',
        rules: [{ toolName: 'Bash' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Ask Bash in user settings')
    })
  })

  describe('destination labels', () => {
    it('cliArg_destination_usesCliArgLabel', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'cliArg',
        rules: [{ toolName: 'Read' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow Read in CLI arg')
    })

    it('unknownDestination_fallsBackToRawValue', () => {
      const s: PermissionSuggestion = {
        type: 'addRules',
        destination: 'someUnknownDest',
        rules: [{ toolName: 'Read' }],
      }
      expect(formatSuggestionLabel(s)).toBe('Allow Read in someUnknownDest')
    })
  })
})
