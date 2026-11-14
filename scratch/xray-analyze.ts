import fs from "node:fs"
import { parseNoteFlags, windowFromNote } from "../bot.ts"

const DAY = 24 * 60
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
function fmtTime(m: number | null | undefined): string {
  if (m === null || m === undefined) return "null"
  const d = Math.floor(m / DAY)
  const rem = ((m % DAY) + DAY) % DAY
  const hh = String(Math.floor(rem / 60)).padStart(2, "0")
  const mm = String(rem % 60).padStart(2, "0")
  return `${DAYS[d] ?? `D${d}`} ${hh}:${mm}`
}

function analyzeFile(path: string) {
  const data = JSON.parse(fs.readFileSync(path, "utf8"))
  const { seed, score, telemetry, snap, events, reveal, map, roster } = data

  console.log(`\n======================================================================`)
  console.log(`X-RAY REPORT: ${seed} (v${data.strategyVersion})`)
  console.log(
    `Score: Margin €${(score.marginCents / 100).toFixed(2)} | Revenue €${(score.revenueCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(2)}% | Undeliv ${(score.undeliveredShare * 100).toFixed(2)}% | Won ${score.wonOrders} | Ranked=${score.ranked}`,
  )
  console.log(`Ledger:`, JSON.stringify(telemetry?.ledgerBreakdownCents ?? {}))

  // Index helpers
  const distKm = new Map<string, number>()
  for (const e of map.roads ?? map.edges ?? []) {
    const a = e.from ?? e.a
    const b = e.to ?? e.b
    const km = e.km ?? e.distanceKm ?? 0
    distKm.set(`${a}->${b}`, km)
    distKm.set(`${b}->${a}`, km)
  }
  const driverById = new Map<string, any>(roster.map((d: any) => [d.id, d]))
  const reqById = new Map<string, any>(reveal.requests.map((r: any) => [r.request.id, r]))
  const truthById = new Map<string, any>(reveal.orders.map((o: any) => [o.orderId, o]))
  const gigById = new Map<string, any>((snap.gigs ?? []).map((g: any) => [g.id, g]))
  const orderById = new Map<string, any>((snap.orders ?? []).map((o: any) => [o.id, o]))

  // Sample event schemas once
  const sampleKinds = ["gig_booked", "gig_dropped", "offer_answered", "visit_failed", "release", "order_won"]
  for (const k of sampleKinds) {
    const ev = events.find((e: any) => e.kind === k)
    if (ev && seed === "spread-4") console.log(`  [schema ${k}]:`, JSON.stringify(ev))
  }

  // 1. VISIT FAILURES
  const visitFails = events.filter((e: any) => e.kind === "visit_failed")
  console.log(`\n--- 1. VISIT FAILURES (${visitFails.length}) ---`)
  for (const vf of visitFails) {
    const r = reqById.get(vf.orderId)
    const t = truthById.get(vf.orderId)
    const legIdx = vf.leg ?? 0
    const leg = r?.request?.legs?.[legIdx]
    const lt = t?.legs?.[legIdx]
    console.log(
      `  [${fmtTime(vf.at)}] ${vf.orderId} leg=${legIdx} kind=${vf.visit ?? "?"} reason=${vf.reason} dealer=${r?.request?.dealerId} ${leg?.pickup?.placeId}->${leg?.delivery?.placeId} note="${r?.request?.note?.text ?? ""}" win=[${fmtTime(leg?.pickup?.window?.from)}..${fmtTime(leg?.pickup?.window?.to)}] readyAt=${fmtTime(lt?.readyAt)} relAt=${fmtTime(lt?.releasedAt)} noteDeadline=${fmtTime(lt?.noteDeadline)} pHours=${JSON.stringify(lt?.pickupHours)} dHours=${JSON.stringify(lt?.deliveryHours)} plates=${lt?.needsPlates} manual=${lt?.manualGearbox} summer=${lt?.summerTyres}`,
    )
  }

  // 2. LATE DELIVERIES & UNDELIVERED PENALTIES
  const lateLedgers = events.filter(
    (e: any) => e.kind === "ledger" && (e.line?.kind === "late_refund" || e.line?.kind === "undelivered_penalty"),
  )
  console.log(`\n--- 2. LATE REFUNDS & UNDELIVERED (${lateLedgers.length}) ---`)
  const causeCounts: Record<string, number> = {}
  const lateDealerIds = new Map<string, number[]>()
  for (const ll of lateLedgers) {
    const oid = ll.line.orderId
    const r = reqById.get(oid)
    const oSnap = orderById.get(oid)
    const t = truthById.get(oid)
    const wonEv = events.find((e: any) => e.kind === "order_won" && e.order?.id === oid)
    const delivEv = events.find((e: any) => e.kind === "delivered" && e.orderId === oid)
    const pickEv = events.find((e: any) => e.kind === "picked_up" && e.orderId === oid)
    const relGigs = (snap.gigs ?? []).filter((g: any) => g.stops?.some((s: any) => s.orderId === oid))
    const relGigIds = new Set(relGigs.map((g: any) => g.id))
    const bookEvs = events.filter((e: any) => e.kind === "gig_booked" && relGigIds.has(e.gigId))
    const dropEvs = events.filter((e: any) => e.kind === "gig_dropped" && relGigIds.has(e.gigId))
    const expEvs = events.filter((e: any) => e.kind === "gig_expired" && relGigIds.has(e.gigId))
    const vfEvs = events.filter((e: any) => e.kind === "visit_failed" && e.orderId === oid)
    const relEvs = events.filter((e: any) => e.kind === "release" && e.orderId === oid)

    const wonAt = wonEv?.at ?? r?.request?.respondBy
    const deadline = oSnap?.deadline ?? wonEv?.order?.deadline
    const delivAt = delivEv?.at ?? null
    const pickAt = pickEv?.at ?? null
    const firstBookAt = bookEvs[0]?.at ?? null
    const lateMin = delivAt && deadline ? delivAt - deadline : null
    const leg0 = r?.request?.legs?.[0]
    const lt0 = t?.legs?.[0]
    const totalKm = relGigs.reduce((a: number, g: any) => a + (g.km ?? 0), 0)
    const hasMultiStop = relGigs.some((g: any) => (g.stops?.length ?? 0) > 2)

    let cause = "unknown"
    if (ll.line.kind === "undelivered_penalty") cause = "undelivered"
    else if (vfEvs.length > 0) cause = `visit_failed_${vfEvs[0].reason}`
    else if (dropEvs.length > 0) cause = `gig_dropped_${dropEvs.length}x`
    else if (lt0?.noteDeadline && wonEv && delivAt && delivAt > lt0.noteDeadline && (!deadline || delivAt <= deadline))
      cause = "note_deadline_missed"
    else if (firstBookAt === null) cause = "never_booked"
    else if (deadline && firstBookAt - wonAt > 240 && deadline - firstBookAt < 480) cause = "slow_to_book_driver_shortage"
    else if (pickAt && deadline && deadline - pickAt < 240) cause = "picked_up_too_late"
    else if (delivAt && pickAt && delivAt - pickAt > 600) cause = "slow_transit_or_delivery_hours_closed"
    else cause = "deadline_tight"

    causeCounts[cause] = (causeCounts[cause] ?? 0) + 1
    const did = r?.request?.dealerId ?? "?"
    if (!lateDealerIds.has(did)) lateDealerIds.set(did, [])
    lateDealerIds.get(did)!.push(delivAt ?? ll.at)

    console.log(
      `  [${ll.line.kind} €${(ll.line.cents / 100).toFixed(2)}] ${oid} ${did} opt=${r?.option} ${leg0?.pickup?.placeId}->${leg0?.delivery?.placeId} won=${fmtTime(wonAt)} dl=${fmtTime(deadline)} pick=${fmtTime(pickAt)} del=${fmtTime(delivAt)} (+${lateMin ?? "?"}m) book=${fmtTime(firstBookAt)} drops=${dropEvs.length} exp=${expEvs.length} vf=${vfEvs.length} rel=${relEvs.length} chain=${hasMultiStop} cause=${cause} note="${r?.request?.note?.text ?? ""}"`,
    )
  }
  console.log(`  Late causes summary:`, JSON.stringify(causeCounts))

  // 3. DRIVER BOOKING & OVERPAYMENT X-RAY (reveal.views vs gig_booked)
  const bookEvents = events.filter((e: any) => e.kind === "gig_booked")
  const viewsByGig = new Map<string, any[]>()
  for (const v of reveal.views ?? []) {
    if (!viewsByGig.has(v.gigId)) viewsByGig.set(v.gigId, [])
    viewsByGig.get(v.gigId)!.push(v)
  }
  for (const arr of viewsByGig.values()) arr.sort((a, b) => a.at - b.at)

  // Map ledger driver_fee per orderId/gigId
  const driverFeeLedgerByOrder = new Map<string, number>()
  for (const e of events) {
    if (e.kind === "ledger" && e.line?.kind === "driver_fee" && e.line?.orderId) {
      driverFeeLedgerByOrder.set(e.line.orderId, (driverFeeLedgerByOrder.get(e.line.orderId) ?? 0) + Math.abs(e.line.cents))
    }
  }

  let totalBookedFeeKnown = 0
  let totalFirstViewFee = 0
  let gigsWithViews = 0
  let instantView1Bookings = 0
  let delayedViewToBookGigs = 0
  let totalWaitAfterFirstViewMin = 0
  let refRatioBins = { lt100: 0, r100_110: 0, r110_125: 0, r125_145: 0, gt145: 0 }

  for (const b of bookEvents) {
    const gig = gigById.get(b.gigId)
    const views = viewsByGig.get(b.gigId) ?? []
    const bookView = views.find((v) => v.driverId === b.driverId && Math.abs(v.at - b.at) <= 1) ?? views[views.length - 1]
    const firstView = views[0]
    const refCents = gig?.referenceFeeCents ?? (gig?.stops?.[0]?.orderId ? reqById.get(gig.stops[0].orderId)?.request?.referenceFeeCents : null)
    if (firstView && bookView) {
      gigsWithViews++
      totalFirstViewFee += firstView.feeCents
      totalBookedFeeKnown += bookView.feeCents
      if (bookView.at - firstView.at <= 1) instantView1Bookings++
      else delayedViewToBookGigs++
      totalWaitAfterFirstViewMin += Math.max(0, bookView.at - firstView.at)
    }
    if (bookView && refCents) {
      const ratio = bookView.feeCents / refCents
      if (ratio < 1.0) refRatioBins.lt100++
      else if (ratio < 1.1) refRatioBins.r100_110++
      else if (ratio < 1.25) refRatioBins.r110_125++
      else if (ratio < 1.45) refRatioBins.r125_145++
      else refRatioBins.gt145++
    }
  }
  console.log(`\n--- 3. DRIVER BOOKING & OVERPAYMENT X-RAY ---`)
  console.log(
    `  Booked=${bookEvents.length}, WithViews=${gigsWithViews}, InstantV1=${instantView1Bookings}, DelayedAfterV1=${delayedViewToBookGigs}, AvgWaitAfterFirstView=${gigsWithViews ? (totalWaitAfterFirstViewMin / gigsWithViews).toFixed(1) : 0}m`,
  )
  console.log(
    `  BookedFeeSum=€${(totalBookedFeeKnown / 100).toFixed(2)} vs FirstViewFeeSum=€${(totalFirstViewFee / 100).toFixed(2)} | FeeEscalationAboveV1=€${((totalBookedFeeKnown - totalFirstViewFee) / 100).toFixed(2)}`,
  )
  console.log(`  Booked/RefFee bins:`, JSON.stringify(refRatioBins))

  // 4. DIRECT OFFERS X-RAY
  const offerAns = events.filter((e: any) => e.kind === "offer_answered")
  const offerAccepted = offerAns.filter((e: any) => e.accepted)
  console.log(`\n--- 4. DIRECT OFFERS (${offerAns.length} answered, ${offerAccepted.length} accepted = ${offerAns.length ? ((100 * offerAccepted.length) / offerAns.length).toFixed(2) : 0}%) ---`)
  for (const oa of offerAccepted) {
    const gig = gigById.get(oa.gigId)
    const drv = driverById.get(oa.driverId)
    console.log(`  [ACCEPTED] ${fmtTime(oa.at)} gig=${oa.gigId} drv=${oa.driverId} home=${drv?.home ?? "?"} fee=€${((oa.feeCents ?? 0) / 100).toFixed(2)} stops=${gig?.stops?.map((s: any) => `${s.placeId}(${s.kind})`).join("->")}`)
  }

  // 5. EV < 200 KM WITH CHARGING AUDIT + NOTE AUDIT
  let evUnder200Charged = 0
  let evUnder200Total = 0
  for (const r of reveal.requests) {
    if (r.outcome !== "won") continue
    const leg = r.request.legs[0]
    const km = distKm.get(`${leg.pickup.placeId}->${leg.delivery.placeId}`) ?? 0
    if (leg.car?.electric && leg.car?.chargePercent !== null && leg.car.chargePercent < 30 && km <= 200) {
      evUnder200Total++
      const g = (snap.gigs ?? []).find((gg: any) => gg.stops?.some((s: any) => s.orderId === r.request.id))
      if (g?.stops?.some((s: any) => s.withCharging)) evUnder200Charged++
    }
  }
  console.log(`\n--- 5. EV <=200km CHARGING BUG CHECK ---`)
  console.log(`  Won EV <30% & <=200km: ${evUnder200Total}, wrongly given withCharging=true: ${evUnder200Charged}`)

  // 6. QUOTES, WON vs LOST vs UNQUOTED FRONTIER
  const buckets = [
    { name: "<1.20", min: 0, max: 1.2 },
    { name: "1.20-1.30", min: 1.2, max: 1.3 },
    { name: "1.30-1.38", min: 1.3, max: 1.38 },
    { name: "1.38-1.46", min: 1.38, max: 1.46 },
    { name: "1.46-1.58", min: 1.46, max: 1.58 },
    { name: "1.58+", min: 1.58, max: 99 },
  ]
  const bStats = buckets.map((b) => ({ ...b, total: 0, won: 0, lost: 0 }))
  let unquotedCount = 0
  let unquotedByOpt: Record<string, number> = {}
  let unquotedSpreadSumCents = 0
  let wonSameDay = 0,
    wonNextDay = 0,
    won3Day = 0
  let wonRev = 0
  for (const r of reveal.requests) {
    if (r.outcome === "unquoted") {
      unquotedCount++
      const bestOpt = r.request.options?.[r.request.options.length - 1]
      if (bestOpt) {
        unquotedByOpt[bestOpt.kind] = (unquotedByOpt[bestOpt.kind] ?? 0) + 1
        unquotedSpreadSumCents += bestOpt.listPriceCents - r.request.referenceFeeCents
      }
      continue
    }
    const chosenOptName = r.option ?? Object.keys(r.quote ?? {})[0]
    const optObj = r.request.options?.find((o: any) => o.kind === chosenOptName) ?? r.request.options?.[0]
    const quotedCents = optObj ? r.quote?.[optObj.kind] : null
    if (!optObj || !quotedCents) continue
    const mult = quotedCents / optObj.listPriceCents
    const b = bStats.find((x) => mult >= x.min && mult < x.max)
    if (b) {
      b.total++
      if (r.outcome === "won") b.won++
      else b.lost++
    }
    if (r.outcome === "won") {
      wonRev += quotedCents
      if (r.option === "same_day") wonSameDay++
      else if (r.option === "next_day") wonNextDay++
      else won3Day++
    }
  }
  console.log(`\n--- 6. PRICING FRONTIER & UNQUOTED (${reveal.requests.length} requests) ---`)
  console.log(
    `  Unquoted: ${unquotedCount} (est spread above refFee €${(unquotedSpreadSumCents / 100).toFixed(0)} at 1.0x), opts=${JSON.stringify(unquotedByOpt)}`,
  )
  console.log(`  Won by option: same_day=${wonSameDay}, next_day=${wonNextDay}, within_3_days=${won3Day}`)
  for (const b of bStats) {
    console.log(
      `  Mult ${b.name.padEnd(9)}: won=${String(b.won).padStart(3)} / ${String(b.total).padStart(3)} (${b.total ? ((100 * b.won) / b.total).toFixed(1) : "0.0"}%)`,
    )
  }

  // 7. NOTE PARSING AUDIT AGAINST GROUND TRUTH
  let noteOrders = 0
  let missedManual = 0,
    falseManual = 0,
    missedPlates = 0,
    falsePlates = 0,
    missedSummer = 0,
    falseSummer = 0
  const missedManualSamples: string[] = []
  const missedPlatesSamples: string[] = []
  for (const t of reveal.orders) {
    const r = reqById.get(t.orderId)
    if (!r) continue
    const parsed = parseNoteFlags(r.request.note)
    const lt = t.legs?.[0]
    if (!lt) continue
    if (r.request.note?.text) noteOrders++
    if (lt.manualGearbox && !parsed.manualGearbox && !parsed.manualLicence) {
      missedManual++
      missedManualSamples.push(`"${r.request.note?.text}" (${r.request.note?.language})`)
    }
    if (!lt.manualGearbox && parsed.manualLicence) falseManual++
    if (lt.needsPlates && !parsed.withPlates) {
      missedPlates++
      missedPlatesSamples.push(`"${r.request.note?.text}" (${r.request.note?.language})`)
    }
    if (!lt.needsPlates && parsed.withPlates) falsePlates++
    if (lt.summerTyres && !parsed.summerTyres) missedSummer++
    if (!lt.summerTyres && parsed.summerTyres) falseSummer++
  }
  console.log(`\n--- 7. NOTE PARSER ACCURACY ON WON ORDERS (${noteOrders} notes / ${reveal.orders.length} orders) ---`)
  console.log(
    `  Manual missed=${missedManual} false=${falseManual} | Plates missed=${missedPlates} false=${falsePlates} | Summer missed=${missedSummer} false=${falseSummer}`,
  )
  if (missedManualSamples.length) console.log("  Missed manual notes:", missedManualSamples)
  if (missedPlatesSamples.length) console.log("  Missed plates notes:", missedPlatesSamples)
}

analyzeFile("scratch/xray_spread-4_reveal.json")
analyzeFile("scratch/xray_spread-5_reveal.json")
