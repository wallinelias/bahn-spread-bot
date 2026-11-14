import fs from "node:fs"
import { Client, type DeskEventKind } from "../spread.ts"
import { QuantitativeDesk } from "../bot.ts"
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
  "forecast",
]

const client = new Client()
const map = await client.map()
const strategy = loadStrategy()

console.log("Using Strategy version:", strategy.version, "baseQuoteMultiplier:", strategy.baseQuoteMultiplier, "baseFeeMultiplier:", strategy.baseFeeMultiplier)

async function runSeedAndCollect(seed: string) {
  console.log(`[${seed}] Creating practice world...`)
  const run = await client.create(8, { seed, board: false })
  console.log(`[${seed}] World created: ${run.id}`)

  try {
    const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
    const desk = new QuantitativeDesk(run, 8, now, map, roster, strategy)

    while (desk.now < endsAt) {
      const day = Math.floor(desk.now / DAY)
      const midnight = (day + 1) * DAY
      const actions = desk.outbox.splice(0)
      const step = await run.advance({ untilEvent: WAKE_ON, max: Math.min(endsAt, midnight), actions })
      desk.readResults(actions, step.results)
      desk.now = step.now
      for (const event of step.events) await desk.handle(event)
    }

    console.log(`[${seed}] Simulation finished. Fetching score, snapshot, events, reveal...`)
    const [score, snap, ev, rev] = await Promise.all([
      run.score(),
      run.snapshot(),
      run.events(),
      run.reveal(),
    ])
    console.log(`[${seed}] Score: Margin €${(score.marginCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(1)}% | Won: ${score.wonOrders}`)

    await run.delete().catch(() => {})
    console.log(`[${seed}] Deleted practice world ${run.id}`)

    return { seed, worldId: run.id, score, snap, ev, rev }
  } catch (err: any) {
    await run.delete().catch(() => {})
    console.error(`[${seed}] Failed:`, err.message)
    throw err
  }
}

const seeds = ["spread-2", "spread-3", "spread-4", "spread-5"]
console.log(`Running analysis on seeds: ${seeds.join(", ")} concurrently...`)

const runsData = await Promise.all(seeds.map((s) => runSeedAndCollect(s)))
console.log("All seeds finished! Analyzing ground-truth telemetry...")

// =========================================================================
// 1. Visit Failed Analysis (spread-2, spread-3, spread-4, spread-5)
// =========================================================================
console.log("\n=======================================================")
console.log("1. VISIT FAILED EVENTS (spread-2, spread-3, spread-4, spread-5)")
console.log("=======================================================")

const allVisitFailures: any[] = []

for (const { seed, worldId, ev, rev, snap } of runsData) {
  const visitFailEvents = ev.filter((e) => e.kind === "visit_failed")
  console.log(`\nSeed ${seed} (${worldId}) - Total visit_failed: ${visitFailEvents.length}`)

  for (const vf of visitFailEvents) {
    const reqItem = rev.requests.find((r) => r.request.id === vf.orderId)
    const legIdx = vf.leg ?? 0
    const leg = reqItem?.request.legs[legIdx]
    const orderTruth = rev.orders.find((o) => o.orderId === vf.orderId)
    const legTruth = orderTruth?.legs[legIdx]

    const item = {
      seed,
      atMinute: vf.at,
      orderId: vf.orderId,
      leg: legIdx,
      reason: vf.reason,
      dealerId: reqItem?.request.dealerId,
      pickupPlace: leg?.pickup.placeId,
      deliveryPlace: leg?.delivery.placeId,
      noteText: reqItem?.request.note?.text ?? null,
      noteLang: reqItem?.request.note?.language ?? null,
      pickupWindow: leg?.pickup.window ?? null,
      pickupIsPrivate: leg?.pickup.privateAddress ?? false,
      truth: {
        readyAt: legTruth?.readyAt ?? null,
        releasedAt: legTruth?.releasedAt ?? null,
        pickupHours: legTruth?.pickupHours ?? null,
        deliveryHours: legTruth?.deliveryHours ?? null,
        noteDeadline: legTruth?.noteDeadline ?? null,
        manualGearbox: legTruth?.manualGearbox ?? null,
        needsPlates: legTruth?.needsPlates ?? null,
        summerTyres: legTruth?.summerTyres ?? null,
      },
    }
    allVisitFailures.push(item)
    console.log(
      `  [@min ${vf.at}] Order ${vf.orderId} (Leg ${legIdx}) Reason: ${vf.reason} | Note: "${item.noteText}" | Win: [${item.pickupWindow?.from}..${item.pickupWindow?.to}] | Truth: ready=${item.truth.readyAt}, released=${item.truth.releasedAt}, hours=${JSON.stringify(item.truth.pickupHours)}, noteDeadline=${item.truth.noteDeadline}`
    )
  }
}

