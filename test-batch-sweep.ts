import { runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()

console.log("=== Testing Batch 8 vs Batch 9 on spread-5 ===")

for (const b of [8, 9]) {
  const strat = { ...baseStrategy, maxOrdersPerBatch: b }
  const start = performance.now()
  const res = await runSimulationRound({
    level: 8,
    seed: "spread-5",
    tuneWithGemini: false,
    persist: false,
    strategyOverride: strat,
  })
  const sec = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`[Batch ${b}] spread-5 (${sec}s): Margin €${(res.score.marginCents / 100).toFixed(2)} | On-Time ${(res.score.onTimeShare * 100).toFixed(1)}% | Won ${res.score.wonOrders}`)
}
