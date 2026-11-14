import fs from "node:fs"

const DAY = 24 * 60
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon2", "Tue2"]
function fmtTime(m: number | null | undefined): string {
  if (m === null || m === undefined) return "null"
  const d = Math.floor(m / DAY)
  const rem = ((m % DAY) + DAY) % DAY
  return `${DAYS[d] ?? `D${d}`} ${String(Math.floor(rem / 60)).padStart(2, "0")}:${String(rem % 60).padStart(2, "0")}`
}

for (const path of ["scratch/xray_spread-4_reveal.json", "scratch/xray_spread-5_reveal.json"]) {
  const data = JSON.parse(fs.readFileSync(path, "utf8"))
  const { seed, snap, events, reveal } = data
  console.log(`\n==================== DEEP DIVE: ${seed} ====================`)
  const reqById = new Map<string, any>(reveal.requests.map((r: any) => [r.request.id, r]))
  const truthById = new Map<string, any>(reveal.orders.map((o: any) => [o.orderId, o]))
  const gigById = new Map<string, any>((snap.gigs ?? []).map((g: any) => [g.id, g]))
  const orderById = new Map<string, any>((snap.orders ?? []).map((o: any) => [o.id, o]))

  // A. Inspect "negative lateMinutes" orders
  console.log(`--- A. MYSTERY NEGATIVE-LATE ORDERS ---`)
  const lateLedgers = events.filter((e: any) => e.kind === "ledger" && e.line?.kind === "late_refund")
  for (const ll of lateLedgers) {
    const oid = ll.line.orderId
    const oSnap = orderById.get(oid)
    const delivEv = events.find((e: any) => e.kind === "delivered" && e.orderId === oid)
    if (oSnap?.deadline && delivEv?.at && delivEv.at <= oSnap.deadline) {
      const evs = events.filter(
        (e: any) => e.orderId === oid || e.order?.id === oid || (e.gigId && gigById.get(e.gigId)?.stops?.some((s: any) => s.orderId === oid)),
      )
      const r = reqById.get(oid)
      const t = truthById.get(oid)
      const wonOpt = r?.request?.options?.find((o: any) => o.kind === r.option)
      console.log(
        `  ${oid} opt=${r?.option} optDL=${fmtTime(wonOpt?.deadline)} snapDL=${fmtTime(oSnap.deadline)} deliv=${fmtTime(delivEv.at)} noteDL=${fmtTime(t?.legs?.[0]?.noteDeadline)} note="${r?.request?.note?.text ?? ""}"`,
      )
      console.log(
        `    timeline:`,
        evs
          .filter((e: any) => !["gig_viewed", "offer_answered", "ledger"].includes(e.kind))
          .map((e: any) => `${e.kind}@${fmtTime(e.at)}${e.kind === "order_changed" ? "(newDL=" + fmtTime(e.order?.deadline) + ")" : ""}${e.kind === "order_won" ? "(winDL=" + fmtTime(e.order?.deadline) + ")" : ""}`)
          .join(" -> "),
      )
    }
  }

  // B. Analyze reveal.views trajectory: why didn't View #1 book?
  console.log(`\n--- B. VIEWS TRAJECTORY (WHY DID DRIVERS VIEW & NOT BOOK?) ---`)
  const viewsByGig = new Map<string, any[]>()
  for (const v of reveal.views ?? []) {
    if (!viewsByGig.has(v.gigId)) viewsByGig.set(v.gigId, [])
    viewsByGig.get(v.gigId)!.push(v)
  }
  const bookEvents = events.filter((e: any) => e.kind === "gig_booked")
  let delayedSamples = 0
  let sameFeeMultipleViews = 0
  let higherFeeBooked = 0
  let lowerFeeBooked = 0
  let exactSameFeeBookedAfterDelay = 0
  let waitBins = { le15m: 0, m15_60: 0, h1_4: 0, h4_12: 0, gt12h: 0 }
  let overpayWhenHigherCents = 0
  let viewCountDist: Record<string, number> = {}
  const ratioDiffs: number[] = []

  for (const b of bookEvents) {
    const gig = gigById.get(b.gigId)
    const views = (viewsByGig.get(b.gigId) ?? []).sort((x, y) => x.at - y.at)
    if (!views.length) continue
    const v1 = views[0]
    const vLast = views.find((v) => v.driverId === b.driverId && Math.abs(v.at - b.at) <= 1) ?? views[views.length - 1]
    const ref = gig?.referenceFeeCents ?? reqById.get(gig?.stops?.[0]?.orderId)?.request?.referenceFeeCents ?? 1
    const waitMin = Math.max(0, b.at - v1.at)
    viewCountDist[String(Math.min(views.length, 6))] = (viewCountDist[String(Math.min(views.length, 6))] ?? 0) + 1
    if (waitMin <= 15) waitBins.le15m++
    else if (waitMin <= 60) waitBins.m15_60++
    else if (waitMin <= 240) waitBins.h1_4++
    else if (waitMin <= 720) waitBins.h4_12++
    else waitBins.gt12h++

    if (b.at - v1.at > 5) {
      if (vLast.feeCents > v1.feeCents) {
        higherFeeBooked++
        overpayWhenHigherCents += vLast.feeCents - v1.feeCents
        ratioDiffs.push(vLast.feeCents / ref - v1.feeCents / ref)
      } else if (vLast.feeCents === v1.feeCents) exactSameFeeBookedAfterDelay++
      else lowerFeeBooked++

      if (delayedSamples < 12 && vLast.feeCents > v1.feeCents) {
        delayedSamples++
        const o0 = gig?.stops?.[0]?.orderId ? reqById.get(gig.stops[0].orderId) : null
        console.log(
          `  gig=${b.gigId} (${gig?.stops?.map((s: any) => s.placeId).join("->")}, opt=${o0?.option}) ref=€${(ref / 100).toFixed(0)} views=${views.length}: V1@${fmtTime(v1.at)}=€${(v1.feeCents / 100).toFixed(1)}(${(v1.feeCents / ref).toFixed(2)}x) -> Book@${fmtTime(b.at)}=€${(vLast.feeCents / 100).toFixed(1)}(${(vLast.feeCents / ref).toFixed(2)}x) [all=${views.slice(0, 6).map((x) => `${(x.feeCents / ref).toFixed(2)}x@${fmtTime(x.at).slice(4)}`).join(",")}]`,
        )
      }
    }
  }
  console.log(`  Wait bins from V1 to Book:`, JSON.stringify(waitBins))
  console.log(
    `  Delayed (>5m): higherFee=${higherFeeBooked} (+€${(overpayWhenHigherCents / 100).toFixed(2)}), sameFee=${exactSameFeeBookedAfterDelay}, lowerFee=${lowerFeeBooked}`,
  )
  console.log(`  Views count before book (6=6+):`, JSON.stringify(viewCountDist))

  // C. Check Fee-to-Ref distribution of BOOKED vs UNBOOKED views!
  let vAll = 0,
    vBook = 0
  const acceptByRatio: Record<string, { views: number; books: number }> = {
    "<0.95": { views: 0, books: 0 },
    "0.95-1.05": { views: 0, books: 0 },
    "1.05-1.15": { views: 0, books: 0 },
    "1.15-1.30": { views: 0, books: 0 },
    "1.30-1.60": { views: 0, books: 0 },
    "1.60+": { views: 0, books: 0 },
  }
  const bookedSet = new Set(bookEvents.map((b: any) => `${b.gigId}:${b.driverId}`))
  for (const v of reveal.views ?? []) {
    const gig = gigById.get(v.gigId)
    const ref = gig?.referenceFeeCents ?? reqById.get(gig?.stops?.[0]?.orderId)?.request?.referenceFeeCents
    if (!ref) continue
    const ratio = v.feeCents / ref
    const key =
      ratio < 0.95
        ? "<0.95"
        : ratio < 1.05
          ? "0.95-1.05"
          : ratio < 1.15
            ? "1.05-1.15"
            : ratio < 1.3
              ? "1.15-1.30"
              : ratio < 1.6
                ? "1.30-1.60"
                : "1.60+"
    acceptByRatio[key]!.views++
    vAll++
    if (bookedSet.has(`${v.gigId}:${v.driverId}`)) {
      acceptByRatio[key]!.books++
      vBook++
    }
  }
  console.log(`\n--- C. DRIVER ACCEPT RATE BY FEE/REF RATIO ON VIEW (${vBook}/${vAll} total views booked) ---`)
  for (const [k, s] of Object.entries(acceptByRatio)) {
    console.log(`  Ratio ${k.padEnd(10)}: ${String(s.books).padStart(3)} / ${String(s.views).padStart(4)} views converted (${s.views ? ((100 * s.books) / s.views).toFixed(1) : "0.0"}%)`)
  }

  // D. DEALER TRUST & REPEAT DEALER PERFORMANCE
  console.log(`\n--- D. DEALER STATS (Top dealers by count & margin) ---`)
  const dStats = new Map<string, { req: number; won: number; late: number; revCents: number; feeCents: number; refundCents: number }>()
  for (const r of reveal.requests) {
    const did = r.request.dealerId
    if (!dStats.has(did)) dStats.set(did, { req: 0, won: 0, late: 0, revCents: 0, feeCents: 0, refundCents: 0 })
    const s = dStats.get(did)!
    s.req++
    if (r.outcome === "won") {
      s.won++
      s.revCents += r.quote?.[r.option] ?? 0
    }
  }
  for (const e of events) {
    if (e.kind === "ledger" && e.line?.orderId) {
      const did = reqById.get(e.line.orderId)?.request?.dealerId
      if (!did || !dStats.has(did)) continue
      const s = dStats.get(did)!
      if (e.line.kind === "driver_fee") s.feeCents += Math.abs(e.line.cents)
      if (e.line.kind === "late_refund" || e.line.kind === "undelivered_penalty") {
        s.late++
        s.refundCents += Math.abs(e.line.cents)
      }
    }
  }
  const topD = [...dStats.entries()].sort((a, b) => b[1].req - a[1].req).slice(0, 12)
  for (const [did, s] of topD) {
    const net = s.revCents - s.feeCents - s.refundCents
    console.log(
      `  ${did}: req=${s.req} won=${s.won} (${((100 * s.won) / s.req).toFixed(0)}%) late=${s.late} rev=€${(s.revCents / 100).toFixed(0)} fee=€${(s.feeCents / 100).toFixed(0)} ref=€${(s.refundCents / 100).toFixed(0)} net=€${(net / 100).toFixed(0)}`,
    )
  }
}
