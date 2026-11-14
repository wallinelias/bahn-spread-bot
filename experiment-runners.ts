import fs from "node:fs"
import { parseArgs } from "node:util"
import {
  Client,
  SpreadError,
  Unreachable,
  World,
  type Action,
  type ActionResult,
  type DeskEvent,
  type DeskEventKind,
  type DriverProfile,
  type FeeStep,
  type Order,
  type PostAction,
  type PriceRequest,
  type Score,
  type WorldMap,
} from "./spread.ts"
import { loadStrategy, type StrategyConfig, type RoundSummary, type DailyMetric } from "./strategy-config.ts"
import { QuantitativeDesk, parseNoteFlags } from "./bot.ts"
import { WeatherNetworkModel } from "./weather-network-model.ts"

const HOUR = 60
const DAY = 24 * HOUR
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

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

export interface ExperimentToggles {
  dynamicCorridors?: boolean
  elasticDealer?: boolean
  emergencySurge?: boolean
  refinedChampion?: boolean
  weatherElasticSurge?: boolean
  elasticV2?: boolean
  pureInelastic?: boolean
  weatherNetworkModel?: boolean
}

export class ExperimentalDesk extends QuantitativeDesk {
  readonly toggles: ExperimentToggles
  readonly dealerRequests = new Map<string, number>()
  readonly dealerWins = new Map<string, number>()
  readonly droppedOrders = new Set<string>()
  readonly bookedFeeByGig = new Map<string, number>()
  readonly weatherModel = new WeatherNetworkModel()

  constructor(
    world: World,
    level: number,
    now: number,
    map: WorldMap,
    roster: DriverProfile[],
    strategy: StrategyConfig,
    toggles: ExperimentToggles = {},
  ) {
    super(world, level, now, map, roster, strategy)
    this.toggles = toggles
  }

  override async handle(event: DeskEvent): Promise<void> {
    this.weatherModel.handleEvent(event)
    if (event.kind === "gig_booked") {
      const postAction = this.posts.get(event.gigId)
      let fee = postAction?.schedule[0]?.feeCents ?? 100
      for (const step of postAction?.schedule ?? []) {
        if (step.at <= this.now) fee = step.feeCents
      }
      this.bookedFeeByGig.set(event.gigId, fee)
    } else if (event.kind === "gig_dropped") {
      const orderId = this.gigOrder.get(event.gigId)
      if (orderId) this.droppedOrders.add(orderId)
    }

    await super.handle(event)

    if ((this.toggles.elasticV2 || this.toggles.pureInelastic) && (event.kind === "gig_dropped" || event.kind === "no_show")) {
      const orderId = this.gigOrder.get(event.gigId)
      if (orderId) {
        const order = this.orders.get(orderId)
        const postAction = this.posts.get(event.gigId)
        const lastBooked = this.bookedFeeByGig.get(event.gigId) ?? 0
        if (order && postAction) {
          const sched = this.feesFor(order, postAction.stops.filter((s) => s.kind === "pickup").length)
          if (lastBooked > 0) {
            for (const s of sched) {
              s.feeCents = Math.max(s.feeCents, Math.round(lastBooked * 1.05))
            }
          }
          this.outbox.push({
            type: "reprice",
            gigId: event.gigId,
            schedule: sched,
          })
          this.dispatchDirectOffersForGig(event.gigId, order)
        }
      }
    }
  }

  override async win(order: Order): Promise<void> {
    await super.win(order)
  }

