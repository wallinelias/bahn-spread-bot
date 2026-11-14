import fs from "node:fs"
import { Client, Unreachable, type DeskEventKind } from "../spread.ts"
import { Top10IntegratedDesk, getTop10DeskOptions, type Top10PricerConfig, type ChainingConfig } from "../top10-engine.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"

const DAY = 24 * 60
const WAKE_ON: DeskEventKind[] = [
  "price_request",
  "order_won",
  "order_lost",
  "order_changed",
  "order_cancelled",
  "visit_failed",
  "gig_expired",
  "gig_dropped",
  "no_show",
  "driver_late",
  "deadline_close",
]

export interface BenchPreset {
  name: string
  pricerPatch: Partial<Top10PricerConfig>
  strategyPatch?: Partial<StrategyConfig>
  chainGigs?: boolean
  chainingOptions?: Partial<ChainingConfig>
  useStructuralPriors?: boolean
}

export const PRESETS: Record<string, BenchPreset> = {
  D1: {
    name: "D1_A1_plus_cleanAdverseGuard",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      cleanAdverseGuard: true,
    },
    chainGigs: false,
  },
  D2: {
    name: "D2_balancedBayesianDrift_mu122",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      balancedBayesianDrift: true,
      minQuoteMultiplier: 1.24,
      worldBaseMuFloor: 1.22,
    },
    chainGigs: false,
  },
  D3: {
    name: "D3_balancedDrift_cleanGuard_broadFeeTiers",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      cleanAdverseGuard: true,
      balancedBayesianDrift: true,
      broadFeeTiers: true,
      minQuoteMultiplier: 1.24,
      worldBaseMuFloor: 1.22,
    },
    chainGigs: false,
  },
  C1: {
    name: "C1_A5_plus_patientMorningHoldout",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      patientMorningHoldout: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    chainGigs: false,
  },
  C2: {
    name: "C2_A1_plus_patientMorningHoldout_cleanGuard",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      cleanAdverseGuard: true,
      patientMorningHoldout: true,
    },
    chainGigs: false,
  },
  C3: {
    name: "C3_A5_patientHoldout_cleanGuard_softGate",
    pricerPatch: {
      strictCapacityGate: false,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      cleanAdverseGuard: true,
      patientMorningHoldout: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    strategyPatch: {
      minExpectedMarginRatio: 0.16,
      targetWinRate: 0.35,
    },
    chainGigs: false,
  },
  B1: {
    name: "B1_A5_plus_softCapacityGate",
    pricerPatch: {
      strictCapacityGate: false,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    chainGigs: false,
  },
  B2: {
    name: "B2_A5_plus_smoothFeeStaircase",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      smoothFeeStaircase: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    chainGigs: false,
  },
  B3: {
    name: "B3_A5_softGate_smoothFee_highVol",
    pricerPatch: {
      strictCapacityGate: false,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      smoothFeeStaircase: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    strategyPatch: {
      minExpectedMarginRatio: 0.14,
      targetWinRate: 0.38,
    },
    chainGigs: false,
  },
  V21: {
    name: "v21_baseline",
    pricerPatch: {},
    chainGigs: false,
  },
  U1_HSTOP: {
    name: "U1_HSTOP_only",
    pricerPatch: { hardenPostStops: true },
    chainGigs: false,
  },
  U1_NDROP: {
    name: "U1_NDROP_only",
    pricerPatch: { repostNoFeeDrop: true },
    chainGigs: false,
  },
  A1: {
    name: "A1_softSurge_adverseGuard_only",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
    },
    chainGigs: false,
  },
  A1P: {
    name: "A1P_A1_plus_positivePriorsOnly",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      useStructuralPriors: true,
      positivePriorsOnly: true,
    },
    useStructuralPriors: true,
    chainGigs: false,
  },
  A2: {
    name: "A2_A1_plus_safeMonThu2CarChaining",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
    },
    chainGigs: true,
    chainingOptions: {
      enabled: true,
      maxChainStartDay: 3, // Mon..Thu (days 0..3)
      scarcityGated: true,
      maxOrdersPerChain: 2,
      maxGapMinutes: 30,
      minOrderSlackMinutes: 600,
      openFeeMinMult: 0.86,
      openFeeMaxMult: 0.91,
    },
  },
  A3: {
    name: "A3_A1_plus_smartDirectOffers",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      smartDirectOffers: true,
    },
    chainGigs: false,
  },
  A4: {
    name: "A4_A1_plus_smoothFee_smartDirectOffers",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
    },
    chainGigs: false,
  },
  A5: {
    name: "A5_A1_plus_lowerMuFloor120",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    chainGigs: false,
  },
  A6: {
    name: "A6_A5_plus_safeMonThu2CarChaining",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    chainGigs: true,
    chainingOptions: {
      enabled: true,
      maxChainStartDay: 3, // Mon..Thu
      scarcityGated: true,
      maxOrdersPerChain: 2,
      maxGapMinutes: 30,
      minOrderSlackMinutes: 600,
      openFeeMinMult: 0.85,
      openFeeMaxMult: 0.90,
    },
  },
  A7: {
    name: "A7_A5_plus_smartDirectOffers_positivePriors",
    pricerPatch: {
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      smartDirectOffers: true,
      useStructuralPriors: true,
      positivePriorsOnly: true,
      minQuoteMultiplier: 1.22,
      worldBaseMuFloor: 1.20,
    },
    useStructuralPriors: true,
    chainGigs: false,
  },
  U1: {
    name: "U1_stops_notes_repostNoDrop",
    pricerPatch: { hardenPostStops: true, repostNoFeeDrop: true },
    chainGigs: false,
  },
  U2: {
    name: "U2_U1_plus_smoothFee_smartDirectOffers",
    pricerPatch: {
      hardenPostStops: true,
      repostNoFeeDrop: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
    },
    chainGigs: false,
  },
  U3_NP: {
    name: "U3_NP_U2_plus_softSurge_adverseGuard",
    pricerPatch: {
      hardenPostStops: true,
      repostNoFeeDrop: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
    },
    chainGigs: false,
  },
  U3: {
    name: "U3_U3NP_plus_positivePriorsOnly",
    pricerPatch: {
      hardenPostStops: true,
      repostNoFeeDrop: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      useStructuralPriors: true,
      positivePriorsOnly: true,
    },
    useStructuralPriors: true,
    chainGigs: false,
  },
  U4: {
    name: "U4_U3_plus_safeMonThu2CarChaining",
    pricerPatch: {
      hardenPostStops: true,
      repostNoFeeDrop: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      useStructuralPriors: true,
      positivePriorsOnly: true,
    },
    useStructuralPriors: true,
    chainGigs: true,
    chainingOptions: {
      enabled: true,
      maxChainStartDay: 3, // Mon..Thu (days 0..3)
      scarcityGated: true,
      maxOrdersPerChain: 2,
      maxGapMinutes: 30,
      minOrderSlackMinutes: 600,
      openFeeMinMult: 0.85,
      openFeeMaxMult: 0.90,
    },
  },
  U5: {
    name: "U5_U3_plus_safeMonThu3CarChaining",
    pricerPatch: {
      hardenPostStops: true,
      repostNoFeeDrop: true,
      smoothFeeStaircase: true,
      smartDirectOffers: true,
      softCapacitySurge: true,
      adverseSelectionGuard: true,
      useStructuralPriors: true,
      positivePriorsOnly: true,
    },
    useStructuralPriors: true,
    chainGigs: true,
    chainingOptions: {
      enabled: true,
      maxChainStartDay: 3,
      scarcityGated: true,
      maxOrdersPerChain: 3,
      maxGapMinutes: 35,
      minOrderSlackMinutes: 600,
      openFeeMinMult: 0.86,
      openFeeMaxMult: 0.91,
    },
  },
}

