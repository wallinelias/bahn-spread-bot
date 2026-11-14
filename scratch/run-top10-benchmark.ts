import fs from "node:fs"
import { parseArgs } from "node:util"
import {
  Client,
  type DeskEvent,
  type DeskEventKind,
  type DriverProfile,
  type OpeningHours,
  type Order,
  type PriceRequest,
  type WorldMap,
} from "../spread.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"
import { formatResultMarkdown, type BenchmarkResult } from "../experiment-runners.ts"
import { Top10ChainingDesk, runChainingUnitTests, type ChainingConfig } from "./top10-chaining.ts"
import { Top10IntegratedDesk, type IntegratedDeskOptions } from "./top10-integrated-desk.ts"

const HOUR = 60
const DAY = 24 * HOUR

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
  "forecast",
]

export interface CandidateSpec {
  name: string
  strategy: StrategyConfig
  deskMode: "chaining_only" | "integrated"
  opts: Partial<IntegratedDeskOptions>
}

export async function benchmarkTop10Candidate(
  spec: CandidateSpec,
  seeds = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"],
  concurrency = 2,
): Promise<BenchmarkResult & { extraTelemetry: Record<string, unknown> }> {
  const client = new Client()
  const map = await client.map()
  const seedResults: BenchmarkResult["seedResults"] = []
  const perSeedExtra: Record<string, unknown>[] = []
  const queue = [...seeds]
  const origLog = console.log
  console.log = () => {}

  async function worker() {
    while (queue.length > 0) {
      const seed = queue.shift()!
      const run = await client.create(8, { seed, board: false })
      try {
        const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
        const desk =
          spec.deskMode === "chaining_only"
            ? new Top10ChainingDesk(run, 8, now, map, roster, { ...spec.strategy }, spec.opts.chaining ?? {})
            : new Top10IntegratedDesk(run, 8, now, map, roster, { ...spec.strategy }, spec.opts)

        while (desk.now < endsAt) {
          const day = Math.floor(desk.now / DAY)
          const midnight = (day + 1) * DAY
          const actions = desk.outbox.splice(0)
          const step = await run.advance({ untilEvent: WAKE_ON, max: Math.min(endsAt, midnight), actions })
          desk.readResults(actions, step.results ?? [])
          desk.now = step.now
          for (const event of step.events) await desk.handle(event)
        }

        const score = await run.score()
        desk.finalizeTelemetry()
        const quoted = desk.telemetry.quotedToWin || 1
        const visitFailuresTotal = Object.values(desk.telemetry.visitFailures).reduce((a, b) => a + b, 0)

        seedResults.push({
          seed,
          marginEur: Number((score.marginCents / 100).toFixed(2)),
          onTimeShare: Number(score.onTimeShare.toFixed(4)),
          wonOrders: score.wonOrders,
          winRate: Number((score.wonOrders / quoted).toFixed(4)),
          gigDrops: desk.telemetry.gigDrops ?? 0,
          lateDeliveries: desk.telemetry.lateDeliveries ?? 0,
          deadlineWarnings: desk.telemetry.deadlineWarnings ?? 0,
          ranked: score.ranked,
        })
        perSeedExtra.push({
          seed,
          visitFailures: desk.telemetry.visitFailures,
          visitFailuresTotal,
          chainStats: desk.chainStats,
          revenueEur: Number((score.revenueCents / 100).toFixed(2)),
          marginShare: Number(score.marginShare.toFixed(4)),
          totalGigsPosted: desk.telemetry.totalGigsPosted,
          totalGigsBooked: desk.telemetry.totalGigsBooked,
          totalDirectOffers: desk.telemetry.totalDirectOffers,
          acceptedDirectOffers: desk.telemetry.acceptedDirectOffers,
        })
        origLog(
          `[TOP10] ${spec.name} | ${seed}: €${(score.marginCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(2)}% | Won ${score.wonOrders} | VF ${visitFailuresTotal} | Chains ${desk.chainStats.chainedGigsPosted} (3-car: ${desk.chainStats.chained3CarPosted}) | Syn ${desk.chainStats.quoteSynergyHits}`,
        )
      } finally {
        await run.delete().catch(() => {})
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, worker))
  console.log = origLog

  seedResults.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed))
  perSeedExtra.sort((a: any, b: any) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed))
  const totalMargin = seedResults.reduce((s, r) => s + r.marginEur, 0)
  const avgMargin = totalMargin / seedResults.length
  const avgOT = seedResults.reduce((s, r) => s + r.onTimeShare, 0) / seedResults.length
  const minOT = Math.min(...seedResults.map((r) => r.onTimeShare))
  const avgWon = seedResults.reduce((s, r) => s + r.wonOrders, 0) / seedResults.length

  return {
    name: spec.name,
    toggles: spec.opts as any,
    seeds,
    seedResults,
    avgMarginEur: Number(avgMargin.toFixed(2)),
    totalMarginEur: Number(totalMargin.toFixed(2)),
    avgOnTimeShare: Number(avgOT.toFixed(4)),
    minOnTimeShare: Number(minOT.toFixed(4)),
    avgWonOrders: Number(avgWon.toFixed(1)),
    allRanked: seedResults.every((r) => r.ranked && r.onTimeShare >= 0.9),
    extraTelemetry: { perSeedExtra },
  }
}