  override quote(request: PriceRequest): void {
    if (
      !this.toggles.dynamicCorridors &&
      !this.toggles.elasticDealer &&
      !this.toggles.refinedChampion &&
      !this.toggles.weatherElasticSurge &&
      !this.toggles.elasticV2 &&
      !this.toggles.pureInelastic &&
      !this.toggles.weatherNetworkModel
    ) {
      super.quote(request)
      return
    }

    this.requests.set(request.id, request)
    this.telemetry.totalRequests++
    this.dealerRequests.set(request.dealerId, (this.dealerRequests.get(request.dealerId) ?? 0) + 1)

    if (this.level <= 3) {
      const first = request.options[0]!
      this.outbox.push({ type: "quote", requestId: request.id, prices: { [first.kind]: first.listPriceCents } })
      this.telemetry.quotedToWin++
      return
    }

    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupPlace = leg0.pickup.placeId
    const deliveryPlace = lastLeg.delivery.placeId
    const pickupDrivers = this.localDriverCount(pickupPlace)
    const deliveryDrivers = this.localDriverCount(deliveryPlace)
    const repositionedAtPickup = this.repositionedDriverCount(pickupPlace)
    const effectivePickupSupply = pickupDrivers + repositionedAtPickup * 1.5
    const F = this.strategy.flags
    const noteFlags = parseNoteFlags(request.note, F.noteNLP)

    const declineRequest = () => {
      const opt = request.options[request.options.length - 1]!
      const declinePrice = Math.max(1000, Math.round(opt.listPriceCents * 4.2))
      this.outbox.push({ type: "quote", requestId: request.id, prices: { [opt.kind]: declinePrice } })
      this.telemetry.declinedHighQuote++
    }

    // Weather & Long-haul protective filtering
    const totalRoadMins = request.legs.reduce((sum, l) => sum + this.roadMinutes(l.pickup.placeId, l.delivery.placeId), 0)
    const touchesSnow = (this.snowPlaces.get(pickupPlace) ?? 0) > this.now || (this.snowPlaces.get(deliveryPlace) ?? 0) > this.now
    const minSlack = Math.min(
      ...request.options.map((o) => o.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins),
    )

    if (this.toggles.refinedChampion) {
      if (touchesSnow && minSlack < 30 * HOUR) {
        declineRequest()
        return
      }
      if (totalRoadMins > 360 && minSlack < 20 * HOUR) {
        declineRequest()
        return
      }
    }

    if (this.toggles.weatherElasticSurge) {
      // Decline tight northern snow routes
      if (touchesSnow && minSlack < 28 * HOUR) {
        declineRequest()
        return
      }
    }

    // Corridor classification
    const isPickupHub = pickupDrivers >= 6
    const isPickupSpoke = pickupDrivers <= 2
    const isDeliveryHub = deliveryDrivers >= 6
    const isDeliverySpoke = deliveryDrivers <= 2
    const isHubToHub = isPickupHub && isDeliveryHub
    const isHubToSpoke = isPickupHub && isDeliverySpoke
    const isSpokeToHub = isPickupSpoke && isDeliveryHub
    const isSpokeToSpoke = isPickupSpoke && isDeliverySpoke

    // 1. Bulk order batch cap
    if (F.selectiveDecline && request.batchId !== null) {
      const batchSoFar = this.batchCounts.get(request.batchId) ?? 0
      if (batchSoFar >= this.strategy.maxOrdersPerBatch) {
        declineRequest()
        return
      }
    }

    // 2. Per-town daily saturation cap
    const day = Math.floor(this.now / DAY)
    const townDayKey = `${day}:${pickupPlace}`
    const townWinsToday = this.townDayWins.get(townDayKey) ?? 0
    const maxTownWinsToday = Math.max(2, Math.ceil(effectivePickupSupply * 0.70))
    if (F.selectiveDecline && townWinsToday >= maxTownWinsToday && pickupDrivers < 10) {
      declineRequest()
      return
    }

    // 3. Fleet capacity & On-Time safety buffer gate
    const waiting = this.waitingOrdersCount()
    const totalDrivers = Math.max(1, this.roster.length)
    const liveOnTime = this.liveOnTimeRatio()
    const isShortageLevel = this.level >= 7
    const onTimeHealthy = liveOnTime >= this.strategy.targetOnTimeBuffer
    const maxWaitingAllowed = Math.max(
      4,
      Math.round(
        totalDrivers *
          (onTimeHealthy ? this.strategy.maxActiveWaitingPerDriver : this.strategy.maxActiveWaitingPerDriver * 0.55),
      ),
    )

    // Dynamic Corridors risk filter for dead-end to dead-end
    if (this.toggles.dynamicCorridors && isSpokeToSpoke && waiting >= maxWaitingAllowed * 0.70) {
      declineRequest()
      return
    }

    if (F.selectiveDecline && (waiting >= maxWaitingAllowed || this.urgent.size >= Math.max(3, Math.round(totalDrivers * 0.10)))) {
      declineRequest()
      return
    }

    // 4. Hard risk filters in shortage worlds
    const hasFlexibleOption = request.options.some((o) => o.kind === "next_day" || o.kind === "within_3_days")

    const snowAtPickup = (this.snowPlaces.get(pickupPlace) ?? 0) > this.now
    const snowAtDelivery = (this.snowPlaces.get(deliveryPlace) ?? 0) > this.now
    if (F.selectiveDecline && noteFlags.summerTyres && (snowAtPickup || snowAtDelivery) && !hasFlexibleOption) {
      declineRequest()
      return
    }

    if (F.selectiveDecline && isShortageLevel && effectivePickupSupply < 1) {
      declineRequest()
      return
    }

    if (F.selectiveDecline && !hasFlexibleOption) {
      const onlyOpt = request.options[0]!
      const slackBeforeDeadline = onlyOpt.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins
      if (
        (isShortageLevel && effectivePickupSupply < 2.5) ||
        slackBeforeDeadline < 260 ||
        (leg0.pickup.privateAddress && effectivePickupSupply < 3.5) ||
        noteFlags.hasTightDeadline
      ) {
        declineRequest()
        return
      }
    }

    // 5. Estimate realistic driver fee
    let estFeeMultiplier = this.strategy.baseFeeMultiplier
    if (effectivePickupSupply < 3) estFeeMultiplier += this.strategy.scarcityTownFeeBoost
    else if (repositionedAtPickup > 0) estFeeMultiplier -= 0.04
    if (deliveryDrivers < 2) estFeeMultiplier += 0.08
    if (leg0.pickup.privateAddress || lastLeg.delivery.privateAddress) estFeeMultiplier += 0.07
    if (noteFlags.manualLicence || noteFlags.withPlates) estFeeMultiplier += 0.07
    if (request.legs.some((l) => l.car.premium)) estFeeMultiplier += 0.05
    const expectedFeeCents = request.referenceFeeCents * estFeeMultiplier

    // 6. Base multiplier calculation
    let baseMult = this.strategy.baseQuoteMultiplier

    // Online adaptation from recent targeted quotes
    if (this.recentOutcomes.length >= 10) {
      const recentWins = this.recentOutcomes.filter(Boolean).length
      const recentWinRate = recentWins / this.recentOutcomes.length
      if (recentWinRate > this.strategy.targetWinRate + 0.10) {
        baseMult += 0.055
      } else if (recentWinRate > this.strategy.targetWinRate + 0.04) {
        baseMult += 0.025
      } else if (recentWinRate < this.strategy.targetWinRate - 0.10 && waiting < maxWaitingAllowed * 0.55) {
        baseMult -= 0.03
      }
    }

    // Dealer Learning baseline offsets
    const dealerOffset = F.dealerLearning ? (this.dealerPriceOffset.get(request.dealerId) ?? 0) : 0
    baseMult += dealerOffset

    const streak = F.dealerLearning ? (this.townOutageStreak.get(townDayKey) ?? 0) : 0
    if (streak >= 3) {
      baseMult += Math.min(0.16, (streak - 2) * 0.04)
    }

    if (this.level === 8 && F.dealerLearning) {
      const trust = this.dealerTrust.get(request.dealerId) ?? 0
      baseMult *= 1 + 0.0085 * Math.min(25, trust)
    }

    if (deliveryDrivers <= 1) baseMult *= 1.05
    if (pickupDrivers <= 2) baseMult *= 1.04

    // Apply Strategy 1: Dynamic Corridors
    if (this.toggles.dynamicCorridors) {
      if (isHubToHub) {
        baseMult *= 0.91 // Volume on safe lanes
      } else if (isHubToSpoke) {
        baseMult *= 1.18 // Bounty for outbound risk
      } else if (isSpokeToHub) {
        baseMult *= 0.97 // Competitive inward return
      } else if (isSpokeToSpoke) {
        baseMult *= 1.32 // Premium only
      }
    }

    // Apply Strategy 2 / Elastic Dealer v2 / Pure Inelastic Pricing
    if (this.toggles.pureInelastic) {
      const dReqs = this.dealerRequests.get(request.dealerId) ?? 0
      const dWins = this.dealerWins.get(request.dealerId) ?? 0
      const dWinRate = dWins / Math.max(1, dReqs)
      if (dWinRate >= 0.35 && dReqs >= 4) {
        baseMult += Math.min(0.18, dWins * 0.015)
      }
    } else if (this.toggles.elasticDealer || this.toggles.weatherElasticSurge || this.toggles.elasticV2) {
      const dReqs = this.dealerRequests.get(request.dealerId) ?? 0
      const dWins = this.dealerWins.get(request.dealerId) ?? 0
      const dWinRate = dWins / Math.max(1, dReqs)
      if (dWinRate >= 0.35 && dReqs >= 4) {
        baseMult += Math.min(0.18, dWins * 0.015)
      } else if (dWinRate < 0.18 && dReqs >= 5) {
        const totalKm = request.legs.reduce((sum, l) => sum + this.roadKm(l.pickup.placeId, l.delivery.placeId), 0)
        const nextDayOpt = request.options.find((o) => o.kind === "next_day")
        const slack = nextDayOpt ? nextDayOpt.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins : 0
        if (totalKm <= 160 && slack >= 14 * HOUR && isHubToHub) {
          const discount = this.toggles.elasticV2 ? 0.04 : 0.07
          baseMult -= discount
        }
      }
    }

    // Build option prices
    const prices: Partial<Record<"same_day" | "next_day" | "within_3_days", number>> = {}
    const minRequiredPrice = expectedFeeCents / Math.max(0.5, 1 - this.strategy.minExpectedMarginRatio)

    for (const opt of request.options) {
      if (this.toggles.weatherNetworkModel) {
        const assessment = this.weatherModel.assessRisk(
          request,
          this.now,
          (f, t) => this.roadMinutes(f, t),
          noteFlags,
        )
        const optRisk = assessment.optionRisks[opt.kind]
        if (!optRisk || !optRisk.safe) {
          continue
        }
      }

      // Urgency Asymmetry Extraction: captive same_day with no alternative
      if (
        (this.toggles.elasticDealer ||
          this.toggles.weatherElasticSurge ||
          this.toggles.elasticV2 ||
          this.toggles.pureInelastic ||
          this.toggles.weatherNetworkModel) &&
        opt.kind === "same_day" &&
        request.options.length === 1
      ) {
        const premium = this.toggles.elasticV2 || this.toggles.pureInelastic || this.toggles.weatherNetworkModel ? 0.08 : 0.16
        const quotePrice = Math.max(minRequiredPrice * 1.08, opt.listPriceCents * (baseMult + premium))
        prices.same_day = Math.max(100, Math.round(quotePrice))
        continue
      }

      if (opt.kind === "same_day" && hasFlexibleOption && F.optionSteering) {
        const slack = opt.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins
        if (effectivePickupSupply >= 4 && slack >= 300 && !noteFlags.hasTightDeadline && onTimeHealthy) {
          const rawSameDay = opt.listPriceCents * (baseMult + this.strategy.sameDayQuotePremium)
          if (rawSameDay >= minRequiredPrice * 1.05) {
            prices.same_day = Math.max(100, Math.round(rawSameDay))
          }
        }
        continue
      }

      let optMult = opt.kind === "same_day" ? baseMult + this.strategy.sameDayQuotePremium * 0.65 : baseMult
      if (this.toggles.weatherNetworkModel) {
        const assessment = this.weatherModel.assessRisk(
          request,
          this.now,
          (f, t) => this.roadMinutes(f, t),
          noteFlags,
        )
        const optRisk = assessment.optionRisks[opt.kind]
        if (optRisk && optRisk.recommendedQuoteMarkup > 0) {
          optMult += optRisk.recommendedQuoteMarkup
        }
      }
      const targetPrice = opt.listPriceCents * optMult
      if (targetPrice * 1.08 < minRequiredPrice) {
        continue
      }
      const finalPrice = Math.max(targetPrice, minRequiredPrice)
      prices[opt.kind] = Math.max(100, Math.round(finalPrice))
    }

    if (Object.keys(prices).length === 0) {
      declineRequest()
      return
    }

    this.outbox.push({ type: "quote", requestId: request.id, prices })
    this.targetedRequests.add(request.id)
    this.telemetry.quotedToWin++
    if (request.batchId !== null) {
      this.batchCounts.set(request.batchId, (this.batchCounts.get(request.batchId) ?? 0) + 1)
    }
  }

