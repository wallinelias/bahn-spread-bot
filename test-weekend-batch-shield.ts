import { runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()

console.log("=== Testing spread-4 and spread-1 with Weekend Batch Shield ===")
// Let's test on spread-4 first
const res4 = await runSimulationRound({
  level: 8,
  seed: "spread-4",
  tuneWithGemini: false,
  persist: false,
  strategyOverride: baseStrategy,
})
console.log(`spread-4: Margin €${(res4.score.marginCents / 100).toFixed(2)} | On-Time ${(res4.score.onTimeShare * 100).toFixed(1)}% | Won ${res4.score.wonOrders}`)
