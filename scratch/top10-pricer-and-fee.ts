/**
 * Top-10 High-Margin Bayesian Competitor Pricer, Surge Controller, & Zero-Holdout Fee Engine.
 *
 * Designed from empirical offline forensic analysis of:
 * - `data/historical-dealer-orders.json` (7,021 option-level quotes across spread-1..spread-5)
 * - `scratch/r2_events.json` vs `scratch/r4_events.json` (driver holdout belief drift: HANDBOOK.md:266)
 * - `scratch/ground_truth_report.json` (visit_failed & late_refund root causes)
 * - `scratch/RULES.md` & `scratch/HANDBOOK.md` (Level 8 Trust, Outage +30%, Price War -20%)
 */

import type {
  Audience,
  DriverProfile,
  FeeStep,
  Order,
  Place,
  PriceRequest,
  Road,
  WorldMap,
} from "../types.ts"

const HOUR = 60
const DAY = 24 * HOUR

export type DeliveryOptionKind = "same_day" | "next_day" | "within_3_days"

export interface Top10PricerConfig {
  level: number
  baseQuoteMultiplier: number
  sameDayQuotePremium: number
  minExpectedMarginRatio: number
  targetWinRate: number
  maxActiveWaitingPerDriver: number
  maxOrdersPerBatch: number
  baseFeeMultiplier: number
  maxNormalFeeMultiplier: number
  urgentFeeMultiplier: number
  maxUrgentFeeMultiplier: number
  scarcityTownFeeBoost: number
  /** Must remain strictly > 1.02x current board fee to prevent direct-offer rejection. */
  directOfferMultiplier: number
  targetOnTimeBuffer: number
  strictCapacityGate?: boolean
  minQuoteMultiplier?: number
  worldBaseMuFloor?: number
}

export const DEFAULT_TOP10_CONFIG: Top10PricerConfig = {
  level: 8,
  baseQuoteMultiplier: 1.468,
  sameDayQuotePremium: 0.214,
  minExpectedMarginRatio: 0.18,
  targetWinRate: 0.315,
  maxActiveWaitingPerDriver: 0.32,
  maxOrdersPerBatch: 5,
  baseFeeMultiplier: 1.145,
  maxNormalFeeMultiplier: 1.45,
  urgentFeeMultiplier: 1.92,
  maxUrgentFeeMultiplier: 2.35,
  scarcityTownFeeBoost: 0.17,
  directOfferMultiplier: 1.03,
  targetOnTimeBuffer: 0.935,
  strictCapacityGate: true,
  minQuoteMultiplier: 1.28,
  worldBaseMuFloor: 1.32,
}

export interface NoteFlags {
  manualLicence: boolean
  withPlates: boolean
  summerTyres: boolean
  hasTightDeadline: boolean
  noteDeadline?: number | null
}

export interface PricingContext {
  now: number
  waitingCount: number
  activeUnbookedUrgent: number
  totalDrivers: number
  liveOnTimeShare: number
  pickupDrivers: number
  deliveryDrivers: number
  repositionedAtPickup: number
  townWinsToday: number
  batchWinsSoFar: number
  snowAtPickup: boolean
  snowAtDelivery: boolean
  totalRoadMins: number
  totalRoadKm: number
  noteFlags: NoteFlags
  /** Optional fee discount factor (e.g. 0.80) when chaining engine pairs this request with an open unbooked gig. */
  chainingDiscountRatio?: number
}

export interface QuoteDecision {
  action: "quote" | "decline"
  prices: Partial<Record<DeliveryOptionKind, number>>
  estimatedCompMultiplier: number
  expectedFeeCents: number
  surgeApplied: number
  regime: "normal" | "price_war" | "outage" | "congested_surge"
  reason: string
}

interface BayesianStat {
  offset: number
  obs: number
}

interface DealerState {
  offset: number
  obs: number
  reqs: number
  wins: number
  trust: number
}

interface PendingQuoteRecord {
  request: PriceRequest
  quotedMultipliers: Partial<Record<DeliveryOptionKind, number>>
  day: number
  laneKey: string
  isBusinessHours: boolean
  wasOutageBoosted: boolean
  wasPriceWarDiscounted: boolean
  surgeApplied: number
}

export function haversineKm(a: Place, b: Place): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * (i) Bayesian Per-Lane + Dealer + Day Competitor Curve + Level 8 Trust Tracker + Price-War / Outage Detectors
 * (ii) Surge Pricing instead of Hard Declines on Congested Batches/Towns for Flexible Options
 */
export class BayesianCompetitorPricer {
  readonly config: Top10PricerConfig
  readonly placesById = new Map<string, Place>()
  readonly roadByPair = new Map<string, Road>()

