import fs from "node:fs"
import { parseArgs } from "node:util"
import { Client } from "../spread.ts"
import { runSimulationRound } from "../bot.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"

const { values: args } = parseArgs({
  options: {
    tag: { type: "string", default: "E1" },
    seeds: { type: "string", default: "spread-1,spread-2,spread-3,spread-4,spread-5" },
    concurrency: { type: "string", default: "5" },
    chain: { type: "string", default: "false" },
  },
})

const seedList = args.seeds!.split(",").map((s) => s.trim()).filter(Boolean)
const concurrency = Math.max(1, Math.min(5, Number(args.concurrency || 5)))
const chainEnabled = args.chain === "true"

// Clean up any leftover practice worlds before starting so we never hit the 12-world limit
const client = new Client()
try {
  const existing = await client.worlds()
  for (const w of existing as any[]) {
    const id = w.worldId ?? w.id
    if (id && !w.ended && !w.boardRun && w.kind !== "final") {
      await client.world(id).delete().catch(() => {})
    }
  }
} catch {}

const base = loadStrategy()
const candidate: StrategyConfig = {
  ...base,
  flags: {
    ...base.flags,
    chainGigs: chainEnabled,
    repositionOffers: true,
    noteNLP: true,
    dealerLearning: true,
    selectiveDecline: true,
    optionSteering: true,
    flatFees: true,
    slackFees: true,
  },
  baseQuoteMultiplier: 1.42,
  sameDayQuotePremium: 0.25,
  minExpectedMarginRatio: 0.19,
  targetWinRate: 0.32,
  maxActiveWaitingPerDriver: 0.41,
  maxOrdersPerBatch: 5,
  baseFeeMultiplier: 1.05,
  maxNormalFeeMultiplier: 1.36,
  urgentFeeMultiplier: 1.75,
  maxUrgentFeeMultiplier: 2.20,
  scarcityTownFeeBoost: 0.14,
  directOfferDiscount: 1.015,
  targetOnTimeBuffer: 0.935,
  pricerOptions: {
    ...(base.pricerOptions ?? {}),
    strictCapacityGate: true,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.2,
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: true,
    smartDirectOffers: false,
    slaRegimeControl: true,
    dealerShadowPricing: false,
    fortressRescueEnabled: false,
    smartDirectOffersV2: true,
  },
}

const realLog = console.log
console.log = (...a: unknown[]) => {
  const s = a.join(" ")
  if (s.includes("Round Complete") || s.includes("ERROR")) realLog(s)
}

const results: any[] = []
let idx = 0

async function worker() {
  while (idx < seedList.length) {
    const seed = seedList[idx++]!
    let attempt = 0
    while (attempt < 3) {
      attempt++
      let worldId: string | undefined
      try {
        const res = await runSimulationRound({
          level: 8,
          seed,
          tuneWithGemini: false,
          persist: false,
          strategyOverride: candidate,
        })
        worldId = res.worldId
        const lb = res.telemetry.ledgerBreakdownCents ?? {}
        const rev = lb.revenue ?? 0
        const fee = Math.abs(lb.driver_fee ?? 0)
        const lateRef = Math.abs(lb.late_refund ?? 0)
        const acc = res.telemetry.acceptedDirectOffers ?? 0
        const totOff = res.telemetry.totalDirectOffers ?? 0
        results.push({
          seed,
          worldId: res.worldId,
          marginEur: Number((res.score.marginCents / 100).toFixed(2)),
          onTimeShare: Number(res.score.onTimeShare.toFixed(4)),
          ranked: res.score.ranked,
          won: res.score.wonOrders,
          declined: res.telemetry.declinedHighQuote,
          revEur: Number((rev / 100).toFixed(2)),
          feeEur: Number((fee / 100).toFixed(2)),
          feePctRev: rev > 0 ? Number(((fee / rev) * 100).toFixed(2)) : 0,
          lateRefEur: Number((lateRef / 100).toFixed(2)),
          offersAcc: acc,
          offersTot: totOff,
          offerConvPct: totOff > 0 ? Number(((acc / totOff) * 100).toFixed(2)) : 0,
          drops: res.telemetry.gigDrops,
          lateDeliveries: res.telemetry.lateDeliveries,
          visitFailures: res.telemetry.visitFailures,
        })
        break
      } catch (err) {
        realLog(`[${args.tag}] ${seed} attempt ${attempt} failed: ${(err as Error).message}`)
        await new Promise((r) => setTimeout(r, 2000))
      } finally {
        if (worldId) await client.world(worldId).delete().catch(() => {})
      }
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, seedList.length) }, worker))
console.log = realLog

results.sort((a, b) => seedList.indexOf(a.seed) - seedList.indexOf(b.seed))
const totalMargin = results.reduce((s, r) => s + r.marginEur, 0)
const minOT = Math.min(...results.map((r) => r.onTimeShare))
const avgOT = results.reduce((s, r) => s + r.onTimeShare, 0) / Math.max(1, results.length)
const totAcc = results.reduce((s, r) => s + r.offersAcc, 0)
const totOff = results.reduce((s, r) => s + r.offersTot, 0)
const totRev = results.reduce((s, r) => s + r.revEur, 0)
const totFee = results.reduce((s, r) => s + r.feeEur, 0)

console.log(`\n=== ${args.tag} (chain=${chainEnabled}) SUMMARY ===`)
for (const r of results) {
  console.log(
    `${r.seed.padEnd(9)} | €${r.marginEur.toFixed(2).padStart(8)} | OT ${(r.onTimeShare * 100).toFixed(2)}% | ${r.ranked ? "RANKED" : "UNRANKED"} | won=${r.won} decl=${r.declined} | offers=${r.offersAcc}/${r.offersTot} (${r.offerConvPct.toFixed(1)}%) | fee/rev=${r.feePctRev.toFixed(1)}% | drops=${r.drops} late=${r.lateDeliveries}`,
  )
}
console.log(
  `TOTAL: €${totalMargin.toFixed(2)} | minOT=${(minOT * 100).toFixed(2)}% avgOT=${(avgOT * 100).toFixed(2)}% | offers=${totAcc}/${totOff} (${totOff > 0 ? ((totAcc / totOff) * 100).toFixed(2) : "0.00"}%) | fee/rev=${totRev > 0 ? ((totFee / totRev) * 100).toFixed(2) : "0.00"}%`,
)
fs.writeFileSync(`scratch/bench-${args.tag}.json`, JSON.stringify({ tag: args.tag, candidate, results, totalMargin, minOT, avgOT }, null, 2))
