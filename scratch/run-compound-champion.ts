import fs from "node:fs"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"
import { runCandidate, formatResultMarkdown, type CandidateResult } from "./continuous-sim-worker.ts"

const baseStrategy = loadStrategy()

const hypothesisCandidates: Array<{
  name: string
  q: number
  f: number
  overrides: Partial<StrategyConfig>
}> = [
  {
    name: "Hypothesis H1 (Dynamic Compound Champion: q=1.468, f=1.145)",
    q: 1.468,
    f: 1.145,
    overrides: {
      baseQuoteMultiplier: 1.468,
      baseFeeMultiplier: 1.145,
      targetWinRate: 0.315,
      maxActiveWaitingPerDriver: 0.320,
      urgentFeeMultiplier: 1.920,
      scarcityTownFeeBoost: 0.170,
    },
  },
  {
    name: "Hypothesis H2 (Lean Driver Fee Champion: q=1.468, f=1.130)",
    q: 1.468,
    f: 1.130,
    overrides: {
      baseQuoteMultiplier: 1.468,
      baseFeeMultiplier: 1.130,
      targetWinRate: 0.315,
      maxActiveWaitingPerDriver: 0.320,
      urgentFeeMultiplier: 1.920,
      scarcityTownFeeBoost: 0.170,
    },
  },
  {
    name: "Hypothesis H3 (Ultra-Lean Driver Fee: q=1.468, f=1.120)",
    q: 1.468,
    f: 1.120,
    overrides: {
      baseQuoteMultiplier: 1.468,
      baseFeeMultiplier: 1.120,
      targetWinRate: 0.315,
      maxActiveWaitingPerDriver: 0.320,
      urgentFeeMultiplier: 1.920,
      scarcityTownFeeBoost: 0.170,
    },
  },
  {
    name: "Hypothesis H4 (q=1.472 Baseline Quote + Lean Fee f=1.130)",
    q: 1.472,
    f: 1.130,
    overrides: {
      baseQuoteMultiplier: 1.472,
      baseFeeMultiplier: 1.130,
      targetWinRate: 0.315,
      maxActiveWaitingPerDriver: 0.320,
      urgentFeeMultiplier: 1.920,
      scarcityTownFeeBoost: 0.170,
    },
  },
]

console.log(`Starting evaluation of ${hypothesisCandidates.length} Dynamic Compound Champion candidates across 5 Level 8 seeds...`)

const allResults: CandidateResult[] = []

for (const c of hypothesisCandidates) {
  console.log(`\n======================================================`)
  console.log(`Evaluating ${c.name}`)
  console.log(`Parameters: ${JSON.stringify(c.overrides, null, 2)}`)
  console.log(`======================================================`)

  const strat: StrategyConfig = {
    ...baseStrategy,
    ...c.overrides,
  }

  const start = performance.now()
  const result = await runCandidate(c.name, strat, c.q, c.f, undefined, 4)
  const elapsed = ((performance.now() - start) / 1000).toFixed(1)

  console.log(`Finished ${c.name} in ${elapsed}s: Avg Margin €${result.avgMarginEur.toFixed(2)} | Min OT ${(result.minOnTimeShare * 100).toFixed(1)}% | Avg OT ${(result.avgOnTimeShare * 100).toFixed(1)}% | Passed: ${result.gatePassed ? "YES" : "NO"}`)
  console.log(formatResultMarkdown(result))

  allResults.push(result)
  fs.writeFileSync("scratch/sim-worker-compound-results.json", JSON.stringify(allResults, null, 2))
}

console.log("\n========================================================")
console.log("SIMULATION WORKER 1: DYNAMIC COMPOUND HYPOTHESIS BENCHMARK COMPLETE")
console.log("========================================================")
