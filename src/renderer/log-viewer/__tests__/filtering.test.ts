import { describe, it, expect } from 'vitest'

// Extract the pure filtering logic from LogViewer.tsx for testing.
// This mirrors the filter function used in the component.

interface LogEntry {
  timestamp: string
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
  error?: string
}

function filterEntries(
  entries: LogEntry[],
  activeLevels: Set<string>,
  activeSources: Set<string> | null,
  messageFilter: string
): LogEntry[] {
  const tokens = messageFilter.toLowerCase().split(/\s+/).filter(Boolean)

  return entries.filter((e) => {
    if (!activeLevels.has(e.level)) return false
    if (activeSources !== null && !activeSources.has(e.source)) return false
    if (tokens.length > 0) {
      const msgLower = e.message.toLowerCase()
      for (const token of tokens) {
        if (!msgLower.includes(token)) return false
      }
    }
    return true
  })
}

function entry(level: LogEntry['level'], source: string, message: string): LogEntry {
  return { timestamp: '12:00:00.000', level, source, message }
}

const ALL_LEVELS = new Set(['debug', 'info', 'warn', 'error'])

describe('log viewer filtering', () => {
  const entries: LogEntry[] = [
    entry('debug', 'session', 'Starting SDK query'),
    entry('info', 'plugin:mcp', 'Connected to server'),
    entry('warn', 'renderer', 'Deprecated API usage'),
    entry('error', 'session', 'Connection failed: timeout'),
    entry('info', 'log-viewer', 'Ready with 100 entries'),
    entry('debug', 'renderer:error', 'Component re-render detected'),
    entry('error', 'plugin:mcp', 'Server disconnected unexpectedly')
  ]

  describe('level filtering', () => {
    it('shows all entries when all levels active', () => {
      expect(filterEntries(entries, ALL_LEVELS, null, '')).toHaveLength(7)
    })

    it('filters by single level', () => {
      const result = filterEntries(entries, new Set(['error']), null, '')
      expect(result).toHaveLength(2)
      expect(result.every((e) => e.level === 'error')).toBe(true)
    })

    it('filters by multiple levels', () => {
      const result = filterEntries(entries, new Set(['warn', 'error']), null, '')
      expect(result).toHaveLength(3)
    })

    it('returns empty when no levels active', () => {
      expect(filterEntries(entries, new Set(), null, '')).toHaveLength(0)
    })
  })

  describe('source filtering', () => {
    it('shows all entries when activeSources is null', () => {
      expect(filterEntries(entries, ALL_LEVELS, null, '')).toHaveLength(7)
    })

    it('filters to specific sources', () => {
      const result = filterEntries(entries, ALL_LEVELS, new Set(['session']), '')
      expect(result).toHaveLength(2)
      expect(result.every((e) => e.source === 'session')).toBe(true)
    })

    it('filters to multiple sources', () => {
      const result = filterEntries(entries, ALL_LEVELS, new Set(['session', 'renderer']), '')
      expect(result).toHaveLength(3)
    })

    it('returns empty for unknown source', () => {
      expect(filterEntries(entries, ALL_LEVELS, new Set(['nonexistent']), '')).toHaveLength(0)
    })
  })

  describe('message token filtering', () => {
    it('matches single token case-insensitively', () => {
      const result = filterEntries(entries, ALL_LEVELS, null, 'SDK')
      expect(result).toHaveLength(1)
      expect(result[0].message).toContain('SDK')
    })

    it('requires ALL tokens to match (AND logic)', () => {
      const result = filterEntries(entries, ALL_LEVELS, null, 'connection failed')
      expect(result).toHaveLength(1)
      expect(result[0].message).toBe('Connection failed: timeout')
    })

    it('returns empty when one token does not match', () => {
      const result = filterEntries(entries, ALL_LEVELS, null, 'connection banana')
      expect(result).toHaveLength(0)
    })

    it('ignores extra whitespace', () => {
      const result = filterEntries(entries, ALL_LEVELS, null, '  SDK   query  ')
      expect(result).toHaveLength(1)
    })

    it('returns all when filter is empty or whitespace', () => {
      expect(filterEntries(entries, ALL_LEVELS, null, '')).toHaveLength(7)
      expect(filterEntries(entries, ALL_LEVELS, null, '   ')).toHaveLength(7)
    })

    it('matches partial words', () => {
      const result = filterEntries(entries, ALL_LEVELS, null, 'connect')
      // Matches "Connected" and "Connection" and "disconnected"
      expect(result).toHaveLength(3)
    })
  })

  describe('combined filters', () => {
    it('applies level + source + message together', () => {
      const result = filterEntries(
        entries,
        new Set(['error']),
        new Set(['plugin:mcp']),
        'disconnect'
      )
      expect(result).toHaveLength(1)
      expect(result[0].message).toBe('Server disconnected unexpectedly')
    })

    it('level filter can exclude otherwise matching entries', () => {
      const result = filterEntries(
        entries,
        new Set(['info']), // excludes debug
        new Set(['session']),
        ''
      )
      // session has debug + error, but only info level is active → 0
      expect(result).toHaveLength(0)
    })
  })
})
