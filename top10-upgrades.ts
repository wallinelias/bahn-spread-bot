import type {
  DeliveryOptionKind,
  DriverProfile,
  FeeStep,
  Order,
  PostAction,
  PriceRequest,
  StopRef,
} from "./spread.ts"
import { clampPickupWindowForNow, extractDailyHoursFromNote, windowFromNoteV2 } from "./note-utils.ts"
import type { PricingContext, QuoteDecision, Top10PricerConfig } from "./top10-engine.ts"

const HOUR = 60
const DAY = 24 * HOUR

const REMOTE_NORTH_PLACES = new Set(["rovaniemi", "oulu", "kajaani", "ylivieska", "kokkola", "joensuu"])

export interface TradeInEligibility {
  feasible: boolean
  effectiveDeadline: number
  leg0SlotEnd: number
  costRiskMult: number
  minNetCents: number
}

export function earliestOpenMinute(
  startMinute: number,
  hours: PriceRequest["legs"][0]["pickup"]["hours"],
): number {
  if (!hours) return startMinute
  const startDay = Math.floor(startMinute / DAY)
  for (let dOff = 0; dOff <= 4; dOff++) {
    const dayIdx = startDay + dOff
    const dow = ((dayIdx % 7) + 7) % 7
    let openMin: number | null = null
    let closeMin: number | null = null
    if (dow === 6) {
      if (hours.sunday) {
        openMin = hours.sunday.opens
        closeMin = hours.sunday.closes
      }
    } else if (dow === 5) {
      if (hours.saturday) {
        openMin = hours.saturday.opens
        closeMin = hours.saturday.closes
      }
    } else {
      openMin = hours.opens
      closeMin = hours.closes
    }
    if (openMin === null || closeMin === null) continue
    const absOpen = dayIdx * DAY + openMin
    const absClose = dayIdx * DAY + closeMin
    const candidate = dOff === 0 ? Math.max(startMinute, absOpen) : absOpen
    if (candidate + 10 <= absClose) return candidate
  }
  return startMinute
}

export function evaluateTradeInLeg0(
  request: PriceRequest,
  now: number,
  roadMinFn: (a: string, b: string) => number,
  overheadMin: number,
): TradeInEligibility {
  const leg0 = request.legs[0]!
  const leg1 = request.legs[1]
  const leg0Min = roadMinFn(leg0.pickup.placeId, leg0.delivery.placeId)
  const leg1Min = leg1 ? roadMinFn(leg1.pickup.placeId, leg1.delivery.placeId) : 0
  const slotEnd = leg0.delivery.window.to
  const latestStart = slotEnd - Math.round(leg0Min * 1.1) - overheadMin - 15
  const earStart = Math.max(now, leg0.pickup.window.from)
  const firstLegalPickup = earliestOpenMinute(earStart, leg0.pickup.hours)

  let feasible = latestStart > firstLegalPickup + 30
  let costRiskMult = 1.14

  const dow = ((Math.floor(latestStart / DAY) % 7) + 7) % 7
  const tod = ((latestStart % DAY) + DAY) % DAY
  const slotDow = ((Math.floor(slotEnd / DAY) % 7) + 7) % 7
  const openHour = dow === 5 ? (leg0.pickup.hours?.saturday?.opens ?? 9 * HOUR) : (leg0.pickup.hours?.opens ?? 8 * HOUR)

  // If leg0 must leave before slot-day opens (next-morning early slot) or on Sunday, require >= 3h open dealer window prior
  if (feasible && leg0Min > 180 && (tod < openHour || dow === 6 || (slotDow === 0 && tod < 9 * HOUR))) {
    costRiskMult += 0.14
    const earDay = Math.floor(firstLegalPickup / DAY)
    const earDow = ((earDay % 7) + 7) % 7
    const earCloseRel =
      earDow === 6
        ? (leg0.pickup.hours?.sunday?.closes ?? 0)
        : earDow === 5
          ? (leg0.pickup.hours?.saturday?.closes ?? 15 * HOUR)
          : (leg0.pickup.hours?.closes ?? 18 * HOUR)
    const sameDayRoom = Math.min(latestStart, earDay * DAY + earCloseRel) - firstLegalPickup
    if (sameDayRoom < 150) feasible = false
  }

  if (leg0Min + leg1Min > 540) costRiskMult += 0.08
  return {
    feasible,
    effectiveDeadline: Math.min(request.options[0]?.deadline ?? slotEnd, slotEnd + leg1Min),
    leg0SlotEnd: slotEnd,
    costRiskMult,
    minNetCents: 2200,
  }
}

