/**
 * The `fetch` the HTTP judge sends with (ADR-081 §6): the shared proxy-aware
 * fetch in `services/net-fetch.ts`, which harness downloads use too.
 */
export { pickNetFetch as pickJudgeFetch } from '../../services/net-fetch'
