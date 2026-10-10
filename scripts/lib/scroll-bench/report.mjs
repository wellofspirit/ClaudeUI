// Compact markdown summary over the bench's result rows. Repeats are folded into mean ± sd
// (sample sd). Errored rows are never aggregated: they are counted and listed at the top.
// Unreadable values (null) print as "n/a", never as 0.
import { meanSd, round } from './stats.mjs'

const fmt = (values, d = 1) => {
  const { mean, sd, n } = meanSd(values)
  if (!n) return values.length && values.every((v) => v === null) ? 'n/a' : '–'
  return n > 1 ? `${round(mean, d)} ± ${round(sd, d)}` : `${round(mean, d)}`
}
const frac = (xs, pred) => `${xs.filter(pred).length}/${xs.length}`
const scaleLabel = (s) => (s.chat === s.ui ? `${s.ui}` : `${s.ui} (chat ${s.chat})`)
const tableRow = (cells) => `| ${cells.join(' | ')} |`
const header = (cols) => [tableRow(cols), `|${cols.map(() => '---').join('|')}|`]

function groupBy(rows, keyFn) {
  const m = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  }
  return m
}

/** A row failed if the scenario threw, or (older runs) a measurement window recorded an error. */
const failed = (r) => !!r.error || !!r.data?.error

