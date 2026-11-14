import fs from "node:fs"

// Read-only driver-fee leak analyzer (0 API calls). Usage: node scratch/fee-leak-analyze.ts <reveal.json> [...]
const files = process.argv.slice(2)
const HOUR = 60

function hav(a: any, b: any): number {
  const R = 6371
  const toRad = (x: number) => (x * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const avg = (a: number[]) => (a.length ? sum(a) / a.length : 0)
const q = (a: number[], p: number) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!
}
const eur = (c: number) => `€${(c / 100).toFixed(0)}`

for (const path of files) {
  const d = JSON.parse(fs.readFileSync(path, "utf8"))
  const { snap, events, reveal, roster, map } = d
  console.log(`\n################ ${path} (tag=${d.tag ?? d.strategyVersion}) margin €${(d.score.marginCents / 100).toFixed(2)} ################`)
  const placeById = new Map<string, any>(map.places.map((p: any) => [p.id, p]))
  const driverById = new Map<string, any>(roster.map((r: any) => [r.id, r]))
  const reqById = new Map<string, any>(reveal.requests.map((r: any) => [r.request.id, r.request]))
  const orderById = new Map<string, any>(snap.orders.map((o: any) => [o.id, o]))
  const gigById = new Map<string, any>(snap.gigs.map((g: any) => [g.id, g]))
  const viewsByGig = new Map<string, any[]>()
  for (const v of reveal.views) {
    if (!viewsByGig.has(v.gigId)) viewsByGig.set(v.gigId, [])
    viewsByGig.get(v.gigId)!.push(v)
  }
  for (const a of viewsByGig.values()) a.sort((x, y) => x.at - y.at)
  const droppedGigs = new Set<string>(events.filter((e: any) => e.kind === "gig_dropped").map((e: any) => e.gigId))
  const dropOrders = new Set<string>()
  for (const gid of droppedGigs) for (const s of gigById.get(gid)?.stops ?? []) dropOrders.add(s.orderId)
  const expiredGigOrders = new Set<string>()
  for (const e of events) if (e.kind === "gig_expired") for (const s of gigById.get(e.gigId)?.stops ?? []) expiredGigOrders.add(s.orderId)

  // gig ordinal per order (to know if it is a repost)
  const gigsByOrder = new Map<string, any[]>()
  for (const g of snap.gigs) for (const oid of new Set<string>(g.stops.map((s: any) => s.orderId))) {
    if (!gigsByOrder.has(oid)) gigsByOrder.set(oid, [])
    gigsByOrder.get(oid)!.push(g)
  }
  for (const a of gigsByOrder.values()) a.sort((x, y) => x.postedAt - y.postedAt)

  const bookings = events.filter((e: any) => e.kind === "gig_booked")
  type Row = any
  const rows: Row[] = []
  for (const b of bookings) {
    const g = gigById.get(b.gigId)
    if (!g) continue
    const oids = [...new Set<string>(g.stops.map((s: any) => s.orderId))]
    const orders = oids.map((o) => orderById.get(o)).filter(Boolean)
    const reqs = oids.map((o) => reqById.get(o)).filter(Boolean)
    if (!reqs.length) continue
    // ref per gig: sum over orders of ref/legs (single-leg orders dominate)
    const ref = sum(reqs.map((r: any) => r.referenceFeeCents / Math.max(1, r.legs.length)))
    const firstStop = g.stops[0]
    const leg = reqs[0].legs[firstStop.leg ?? 0]
    const pickupPlace = placeById.get(leg.pickup.placeId)
    const driver = driverById.get(b.driverId)
    const homePlace = driver ? placeById.get(driver.homePlaceId) : null
    const distHome = homePlace && pickupPlace ? hav(homePlace, pickupPlace) : NaN
    const views = viewsByGig.get(b.gigId) ?? []
    const myViews = views.filter((v) => v.driverId === b.driverId)
    const firstGigView = views[0]
    const firstMine = myViews[0]
    const postedFee = g.schedule?.[0]?.feeCents ?? g.feeCents
    const bookedFee = b.feeCents
    const lastPickupAt = Math.min(...orders.map((o: any) => o.lastPickupAt ?? 1e9))
    const slackAtPost = lastPickupAt - g.postedAt
    const slackAtBook = lastPickupAt - b.at
    const ordinal = (gigsByOrder.get(oids[0]!) ?? []).findIndex((x) => x.id === g.id)
    // classify
    let cls: string
    const earlierLower = myViews.some((v) => v.at < b.at - 1 && v.feeCents < bookedFee)
    const earlierSame = myViews.some((v) => v.at < b.at - 1 && v.feeCents === bookedFee)
    if (earlierLower) cls = "B_reservation(earlier view at LOWER fee)"
    else if (earlierSame) cls = "C_reviewed_same_fee"
    else if (b.at - g.postedAt <= 5) cls = "A1_instant(<=5m after post)"
    else if (bookedFee === postedFee) cls = "A2_first_view_at_posted_fee(late arrival)"
    else cls = "A3_first_view_at_escalated_fee(arrival-limited)"
    rows.push({
      gigId: b.gigId, driverId: b.driverId, at: b.at, postedAt: g.postedAt, ref, postedFee, bookedFee,
      ratio: bookedFee / ref, postedRatio: postedFee / ref, distHome, cls, slackAtPost, slackAtBook, ordinal,
      nViewsBefore: views.filter((v) => v.at <= b.at).length,
      uniqViewersBefore: new Set(views.filter((v) => v.at <= b.at).map((v) => v.driverId)).size,
      firstGigViewFee: firstGigView?.feeCents ?? postedFee,
      firstMineFee: firstMine?.feeCents ?? bookedFee,
      isDropRecovery: dropOrders.has(oids[0]!) && ordinal > 0,
      hasExpiredBefore: expiredGigOrders.has(oids[0]!) && ordinal > 0,
      multi: oids.length > 1 || reqs.some((r: any) => r.legs.length > 1),
      pickupId: leg.pickup.placeId,
      hour: Math.floor((b.at % 1440) / 60),
    })
  }
  console.log(`booked rows=${rows.length}`)
  const totBooked = sum(rows.map((r) => r.bookedFee))
  const totPosted = sum(rows.map((r) => r.postedFee))
  const totRef = sum(rows.map((r) => r.ref))
  console.log(`TOTAL booked=${eur(totBooked)} posted=${eur(totPosted)} ref=${eur(totRef)} | booked/ref=${(totBooked / totRef).toFixed(3)} posted/ref=${(totPosted / totRef).toFixed(3)} | escalation(booked-posted)=${eur(totBooked - totPosted)}`)

  // ---- 1. class breakdown
  console.log(`\n--- 1. BOOKER CLASS (reservation-price vs arrival-limited) ---`)
  const byCls = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byCls.has(r.cls)) byCls.set(r.cls, [])
    byCls.get(r.cls)!.push(r)
  }
  for (const [c, rs] of [...byCls.entries()].sort()) {
    const esc = sum(rs.map((r) => r.bookedFee - r.postedFee))
    const escOwn = sum(rs.map((r) => r.bookedFee - r.firstMineFee))
    console.log(
      `  ${c.padEnd(48)} n=${String(rs.length).padStart(3)} booked/ref=${(sum(rs.map((r) => r.bookedFee)) / sum(rs.map((r) => r.ref))).toFixed(3)} posted/ref=${(sum(rs.map((r) => r.postedFee)) / sum(rs.map((r) => r.ref))).toFixed(3)} esc_vs_posted=${eur(esc)} esc_vs_own_first_view=${eur(escOwn)} avgWaitFromPost=${avg(rs.map((r) => r.at - r.postedAt)).toFixed(0)}m`,
    )
  }

  // ---- booked ratio distribution & tail composition
  console.log(`\n--- 1b. BOOKED/REF TAIL COMPOSITION ---`)
  const bins: [string, number, number][] = [["<0.90", 0, 0.9], ["0.90-1.00", 0.9, 1.0], ["1.00-1.10", 1.0, 1.1], ["1.10-1.25", 1.1, 1.25], ["1.25-1.45", 1.25, 1.45], [">=1.45", 1.45, 99]]
  for (const [name, lo, hi] of bins) {
    const rs = rows.filter((r) => r.ratio >= lo && r.ratio < hi)
    const fee = sum(rs.map((r) => r.bookedFee))
    const over = sum(rs.map((r) => r.bookedFee - r.ref))
    console.log(
      `  ${name.padEnd(10)} n=${String(rs.length).padStart(3)} fee=${eur(fee).padStart(6)} overRef=${eur(over).padStart(6)} | dropRecov=${rs.filter((r) => r.isDropRecovery).length} repostAfterExpire=${rs.filter((r) => r.hasExpiredBefore).length} multi=${rs.filter((r) => r.multi).length} slackAtBook<5h=${rs.filter((r) => r.slackAtBook < 5 * HOUR).length} slackAtPost>=24h=${rs.filter((r) => r.slackAtPost >= 24 * HOUR).length} medUniqViewers=${q(rs.map((r) => r.uniqViewersBefore), 0.5)} medWaitFromPost=${q(rs.map((r) => r.at - r.postedAt), 0.5)}m`,
    )
  }

  // ---- 2. distance
  console.log(`\n--- 2. BOOKER HOME->PICKUP DISTANCE vs ACCEPTED FEE ---`)
  const dBins: [string, number, number][] = [["<=15km", 0, 15], ["15-30km", 15, 30], ["30-60km", 30, 60], ["60-120km", 60, 120], [">120km", 120, 1e9]]
  for (const [name, lo, hi] of dBins) {
    const rs = rows.filter((r) => r.distHome >= lo && r.distHome < hi)
    if (!rs.length) continue
    console.log(
      `  ${name.padEnd(9)} n=${String(rs.length).padStart(3)} booked/ref=${(sum(rs.map((r) => r.bookedFee)) / sum(rs.map((r) => r.ref))).toFixed(3)} posted/ref=${(sum(rs.map((r) => r.postedFee)) / sum(rs.map((r) => r.ref))).toFixed(3)} medRatio=${q(rs.map((r) => r.ratio), 0.5).toFixed(2)} p25=${q(rs.map((r) => r.ratio), 0.25).toFixed(2)} p75=${q(rs.map((r) => r.ratio), 0.75).toFixed(2)} instant(<=5m)=${rs.filter((r) => r.at - r.postedAt <= 5).length} medWait=${q(rs.map((r) => r.at - r.postedAt), 0.5)}m`,
    )
  }

  // views conversion by distance x ratio
  console.log(`\n--- 2b. P(book | view) by home->pickup distance x fee/ref (single-order gigs) ---`)
  const bookKey = new Set(bookings.map((b: any) => `${b.gigId}:${b.driverId}`))
  const rBins: [string, number, number][] = [["<0.90", 0, 0.9], ["0.90-1.00", 0.9, 1.0], ["1.00-1.15", 1.0, 1.15], ["1.15-1.35", 1.15, 1.35], [">=1.35", 1.35, 99]]
  const cell = new Map<string, { v: number; b: number }>()
  for (const v of reveal.views) {
    const g = gigById.get(v.gigId)
    if (!g) continue
    const oids = [...new Set<string>(g.stops.map((s: any) => s.orderId))]
    const reqs = oids.map((o) => reqById.get(o)).filter(Boolean)
    if (!reqs.length) continue
    const ref = sum(reqs.map((r: any) => r.referenceFeeCents / Math.max(1, r.legs.length)))
    const leg = reqs[0].legs[g.stops[0].leg ?? 0]
    const pp = placeById.get(leg.pickup.placeId)
    const dr = driverById.get(v.driverId)
    const hp = dr ? placeById.get(dr.homePlaceId) : null
    if (!pp || !hp) continue
    const dist = hav(hp, pp)
    const dName = dBins.find(([, lo, hi]) => dist >= lo && dist < hi)![0]
    const rr = v.feeCents / ref
    const rName = rBins.find(([, lo, hi]) => rr >= lo && rr < hi)![0]
    const k = `${dName}|${rName}`
    if (!cell.has(k)) cell.set(k, { v: 0, b: 0 })
    const c = cell.get(k)!
    c.v++
    if (bookKey.has(`${v.gigId}:${v.driverId}`)) c.b++
  }
  console.log(`  ${"dist\\ratio".padEnd(10)} ${rBins.map(([n]) => n.padStart(16)).join("")}`)
  for (const [dn] of dBins) {
    const cols = rBins.map(([rn]) => {
      const c = cell.get(`${dn}|${rn}`)
      return (c ? `${c.b}/${c.v} ${((100 * c.b) / Math.max(1, c.v)).toFixed(1)}%` : "-").padStart(16)
    })
    console.log(`  ${dn.padEnd(10)} ${cols.join("")}`)
  }

  // ---- 2c. direct offers
  console.log(`\n--- 2c. DIRECT OFFERS ---`)
  const offers = events.filter((e: any) => e.kind === "offer_answered")
  const ans: Record<string, number> = {}
  for (const o of offers) ans[o.answer] = (ans[o.answer] ?? 0) + 1
  console.log(`  answers=${JSON.stringify(ans)}`)
  const acc = offers.filter((o: any) => o.answer === "accepted")
  for (const o of acc.slice(0, 12)) {
    const g = gigById.get(o.gigId)
    const r = rows.find((x) => x.gigId === o.gigId)
    console.log(`  accepted at=${o.at} gig=${o.gigId} drv=${o.driverId} postedAt=${g?.postedAt} fee=${o.feeCents ?? r?.bookedFee} ratio=${r?.ratio?.toFixed(2)} distHome=${r?.distHome?.toFixed(0)}km`)
  }

  // ---- 3. step timing: bookings right after fee step-ups
  console.log(`\n--- 3. BOOKING TIMING vs FEE STEPS ---`)
  let afterStep = 0
  let total = 0
  const lagBins: Record<string, number> = { "0-5m": 0, "5-30m": 0, "30-120m": 0, ">120m": 0 }
  for (const r of rows) {
    const g = gigById.get(r.gigId)
    const steps = (g?.schedule ?? []).filter((s: any) => s.at > g.postedAt && s.at <= r.at)
    total++
    if (steps.length) {
      const last = steps[steps.length - 1]
      const lag = r.at - last.at
      afterStep++
      if (lag <= 5) lagBins["0-5m"]!++
      else if (lag <= 30) lagBins["5-30m"]!++
      else if (lag <= 120) lagBins["30-120m"]!++
      else lagBins[">120m"]!++
    }
  }
  console.log(`  bookings after >=1 fee step-up: ${afterStep}/${total}; lag since last step: ${JSON.stringify(lagBins)}`)
  // schedule shape stats
  const nSteps = snap.gigs.map((g: any) => g.schedule?.length ?? 0)
  console.log(`  schedule steps/gig: avg=${avg(nSteps).toFixed(1)} | first-step ratio avg=${(sum(rows.map((r) => r.postedFee)) / totRef).toFixed(3)}`)
  // for booked gigs: ratio of first-step by class & by bucket of final
  const insta = rows.filter((r) => r.at - r.postedAt <= 5)
  console.log(`  instant(<=5m): n=${insta.length} booked/ref=${(sum(insta.map((r) => r.bookedFee)) / Math.max(1, sum(insta.map((r) => r.ref)))).toFixed(3)}`)
  const lateRows = rows.filter((r) => r.at - r.postedAt > 5)
  console.log(`  later(>5m): n=${lateRows.length} posted/ref=${(sum(lateRows.map((r) => r.postedFee)) / Math.max(1, sum(lateRows.map((r) => r.ref)))).toFixed(3)} booked/ref=${(sum(lateRows.map((r) => r.bookedFee)) / Math.max(1, sum(lateRows.map((r) => r.ref)))).toFixed(3)} avgWait=${avg(lateRows.map((r) => r.at - r.postedAt)).toFixed(0)}m`)

  // Booked/ref by posted ratio bin (first-step) -> what posted ratio converts to what booked
  console.log(`\n--- 4. POSTED/REF bin -> outcome (booked gigs only) ---`)
  const pb: [string, number, number][] = [["<0.85", 0, 0.85], ["0.85-0.92", 0.85, 0.92], ["0.92-1.00", 0.92, 1.0], ["1.00-1.10", 1.0, 1.1], [">=1.10", 1.1, 99]]
  for (const [name, lo, hi] of pb) {
    const rs = rows.filter((r) => r.postedRatio >= lo && r.postedRatio < hi && !r.multi)
    if (!rs.length) continue
    console.log(
      `  posted ${name.padEnd(10)} n=${String(rs.length).padStart(3)} booked/ref=${(sum(rs.map((r) => r.bookedFee)) / sum(rs.map((r) => r.ref))).toFixed(3)} instant%=${((100 * rs.filter((r) => r.at - r.postedAt <= 5).length) / rs.length).toFixed(0)} medWait=${q(rs.map((r) => r.at - r.postedAt), 0.5)}m p90Wait=${q(rs.map((r) => r.at - r.postedAt), 0.9)}m medUniqViewers=${q(rs.map((r) => r.uniqViewersBefore), 0.5)}`,
    )
  }
}
