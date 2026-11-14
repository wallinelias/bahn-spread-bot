import { runSimulationRound, type SpreadBot } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()

console.log("=== Testing Volume Expansion on spread-1 ===")

// Test 1: maxOrdersPerBatch = 12
const strat12 = { ...baseStrategy, maxOrdersPerBatch: 12 }
const res12 = await runSimulationRound({
  level: 8,
  seed: "spread-1",
  tuneWithGemini: false,
  persist: false,
  strategyOverride: strat12,
})

console.log(`[Batch 12] Margin €${(res12.score.marginCents / 100).toFixed(2)} | On-Time ${(res12.score.onTimeShare * 100).toFixed(1)}% | Won ${res12.score.wonOrders}`)

// Test on spread-2
const res12_s2 = await runSimulationRound({
  level: 8,
  seed: "spread-2",
  tuneWithGemini: false,
  persist: false,
  strategyOverride: strat12,
})

console.log(`[Batch 12 s2] Margin €${(res12_s2.score.marginCents / 100).toFixed(2)} | On-Time ${(res12_s2.score.onTimeShare * 100).toFixed(1)}% | Won ${res12_s2.score.wonOrders}`)
