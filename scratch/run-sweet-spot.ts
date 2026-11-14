import fs from "node:fs"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"
import { runCandidate, formatResultMarkdown, type CandidateResult } from "./continuous-sim-worker.ts"

const baseStrategy = loadStrategy()

const sweetSpotCandidates: Array<{
  name: string
  q: number
  f: number
  overrides: Partial<StrategyConfig>
}> = [
  {
    name: "Candidate S1 (Calibrated Sweet Spot: q=1.475, f=1.147, wait=0.304)",
    q: 1.475,
    f: 1.147,
    overrides: {
      baseQuoteMultiplier: 1.475,
      baseFeeMultiplier: 1.147,
      maxActiveWaitingPerDriver: 0.304,
      targetWinRate: 0.315,
      urgentFeeMultiplier: 1.896,
      scarcityTownFeeBoost: 0.170,
    },
  },
  {
    name: "Candidate S2 (Refined Compound: q=1.470, f=1.150, wait=0.310)",
    q: 1.470,
    f: 1.150,
    overrides: {
      baseQuoteMultiplier: 1.470,
      baseFeeMultiplier: 1.150,
      maxActiveWaitingPerDriver: 0.310,
      targetWinRate: 0.315,
      urgentFeeMultiplier: 1.900,
      scarcityTownFeeBoost: 0.170,
    },
  },
  {
    name: "Candidate S3 (Conservative Volume: q=1.465, f=1.152, wait=0.300)",
    q: 1.465,
    f: 1.152,
    overrides: {
      baseQuoteMultiplier: 1.465,
      baseFeeMultiplier: 1.152,
      maxActiveWaitingPerDriver: 0.300,
      targetWinRate: 0.315,
      urgentFeeMultiplier: 1.890,
      scarcityTownFeeBoost: 0.165,
    },
  },
  {
    name: "Candidate S4 (Aggressive Quote Cap: q=1.478, f=1.145, wait=0.310)",
    q: 1.478,
    f: 1.145,
    overrides: {
      baseQuoteMultiplier: 1.478,
      baseFeeMultiplier: 1.145,
      maxActiveWaitingPerDriver: 0.310,
      targetWinRate: 0.315,
      urgentFeeMultiplier: 1.920,
      scarcityTownFeeBoost: 0.170,
    },
  },
]

console.log(`Starting Sweet Spot Calibration Suite (${sweetSpotCandidates.length} candidates) across 5 Level 8 seeds...`)

const allResults: CandidateResult[] = []

for (const c of sweetSpotCandidates) {
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
  fs.writeFileSync("scratch/sim-worker-sweetspot-results.json", JSON.stringify(allResults, null, 2))
}

console.log("\n========================================================")
console.log("SIMULATION WORKER 1: SWEET SPOT BENCHMARK COMPLETE")
console.log("========================================================")
