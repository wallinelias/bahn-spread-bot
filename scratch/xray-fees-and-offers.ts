import fs from "node:fs"
import { parseNoteFlags, windowFromNote } from "../bot.ts"

const DAY = 24 * 60

for (const path of ["scratch/xray_spread-4_reveal.json", "scratch/xray_spread-5_reveal.json"]) {
  const d = JSON.parse(fs.readFileSync(path, "utf8"))
  const { seed, events, reveal, snap, roster } = d
  console.log(`\n================ FEES / OFFERS / NOTES X-RAY: ${seed} ================`)
  const reqById = new Map<string, any>(reveal.requests.map((r: any) => [r.request.id, r]))
  const gigById = new Map<string, any>((snap.gigs ?? []).map((g: any) => [g.id, g]))
  const driverById = new Map<string, any>(roster.map((dr: any) => [dr.id, dr]))

  // 1. Check ALL ground-truth hidden note traps in reveal.orders
  console.log(`--- 1. ALL REVEAL ORDERS NOTE DIFFERENCES vs REQUEST ---`)
  let hoursMismatch = 0
  let noteDlCount = 0
  for (const ro of reveal.orders) {
    const req = reqById.get(ro.orderId)?.request
    if (!req) continue
    for (let i = 0; i < ro.legs.length; i++) {
      const rt = ro.legs[i]
      const rl = req.legs[i]
      if (rt.noteDeadline !== null) {
        noteDlCount++
        console.log(`  [noteDeadline=${rt.noteDeadline}] ${ro.orderId} L${i} note="${req.note?.text}" win=[${rl.pickup.window.from}..${rl.pickup.window.to}]`)
      }
      const pDiff = JSON.stringify(rt.pickupHours) !== JSON.stringify(rl.pickup.hours)
      const dDiff = JSON.stringify(rt.deliveryHours) !== JSON.stringify(rl.delivery.hours)
      if (pDiff || dDiff) {
        hoursMismatch++
        if (hoursMismatch <= 15) {
          console.log(
            `  [hoursDiff] ${ro.orderId} L${i} pDiff=${pDiff} dDiff=${dDiff} note="${req.note?.text}" | reqP=${JSON.stringify(rl.pickup.hours)} trueP=${JSON.stringify(rt.pickupHours)} | reqD=${JSON.stringify(rl.delivery.hours)} trueD=${JSON.stringify(rt.deliveryHours)}`,
          )
        }
      }
    }
  }
  console.log(`  Summary: noteDeadline count=${noteDlCount}, hoursMismatch count=${hoursMismatch}`)

  // 2. Check ALL fees vs views on single-order gigs: what initial fee/ref ratio booked vs didn't book?
  console.log(`\n--- 2. SINGLE-ORDER GIGS: INITIAL POST FEE vs FINAL BOOKED FEE ---`)
  const viewsByGig = new Map<string, any[]>()
  for (const v of reveal.views ?? []) {
    if (!viewsByGig.has(v.gigId)) viewsByGig.set(v.gigId, [])
    viewsByGig.get(v.gigId)!.push(v)
  }
  const bookEvs = events.filter((e: any) => e.kind === "gig_booked")
  const initialBins: Record<string, { gigs: number; v1Book: number; bookedFeeSum: number; v1FeeSum: number; refSum: number; drops: number }> = {
    "<0.85": { gigs: 0, v1Book: 0, bookedFeeSum: 0, v1FeeSum: 0, refSum: 0, drops: 0 },
    "0.85-0.95": { gigs: 0, v1Book: 0, bookedFeeSum: 0, v1FeeSum: 0, refSum: 0, drops: 0 },
    "0.95-1.05": { gigs: 0, v1Book: 0, bookedFeeSum: 0, v1FeeSum: 0, refSum: 0, drops: 0 },
    "1.05-1.20": { gigs: 0, v1Book: 0, bookedFeeSum: 0, v1FeeSum: 0, refSum: 0, drops: 0 },
    "1.20+": { gigs: 0, v1Book: 0, bookedFeeSum: 0, v1FeeSum: 0, refSum: 0, drops: 0 },
  }
  const dropGigIds = new Set(events.filter((e: any) => e.kind === "gig_dropped").map((e: any) => e.gigId))

  for (const b of bookEvs) {
    const gig = gigById.get(b.gigId)
    if (!gig) continue
    const views = (viewsByGig.get(b.gigId) ?? []).sort((x, y) => x.at - y.at)
    if (!views.length) continue
    const ref = gig.referenceFeeCents ?? reqById.get(gig.stops?.[0]?.orderId)?.request?.referenceFeeCents
    if (!ref) continue
    const v1Ratio = views[0].feeCents / ref
    const key = v1Ratio < 0.85 ? "<0.85" : v1Ratio < 0.95 ? "0.85-0.95" : v1Ratio < 1.05 ? "0.95-1.05" : v1Ratio < 1.2 ? "1.05-1.20" : "1.20+"
    const bin = initialBins[key]!
    bin.gigs++
    if (b.at - views[0].at <= 5) bin.v1Book++
    bin.v1FeeSum += views[0].feeCents
    bin.bookedFeeSum += b.feeCents ?? views[views.length - 1].feeCents
    bin.refSum += ref
    if (dropGigIds.has(b.gigId)) bin.drops++
  }
  for (const [k, s] of Object.entries(initialBins)) {
    console.log(
      `  InitRatio ${k.padEnd(10)}: gigs=${String(s.gigs).padStart(3)} instant=${String(s.v1Book).padStart(3)} (${s.gigs ? ((100 * s.v1Book) / s.gigs).toFixed(0) : 0}%) avgInit=${(s.v1FeeSum / Math.max(1, s.refSum)).toFixed(2)}x avgBooked=${(s.bookedFeeSum / Math.max(1, s.refSum)).toFixed(2)}x overV1=€${((s.bookedFeeSum - s.v1FeeSum) / 100).toFixed(0)} drops=${s.drops}`,
    )
  }

  // 3. Why did ALL direct offers fail? Inspect first 10 offer_answered events with gig & driver details
  const offers = events.filter((e: any) => e.kind === "offer_answered")
  console.log(`\n--- 3. DIRECT OFFERS BREAKDOWN (${offers.length}) ---`)
  const offerDeclinedGigs = new Map<string, number>()
  const offerDrivers = new Map<string, number>()
  for (const o of offers) {
    offerDeclinedGigs.set(o.gigId, (offerDeclinedGigs.get(o.gigId) ?? 0) + 1)
    offerDrivers.set(o.driverId, (offerDrivers.get(o.driverId) ?? 0) + 1)
  }
  console.log(`  Unique gigs offered=${offerDeclinedGigs.size}, unique drivers=${offerDrivers.size}`)
  for (const o of offers.slice(0, 8)) {
    const gig = gigById.get(o.gigId)
    const drv = driverById.get(o.driverId)
    const v = viewsByGig.get(o.gigId)?.[0]
    console.log(
      `  at=${o.at} gig=${o.gigId} stops=${gig?.stops?.map((s: any) => s.placeId).join("->")} ref=€${((gig?.referenceFeeCents ?? 0) / 100).toFixed(1)} v1Fee=€${((v?.feeCents ?? 0) / 100).toFixed(1)} drv=${o.driverId} home=${drv?.home} rate=${drv?.rateMultiplier ?? drv?.feeMultiplier ?? "?"} ans=${o.answer}`,
    )
  }

  // 4. Trade-in vs single-leg profitability!
  console.log(`\n--- 4. SINGLE-LEG vs TRADE-IN (2-LEG) ORDERS PROFITABILITY ---`)
  const stats = { leg1: { won: 0, late: 0, rev: 0, fee: 0, ref: 0 }, leg2: { won: 0, late: 0, rev: 0, fee: 0, ref: 0 } }
  for (const r of reveal.requests) {
    if (r.outcome !== "won") continue
    const k = r.request.legs.length > 1 ? "leg2" : "leg1"
    stats[k].won++
    stats[k].rev += r.quote?.[r.option] ?? 0
  }
  for (const e of events) {
    if (e.kind === "ledger" && e.line?.orderId) {
      const r = reqById.get(e.line.orderId)
      if (!r) continue
      const k = r.request.legs.length > 1 ? "leg2" : "leg1"
      if (e.line.kind === "driver_fee") stats[k].fee += Math.abs(e.line.cents)
      if (e.line.kind === "late_refund" || e.line.kind === "undelivered_penalty") {
        stats[k].late++
        stats[k].ref += Math.abs(e.line.cents)
      }
    }
  }
  for (const [k, s] of Object.entries(stats)) {
    console.log(
      `  ${k}: won=${s.won} late=${s.late} (${((100 * s.late) / Math.max(1, s.won)).toFixed(1)}%) rev=€${(s.rev / 100).toFixed(0)} fee=€${(s.fee / 100).toFixed(0)} lateRef=€${(s.ref / 100).toFixed(0)} net=€${((s.rev - s.fee - s.ref) / 100).toFixed(0)} (€${((s.rev - s.fee - s.ref) / 100 / Math.max(1, s.won)).toFixed(1)}/order)`,
    )
  }
}