  // Hierarchical Bayesian state for compQuote / listPrice
  private worldBaseMu: number
  private worldObsCount = 0
  private readonly lanePosteriors = new Map<string, BayesianStat>()
  private readonly dealerStates = new Map<string, DealerState>()
  private readonly dayPosteriors = new Map<number, BayesianStat>()
  private readonly pendingQuotes = new Map<string, PendingQuoteRecord>()

  // Rolling market outcomes for adaptation & regime detection
  private readonly recentTargetedOutcomes: boolean[] = []
  private readonly businessHourHistory: Array<{
    at: number
    day: number
    pickupPlace: string
    dealerId: string
    won: boolean
    normMult: number
  }> = []

  // Regime detectors (HANDBOOK.md: Price War -20% vs Outage +30% on working days 08:00-18:00)
  private activePriceWarDay: number | null = null
  private activeOutage: { day: number; centerPlaceId: string } | null = null
  private readonly townDayStreak = new Map<string, { streak: number; wins: number; total: number }>()

  // Empirical option offsets calibrated from data/historical-dealer-orders.json (N=7,021)
  private static readonly OPTION_PRIOR: Record<DeliveryOptionKind, number> = {
    same_day: 0.0,
    next_day: 0.0,
    within_3_days: -0.035,
  }

  constructor(map: WorldMap, config: Partial<Top10PricerConfig> = {}) {
    this.config = { ...DEFAULT_TOP10_CONFIG, ...config }
    for (const p of map.places) this.placesById.set(p.id, p)
    for (const r of map.roads) this.roadByPair.set(`${r.from}->${r.to}`, r)

    // Level-aware prior (HANDBOOK.md: L8 1.26-1.54, L7 1.12-1.38, L6 0.90-1.10)
    if (this.config.level >= 8) this.worldBaseMu = this.config.baseQuoteMultiplier
    else if (this.config.level === 7) this.worldBaseMu = Math.max(1.22, this.config.baseQuoteMultiplier - 0.14)
    else if (this.config.level === 6) this.worldBaseMu = 1.08
    else this.worldBaseMu = 1.04
  }

  private getDealer(dealerId: string): DealerState {
    let s = this.dealerStates.get(dealerId)
    if (!s) {
      s = { offset: 0, obs: 0, reqs: 0, wins: 0, trust: 0 }
      this.dealerStates.set(dealerId, s)
    }
    return s
  }

  private isWorkingHours(atMinute: number): { day: number; isWorkHours: boolean } {
    const day = Math.floor(atMinute / DAY)
    const mod = atMinute % DAY
    // Mon-Fri (days 0..4), 08:00 (480) to 18:00 (1080)
    const isWorkHours = day <= 4 && mod >= 8 * HOUR && mod < 18 * HOUR
    return { day, isWorkHours }
  }

  private isInsideOutageRegion(placeId: string, day: number): boolean {
    if (!this.activeOutage || this.activeOutage.day !== day) return false
    if (placeId === this.activeOutage.centerPlaceId) return true
    const center = this.placesById.get(this.activeOutage.centerPlaceId)
    const target = this.placesById.get(placeId)
    if (!center || !target) return false
    return haversineKm(center, target) <= 80.5
  }

  /**
   * Level 8 Dealer Trust update (+1% per on-time delivery up to 25; late halves count).
   */
  recordDelivery(dealerId: string, wasOnTime: boolean): void {
    const d = this.getDealer(dealerId)
    if (wasOnTime) {
      d.trust = Math.min(25, d.trust + 1)
    } else {
      d.trust = Math.floor(d.trust / 2)
    }
  }

  getDealerTrust(dealerId: string): number {
    return this.getDealer(dealerId).trust
  }

  /**
   * Estimates the competitor's expected multiplier (compQuote / listPrice) before our trust bonus.
   */
  estimateCompMultiplier(
    pickupPlace: string,
    deliveryPlace: string,
    dealerId: string,
    option: DeliveryOptionKind,
    roadKm: number,
    day: number,
    deliveryDrivers: number,
    pickupDrivers: number,
  ): number {
    const laneKey = `${pickupPlace}->${deliveryPlace}`
    const lane = this.lanePosteriors.get(laneKey)
    const dealer = this.getDealer(dealerId)
    const dayStat = this.dayPosteriors.get(day)

    // Bayesian shrinkage toward 0 for sparse observations
    const laneEffect = lane ? (lane.offset * lane.obs) / (4 + lane.obs) : 0
    const dealerEffect = (dealer.offset * dealer.obs) / (3 + dealer.obs)
    const dayEffect = dayStat ? (dayStat.offset * dayStat.obs) / (6 + dayStat.obs) : 0

    // Distance structural premium: empirical data shows Long (>110€) & Ultra (>170€) convert ~5% higher than medium
    const distBonus = roadKm >= 260 ? 0.035 : roadKm >= 150 ? 0.015 : 0

    // Structural scarcity lane prior (HANDBOOK.md:286: higher where few drivers live near delivery)
    let scarcityPrior = 0
    if (deliveryDrivers <= 1) scarcityPrior += 0.055
    else if (deliveryDrivers <= 2) scarcityPrior += 0.025
    if (pickupDrivers <= 2) scarcityPrior += 0.04

    // Captive inelastic dealer asymmetric ratchet (gated on settled positive dealer posterior)
    let captiveRatchet = 0
    const dWinRate = dealer.wins / Math.max(1, dealer.reqs)
    if (dealer.reqs >= 6 && dWinRate >= 0.4 && dealer.offset >= -0.02) {
      captiveRatchet = Math.min(0.1, dealer.wins * 0.01)
    }

    const optBase = BayesianCompetitorPricer.OPTION_PRIOR[option]

    let est =
      this.worldBaseMu +
      laneEffect +
      dealerEffect +
      dayEffect +
      optBase +
      distBonus +
      scarcityPrior +
      captiveRatchet

    return Math.max(1.05, Math.min(2.6, est))
  }

