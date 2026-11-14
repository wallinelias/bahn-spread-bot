import { readFileSync } from "node:fs"

const r4Events = JSON.parse(readFileSync("./scratch/r4_events.json", "utf-8"))
const r2Events = JSON.parse(readFileSync("./scratch/r2_events.json", "utf-8"))
const r4Snap = JSON.parse(readFileSync("./scratch/r4_snap.json", "utf-8"))
const r2Snap = JSON.parse(readFileSync("./scratch/r2_snap.json", "utf-8"))

console.log("=== COMPARING GIG BOOKINGS & EXPIRATIONS ===")

function analyzeGigs(events: any[], snap: any) {
  const books = events.filter((e: any) => e.kind === "gig_booked")
  const expires = events.filter((e: any) => e.kind === "gig_expired")
  const drops = events.filter((e: any) => e.kind === "gig_dropped")
  const views = events.filter((e: any) => e.kind === "gig_viewed")
  
  // Booked fees vs reference fees
  // Match gig to snapshot or booked events
  const gigFees = books.map((b: any) => b.feeCents)
  const totalBookedFeeCents = gigFees.reduce((a: number, b: number) => a + b, 0)
  const avgBookedFeeCents = totalBookedFeeCents / (gigFees.length || 1)

  return {
    totalGigs: snap.gigs.length,
    bookedCount: books.length,
    expiredCount: expires.length,
    droppedCount: drops.length,
    viewCount: views.length,
    viewsPerGig: (views.length / (snap.gigs.length || 1)).toFixed(1),
    totalBookedFeeEur: (totalBookedFeeCents / 100).toFixed(2),
    avgBookedFeeEur: (avgBookedFeeCents / 100).toFixed(2),
  }
}

console.log("Run 4 Gigs:", analyzeGigs(r4Events, r4Snap))
console.log("Run 2 Gigs:", analyzeGigs(r2Events, r2Snap))

console.log("\n=== GIG ESCALATION AT BOOKING ===")
// Let's see at what step/fee gigs were booked in R4 vs R2
function analyzeBookingSteps(events: any[], snap: any) {
  const gigMap = new Map(snap.gigs.map((g: any) => [g.id, g]))
  const books = events.filter((e: any) => e.kind === "gig_booked")
  
  let bookedAtFirstStep = 0
  let bookedAtUrgentStep = 0
  let bookedAtMidStep = 0
  
  for (const b of books) {
    const g: any = gigMap.get(b.gigId)
    if (!g || !g.schedule || g.schedule.length === 0) continue
    const firstFee = g.schedule[0].feeCents
    const lastFee = g.schedule[g.schedule.length - 1].feeCents
    if (b.feeCents <= firstFee * 1.02) {
      bookedAtFirstStep++
    } else if (b.feeCents >= lastFee * 0.95) {
      bookedAtUrgentStep++
    } else {
      bookedAtMidStep++
    }
  }
  return {
    totalBooked: books.length,
    bookedAtFirstStep,
    firstStepPct: (bookedAtFirstStep * 100 / books.length).toFixed(1) + "%",
    bookedAtMidStep,
    midStepPct: (bookedAtMidStep * 100 / books.length).toFixed(1) + "%",
    bookedAtUrgentStep,
    urgentStepPct: (bookedAtUrgentStep * 100 / books.length).toFixed(1) + "%"
  }
}

console.log("Run 4 Booking Tiers:", analyzeBookingSteps(r4Events, r4Snap))
console.log("Run 2 Booking Tiers:", analyzeBookingSteps(r2Events, r2Snap))

console.log("\n=== ORDER OUTCOMES (DELIVERY STATUS) ===")
function analyzeDeliveries(events: any[]) {
  const delivered = events.filter((e: any) => e.kind === "delivered")
  const lateRefunds = events.filter((e: any) => e.kind === "ledger" && e.line.kind === "late_refund")
  const revenues = events.filter((e: any) => e.kind === "ledger" && e.line.kind === "revenue")
  
  const lateMinutes: number[] = []
  for (const lr of lateRefunds) {
    const m = lr.line.detail.match(/Late by (\d+) minutes/)
    if (m) lateMinutes.push(Number(m[1]))
  }
  
  return {
    deliveredCount: delivered.length,
    revenueOrdersCount: revenues.length,
    lateDeliveriesCount: lateRefunds.length,
    onTimeDeliveriesCount: revenues.length - lateRefunds.length,
    onTimeRate: ((revenues.length - lateRefunds.length) * 100 / revenues.length).toFixed(2) + "%",
    avgLateMinutes: lateMinutes.length ? (lateMinutes.reduce((a, b) => a + b, 0) / lateMinutes.length).toFixed(0) + "m" : "0m",
    maxLateMinutes: lateMinutes.length ? Math.max(...lateMinutes) + "m" : "0m",
  }
}

console.log("Run 4 Deliveries:", analyzeDeliveries(r4Events))
console.log("Run 2 Deliveries:", analyzeDeliveries(r2Events))
