import { readFileSync } from "node:fs"

const r4Events = JSON.parse(readFileSync("./scratch/r4_events.json", "utf-8"))
const r4Snap = JSON.parse(readFileSync("./scratch/r4_snap.json", "utf-8"))
const r2Events = JSON.parse(readFileSync("./scratch/r2_events.json", "utf-8"))

// 1. Build lookup for all requests and orders in R4
const reqMapR4 = new Map()
for (const e of r4Events) {
  if (e.kind === "price_request") {
    reqMapR4.set(e.request.id, e.request)
  }
}

const wonOrderMapR4 = new Map()
for (const e of r4Events) {
  if (e.kind === "order_won") {
    wonOrderMapR4.set(e.order.id, e.order)
  }
}
for (const o of r4Snap.orders) {
  wonOrderMapR4.set(o.id, o)
}

// 2. Analyze Late Deliveries in R4
const lateDeliveriesR4: any[] = []
for (const e of r4Events) {
  if (e.kind === "ledger" && e.line.kind === "late_refund") {
    const o = wonOrderMapR4.get(e.line.orderId)
    const req = reqMapR4.get(e.line.orderId)
    lateDeliveriesR4.push({
      orderId: e.line.orderId,
      detail: e.line.detail,
      cents: e.line.cents,
      at: e.at,
      pickup: o?.legs?.[0]?.pickup?.placeId,
      delivery: o?.legs?.[0]?.delivery?.placeId,
      batchId: req?.batchId || "none",
      dealerId: o?.dealerId,
      option: o?.option,
      deadline: o?.deadline,
      lastPickupAt: o?.lastPickupAt
    })
  }
}

console.log(`=== LATE DELIVERIES IN RUN 4 (Total: ${lateDeliveriesR4.length}) ===`)
console.log(`Total penalty: €${(-lateDeliveriesR4.reduce((s, x) => s + x.cents, 0) / 100).toFixed(2)}`)

const latePlaces: Record<string, number> = {}
const lateBatches: Record<string, number> = {}
for (const l of lateDeliveriesR4) {
  const p = `${l.pickup}->${l.delivery}`
  latePlaces[p] = (latePlaces[p] || 0) + 1
  lateBatches[l.batchId] = (lateBatches[l.batchId] || 0) + 1
}

console.log("\nLate deliveries by route (pickup->delivery):")
console.table(Object.entries(latePlaces).sort((a, b) => b[1] - a[1]).slice(0, 15))

console.log("\nLate deliveries by batchId:")
console.table(Object.entries(lateBatches).sort((a, b) => b[1] - a[1]).slice(0, 10))

// 3. Analyze the 79 Deadline Warnings
const warningsR4 = r4Events.filter((e: any) => e.kind === "deadline_close")
const warningOrders = warningsR4.map((w: any) => {
  const o = wonOrderMapR4.get(w.orderId)
  const req = reqMapR4.get(w.orderId)
  return {
    orderId: w.orderId,
    at: w.at,
    lastPickupAt: w.lastPickupAt,
    slackAtWarning: w.lastPickupAt - w.at,
    pickup: o?.legs?.[0]?.pickup?.placeId,
    delivery: o?.legs?.[0]?.delivery?.placeId,
    batchId: req?.batchId || "none",
    dealerId: o?.dealerId,
    status: o?.status
  }
})

const warningDestPlaces: Record<string, number> = {}
const warningPickupPlaces: Record<string, number> = {}
for (const w of warningOrders) {
  if (w.pickup) warningPickupPlaces[w.pickup] = (warningPickupPlaces[w.pickup] || 0) + 1
  if (w.delivery) warningDestPlaces[w.delivery] = (warningDestPlaces[w.delivery] || 0) + 1
}

console.log("\n=== 79 DEADLINE WARNINGS IN RUN 4 ===")
console.log("Pickups involved in deadline warnings:")
console.table(Object.entries(warningPickupPlaces).sort((a, b) => b[1] - a[1]).slice(0, 10))
console.log("Destinations involved in deadline warnings:")
console.table(Object.entries(warningDestPlaces).sort((a, b) => b[1] - a[1]).slice(0, 10))

// Northern towns affected by snow: kemi, oulu, rovaniemi
const snowTowns = new Set(["kemi", "oulu", "rovaniemi"])
const warningsInSnow = warningOrders.filter(w => snowTowns.has(w.pickup) || snowTowns.has(w.delivery))
console.log(`Warnings touching snow towns (Kemi/Oulu/Rovaniemi): ${warningsInSnow.length} / ${warningOrders.length} (${(warningsInSnow.length * 100 / warningOrders.length).toFixed(1)}%)`)

const lateInSnow = lateDeliveriesR4.filter(l => snowTowns.has(l.pickup) || snowTowns.has(l.delivery))
console.log(`Late deliveries touching snow towns: ${lateInSnow.length} / ${lateDeliveriesR4.length} (${(lateInSnow.length * 100 / lateDeliveriesR4.length).toFixed(1)}%)`)

// 4. Analyze the 39 Gig Drops in Run 4
const dropsR4 = r4Events.filter((e: any) => e.kind === "gig_dropped")
console.log(`\n=== 39 GIG DROPS IN RUN 4 ===`)

// Link gigId to orders
const gigToOrders = new Map<string, string[]>()
for (const g of r4Snap.gigs) {
  gigToOrders.set(g.id, g.stops.map((s: any) => s.orderId))
}

const droppedGigDetails = dropsR4.map((d: any) => {
  const g = r4Snap.gigs.find((x: any) => x.id === d.gigId)
  const orderIds = gigToOrders.get(d.gigId) || []
  const o = wonOrderMapR4.get(orderIds[0])
  return {
    gigId: d.gigId,
    driverId: d.driverId,
    at: d.at,
    orderCount: orderIds.length,
    orders: orderIds,
    pickup: o?.legs?.[0]?.pickup?.placeId,
    delivery: o?.legs?.[0]?.delivery?.placeId,
    feeCents: g?.feeCents
  }
})

const dropRoutes: Record<string, number> = {}
for (const d of droppedGigDetails) {
  const p = `${d.pickup}->${d.delivery}`
  dropRoutes[p] = (dropRoutes[p] || 0) + 1
}

console.log("Top routes of dropped gigs:")
console.table(Object.entries(dropRoutes).sort((a, b) => b[1] - a[1]).slice(0, 10))

const dropsInSnow = droppedGigDetails.filter(d => snowTowns.has(d.pickup) || snowTowns.has(d.delivery))
console.log(`Gig drops touching snow towns: ${dropsInSnow.length} / ${droppedGigDetails.length} (${(dropsInSnow.length * 100 / droppedGigDetails.length).toFixed(1)}%)`)

// Did gig drops cause deadline warnings?
const droppedOrderIds = new Set(droppedGigDetails.flatMap(d => d.orders))
const warningsOnDroppedOrders = warningOrders.filter(w => droppedOrderIds.has(w.orderId))
console.log(`Deadline warnings on orders that had gigs dropped: ${warningsOnDroppedOrders.length} / ${warningOrders.length}`)
const lateOnDroppedOrders = lateDeliveriesR4.filter(l => droppedOrderIds.has(l.orderId))
console.log(`Late deliveries on orders that had gigs dropped: ${lateOnDroppedOrders.length} / ${lateDeliveriesR4.length}`)
