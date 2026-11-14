import assert from "node:assert/strict"
import { loadStrategy } from "../strategy-config.ts"
import { BayesianCompetitorPricer, Top10IntegratedDesk, getTop10DeskOptions } from "../top10-engine.ts"
import {
  buildSmoothFeeSchedule,
  evaluateTradeInLeg0,
  getActivePeakFeeAt,
  hardenOutboxPostActions,
  resolveOrderActivePeakFee,
  shouldAllowSmartDirectOffer,
} from "../top10-upgrades.ts"
import type { Order, Place, PriceRequest, Road, StopRef } from "../spread.ts"

const places: Place[] = [
  { id: "helsinki", name: "Helsinki", lat: 60.17, lon: 24.94 },
  { id: "tampere", name: "Tampere", lat: 61.5, lon: 23.79 },
  { id: "oulu", name: "Oulu", lat: 65.01, lon: 25.47 },
  { id: "rovaniemi", name: "Rovaniemi", lat: 66.5, lon: 25.73 },
  { id: "hyvinkaa", name: "Hyvinkaa", lat: 60.63, lon: 24.86 },
]

const roads: Road[] = [
  { from: "helsinki", to: "tampere", km: 178, minutes: 120 },
  { from: "tampere", to: "helsinki", km: 178, minutes: 120 },
  { from: "helsinki", to: "hyvinkaa", km: 55, minutes: 45 },
  { from: "hyvinkaa", to: "helsinki", km: 55, minutes: 45 },
  { from: "helsinki", to: "oulu", km: 607, minutes: 430 },
  { from: "oulu", to: "helsinki", km: 607, minutes: 430 },
  { from: "oulu", to: "hyvinkaa", km: 560, minutes: 390 },
  { from: "hyvinkaa", to: "oulu", km: 560, minutes: 390 },
  { from: "helsinki", to: "rovaniemi", km: 824, minutes: 580 },
  { from: "rovaniemi", to: "helsinki", km: 824, minutes: 580 },
]

const roster = [
  { id: "d1", name: "D1", rating: 4.9, homePlaceId: "helsinki", completedGigs: 20, drops: 0 },
  { id: "d2", name: "D2", rating: 4.8, homePlaceId: "helsinki", completedGigs: 20, drops: 0 },
  { id: "d3", name: "D3", rating: 4.7, homePlaceId: "tampere", completedGigs: 20, drops: 0 },
  { id: "d4", name: "D4", rating: 4.8, homePlaceId: "oulu", completedGigs: 20, drops: 0 },
]

const DAY = 1440
const HOUR = 60

function makeBaseReq(overrides: Partial<PriceRequest> = {}): PriceRequest {
  return {
    id: "R1",
    dealerId: "D01",
    arrivedAt: 10 * HOUR,
    batchId: null,
    note: null,
    referenceFeeCents: 10000,
    legs: [
      {
        car: { kind: "sedan", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "helsinki", window: { from: 10 * HOUR, to: 18 * HOUR }, hours: { weekdays: [0, 1, 2, 3, 4], opens: 8 * HOUR, closes: 18 * HOUR } },
        delivery: { placeId: "tampere", window: { from: 10 * HOUR, to: DAY + 18 * HOUR }, hours: { weekdays: [0, 1, 2, 3, 4], opens: 8 * HOUR, closes: 18 * HOUR } },
      },
    ],
    options: [
      { kind: "next_day", listPriceCents: 16500, deadline: DAY + 18 * HOUR },
      { kind: "within_3_days", listPriceCents: 15500, deadline: 3 * DAY + 18 * HOUR },
    ],
    ...overrides,
  } as PriceRequest
}

