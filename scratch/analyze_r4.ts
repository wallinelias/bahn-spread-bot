import { readFileSync } from "node:fs"

const r4Events = JSON.parse(readFileSync("./scratch/r4_events.json", "utf-8"))
const r4Snap = JSON.parse(readFileSync("./scratch/r4_snap.json", "utf-8"))
const r4Roster = JSON.parse(readFileSync("./scratch/r4_roster.json", "utf-8"))

const r2Events = JSON.parse(readFileSync("./scratch/r2_events.json", "utf-8"))
const r2Snap = JSON.parse(readFileSync("./scratch/r2_snap.json", "utf-8"))
const r2Roster = JSON.parse(readFileSync("./scratch/r2_roster.json", "utf-8"))

console.log("================ WEATHER / FORECASTS ================")
const r4Forecasts = r4Events.filter((e: any) => e.kind === "forecast")
console.log("Run 4 Forecasts:", JSON.stringify(r4Forecasts, null, 2))
const r2Forecasts = r2Events.filter((e: any) => e.kind === "forecast")
console.log("Run 2 Forecasts:", JSON.stringify(r2Forecasts, null, 2))

console.log("\n================ BATCH ID ANALYSIS ================")
function analyzeBatches(events: any[]) {
  const requests = events.filter((e: any) => e.kind === "price_request")
  const wonOrders = events.filter((e: any) => e.kind === "order_won")
  const wonOrderIds = new Set(wonOrders.map((e: any) => e.order.id || e.order.orderId))

  const batches: Record<string, { total: number; won: number; places: Set<string>; dealers: Set<string>; times: number[] }> = {}
  for (const r of requests) {
    const req = r.request
    const bId = req.batchId || "no_batch"
    if (!batches[bId]) {
      batches[bId] = { total: 0, won: 0, places: new Set(), dealers: new Set(), times: [] }
    }
    batches[bId].total++
    batches[bId].times.push(r.at)
    batches[bId].dealers.add(req.dealerId)
    for (const leg of req.legs || []) {
      batches[bId].places.add(leg.pickup)
      batches[bId].places.add(leg.dropoff)
    }
    // Check if any won order matched this request
    // Note: orderId usually equals requestId in spread
    if (wonOrderIds.has(req.id)) {
      batches[bId].won++
    }
  }
  return batches
}

const r4Batches = analyzeBatches(r4Events)
const r2Batches = analyzeBatches(r2Events)

console.log("Run 4 Top Batches by won orders:")
const sortedR4Batches = Object.entries(r4Batches).sort((a, b) => b[1].won - a[1].won)
for (const [bId, b] of sortedR4Batches.slice(0, 10)) {
  console.log(`Batch ${bId}: total=${b.total}, won=${b.won}, places=[${[...b.places].join(",")}], dealers=[${[...b.dealers].join(",")}], timeRange=${Math.min(...b.times)}-${Math.max(...b.times)}`)
}

console.log("\n================ 79 DEADLINE WARNINGS IN RUN 4 ================")
const r4Warnings = r4Events.filter((e: any) => e.kind === "deadline_close")
console.log(`Total deadline_close in R4: ${r4Warnings.length}`)

// Map orders to their details from order_won or snapshot
const orderMapR4 = new Map()
for (const e of r4Events) {
  if (e.kind === "order_won") {
    orderMapR4.set(e.order.id || e.order.orderId, e.order)
  }
}
for (const o of r4Snap.orders) {
  orderMapR4.set(o.id || o.orderId, o)
}

// Check ledger late_refunds in R4
const lateRefundsR4 = r4Events.filter((e: any) => e.kind === "ledger" && e.line.kind === "late_refund")
console.log(`Late refunds in R4: ${lateRefundsR4.length}, total cents: ${lateRefundsR4.reduce((s: number, e: any) => s + e.line.cents, 0)}`)

const warningByTown: Record<string, number> = {}
const warningByBatch: Record<string, number> = {}
const warningTimeHistogram: Record<number, number> = {} // by day (1440 min)

for (const w of r4Warnings) {
  const o = orderMapR4.get(w.orderId)
  const day = Math.floor(w.at / 1440)
  warningTimeHistogram[day] = (warningTimeHistogram[day] || 0) + 1
  if (o) {
    const pickup = o.legs?.[0]?.pickup || "unknown"
    const dropoff = o.legs?.[0]?.dropoff || "unknown"
    const route = `${pickup}->${dropoff}`
    warningByTown[route] = (warningByTown[route] || 0) + 1
    const bId = o.batchId || "no_batch"
    warningByBatch[bId] = (warningByBatch[bId] || 0) + 1
  }
}

console.log("Warnings by Day in R4 (Day 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun, 7=Mon, 8=Tue):")
console.table(warningTimeHistogram)

console.log("Top routes with deadline warnings in R4:")
const sortedWarningRoutes = Object.entries(warningByTown).sort((a, b) => b[1] - a[1])
console.table(sortedWarningRoutes.slice(0, 15))

console.log("Warnings by batchId in R4:")
const sortedWarningBatches = Object.entries(warningByBatch).sort((a, b) => b[1] - a[1])
console.table(sortedWarningBatches.slice(0, 10))

console.log("\n================ 39 GIG DROPS IN RUN 4 ================")
const r4Drops = r4Events.filter((e: any) => e.kind === "gig_dropped")
console.log(`Total gig_dropped in R4: ${r4Drops.length}`)

const gigMapR4 = new Map()
for (const g of r4Snap.gigs) {
  gigMapR4.set(g.id, g)
}

const dropByDriver: Record<string, number> = {}
const dropByTime: Record<number, number> = {}
const dropByGig: Record<string, any> = {}

for (const d of r4Drops) {
  dropByDriver[d.driverId] = (dropByDriver[d.driverId] || 0) + 1
  const day = Math.floor(d.at / 1440)
  dropByTime[day] = (dropByTime[day] || 0) + 1
  const gig = gigMapR4.get(d.gigId)
  dropByGig[d.gigId] = gig
}

console.log("Gig drops by Day in R4:")
console.table(dropByTime)

console.log("Top drivers who dropped gigs in R4:")
console.table(Object.entries(dropByDriver).sort((a, b) => b[1] - a[1]).slice(0, 10))

// Let's check why gigs were dropped: how long between booked and dropped?
const bookEventsR4 = new Map()
for (const e of r4Events) {
  if (e.kind === "gig_booked") {
    bookEventsR4.set(e.gigId + "_" + e.driverId, e.at)
  }
}

const dropDelays: number[] = []
for (const d of r4Drops) {
  const bookedAt = bookEventsR4.get(d.gigId + "_" + d.driverId)
  if (bookedAt !== undefined) {
    dropDelays.push(d.at - bookedAt)
  }
}
console.log(`Drop delay after booking (minutes): avg=${(dropDelays.reduce((a, b) => a + b, 0) / dropDelays.length).toFixed(1)}m, min=${Math.min(...dropDelays)}m, max=${Math.max(...dropDelays)}m`)
console.log("Sample drop delays:", dropDelays.slice(0, 10))
