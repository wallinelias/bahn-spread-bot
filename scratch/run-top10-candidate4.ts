import fs from "node:fs"
import { loadStrategy } from "../strategy-config.ts"
import { formatResultMarkdown } from "../experiment-runners.ts"
import { benchmarkTop10Candidate, type CandidateSpec } from "./run-top10-benchmark.ts"

const baseStrategy = loadStrategy()

const specs: CandidateSpec[] = [
  {
    name: "Top10 Candidate 4A: Integrated (twr=0.40, minMargin=0.15, maxWait=0.45, Chaining)",
    strategy: {
      ...baseStrategy,
      targetWinRate: 0.40,
      minExpectedMarginRatio: 0.15,
      maxActiveWaitingPerDriver: 0.45,
      flags: { ...baseStrategy.flags, chainGigs: true },
    },
    deskMode: "integrated",
    opts: {
      useBayesianPricer: true,
      useZeroHoldoutScheduler: true,
      chaining: { enabled: true, maxOrdersPerChain: 3, maxGapMinutes: 45, quoteSynergyEnabled: true },
    },
  },
  {
    name: "Top10 Candidate 4B: Integrated (twr=0.44, minMargin=0.15, maxWait=0.45, Chaining)",
    strategy: {
      ...baseStrategy,
      targetWinRate: 0.44,
      minExpectedMarginRatio: 0.15,
      maxActiveWaitingPerDriver: 0.45,
      flags: { ...baseStrategy.flags, chainGigs: true },
    },
    deskMode: "integrated",
    opts: {
      useBayesianPricer: true,
      useZeroHoldoutScheduler: true,
      chaining: { enabled: true, maxOrdersPerChain: 3, maxGapMinutes: 45, quoteSynergyEnabled: true },
    },
  },
]

const results = []
for (const s of specs) {
  console.log(`\n=== Benchmarking: ${s.name} ===`)
  const res = await benchmarkTop10Candidate(s, undefined, 3)
  console.log(formatResultMarkdown(res))
  console.log("Extra Telemetry:", JSON.stringify(res.extraTelemetry, null, 2))
  results.push(res)
  fs.writeFileSync("scratch/top10-candidate4-results.json", JSON.stringify(results, null, 2))
}
