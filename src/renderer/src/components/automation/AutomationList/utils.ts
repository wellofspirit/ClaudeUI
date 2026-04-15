export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSec = seconds % 60
  if (minutes < 60) return `${minutes}m${remainingSec > 0 ? ` ${remainingSec}s` : ''}`
  const hours = Math.floor(minutes / 60)
  const remainingMin = minutes % 60
  return `${hours}h${remainingMin > 0 ? ` ${remainingMin}m` : ''}`
}