  /**
   * Evaluates a price request: computes Bayesian quote or applies congestion surge on flexible options.
   */
  evaluateQuote(request: PriceRequest, ctx: PricingContext): QuoteDecision {
    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupPlace = leg0.pickup.placeId
    const deliveryPlace = lastLeg.delivery.placeId
    const effectivePickupSupply = ctx.pickupDrivers + ctx.repositionedAtPickup * 1.5
    const { day, isWorkHours } = this.isWorkingHours(ctx.now)

    const dealer = this.getDealer(request.dealerId)
    dealer.reqs++

    const hasFlexibleOption = request.options.some((o) => o.kind === "next_day" || o.kind === "within_3_days")
    const isShortageLevel = this.config.level >= 7
    const onTimeHealthy = ctx.liveOnTimeShare >= this.config.targetOnTimeBuffer
    const maxWaitingAllowed = Math.max(
      4,
      Math.round(
        Math.max(1, ctx.totalDrivers) *
          (onTimeHealthy ? this.config.maxActiveWaitingPerDriver : this.config.maxActiveWaitingPerDriver * 0.55),
      ),
    )

    // 1. Hard risk filters (ONLY for genuinely unfulfillable / toxic orders)
    if (ctx.noteFlags.summerTyres && (ctx.snowAtPickup || ctx.snowAtDelivery) && !hasFlexibleOption) {
      return {
        action: "decline",
        prices: {},
        estimatedCompMultiplier: 0,
        expectedFeeCents: 0,
        surgeApplied: 0,
        regime: "normal",
        reason: "summer_tyres_in_snow_no_flex",
      }
    }

    if (isShortageLevel && effectivePickupSupply < 1 && !hasFlexibleOption) {
      return {
        action: "decline",
        prices: {},
        estimatedCompMultiplier: 0,
        expectedFeeCents: 0,
        surgeApplied: 0,
        regime: "normal",
        reason: "zero_pickup_supply_same_day",
      }
    }

    if (!hasFlexibleOption) {
      const onlyOpt = request.options[0]!
      const slackBeforeDeadline = onlyOpt.deadline - Math.max(ctx.now, leg0.pickup.window.from) - ctx.totalRoadMins
      if (
        (isShortageLevel && effectivePickupSupply < 1.5 && slackBeforeDeadline < 360) ||
        slackBeforeDeadline < 240 ||
        (leg0.pickup.privateAddress && effectivePickupSupply < 2.5) ||
        ctx.noteFlags.hasTightDeadline
      ) {
        return {
          action: "decline",
          prices: {},
          estimatedCompMultiplier: 0,
          expectedFeeCents: 0,
          surgeApplied: 0,
          regime: "normal",
          reason: "tight_same_day_risk",
        }
      }
    }

    // Critical fleet melt protection / strict queue gating (matches v15 safety when strictCapacityGate=true)
    const strictGate = this.config.strictCapacityGate !== false
    const criticalFleetOverload = strictGate
      ? ctx.waitingCount >= maxWaitingAllowed ||
        ctx.activeUnbookedUrgent >= Math.max(4, Math.round(ctx.totalDrivers * 0.12)) ||
        ctx.liveOnTimeShare < this.config.targetOnTimeBuffer - 0.02
      : ctx.waitingCount >= Math.round(maxWaitingAllowed * 1.45) ||
        ctx.activeUnbookedUrgent >= Math.max(6, Math.round(ctx.totalDrivers * 0.16)) ||
        ctx.liveOnTimeShare < this.config.targetOnTimeBuffer - 0.02

    if (criticalFleetOverload) {
      return {
        action: "decline",
        prices: {},
        estimatedCompMultiplier: 0,
        expectedFeeCents: 0,
        surgeApplied: 0,
        regime: "congested_surge",
        reason: "critical_fleet_overload",
      }
    }

    // 2. Hard batch/town saturation gating (strictGate) or congestion surge
    let surgePremium = 0
    let congestionFeeAdder = 0
    let blockSameDayDueToCongestion = false

    if (request.batchId !== null && ctx.batchWinsSoFar >= this.config.maxOrdersPerBatch) {
      if (strictGate || !hasFlexibleOption) {
        return {
          action: "decline",
          prices: {},
          estimatedCompMultiplier: 0,
          expectedFeeCents: 0,
          surgeApplied: 0,
          regime: "congested_surge",
          reason: "batch_cap_same_day",
        }
      }
      const overflow = ctx.batchWinsSoFar - this.config.maxOrdersPerBatch + 1
      surgePremium += Math.min(0.45, 0.12 + overflow * 0.08)
      congestionFeeAdder += 0.12
      blockSameDayDueToCongestion = true
    }

    const maxTownWinsToday = Math.max(2, Math.ceil(effectivePickupSupply * 0.7))
    if (ctx.townWinsToday >= maxTownWinsToday && ctx.pickupDrivers < 10) {
      if (strictGate || !hasFlexibleOption) {
        return {
          action: "decline",
          prices: {},
          estimatedCompMultiplier: 0,
          expectedFeeCents: 0,
          surgeApplied: 0,
          regime: "congested_surge",
          reason: "town_cap_same_day",
        }
      }
      const townOverflow = ctx.townWinsToday - maxTownWinsToday + 1
      surgePremium += Math.min(0.4, 0.14 + townOverflow * 0.06)
      congestionFeeAdder += 0.14
      blockSameDayDueToCongestion = true
    }

    if (ctx.waitingCount >= maxWaitingAllowed * 0.85) {
      if (!hasFlexibleOption) {
        return {
          action: "decline",
          prices: {},
          estimatedCompMultiplier: 0,
          expectedFeeCents: 0,
          surgeApplied: 0,
          regime: "congested_surge",
          reason: "queue_cap_same_day",
        }
      }
      const loadRatio = ctx.waitingCount / Math.max(1, maxWaitingAllowed)
      surgePremium += Math.min(0.38, Math.max(0.08, (loadRatio - 0.85) * 0.6))
      congestionFeeAdder += 0.1
      blockSameDayDueToCongestion = true
    }

    // 3. Estimate realistic driver fee (accounting for ~5% real-world escalation/drop expectation on solo baseline)
    let estFeeMultiplier = Math.max(1.05, this.config.baseFeeMultiplier) + congestionFeeAdder
    if (effectivePickupSupply < 3) estFeeMultiplier += this.config.scarcityTownFeeBoost
    else if (ctx.repositionedAtPickup > 0) estFeeMultiplier -= 0.04
    if (ctx.deliveryDrivers < 2) estFeeMultiplier += 0.08
    if (leg0.pickup.privateAddress || lastLeg.delivery.privateAddress) estFeeMultiplier += 0.07
    if (ctx.noteFlags.manualLicence || ctx.noteFlags.withPlates) estFeeMultiplier += 0.07
    if (request.legs.some((l) => l.car.premium)) estFeeMultiplier += 0.05
    if (ctx.chainingDiscountRatio && ctx.chainingDiscountRatio < 1.0) {
      estFeeMultiplier *= ctx.chainingDiscountRatio
    }

    const expectedFeeCents = request.referenceFeeCents * estFeeMultiplier
    const minRequiredPrice = expectedFeeCents / Math.max(0.5, 1 - this.config.minExpectedMarginRatio)

    // 4. Online proportional winRate stabilizer
    let winRateAdjust = 0
    if (this.recentTargetedOutcomes.length >= 10) {
      const recentWins = this.recentTargetedOutcomes.filter(Boolean).length
      const recentWinRate = recentWins / this.recentTargetedOutcomes.length
      const winGap = recentWinRate - this.config.targetWinRate
      if (winGap > 0.04) {
        winRateAdjust = Math.min(0.1, winGap * 0.45)
      } else if (winGap < -0.04 && ctx.waitingCount < maxWaitingAllowed * 0.8 && onTimeHealthy) {
        winRateAdjust = Math.max(-0.22, winGap * 0.75)
      }
    }

    // 5. Regime Detection: Regional Outage (+30%) vs Price War (-20%) on working days 08:00-18:00
    let regime: QuoteDecision["regime"] = surgePremium > 0 ? "congested_surge" : "normal"
    let regimeMultiplier = 1.0
    const isOutageActiveHere = isWorkHours && this.isInsideOutageRegion(pickupPlace, day)
    const isPriceWarActiveHere = isWorkHours && this.activePriceWarDay === day && !isOutageActiveHere

    if (isOutageActiveHere) {
      regime = "outage"
      regimeMultiplier = 1.24 // Extract +24% against competitor's +30% backup
    } else if (isPriceWarActiveHere) {
      regime = "price_war"
      regimeMultiplier = 0.84 // Temporary -16% defense against -20% competitor price war
    }

    // 6. Level 8 Dealer Trust Factor (+1% per on-time order up to 25)
    const trustFactor = this.config.level >= 8 ? 1 + 0.009 * Math.min(25, dealer.trust) : 1.0

    // 7. Build Option Prices
    const prices: Partial<Record<DeliveryOptionKind, number>> = {}
    const quotedMultipliers: Partial<Record<DeliveryOptionKind, number>> = {}
    let refCompMult = 1.468

    for (const opt of request.options) {
      if (opt.kind === "same_day" && blockSameDayDueToCongestion) continue

      const baseCompMult = this.estimateCompMultiplier(
        pickupPlace,
        deliveryPlace,
        request.dealerId,
        opt.kind,
        ctx.totalRoadKm,
        day,
        ctx.deliveryDrivers,
        ctx.pickupDrivers,
      )
      refCompMult = baseCompMult

      // Combine Bayesian competitor estimate + online stabilizer + trust + regime + surge
      let targetMult = (baseCompMult + winRateAdjust) * trustFactor * regimeMultiplier + surgePremium

      // Captive single same_day extraction
      if (opt.kind === "same_day" && request.options.length === 1) {
        targetMult += 0.08
      } else if (opt.kind === "same_day" && hasFlexibleOption) {
        // Option steering: quote same_day high so dealer either pays rich premium or steers to next_day
        const slack = opt.deadline - Math.max(ctx.now, leg0.pickup.window.from) - ctx.totalRoadMins
        if (effectivePickupSupply < 4 || slack < 300 || ctx.noteFlags.hasTightDeadline || !onTimeHealthy) {
          continue
        }
        targetMult += this.config.sameDayQuotePremium
      }

      const minQuoteMult = this.config.level >= 8 ? (this.config.minQuoteMultiplier ?? 1.28) : 1.05
      targetMult = Math.max(targetMult, minQuoteMult)

      const rawPrice = opt.listPriceCents * targetMult
      // Reject individual option if below profitable break-even floor (tight 1.02x vs old 1.06x slack)
      if (rawPrice * 1.02 < minRequiredPrice) {
        continue
      }
      const finalPrice = Math.max(100, Math.round(Math.max(rawPrice, minRequiredPrice)))
      prices[opt.kind] = finalPrice
      quotedMultipliers[opt.kind] = finalPrice / Math.max(1, opt.listPriceCents)
    }

    if (Object.keys(prices).length === 0) {
      return {
        action: "decline",
        prices: {},
        estimatedCompMultiplier: refCompMult,
        expectedFeeCents,
        surgeApplied: surgePremium,
        regime,
        reason: "below_min_margin_floor",
      }
    }

    this.pendingQuotes.set(request.id, {
      request,
      quotedMultipliers,
      day,
      laneKey: `${pickupPlace}->${deliveryPlace}`,
      isBusinessHours: isWorkHours,
      wasOutageBoosted: isOutageActiveHere,
      wasPriceWarDiscounted: isPriceWarActiveHere,
      surgeApplied: surgePremium,
    })

    return {
      action: "quote",
      prices,
      estimatedCompMultiplier: refCompMult,
      expectedFeeCents,
      surgeApplied: surgePremium,
      regime,
      reason: surgePremium > 0 ? `surge_+${(surgePremium * 100).toFixed(0)}%` : "bayesian_optimal",
    }
  }