  override feesFor(order: Order, cars: number): FeeStep[] {
    if (
      !this.toggles.dynamicCorridors &&
      !this.toggles.emergencySurge &&
      !this.toggles.refinedChampion &&
      !this.toggles.weatherElasticSurge &&
      !this.toggles.weatherNetworkModel
    ) {
      return super.feesFor(order, cars)
    }

    const req = this.requests.get(order.id)!
    const baseRefFee = (req.referenceFeeCents * cars) / order.legs.length
    if (this.level === 1) {
      return [{ at: this.now, feeCents: Math.max(100, Math.round(baseRefFee * 1.15)) }]
    }

    const pickupPlace = order.legs[0]!.pickup.placeId
    const deliveryPlace = order.legs[order.legs.length - 1]!.delivery.placeId
    const pickupDrivers = this.localDriverCount(pickupPlace)
    const deliveryDrivers = this.localDriverCount(deliveryPlace)

    let scarcityAdd = 0
    if (this.level >= 7) {
      if (pickupDrivers <= 2) scarcityAdd += this.strategy.scarcityTownFeeBoost
      else if (pickupDrivers <= 4) scarcityAdd += this.strategy.scarcityTownFeeBoost * 0.45
      if (deliveryDrivers <= 1) scarcityAdd += 0.08
    }

    let weatherFeeBoost = 0
    if (this.toggles.weatherNetworkModel) {
      weatherFeeBoost = this.weatherModel.getDriverFeeBoostForOrder(order, this.now)
      if (weatherFeeBoost > 0) {
        scarcityAdd += weatherFeeBoost
      }
    }

    const slackToLastPickup = Math.max(0, order.lastPickupAt - this.now)

    // WeatherElasticSurge Fee Schedule: Baseline flat fees + dynamic emergency ramp for dropped/tight orders
    if (this.toggles.weatherElasticSurge) {
      const isUrgent = this.urgent.has(order.id) || slackToLastPickup <= 150 || this.droppedOrders.has(order.id)
      if (isUrgent) {
        const startMult = Math.max(this.strategy.urgentFeeMultiplier, this.strategy.baseFeeMultiplier + scarcityAdd + 0.45)
        const peakMult = Math.max(startMult + 0.45, 2.35 + scarcityAdd)
        const steps = [0, 1, 2, 3, 4]
        return steps.map((k) => ({
          at: this.now + k * 20,
          feeCents: Math.max(100, Math.round(baseRefFee * (startMult + (k / 4) * (peakMult - startMult)))),
        }))
      }
      return super.feesFor(order, cars)
    }
    const isRedSurge =
      this.toggles.emergencySurge &&
      (this.urgent.has(order.id) || slackToLastPickup <= 180 || this.droppedOrders.has(order.id))
    const isNormalUrgent =
      !this.toggles.emergencySurge &&
      (this.urgent.has(order.id) || slackToLastPickup <= 240 || (this.toggles.refinedChampion && this.droppedOrders.has(order.id)))

    // Refined Champion Upfront Booking Fee Schedule
    if (this.toggles.refinedChampion) {
      let openMult = Math.max(1.15, this.strategy.baseFeeMultiplier) + scarcityAdd
      let midMult = Math.max(openMult + 0.16, 1.40 + scarcityAdd)
      let normalPeak = Math.max(midMult + 0.14, 1.55 + scarcityAdd)
      const urgentPeak = Math.max(normalPeak + 0.35, 2.25 + scarcityAdd)

      if (isNormalUrgent) {
        const startMult = Math.max(1.60, openMult + 0.40)
        const steps = [0, 1, 2, 3, 4]
        return steps.map((k) => ({
          at: this.now + k * 20,
          feeCents: Math.max(100, Math.round(baseRefFee * (startMult + (k / 4) * (urgentPeak - startMult)))),
        }))
      }

      const rawSteps: FeeStep[] = [
        { at: this.now, feeCents: Math.max(100, Math.round(baseRefFee * openMult)) },
        { at: this.now + 240, feeCents: Math.max(100, Math.round(baseRefFee * midMult)) },
        { at: this.now + 360, feeCents: Math.max(100, Math.round(baseRefFee * normalPeak)) },
      ]
      const escalateStart = Math.max(this.now + 60, order.lastPickupAt - 260)
      for (let j = 1; j <= 4; j++) {
        const frac = j / 4
        rawSteps.push({
          at: escalateStart + (j - 1) * 35,
          feeCents: Math.max(100, Math.round(baseRefFee * (normalPeak + frac * (urgentPeak - normalPeak)))),
        })
      }

      const schedule: FeeStep[] = []
      for (const s of rawSteps) {
        const prev = schedule[schedule.length - 1]
        if (!prev) schedule.push(s)
        else if (s.at > prev.at) schedule.push({ at: s.at, feeCents: Math.max(prev.feeCents, s.feeCents) })
      }
      return schedule
    }

    // Strategy 3: Red Surge Exponential Dynamic Ramp
    if (this.toggles.emergencySurge && isRedSurge) {
      const baseUrgentMult = 1.65 + scarcityAdd
      const maxSurge = 2.75 + scarcityAdd
      const slackClamped = Math.max(0, Math.min(180, slackToLastPickup))
      const surgeExponent = (180 - slackClamped) / 180
      const startMult = baseUrgentMult * Math.pow(maxSurge / baseUrgentMult, surgeExponent)
      const peakMult = Math.max(startMult + 0.35, maxSurge)

      const deltas = [0, 15, 30, 60, 90, 120]
      return deltas.map((dt, idx) => {
        const frac = idx / (deltas.length - 1)
        const mult = startMult + frac * (peakMult - startMult)
        return {
          at: this.now + dt,
          feeCents: Math.max(100, Math.round(baseRefFee * mult)),
        }
      })
    }

    if (isNormalUrgent) {
      const startMult = Math.max(this.strategy.urgentFeeMultiplier, this.strategy.baseFeeMultiplier + scarcityAdd + 0.45)
      const peakMult = Math.max(startMult + 0.4, this.strategy.maxUrgentFeeMultiplier + scarcityAdd)
      const steps = [0, 1, 2, 3, 4, 5]
      return steps.map((k) => {
        const frac = k / (steps.length - 1)
        const mult = startMult + frac * (peakMult - startMult)
        return {
          at: this.now + k * 25,
          feeCents: Math.max(100, Math.round(baseRefFee * mult)),
        }
      })
    }

    let openMult = this.strategy.baseFeeMultiplier + scarcityAdd
    let midMult = Math.max(openMult + 0.18, this.strategy.maxNormalFeeMultiplier * 0.92 + scarcityAdd)
    let normalPeak = Math.max(midMult + 0.15, this.strategy.maxNormalFeeMultiplier + scarcityAdd)
    let flatHoldMins = 240
    let peakOffsetMins = 360

    if (this.toggles.dynamicCorridors) {
      const isPickupHub = pickupDrivers >= 6
      const isPickupSpoke = pickupDrivers <= 2
      const isDeliveryHub = deliveryDrivers >= 6
      const isDeliverySpoke = deliveryDrivers <= 2
      if (isPickupHub && isDeliveryHub) {
        openMult = (slackToLastPickup >= 16 * HOUR ? 0.82 : 0.88) + scarcityAdd
        midMult = 1.05 + scarcityAdd
        normalPeak = 1.25 + scarcityAdd
        flatHoldMins = 360
        peakOffsetMins = 540
      } else if (isPickupHub && isDeliverySpoke) {
        openMult = 1.15 + scarcityAdd
        midMult = 1.35 + scarcityAdd
        normalPeak = 1.55 + scarcityAdd
        flatHoldMins = 180
        peakOffsetMins = 300
      } else if (isPickupSpoke && isDeliveryHub) {
        openMult = 0.95 + scarcityAdd
        midMult = 1.15 + scarcityAdd
        normalPeak = 1.35 + scarcityAdd
        flatHoldMins = 240
        peakOffsetMins = 360
      } else if (isPickupSpoke && isDeliverySpoke) {
        openMult = 1.25 + scarcityAdd * 1.5
        midMult = 1.45 + scarcityAdd * 1.5
        normalPeak = 1.65 + scarcityAdd * 1.5
        flatHoldMins = 120
        peakOffsetMins = 240
      }
    } else if (this.strategy.flags.slackFees && pickupDrivers >= 4 && weatherFeeBoost === 0) {
      if (slackToLastPickup >= 30 * HOUR) {
        openMult = 0.88 + scarcityAdd
        midMult = 1.05 + scarcityAdd
        normalPeak = 1.26 + scarcityAdd
        flatHoldMins = 360
        peakOffsetMins = 720
      } else if (slackToLastPickup >= 16 * HOUR) {
        openMult = 0.98 + scarcityAdd
        midMult = 1.16 + scarcityAdd
        normalPeak = 1.35 + scarcityAdd
        flatHoldMins = 240
        peakOffsetMins = 420
      }
    }

    if (this.toggles.emergencySurge && slackToLastPickup > 180 && slackToLastPickup <= 300) {
      openMult = Math.max(openMult, 1.28 + scarcityAdd)
      midMult = Math.max(midMult, 1.42 + scarcityAdd)
      flatHoldMins = 90
      peakOffsetMins = 150
    }

    const urgentPeak = Math.max(normalPeak + 0.35, this.strategy.maxUrgentFeeMultiplier + scarcityAdd)

    const rawSteps: FeeStep[] = [
      { at: this.now, feeCents: Math.max(100, Math.round(baseRefFee * openMult)) },
      { at: this.now + flatHoldMins, feeCents: Math.max(100, Math.round(baseRefFee * midMult)) },
      { at: this.now + peakOffsetMins, feeCents: Math.max(100, Math.round(baseRefFee * normalPeak)) },
    ]

    const escalateLead = this.toggles.emergencySurge ? 180 : 300
    const escalateStart = Math.max(this.now + 60, order.lastPickupAt - escalateLead)
    for (let j = 1; j <= 4; j++) {
      const frac = j / 4
      const mult = normalPeak + frac * (urgentPeak - normalPeak)
      rawSteps.push({
        at: escalateStart + (j - 1) * (this.toggles.emergencySurge ? 25 : 45),
        feeCents: Math.max(100, Math.round(baseRefFee * mult)),
      })
    }

    const schedule: FeeStep[] = []
    for (const s of rawSteps) {
      const prev = schedule[schedule.length - 1]
      if (!prev) {
        schedule.push(s)
      } else if (s.at > prev.at) {
        schedule.push({
          at: s.at,
          feeCents: Math.max(prev.feeCents, s.feeCents),
        })
      }
    }
    return schedule
  }

