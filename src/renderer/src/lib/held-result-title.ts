/**
 * The notification title of `session:dispatch-result-held`. A media job's notice names the job
 * ("Image job finished", `media-jobs.ts`); an X-Agent's names the agent.
 */
export function heldResultTitle(name: string | undefined): string {
  if (name && /^(Image|Video) job (finished|stopped|failed)$/.test(name)) {
    return `${name} — result waiting`
  }
  return name ? `X-Agent ${name} finished — result waiting` : 'An X-Agent finished — result waiting'
}