export async function runOfflineLifecycleTests(): Promise<{ passed: number; failed: number }> {
  const unit = runChainingUnitTests()
  for (const d of unit.details) console.log(d)

  let passed = unit.passed
  let failed = unit.failed
  const assert = (cond: boolean, label: string) => {
    if (cond) {
      passed++
      console.log(`PASS: ${label}`)
    } else {
      failed++
      console.log(`FAIL: ${label}`)
    }
  }

  // Mock world and map for full Top10IntegratedDesk event-lifecycle test (0 HTTP calls)
  let seqId = 1
  const mockWorld = {
    act: async (actions: any[]) =>
      actions.map((a) => (a.type === "post" ? { ok: true, id: `G_${seqId++}` } : { ok: true, id: a.gigId ?? "ok" })),
  }
  const map: WorldMap = {
    places: [
      { id: "HSL", name: "Helsinki", lat: 60.17, lon: 24.94 },
      { id: "TRE", name: "Tampere", lat: 61.5, lon: 23.79 },
      { id: "TKU", name: "Turku", lat: 60.45, lon: 22.27 },
      { id: "SLO", name: "Salo", lat: 60.38, lon: 23.13 },
    ],
    roads: [
      { from: "HSL", to: "TRE", km: 175, minutes: 110 },
      { from: "TRE", to: "HSL", km: 175, minutes: 110 },
      { from: "TRE", to: "TKU", km: 160, minutes: 100 },
      { from: "TKU", to: "TRE", km: 160, minutes: 100 },
      { from: "TKU", to: "SLO", km: 55, minutes: 35 },
      { from: "SLO", to: "TKU", km: 55, minutes: 35 },
      { from: "SLO", to: "HSL", km: 115, minutes: 70 },
      { from: "HSL", to: "SLO", km: 115, minutes: 70 },
    ],
  }
  const roster: DriverProfile[] = Array.from({ length: 12 }, (_, idx) => ({
    id: `DRV_${idx}`,
    homePlaceId: ["HSL", "TRE", "TKU", "SLO"][idx % 4]!,
    rating: 4.9,
    licence: "manual",
    completedGigs: 80,
    drops: 0,
  }))
  const stdHours: OpeningHours = {
    opens: 8 * HOUR,
    closes: 18 * HOUR,
    weekdays: [0, 1, 2, 3, 4],
    saturday: { opens: 9 * HOUR, closes: 14 * HOUR },
  }
  const strategy = loadStrategy()
  const now0 = 9 * HOUR
  const desk = new Top10IntegratedDesk(mockWorld, 8, now0, map, roster, { ...strategy }, {})

  const mkReq = (id: string, from: string, to: string, at: number, refCents = 10000): PriceRequest => ({
    id,
    dealerId: "D01",
    batchId: null,
    arrivedAt: at,
    respondBy: at + 15,
    legs: [
      {
        car: { premium: false, electric: false, chargePercent: 80 },
        pickup: { placeId: from, privateAddress: false, window: { from: at, to: 4 * DAY + 20 * HOUR }, hours: stdHours },
        delivery: { placeId: to, privateAddress: false, window: { from: at, to: 4 * DAY + 20 * HOUR }, hours: stdHours },
      },
    ],
    options: [
      { kind: "next_day", deadline: 1 * DAY + 20 * HOUR, listPriceCents: 22000 },
      { kind: "within_3_days", deadline: 4 * DAY + 20 * HOUR, listPriceCents: 20000 },
    ],
    referenceFeeCents: refCents,
    note: null,
  })
  const mkOrder = (req: PriceRequest): Order => ({
    id: req.id,
    dealerId: req.dealerId,
    option: "within_3_days",
    priceCents: 30000,
    deadline: 4 * DAY + 20 * HOUR,
    legs: req.legs,
    status: "waiting",
    deliveredAt: [null],
    lastPickupAt: 4 * DAY + 12 * HOUR,
  })

  // 1. Win first order R1 (HSL -> TRE) -> posted as single gig G_1
  const r1 = mkReq("R1", "HSL", "TRE", now0)
  await desk.handle({ seq: 1, at: now0, kind: "price_request", request: r1 } as DeskEvent)
  desk.outbox.splice(0)
  await desk.handle({ seq: 2, at: now0 + 15, kind: "order_won", order: mkOrder(r1) } as DeskEvent)
  await desk.send()
  assert(desk.gigsOf("R1").length === 1, "R1 posted as solo gig G_1")

  // 2. Incoming request R2 (TRE -> TKU) should hit quote synergy with R1!
  desk.now = now0 + 20
  const r2 = mkReq("R2", "TRE", "TKU", desk.now)
  await desk.handle({ seq: 3, at: desk.now, kind: "price_request", request: r2 } as DeskEvent)
  assert(desk.chainStats.quoteSynergyHits === 1 && desk.lastQuoteSynergy.get("R2")?.matched === true, "R2 triggered quote() synergy discount against R1")
  desk.outbox.splice(0)

  // 3. Win R2 -> chains R1 + R2 into 2-car gig
  desk.now = now0 + 35
  await desk.handle({ seq: 4, at: desk.now, kind: "order_won", order: mkOrder(r2) } as DeskEvent)
  await desk.send()
  assert(
    desk.chainStats.chained2CarPosted === 1 && desk.gigsOf("R1")[0] === desk.gigsOf("R2")[0],
    `R1 + R2 consolidated into single 2-car gig (${desk.gigsOf("R1")[0]})`,
  )

  // 4. Win R3 (SLO -> HSL, 35m gap from TKU) -> extends 2-car gig to 3-car chain!
  desk.now = now0 + 50
  const r3 = mkReq("R3", "SLO", "HSL", desk.now)
  await desk.handle({ seq: 5, at: desk.now, kind: "price_request", request: r3 } as DeskEvent)
  desk.outbox.splice(0)
  desk.now = now0 + 65
  await desk.handle({ seq: 6, at: desk.now, kind: "order_won", order: mkOrder(r3) } as DeskEvent)
  await desk.send()
  const g1 = desk.gigsOf("R1")[0]
  const g2 = desk.gigsOf("R2")[0]
  const g3 = desk.gigsOf("R3")[0]
  assert(
    desk.chainStats.chained3CarPosted === 1 && g1 !== undefined && g1 === g2 && g2 === g3,
    `R1 + R2 + R3 extended into 3-car chain (${g1})`,
  )

  // 5. Trigger deadline_close on R2 -> must safely withdraw & split 3-car gig into 3 solo gigs!
  desk.now = now0 + 90
  await desk.handle({ seq: 7, at: desk.now, kind: "deadline_close", orderId: "R2", lastPickupAt: now0 + 270 } as DeskEvent)
  await desk.send()
  const g1After = desk.gigsOf("R1")[0]
  const g2After = desk.gigsOf("R2")[0]
  const g3After = desk.gigsOf("R3")[0]
  assert(
    desk.chainStats.chainSplitsOnUrgent === 1 &&
      g1After !== undefined &&
      g2After !== undefined &&
      g3After !== undefined &&
      new Set([g1After, g2After, g3After]).size === 3,
    `deadline_close split 3-car chain into 3 distinct solo gigs (${g1After}, ${g2After}, ${g3After})`,
  )

  console.log(`\nIntegrated lifecycle test summary: ${passed} passed, ${failed} failed`)
  return { passed, failed }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { values } = parseArgs({
    options: {
      "test-offline": { type: "boolean", default: false },
      run: { type: "boolean", default: false },
      concurrency: { type: "string", default: "2" },
      only: { type: "string", default: "" },
      out: { type: "string", default: "scratch/top10-benchmark-results.json" },
    },
  })

  if (values["test-offline"]) {
    const res = await runOfflineLifecycleTests()
    if (res.failed > 0) process.exit(1)
  }

  if (values.run) {
    const baseStrategy = loadStrategy()
    const concurrency = Math.max(1, Number(values.concurrency) || 2)
    const specs: CandidateSpec[] = [
      {
        name: "C1: v15 + Multi-Car Chaining + Quote Synergy",
        strategy: { ...baseStrategy, flags: { ...baseStrategy.flags, chainGigs: true } },
        deskMode: "chaining_only",
        opts: {
          chaining: { enabled: true, maxOrdersPerChain: 3, maxGapMinutes: 45, quoteSynergyEnabled: true },
        },
      },
      {
        name: "C2: Integrated (v15 + Bayesian Pricer + Zero-Holdout + Chaining)",
        strategy: { ...baseStrategy, flags: { ...baseStrategy.flags, chainGigs: true } },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: { enabled: true, maxOrdersPerChain: 3, maxGapMinutes: 45, quoteSynergyEnabled: true },
        },
      },
      {
        name: "C3: Integrated (v14 Safety Base + Bayesian Pricer + Chaining)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.44,
          maxActiveWaitingPerDriver: 0.36,
          baseFeeMultiplier: 1.12,
          maxNormalFeeMultiplier: 1.42,
          urgentFeeMultiplier: 1.9,
          maxUrgentFeeMultiplier: 2.35,
          scarcityTownFeeBoost: 0.16,
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
        name: "C4: Top10 Volume+Margin (twr=0.43, minMargin=0.15, maxWait=0.45, q=1.38)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.38,
          minExpectedMarginRatio: 0.15,
          targetWinRate: 0.43,
          maxActiveWaitingPerDriver: 0.45,
          maxOrdersPerBatch: 7,
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
        name: "C5: Top10 Balanced (twr=0.38, minMargin=0.15, maxWait=0.45, q=1.40)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.4,
          minExpectedMarginRatio: 0.15,
          targetWinRate: 0.38,
          maxActiveWaitingPerDriver: 0.45,
          maxOrdersPerBatch: 6,
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
        name: "C6: Strict Bayesian + ZeroHoldout (v15 base, Chaining OFF)",
        strategy: {
          ...baseStrategy,
          minExpectedMarginRatio: 0.19,
          flags: { ...baseStrategy.flags, chainGigs: false },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: { enabled: false },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.29, worldBaseMuFloor: 1.32 },
        },
      },
      {
        name: "C7: C6 + Safe 2-Car 0.88x Chaining (QuoteSynergy OFF)",
        strategy: {
          ...baseStrategy,
          minExpectedMarginRatio: 0.19,
          flags: { ...baseStrategy.flags, chainGigs: true },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 600,
            openFeeMinMult: 0.88,
            openFeeMaxMult: 0.92,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.29, worldBaseMuFloor: 1.32 },
        },
      },
      {
        name: "C8: v15 + Safe 2-Car 0.88x Chaining ONLY (No Bayesian)",
        strategy: { ...baseStrategy, flags: { ...baseStrategy.flags, chainGigs: true } },
        deskMode: "chaining_only",
        opts: {
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 600,
            openFeeMinMult: 0.88,
            openFeeMaxMult: 0.92,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
        },
      },
      {
        name: "C9: Tuned Hybrid (twr=0.34, minMargin=0.20, maxWait=0.40, baseFee=1.06/1.38 + Safe 2-Car 0.88x)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.44,
          minExpectedMarginRatio: 0.2,
          targetWinRate: 0.34,
          maxActiveWaitingPerDriver: 0.4,
          maxOrdersPerBatch: 5,
          baseFeeMultiplier: 1.06,
          maxNormalFeeMultiplier: 1.38,
          flags: { ...baseStrategy.flags, chainGigs: true },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 600,
            openFeeMinMult: 0.88,
            openFeeMaxMult: 0.92,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.3, worldBaseMuFloor: 1.33 },
        },
      },
      {
        name: "C10: C9 Pricer+ZeroHoldout ONLY (Chaining OFF, maxWait=0.38)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.44,
          minExpectedMarginRatio: 0.2,
          targetWinRate: 0.34,
          maxActiveWaitingPerDriver: 0.38,
          maxOrdersPerBatch: 5,
          baseFeeMultiplier: 1.06,
          maxNormalFeeMultiplier: 1.38,
          flags: { ...baseStrategy.flags, chainGigs: false },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: { enabled: false },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.3, worldBaseMuFloor: 1.33 },
        },
      },
      {
        name: "C11: C9 Safety Polish (maxWait=0.36, baseFee=1.08/1.40, maxBatch=4 + High-Slack 2-Car 0.90x)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.44,
          minExpectedMarginRatio: 0.2,
          targetWinRate: 0.34,
          maxActiveWaitingPerDriver: 0.36,
          maxOrdersPerBatch: 4,
          baseFeeMultiplier: 1.08,
          maxNormalFeeMultiplier: 1.4,
          flags: { ...baseStrategy.flags, chainGigs: true },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 720,
            openFeeMinMult: 0.9,
            openFeeMaxMult: 0.94,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.3, worldBaseMuFloor: 1.33 },
        },
      },
      {
        name: "C12: C9 + twr=0.32 Safety (baseFee=1.05/1.36, maxWait=0.38 + Safe 2-Car 0.88x)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.44,
          minExpectedMarginRatio: 0.2,
          targetWinRate: 0.32,
          maxActiveWaitingPerDriver: 0.38,
          maxOrdersPerBatch: 5,
          baseFeeMultiplier: 1.05,
          maxNormalFeeMultiplier: 1.36,
          flags: { ...baseStrategy.flags, chainGigs: true },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 660,
            openFeeMinMult: 0.88,
            openFeeMaxMult: 0.92,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.3, worldBaseMuFloor: 1.33 },
        },
      },
      {
        name: "C13: C6+C9 Sweet Spot (twr=0.31, minM=0.19, baseFee=1.05/1.36, maxWait=0.38, Safe 2-Car 0.89x)",
        strategy: {
          ...baseStrategy,
          baseQuoteMultiplier: 1.43,
          minExpectedMarginRatio: 0.19,
          targetWinRate: 0.31,
          maxActiveWaitingPerDriver: 0.38,
          maxOrdersPerBatch: 5,
          baseFeeMultiplier: 1.05,
          maxNormalFeeMultiplier: 1.36,
          flags: { ...baseStrategy.flags, chainGigs: true },
        },
        deskMode: "integrated",
        opts: {
          useBayesianPricer: true,
          useZeroHoldoutScheduler: true,
          chaining: {
            enabled: true,
            maxOrdersPerChain: 2,
            maxGapMinutes: 25,
            minOrderSlackMinutes: 720,
            openFeeMinMult: 0.89,
            openFeeMaxMult: 0.93,
            quoteSynergyEnabled: false,
            allowChainedCapacityBypass: false,
          },
          pricer: { strictCapacityGate: true, minQuoteMultiplier: 1.29, worldBaseMuFloor: 1.32 },
        },
      },
    ]

    const onlyIdx = values.only
      ? new Set(values.only.split(",").map((x) => Number(x.trim())).filter(Number.isFinite))
      : null
    const selected = onlyIdx ? specs.filter((_, i) => onlyIdx.has(i + 1)) : specs
    const outFile = values.out || "scratch/top10-benchmark-results.json"

    const results = []
    for (const s of selected) {
      console.log(`\n=== Benchmarking: ${s.name} ===`)
      const res = await benchmarkTop10Candidate(s, undefined, concurrency)
      console.log(formatResultMarkdown(res))
      console.log("Extra Telemetry:", JSON.stringify(res.extraTelemetry, null, 2))
      results.push(res)
      fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
    }
  }
}