  override tryDirectOfferToDriver(gigId: string, driverId: string): void {
    const orderId = this.gigOrder.get(gigId)
    const isUrgent = orderId ? this.urgent.has(orderId) || this.droppedOrders.has(orderId) : false

    if (this.toggles.emergencySurge && isUrgent) {
      if (this.level < 3 || !this.strategy.flags.repositionOffers) return
      const minuteOfDay = this.now % DAY
      if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return
      if ((this.gigOpenOffers.get(gigId) ?? 0) >= 4) return

      const pairKey = `${gigId}:${driverId}`
      if (this.offeredPairs.has(pairKey)) return

      const day = Math.floor(this.now / DAY)
      const driverDayKey = `${day}:${driverId}`
      const sentToday = this.driverOffersByDay.get(driverDayKey) ?? 0
      if (sentToday >= 4) return

      const postAction = this.posts.get(gigId)
      if (!postAction) return

      const profile = this.roster.find((d) => d.id === driverId)
      if (!profile) return

      if (postAction.audience.experienced && (profile.rating < 4.8 || profile.completedGigs < 50)) return
      if (postAction.audience.manualLicence && profile.licence !== "manual") return

      let currentFee = postAction.schedule[0]!.feeCents
      for (const step of postAction.schedule) {
        if (step.at <= this.now) currentFee = step.feeCents
      }
      const offerFee = Math.max(100, Math.round(currentFee * 1.00))

      this.outbox.push({
        type: "offer",
        gigId,
        driverId,
        feeCents: offerFee,
      })
      this.offeredPairs.add(pairKey)
      this.driverOffersByDay.set(driverDayKey, sentToday + 1)
      this.gigOpenOffers.set(gigId, (this.gigOpenOffers.get(gigId) ?? 0) + 1)
      this.telemetry.totalDirectOffers++
      return
    }

    super.tryDirectOfferToDriver(gigId, driverId)
  }
}

