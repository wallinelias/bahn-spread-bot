import { Client } from "./spread.ts"
import { QuantitativeDesk, runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const strat = loadStrategy()
for (const seed of ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"]) {
  const res = await runSimulationRound({
    level: 8,
    seed,
    tuneWithGemini: false,
    persist: false,
    quiet: true,
    strategyOverride: strat,
  })
  const t = res.telemetry
  console.log(
    `${seed}: Margin €${(res.score.marginCents / 100).toFixed(2)} | OT ${(res.score.onTimeShare * 100).toFixed(1)}% | ` +
    `Reqs ${t.totalRequests} | Quoted ${t.quotedToWin} | Declined ${t.declinedHighQuote} | Won ${t.wonOrders} (${(t.winRateTargeted * 100).toFixed(1)}% tgt) | ` +
    `Booked ${t.totalGigsBooked}/${t.totalGigsPosted} | Offers ${t.acceptedDirectOffers}/${t.totalDirectOffers} | Drops ${t.gigDrops} | Late ${t.lateDeliveries}`
  )
  console.log(`   Ledger:`, Object.entries(t.ledgerBreakdownCents).map(([k, v]) => `${k}: €${(v / 100).toFixed(0)}`).join(", "))
}
