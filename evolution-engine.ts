import fs from "node:fs"
import path from "node:path"
import { runSimulationRound } from "./bot.ts"
import { loadStrategy, saveStrategy, type StrategyConfig, type RoundSummary } from "./strategy-config.ts"

export interface GateCriteria {
  minAvgMarginEur: number
  minOnTimeShare: number
  minAvgOnTimeShare: number
  allRanked: boolean
}

export const OFFICIAL_CHAMPION_GATE: GateCriteria = {
  minAvgMarginEur: 7282.12, // Must beat €7,282.12/wk (Total > €36,410.62)
  minOnTimeShare: 0.933,   // Must maintain >= 93.3% on-time across ALL seeds
  minAvgOnTimeShare: 0.945, // Must maintain >= 94.5% average on-time
  allRanked: true,         // All 5 seeds MUST be RANKED
}

export interface SeedEvaluationResult {
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

export interface CandidateEvaluationResult {
  candidateName: string
  promoted: boolean
  seedResults: SeedEvaluationResult[]
  totalMarginEur: number
  avgMarginEur: number
  avgOnTimeShare: number
  minOnTimeShare: number
  avgWonOrders: number
  allRanked: boolean
  gatePassed: boolean
  gateViolations: string[]
  deltaMarginAvg: number
  deltaMarginTotal: number
}

export function evaluateGate(
  totalMarginEur: number,
  avgMarginEur: number,
  avgOnTimeShare: number,
  minOnTimeShare: number,
  allRanked: boolean,
  gate: GateCriteria = OFFICIAL_CHAMPION_GATE,
): { passed: boolean; violations: string[] } {
  const violations: string[] = []

  if (!allRanked) {
    violations.push("Not all seeds qualified as RANKED (at least one seed had onTimeShare < 90.0% or 0 won orders).")
  }
  if (minOnTimeShare < gate.minOnTimeShare) {
    violations.push(`Worst seed on-time (${(minOnTimeShare * 100).toFixed(1)}%) is below safety buffer gate of ${(gate.minOnTimeShare * 100).toFixed(1)}%.`)
  }
  if (avgOnTimeShare < gate.minAvgOnTimeShare) {
    violations.push(`Average on-time (${(avgOnTimeShare * 100).toFixed(1)}%) is below gate of ${(gate.minAvgOnTimeShare * 100).toFixed(1)}%.`)
  }
  if (avgMarginEur <= gate.minAvgMarginEur) {
    violations.push(`Average margin (€${avgMarginEur.toFixed(2)}/wk) does not beat champion gate (€${gate.minAvgMarginEur.toFixed(2)}/wk, delta: €${(avgMarginEur - gate.minAvgMarginEur).toFixed(2)}/wk).`)
  }

  return {
    passed: violations.length === 0,
    violations,
  }
}

export function formatResultMarkdown(
  name: string,
  seeds: SeedEvaluationResult[],
  avgMarginEur: number,
  totalMarginEur: number,
  avgOnTimeShare: number,
  minOnTimeShare: number,
  avgWonOrders: number,
  allRanked: boolean,
): string {
  let md = `### Benchmark: ${name}\n\n`
  md += `| Seed | Margin (€) | On-Time (%) | Won Orders | Win Rate (%) | Drops | Late | Ranked |\n`
  md += `|---|---|---|---|---|---|---|---|\n`
  for (const s of seeds) {
    md += `| ${s.seed} | €${s.marginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })} | ${(s.onTimeShare * 100).toFixed(1)}% | ${s.wonOrders} | ${(s.winRate * 100).toFixed(1)}% | ${s.gigDrops} | ${s.lateDeliveries} | ${s.ranked ? "✅ YES" : "❌ NO"} |\n`
  }
  md += `\n**Summary:** Avg Margin: **€${avgMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}/wk** (Total: €${totalMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}) | Avg OT: **${(avgOnTimeShare * 100).toFixed(1)}%** | Min OT: **${(minOnTimeShare * 100).toFixed(1)}%** | Avg Won Orders: **${avgWonOrders.toFixed(1)}** | All Ranked: **${allRanked ? "✅ YES" : "❌ NO"}**\n`
  return md
}

export function updateJuryPresentation(
  newVersion: number,
  avgMarginEur: number,
  totalMarginEur: number,
  avgOnTimeShare: number,
  minOnTimeShare: number,
  avgWonOrders: number,
  description: string,
): void {
  const deckPath = path.resolve("JURY_PRESENTATION.md")
  if (!fs.existsSync(deckPath)) return
  let content = fs.readFileSync(deckPath, "utf8")

  const totalEur = `€${totalMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
  const avgEur = `€${avgMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}/week`
  const avgOT = `${(avgOnTimeShare * 100).toFixed(1)}%`
  const minOT = `${(minOnTimeShare * 100).toFixed(1)}%`

  // Slide 1 update
  const slide1Target = /- \*\*5-Week Level 8 Benchmark \(`spread-1` to `spread-5`\):\*\* .*/
  const slide1Replacement = `- **5-Week Level 8 Benchmark (\`spread-1\` to \`spread-5\`):** **${avgEur}** average gross margin (**${totalEur} total**, **${avgOT} average on-time**, **${minOT} worst week**, **5/5 weeks ranked ≥ 90%**), surpassing previous champion by **+€${(totalMarginEur - 36410.62).toFixed(2)}**.`
  content = content.replace(slide1Target, slide1Replacement)

  // Slide 5 table top row update
  const s5Pattern = /\| \*\*Strategy v\d+ \(.*?\) \*\* \| \*\*€[\d,]+\*\* \| \*\*[\d.]+%?\*\* \| \*\*[\d.]+%?\*\* \| \*\*5 \/ 5\*\* \| \d+ \|/
  const s5Replacement = `| **Strategy v${newVersion} (${description})** | **€${Math.round(avgMarginEur).toLocaleString("en-US")}** | **${avgOT}** | **${minOT}** | **5 / 5** | ${Math.round(avgWonOrders)} |`
  content = content.replace(s5Pattern, s5Replacement)

  fs.writeFileSync(deckPath, content, "utf8")
}

export async function evaluateCandidateOnBot(
  name: string,
  strategyOverride: StrategyConfig,
  seeds: string[] = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"],
  concurrency = 4,
): Promise<CandidateEvaluationResult> {
  console.log(`\n================================================================================`)
  console.log(`[EVOLUTION RUNNER] Evaluating Candidate: "${name}"`)
  console.log(`Seeds: ${seeds.join(", ")} | Concurrency: ${concurrency}`)
  console.log(`Gate: Avg Margin > €${OFFICIAL_CHAMPION_GATE.minAvgMarginEur}/wk | Min OT >= ${(OFFICIAL_CHAMPION_GATE.minOnTimeShare * 100).toFixed(1)}% | 5/5 RANKED`)
  console.log(`================================================================================\n`)

  const queue = [...seeds]
  const seedResults: SeedEvaluationResult[] = []
  const startPerf = performance.now()

  const realLog = console.log
  console.log = () => {}

  async function worker() {
    while (queue.length > 0) {
      const seed = queue.shift()!
      let retries = 0
      while (retries < 3) {
        try {
          const s = await runSimulationRound({
            level: 8,
            seed,
            tuneWithGemini: false,
            persist: false,
            strategyOverride,
          })
          const quoted = s.telemetry.quotedToWin || 1
          seedResults.push({
            seed,
            marginEur: Number((s.score.marginCents / 100).toFixed(2)),
            onTimeShare: Number(s.score.onTimeShare.toFixed(4)),
            wonOrders: s.score.wonOrders,
            winRate: Number((s.score.wonOrders / quoted).toFixed(4)),
            gigDrops: s.telemetry.gigDrops ?? 0,
            lateDeliveries: s.telemetry.lateDeliveries ?? 0,
            deadlineWarnings: s.telemetry.deadlineWarnings ?? 0,
            ranked: s.score.ranked,
          })
          break
        } catch (err) {
          retries++
          if (retries >= 3) {
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
      realLog(`[EVOLUTION RUNNER] ${name}: finished ${seed}`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, worker))
  console.log = realLog

  seedResults.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed))

  const count = seedResults.length || 1
  const totalMarginEur = Number(seedResults.reduce((sum, r) => sum + r.marginEur, 0).toFixed(2))
  const avgMarginEur = Number((totalMarginEur / count).toFixed(2))
  const avgOnTimeShare = Number((seedResults.reduce((sum, r) => sum + r.onTimeShare, 0) / count).toFixed(4))
  const minOnTimeShare = Number(Math.min(...seedResults.map((r) => r.onTimeShare)).toFixed(4))
  const avgWonOrders = Number((seedResults.reduce((sum, r) => sum + r.wonOrders, 0) / count).toFixed(1))
  const allRanked = seedResults.every((r) => r.ranked && r.onTimeShare >= 0.90)

  const mdReport = formatResultMarkdown(
    name,
    seedResults,
    avgMarginEur,
    totalMarginEur,
    avgOnTimeShare,
    minOnTimeShare,
    avgWonOrders,
    allRanked,
  )
  console.log(mdReport)

  const gate = evaluateGate(totalMarginEur, avgMarginEur, avgOnTimeShare, minOnTimeShare, allRanked)
  const deltaMarginAvg = Number((avgMarginEur - OFFICIAL_CHAMPION_GATE.minAvgMarginEur).toFixed(2))
  const deltaMarginTotal = Number((totalMarginEur - OFFICIAL_CHAMPION_GATE.minAvgMarginEur * seeds.length).toFixed(2))

  if (gate.passed) {
    console.log(`\n🎉 [GATE PASSED] Candidate "${name}" BEATS Champion Gate!`)
    console.log(`   Margin Gain: +€${deltaMarginAvg}/wk (+€${deltaMarginTotal} total across ${seeds.length} seeds)`)
    console.log(`   On-Time Quality: Min ${(minOnTimeShare * 100).toFixed(1)}% | Avg ${(avgOnTimeShare * 100).toFixed(1)}% (5/5 RANKED)`)

    const promotedStrategy: StrategyConfig = {
      ...strategyOverride,
      version: strategyOverride.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: "ablation-verified-champion",
      reasoningSummary: `Promoted Strategy v${strategyOverride.version + 1}: ${name} (+€${deltaMarginTotal} gain across 5 Level 8 seeds: €${totalMarginEur.toFixed(2)} / €${avgMarginEur.toFixed(2)}/wk avg, ${(avgOnTimeShare * 100).toFixed(1)}% avg OT, ${(minOnTimeShare * 100).toFixed(1)}% min OT, 5/5 RANKED).`,
    }
    saveStrategy(promotedStrategy)
    console.log(`✅ Saved promoted strategy to data/strategy.json (Version ${promotedStrategy.version}).`)

    updateJuryPresentation(promotedStrategy.version, avgMarginEur, totalMarginEur, avgOnTimeShare, minOnTimeShare, avgWonOrders, name)
    console.log(`✅ Updated JURY_PRESENTATION.md with newly verified empirical results.`)

    return {
      candidateName: name,
      promoted: true,
      seedResults,
      totalMarginEur,
      avgMarginEur,
      avgOnTimeShare,
      minOnTimeShare,
      avgWonOrders,
      allRanked,
      gatePassed: true,
      gateViolations: [],
      deltaMarginAvg,
      deltaMarginTotal,
    }
  } else {
    console.log(`\n❌ [GATE REJECTED] Candidate "${name}" did not qualify for promotion:`)
    for (const v of gate.violations) {
      console.log(`   - ${v}`)
    }

    const logPath = path.resolve("data", "ablation_log.json")
    let ablationLog: any[] = []
    if (fs.existsSync(logPath)) {
      try {
        ablationLog = JSON.parse(fs.readFileSync(logPath, "utf8"))
      } catch {}
    }
    ablationLog.push({
      timestamp: new Date().toISOString(),
      candidateName: name,
      passed: false,
      violations: gate.violations,
      totalMarginEur,
      avgMarginEur,
      avgOnTimeShare,
      minOnTimeShare,
      seedResults,
    })
    fs.writeFileSync(logPath, JSON.stringify(ablationLog, null, 2), "utf8")

    return {
      candidateName: name,
      promoted: false,
      seedResults,
      totalMarginEur,
      avgMarginEur,
      avgOnTimeShare,
      minOnTimeShare,
      avgWonOrders,
      allRanked,
      gatePassed: false,
      gateViolations: gate.violations,
      deltaMarginAvg,
      deltaMarginTotal,
    }
  }
}

// CLI runner
if (process.argv[1]?.endsWith("evolution-engine.ts")) {
  const baseStrategy = loadStrategy()
  await evaluateCandidateOnBot("Baseline Strategy v10", baseStrategy, ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"], 4)
}
