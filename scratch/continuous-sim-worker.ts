import fs from "node:fs"
import path from "node:path"
import { runSimulationRound } from "../bot.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"

export interface SeedResult {
  seed: string
  marginEur: number
  onTimeShare: number
  wonOrders: number
  winRate: number
  gigDrops: number
  lateDeliveries: number
  deadlineWarnings: number
  ranked: boolean
  error?: string
}

export interface CandidateResult {
  name: string
  q: number
  f: number
  clampCeiling?: number
  strategy: StrategyConfig
  seedResults: SeedResult[]
  totalMarginEur: number
  avgMarginEur: number
  avgOnTimeShare: number
  minOnTimeShare: number
  avgWonOrders: number
  allRanked: boolean
  gatePassed: boolean
  violations: string[]
}

const SEEDS = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"]
const GATE = {
  minAvgMarginEur: 7282.12,
  minOnTimeShare: 0.933,
  minAvgOnTimeShare: 0.945,
  allRanked: true,
}

export async function runCandidate(
  name: string,
  strategyOverride: StrategyConfig,
  q: number,
  f: number,
  clampCeiling?: number,
  concurrency = 3,
): Promise<CandidateResult> {
  const queue = [...SEEDS]
  const seedResults: SeedResult[] = []

  const originalLog = console.log
  console.log = () => {}

  async function worker() {
    while (queue.length > 0) {
      const seed = queue.shift()!
      let retries = 0
      while (retries < 3) {
        try {
          const res = await runSimulationRound({
            level: 8,
            seed,
            tuneWithGemini: false,
            persist: false,
            strategyOverride,
          })
          const quoted = res.telemetry.quotedToWin || 1
          seedResults.push({
            seed,
            marginEur: Number((res.score.marginCents / 100).toFixed(2)),
            onTimeShare: Number(res.score.onTimeShare.toFixed(4)),
            wonOrders: res.score.wonOrders,
            winRate: Number((res.score.wonOrders / quoted).toFixed(4)),
            gigDrops: res.telemetry.gigDrops ?? 0,
            lateDeliveries: res.telemetry.lateDeliveries ?? 0,
            deadlineWarnings: res.telemetry.deadlineWarnings ?? 0,
            ranked: res.score.ranked,
          })
          break
        } catch (err) {
          retries++
          if (retries >= 3) {
            originalLog(`[SIM-WORKER] Error on ${seed} (${name}): ${(err as Error).message}`)
            seedResults.push({
              seed,
              marginEur: 0,
              onTimeShare: 0,
              wonOrders: 0,
              winRate: 0,
              gigDrops: 0,
              lateDeliveries: 0,
              deadlineWarnings: 0,
              ranked: false,
              error: (err as Error).message,
            })
            break
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      originalLog(`[SIM-WORKER] ${name}: finished ${seed}`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, SEEDS.length) }, worker))
  console.log = originalLog

  seedResults.sort((a, b) => SEEDS.indexOf(a.seed) - SEEDS.indexOf(b.seed))

  const count = seedResults.length || 1
  const totalMarginEur = Number(seedResults.reduce((sum, r) => sum + r.marginEur, 0).toFixed(2))
  const avgMarginEur = Number((totalMarginEur / count).toFixed(2))
  const avgOnTimeShare = Number((seedResults.reduce((sum, r) => sum + r.onTimeShare, 0) / count).toFixed(4))
  const minOnTimeShare = Number(Math.min(...seedResults.map((r) => r.onTimeShare)).toFixed(4))
  const avgWonOrders = Number((seedResults.reduce((sum, r) => sum + r.wonOrders, 0) / count).toFixed(1))
  const allRanked = seedResults.every((r) => r.ranked && r.onTimeShare >= 0.90)

  const violations: string[] = []
  if (!allRanked) violations.push("Not all seeds ranked")
  if (minOnTimeShare < GATE.minOnTimeShare) {
    violations.push(`Worst seed on-time (${(minOnTimeShare * 100).toFixed(1)}%) < ${(GATE.minOnTimeShare * 100).toFixed(1)}% safety buffer`)
  }
  if (avgOnTimeShare < GATE.minAvgOnTimeShare) {
    violations.push(`Avg on-time (${(avgOnTimeShare * 100).toFixed(1)}%) < ${(GATE.minAvgOnTimeShare * 100).toFixed(1)}%`)
  }
  if (avgMarginEur <= GATE.minAvgMarginEur) {
    violations.push(`Avg margin €${avgMarginEur.toFixed(2)}/wk does not beat champion gate €${GATE.minAvgMarginEur.toFixed(2)}/wk (Δ: €${(avgMarginEur - GATE.minAvgMarginEur).toFixed(2)})`)
  }

  return {
    name,
    q,
    f,
    clampCeiling,
    strategy: strategyOverride,
    seedResults,
    totalMarginEur,
    avgMarginEur,
    avgOnTimeShare,
    minOnTimeShare,
    avgWonOrders,
    allRanked,
    gatePassed: violations.length === 0,
    violations,
  }
}

export function formatResultMarkdown(res: CandidateResult): string {
  let md = `### Candidate Benchmark: ${res.name} (q=${res.q}, f=${res.f})\n\n`
  md += `| Seed | Margin (€) | On-Time (%) | Won Orders | Win Rate (%) | Drops | Late | Ranked |\n`
  md += `|---|---|---|---|---|---|---|---|\n`
  for (const s of res.seedResults) {
    md += `| ${s.seed} | €${s.marginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })} | ${(s.onTimeShare * 100).toFixed(1)}% | ${s.wonOrders} | ${(s.winRate * 100).toFixed(1)}% | ${s.gigDrops} | ${s.lateDeliveries} | ${s.ranked ? "✅ YES" : "❌ NO"} |\n`
  }
  md += `\n**Aggregate Metrics:**\n`
  md += `- **Avg Margin:** €${res.avgMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}/wk (Total: €${res.totalMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })})\n`
  md += `- **On-Time Reliability:** Avg: **${(res.avgOnTimeShare * 100).toFixed(1)}%** | Worst Seed (Min): **${(res.minOnTimeShare * 100).toFixed(1)}%** (Safety buffer: >= 93.3%)\n`
  md += `- **Won Orders:** Avg ${res.avgWonOrders.toFixed(1)} orders/wk\n`
  md += `- **Gate Status:** ${res.gatePassed ? "🎉 **PASSED — QUALIFIED FOR PROMOTION**" : "❌ **REJECTED** (" + res.violations.join(", ") + ")"}\n`
  return md
}