export function evaluateQuoteWithUpgrades(
  request: PriceRequest,
  ctx: PricingContext,
  config: Top10PricerConfig,
  roadMinFn: (a: string, b: string) => number,
  evaluateCore: (req: PriceRequest, c: PricingContext) => QuoteDecision,
): QuoteDecision {
  const waitRatio = ctx.waitingCount / Math.max(1, ctx.totalDrivers)
  const maxWait = config.maxActiveWaitingPerDriver
  const softCapEnabled = Boolean(config.softCapacitySurge)
  const advGuardEnabled = Boolean(config.adverseSelectionGuard)

  // Step 1: Soft congestion bypass into core pricer when waitingRatio is in [maxWait, maxWait + 0.16]
  let coreCtx = ctx
  let congestionSurcharge = 0
  let inSoftCongestionZone = false

  if (softCapEnabled && waitRatio > maxWait && waitRatio <= maxWait + 0.16) {
    inSoftCongestionZone = true
    const cappedWait = Math.max(0, Math.floor((maxWait - 0.005) * Math.max(1, ctx.totalDrivers)))
    coreCtx = { ...ctx, waitingCount: cappedWait }
    const excessT = Math.min(1, Math.max(0, (waitRatio - maxWait) / 0.16))
    congestionSurcharge = 0.08 + 0.16 * excessT
  }

  const baseDecision = evaluateCore(request, coreCtx)
  if (baseDecision.action === "decline") {
    return baseDecision
  }

  const prices: Partial<Record<DeliveryOptionKind, number>> = { ...baseDecision.prices }
  const leg0 = request.legs[0]!
  const km = ctx.totalRoadKm
  const arrDow = ((Math.floor(ctx.now / DAY) % 7) + 7) % 7
  const tod = ((ctx.now % DAY) + DAY) % DAY
  const isTradeIn = request.legs.length > 1

  let expectedCostMult = config.baseFeeMultiplier
  let extraFloorMult = 0

  if (advGuardEnabled) {
    if (km > 400) {
      expectedCostMult += Math.min(0.24, (km - 400) / 1400)
    }
    if (REMOTE_NORTH_PLACES.has(leg0.pickup.placeId) || REMOTE_NORTH_PLACES.has(leg0.delivery.placeId)) {
      expectedCostMult += leg0.pickup.placeId === "rovaniemi" || leg0.delivery.placeId === "rovaniemi" ? 0.14 : 0.07
    }
    if (ctx.pickupDrivers <= 1) {
      expectedCostMult += 0.09
    } else if (ctx.pickupDrivers === 2) {
      expectedCostMult += 0.03
    }
    if (arrDow >= 4 && tod >= 12 * HOUR) {
      expectedCostMult += 0.08
    }
    if (ctx.liveOnTimeShare < 0.945) {
      extraFloorMult += (0.945 - ctx.liveOnTimeShare) * 1.4
    }
  }

  let tradeInfo: TradeInEligibility | null = null
  if (advGuardEnabled && isTradeIn) {
    const overhead = (ctx.noteFlags.withPlates ? 30 : 0) + (leg0.car.electric && (leg0.car.chargePercent ?? 100) < 30 && km > 200 ? 40 : 0)
    tradeInfo = evaluateTradeInLeg0(request, ctx.now, roadMinFn, overhead)
    expectedCostMult = Math.max(expectedCostMult, config.baseFeeMultiplier * tradeInfo.costRiskMult)
  }

  const filteredPrices: Partial<Record<DeliveryOptionKind, number>> = {}
  const targetMargin = config.minExpectedMarginRatio + (inSoftCongestionZone ? 0.05 : 0)

  for (const opt of request.options) {
    let price = prices[opt.kind]
    if (price === undefined) continue

    // Keep same_day STRICT under soft capacity surge so urgent today deliveries never flood OT
    if (inSoftCongestionZone && opt.kind === "same_day" && waitRatio > maxWait * 0.92) {
      continue
    }

    if (inSoftCongestionZone && congestionSurcharge > 0) {
      price = Math.round(price * (1 + congestionSurcharge))
    }

    if (advGuardEnabled) {
      if (isTradeIn && tradeInfo) {
        if (!tradeInfo.feasible) continue
        // Ensure trade-ins don't quote same_day unless very lucrative
        if (opt.kind === "same_day" && km > 180) continue
      }

      // Compute realistic expected driver clearing cost (especially when refFee >= 0.85 * listPrice!)
      const refFee = Math.max(100, request.referenceFeeCents)
      const listPrice = Math.max(100, opt.listPriceCents)
      const refToList = refFee / listPrice
      let optCostMult = expectedCostMult
      if (opt.kind === "same_day") optCostMult += 0.09
      if (!config.cleanAdverseGuard && refToList > 0.86) {
        optCostMult += Math.min(0.24, (refToList - 0.86) * 0.65)
      } else if (config.cleanAdverseGuard && refToList > 1.04) {
        optCostMult += Math.min(0.08, (refToList - 1.04) * 0.25)
      }

      const estRealFee = Math.round(refFee * optCostMult)
      const minNetRequired = isTradeIn && tradeInfo ? tradeInfo.minNetCents : km > 420 ? 1800 : 1200
      const minFloorByCost = Math.round(estRealFee / Math.max(0.55, 1 - targetMargin))
      const minFloorByAbs = estRealFee + minNetRequired
      const safetyFloor = Math.round(Math.max(minFloorByCost, minFloorByAbs) * (1 + extraFloorMult))

      if (price < safetyFloor) {
        price = safetyFloor
      }
      // Avoid absurd un-winnable >2.15x only if competitor ceiling can't clear cost; let natural ceiling cap or allow win at high WTP
      const maxSensibleMult = opt.kind === "same_day" ? 2.15 : 2.05
      if (price / listPrice > maxSensibleMult && estRealFee * 1.15 > listPrice * maxSensibleMult) {
        // Structurally unprofitable toxic haul (e.g. list=€226, ref=€245 Rovaniemi)
        continue
      }
    }

    filteredPrices[opt.kind] = Math.max(100, Math.round(price))
  }

  if (Object.keys(filteredPrices).length === 0) {
    return {
      ...baseDecision,
      action: "decline",
      prices: {},
      reason: advGuardEnabled && isTradeIn ? "trade_in_unprofitable_or_tight" : "upgrade_gate_decline",
    }
  }

  return {
    ...baseDecision,
    action: "quote",
    prices: filteredPrices,
    regime: inSoftCongestionZone ? "congested_surge" : baseDecision.regime,
  }
}

