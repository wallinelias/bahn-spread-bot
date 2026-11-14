import fs from "node:fs"
import { Client, type DeskEventKind } from "../spread.ts"
import { Top10IntegratedDesk, getTop10DeskOptions } from "../top10-engine.ts"
import { loadStrategy } from "../strategy-config.ts"

const DAY = 24 * 60
const WAKE_ON: DeskEventKind[] = [
  "price_request",
  "order_won",
  "order_lost",
  "order_changed",
  "order_cancelled",
  "visit_failed",
  "gig_expired",
  "gig_dropped",
  "no_show",
  "driver_late",
  "deadline_close",
]

const strategy = loadStrategy()
const client = new Client()
const map = await client.map()

async function captureSeed(seed: string) {
  const outPath = `scratch/xray_${seed.replace(/[^a-z0-9_-]/gi, "")}_reveal.json`
  console.log(`[${seed}] Creating practice world with Champion v${strategy.version}...`)
  const run = await client.create(8, { seed, board: false })
  console.log(`[${seed}] World created: ${run.id}`)
  try {
    const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
    const desk = new Top10IntegratedDesk(run, 8, now, map, roster, strategy, getTop10DeskOptions(strategy))
    while (desk.now < endsAt) {
      const day = Math.floor(desk.now / DAY)
      const midnight = (day + 1) * DAY
      const actions = desk.outbox.splice(0)
      const step = await run.advance({
        untilEvent: WAKE_ON,
        max: Math.min(endsAt, midnight),
        actions,
      })
      desk.readResults(actions, step.results)
      desk.now = step.now
      for (const event of step.events) {
        await desk.handle(event)
      }
    }
    desk.finalizeTelemetry()
    const [score, snap, events, reveal] = await Promise.all([
      run.score(),
      run.snapshot(),
      run.events(),
      run.reveal(),
    ])
    const payload = {
      seed,
      worldId: run.id,
      strategyVersion: strategy.version,
      score,
      telemetry: desk.telemetry,
      snap,
      events,
      reveal,
      map,
      roster,
    }
    fs.writeFileSync(outPath, JSON.stringify(payload))
    console.log(
      `[${seed}] Saved ${outPath} | Margin €${(score.marginCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(2)}% | Won ${score.wonOrders} | Ranked=${score.ranked}`,
    )
    console.log(`[${seed}] reveal keys: ${Object.keys(reveal).join(", ")}`)
    const eventCounts: Record<string, number> = {}
    for (const e of events) eventCounts[e.kind] = (eventCounts[e.kind] ?? 0) + 1
    console.log(`[${seed}] event kinds: ${JSON.stringify(eventCounts)}`)
  } finally {
    await run.delete().catch(() => {})
    console.log(`[${seed}] Deleted world ${run.id}`)
  }
}

await Promise.all([captureSeed("spread-4"), captureSeed("spread-5")])
