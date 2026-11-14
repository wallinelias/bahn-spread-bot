import assert from "node:assert/strict"
import { evaluateIntraWeekSlaRegime, TownClearingTracker, computeShadowAndOutageQuoteFactor } from "../top10-upgrades.ts"
import { ZeroHoldoutFeeScheduler } from "../top10-engine.ts"

const makeOrders = (total: number, atRiskCount: number, baseNow = 1000) =>
  Array.from({ length: total }, (_, i) => ({
    id: `O${i}`,
    status: "open",
    option: "next_day",
    deadline: i < atRiskCount ? baseNow + 200 : baseNow + 4000,
    lastPickupAt: i < atRiskCount ? baseNow + 100 : baseNow + 3000,
    deliveredAt: [null],
    legs: [{ pickup: { placeId: "hsl" }, delivery: { placeId: "tre" } }],
  }))

const fortress = evaluateIntraWeekSlaRegime({
  now: 1000,
  onTimeDeliveries: 50,
  lateDeliveries: 6,
  orders: makeOrders(40, 10),
  hasBookedOrWorkingGig: () => false,
  localDriversFn: () => 4,
  totalDrivers: 80,
  baseMaxWaitingPerDriver: 0.43,
  urgentOrderIds: new Set(["O0", "O1"]),
})
assert.equal(fortress.regime, "FORTRESS", `Expected FORTRESS, got ${fortress.regime} (${fortress.projectedEowOT})`)
assert.equal(fortress.effectiveMaxWaitingPerDriver, 0.28)
assert.equal(fortress.quoteMultiplierFactor, 1.07)

const harvest = evaluateIntraWeekSlaRegime({
  now: 3 * 1440 + 500,
  onTimeDeliveries: 120,
  lateDeliveries: 2,
  orders: makeOrders(10, 0, 3 * 1440 + 500),
  hasBookedOrWorkingGig: () => false,
  localDriversFn: () => 6,
  totalDrivers: 100,
  baseMaxWaitingPerDriver: 0.43,
  urgentOrderIds: new Set(),
})
assert.equal(harvest.regime, "HARVEST", `Expected HARVEST, got ${harvest.regime} (${harvest.projectedEowOT})`)
assert.equal(harvest.effectiveMaxWaitingPerDriver, 0.43)
assert.ok(harvest.targetWinRateDelta > 0)

const tracker = new TownClearingTracker()
tracker.recordBooking("hsl", 11200, 10000)
tracker.recordBooking("hsl", 11600, 10000)
assert.ok(tracker.getTownClearingRatio("hsl") > 1.07 && tracker.getTownClearingRatio("hsl") < 1.16)

assert.ok(
  computeShadowAndOutageQuoteFactor({
    dealerAdjustmentOffset: -0.02,
    townOutageStreak: 4,
    localDrivers: 4,
    unbookedInTown: 1,
    regime: "HARVEST",
  }) >= 1.025,
)

const sched = new ZeroHoldoutFeeScheduler({ level: 8, directOfferMultiplier: 1.015 })
const places = new Map([
  ["hsl", { id: "hsl", name: "Helsinki", lat: 60.17, lon: 24.94, hours: null }],
  ["tre", { id: "tre", name: "Tampere", lat: 61.5, lon: 23.76, hours: null }],
  ["olu", { id: "olu", name: "Oulu", lat: 65.01, lon: 25.47, hours: null }],
] as any)
const candidates = sched.selectDirectOfferCandidates({
  now: 800,
  gigId: "g1",
  order: {
    id: "O1",
    dealerId: "D01",
    option: "next_day",
    deadline: 3000,
    lastPickupAt: 2500,
    status: "open",
    priceCents: 12000,
    deliveredAt: [null],
    legs: [{ pickup: { placeId: "hsl", window: { from: 800, to: 2500 }, privateAddress: false }, delivery: { placeId: "tre", window: { from: 800, to: 3000 }, privateAddress: false }, car: { electric: false, chargePercent: null } }],
  } as any,
  audience: { experienced: false, manualLicence: false } as any,
  currentSchedule: [{ at: 790, feeCents: 8800 }],
  referenceFeeCents: 10000,
  carsInGig: 1,
  isUrgent: false,
  roster: [
    { id: "dormant", homePlaceId: "hsl", rating: 4.9, licence: "manual", completedGigs: 2, drops: 0 },
    { id: "stranded_homeward", homePlaceId: "tre", rating: 4.85, licence: "manual", completedGigs: 50, drops: 0 },
  ] as any,
  placesById: places,
  driverLastDelivery: new Map([["stranded_homeward", { at: 750, placeId: "hsl" }]]),
  gigViewers: new Set(["dormant"]),
  driversNearPickup: [{ id: "dormant", homePlaceId: "hsl", rating: 4.9, licence: "manual", completedGigs: 2, drops: 0 }] as any,
  repositionedEnRoute: new Set(),
  offeredPairs: new Set(),
  driverOffersToday: new Map(),
  openOffersOnGig: 0,
  townClearingMultiplier: 1.10,
  gigPostedAt: 795,
  localDriverCount: 6,
})
assert.equal(candidates.length, 1)
assert.equal(candidates[0]!.driverId, "stranded_homeward")
assert.ok(candidates[0]!.feeCents >= 10000)

console.log("PASS: verify-sla-and-offers all assertions succeeded")