export function buildSmoothFeeSchedule(params: {
  order: Order
  referenceFeeCents?: number
  cars: number
  now: number
  pickupDrivers: number
  roadMin: number
  roadKm: number
  overheadMin: number
  config: Top10PricerConfig
  prevPeakFeeCents?: number
  urgent: boolean
}): FeeStep[] {
  const { order, referenceFeeCents, cars, now, pickupDrivers, roadMin, roadKm, overheadMin, config, prevPeakFeeCents, urgent } = params
  const fallbackRef = Math.round((order.priceCents || 12000) * 0.72)
  const rawRef = referenceFeeCents !== undefined && Number.isFinite(referenceFeeCents) ? referenceFeeCents : fallbackRef
  const ref = Math.max(100, Math.round(rawRef))
  const dow = ((Math.floor(now / DAY) % 7) + 7) % 7
  const tod = ((now % DAY) + DAY) % DAY

  // Trade-in leg 0 uses slot deadline rather than waiting until evening order.deadline!
  let effectiveDeadline = order.deadline
  if (order.legs.length > 1 && order.deliveredAt[0] === null) {
    const leg0 = order.legs[0]!
    const slotEnd = leg0.delivery.window.to
    if (slotEnd && slotEnd < effectiveDeadline) {
      effectiveDeadline = slotEnd + Math.max(0, Math.round(roadMin * 0.45))
    }
  }

  const timeToDeadline = effectiveDeadline - now
  const slack = timeToDeadline - roadMin - overheadMin
  const shortage = pickupDrivers <= 1
  const longHaul = roadKm > 420
  const sameDay = order.option === "same_day" || timeToDeadline <= 14 * HOUR
  const lateDay = tod >= 15 * HOUR + 30
  const weekendTight = dow >= 4 && slack < 20 * HOUR

  const steps: FeeStep[] = []
  const pushStep = (at: number, mult: number) => {
    const baseCents = Math.round(ref * cars * mult)
    const floored =
      prevPeakFeeCents && prevPeakFeeCents > 0 && timeToDeadline < 20 * HOUR
        ? Math.max(baseCents, prevPeakFeeCents)
        : baseCents
    const clampedAt = Math.max(now, Math.round(at))
    const prev = steps[steps.length - 1]
    if (prev && clampedAt <= prev.at) {
      prev.feeCents = Math.max(prev.feeCents, floored)
    } else if (!prev || floored > prev.feeCents) {
      steps.push({ at: clampedAt, feeCents: floored })
    }
  }

  const useFastClear = urgent || sameDay || shortage || longHaul || slack < 9 * HOUR || weekendTight || lateDay

  if (!useFastClear) {
    // High-slack daytime: keep cheap 0.89x initial sweep, then staircase smoothly at +18m / +48m / +95m / +155m BEFORE nightfall!
    const openMult = Math.max(0.88, Math.min(0.95, config.baseFeeMultiplier - 0.14))
    pushStep(now, openMult)
    pushStep(now + 18, Math.max(openMult + 0.05, 0.95))
    pushStep(now + 48, 1.02)
    pushStep(now + 95, 1.09)
    pushStep(now + 155, Math.min(config.maxNormalFeeMultiplier, 1.18))
  } else {
    // Tight/same-day/shortage/long-haul: don't burn precious minutes at 0.88x -> clear promptly!
    const startMult =
      shortage || urgent
        ? Math.min(1.22, config.baseFeeMultiplier + 0.08)
        : longHaul
          ? Math.max(1.01, config.baseFeeMultiplier - 0.02)
          : sameDay
            ? Math.max(0.98, config.baseFeeMultiplier - 0.05)
            : 0.94
    pushStep(now, startMult)
    pushStep(now + 15, Math.min(config.maxNormalFeeMultiplier, startMult + 0.09))
    pushStep(now + 35, Math.min(config.maxNormalFeeMultiplier, startMult + 0.19))
    pushStep(now + 65, Math.min(config.maxUrgentFeeMultiplier, Math.max(config.maxNormalFeeMultiplier, startMult + 0.30)))
  }

  // Urgent deadline protection ramp (fires early enough to hit daytime drivers!)
  const urgentHorizon = Math.min(timeToDeadline - 30, Math.max(240, roadMin + overheadMin + 150))
  const urgentStart = Math.max(now + (useFastClear ? 85 : 190), effectiveDeadline - Math.max(210, urgentHorizon))

  if (urgentStart < effectiveDeadline - 40) {
    const midUrgent = Math.round((urgentStart + effectiveDeadline - 45) / 2)
    const u1 = Math.max(config.maxNormalFeeMultiplier + 0.06, Math.min(1.62, config.urgentFeeMultiplier - 0.25))
    const u2 = Math.min(config.maxUrgentFeeMultiplier, config.urgentFeeMultiplier)
    const u3 = config.maxUrgentFeeMultiplier
    pushStep(urgentStart, u1)
    if (midUrgent > urgentStart + 20) pushStep(midUrgent, u2)
    if (effectiveDeadline - 75 > midUrgent + 20) pushStep(effectiveDeadline - 75, u3)
  }

  return steps.length > 0 ? steps : [{ at: now, feeCents: Math.round(ref * cars * config.baseFeeMultiplier) }]
}

