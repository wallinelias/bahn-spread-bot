import { runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()

console.log("=== Testing spread-1 and spread-5 with current bot.ts ===")

for (const seed of ["spread-1", "spread-5"]) {
  const start = performance.now()
  const res = await runSimulationRound({
    level: 8,
    seed,
    tuneWithGemini: false,
    persist: false,
    strategyOverride: baseStrategy,
  })
  const sec = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`[Current v10] ${seed} (${sec}s): Margin €${(res.score.marginCents / 100).toFixed(2)} | On-Time ${(res.score.onTimeShare * 100).toFixed(1)}% | Won ${res.score.wonOrders}`)
}
