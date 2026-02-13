import * as fs from 'fs'

const TAIL_SIZE = 8192 // 8KB

interface CacheEntry {
  mtime: number
  summary: string | null
}

const cache = new Map<string, CacheEntry>()

/**
 * Get the session summary for a JSONL file, using an mtime-based cache.
 * Returns the summary string or null if none found.
 */
export function getCachedSummary(filePath: string, mtime: number): string | null {
  const entry = cache.get(filePath)
  if (entry && entry.mtime === mtime) {
    return entry.summary
  }

  const summary = parseSessionSummary(filePath)
  cache.set(filePath, { mtime, summary })
  return summary
}

/**
 * Parse a session JSONL for summary entries.
 * Checks the last 8KB (tail) for the most recent summary, then falls back
 * to the first 30 lines (header) for resumed sessions with summary at line 0.
 */
function parseSessionSummary(filePath: string): string | null {
  // Try tail first — most recent summary wins
  const tailSummary = parseSummaryFromTail(filePath)
  if (tailSummary) return tailSummary

  // Fall back to header (first 30 lines) for resumed sessions
  return parseSummaryFromHeader(filePath)
}

function parseSummaryFromTail(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    let tail: string
    if (stat.size <= TAIL_SIZE) {
      tail = fs.readFileSync(filePath, 'utf-8')
    } else {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buf = Buffer.alloc(TAIL_SIZE)
        fs.readSync(fd, buf, 0, TAIL_SIZE, stat.size - TAIL_SIZE)
        tail = buf.toString('utf-8')
      } finally {
        fs.closeSync(fd)
      }
    }

    // Scan lines in reverse to find the last summary entry
    const lines = tail.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      // Quick check before parsing JSON
      if (!line.includes('"type":"summary"') && !line.includes('"type": "summary"')) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary) {
          return obj.summary
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error
  }
  return null
}

function parseSummaryFromHeader(filePath: string): string | null {
  try {
    // Read first ~4KB which should cover 30+ lines
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(4096)
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0)
      const header = buf.toString('utf-8', 0, bytesRead)
      const lines = header.split('\n')

      for (let i = 0; i < Math.min(lines.length, 30); i++) {
        const line = lines[i].trim()
        if (!line) continue
        if (!line.includes('"type":"summary"') && !line.includes('"type": "summary"')) continue
        try {
          const obj = JSON.parse(line)
          if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary) {
            return obj.summary
          }
        } catch {
          // Skip malformed lines
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // File read error
  }
  return null
}