export function getOrderLegsKey(legs: readonly number[]): string {
  return [...new Set(legs)].sort((a, b) => a - b).join(",")
}

export function getActivePeakFeeAt(schedule: readonly FeeStep[] | undefined, now: number): number {
  if (!schedule || schedule.length === 0) return 0
  let active = schedule[0]!.feeCents
  for (const s of schedule) {
    if (s.at <= now) active = Math.max(active, s.feeCents)
  }
  return active
}

export function resolveOrderActivePeakFee(params: {
  order: Order
  cars: number
  now: number
  peakFeeByKey: Map<string, number>
  prevSchedByKey?: Map<string, FeeStep[]>
}): number {
  const { order, cars, now, peakFeeByKey, prevSchedByKey } = params
  if (order.deadline - now >= 4.5 * HOUR) return 0
  const legs =
    cars >= order.legs.length
      ? order.legs.map((_, i) => i)
      : [Math.max(0, order.deliveredAt.findIndex((d) => d === null))]
  const key = `${order.id}:${getOrderLegsKey(legs)}`
  const recorded = peakFeeByKey.get(key) ?? 0
  const fromPrev = prevSchedByKey ? getActivePeakFeeAt(prevSchedByKey.get(key), now) : 0
  const best = Math.max(recorded, fromPrev)
  if (best > recorded) peakFeeByKey.set(key, best)
  return best
}