  /**
   * Online Bayesian update when `order_won` or `order_lost` arrives.
   */
  observeOutcome(requestId: string, won: boolean, wonOption?: DeliveryOptionKind, atMinute?: number): void {
    const rec = this.pendingQuotes.get(requestId)
    if (!rec) return
    this.pendingQuotes.delete(requestId)

    this.recentTargetedOutcomes.push(won)
    if (this.recentTargetedOutcomes.length > 35) this.recentTargetedOutcomes.shift()

    const dealer = this.getDealer(rec.request.dealerId)
    if (won) dealer.wins++

    // Determine the normalized quote multiplier (removing trust, option offset, and regime factor)
    const optKind: DeliveryOptionKind =
      won && wonOption
        ? wonOption
        : rec.quotedMultipliers.next_day !== undefined
          ? "next_day"
          : rec.quotedMultipliers.within_3_days !== undefined
            ? "within_3_days"
            : "same_day"

    const rawMult = rec.quotedMultipliers[optKind]
    if (rawMult === undefined) return

    const trustFactor = this.config.level >= 8 ? 1 + 0.009 * Math.min(25, dealer.trust) : 1.0
    const optPrior = BayesianCompetitorPricer.OPTION_PRIOR[optKind]
    const normMult = rawMult / trustFactor - optPrior

    // Update Outage & Price-War streak detectors during working hours (08:00-18:00)
    const pickupPlace = rec.request.legs[0]!.pickup.placeId
    const evTime = atMinute ?? rec.request.respondBy
    const { day, isWorkHours } = this.isWorkingHours(evTime)

    if (isWorkHours) {
      const tdKey = `${day}:${pickupPlace}`
      const td = this.townDayStreak.get(tdKey) ?? { streak: 0, wins: 0, total: 0 }
      td.total++
      if (won) {
        td.wins++
        td.streak++
      } else {
        td.streak = 0
      }
      this.townDayStreak.set(tdKey, td)

      // Outage detector: >= 4 consecutive wins in one town OR >= 80% win rate over >= 5 reqs during 08:00-18:00
      if (!this.activeOutage && (td.streak >= 4 || (td.total >= 5 && td.wins / td.total >= 0.8))) {
        this.activeOutage = { day, centerPlaceId: pickupPlace }
      }

      this.businessHourHistory.push({
        at: evTime,
        day,
        pickupPlace,
        dealerId: rec.request.dealerId,
        won,
        normMult,
      })
      // Keep sliding window of last 14 business-hour quotes on this day
      const sameDayBiz = this.businessHourHistory.filter((h) => h.day === day).slice(-14)
      if (sameDayBiz.length >= 10 && !this.activeOutage) {
        const winsInWin = sameDayBiz.filter((h) => h.won).length
        const distinctTowns = new Set(sameDayBiz.map((h) => h.pickupPlace)).size
        // Price-War detector: sudden collapse (<12% wins) across >= 3 towns while quoting normal prices
        if (winsInWin / sameDayBiz.length <= 0.12 && distinctTowns >= 3) {
          this.activePriceWarDay = day
        } else if (winsInWin / sameDayBiz.length >= 0.28 && this.activePriceWarDay === day) {
          this.activePriceWarDay = null
        }
      }
    }

    // Do not pollute baseline Bayesian posteriors with temporary outage/price-war distortion or congestion surge losses
    if (rec.wasOutageBoosted || rec.wasPriceWarDiscounted) return
    if (!won && rec.surgeApplied > 0.05) return

    // Bayesian gradient update: won -> evidence compPrice >= normMult; lost -> evidence compPrice < normMult
    const step = won ? 0.022 : -0.018

    // 1. World base drift (adaptive fast early convergence with level-8 lower bound preventing losing-margin spirals)
    this.worldObsCount++
    const worldGain = 1 / (2 + Math.min(25, this.worldObsCount * 0.35))
    const worldStep = won ? 0.045 : -0.04
    const worldFloor = this.config.level >= 8 ? (this.config.worldBaseMuFloor ?? 1.32) : 1.05
    this.worldBaseMu = Math.max(worldFloor, Math.min(1.85, this.worldBaseMu + worldStep * worldGain))

    // 2. Lane posterior update
    const lane = this.lanePosteriors.get(rec.laneKey) ?? { offset: 0, obs: 0 }
    lane.obs++
    const laneGain = 1 / (4 + lane.obs)
    lane.offset = Math.max(-0.25, Math.min(0.35, lane.offset + step * laneGain * 3.5))
    this.lanePosteriors.set(rec.laneKey, lane)

    // 3. Dealer posterior update
    dealer.obs++
    const dealerGain = 1 / (3 + dealer.obs)
    dealer.offset = Math.max(-0.25, Math.min(0.25, dealer.offset + step * dealerGain * 3.0))

    // 4. Day posterior update
    const dayStat = this.dayPosteriors.get(rec.day) ?? { offset: 0, obs: 0 }
    dayStat.obs++
    const dayGain = 1 / (5 + dayStat.obs)
    dayStat.offset = Math.max(-0.18, Math.min(0.2, dayStat.offset + step * dayGain * 2.5))
    this.dayPosteriors.set(rec.day, dayStat)
  }
}