// =========================================================================
// 2. Late Refund & Undelivered Penalty Analysis (spread-3, spread-4, spread-5)
// =========================================================================
console.log("\n=======================================================")
console.log("2. LATE REFUNDS & PENALTIES (spread-3, spread-4, spread-5)")
console.log("=======================================================")

const targetSeeds = runsData.filter((r) => ["spread-3", "spread-4", "spread-5"].includes(r.seed))
const allLateCases: any[] = []

for (const { seed, worldId, ev, rev, snap } of targetSeeds) {
  const lateLedgers = ev.filter(
    (e) => e.kind === "ledger" && (e.line.kind === "late_refund" || e.line.kind === "undelivered_penalty")
  )
  console.log(`\nSeed ${seed} (${worldId}) - Late / penalty ledger events: ${lateLedgers.length}`)

  for (const ll of lateLedgers) {
    const orderId = ll.line.orderId!
    const reqItem = rev.requests.find((r) => r.request.id === orderId)
    const ordSnap = snap.orders.find((o) => o.id === orderId)
    const ordTruth = rev.orders.find((o) => o.orderId === orderId)

    // Trace events for this order
    const orderEvents = ev.filter(
      (e) =>
        (e as any).orderId === orderId ||
        (e.kind === "ledger" && e.line.orderId === orderId) ||
        (snap.gigs.some((g) => g.id === (e as any).gigId && g.stops.some((s) => s.orderId === orderId)))
    )

    const wonEvent = ev.find((e) => e.kind === "order_won" && e.order.id === orderId)
    const wonAt = wonEvent?.at ?? reqItem?.request.respondBy ?? 0
    const deadline = ordSnap?.deadline ?? 0
    const deliveredEvent = ev.find((e) => e.kind === "delivered" && e.orderId === orderId)
    const deliveredAt = deliveredEvent?.at ?? null

    const drops = ev.filter((e) => e.kind === "gig_dropped" && snap.gigs.some((g) => g.id === e.gigId && g.stops.some((s) => s.orderId === orderId)))
    const visitFails = ev.filter((e) => e.kind === "visit_failed" && e.orderId === orderId)
    const deadlineClose = ev.filter((e) => e.kind === "deadline_close" && e.orderId === orderId)

    // Check first booking
    const bookEvents = ev.filter((e) => e.kind === "gig_booked" && snap.gigs.some((g) => g.id === e.gigId && g.stops.some((s) => s.orderId === orderId)))
    const firstBookedAt = bookEvents[0]?.at ?? null

    // Determine root cause
    let rootCause = "unbooked_until_late"
    if (visitFails.length > 0) rootCause = `visit_failed_${visitFails[0].reason}`
    else if (drops.length > 0) rootCause = `gig_dropped_${drops.length}x`
    else if (ordTruth?.legs.some((l) => l.noteDeadline && l.deliveredAt && l.deliveredAt > l.noteDeadline)) rootCause = "note_deadline_missed"
    else if (firstBookedAt !== null && firstBookedAt > deadline - 360) rootCause = "booked_too_late"

    const caseDetail = {
      seed,
      orderId,
      kind: ll.line.kind,
      cents: ll.line.cents,
      dealerId: reqItem?.request.dealerId,
      option: reqItem?.option,
      wonAt,
      deadline,
      deliveredAt,
      lateMinutes: deliveredAt && deadline ? Math.max(0, deliveredAt - deadline) : null,
      firstBookedAt,
      dropsCount: drops.length,
      visitFailedCount: visitFails.length,
      noteText: reqItem?.request.note?.text ?? null,
      noteDeadline: ordTruth?.legs[0]?.noteDeadline ?? null,
      rootCause,
      eventsSummary: orderEvents.map((e) => `@${e.at} ${e.kind} ${((e as any).line?.kind || (e as any).reason || "")}`).join("; "),
    }
    allLateCases.push(caseDetail)
    console.log(
      `  Order ${orderId}: ${ll.line.kind} (€${Math.abs(ll.line.cents / 100).toFixed(2)}) | Opt: ${caseDetail.option} | Won @${wonAt}, DDL @${deadline}, Del @${deliveredAt} (Late: ${caseDetail.lateMinutes}m) | Root Cause: ${rootCause} | Drops: ${drops.length}, VF: ${visitFails.length}`
    )
  }
}

// =========================================================================
// 3. spread-3 Win Rate & Quoting Deep Dive
// =========================================================================
console.log("\n=======================================================")
console.log("3. spread-3 WIN VS LOST DEEP DIVE")
console.log("=======================================================")

const s3 = runsData.find((r) => r.seed === "spread-3")!
const s3Rev = s3.rev

const totalRequests = s3Rev.requests.length
const quotedRequests = s3Rev.requests.filter((r) => r.quote !== null)
const wonRequests = s3Rev.requests.filter((r) => r.outcome === "won")
const lostRequests = s3Rev.requests.filter((r) => r.outcome === "lost")