export function hardenOutboxPostActions(params: {
  outbox: any[]
  now: number
  orders: Map<string, Order>
  requests: Map<string, PriceRequest>
  roadKm: (a: string, b: string) => number
  roadMinutes: (a: string, b: string) => number
  noteNLP: boolean
  hardenStops: boolean
  repostNoFeeDrop: boolean
  peakFeeByKey: Map<string, number>
  prevSchedByKey?: Map<string, FeeStep[]>
}): void {
  const {
    outbox,
    now,
    orders,
    requests,
    roadKm,
    roadMinutes,
    noteNLP,
    hardenStops,
    repostNoFeeDrop,
    peakFeeByKey,
    prevSchedByKey,
  } = params

  for (const act of outbox) {
    if (!act || act.type !== "post" || !Array.isArray(act.stops)) continue
    const post = act as PostAction
    const isSingleOrder = new Set(post.stops.map((s) => s.orderId)).size === 1

    if (hardenStops) {
      for (let i = 0; i < post.stops.length; i++) {
        const stop = post.stops[i]!
        const order = orders.get(stop.orderId)
        const req = requests.get(stop.orderId)
        const legObj = order?.legs[stop.leg]
        if (!order || !legObj) continue

        const legKm = roadKm(legObj.pickup.placeId, legObj.delivery.placeId)
        const legMin = roadMinutes(legObj.pickup.placeId, legObj.delivery.placeId)

        // Fix EV <= 200km charging overhead everywhere
        if (stop.kind === "pickup") {
          const car = legObj.car
          stop.withCharging = Boolean(car.electric && car.chargePercent !== null && car.chargePercent < 30 && legKm > 200)
        }

        if (stop.kind === "pickup") {
          const baseWin = { ...legObj.pickup.window }
          const noted = noteNLP && req?.note ? windowFromNoteV2(req.note, baseWin, "pickup", req.arrivedAt) : baseWin
          const daily = noteNLP && req?.note ? extractDailyHoursFromNote(req.note) : {}
          let win = clampPickupWindowForNow(noted, legObj.pickup.hours, daily, now, 15)

          // Trade-in leg 0 pickup MUST finish early enough to make private seller slot [delivery.window.to]!
          if (order.legs.length > 1 && stop.leg === 0) {
            const ovh = (stop.withPlates ? 30 : 0) + (stop.withCharging ? 40 : 0)
            const latestPickupForSlot = legObj.delivery.window.to - Math.round(legMin * 1.1) - ovh - 15
            if (latestPickupForSlot > Math.max(win.from, now) + 15) {
              win = { ...win, to: Math.min(win.to, latestPickupForSlot) }
            }
          }

    // Never tighten a stop window into an already-expired <15m trap (which causes 10-min repost loops)
    const hardDeadline = legObj.pickup.window.to
    const isWindowTightened = win.to < hardDeadline - 1
    if (Math.round(win.to) > Math.max(now, Math.round(win.from)) + 15) {
      if (win.from > now + 15 || isWindowTightened) {
        stop.window = {
          from: Math.max(now, Math.round(win.from)),
          to: Math.round(win.to),
        }
      }
    } else if (win.from > now + 15 && Math.round(hardDeadline) > Math.round(win.from) + 15) {
      stop.window = { from: Math.round(win.from), to: Math.round(hardDeadline) }
    }
        } else if (stop.kind === "delivery" && noteNLP && req?.note) {
          const baseDel: { from: number; to: number } = { from: legObj.delivery.window.from, to: order.deadline }
          const notedDel = windowFromNoteV2(req.note, baseDel, "delivery", req.arrivedAt)
          if (notedDel.to < order.deadline && notedDel.to > now + legMin + 25) {
            stop.window = {
              from: Math.round(Math.max(legObj.delivery.window.from, now)),
              to: Math.round(notedDel.to),
            }
          }
        }
      }
    }

    if (repostNoFeeDrop && isSingleOrder && post.stops.length > 0 && post.schedule.length > 0) {
      const stop0 = post.stops[0]!
      const key = `${stop0.orderId}:${getOrderLegsKey(post.stops.map((s) => s.leg))}`
      const order = orders.get(stop0.orderId)
      const prevSchedFee = prevSchedByKey ? getActivePeakFeeAt(prevSchedByKey.get(key), now) : 0
      const prevPeak = Math.max(peakFeeByKey.get(key) ?? 0, prevSchedFee)
      if (prevPeak > (peakFeeByKey.get(key) ?? 0)) {
        peakFeeByKey.set(key, prevPeak)
      }
      const timeLeft = order ? order.deadline - now : 0
      if (prevPeak > 0 && timeLeft < 4.5 * HOUR) {
        for (const step of post.schedule) {
          if (step.feeCents < prevPeak) step.feeCents = prevPeak
        }
      }
      if (prevSchedByKey) {
        prevSchedByKey.set(
          key,
          post.schedule.map((s) => ({ at: s.at, feeCents: s.feeCents })),
        )
      } else {
        const activeNow = getActivePeakFeeAt(post.schedule, now)
        if (activeNow > prevPeak) peakFeeByKey.set(key, activeNow)
      }
    }
  }
}

