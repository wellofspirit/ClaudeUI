// TEST ONLY. Keeps the ChatGPT credential contract test hermetic: every model
// request opencode builds (session hook `http.request`, which receives the fully
// built web Request — core/src/session/model-request.ts) is recorded with the
// headers under test, then rewritten to the localhost fixture before it is sent.
// The loopback-only sandbox and the refusing proxy are the backstops if this
// hook ever misses a request.
import fs from 'node:fs'

const LOG = process.env.CONTRACT_REDIRECT_LOG
const TARGET = process.env.CONTRACT_FIXTURE_ORIGIN
const HEADERS = ['authorization', 'chatgpt-account-id', 'originator']

export default {
  id: 'claudeui-contract-chatgpt-redirect',
  setup: async (ctx) => {
    await ctx.session.hook('http.request', async (event) => {
      const request = event.request
      const url = new URL(request.url)
      const headers = Object.fromEntries(HEADERS.map((name) => [name, request.headers.get(name)]))
      if (LOG) fs.appendFileSync(LOG, JSON.stringify({ url: request.url, headers }) + '\n')
      if (!TARGET) return
      event.request = new Request(
        `${TARGET}/upstream/${url.host}${url.pathname}${url.search}`,
        request
      )
    })
  }
}
