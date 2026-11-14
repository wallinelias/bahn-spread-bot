import { runSimulationRound } from "./bot.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()

console.log("=== Running 5-Seed Benchmark with Dynamic Unchoked Gating ===")

const seeds = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"]
let totalMarginCents = 0
let totalWon = 0
let otSum = 0
let minOt = 1.0

for (const seed of seeds) {
  const start = performance.now()
  const res = await runSimulationRound({
    level: 8,
    seed,
    tuneWithGemini: false,
    persist: false,
    strategyOverride: baseStrategy,
  })
  const sec = ((performance.now() - start) / 1000).toFixed(1)
  const marginEur = res.score.marginCents / 100
  const ot = res.score.onTimeShare
  totalMarginCents += res.score.marginCents
  totalWon += res.score.wonOrders
  otSum += ot
  if (ot < minOt) minOt = ot

  console.log(`[Dynamic] ${seed} (${sec}s): Margin €${marginEur.toFixed(2)} | On-Time ${(ot * 100).toFixed(1)}% | Won ${res.score.wonOrders} | Ranked: ${res.score.ranked}`)
}

const avgMarginEur = (totalMarginCents / 100) / seeds.length
const avgOt = otSum / seeds.length
console.log(`\n=== Benchmark Results ===`)
console.log(`Total 5-Seed Margin: €${(totalMarginCents / 100).toFixed(2)} (Avg €${avgMarginEur.toFixed(2)}/wk)`)
console.log(`Avg On-Time: ${(avgOt * 100).toFixed(1)}% | Min On-Time: ${(minOt * 100).toFixed(1)}%`)
console.log(`Total Won Orders: ${totalWon} (Avg ${(totalWon / seeds.length).toFixed(1)}/wk)`)
console.log(`Safety Buffer Cleared (>=93.3%): ${minOt >= 0.933 ? "✅ YES" : "❌ NO"}`)