export interface FeeScheduleParams {
  now: number
  order: Order
  referenceFeeCents: number
  carsInGig: number
  pickupDrivers: number
  deliveryDrivers: number
  isUrgent: boolean
  lastBookedFeeCents?: number
}

export interface DirectOfferContext {
  now: number
  gigId: string
  order: Order
  audience: Audience
  currentSchedule: FeeStep[]
  referenceFeeCents: number
  carsInGig: number
  isUrgent: boolean
  roster: DriverProfile[]
  placesById: Map<string, Place>
  driverLastDelivery: Map<string, { placeId: string; at: number }>
  gigViewers: Set<string>
  driversNearPickup: DriverProfile[]
  repositionedEnRoute: Set<string>
  offeredPairs: Set<string>
  driverOffersToday: Map<string, number>
  openOffersOnGig: number
}

export interface DirectOfferCandidate {
  driverId: string
  feeCents: number
  priority: number
  tier: "idle_at_pickup" | "viewer" | "local" | "en_route"
}

/**
 * (iii) Zero-Holdout Fee Schedule + Idle-First >1.02x Direct Offers
 */
export class ZeroHoldoutFeeScheduler {
  readonly config: Top10PricerConfig

  constructor(config: Partial<Top10PricerConfig> = {}) {
    this.config = { ...DEFAULT_TOP10_CONFIG, ...config }
  }

