import fs from "node:fs"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"
import { runCandidate, formatResultMarkdown, type CandidateResult } from "./continuous-sim-worker.ts"

const baseStrategy = loadStrategy()

const candidates: Array<{ name: string; q: number; f: number }> = [
  { name: "Candidate 1 (Baseline v13 Reference)", q: 1.472, f: 1.158 },
  { name: "Candidate 2 (q=1.49, f=1.13)", q: 1.49, f: 1.13 },
  { name: "Candidate 3 (q=1.51, f=1.12)", q: 1.51, f: 1.12 },
  { name: "Candidate 4 (q=1.53, f=1.12)", q: 1.53, f: 1.12 },
  { name: "Candidate 5 (q=1.55, f=1.12)", q: 1.55, f: 1.12 },
  { name: "Candidate 6 (q=1.51, f=1.11)", q: 1.51, f: 1.11 },
]

console.log(`Starting continuous simulation sweep of ${candidates.length} candidates across 5 Level 8 seeds...`)

const allResults: CandidateResult[] = []

for (const c of candidates) {
  console.log(`\n======================================================`)
  console.log(`Evaluating ${c.name}: baseQuoteMultiplier=${c.q}, baseFeeMultiplier=${c.f}`)
  console.log(`======================================================`)

  const strat: StrategyConfig = {
    ...baseStrategy,
    baseQuoteMultiplier: c.q,
    baseFeeMultiplier: c.f,
  }

  const start = performance.now()
  const result = await runCandidate(c.name, strat, c.q, c.f, undefined, 3)
  const elapsed = ((performance.now() - start) / 1000).toFixed(1)

  console.log(`Finished ${c.name} in ${elapsed}s: Avg Margin €${result.avgMarginEur.toFixed(2)} | Min OT ${(result.minOnTimeShare * 100).toFixed(1)}% | Avg OT ${(result.avgOnTimeShare * 100).toFixed(1)}% | Passed: ${result.gatePassed ? "YES" : "NO"}`)
  console.log(formatResultMarkdown(result))

  allResults.push(result)
  fs.writeFileSync("scratch/sim-worker-results.json", JSON.stringify(allResults, null, 2))
}

console.log("\n========================================================")
console.log("SIMULATION WORKER 1: ALL BENCHMARKS COMPLETE")
console.log("========================================================")