export async function runExperimentalWorld(options: {
  seed: string
  level?: number
  strategy?: StrategyConfig
  toggles?: ExperimentToggles
}): Promise<{ score: Score; telemetry: QuantitativeDesk["telemetry"] }> {
  const level = (options.level ?? 8) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  const strategy = options.strategy ?? loadStrategy()
  const toggles = options.toggles ?? {}
  const client = new Client()
  const map = await client.map()

  const run = await client.create(level, { seed: options.seed, board: false })
  const remove = () => run.delete().then(() => true, () => false)

  try {
    const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
    const desk = new ExperimentalDesk(run, level, now, map, roster, strategy, toggles)

    while (desk.now < endsAt) {
      const day = Math.floor(desk.now / DAY)
      const midnight = (day + 1) * DAY
      const actions = desk.outbox.splice(0)
      const step = await run.advance({ untilEvent: WAKE_ON, max: Math.min(endsAt, midnight), actions })
      desk.readResults(actions, step.results)
      desk.now = step.now
      for (const event of step.events) await desk.handle(event)
    }

    const finalScore = await run.score()
    desk.finalizeTelemetry()
    return { score: finalScore, telemetry: desk.telemetry }
  } finally {
    await remove()
  }
}

export interface BenchmarkResult {
  name: string
  toggles: ExperimentToggles
  seeds: string[]
  seedResults: {
    seed: string
    marginEur: number
    onTimeShare: number
    wonOrders: number
    winRate: number
    gigDrops: number
    lateDeliveries: number
    deadlineWarnings: number
    ranked: boolean
  }[]
  avgMarginEur: number
  totalMarginEur: number
  avgOnTimeShare: number
  minOnTimeShare: number
  avgWonOrders: number
  allRanked: boolean
}