export function renderSummary({ env, rows }) {
  const out = []
  out.push(`# Chat-scroll bench run`, '')
  const errors = rows.filter(failed)
  out.push(
    `Rows: ${rows.length} total, **${errors.length} errored (excluded from every table)**.`,
    ''
  )
  if (errors.length) {
    out.push('## Errors', '')
    for (const r of errors)
      out.push(`- ${r.source} ${scaleLabel(r.scale)} ${r.scenario}: ${r.error ?? r.data?.error}`)
    out.push('')
  }
  out.push('```json', JSON.stringify(env, null, 2), '```', '')
  const by = (sc) => rows.filter((r) => r.scenario === sc && !failed(r))

  const s1 = [...by('S1'), ...by('S5-S1').map((r) => ({ ...r, source: `${r.source} (mobile)` }))]
  if (s1.length) {
    out.push('## S1 scroll-to-bottom from the top', '')
    out.push(
      ...header([
        'source',
        'scale',
        'reps',
        'reached',
        'clicks',
        'final residual px',
        'click-1 residual px',
        'click-1 sh growth px',
        'stopped at frozen target (clicks)',
        'time to stop ms/click',
        'janky %',
        'trace dropped %'
      ])
    )
    for (const [, g] of groupBy(s1, (r) => `${r.source}|${scaleLabel(r.scale)}`)) {
      const d = g.map((r) => r.data)
      const clicks = d.flatMap((x) => x.clicks)
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g.length,
          frac(d, (x) => x.reached),
          fmt(d.map((x) => x.clicks.length)),
          fmt(d.map((x) => x.finalResidual)),
          fmt(d.map((x) => x.clicks[0]?.residual)),
          fmt(d.map((x) => x.clicks[0]?.shGrowth)),
          frac(clicks, (c) => c.stoppedAtFrozenTarget),
          fmt(
            clicks.map((c) => c.settleMs),
            0
          ),
          fmt(d.map((x) => x.frames.jankyPct)),
          fmt(d.map((x) => x.trace?.droppedPct ?? null))
        ])
      )
    }
    out.push('')
  }

  const s2 = [...by('S2'), ...by('S5-S2')]
  if (s2.length) {
    const flat = []
    for (const r of s2)
      for (const p of r.data.passes)
        for (const s of p.steps)
          flat.push({
            source: `${r.source}${r.scenario === 'S5-S2' ? ' (mobile)' : ''}`,
            scale: r.scale,
            pass: p.pass,
            ...s
          })
    // A step whose input did not scroll the chat measured an idle page: excluded and counted.
    const idle = (s) => !(Math.abs(s.scrolledPx ?? 0) >= 5)
    const excluded = flat.filter(idle).length
    out.push('## S2 wheel / gesture / touch scroll through the middle', '')
    out.push(
      `${excluded} of ${flat.length} steps moved < 5 px (input did not scroll the chat) and are excluded below.`,
      ''
    )
    out.push(
      ...header([
        'source',
        'scale',
        'pass',
        'step',
        'reps (excluded)',
        'rAF p95 ms',
        'janky %',
        'LoAF n',
        'LoAF script ms',
        'LoAF style+layout+paint ms',
        'Layout ms (CDP)',
        'Style ms (CDP)',
        'trace dropped %',
        'janky scroll updates',
        'sh delta px'
      ])
    )
    for (const [, all] of groupBy(
      flat,
      (r) => `${r.source}|${scaleLabel(r.scale)}|${r.pass}|${r.step}`
    )) {
      const g = all.filter((s) => !idle(s))
      out.push(
        tableRow([
          all[0].source,
          scaleLabel(all[0].scale),
          all[0].pass,
          all[0].step,
          `${g.length} (${all.length - g.length})`,
          fmt(g.map((x) => x.frames.p95)),
          fmt(g.map((x) => x.frames.jankyPct)),
          fmt(g.map((x) => x.loaf.count)),
          fmt(
            g.map((x) => x.loaf.scriptMs),
            0
          ),
          fmt(
            g.map((x) => x.loaf.styleLayoutPaintMs),
            0
          ),
          fmt(
            g.map((x) => x.metrics.LayoutDurationMs),
            0
          ),
          fmt(
            g.map((x) => x.metrics.RecalcStyleDurationMs),
            0
          ),
          fmt(g.map((x) => x.trace?.droppedPct ?? null)),
          fmt(g.map((x) => x.trace?.jankyScrollUpdates ?? null)),
          fmt(
            g.map((x) => x.shDelta),
            0
          )
        ])
      )
    }
    out.push('')
  }

  const s3 = by('S3')
  if (s3.length) {
    out.push('## S3 jumps', '')
    out.push(
      ...header([
        'source',
        'scale',
        'reps',
        'jump',
        'time-to-stable ms',
        'sh delta px',
        'scrollTop drift px',
        'anchor shift px',
        'thumb ratio set → settled',
        'janky %'
      ])
    )
    const flat = s3.flatMap((r) =>
      r.data.jumps.map((j) => ({ source: r.source, scale: r.scale, ...j }))
    )
    for (const [, g] of groupBy(flat, (r) => `${r.source}|${scaleLabel(r.scale)}|${r.frac}`))
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g.length,
          g[0].frac,
          fmt(
            g.map((x) => x.timeToStableMs),
            0
          ),
          fmt(
            g.map((x) => x.shDelta),
            0
          ),
          fmt(
            g.map((x) => x.stDrift),
            0
          ),
          fmt(
            g.map((x) => x.anchorShiftPx),
            0
          ),
          `${fmt(
            g.map((x) => x.thumbRatioSet),
            3
          )} → ${fmt(
            g.map((x) => x.thumbRatioSettled),
            3
          )}`,
          fmt(g.map((x) => x.frames.jankyPct))
        ])
      )
    out.push('', '### S3 find-in-chat', '')
    out.push(
      ...header([
        'source',
        'scale',
        'reps',
        'term',
        'matches',
        'steps',
        'time to stable ms',
        'settled',
        'wholly visible',
        'elementFromPoint hit',
        'moves after Enter',
        'janky %'
      ])
    )
    for (const [, g] of groupBy(s3, (r) => `${r.source}|${scaleLabel(r.scale)}`)) {
      const steps = g.flatMap((r) => r.data.find.steps)
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g.length,
          g[0].data.find.term,
          fmt(
            g.map((r) => r.data.find.totalMatches),
            0
          ),
          steps.length,
          fmt(
            steps.map((s) => s.stableMs),
            0
          ),
          frac(steps, (s) => s.settled),
          frac(steps, (s) => s.whollyVisible),
          frac(steps, (s) => s.elementFromPointHit),
          fmt(steps.map((s) => s.moves)),
          fmt(steps.map((s) => s.frames?.jankyPct))
        ])
      )
    }
    out.push('')
  }

  // Warm-up turns only grow the session; they are never reported. A turn whose first frame was not
  // really following (off the bottom, or a readable follow state that is off) is excluded too.
  const s4all = by('S4').filter((r) => !r.data.warmup)
  const s4 = s4all.filter((r) => !r.data.notFollowingAtStart)
  if (s4all.length) {
    out.push('## S4 streaming auto-scroll (no input; warm-up turns excluded)', '')
    out.push(
      `${s4all.length - s4.length} of ${s4all.length} turns did not start following and are excluded below.`,
      ''
    )
    out.push(
      ...header([
        'source',
        'scale',
        'turns',
        'running frames',
        'TI present frames',
        'TI not fully visible %',
        'TI fully hidden %',
        'dist max px',
        'dist p95',
        'frames dist>2 %',
        'episodes ≥250 ms',
        'of which layout-only residual',
        'stuck ms (layout residual)',
        'longest ms',
        'follow-off frames',
        'janky %'
      ])
    )
    for (const [, g] of groupBy(s4, (r) => `${r.source}|${scaleLabel(r.scale)}`)) {
      // Full-resolution summaries, computed before the stored trace was thinned.
      const d = g.map((r) => r.data.drift)
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g.length,
          fmt(
            d.map((x) => x.runningFrames),
            0
          ),
          fmt(
            d.map((x) => x.tiPresentFrames),
            0
          ),
          fmt(d.map((x) => x.tiNotFullyVisiblePct)),
          fmt(d.map((x) => x.tiFullyHiddenPct)),
          fmt(
            d.map((x) => x.distMax),
            0
          ),
          fmt(
            d.map((x) => x.distP95),
            0
          ),
          fmt(d.map((x) => x.distOver2Pct)),
          fmt(d.map((x) => x.episodesOver250ms)),
          fmt(d.map((x) => x.longEpisodesLayoutResidual ?? null)),
          fmt(
            d.map((x) => x.stuckMsLayoutResidual ?? null),
            0
          ),
          fmt(
            d.map((x) => x.longestEpisodeMs),
            0
          ),
          fmt(
            d.map((x) => x.autoScrollDisarmedFrames ?? null),
            0
          ),
          fmt(g.map((r) => r.data.frames.jankyPct))
        ])
      )
    }
    out.push('')
  }

  const s6 = by('S6')
  if (s6.length) {
    const all = s6.flatMap((r) =>
      r.data.episodes
        .filter((e) => !e.skipped)
        .map((e) => ({ source: r.source, scale: r.scale, mode: r.data.mode, ...e }))
    )
    const unpinned = all.filter((e) => e.unpinnedStart)
    const stopped = all.filter((e) => !e.unpinnedStart && e.streamStopped)
    const skipped = s6.flatMap((r) => r.data.episodes.filter((e) => e.skipped)).length
    out.push('## S6 scroll up while content streams', '')
    out.push(
      `${unpinned.length} of ${all.length} episodes did not start really following (first frame >= 10 px from the bottom, or follow state off), ${stopped.length} saw no streaming during the episode, and ${skipped} were skipped (stream ended before the episode); all are excluded below.`,
      ''
    )
    out.push(
      ...header([
        'source',
        'scale',
        'mode',
        'episode',
        'reps',
        'start dist px',
        'user snap-backs',
        'max user-up px',
        'wholly overridden',
        'stayed escaped ≥2 s',
        'final dist px',
        'frames w/ mutations',
        'main running frames'
      ])
    )
    const kept = all.filter((e) => !e.unpinnedStart && !e.streamStopped)
    for (const [, g] of groupBy(
      kept,
      (r) => `${r.source}|${scaleLabel(r.scale)}|${r.mode}|${r.episode}`
    ))
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g[0].mode,
          g[0].episode,
          g.length,
          fmt(g.map((x) => x.startDist ?? null)),
          fmt(g.map((x) => x.snapBacks)),
          fmt(
            g.map((x) => x.maxUserUpPx),
            0
          ),
          frac(g, (x) => x.overridden),
          frac(g, (x) => x.stayedEscaped2s),
          fmt(
            g.map((x) => x.finalDist),
            0
          ),
          fmt(
            g.map((x) => x.framesWithMutations),
            0
          ),
          fmt(
            g.map((x) => x.mainRunningFrames),
            0
          )
        ])
      )
    out.push('')
  }

  const s7all = by('S7')
  const s7 = s7all.filter((r) => !r.data.notFollowingAtStart)
  if (s7all.length) {
    out.push('## S7 subagent detail panel (TaskEntry) following', '')
    out.push(
      `${s7all.length - s7.length} of ${s7all.length} watches did not start following and are excluded below.`,
      ''
    )
    out.push(
      ...header([
        'source',
        'scale',
        'reps',
        'follow source',
        'frames below bottom %',
        'max px below',
        'episodes ≥250 ms',
        'longest ms',
        'follow flips w/o input',
        'button shown after scroll-up',
        'reached bottom',
        'stayed at bottom',
        'following at end'
      ])
    )
    for (const [, g] of groupBy(s7, (r) => `${r.source}|${scaleLabel(r.scale)}`)) {
      const w = g.map((r) => r.data.watch)
      const b = g.map((r) => r.data.button).filter(Boolean)
      out.push(
        tableRow([
          g[0].source,
          scaleLabel(g[0].scale),
          g.length,
          g[0].data.followSource ?? 'n/a',
          fmt(w.map((x) => x.framesBelowBottomPct)),
          fmt(
            w.map((x) => x.distMax),
            0
          ),
          fmt(w.map((x) => x.episodesOver250ms)),
          fmt(
            w.map((x) => x.longestEpisodeMs),
            0
          ),
          fmt(w.map((x) => x.followingFlipsWithoutInput ?? null)),
          frac(b, (x) => x.buttonShownAfterScrollUp),
          frac(b, (x) => x.reached),
          frac(b, (x) => x.stayedAtBottomAfterReach),
          b.some((x) => x.followingAtEnd !== null) ? frac(b, (x) => x.followingAtEnd === 1) : 'n/a'
        ])
      )
    }
    out.push('')
  }

  const cal = by('E')
  if (cal.length) {
    out.push('## E height-estimate calibration (estimate / actual, wrapper CSS px)', '')
    out.push(
      ...header([
        'source',
        'scale',
        'estimate',
        'messages',
        'ratio p10',
        'p50',
        'p90',
        '% in [0.7, 1.4]',
        '% in [0.5, 2]',
        'total est px',
        'total actual px'
      ])
    )
    for (const r of cal) {
      const st = r.data.stats
      out.push(
        tableRow([
          r.source,
          scaleLabel(r.scale),
          r.data.estimateSource,
          st.n,
          st.p10,
          st.p50,
          st.p90,
          st.within07to14Pct,
          st.within05to2Pct,
          st.totalEst,
          st.totalActual
        ])
      )
    }
    out.push('', '### E worst 15 outliers per session x scale (content-free shape)', '')
    out.push(...header(['source', 'scale', 'msg #', 'est', 'actual', 'ratio', 'role', 'shape']))
    for (const r of cal)
      for (const o of r.data.outliers) {
        const ids = Object.entries(o.shape.testids)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([k, v]) => `${k}×${v}`)
          .join(', ')
        const tags = Object.entries(o.shape.tags)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}×${v}`)
          .join(' ')
        out.push(
          tableRow([
            r.source,
            scaleLabel(r.scale),
            o.i,
            o.est,
            o.actual,
            o.ratio,
            o.shape.role ?? 'n/a',
            [ids, tags].filter(Boolean).join('; ') || '–'
          ])
        )
      }
    out.push('')
  }

  const heights = by('heights')
  if (heights.length) {
    out.push('## Real message heights vs the 100 px placeholder', '')
    out.push(
      ...header([
        'source',
        'scale',
        'messages',
        'p10',
        'p50',
        'p90',
        'max',
        'mean',
        'real total px',
        'placeholder total px',
        'ratio'
      ])
    )
    for (const r of heights) {
      const h = r.data
      out.push(
        tableRow([
          r.source,
          scaleLabel(r.scale),
          h.n,
          h.p10,
          h.p50,
          h.p90,
          h.max,
          h.mean,
          h.total,
          h.placeholderTotal,
          h.ratio
        ])
      )
    }
    out.push('')
  }
  return out.join('\n')
}