function getArg(flag: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(flag)
  return idx !== -1 ? process.argv[idx + 1] : fallback
}

const tag = getArg("--tag", "U1")!
const seeds = (getArg("--seeds", "spread-4,spread-5")!).split(",").map((s) => s.trim()).filter(Boolean)
const concurrency = Math.max(1, Math.min(4, Number(getArg("--concurrency", "2"))))
const outPath = getArg("--out", `scratch/bench-${tag.toLowerCase()}.json`)!
const saveReveal = process.argv.includes("--reveal")

const preset = PRESETS[tag]
if (!preset) {
  console.error(`Unknown preset --tag ${tag}. Valid: ${Object.keys(PRESETS).join(", ")}`)
  process.exit(1)
}

const baseStrategy = loadStrategy()
const strat: StrategyConfig & Record<string, any> = {
  ...baseStrategy,
  ...(preset.strategyPatch ?? {}),
  flags: {
    ...baseStrategy.flags,
    chainGigs: preset.chainGigs ?? false,
  },
  useStructuralPriors: preset.useStructuralPriors ?? false,
  pricerOptions: { ...preset.pricerPatch },
  chainingOptions: preset.chainingOptions ? { ...preset.chainingOptions } : undefined,
}

const client = new Client()
let map: Awaited<ReturnType<Client["map"]>>
for (let attempt = 1; attempt <= 4; attempt++) {
  try {
    map = await client.map()
    break
  } catch (err) {
    if (attempt < 4 && err instanceof Unreachable) {
      await new Promise((r) => setTimeout(r, 2500))
      continue
    }
    throw err
  }
}

