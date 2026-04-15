import { describe, it, expect } from 'vitest'
import { formatDuration } from '../utils'

describe('formatDuration', () => {
  it('formats under a minute', () => {
    expect(formatDuration(5000)).toBe('5s')
    expect(formatDuration(59000)).toBe('59s')
  })

  it('formats minutes', () => {
    expect(formatDuration(60000)).toBe('1m')
    expect(formatDuration(90000)).toBe('1m 30s')
    expect(formatDuration(3540000)).toBe('59m')
  })

  it('formats hours', () => {
    expect(formatDuration(3600000)).toBe('1h')
    expect(formatDuration(5400000)).toBe('1h 30m')
    expect(formatDuration(7200000)).toBe('2h')
  })

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0s')
  })
})