  /**
   * Generates a game-theoretic flat-opening fee schedule.
   * Anchors driver learning belief `bookedFee / firstViewedFee = 1.000` to prevent 19-hour holdout waits.
   */
  buildSchedule(params: FeeScheduleParams): FeeStep[] {
    const { now, order, referenceFeeCents, carsInGig, pickupDrivers, deliveryDrivers, isUrgent, lastBookedFeeCents } =
      params
    const baseRefFee = (referenceFeeCents * carsInGig) / Math.max(1, order.legs.length)

    if (this.config.level === 1) {
      return [{ at: now, feeCents: Math.max(100, Math.round(baseRefFee * 1.15)) }]
    }

    let scarcityAdd = 0
    if (this.config.level >= 7) {
      if (pickupDrivers <= 2) scarcityAdd += this.config.scarcityTownFeeBoost
      else if (pickupDrivers <= 4) scarcityAdd += this.config.scarcityTownFeeBoost * 0.45
      if (deliveryDrivers <= 1) scarcityAdd += 0.08
    }

    const slackToLastPickup = Math.max(0, order.lastPickupAt - now)

    // Urgent or Dropped-Gig Recovery: rapid 25-min step escalation starting 4.5h before lastPickupAt
    if (isUrgent || slackToLastPickup <= 4.5 * HOUR) {
      const startMult = Math.max(this.config.urgentFeeMultiplier, this.config.baseFeeMultiplier + scarcityAdd + 0.45)
      const peakMult = Math.max(startMult + 0.4, this.config.maxUrgentFeeMultiplier + scarcityAdd)
      const minDropFloor = lastBookedFeeCents ? Math.round(lastBookedFeeCents * 1.05) : 0

      return [0, 1, 2, 3, 4, 5].map((k) => {
        const frac = k / 5
        const mult = startMult + frac * (peakMult - startMult)
        return {
          at: now + k * 25,
          feeCents: Math.max(100, minDropFloor, Math.round(baseRefFee * mult)),
        }
      })
    }

    // Zero-holdout flat plateau (eliminates hourly tick holding behavior observed in r4_events)
    let openMult = this.config.baseFeeMultiplier + scarcityAdd
    let midMult = Math.max(openMult + 0.18, this.config.maxNormalFeeMultiplier * 0.92 + scarcityAdd)
    let normalPeak = Math.max(midMult + 0.15, this.config.maxNormalFeeMultiplier + scarcityAdd)
    let flatHoldMins = 300 // 5 hours flat plateau
    let peakOffsetMins = 480

    // Flexible high-slack orders in well-supplied towns: achieve €80-€88 booked fees without drops
    if (pickupDrivers >= 4) {
      if (slackToLastPickup >= 30 * HOUR) {
        openMult = 0.88 + scarcityAdd
        midMult = 1.05 + scarcityAdd
        normalPeak = 1.26 + scarcityAdd
        flatHoldMins = 360 // 6-hour flat anchor
        peakOffsetMins = 720
      } else if (slackToLastPickup >= 16 * HOUR) {
        openMult = 0.98 + scarcityAdd
        midMult = 1.16 + scarcityAdd
        normalPeak = 1.35 + scarcityAdd
        flatHoldMins = 240
        peakOffsetMins = 420
      }
    }

    const urgentPeak = Math.max(normalPeak + 0.35, this.config.maxUrgentFeeMultiplier + scarcityAdd)

    const rawSteps: FeeStep[] = [
      { at: now, feeCents: Math.max(100, Math.round(baseRefFee * openMult)) },
      { at: now + flatHoldMins, feeCents: Math.max(100, Math.round(baseRefFee * midMult)) },
      { at: now + peakOffsetMins, feeCents: Math.max(100, Math.round(baseRefFee * normalPeak)) },
    ]

    // Pre-deadline embedded safety ramp starting 5h40m (340m) before lastPickupAt to avoid 6-13m late misses
    const escalateStart = Math.max(now + 90, order.lastPickupAt - 340)
    for (let j = 1; j <= 4; j++) {
      const frac = j / 4
      const mult = normalPeak + frac * (urgentPeak - normalPeak)
      rawSteps.push({
        at: escalateStart + (j - 1) * 45,
        feeCents: Math.max(100, Math.round(baseRefFee * mult)),
      })
    }

    rawSteps.sort((a, b) => a.at - b.at)
    const schedule: FeeStep[] = []
    for (const s of rawSteps) {
      const prev = schedule[schedule.length - 1]
      if (!prev) {
        schedule.push(s)
      } else if (s.at === prev.at) {
        prev.feeCents = Math.max(prev.feeCents, s.feeCents)
      } else if (s.at > prev.at) {
        schedule.push({
          at: s.at,
          feeCents: Math.max(prev.feeCents, s.feeCents),
        })
      }
    }
    return schedule
  }