async function runSeed(seed: string) {
  const t0 = Date.now()
  const run = await client.create(8, { seed, board: false })
  try {
    const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
    const opts = getTop10DeskOptions(strat)
    const desk = new Top10IntegratedDesk(run, 8, now, map, roster, strat, opts)
    while (desk.now < endsAt) {
      const day = Math.floor(desk.now / DAY)
      const midnight = (day + 1) * DAY
      const actions = desk.outbox.splice(0)
      const step = await run.advance({
        untilEvent: WAKE_ON,
        max: Math.min(endsAt, midnight),
        actions,
      })
      desk.readResults(actions, step.results)
      desk.now = step.now
      for (const event of step.events) {
        await desk.handle(event)
      }
    }
    desk.finalizeTelemetry()
    const score = await run.score()
    if (saveReveal) {
      const [snap, events, reveal] = await Promise.all([run.snapshot(), run.events(), run.reveal()])
      const revPath = `scratch/reveal_${tag.toLowerCase()}_${seed.replace(/[^a-z0-9_-]/gi, "")}.json`
      fs.writeFileSync(revPath, JSON.stringify({ seed, tag, worldId: run.id, score, telemetry: desk.telemetry, snap, events, reveal, map, roster }))
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    const vfCount = Object.values(desk.telemetry.visitFailuresByReason ?? {}).reduce((a, b) => a + b, 0)
    const lateCount = score.wonOrders - Math.round(score.onTimeShare * score.wonOrders)
    console.log(
      `[${tag}][${seed}] Margin €${(score.marginCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(2)}% | Won ${score.wonOrders} | Decl ${desk.telemetry.declinedHighQuote} | Drops ${desk.telemetry.drops} | VF ${vfCount} (${JSON.stringify(desk.telemetry.visitFailuresByReason ?? {})}) | Offers ${desk.telemetry.acceptedDirectOffers}/${desk.telemetry.totalDirectOffers} | Chains ${desk.chainStats.chainedGigsPosted} | Ranked=${score.ranked} (${sec}s)`,
    )
    return {
      seed,
      marginEur: Number((score.marginCents / 100).toFixed(2)),
      onTimeShare: score.onTimeShare,
      wonOrders: score.wonOrders,
      ranked: score.ranked,
      lateApprox: lateCount,
      telemetry: desk.telemetry,
      chainStats: desk.chainStats,
    }
  } finally {
    for (let dTry = 1; dTry <= 3; dTry++) {
      try {
        await run.delete()
        break
      } catch {
        if (dTry < 3) await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }
}

async function runSeedWithRetry(seed: string) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await runSeed(seed)
    } catch (err: any) {
      const msg = String(err?.message ?? err)
      if (
        attempt < 4 &&
        (err instanceof Unreachable ||
          msg.includes("restarting") ||
          msg.includes("Connect Timeout") ||
          msg.includes("fetch failed"))
      ) {
        console.warn(`[${tag}][${seed}] Transient network error (attempt ${attempt}/4), retrying in 3s: ${msg}`)
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      throw err
    }
  }
}

const results: any[] = []
for (let i = 0; i < seeds.length; i += concurrency) {
  const chunk = seeds.slice(i, i + concurrency)
  const chunkRes = await Promise.all(chunk.map((s) => runSeedWithRetry(s)))
  results.push(...chunkRes)
}

const totalMarginEur = Number(results.reduce((s, r) => s + r.marginEur, 0).toFixed(2))
const avgMarginEur = Number((totalMarginEur / results.length).toFixed(2))
const minOnTime = Math.min(...results.map((r) => r.onTimeShare))
const rankedCount = results.filter((r) => r.ranked).length
const summary = {
  tag,
  preset,
  seeds,
  totalMarginEur,
  avgMarginEur,
  minOnTimePct: Number((minOnTime * 100).toFixed(2)),
  ranked: `${rankedCount}/${results.length}`,
  results,
}
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2))
console.log(
  `\nSUMMARY [${tag}]: Total €${totalMarginEur.toFixed(2)} | Avg €${avgMarginEur.toFixed(2)} | MinOT ${(minOnTime * 100).toFixed(2)}% | Ranked ${rankedCount}/${results.length} | Saved ${outPath}`,
)
