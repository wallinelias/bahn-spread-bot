import { Client } from "../spread.ts"
import { runSimulationRound } from "../bot.ts"
import { loadStrategy } from "../strategy-config.ts"

const client = new Client()
for (const w of await client.worlds()) {
  if (!w.ended && !w.board) await client.world(w.id).delete().catch(() => {})
}

const base = loadStrategy()
const variants: Record<string, any> = {
  PURE_A5: {
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: false,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.20,
    slaRegimeControl: false,
    dealerShadowPricing: false,
    fortressRescueEnabled: false,
    smartDirectOffersV2: false,
  },
  A5_SLA_ONLY: {
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: false,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.20,
    slaRegimeControl: true,
    dealerShadowPricing: false,
    fortressRescueEnabled: false,
    smartDirectOffersV2: false,
  },
  A5_SHADOW_ONLY: {
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: false,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.20,
    slaRegimeControl: false,
    dealerShadowPricing: true,
    fortressRescueEnabled: false,
    smartDirectOffersV2: false,
  },
  A5_D1_CLEAN: {
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: true,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.20,
    slaRegimeControl: false,
    dealerShadowPricing: false,
    fortressRescueEnabled: false,
    smartDirectOffersV2: false,
  },
}

const jobs: { tag: string; seed: string }[] = []
for (const tag of Object.keys(variants)) {
  for (const seed of ["spread-3", "spread-5"]) {
    jobs.push({ tag, seed })
  }
}

const realLog = console.log
console.log = () => {}

const out: any[] = []
async function runJob(job: { tag: string; seed: string }) {
  const strat: any = {
    ...base,
    flags: { ...base.flags, chainGigs: false },
    baseQuoteMultiplier: 1.44,
    sameDayQuotePremium: 0.25,
    minExpectedMarginRatio: 0.20,
    targetWinRate: 0.33,
    maxActiveWaitingPerDriver: 0.43,
    baseFeeMultiplier: 1.01,
    maxNormalFeeMultiplier: 1.33,
    urgentFeeMultiplier: 1.75,
    maxUrgentFeeMultiplier: 2.20,
    scarcityTownFeeBoost: 0.14,
    directOfferDiscount: 1.0,
    targetOnTimeBuffer: 0.935,
    pricerOptions: variants[job.tag],
  }
  const res = await runSimulationRound({
    level: 8,
    seed: job.seed,
    tuneWithGemini: false,
    persist: false,
    strategyOverride: strat,
  })
  await client.world(res.worldId).delete().catch(() => {})
  const lb = res.telemetry.ledgerBreakdownCents ?? {}
  out.push({
    tag: job.tag,
    seed: job.seed,
    margin: Number((res.score.marginCents / 100).toFixed(2)),
    ot: Number((res.score.onTimeShare * 100).toFixed(2)),
    won: res.score.wonOrders,
    decl: res.telemetry.declinedHighQuote,
    offers: `${res.telemetry.acceptedDirectOffers}/${res.telemetry.totalDirectOffers}`,
    feePct: Number(((Math.abs(lb.driver_fee || 0) / Math.max(1, lb.revenue || 1)) * 100).toFixed(1)),
    late: res.telemetry.lateDeliveries,
  })
}

let i = 0
async function worker() {
  while (i < jobs.length) {
    await runJob(jobs[i++]!)
  }
}
await Promise.all([worker(), worker(), worker(), worker()])
console.log = realLog
out.sort((a, b) => (a.seed + a.tag).localeCompare(b.seed + b.tag))
for (const r of out) {
  console.log(`${r.seed.padEnd(8)} | ${r.tag.padEnd(15)} | €${r.margin.toFixed(2).padStart(7)} | OT ${r.ot.toFixed(2)}% | won=${r.won} decl=${r.decl} | off=${r.offers} | fee=${r.feePct}% late=${r.late}`)
}
