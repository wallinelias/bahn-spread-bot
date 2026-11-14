import { readFileSync } from "node:fs"

const r4Events = JSON.parse(readFileSync("./scratch/r4_events.json", "utf-8"))
const r2Events = JSON.parse(readFileSync("./scratch/r2_events.json", "utf-8"))

function trackDealerTrust(events: any[]) {
  // Each dealer starts at 0
  // An on-time delivery increments count by 1 (max 25)
  // A late delivery halves count: Math.floor(count / 2)
  const trust: Record<string, number> = {}
  const lateCount: Record<string, number> = {}
  const onTimeCount: Record<string, number> = {}
  
  // Track order outcomes
  const lateOrders = new Set()
  for (const e of events) {
    if (e.kind === "ledger" && e.line.kind === "late_refund") {
      lateOrders.add(e.line.orderId)
    }
  }
  
  for (const e of events) {
    if (e.kind === "delivered") {
      // Find order dealer
      // The order might be delivered
    }
    if (e.kind === "ledger" && e.line.kind === "revenue") {
      const oId = e.line.orderId
      // Find dealer
      const wonEv = events.find((x: any) => x.kind === "order_won" && (x.order.id === oId || x.order.orderId === oId))
      const dealer = wonEv?.order?.dealerId || "unknown"
      if (!trust[dealer]) trust[dealer] = 0
      
      if (lateOrders.has(oId)) {
        trust[dealer] = Math.floor(trust[dealer] / 2)
        lateCount[dealer] = (lateCount[dealer] || 0) + 1
      } else {
        trust[dealer] = Math.min(25, trust[dealer] + 1)
        onTimeCount[dealer] = (onTimeCount[dealer] || 0) + 1
      }
    }
  }
  
  const totalTrustScore = Object.values(trust).reduce((a, b) => a + b, 0)
  const avgTrust = (totalTrustScore / Object.keys(trust).length).toFixed(1)
  return {
    dealerCount: Object.keys(trust).length,
    totalTrustScore,
    avgTrust,
    trustMap: trust,
    lateCount,
    onTimeCount
  }
}

const t4 = trackDealerTrust(r4Events)
const t2 = trackDealerTrust(r2Events)

console.log("Run 4 Dealer Trust:", {
  totalTrustScore: t4.totalTrustScore,
  avgTrust: t4.avgTrust,
  totalLate: Object.values(t4.lateCount).reduce((a, b) => a + b, 0),
  totalOnTime: Object.values(t4.onTimeCount).reduce((a, b) => a + b, 0)
})

console.log("Run 2 Dealer Trust:", {
  totalTrustScore: t2.totalTrustScore,
  avgTrust: t2.avgTrust,
  totalLate: Object.values(t2.lateCount).reduce((a, b) => a + b, 0),
  totalOnTime: Object.values(t2.onTimeCount).reduce((a, b) => a + b, 0)
})

console.log("\nTop dealers trust at end of Run 4:")
console.table(Object.entries(t4.trustMap).map(([d, tr]) => ({ dealer: d, trust: tr, onTime: t4.onTimeCount[d] || 0, late: t4.lateCount[d] || 0 })).sort((a, b) => b.trust - a.trust).slice(0, 10))

console.log("\nTop dealers trust at end of Run 2:")
console.table(Object.entries(t2.trustMap).map(([d, tr]) => ({ dealer: d, trust: tr, onTime: t2.onTimeCount[d] || 0, late: t2.lateCount[d] || 0 })).sort((a, b) => b.trust - a.trust).slice(0, 10))
