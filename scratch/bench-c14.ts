import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { runSimulationRound } from "../bot.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"

interface VariantSpec {
  id: string
  label: string
  build: (base: StrategyConfig) => StrategyConfig & {
    pricerOptions?: Record<string, unknown>
    chainingOptions?: Record<string, unknown>
    useStructuralPriors?: boolean
  }
}

const VARIANTS: Record<string, VariantSpec> = {
  a: {
    id: "C14a",
    label: "Hybrid €12/12% + Priors + 0.88x@22h + CrisisShield (Chaining OFF)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-C14a",
      flags: { ...base.flags, chainGigs: false },
      baseQuoteMultiplier: 1.44,
      sameDayQuotePremium: 0.21,
      minExpectedMarginRatio: 0.12,
      targetWinRate: 0.34,
      maxActiveWaitingPerDriver: 0.40,
      maxOrdersPerBatch: 5,
      baseFeeMultiplier: 1.06,
      maxNormalFeeMultiplier: 1.38,
      urgentFeeMultiplier: 1.86,
      maxUrgentFeeMultiplier: 2.30,
      scarcityTownFeeBoost: 0.16,
      targetOnTimeBuffer: 0.935,
      useStructuralPriors: true,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.22,
        worldBaseMuFloor: 1.20,
        useStructuralPriors: true,
        hybridMarginFilter: true,
        minAbsoluteMarginCents: 1200,
        congestedAbsoluteMarginCents: 1550,
      },
    }),
  },
  b: {
    id: "C14b",
    label: "C14a + Scarcity-Gated 2-Car Chaining (0.87-0.92x)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-C14b",
      flags: { ...base.flags, chainGigs: true },
      baseQuoteMultiplier: 1.44,
      sameDayQuotePremium: 0.21,
      minExpectedMarginRatio: 0.12,
      targetWinRate: 0.34,
      maxActiveWaitingPerDriver: 0.40,
      maxOrdersPerBatch: 5,
      baseFeeMultiplier: 1.06,
      maxNormalFeeMultiplier: 1.38,
      urgentFeeMultiplier: 1.86,
      maxUrgentFeeMultiplier: 2.30,
      scarcityTownFeeBoost: 0.16,
      targetOnTimeBuffer: 0.935,
      useStructuralPriors: true,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.22,
        worldBaseMuFloor: 1.20,
        useStructuralPriors: true,
        hybridMarginFilter: true,
        minAbsoluteMarginCents: 1200,
        congestedAbsoluteMarginCents: 1550,
      },
      chainingOptions: {
        enabled: true,
        scarcityGated: true,
        maxOrdersPerChain: 2,
        maxGapMinutes: 28,
        minOrderSlackMinutes: 600,
        openFeeMinMult: 0.87,
        openFeeMaxMult: 0.92,
        quoteSynergyEnabled: false,
        allowChainedCapacityBypass: false,
      },
    }),
  },
  c: {
    id: "C14c",
    label: "C14a + Scarcity-Gated 2-3 Car Chaining + Synergy (twr=0.35)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-C14c",
      flags: { ...base.flags, chainGigs: true },
      baseQuoteMultiplier: 1.42,
      sameDayQuotePremium: 0.20,
      minExpectedMarginRatio: 0.12,
      targetWinRate: 0.35,
      maxActiveWaitingPerDriver: 0.41,
      maxOrdersPerBatch: 5,
      baseFeeMultiplier: 1.05,
      maxNormalFeeMultiplier: 1.38,
      urgentFeeMultiplier: 1.85,
      maxUrgentFeeMultiplier: 2.30,
      scarcityTownFeeBoost: 0.16,
      targetOnTimeBuffer: 0.938,
      useStructuralPriors: true,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.21,
        worldBaseMuFloor: 1.19,
        useStructuralPriors: true,
        hybridMarginFilter: true,
        minAbsoluteMarginCents: 1200,
        congestedAbsoluteMarginCents: 1600,
      },
      chainingOptions: {
        enabled: true,
        scarcityGated: true,
        maxOrdersPerChain: 3,
        maxGapMinutes: 30,
        minOrderSlackMinutes: 600,
        openFeeMinMult: 0.85,
        openFeeMaxMult: 0.91,
        quoteSynergyEnabled: true,
        allowChainedCapacityBypass: false,
      },
    }),
  },
  k1: {
    id: "K1_Hybrid",
    label: "Exact v21/C6 + ONLY HybridMarginFilter (€14/12%, No Priors, Old Fee)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-K1",
      flags: { ...base.flags, chainGigs: false },
      useStructuralPriors: false,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.29,
        worldBaseMuFloor: 1.32,
        useStructuralPriors: false,
        hybridMarginFilter: true,
        minAbsoluteMarginCents: 1400,
        congestedAbsoluteMarginCents: 1700,
        broadFeeTiers: false,
      },
    }),
  },
  k2: {
    id: "K2_Fee22h",
    label: "Exact v21/C6 + ONLY BroadFeeTiers (0.88@22h / 0.94@14h @ 3+ drivers)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-K2",
      flags: { ...base.flags, chainGigs: false },
      useStructuralPriors: false,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.29,
        worldBaseMuFloor: 1.32,
        useStructuralPriors: false,
        hybridMarginFilter: false,
        broadFeeTiers: true,
      },
    }),
  },
  k3: {
    id: "K3_PosPriors",
    label: "Exact v21/C6 + ONLY Positive Structural Priors (boost>0 only)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-K3",
      flags: { ...base.flags, chainGigs: false },
      useStructuralPriors: true,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.29,
        worldBaseMuFloor: 1.32,
        useStructuralPriors: true,
        positivePriorsOnly: true,
        hybridMarginFilter: false,
        broadFeeTiers: false,
      },
    }),
  },
  k4: {
    id: "K4_C9SafeDay3",
    label: "Exact C9 + ScarcityGated + maxChainStartDay=3 (Mon-Thu chains)",
    build: (base) => ({
      ...base,
      updatedBy: "bench-K4",
      flags: { ...base.flags, chainGigs: true },
      baseQuoteMultiplier: 1.42,
      sameDayQuotePremium: 0.22,
      minExpectedMarginRatio: 0.20,
      targetWinRate: 0.34,
      maxActiveWaitingPerDriver: 0.40,
      maxOrdersPerBatch: 5,
      baseFeeMultiplier: 1.06,
      maxNormalFeeMultiplier: 1.38,
      urgentFeeMultiplier: 1.80,
      maxUrgentFeeMultiplier: 2.25,
      scarcityTownFeeBoost: 0.15,
      targetOnTimeBuffer: 0.935,
      useStructuralPriors: false,
      pricerOptions: {
        strictCapacityGate: true,
        minQuoteMultiplier: 1.30,
        worldBaseMuFloor: 1.33,
        useStructuralPriors: false,
        hybridMarginFilter: false,
        broadFeeTiers: false,
      },
      chainingOptions: {
        enabled: true,
        scarcityGated: true,
        maxChainStartDay: 3,
        maxOrdersPerChain: 2,
        maxGapMinutes: 25,
        minOrderSlackMinutes: 600,
        openFeeMinMult: 0.88,
        openFeeMaxMult: 0.92,
        quoteSynergyEnabled: false,
        allowChainedCapacityBypass: false,
      },
    }),
  },
}