  /**
   * Selects direct offer targets prioritizing genuinely idle drivers who delivered near pickup
   * (especially drivers >30 km from home who receive NO app notifications), at strictly >1.02x board fee.
   */
  selectDirectOfferCandidates(ctx: DirectOfferContext): DirectOfferCandidate[] {
    if (this.config.level < 3) return []
    const minuteOfDay = ctx.now % DAY
    // Respect 23:00-07:00 driver sleep curfew (RULES.md: Direct offers)
    if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return []
    if (ctx.openOffersOnGig >= 3) return []

    const pickupPlaceId = ctx.order.legs[0]!.pickup.placeId
    const deliveryPlaceId = ctx.order.legs[ctx.order.legs.length - 1]!.delivery.placeId
    const pickupPlace = ctx.placesById.get(pickupPlaceId)
    const deliveryPlace = ctx.placesById.get(deliveryPlaceId)
    if (!pickupPlace) return []

    const day = Math.floor(ctx.now / DAY)
    const rosterMap = new Map(ctx.roster.map((d) => [d.id, d]))

    let currentBoardFee = ctx.currentSchedule[0]?.feeCents ?? 100
    for (const step of ctx.currentSchedule) {
      if (step.at <= ctx.now) currentBoardFee = step.feeCents
    }
    const minRef = Math.round((ctx.referenceFeeCents * ctx.carsInGig) / Math.max(1, ctx.order.legs.length))
    // Strictly > 1.02x current fee for non-urgent; 1.12x for urgent
    const offerMultiplier = ctx.isUrgent ? 1.12 : Math.max(1.025, this.config.directOfferMultiplier)
    const offerFeeCents = Math.max(100, minRef, Math.round(currentBoardFee * offerMultiplier))

    const seen = new Set<string>()
    const scored: DirectOfferCandidate[] = []

    const tryAdd = (driverId: string, tier: DirectOfferCandidate["tier"], basePriority: number) => {
      if (seen.has(driverId)) return
      seen.add(driverId)

      if (ctx.offeredPairs.has(`${ctx.gigId}:${driverId}`)) return
      if ((ctx.driverOffersToday.get(`${day}:${driverId}`) ?? 0) >= 3) return

      const profile = rosterMap.get(driverId)
      if (!profile) return
      if (ctx.audience.experienced && (profile.rating < 4.8 || profile.completedGigs < 50)) return
      if (ctx.audience.manualLicence && profile.licence !== "manual") return

      const homePlace = ctx.placesById.get(profile.homePlaceId)
      const homewardBonus = homePlace && deliveryPlace && haversineKm(homePlace, deliveryPlace) <= 40 ? 45 : 0
      const ratingBonus = profile.rating >= 4.8 ? 10 : 0

      scored.push({
        driverId,
        feeCents: offerFeeCents,
        priority: basePriority + homewardBonus + ratingBonus,
        tier,
      })
    }

    // Tier 1: Genuinely idle drivers who finished a delivery within 35 km today (last 12h)
    for (const [driverId, lastDeliv] of ctx.driverLastDelivery.entries()) {
      if (ctx.now - lastDeliv.at > 12 * HOUR) continue
      const lastPlace = ctx.placesById.get(lastDeliv.placeId)
      if (!lastPlace) continue
      const distKm = haversineKm(lastPlace, pickupPlace)
      if (distKm > 35) continue

      const profile = rosterMap.get(driverId)
      const homePlace = profile ? ctx.placesById.get(profile.homePlaceId) : undefined
      // Drivers >30 km from home never receive push notifications for this gig!
      const strandedAway = homePlace ? haversineKm(homePlace, pickupPlace) > 30 : false
      const tierScore = (strandedAway ? 300 : 200) - distKm
      tryAdd(driverId, "idle_at_pickup", tierScore)
    }

    // Tier 2: Active gig viewers
    for (const dId of ctx.gigViewers) {
      tryAdd(dId, "viewer", 120)
    }

    // Tier 3: Local drivers near pickup
    for (const d of ctx.driversNearPickup) {
      tryAdd(d.id, "local", 80)
    }

    // Tier 4: En-route repositioned drivers
    for (const dId of ctx.repositionedEnRoute) {
      tryAdd(dId, "en_route", 50)
    }

    scored.sort((a, b) => b.priority - a.priority)
    const slotsAvailable = Math.max(0, 3 - ctx.openOffersOnGig)
    return scored.slice(0, slotsAvailable)
  }
}
