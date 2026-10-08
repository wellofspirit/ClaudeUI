// Small helpers shared by the isolated and live runners: driving a session through the app,
// waiting on its state, the environment probe and the run log.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SEL, mutationsDuring, sleep } from './common.mjs'
import { pct, round } from './stats.mjs'

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

/** One line per S6 pass: user snap-backs, how far up the user got, whether it stayed up. */
export function logS6(label, episodes) {
  log(
    `  ${label} ${episodes
      .map((e) =>
        e.skipped
          ? `${e.episode}:skipped`
          : `${e.episode}:start=${e.startDist},sb=${e.snapBacks},up=${e.maxUserUpPx},stay=${e.stayedEscaped2s},mut=${e.framesWithMutations}${e.unpinnedStart ? ',UNPINNED' : ''}`
      )
      .join(' ')}`
  )
}

export function scaleConfigs(o) {
  const list = o.scales.map((ui) => ({ ui, chat: ui }))
  if (o.chatScale) list.push(o.chatScale)
  return list
}

export async function shot(win, out, name) {
  const p = join(out, `${name}.png`)
  await win.screenshot({ path: p }).catch(() => {})
  return p
}

/**
 * Measured vsync cadence (median rAF interval over 3 s) and whether `behavior: 'smooth'` animates
 * (frames a 3000 px smooth scroll of a scratch box takes).
 */
export async function measureRefresh(win) {
  const ts = await win.evaluate(() => window.__scrollBench.measureRaf(3000))
  const iv = ts.slice(1).map((t, i) => t - ts[i])
  const smoothFrames = await win.evaluate(
    () =>
      new Promise((resolve) => {
        const box = document.createElement('div')
        box.style.cssText =
          'position:fixed;left:-9999px;top:0;width:200px;height:200px;overflow:auto'
        box.innerHTML = '<div style="height:5000px"></div>'
        document.body.appendChild(box)
        let n = 0
        requestAnimationFrame(() => {
          box.scrollTo({ top: 3000, behavior: 'smooth' })
          const step = () => {
            n++
            if (box.scrollTop >= 2999 || n > 300) {
              box.remove()
              resolve(n)
            } else requestAnimationFrame(step)
          }
          requestAnimationFrame(step)
        })
      })
  )
  return {
    refreshMs: round(pct(iv, 50), 2),
    p5: round(pct(iv, 5), 2),
    p95: round(pct(iv, 95), 2),
    n: iv.length,
    smoothScrollFrames: smoothFrames,
    smoothScrollAnimates: smoothFrames > 2
  }
}

/**
 * Write a cwd-scoped allow-list so tools run with no approval and no auto-mode classifier. The
 * file must not exist yet: the bench only ever writes it into a directory it created.
 */
export function writeCwdPermissions(cwd, allow) {
  const file = join(cwd, '.claude', 'settings.local.json')
  if (existsSync(file)) throw new Error(`refusing to overwrite an existing ${file}`)
  mkdirSync(join(cwd, '.claude'), { recursive: true })
  writeFileSync(file, JSON.stringify({ permissions: { allow } }, null, 2), { flag: 'wx' })
}

/** Create a Claude session in `cwd` the way the welcome screen does, in `default` permission mode. */
export async function newSession(win, cwd, model) {
  const rid = randomUUID()
  const info = await win.evaluate(
    ({ rid, cwd, model }) => {
      const h = window.__claudeuiVerifier
      h.sessionStore.getState().createNewSession(rid, cwd, true)
      const st = h.sessionStore.getState()
      if (st.sessions[rid]?.selectedEngineId !== 'claude') st.setSelectedEngine('claude')
      h.sessionStore.getState().changePermissionMode(rid, 'default')
      if (model) h.sessionStore.getState().setSelectedModel(model)
      const s = h.sessionStore.getState().sessions[rid]
      return { rid, engine: s?.selectedEngineId, model: s?.selectedModel, mode: s?.permissionMode }
    },
    { rid, cwd, model }
  )
  await win.waitForSelector('[data-testid="InputBox.textarea"]', { timeout: 20_000 })
  return info
}

/** Type and send a prompt. It must be one line: the composer sends on Enter. */
export async function sendPrompt(win, text) {
  if (/[\r\n]/.test(text)) throw new Error('sendPrompt: prompts must be single-line')
  await win.click('[data-testid="InputBox.textarea"]')
  await win.keyboard.type(text, { delay: 0 })
  await win.click('[data-testid="InputBox.send"]')
}

export const runState = (win) =>
  win.evaluate(() => {
    const st = window.__claudeuiVerifier.sessionStore.getState()
    const s = st.sessions[st.activeSessionId]
    return {
      state: s?.status?.state,
      error: s?.status?.error ?? null,
      n: s?.messages?.length ?? 0,
      sid: s?.status?.sessionId ?? null,
      pendingApprovals: (s?.pendingApprovals ?? []).length
    }
  })

export async function waitIdle(win, timeoutMs = 600_000) {
  const t0 = Date.now()
  let s
  while (Date.now() - t0 < timeoutMs) {
    s = await runState(win)
    if (s.state !== 'running') return s
    await sleep(500)
  }
  return s
}

/** True while the chat transcript received DOM mutations in the last 1.5 s. */
export const chatIsStreaming = async (win) => (await mutationsDuring(win, SEL.scroller, 1500)) > 0

/** Wait until no chat mutation for 4 s and the session is idle. */
export async function waitForQuiet(win, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const quiet = (await mutationsDuring(win, SEL.scroller, 4000)) === 0
    if (quiet && (await runState(win)).state !== 'running') return true
  }
  return false
}
