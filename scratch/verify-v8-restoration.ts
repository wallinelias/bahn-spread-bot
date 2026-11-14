import { benchmarkStrategy, ExperimentalDesk, formatResultMarkdown } from "../experiment-runners.ts"
import { QuantitativeDesk } from "../bot.ts"
import type { StrategyConfig } from "../strategy-config.ts"

const STRATEGY_V8_TRUE: StrategyConfig = {
  version: 15,
  updatedAt: new Date().toISOString(),
  updatedBy: "manual",
  notes: "True Strategy v8: high quote (1.46) + lean flat driver fees (1.00 / 1.34 / 1.75 / 2.20 / 0.14)",
  baseQuoteMultiplier: 1.46,
  sameDayQuotePremium: 0.22,
  minExpectedMarginRatio: 0.18,
  targetWinRate: 0.30,
  maxActiveWaitingPerDriver: 0.45,
  maxOrdersPerBatch: 5,
  baseFeeMultiplier: 1.00,
  maxNormalFeeMultiplier: 1.34,
  urgentFeeMultiplier: 1.75,
  maxUrgentFeeMultiplier: 2.20,
  scarcityTownFeeBoost: 0.14,
  directOfferDiscount: 0.96,
  targetOnTimeBuffer: 0.935,
  flags: {
    selectiveDecline: true,
    optionSteering: true,
    flatFees: true,
    repositionOffers: true,
    noteNLP: true,
    dealerLearning: true,
    chainGigs: false,
    slackFees: true,
  },
}

ExperimentalDesk.prototype.win = async function (order) {
  await QuantitativeDesk.prototype.win.call(this, order)
}
QuantitativeDesk.prototype.dispatchContinuationDirectOffers = function () {}
QuantitativeDesk.prototype.delivered = function (orderId: string, leg: number, at: number, placeId: string, gigId: string) {
  this.legGigs.get(orderId)?.delete(leg)
  const order = this.orders.get(orderId)
  if (order) order.deliveredAt[leg] = at
  const driverId = this.gigBookedByDriver.get(gigId)
  if (driverId) {
    for (const set of this.repositionedDriversAtPlace.values()) {
      set.delete(driverId)
    }
    this.driverLastDelivery.set(driverId, { placeId, at })
  }
}

console.log("=== Running 5-Seed Verification of True Strategy v8 (q=1.46, f=1.00) ===")
const res = await benchmarkStrategy(
  "True Strategy v8 (q=1.46, f=1.00)",
  STRATEGY_V8_TRUE,
  { pureInelastic: true },
  ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"],
  5,
)
console.log(formatResultMarkdown(res))