// 1. Trade-in Leg 0 morning infeasibility vs feasible afternoon slot
{
  const roadMinFn = (a: string, b: string) => roads.find((r) => r.from === a && r.to === b)?.minutes ?? 180
  // Impossible Monday 09:00 Oulu->Hyvinkaa starting Sunday 20:00 (dealer closed overnight)
  const badReq = makeBaseReq({
    id: "TR_BAD",
    arrivedAt: 6 * DAY + 16 * HOUR,
    legs: [
      {
        car: { kind: "suv", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "oulu", window: { from: 6 * DAY + 16 * HOUR, to: 7 * DAY + 18 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
        delivery: { placeId: "hyvinkaa", window: { from: 7 * DAY + 8 * HOUR, to: 7 * DAY + 9 * HOUR }, hours: null },
      },
      {
        car: { kind: "sedan", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "hyvinkaa", window: { from: 7 * DAY + 8 * HOUR, to: 7 * DAY + 18 * HOUR }, hours: null },
        delivery: { placeId: "oulu", window: { from: 7 * DAY + 9 * HOUR, to: 7 * DAY + 20 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
      },
    ],
  })
  const badRes = evaluateTradeInLeg0(badReq, 6 * DAY + 16 * HOUR, roadMinFn, 0)
  assert.equal(badRes.feasible, false, "Morning post-Sunday Oulu->Hyvinkaa 09:00 slot must be infeasible")

  // Feasible midday Helsinki->Tampere 16:00 slot from 10:00 AM
  const okReq = makeBaseReq({
    id: "TR_OK",
    arrivedAt: 10 * HOUR,
    legs: [
      {
        car: { kind: "sedan", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "helsinki", window: { from: 10 * HOUR, to: 18 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
        delivery: { placeId: "tampere", window: { from: 15 * HOUR, to: 16 * HOUR }, hours: null },
      },
      {
        car: { kind: "sedan", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "tampere", window: { from: 15 * HOUR, to: 18 * HOUR }, hours: null },
        delivery: { placeId: "helsinki", window: { from: 16 * HOUR, to: 20 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
      },
    ],
  })
  const okRes = evaluateTradeInLeg0(okReq, 10 * HOUR, roadMinFn, 0)
  assert.equal(okRes.feasible, true, "Feasible Helsinki->Tampere 16:00 trade-in slot should pass")
}

// 2. Pricer softCapacitySurge + adverseSelectionGuard + single dealer.reqs increment + pendingQuotes sync
{
  const strat = loadStrategy()
  const opts = getTop10DeskOptions(strat)
  const pricer = new BayesianCompetitorPricer({ places, roads }, {
    ...opts.pricer,
    level: 8,
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    maxActiveWaitingPerDriver: 0.41,
  })

  // Waiting ratio = 2 / 4 = 0.50 (above 0.41, within 0.57 soft surge zone)
  const normalReq = makeBaseReq({
    id: "R_CONG",
    options: [
      { kind: "same_day", listPriceCents: 21000, deadline: 19 * HOUR },
      { kind: "next_day", listPriceCents: 18500, deadline: DAY + 18 * HOUR },
    ],
  })
  const d1 = pricer.evaluateQuote(normalReq, {
    now: 10 * HOUR,
    waitingCount: 2,
    activeUnbookedUrgent: 0,
    totalDrivers: 4,
    liveOnTimeShare: 0.96,
    pickupDrivers: 2,
    deliveryDrivers: 1,
    repositionedAtPickup: 0,
    townWinsToday: 0,
    batchWinsSoFar: 0,
    snowAtPickup: false,
    snowAtDelivery: false,
    totalRoadMins: 120,
    totalRoadKm: 178,
    noteFlags: { withPlates: false, summerTyres: false, urgent: false, ev: false },
  })
  assert.equal(d1.action, "quote", "Soft congestion zone should still quote next_day")
  assert.equal(d1.regime, "congested_surge")
  assert.equal(d1.prices.same_day, undefined, "same_day should be filtered in tight soft congestion zone")
  assert.ok((d1.prices.next_day ?? 0) > 16500, "next_day should include congestion surge")

  // Toxic Rovaniemi negative-spread order (list=22600, ref=24500) must be declined or heavily floored out
  const toxicReq = makeBaseReq({
    id: "R_TOXIC",
    referenceFeeCents: 24500,
    legs: [
      {
        car: { kind: "sedan", electric: false, chargePercent: null, winterTyres: true },
        pickup: { placeId: "helsinki", window: { from: 10 * HOUR, to: 18 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
        delivery: { placeId: "rovaniemi", window: { from: 10 * HOUR, to: DAY + 20 * HOUR }, hours: { opens: 8 * HOUR, closes: 18 * HOUR } },
      },
    ],
    options: [{ kind: "next_day", listPriceCents: 22600, deadline: DAY + 20 * HOUR }],
  })
  const dToxic = pricer.evaluateQuote(toxicReq, {
    now: 10 * HOUR,
    waitingCount: 0,
    activeUnbookedUrgent: 0,
    totalDrivers: 4,
    liveOnTimeShare: 0.96,
    pickupDrivers: 2,
    deliveryDrivers: 0,
    repositionedAtPickup: 0,
    townWinsToday: 0,
    batchWinsSoFar: 0,
    snowAtPickup: false,
    snowAtDelivery: false,
    totalRoadMins: 580,
    totalRoadKm: 824,
    noteFlags: { withPlates: false, summerTyres: false, urgent: false, ev: false },
  })
  assert.equal(dToxic.action, "decline", "Toxic Rovaniemi ref>list must be declined by adverseSelectionGuard")
}

// 3. Outbox hardenPostStops + repostNoFeeDrop active peak (ignoring future unreached steps!)
{
  const reqMap = new Map<string, PriceRequest>()
  const ordMap = new Map<string, Order>()
  const req = makeBaseReq({
    id: "R_NOTE",
    arrivedAt: 10 * HOUR,
    note: { text: "ma. viideltä kiinni, koeekilvet mukaan", language: "fi" } as any,
    legs: [
      {
        car: { kind: "ev", electric: true, chargePercent: 20, winterTyres: true },
        pickup: { placeId: "helsinki", window: { from: 10 * HOUR, to: 18 * HOUR }, hours: { weekdays: [0, 1, 2, 3, 4], opens: 8 * HOUR, closes: 18 * HOUR } },
        delivery: { placeId: "tampere", window: { from: 10 * HOUR, to: DAY + 18 * HOUR }, hours: { weekdays: [0, 1, 2, 3, 4], opens: 8 * HOUR, closes: 18 * HOUR } },
      },
    ],
  })
  reqMap.set(req.id, req)
  const ord: Order = {
    id: req.id,
    dealerId: req.dealerId,
    option: "next_day",
    priceCents: 20000,
    referenceFeeCents: 10000,
    deadline: DAY + 18 * HOUR,
    lastPickupAt: DAY + 14 * HOUR,
    legs: req.legs,
    status: "open",
    deliveredAt: [null],
  } as any
  ordMap.set(ord.id, ord)

  const peakFeeByKey = new Map<string, number>()
  const prevSchedByKey = new Map<string, any[]>()

  const post1 = {
    type: "post",
    audience: "all",
    stops: [
      { kind: "pickup", orderId: ord.id, leg: 0, window: { from: 10 * HOUR, to: DAY + 10 * HOUR }, withPlates: true, withCharging: true } as StopRef,
      { kind: "delivery", orderId: ord.id, leg: 0, window: { from: 10 * HOUR, to: DAY + 18 * HOUR }, withPlates: false, withCharging: false } as StopRef,
    ],
    schedule: [
      { at: DAY + 6 * HOUR, feeCents: 11000 },
      { at: DAY + 9 * HOUR, feeCents: 14500 },
      { at: DAY + 16 * HOUR, feeCents: 21000 }, // Future urgent step not yet reached!
    ],
  }
  const roadKm = (a: string, b: string) => roads.find((r) => r.from === a && r.to === b)?.km ?? 178
  const roadMin = (a: string, b: string) => roads.find((r) => r.from === a && r.to === b)?.minutes ?? 120

  // On Monday Day 0 at 10:00 AM, "ma. viideltä kiinni" must clamp Day 0 pickup closing to 17:00 (1020)
  hardenOutboxPostActions({
    outbox: [post1],
    now: 10 * HOUR,
    orders: ordMap,
    requests: reqMap,
    roadKm,
    roadMinutes: roadMin,
    noteNLP: true,
    hardenStops: true,
    repostNoFeeDrop: false,
    peakFeeByKey,
    prevSchedByKey,
  })
  assert.equal(post1.stops[0]!.withCharging, false, "EV <= 200km must set withCharging=false")
  assert.ok(post1.stops[0]!.window.to <= 17 * HOUR, `Monday 'ma. viideltä kiinni' must close at <= 17:00 (got ${post1.stops[0]!.window.to})`)

  // Re-emit schedule on Tuesday DAY + 6*HOUR and verify active peak on repost at DAY + 9*HOUR + 30
  hardenOutboxPostActions({
    outbox: [post1],
    now: DAY + 6 * HOUR,
    orders: ordMap,
    requests: reqMap,
    roadKm,
    roadMinutes: roadMin,
    noteNLP: true,
    hardenStops: true,
    repostNoFeeDrop: true,
    peakFeeByKey,
    prevSchedByKey,
  })

  // Simulate non-urgent repost (>= 4.5h before deadline) -> should reset cleanly (floor=0)
  const nonUrgentTime = DAY + 9 * HOUR + 30
  const floorEarly = resolveOrderActivePeakFee({
    order: ord,
    cars: 1,
    now: nonUrgentTime,
    peakFeeByKey,
    prevSchedByKey,
  })
  assert.equal(floorEarly, 0, "Non-urgent (>= 4.5h left) repost should allow morning fee reset")

  // Simulate urgent gig_expired (< 4.5h before DAY + 18*HOUR deadline) -> must keep active peak 14500 (not future 21000!)
  const repostTime = DAY + 14 * HOUR + 30
  const floorAtRepost = resolveOrderActivePeakFee({
    order: ord,
    cars: 1,
    now: repostTime,
    peakFeeByKey,
    prevSchedByKey,
  })
  assert.equal(floorAtRepost, 14500, "Active peak at urgent repost (<4.5h) must equal 14500 (not future 21000 step)")

  const post2 = {
    type: "post",
    audience: "all",
    stops: [
      { kind: "pickup", orderId: ord.id, leg: 0, window: { from: repostTime, to: Infinity }, withPlates: true, withCharging: true } as StopRef,
      { kind: "delivery", orderId: ord.id, leg: 0, window: { from: repostTime, to: DAY + 18 * HOUR }, withPlates: false, withCharging: false } as StopRef,
    ],
    schedule: [{ at: repostTime, feeCents: 12000 }],
  }
  hardenOutboxPostActions({
    outbox: [post2],
    now: repostTime,
    orders: ordMap,
    requests: reqMap,
    roadKm,
    roadMinutes: roadMin,
    noteNLP: true,
    hardenStops: true,
    repostNoFeeDrop: true,
    peakFeeByKey,
    prevSchedByKey,
  })
  assert.equal(post2.schedule[0]!.feeCents, 14500, "Urgent repost fee must never drop below active peak 14500")
  assert.equal(post2.stops[0]!.withCharging, false, "Repost must also strip EV <= 200km charging")
  assert.ok(post2.stops[0]!.window.to > repostTime + 15, "Must never tighten expired stop window into a 10m repost loop")
}

// 4. Smart direct offer filter + monotonic smooth fee staircase (Order without referenceFeeCents)
{
  const ord: Order = {
    id: "R_DO",
    dealerId: "D01",
    option: "next_day",
    priceCents: 20000,
    deadline: DAY + 18 * HOUR,
    lastPickupAt: DAY + 14 * HOUR,
    legs: makeBaseReq().legs,
    status: "waiting",
    deliveredAt: [null],
  } as any

  const nonHomeAbundant = shouldAllowSmartDirectOffer({
    order: ord,
    referenceFeeCents: 10000,
    now: 10 * HOUR,
    roadMin: 120,
    pickupDrivers: 3,
    driver: { id: "d1", name: "D1", rating: 4.9, homePlaceId: "helsinki", completedGigs: 20, drops: 0 },
    offerFeeCents: 9500,
  })
  assert.equal(nonHomeAbundant.allow, false, "Abundant pickup non-homeward high-slack direct offer must be suppressed")

  const homeward = shouldAllowSmartDirectOffer({
    order: ord,
    referenceFeeCents: 10000,
    now: 10 * HOUR,
    roadMin: 120,
    pickupDrivers: 3,
    driver: { id: "d3", name: "D3", rating: 4.9, homePlaceId: "tampere", completedGigs: 20, drops: 0 },
    offerFeeCents: 9500,
  })
  assert.equal(homeward.allow, true, "Homeward driver direct offer must be allowed")
  assert.equal(homeward.minFeeCents, 10400, "Homeward direct offer floor = 1.04x ref")

  // Omitting referenceFeeCents must never yield NaN
  const homewardFallback = shouldAllowSmartDirectOffer({
    order: ord,
    now: 10 * HOUR,
    roadMin: 120,
    pickupDrivers: 3,
    driver: { id: "d3", name: "D3", rating: 4.9, homePlaceId: "tampere", completedGigs: 20, drops: 0 },
    offerFeeCents: 9500,
  })
  assert.ok(Number.isInteger(homewardFallback.minFeeCents), "Fallback ref must never yield NaN")

  const strat = loadStrategy()
  const opts = getTop10DeskOptions(strat)
  const sched = buildSmoothFeeSchedule({
    order: ord,
    referenceFeeCents: 10000,
    cars: 1,
    now: 10 * HOUR,
    pickupDrivers: 3,
    roadMin: 120,
    roadKm: 178,
    overheadMin: 0,
    config: {
      strictCapacityGate: true,
      baseFeeMultiplier: 1.02,
      maxNormalFeeMultiplier: 1.24,
      urgentFeeMultiplier: 1.85,
      maxUrgentFeeMultiplier: 2.15,
      ...opts.pricer,
    } as any,
    urgent: false,
  })
  assert.ok(sched.length >= 4, "Smooth fee staircase must emit multiple progressive steps")
  for (let i = 1; i < sched.length; i++) {
    assert.ok(Number.isInteger(sched[i]!.feeCents) && sched[i]!.at > sched[i - 1]!.at && sched[i]!.feeCents >= sched[i - 1]!.feeCents, "Schedule must be integer and strictly progressive")
  }
  const schedFallback = buildSmoothFeeSchedule({
    order: ord,
    cars: 1,
    now: 10 * HOUR,
    pickupDrivers: 3,
    roadMin: 120,
    roadKm: 178,
    overheadMin: 0,
    config: {
      strictCapacityGate: true,
      baseFeeMultiplier: 1.02,
      maxNormalFeeMultiplier: 1.24,
      urgentFeeMultiplier: 1.85,
      maxUrgentFeeMultiplier: 2.15,
      ...opts.pricer,
    } as any,
    urgent: false,
  })
  assert.ok(schedFallback.every((s) => Number.isInteger(s.feeCents)), "Schedule fallback must never produce NaN")
}

console.log("PASS: verify-upgrades-offline all 4 assertions succeeded")
