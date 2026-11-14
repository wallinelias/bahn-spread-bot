import fs from "node:fs"
import { benchmarkStrategy, formatResultMarkdown, type BenchmarkResult } from "./experiment-runners.ts"
import { loadStrategy } from "./strategy-config.ts"

const baseStrategy = loadStrategy()
const seeds = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"]
const concurrency = 3

const experiments = [
  { name: "Strategy v8 Baseline", toggles: {} },
  { name: "Strategy 1: Dynamic Corridors", toggles: { dynamicCorridors: true } },
  { name: "Strategy 2: Elastic Dealer Pricing", toggles: { elasticDealer: true } },
  { name: "Strategy 3: Adaptive Emergency Surge", toggles: { emergencySurge: true } },
]

console.log(`Starting full 5-seed evaluation across ${experiments.length} strategies (concurrency ${concurrency})...`)
const allResults: BenchmarkResult[] = []

for (const exp of experiments) {
  console.log(`\n=== Running: ${exp.name} ===`)
  const start = performance.now()
  const res = await benchmarkStrategy(exp.name, baseStrategy, exp.toggles, seeds, concurrency)
  const elapsed = ((performance.now() - start) / 1000).toFixed(1)
  console.log(`Completed ${exp.name} in ${elapsed}s: Avg Margin €${res.avgMarginEur}/wk | Min OT ${(res.minOnTimeShare * 100).toFixed(1)}% | Avg OT ${(res.avgOnTimeShare * 100).toFixed(1)}% | Ranked: ${res.allRanked ? "YES" : "NO"}`)
  allResults.push(res)
}

fs.mkdirSync("data", { recursive: true })
fs.writeFileSync("data/experimental-benchmarks.json", JSON.stringify(allResults, null, 2))

console.log("\n========================================================")
console.log("FINAL COMPARATIVE 5-SEED BENCHMARK REPORT")
console.log("========================================================\n")
for (const r of allResults) {
  console.log(formatResultMarkdown(r))
}