export async function benchmarkStrategy(
  name: string,
  strategy: StrategyConfig,
  toggles: ExperimentToggles = {},
  seeds: string[] = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"],
  concurrency = 2,
): Promise<BenchmarkResult> {
  const seedResults: BenchmarkResult["seedResults"] = []
  const queue = [...seeds]

  const originalLog = console.log
  console.log = () => {}

  async function worker() {
    while (queue.length > 0) {
      const seed = queue.shift()!
      let retries = 0
      while (retries < 3) {
        try {
          const { score, telemetry } = await runExperimentalWorld({
            seed,
            level: 8,
            strategy,
            toggles,
          })
          const quoted = telemetry.quotedToWin || 1
          seedResults.push({
            seed,
            marginEur: Number((score.marginCents / 100).toFixed(2)),
            onTimeShare: Number(score.onTimeShare.toFixed(4)),
            wonOrders: score.wonOrders,
            winRate: Number((score.wonOrders / quoted).toFixed(4)),
            gigDrops: telemetry.gigDrops ?? 0,
            lateDeliveries: telemetry.lateDeliveries ?? 0,
            deadlineWarnings: telemetry.deadlineWarnings ?? 0,
            ranked: score.ranked,
          })
          break
        } catch (err) {
          retries++
          if (retries >= 3) {
            originalLog(`[benchmark] Error on ${seed} (${name}): ${(err as Error).message}`)
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
            })
            break
          }
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
      originalLog(`[benchmark] ${name}: finished ${seed}`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, worker))
  console.log = originalLog

  seedResults.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed))

  const count = seedResults.length || 1
  const totalMargin = seedResults.reduce((sum, r) => sum + r.marginEur, 0)
  const avgMargin = totalMargin / count
  const avgOT = seedResults.reduce((sum, r) => sum + r.onTimeShare, 0) / count
  const minOT = Math.min(...seedResults.map((r) => r.onTimeShare))
  const avgWon = seedResults.reduce((sum, r) => sum + r.wonOrders, 0) / count
  const allRanked = seedResults.every((r) => r.ranked && r.onTimeShare >= 0.90)

  return {
    name,
    toggles,
    seeds,
    seedResults,
    avgMarginEur: Number(avgMargin.toFixed(2)),
    totalMarginEur: Number(totalMargin.toFixed(2)),
    avgOnTimeShare: Number(avgOT.toFixed(4)),
    minOnTimeShare: Number(minOT.toFixed(4)),
    avgWonOrders: Number(avgWon.toFixed(1)),
    allRanked,
  }
}

