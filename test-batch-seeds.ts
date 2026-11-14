import { runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()
const strat12 = { ...baseStrategy, maxOrdersPerBatch: 12 }

console.log("=== Testing Batch 12 on spread-3, spread-4, spread-5 ===")

for (const seed of ["spread-3", "spread-4", "spread-5"]) {
  const start = performance.now()
  const res = await runSimulationRound({
    level: 8,
    seed,
    tuneWithGemini: false,
    persist: false,
    strategyOverride: strat12,
  })
  const sec = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`[Batch 12] ${seed} (${sec}s): Margin €${(res.score.marginCents / 100).toFixed(2)} | On-Time ${(res.score.onTimeShare * 100).toFixed(1)}% | Won ${res.score.wonOrders}`)
}