const { values } = parseArgs({
  options: {
    variants: { type: "string", default: "a,b" },
    seeds: { type: "string", default: "spread-1,spread-2,spread-3,spread-4,spread-5" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: "scratch/bench-c14-ab.json" },
  },
})

const selectedIds = values.variants!.split(",").map((s) => s.trim()).filter((k) => VARIANTS[k])
const seeds = values.seeds!.split(",").map((s) => s.trim()).filter(Boolean)
const concurrency = Math.min(4, Math.max(1, Number(values.concurrency || 4)))
const base = loadStrategy()

type JobResult = {
  variant: string
  seed: string
  marginEur: number
  revEur: number
  wonOrders: number
  onTimeShare: number
  ranked: boolean
  gigDrops: number
  lateDeliveries: number
  visitFailures: Record<string, number>
  lateRefundEur: number
}

const jobs: Array<{ key: string; variant: VariantSpec; seed: string; strat: StrategyConfig }> = []
for (const key of selectedIds) {
  const v = VARIANTS[key]!
  const strat = v.build(base)
  for (const seed of seeds) {
    jobs.push({ key, variant: v, seed, strat })
  }
}

console.log(`Running ${jobs.length} sims (${selectedIds.join(",")} x [${seeds.join(",")}]) @ concurrency=${concurrency}...`)
const results: JobResult[] = []
let idx = 0