export function formatResultMarkdown(res: BenchmarkResult): string {
  let md = `### Benchmark: ${res.name}\n\n`
  md += `| Seed | Margin (€) | On-Time (%) | Won Orders | Win Rate (%) | Drops | Late | Ranked |\n`
  md += `|---|---|---|---|---|---|---|---|\n`
  for (const s of res.seedResults) {
    md += `| ${s.seed} | €${s.marginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })} | ${(s.onTimeShare * 100).toFixed(1)}% | ${s.wonOrders} | ${(s.winRate * 100).toFixed(1)}% | ${s.gigDrops} | ${s.lateDeliveries} | ${s.ranked ? "✅ YES" : "❌ NO"} |\n`
  }
  md += `\n**Summary:** Avg Margin: **€${res.avgMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}/wk** (Total: €${res.totalMarginEur.toLocaleString("en-US", { minimumFractionDigits: 2 })}) | Avg OT: **${(res.avgOnTimeShare * 100).toFixed(1)}%** | Min OT: **${(res.minOnTimeShare * 100).toFixed(1)}%** | Avg Won Orders: **${res.avgWonOrders}** | All Ranked: **${res.allRanked ? "✅ YES" : "❌ NO"}**\n`
  return md
}

// CLI execution
if (process.argv[1]?.endsWith("experiment-runners.ts")) {
  const { values: args } = parseArgs({
    options: {
      strategy: { type: "string", default: "baseline" },
      seeds: { type: "string", default: "spread-1,spread-2,spread-3,spread-4,spread-5" },
      concurrency: { type: "string", default: "2" },
    },
  })

  const seeds = args.seeds!.split(",").map((s) => s.trim())
  const concurrency = Number(args.concurrency)
  const baseStrategy = loadStrategy()

  let toggles: ExperimentToggles = {}
  let label = "Baseline v8"

  if (args.strategy === "corridors") {
    toggles = { dynamicCorridors: true }
    label = "Strategy 1: Dynamic Corridors"
  } else if (args.strategy === "elastic") {
    toggles = { elasticDealer: true }
    label = "Strategy 2: Elastic Dealer Pricing"
  } else if (args.strategy === "elastic-v2") {
    toggles = { elasticV2: true }
    label = "Strategy 2b: Elastic Dealer v2"
  } else if (args.strategy === "pure-inelastic") {
    toggles = { pureInelastic: true }
    label = "Strategy 2c: Pure Inelastic Ratchet"
  } else if (args.strategy === "weather-model" || args.strategy === "weather") {
    toggles = { pureInelastic: true, weatherNetworkModel: true }
    label = "Strategy 6: Weather-Aware Network Model + Pure Inelastic Ratchet"
  } else if (args.strategy === "surge") {
    toggles = { emergencySurge: true }
    label = "Strategy 3: Adaptive Emergency Surge"
  } else if (args.strategy === "refined") {
    toggles = { refinedChampion: true }
    label = "Strategy 4: Refined Weather & Upfront Liquidity"
  } else if (args.strategy === "optimized" || args.strategy === "ensemble") {
    toggles = { weatherElasticSurge: true }
    label = "Strategy 5: Weather Defense & Elastic Capture"
  } else if (args.strategy === "all") {
    toggles = { dynamicCorridors: true, elasticDealer: true, emergencySurge: true }
    label = "Combined: All 3 Strategies"
  }

  console.log(`Starting benchmark for "${label}" on seeds ${seeds.join(", ")} (concurrency ${concurrency})...`)
  const result = await benchmarkStrategy(label, baseStrategy, toggles, seeds, concurrency)
  console.log(formatResultMarkdown(result))
}