export function shouldAllowSmartDirectOffer(params: {
  order: Order
  referenceFeeCents?: number
  now: number
  roadMin: number
  pickupDrivers: number
  driver: DriverProfile
  offerFeeCents: number
}): { allow: boolean; minFeeCents: number } {
  const { order, referenceFeeCents, now, roadMin, pickupDrivers, driver, offerFeeCents } = params
  const leg0 = order.legs[0]!
  const deliveryPlace = leg0.delivery.placeId
  const slack = order.deadline - now - roadMin
  const isHomeward = driver.homePlaceId === deliveryPlace
  const isUrgentOrBarren = slack <= 6 * HOUR || pickupDrivers <= 1

  if (!isUrgentOrBarren && !isHomeward) {
    return { allow: false, minFeeCents: offerFeeCents }
  }
  const fallbackRef = Math.round((order.priceCents || 12000) * 0.72)
  const rawRef = referenceFeeCents !== undefined && Number.isFinite(referenceFeeCents) ? referenceFeeCents : fallbackRef
  const ref = Math.max(100, Math.round(rawRef))
  const floorMult = isUrgentOrBarren && slack < 4 * HOUR ? 1.15 : isHomeward ? 1.04 : 1.09
  const minFeeCents = Math.max(offerFeeCents, Math.round(ref * floorMult))
  return { allow: true, minFeeCents }
}