async function worker() {
  while (true) {
    const i = idx++
    if (i >= jobs.length) return
    const job = jobs[i]!
    const sum = await runSimulationRound({
      level: 8,
      seed: job.seed,
      board: false,
      tuneWithGemini: false,
      persist: false,
      quiet: true,
      strategyOverride: job.strat,
    })
    const res: JobResult = {
      variant: job.variant.id,
      seed: job.seed,
      marginEur: Number((sum.score.marginCents / 100).toFixed(2)),
      revEur: Number((sum.score.revenueCents / 100).toFixed(2)),
      wonOrders: sum.score.wonOrders,
      onTimeShare: Number(sum.score.onTimeShare.toFixed(4)),
      ranked: sum.score.ranked,
      gigDrops: sum.telemetry.gigDrops,
      lateDeliveries: sum.telemetry.lateDeliveries,
      visitFailures: sum.telemetry.visitFailures,
      lateRefundEur: Number(((Math.abs(sum.telemetry.ledgerBreakdownCents?.late_refund ?? 0)) / 100).toFixed(2)),
    }
    results.push(res)
    console.log(
      `[${res.variant} | ${res.seed}] €${res.marginEur.toFixed(2)} | won=${res.wonOrders} | OT=${(res.onTimeShare * 100).toFixed(2)}% | drops=${res.gigDrops} | late=${res.lateDeliveries} | ${res.ranked ? "RANKED" : "UNRANKED"}`,
    )
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))

const summaryByVariant: Record<string, unknown> = {}
console.log("\n=== SUMMARY ===")
for (const key of selectedIds) {
  const v = VARIANTS[key]!
  const rows = results.filter((r) => r.variant === v.id).sort((a, b) => a.seed.localeCompare(b.seed))
  const totalMargin = rows.reduce((s, r) => s + r.marginEur, 0)
  const avgOT = rows.reduce((s, r) => s + r.onTimeShare, 0) / rows.length
  const minOT = Math.min(...rows.map((r) => r.onTimeShare))
  const allRanked = rows.every((r) => r.ranked)
  const totalWon = rows.reduce((s, r) => s + r.wonOrders, 0)
  const totalDrops = rows.reduce((s, r) => s + r.gigDrops, 0)
  summaryByVariant[v.id] = {
    label: v.label,
    totalMarginEur: Number(totalMargin.toFixed(2)),
    avgMarginEur: Number((totalMargin / rows.length).toFixed(2)),
    avgOnTimeShare: Number(avgOT.toFixed(4)),
    minOnTimeShare: Number(minOT.toFixed(4)),
    allRanked,
    totalWon,
    totalDrops,
    rows,
  }
  console.log(
    `${v.id} (${v.label}): Total €${totalMargin.toFixed(2)} (avg €${(totalMargin / rows.length).toFixed(2)}) | avgOT ${(avgOT * 100).toFixed(2)}% | minOT ${(minOT * 100).toFixed(2)}% | won=${totalWon} | drops=${totalDrops} | ${allRanked ? "5/5 RANKED" : "UNRANKED"}`,
  )
}

const outPath = path.resolve(process.cwd(), values.out!)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(summaryByVariant, null, 2))
console.log(`Saved -> ${outPath}`)