console.log(`Total Requests on spread-3: ${totalRequests}`)
console.log(`Quoted Requests: ${quotedRequests.length}`)
console.log(`Won Requests: ${wonRequests.length} (${((wonRequests.length / quotedRequests.length) * 100).toFixed(1)}% win rate)`)
console.log(`Lost Requests: ${lostRequests.length}`)

// By Option Breakdown
const optionsBreakdown: Record<string, { won: number; lost: number; wonMults: number[]; lostMults: number[] }> = {
  same_day: { won: 0, lost: 0, wonMults: [], lostMults: [] },
  next_day: { won: 0, lost: 0, wonMults: [], lostMults: [] },
  within_3_days: { won: 0, lost: 0, wonMults: [], lostMults: [] },
}

for (const qr of quotedRequests) {
  for (const opt of qr.request.options) {
    const qPrice = qr.quote?.[opt.kind]
    if (qPrice && opt.listPriceCents) {
      const mult = qPrice / opt.listPriceCents
      if (qr.outcome === "won" && qr.option === opt.kind) {
        optionsBreakdown[opt.kind].won++
        optionsBreakdown[opt.kind].wonMults.push(mult)
      } else if (qr.outcome === "lost") {
        optionsBreakdown[opt.kind].lost++
        optionsBreakdown[opt.kind].lostMults.push(mult)
      }
    }
  }
}

console.log("\nOption Breakdown on spread-3:")
for (const [opt, data] of Object.entries(optionsBreakdown)) {
  const avgWonM = data.wonMults.length ? (data.wonMults.reduce((a, b) => a + b, 0) / data.wonMults.length).toFixed(3) : "N/A"
  const avgLostM = data.lostMults.length ? (data.lostMults.reduce((a, b) => a + b, 0) / data.lostMults.length).toFixed(3) : "N/A"
  console.log(`  ${opt.padEnd(15)} Won: ${String(data.won).padStart(3)} (Avg Mult: ${avgWonM}) | Lost Quotes: ${String(data.lost).padStart(3)} (Avg Mult: ${avgLostM})`)
}

// By Dealer Breakdown on spread-3
const dealerStats = new Map<string, { requests: number; won: number; lost: number; wonMults: number[]; lostMults: number[] }>()
for (const qr of quotedRequests) {
  const d = qr.request.dealerId
  if (!dealerStats.has(d)) dealerStats.set(d, { requests: 0, won: 0, lost: 0, wonMults: [], lostMults: [] })
  const ds = dealerStats.get(d)!
  ds.requests++
  if (qr.outcome === "won") {
    ds.won++
    const optObj = qr.request.options.find((o) => o.kind === qr.option)
    const qPrice = qr.quote?.[qr.option!]
    if (qPrice && optObj?.listPriceCents) ds.wonMults.push(qPrice / optObj.listPriceCents)
  } else if (qr.outcome === "lost") {
    ds.lost++
    for (const opt of qr.request.options) {
      const qPrice = qr.quote?.[opt.kind]
      if (qPrice && opt.listPriceCents) ds.lostMults.push(qPrice / opt.listPriceCents)
    }
  }
}

console.log("\nDealer Breakdown on spread-3 (Sorted by Requests):")
const sortedDealers = [...dealerStats.entries()].sort((a, b) => b[1].requests - a[1].requests)
for (const [dealer, stat] of sortedDealers.slice(0, 15)) {
  const wr = ((stat.won / stat.requests) * 100).toFixed(1)
  const avgWon = stat.wonMults.length ? (stat.wonMults.reduce((a, b) => a + b, 0) / stat.wonMults.length).toFixed(3) : "N/A"
  const avgLost = stat.lostMults.length ? (stat.lostMults.reduce((a, b) => a + b, 0) / stat.lostMults.length).toFixed(3) : "N/A"
  console.log(`  ${dealer.padEnd(6)} Reqs: ${String(stat.requests).padStart(3)} | Won: ${String(stat.won).padStart(2)} (${wr.padStart(4)}%) | Avg Won Mult: ${avgWon.padEnd(5)} | Avg Lost Mult: ${avgLost}`)
}

// Write out JSON report
const fullReport = {
  timestamp: new Date().toISOString(),
  strategyUsed: strategy,
  scores: runsData.map((r) => ({ seed: r.seed, worldId: r.worldId, score: r.score })),
  visitFailures: allVisitFailures,
  lateCases: allLateCases,
  spread3DeepDive: {
    totalRequests,
    quotedRequests: quotedRequests.length,
    wonRequests: wonRequests.length,
    lostRequests: lostRequests.length,
    optionsBreakdown,
    dealerStats: Object.fromEntries(dealerStats),
  },
}

fs.writeFileSync("scratch/ground_truth_report.json", JSON.stringify(fullReport, null, 2))
console.log("\nSaved complete ground-truth report to scratch/ground_truth_report.json")
