import fs from "node:fs"
import path from "node:path"
import type {
  Action,
  ActionResult,
  Audience,
  DeskEvent,
  DeskSnapshot,
  FeeStep,
  Note,
  OpeningHours,
  Order,
  Place,
  PostAction,
  PriceRequest,
  StopRef,
} from "./spread.ts"
import { QuantitativeDesk, type ParsedNoteInfo } from "./bot.ts"
import { parseNoteFlagsV2 as parseNoteFlags, windowFromNoteV2 as windowFromNote, extractDailyHoursFromNote, clampPickupWindowForNow } from "./note-utils.ts"
import type { StrategyConfig } from "./strategy-config.ts"
import {
  buildSmoothFeeSchedule,
  evaluateQuoteWithUpgrades,
  hardenOutboxPostActions,
  resolveOrderActivePeakFee,
  shouldAllowSmartDirectOffer,
} from "./top10-upgrades.ts"

export const MINUTE = 1
export const HOUR = 60
export const DAY = 24 * HOUR

export interface StructuralPriors {
  updatedAt: string
  worldsAnalyzed: number
  laneQuoteBoostByKey: Record<string, number>
  dealerMuAdjustmentById: Record<string, number>
  clearingFeeRatioByHour: Record<string, number>
}

export function loadStructuralPriors(filePath = path.join(process.cwd(), "data", "structural-priors.json")): StructuralPriors | null {
  try {
    if (!fs.existsSync(filePath)) return null
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as StructuralPriors
  } catch {
    return null
  }
}


// =============================================================================

// 1. BAYESIAN COMPETITOR PRICER & ZERO-HOLDOUT FEE SCHEDULER

// =============================================================================

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
  useStructuralPriors?: boolean
  positivePriorsOnly?: boolean
  hybridMarginFilter?: boolean
  optionAwareFee?: boolean
  minAbsoluteMarginCents?: number
  congestedAbsoluteMarginCents?: number
  broadFeeTiers?: boolean
  hardenPostStops?: boolean
  repostNoFeeDrop?: boolean
  smoothFeeStaircase?: boolean
  softCapacitySurge?: boolean
  adverseSelectionGuard?: boolean
  smartDirectOffers?: boolean
  patientMorningHoldout?: boolean
  cleanAdverseGuard?: boolean
  balancedBayesianDrift?: boolean
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
  minQuoteMultiplier: 1.29,
  worldBaseMuFloor: 1.32,
  useStructuralPriors: false,
  positivePriorsOnly: false,
  hybridMarginFilter: false,
  optionAwareFee: false,
  minAbsoluteMarginCents: 1200,
  congestedAbsoluteMarginCents: 1550,
  broadFeeTiers: false,
  hardenPostStops: false,
  repostNoFeeDrop: false,
  smoothFeeStaircase: false,
  softCapacitySurge: false,
  adverseSelectionGuard: false,
  smartDirectOffers: false,
  patientMorningHoldout: false,
  cleanAdverseGuard: false,
  balancedBayesianDrift: false,
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
  private readonly structuralPriors: StructuralPriors | null

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
    this.structuralPriors = this.config.useStructuralPriors !== false ? loadStructuralPriors() : null
    if (this.structuralPriors) {
      for (const [laneKey, boost] of Object.entries(this.structuralPriors.laneQuoteBoostByKey ?? {})) {
        if (Number.isFinite(boost) && (!this.config.positivePriorsOnly || boost > 0)) {
          this.lanePosteriors.set(laneKey, { offset: boost, obs: 2 })
        }
      }
      for (const [dealerId, adj] of Object.entries(this.structuralPriors.dealerMuAdjustmentById ?? {})) {
        if (Number.isFinite(adj) && (!this.config.positivePriorsOnly || adj > 0)) {
          this.dealerStates.set(dealerId, { offset: adj, obs: 2, reqs: 0, wins: 0, trust: 0.5 })
        }
      }
    }

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
    if (!this.config.softCapacitySurge && !this.config.adverseSelectionGuard) {
      return this.evaluateQuoteCore(request, ctx)
    }
    const res = evaluateQuoteWithUpgrades(
      request,
      ctx,
      this.config,
      (a, b) => this.roadByPair.get(`${a}->${b}`)?.minutes ?? 180,
      (req, c) => this.evaluateQuoteCore(req, c),
    )
    if (res.action === "decline") {
      this.pendingQuotes.delete(request.id)
    } else {
      const rec = this.pendingQuotes.get(request.id)
      if (rec) {
        const updatedMults: Partial<Record<DeliveryOptionKind, number>> = {}
        for (const opt of request.options) {
          const p = res.prices[opt.kind]
          if (p !== undefined) {
            updatedMults[opt.kind] = p / Math.max(1, opt.listPriceCents)
          }
        }
        rec.quotedMultipliers = updatedMults
        rec.surgeApplied = res.surgeApplied
      }
    }
    return res
  }

  private evaluateQuoteCore(request: PriceRequest, ctx: PricingContext): QuoteDecision {
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
      const crisisSameDay =
        (!onTimeHealthy && ctx.liveOnTimeShare < this.config.targetOnTimeBuffer - 0.015) ||
        ctx.waitingCount >= maxWaitingAllowed ||
        (isShortageLevel && ctx.activeUnbookedUrgent >= Math.max(4, Math.round(ctx.totalDrivers * 0.16)))
      if (
        (isShortageLevel && effectivePickupSupply < 1.5 && slackBeforeDeadline < 360) ||
        slackBeforeDeadline < 240 ||
        (leg0.pickup.privateAddress && effectivePickupSupply < 2.5) ||
        ctx.noteFlags.hasTightDeadline ||
        (crisisSameDay && slackBeforeDeadline < 600)
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
    const highLoad =
      ctx.waitingCount >= maxWaitingAllowed * 0.75 ||
      !onTimeHealthy ||
      ctx.activeUnbookedUrgent >= 4
    let minRequiredPrice: number
    if (this.config.hybridMarginFilter !== false) {
      const absFloor = highLoad
        ? (this.config.congestedAbsoluteMarginCents ?? 1550)
        : (this.config.minAbsoluteMarginCents ?? 1200)
      const effRatio = highLoad
        ? Math.max(this.config.minExpectedMarginRatio, 0.21)
        : Math.min(this.config.minExpectedMarginRatio, 0.12)
      const ratioMargin = Math.round((expectedFeeCents * effRatio) / Math.max(0.4, 1 - effRatio))
      minRequiredPrice = expectedFeeCents + Math.max(absFloor, ratioMargin)
    } else {
      minRequiredPrice = expectedFeeCents / Math.max(0.5, 1 - this.config.minExpectedMarginRatio)
    }

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

      const minQuoteMult = this.config.level >= 8 ? (this.config.minQuoteMultiplier ?? 1.22) : 1.05
      targetMult = Math.max(targetMult, minQuoteMult)

      const optCostFactor = !this.config.optionAwareFee
        ? 1.0
        : opt.kind === "same_day"
          ? 1.12
          : opt.kind === "within_3_days" && ctx.pickupDrivers >= 4
            ? 0.91
            : 1.0
      const optMinRequired = Math.round(minRequiredPrice * optCostFactor)
      const rawPrice = opt.listPriceCents * targetMult
      // Reject individual option if below profitable break-even floor (tight 1.02x vs old 1.06x slack)
      if (rawPrice * 1.02 < optMinRequired) {
        continue
      }
      const finalPrice = Math.max(100, Math.round(Math.max(rawPrice, optMinRequired)))
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
    const step = this.config.balancedBayesianDrift ? (won ? 0.026 : -0.014) : (won ? 0.022 : -0.018)

    // 1. World base drift (adaptive fast early convergence with level-8 lower bound preventing losing-margin spirals)
    this.worldObsCount++
    const worldGain = 1 / (2 + Math.min(25, this.worldObsCount * 0.35))
    const worldStep = this.config.balancedBayesianDrift ? (won ? 0.052 : -0.028) : (won ? 0.045 : -0.04)
    const worldFloor = this.config.level >= 8 ? (this.config.worldBaseMuFloor ?? 1.20) : 1.05
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

  /** Replay a historical won order on WebSocket reconnect (--final). */
  observeHistoricalWin(request: PriceRequest, order: Order): void {
    const opt = request.options.find((o) => o.kind === order.option)
    if (!opt || opt.listPriceCents <= 0) return
    const mult = order.priceCents / opt.listPriceCents
    const trustFactor = this.config.level >= 8 ? 1 + 0.009 * Math.min(25, this.getDealer(order.dealerId).trust) : 1.0
    const normMult = mult / trustFactor - BayesianCompetitorPricer.OPTION_PRIOR[order.option]
    const dealer = this.getDealer(order.dealerId)
    dealer.reqs++
    dealer.wins++
    dealer.obs++
    const dealerGain = 1 / (3 + dealer.obs)
    dealer.offset = Math.max(-0.25, Math.min(0.25, dealer.offset + 0.022 * dealerGain * 3.0))
    const laneKey = `${request.legs[0]!.pickup.placeId}->${request.legs.at(-1)!.delivery.placeId}`
    const lane = this.lanePosteriors.get(laneKey) ?? { offset: 0, obs: 0 }
    lane.obs++
    const laneGain = 1 / (4 + lane.obs)
    lane.offset = Math.max(-0.25, Math.min(0.35, lane.offset + 0.022 * laneGain * 3.5))
    this.lanePosteriors.set(laneKey, lane)
    if (normMult >= (this.config.worldBaseMuFloor ?? 1.20)) {
      this.worldObsCount++
      const worldGain = 1 / (2 + Math.min(25, this.worldObsCount * 0.35))
      this.worldBaseMu = Math.min(1.85, this.worldBaseMu + 0.045 * worldGain)
    }
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
  private readonly structuralPriors: StructuralPriors | null

  constructor(config: Partial<Top10PricerConfig> = {}) {
    this.config = { ...DEFAULT_TOP10_CONFIG, ...config }
    this.structuralPriors = this.config.useStructuralPriors !== false ? loadStructuralPriors() : null
  }

  private addWakeMinutes(startAt: number, wakeMins: number): number {
    let t = startAt
    let rem = wakeMins
    while (rem > 0) {
      const mod = ((t % DAY) + DAY) % DAY
      if (mod >= 21 * HOUR) {
        t += DAY - mod + 8 * HOUR
        continue
      }
      if (mod < 8 * HOUR) {
        t += 8 * HOUR - mod
        continue
      }
      const step = Math.min(rem, 21 * HOUR - mod)
      t += step
      rem -= step
    }
    return t
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
    if (this.config.broadFeeTiers) {
      if (pickupDrivers >= 3) {
        if (slackToLastPickup >= 22 * HOUR) {
          openMult = 0.88 + scarcityAdd
          midMult = 1.04 + scarcityAdd
          normalPeak = 1.24 + scarcityAdd
          flatHoldMins = 360 // 6-hour flat anchor
          peakOffsetMins = 720
        } else if (slackToLastPickup >= 14 * HOUR) {
          openMult = 0.94 + scarcityAdd
          midMult = 1.12 + scarcityAdd
          normalPeak = 1.32 + scarcityAdd
          flatHoldMins = 240
          peakOffsetMins = 420
        }
      }
    } else if (pickupDrivers >= 4) {
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

    const pickupHour = String(Math.floor((now % DAY) / HOUR))
    const hrPrior = this.structuralPriors?.clearingFeeRatioByHour?.[pickupHour]
    if (hrPrior !== undefined && hrPrior >= 1.1 && !isUrgent) {
      openMult = Math.max(openMult, Math.min(1.12, hrPrior) + scarcityAdd * 0.5)
    }

    const urgentPeak = Math.max(normalPeak + 0.35, this.config.maxUrgentFeeMultiplier + scarcityAdd)

    if (this.config.patientMorningHoldout) {
      const pOpen =
        slackToLastPickup >= 28 * HOUR
          ? Math.min(openMult, 0.88 + scarcityAdd * 0.5)
          : slackToLastPickup >= 14 * HOUR
            ? Math.min(openMult, 0.93 + scarcityAdd * 0.5)
            : Math.min(openMult, 0.98 + scarcityAdd * 0.5)
      const pMid = pOpen + 0.08
      const pPeak = pOpen + 0.18
      const escalateStart = Math.max(now + 90, order.lastPickupAt - 340)
      const midAt = Math.min(escalateStart - 60, this.addWakeMinutes(now, 360))
      const peakAt = Math.min(escalateStart - 30, Math.max(midAt + 180, order.lastPickupAt - 540))
      const rawPatient: FeeStep[] = [
        { at: now, feeCents: Math.max(100, Math.round(baseRefFee * pOpen)) },
        { at: Math.max(now + 60, midAt), feeCents: Math.max(100, Math.round(baseRefFee * pMid)) },
        { at: Math.max(now + 120, peakAt), feeCents: Math.max(100, Math.round(baseRefFee * pPeak)) },
      ]
      for (let j = 1; j <= 4; j++) {
        const frac = j / 4
        const mult = pPeak + frac * (urgentPeak - pPeak)
        rawPatient.push({
          at: escalateStart + (j - 1) * 45,
          feeCents: Math.max(100, Math.round(baseRefFee * mult)),
        })
      }
      rawPatient.sort((a, b) => a.at - b.at)
      const sched: FeeStep[] = []
      for (const s of rawPatient) {
        const prev = sched[sched.length - 1]
        if (!prev) sched.push(s)
        else if (s.at === prev.at) prev.feeCents = Math.max(prev.feeCents, s.feeCents)
        else if (s.at > prev.at) sched.push({ at: s.at, feeCents: Math.max(prev.feeCents, s.feeCents) })
      }
      return sched
    }

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

// =============================================================================

// 2. MULTI-CAR ROUTE CHAINING & CONSOLIDATION DESK

// =============================================================================

export interface ChainingConfig {
  enabled: boolean
  maxOrdersPerChain: 2 | 3
  maxGapMinutes: number // max empty-mile drive between car i delivery and car i+1 pickup (default 45)
  maxTotalDriveMinutes: number // RULES.md:68 hard cap is 720 (12h)
  minOrderSlackMinutes: number // min time before lastPickupAt to enter a chain (default 10h)
  bookingBufferMinutes: number // ensure gig stays feasible even if booked up to N mins later (default 120)
  consolidationIntervalMinutes: number // periodic sweep cadence (default 45)
  openFeeMinMult: number // opening fee floor fraction of combined refFee (default 0.78)
  openFeeMaxMult: number // opening fee ceiling fraction of combined refFee for normal towns (default 0.85)
  quoteSynergyEnabled: boolean // discount expectedFeeCents in quote() when partner order exists
  allowChainedCapacityBypass: boolean // allow pairing even when town/waiting cap is near threshold
  scarcityGated?: boolean // dynamically pause new chaining when OT or drop-rate degrades
  maxChainStartDay?: number // optional day index cutoff (e.g. 4 = Mon..Thu) for starting new chains
}

export const DEFAULT_CHAINING_CONFIG: ChainingConfig = {
  enabled: true,
  maxOrdersPerChain: 3,
  maxGapMinutes: 45,
  maxTotalDriveMinutes: 720,
  minOrderSlackMinutes: 10 * HOUR,
  bookingBufferMinutes: 120,
  consolidationIntervalMinutes: 45,
  openFeeMinMult: 0.78,
  openFeeMaxMult: 0.85,
  quoteSynergyEnabled: true,
  allowChainedCapacityBypass: true,
  scarcityGated: true,
}

export type RoadMinutesFn = (fromPlaceId: string, toPlaceId: string) => number
export type LocalDriversFn = (placeId: string) => number

export interface ChainOrderContext {
  order: Order
  request: PriceRequest
  noteFlags: ParsedNoteInfo
  pickupWin: TimeWindow
  deliveryWin: TimeWindow
  pickupDailyCloseMin?: number
  deliveryDailyCloseMin?: number
  plates: boolean
  charging: boolean
  pickupOverheadMinutes: number
}

export interface ChainDriveStats {
  totalDriveMinutes: number
  loadedDriveMinutes: number
  totalGapMinutes: number
  maxGapMinutes: number
  gaps: number[]
}

export interface ChainEvaluation {
  feasible: boolean
  reason?: string
  contexts: ChainOrderContext[]
  stats: ChainDriveStats
  earliestStartAt: number
  earliestFinishAt: number
  minSlackMinutes: number
  estimatedSavingsCents: number
  score: number
}

export interface ChainPlan {
  contexts: ChainOrderContext[]
  evaluation: ChainEvaluation
  replacesGigIds: string[]
}

export interface QuoteSynergyResult {
  matched: boolean
  partnerOrderIds: string[]
  gapMinutes: number
  totalDriveMinutes: number
  feeDiscountFactor: number // e.g. 0.78 .. 0.85 applied to expectedFeeCents
  partnerSavingsCents: number
  bestOptionKind?: "same_day" | "next_day" | "within_3_days"
}

export interface RetryMeta {
  pickupFrom: number
  manualLicence: boolean
  plates: boolean
}

export function extractDailyCloseMin(
  noted: TimeWindow,
  base: TimeWindow,
  orderDeadline: number,
): number | undefined {
  if (noted.to < base.to && noted.to < orderDeadline) {
    const tod = noted.to % DAY
    if (tod >= 7 * HOUR && tod < 20 * HOUR) {
      return tod
    }
  }
  return undefined
}

export function buildChainOrderContext(
  order: Order,
  request: PriceRequest,
  noteNLP: boolean,
  retry: RetryMeta = { pickupFrom: 0, manualLicence: false, plates: false },
  routeKm?: number,
): ChainOrderContext | null {
  if (order.legs.length !== 1 || order.status === "cancelled" || order.deliveredAt[0] !== null) {
    return null
  }
  const leg = order.legs[0]!
  if (leg.pickup.privateAddress || leg.delivery.privateAddress) {
    return null
  }
  const note = noteNLP ? request.note : null
  const noteFlags = parseNoteFlags(request.note, noteNLP)
  const notedPickup = windowFromNote(note, leg.pickup.window, "pickup", request.arrivedAt)
  const start = Math.round(Math.max(notedPickup.from, retry.pickupFrom, leg.pickup.window.from))
  const pickupWin: TimeWindow = {
    from: start,
    to: Math.max(start, Math.round(notedPickup.to)),
  }
  const deliveryBase: TimeWindow = {
    from: leg.delivery.window.from,
    to: Math.max(leg.delivery.window.from, order.deadline),
  }
  const notedDelivery = windowFromNote(note, deliveryBase, "delivery", request.arrivedAt)
  const deliveryWin: TimeWindow = {
    from: Math.round(notedDelivery.from),
    to: Math.min(order.deadline, Math.round(notedDelivery.to)),
  }
  if (pickupWin.to < pickupWin.from || deliveryWin.to < deliveryWin.from) {
    return null
  }

  const plates = retry.plates || noteFlags.withPlates
  const charging = Boolean(
    leg.car.electric &&
      leg.car.chargePercent !== null &&
      leg.car.chargePercent < 30 &&
      (routeKm === undefined || routeKm > 200),
  )
  const pickupOverheadMinutes = (plates ? 30 : 0) + (charging ? 40 : 0)

  return {
    order,
    request,
    noteFlags: {
      ...noteFlags,
      manualLicence: retry.manualLicence || noteFlags.manualLicence,
      withPlates: plates,
    },
    pickupWin,
    deliveryWin,
    pickupDailyCloseMin: extractDailyCloseMin(notedPickup, leg.pickup.window, order.deadline),
    deliveryDailyCloseMin: extractDailyCloseMin(notedDelivery, deliveryBase, order.deadline),
    plates,
    charging,
    pickupOverheadMinutes,
  }
}

export function isSiteOpenAt(
  minute: number,
  hours: OpeningHours | null,
  closingBufferMin = 15,
  extraDailyCloseMin?: number,
): boolean {
  const dayIndex = Math.floor(minute / DAY)
  const dow = ((dayIndex % 7) + 7) % 7 // 0=Mon .. 4=Fri, 5=Sat, 6=Sun
  const tod = ((minute % DAY) + DAY) % DAY

  if (dow === 6) return false // Sunday: every dealer site closed

  if (!hours) {
    if (extraDailyCloseMin !== undefined && tod > extraDailyCloseMin - closingBufferMin) return false
    return true
  }

  if (dow === 5) {
    if (!hours.saturday) return false
    const effectiveClose =
      extraDailyCloseMin !== undefined ? Math.min(hours.saturday.closes, extraDailyCloseMin) : hours.saturday.closes
    return tod >= hours.saturday.opens && tod <= effectiveClose - closingBufferMin
  }

  if (!hours.weekdays.includes(dow)) return false
  const effectiveClose = extraDailyCloseMin !== undefined ? Math.min(hours.closes, extraDailyCloseMin) : hours.closes
  return tod >= hours.opens && tod <= effectiveClose - closingBufferMin
}

export function nextSiteOpenAt(
  minute: number,
  hours: OpeningHours | null,
  closingBufferMin = 15,
  extraDailyCloseMin?: number,
): number {
  let cursor = Math.round(minute)
  if (!hours && extraDailyCloseMin === undefined) {
    // Still avoid Sunday for dealer sites
    for (let d = 0; d < 8; d++) {
      const dow = Math.floor(cursor / DAY) % 7
      if (dow !== 6) return cursor
      cursor = (Math.floor(cursor / DAY) + 1) * DAY + 8 * HOUR
    }
    return Infinity
  }

  for (let d = 0; d < 9; d++) {
    const dayStart = Math.floor(cursor / DAY) * DAY
    const dow = Math.floor(cursor / DAY) % 7
    const tod = cursor - dayStart

    if (dow === 6) {
      cursor = dayStart + DAY
      continue
    }

    let opens = 0
    let closes = 24 * HOUR
    let openDay = true

    if (hours) {
      if (dow === 5) {
        if (!hours.saturday) {
          openDay = false
        } else {
          opens = hours.saturday.opens
          closes = hours.saturday.closes
        }
      } else {
        if (!hours.weekdays.includes(dow)) {
          openDay = false
        } else {
          opens = hours.opens
          closes = hours.closes
        }
      }
    }

    if (!openDay) {
      cursor = dayStart + DAY
      continue
    }

    const effectiveClose = extraDailyCloseMin !== undefined ? Math.min(closes, extraDailyCloseMin) : closes
    if (effectiveClose - closingBufferMin <= opens) {
      cursor = dayStart + DAY
      continue
    }

    if (tod < opens) {
      return dayStart + opens
    }
    if (tod <= effectiveClose - closingBufferMin) {
      return cursor
    }
    cursor = dayStart + DAY
  }

  return Infinity
}

export function safeRoadMinutes(roadMinutesFn: RoadMinutesFn, fromPlace: string, toPlace: string): number {
  if (fromPlace === toPlace) return 0
  return roadMinutesFn(fromPlace, toPlace)
}

export function computeChainDriveStats(contexts: ChainOrderContext[], roadMinutesFn: RoadMinutesFn): ChainDriveStats {
  let loadedDriveMinutes = 0
  let totalGapMinutes = 0
  let maxGapMinutes = 0
  const gaps: number[] = []

  for (let i = 0; i < contexts.length; i++) {
    const leg = contexts[i]!.order.legs[0]!
    loadedDriveMinutes += safeRoadMinutes(roadMinutesFn, leg.pickup.placeId, leg.delivery.placeId)
    if (i + 1 < contexts.length) {
      const nextLeg = contexts[i + 1]!.order.legs[0]!
      const gap = safeRoadMinutes(roadMinutesFn, leg.delivery.placeId, nextLeg.pickup.placeId)
      gaps.push(gap)
      totalGapMinutes += gap
      if (gap > maxGapMinutes) maxGapMinutes = gap
    }
  }

  return {
    totalDriveMinutes: loadedDriveMinutes + totalGapMinutes,
    loadedDriveMinutes,
    totalGapMinutes,
    maxGapMinutes,
    gaps,
  }
}

function simulateTimelineFrom(
  contexts: ChainOrderContext[],
  startAt: number,
  roadMinutesFn: RoadMinutesFn,
): { ok: boolean; reason?: string; finishAt: number; minSlack: number } {
  let t = startAt
  let minSlack = Infinity

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i]!
    const leg = ctx.order.legs[0]!

    if (i > 0) {
      const prevLeg = contexts[i - 1]!.order.legs[0]!
      t += safeRoadMinutes(roadMinutesFn, prevLeg.delivery.placeId, leg.pickup.placeId)
    }

    if (t < ctx.pickupWin.from) {
      t = ctx.pickupWin.from
    }

    // Driver leaves / arrives only when pickup site is open (RULES.md:73)
    const openPickupT = nextSiteOpenAt(t, leg.pickup.hours, 15, ctx.pickupDailyCloseMin)
    if (!Number.isFinite(openPickupT)) {
      return { ok: false, reason: `pickup ${ctx.order.id} never opens`, finishAt: Infinity, minSlack: -1 }
    }
    t = openPickupT

    if (t > ctx.pickupWin.to - 15) {
      return {
        ok: false,
        reason: `pickup ${ctx.order.id} misses window (${t} > ${ctx.pickupWin.to - 15})`,
        finishAt: Infinity,
        minSlack: -1,
      }
    }
    const pickupDeadlineMargin = ctx.order.lastPickupAt - t
    if (pickupDeadlineMargin < 60) {
      return {
        ok: false,
        reason: `pickup ${ctx.order.id} too close to lastPickupAt (${pickupDeadlineMargin}m)`,
        finishAt: Infinity,
        minSlack: -1,
      }
    }

    // Add plates (30m) + charging (40m) stop overhead
    t += ctx.pickupOverheadMinutes

    // Drive loaded leg
    t += safeRoadMinutes(roadMinutesFn, leg.pickup.placeId, leg.delivery.placeId)

    // Delivery arrival check: if site is closed, delivery counts at next opening (RULES.md:124)
    let effectiveDelivAt = t
    if (!isSiteOpenAt(t, leg.delivery.hours, 10, ctx.deliveryDailyCloseMin)) {
      // If note specifically closed delivery site earlier than stated hours, driver waits up to 2h at €15/h — avoid!
      if (ctx.deliveryDailyCloseMin !== undefined) {
        return {
          ok: false,
          reason: `delivery ${ctx.order.id} hits note closing time at ${t}`,
          finishAt: Infinity,
          minSlack: -1,
        }
      }
      effectiveDelivAt = nextSiteOpenAt(t, leg.delivery.hours, 10)
      if (effectiveDelivAt - t > 45) {
        return {
          ok: false,
          reason: `delivery ${ctx.order.id} waits ${effectiveDelivAt - t}m at closed site`,
          finishAt: Infinity,
          minSlack: -1,
        }
      }
    }
    t = Math.max(t, effectiveDelivAt)

    const delivMargin = Math.min(ctx.deliveryWin.to, ctx.order.deadline) - effectiveDelivAt
    if (delivMargin < 30) {
      return {
        ok: false,
        reason: `delivery ${ctx.order.id} misses deadline/window (margin ${delivMargin}m)`,
        finishAt: Infinity,
        minSlack: -1,
      }
    }

    minSlack = Math.min(minSlack, pickupDeadlineMargin, delivMargin)
  }

  return { ok: true, finishAt: t, minSlack }
}

export function evaluateChainSequence(
  contexts: ChainOrderContext[],
  now: number,
  roadMinutesFn: RoadMinutesFn,
  config: ChainingConfig = DEFAULT_CHAINING_CONFIG,
  snowChecker?: (placeId: string, atMinute: number) => boolean,
): ChainEvaluation {
  const reject = (reason: string): ChainEvaluation => ({
    feasible: false,
    reason,
    contexts,
    stats: {
      totalDriveMinutes: Infinity,
      loadedDriveMinutes: Infinity,
      totalGapMinutes: Infinity,
      maxGapMinutes: Infinity,
      gaps: [],
    },
    earliestStartAt: Infinity,
    earliestFinishAt: Infinity,
    minSlackMinutes: -Infinity,
    estimatedSavingsCents: 0,
    score: -Infinity,
  })

  if (contexts.length < 2 || contexts.length > config.maxOrdersPerChain) {
    return reject("invalid chain length")
  }

  const seenIds = new Set<string>()
  for (const ctx of contexts) {
    if (seenIds.has(ctx.order.id)) return reject("duplicate order")
    seenIds.add(ctx.order.id)
    if (ctx.order.legs.length !== 1 || ctx.order.status === "cancelled" || ctx.order.deliveredAt[0] !== null) {
      return reject("order ineligible")
    }
    if (ctx.order.lastPickupAt - now < config.minOrderSlackMinutes) {
      return reject(`insufficient slack on ${ctx.order.id}`)
    }
    if (ctx.noteFlags.hasTightDeadline) {
      return reject(`tight deadline note on ${ctx.order.id}`)
    }
    const leg = ctx.order.legs[0]!
    if (leg.pickup.privateAddress || leg.delivery.privateAddress) {
      return reject(`private address on ${ctx.order.id}`)
    }
    if (ctx.noteFlags.summerTyres && snowChecker) {
      if (snowChecker(leg.pickup.placeId, now) || snowChecker(leg.delivery.placeId, now)) {
        return reject(`summer tyres snow risk on ${ctx.order.id}`)
      }
    }
  }

  const stats = computeChainDriveStats(contexts, roadMinutesFn)
  if (stats.maxGapMinutes > config.maxGapMinutes) {
    return reject(`gap ${stats.maxGapMinutes}m > ${config.maxGapMinutes}m`)
  }
  if (stats.totalDriveMinutes > config.maxTotalDriveMinutes) {
    return reject(`total drive ${stats.totalDriveMinutes}m > ${config.maxTotalDriveMinutes}m`)
  }

  // Dual-horizon simulation: asap driver start + delayed booking buffer
  const firstLeg = contexts[0]!.order.legs[0]!
  const earliestOpen = nextSiteOpenAt(
    Math.max(now + 45, contexts[0]!.pickupWin.from),
    firstLeg.pickup.hours,
    15,
    contexts[0]!.pickupDailyCloseMin,
  )
  if (!Number.isFinite(earliestOpen)) {
    return reject("first pickup never opens")
  }

  const asapSim = simulateTimelineFrom(contexts, earliestOpen, roadMinutesFn)
  if (!asapSim.ok) {
    return reject(asapSim.reason ?? "asap timeline infeasible")
  }

  const delayedSim = simulateTimelineFrom(contexts, earliestOpen + config.bookingBufferMinutes, roadMinutesFn)
  if (!delayedSim.ok) {
    return reject(`booking buffer failed: ${delayedSim.reason ?? "infeasible"}`)
  }

  const combinedRef = contexts.reduce((s, c) => s + c.request.referenceFeeCents, 0)
  const expectedSoloFee = combinedRef * 1.05
  const avgGap = stats.totalGapMinutes / Math.max(1, contexts.length - 1)
  const baseFrac =
    contexts.length === 3
      ? config.openFeeMinMult + 0.04 * (avgGap / Math.max(1, config.maxGapMinutes))
      : config.openFeeMinMult + 0.02 + 0.05 * (avgGap / Math.max(1, config.maxGapMinutes))
  const estimatedChainFee = combinedRef * Math.min(config.openFeeMaxMult, baseFrac)
  const estimatedSavingsCents = Math.max(0, Math.round(expectedSoloFee - estimatedChainFee))

  // Prefer high euro savings, zero/minimal empty-mile gaps, 3-car density, and healthy slack
  const zeroGapBonus = stats.gaps.filter((g) => g === 0).length * 450
  const lengthBonus = contexts.length === 3 ? 600 : 0
  const gapPenalty = stats.totalGapMinutes * 18
  const slackBonus = Math.min(800, delayedSim.minSlack * 0.4)
  const score = estimatedSavingsCents + zeroGapBonus + lengthBonus - gapPenalty + slackBonus

  return {
    feasible: true,
    contexts,
    stats,
    earliestStartAt: earliestOpen,
    earliestFinishAt: asapSim.finishAt,
    minSlackMinutes: delayedSim.minSlack,
    estimatedSavingsCents,
    score,
  }
}

export function chainedFeesFor(
  contexts: ChainOrderContext[],
  stats: ChainDriveStats,
  now: number,
  strategy: StrategyConfig,
  localDriverCountFn: LocalDriversFn,
  config: ChainingConfig = DEFAULT_CHAINING_CONFIG,
): FeeStep[] {
  const combinedRef = contexts.reduce((s, c) => s + c.request.referenceFeeCents, 0)
  const minLastPickup = Math.min(...contexts.map((c) => c.order.lastPickupAt))
  const avgGap = stats.totalGapMinutes / Math.max(1, contexts.length - 1)
  const gapRatio = Math.min(1, avgGap / Math.max(1, config.maxGapMinutes))

  // Target opening multiplier strictly in [0.78, 0.85] on normal corridors
  const rawOpen =
    contexts.length >= 3
      ? config.openFeeMinMult + 0.04 * gapRatio
      : config.openFeeMinMult + 0.02 + 0.05 * gapRatio
  let openMult = Math.min(config.openFeeMaxMult, Math.max(config.openFeeMinMult, rawOpen))

  // Minor scarcity cushion for very scarce endpoints so the gig still books reliably
  const firstPickup = contexts[0]!.order.legs[0]!.pickup.placeId
  const lastDelivery = contexts[contexts.length - 1]!.order.legs[0]!.delivery.placeId
  const pickupDrivers = localDriverCountFn(firstPickup)
  const deliveryDrivers = localDriverCountFn(lastDelivery)
  let scarcityAdd = 0
  if (pickupDrivers <= 1) scarcityAdd += 0.04
  else if (pickupDrivers <= 2) scarcityAdd += 0.02
  if (deliveryDrivers <= 1) scarcityAdd += 0.03

  openMult = Math.min(0.89, openMult + scarcityAdd)
  const midMult = Math.max(openMult + 0.13, 0.96 + scarcityAdd)
  const peakMult = Math.max(midMult + 0.14, 1.12 + scarcityAdd)
  const urgentPeak = Math.max(peakMult + 0.25, Math.min(1.65, strategy.maxNormalFeeMultiplier * 1.15 + scarcityAdd))

  const openFee = Math.max(100, Math.round(combinedRef * openMult))
  const midFee = Math.max(openFee, Math.round(combinedRef * midMult))
  const peakFee = Math.max(midFee, Math.round(combinedRef * peakMult))

  const rawSteps: FeeStep[] = [
    { at: Math.round(now), feeCents: openFee },
    { at: Math.round(now + 240), feeCents: midFee },
    { at: Math.round(now + 420), feeCents: peakFee },
  ]

  // Pre-deadline safety escalation starting 5h40m before minLastPickup to avoid 6-13m near-miss late refunds
  const escalateStart = Math.max(Math.round(now + 60), Math.round(minLastPickup - 340))
  for (let j = 1; j <= 4; j++) {
    const frac = j / 4
    const fee = Math.round(combinedRef * (peakMult + frac * (urgentPeak - peakMult)))
    rawSteps.push({
      at: escalateStart + (j - 1) * 45,
      feeCents: Math.max(peakFee, fee),
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
      schedule.push({ at: s.at, feeCents: Math.max(prev.feeCents, s.feeCents) })
    }
  }
  return schedule
}

export function buildStopsForOrders(
  contexts: ChainOrderContext[],
  now: number,
  noteNLP: boolean,
): StopRef[] {
  const stops: StopRef[] = []
  for (const ctx of contexts) {
    const leg = ctx.order.legs[0]!
    const pickupBase = leg.pickup.window
    const delivBase = { from: leg.delivery.window.from, to: Math.max(leg.delivery.window.from, ctx.order.deadline) }

    const first: StopRef = {
      orderId: ctx.order.id,
      leg: 0,
      kind: "pickup",
      withPlates: ctx.plates,
      withCharging: ctx.charging,
    }
    const second: StopRef = {
      orderId: ctx.order.id,
      leg: 0,
      kind: "delivery",
    }
    const pStop =
      ctx.pickupWin.from > pickupBase.from || ctx.pickupWin.to < pickupBase.to
        ? { ...first, window: ctx.pickupWin }
        : first
    const dStop =
      ctx.deliveryWin.from > delivBase.from || ctx.deliveryWin.to < delivBase.to
        ? { ...second, window: ctx.deliveryWin }
        : second

    for (const s of [pStop, dStop]) {
      stops.push(s.window && s.window.to < now + 15 ? { ...s, window: undefined } : s)
    }
  }
  void noteNLP
  return stops
}

export function buildChainedAudience(contexts: ChainOrderContext[]): Audience {
  return {
    experienced: contexts.some((c) => c.order.legs[0]!.car.premium),
    manualLicence: contexts.some((c) => c.noteFlags.manualLicence),
  }
}

export function canonicalComboKey(orderIds: string[]): string {
  return [...orderIds].sort().join("|")
}

export function findBestChainPlans(
  openSingleGigs: { gigId: string; ctx: ChainOrderContext }[],
  openMultiGigs: { gigId: string; contexts: ChainOrderContext[]; evalStats: ChainDriveStats }[],
  now: number,
  roadMinutesFn: RoadMinutesFn,
  config: ChainingConfig,
  rejectedCombos: Set<string>,
  snowChecker?: (placeId: string, atMinute: number) => boolean,
): ChainPlan[] {
  const candidates: ChainPlan[] = []

  // 1. Extend existing 2-car open gigs to 3-car chains when a compatible 3rd order exists
  if (config.maxOrdersPerChain >= 3) {
    for (const multi of openMultiGigs) {
      if (multi.contexts.length !== 2) continue
      const [cA, cB] = multi.contexts
      for (const single of openSingleGigs) {
        const cC = single.ctx
        const comboKey = canonicalComboKey([cA!.order.id, cB!.order.id, cC.order.id])
        if (rejectedCombos.has(comboKey)) continue

        const perms: ChainOrderContext[][] = [
          [cA!, cB!, cC],
          [cA!, cC, cB!],
          [cC, cA!, cB!],
          [cB!, cA!, cC],
          [cB!, cC, cA!],
          [cC, cB!, cA!],
        ]
        let bestEval: ChainEvaluation | null = null
        for (const perm of perms) {
          const ev = evaluateChainSequence(perm, now, roadMinutesFn, config, snowChecker)
          if (ev.feasible && (!bestEval || ev.score > bestEval.score)) {
            bestEval = ev
          }
        }
        if (bestEval) {
          candidates.push({
            contexts: bestEval.contexts,
            evaluation: bestEval,
            replacesGigIds: [multi.gigId, single.gigId],
          })
        }
      }
    }
  }

  // 2. Pairwise 2-car chains among open single-car gigs
  const n = openSingleGigs.length
  const feasiblePairs: { i: number; j: number; ev: ChainEvaluation }[] = []

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = openSingleGigs[i]!
      const b = openSingleGigs[j]!
      const comboKey = canonicalComboKey([a.ctx.order.id, b.ctx.order.id])
      if (rejectedCombos.has(comboKey)) continue

      const evAB = evaluateChainSequence([a.ctx, b.ctx], now, roadMinutesFn, config, snowChecker)
      const evBA = evaluateChainSequence([b.ctx, a.ctx], now, roadMinutesFn, config, snowChecker)
      const best =
        evAB.feasible && (!evBA.feasible || evAB.score >= evBA.score)
          ? evAB
          : evBA.feasible
            ? evBA
            : null

      if (best) {
        feasiblePairs.push({ i, j, ev: best })
        candidates.push({
          contexts: best.contexts,
          evaluation: best,
          replacesGigIds: [a.gigId, b.gigId],
        })
      }
    }
  }

  // 3. Direct 3-car chains from open single-car gigs (only combine pairs that share an endpoint)
  if (config.maxOrdersPerChain >= 3 && feasiblePairs.length >= 2) {
    const adj = new Map<number, Set<number>>()
    for (const p of feasiblePairs) {
      if (!adj.has(p.i)) adj.set(p.i, new Set())
      if (!adj.has(p.j)) adj.set(p.j, new Set())
      adj.get(p.i)!.add(p.j)
      adj.get(p.j)!.add(p.i)
    }

    const triedTriples = new Set<string>()
    for (const p of feasiblePairs) {
      const neighbors = new Set<number>([...(adj.get(p.i) ?? []), ...(adj.get(p.j) ?? [])])
      for (const k of neighbors) {
        if (k === p.i || k === p.j) continue
        const indices = [p.i, p.j, k].sort((x, y) => x - y)
        const idxKey = indices.join(",")
        if (triedTriples.has(idxKey)) continue
        triedTriples.add(idxKey)

        const c1 = openSingleGigs[indices[0]!]!
        const c2 = openSingleGigs[indices[1]!]!
        const c3 = openSingleGigs[indices[2]!]!
        const comboKey = canonicalComboKey([c1.ctx.order.id, c2.ctx.order.id, c3.ctx.order.id])
        if (rejectedCombos.has(comboKey)) continue

        const perms: ChainOrderContext[][] = [
          [c1.ctx, c2.ctx, c3.ctx],
          [c1.ctx, c3.ctx, c2.ctx],
          [c2.ctx, c1.ctx, c3.ctx],
          [c2.ctx, c3.ctx, c1.ctx],
          [c3.ctx, c1.ctx, c2.ctx],
          [c3.ctx, c2.ctx, c1.ctx],
        ]
        let bestEval: ChainEvaluation | null = null
        for (const perm of perms) {
          const ev = evaluateChainSequence(perm, now, roadMinutesFn, config, snowChecker)
          if (ev.feasible && (!bestEval || ev.score > bestEval.score)) {
            bestEval = ev
          }
        }
        if (bestEval) {
          candidates.push({
            contexts: bestEval.contexts,
            evaluation: bestEval,
            replacesGigIds: [c1.gigId, c2.gigId, c3.gigId],
          })
        }
      }
    }
  }

  // Greedily pick non-overlapping chains by highest score (prioritizing 3-car & zero-gap savings)
  candidates.sort((a, b) => b.evaluation.score - a.evaluation.score)
  const usedOrderIds = new Set<string>()
  const usedGigIds = new Set<string>()
  const selected: ChainPlan[] = []

  for (const plan of candidates) {
    const orderIds = plan.contexts.map((c) => c.order.id)
    if (orderIds.some((id) => usedOrderIds.has(id))) continue
    if (plan.replacesGigIds.some((gid) => gid && usedGigIds.has(gid))) continue

    for (const id of orderIds) usedOrderIds.add(id)
    for (const gid of plan.replacesGigIds) {
      if (gid) usedGigIds.add(gid)
    }
    selected.push(plan)
  }

  return selected
}

export function findQuoteChainSynergy(
  request: PriceRequest,
  openEligibleContexts: ChainOrderContext[],
  now: number,
  roadMinutesFn: RoadMinutesFn,
  noteNLP: boolean,
  config: ChainingConfig = DEFAULT_CHAINING_CONFIG,
  snowChecker?: (placeId: string, atMinute: number) => boolean,
): QuoteSynergyResult {
  const noMatch: QuoteSynergyResult = {
    matched: false,
    partnerOrderIds: [],
    gapMinutes: Infinity,
    totalDriveMinutes: Infinity,
    feeDiscountFactor: 1.0,
    partnerSavingsCents: 0,
  }

  if (!config.quoteSynergyEnabled || request.legs.length !== 1 || openEligibleContexts.length === 0) {
    return noMatch
  }
  const leg = request.legs[0]!
  if (leg.pickup.privateAddress || leg.delivery.privateAddress) {
    return noMatch
  }
  const flags = parseNoteFlags(request.note, noteNLP)
  if (flags.hasTightDeadline) {
    return noMatch
  }

  // Evaluate flexible options first (or longest deadline option)
  const sortedOptions = [...request.options].sort((a, b) => b.deadline - a.deadline)
  let bestResult: QuoteSynergyResult = noMatch
  let bestScore = -Infinity

  for (const opt of sortedOptions) {
    const estLastPickup = opt.deadline - safeRoadMinutes(roadMinutesFn, leg.pickup.placeId, leg.delivery.placeId) - 180
    if (estLastPickup - now < config.minOrderSlackMinutes) continue

    const syntheticOrder: Order = {
      id: `SYNTH_${request.id}`,
      dealerId: request.dealerId,
      option: opt.kind,
      priceCents: opt.listPriceCents,
      deadline: opt.deadline,
      legs: request.legs,
      status: "waiting",
      deliveredAt: [null],
      lastPickupAt: estLastPickup,
    }
    const reqCtx = buildChainOrderContext(syntheticOrder, request, noteNLP)
    if (!reqCtx) continue

    for (const partner of openEligibleContexts) {
      const evAB = evaluateChainSequence([partner, reqCtx], now, roadMinutesFn, config, snowChecker)
      const evBA = evaluateChainSequence([reqCtx, partner], now, roadMinutesFn, config, snowChecker)
      const bestEv =
        evAB.feasible && (!evBA.feasible || evAB.score >= evBA.score)
          ? evAB
          : evBA.feasible
            ? evBA
            : null

      if (!bestEv) continue

      const gap = bestEv.stats.maxGapMinutes
      const gapFrac = Math.min(1, gap / Math.max(1, config.maxGapMinutes))
      // Chained gig opens around 0.78–0.85 * sum(refFee) -> ~15–22% direct cost reduction
      const discountFactor = 0.78 + 0.06 * gapFrac
      const partnerSavings = Math.round(partner.request.referenceFeeCents * (1 - discountFactor))
      if (bestEv.score > bestScore) {
        bestScore = bestEv.score
        bestResult = {
          matched: true,
          partnerOrderIds: [partner.order.id],
          gapMinutes: gap,
          totalDriveMinutes: bestEv.stats.totalDriveMinutes,
          feeDiscountFactor: Number(discountFactor.toFixed(4)),
          partnerSavingsCents: partnerSavings,
          bestOptionKind: opt.kind,
        }
      }
    }
    if (bestResult.matched) break
  }

  return bestResult
}

/**
 * Top10ChainingDesk: Drop-in upgrade over QuantitativeDesk implementing the
 * "No Empty Miles" 2–3 car chaining engine, periodic consolidation sweep,
 * safe split/withdraw on urgent/drop/expire/cancel events, 0.78–0.85x chained
 * pricing, and expectedFeeCents synergy discounting in quote().
 */
export class Top10ChainingDesk extends QuantitativeDesk {
  readonly chainConfig: ChainingConfig
  readonly gigOrders = new Map<string, string[]>() // gigId -> unique orderIds in stop order
  readonly pickedUpStops = new Set<string>() // `${orderId}:${leg}`
  readonly rejectedChainCombos = new Set<string>()
  readonly failedOrderIds = new Set<string>()
  readonly lastQuoteSynergy = new Map<string, QuoteSynergyResult>()
  lastConsolidationAt = -Infinity

  readonly chainStats = {
    chainedGigsPosted: 0,
    chained2CarPosted: 0,
    chained3CarPosted: 0,
    periodicConsolidations: 0,
    chainSplitsOnUrgent: 0,
    chainSplitsOnExpire: 0,
    chainSplitsOnDrop: 0,
    chainSplitsOnCancel: 0,
    rejectedChainPosts: 0,
    quoteSynergyHits: 0,
  }

  constructor(
    world: any,
    level: number,
    now: number,
    map: any,
    roster: any[],
    strategy: StrategyConfig,
    chainConfig: Partial<ChainingConfig> = {},
  ) {
    super(world, level, now, map, roster, strategy)
    this.chainConfig = { ...DEFAULT_CHAINING_CONFIG, ...chainConfig }
  }

  override carry(action: PostAction, gigId: string): void {
    super.carry(action, gigId)
    const uniqueOrderIds: string[] = []
    for (const s of action.stops) {
      if (!uniqueOrderIds.includes(s.orderId)) uniqueOrderIds.push(s.orderId)
    }
    this.gigOrders.set(gigId, uniqueOrderIds)
  }

  private hasGigOrPendingPost(orderId: string): boolean {
    if (this.gigsOf(orderId).length > 0) return true
    return this.outbox.some((a) => a.type === "post" && a.stops.some((s) => s.orderId === orderId))
  }

  private removeGigTracking(gigId: string): void {
    const action = this.posts.get(gigId)
    if (action) {
      for (const { orderId, leg } of action.stops) {
        if (this.legGigs.get(orderId)?.get(leg) === gigId) {
          this.legGigs.get(orderId)?.delete(leg)
        }
      }
    }
    this.posts.delete(gigId)
    this.gigOrders.delete(gigId)
    this.booked.delete(gigId)
    this.started.delete(gigId)
  }

  private ordersInGig(gigId: string): string[] {
    const tracked = this.gigOrders.get(gigId)
    if (tracked && tracked.length > 0) return tracked
    const action = this.posts.get(gigId)
    if (!action) return []
    return [...new Set(action.stops.map((s) => s.orderId))]
  }

  private buildRetryForOrder(order: Order): RetryMeta {
    const req = this.requests.get(order.id)
    const flags = parseNoteFlags(req?.note ?? null, this.strategy.flags.noteNLP)
    return {
      pickupFrom: 0,
      manualLicence: flags.manualLicence,
      plates: flags.withPlates,
    }
  }

  private isOrderChainEligible(order: Order): ChainOrderContext | null {
    if (order.status === "cancelled" || order.legs.length !== 1) return null
    if (order.deliveredAt[0] !== null || this.pickedUpStops.has(`${order.id}:0`)) return null
    if (this.urgent.has(order.id) || this.failedOrderIds.has(order.id)) return null
    if (order.lastPickupAt - this.now < this.chainConfig.minOrderSlackMinutes) return null
    const req = this.requests.get(order.id)
    if (!req) return null
    const leg = order.legs[0]!
    const km = this.roadKm(leg.pickup.placeId, leg.delivery.placeId)
    return buildChainOrderContext(order, req, this.strategy.flags.noteNLP, this.buildRetryForOrder(order), km)
  }

  private collectOpenChainable(): {
    openSingleGigs: { gigId: string; ctx: ChainOrderContext }[]
    openMultiGigs: { gigId: string; contexts: ChainOrderContext[]; evalStats: ChainDriveStats }[]
    allOpenContexts: ChainOrderContext[]
  } {
    const openSingleGigs: { gigId: string; ctx: ChainOrderContext }[] = []
    const openMultiGigs: { gigId: string; contexts: ChainOrderContext[]; evalStats: ChainDriveStats }[] = []
    const allOpenContexts: ChainOrderContext[] = []
    const seenOrders = new Set<string>()

    for (const [gigId, postAction] of this.posts.entries()) {
      if (this.booked.has(gigId) || this.started.has(gigId)) continue
      if ((this.gigOpenOffers.get(gigId) ?? 0) > 0) continue

      const oIds = this.ordersInGig(gigId)
      if (oIds.length === 0) continue

      // Verify every leg in this gig still belongs to gigId and is chain-eligible
      const ctxs: ChainOrderContext[] = []
      let allValid = true
      for (const oid of oIds) {
        const order = this.orders.get(oid)
        if (!order || this.legGigs.get(oid)?.get(0) !== gigId) {
          allValid = false
          break
        }
        const ctx = this.isOrderChainEligible(order)
        if (!ctx) {
          allValid = false
          break
        }
        ctxs.push(ctx)
      }
      if (!allValid) continue

      if (ctxs.length === 1) {
        openSingleGigs.push({ gigId, ctx: ctxs[0]! })
      } else if (ctxs.length === 2) {
        const evalStats = computeChainDriveStats(ctxs, (a, b) => this.roadMinutes(a, b))
        openMultiGigs.push({ gigId, contexts: ctxs, evalStats })
      }
      for (const c of ctxs) {
        if (!seenOrders.has(c.order.id)) {
          seenOrders.add(c.order.id)
          allOpenContexts.push(c)
        }
      }
      void postAction
    }

    return { openSingleGigs, openMultiGigs, allOpenContexts }
  }

  private isSnowActiveAt = (placeId: string, atMinute: number): boolean => {
    const endsAt = this.snowPlaces.get(placeId) ?? 0
    return endsAt > atMinute
  }

  private queueChainedPost(plan: ChainPlan): void {
    const contexts = plan.contexts
    const stops = buildStopsForOrders(contexts, this.now, this.strategy.flags.noteNLP)
    const audience = buildChainedAudience(contexts)
    const schedule = chainedFeesFor(
      contexts,
      plan.evaluation.stats,
      this.now,
      this.strategy,
      (p) => this.localDriverCount(p),
      this.chainConfig,
    )

    this.outbox.push({ type: "post", stops, audience, schedule })
    this.telemetry.totalGigsPosted++
    this.chainStats.chainedGigsPosted++
    if (contexts.length === 3) this.chainStats.chained3CarPosted++
    else this.chainStats.chained2CarPosted++
  }

  private withdrawGigForConsolidation(gigId: string): boolean {
    if (!gigId || this.booked.has(gigId) || this.started.has(gigId)) return false
    if (!this.posts.has(gigId)) return false
    this.outbox.push({ type: "withdraw", gigId })
    this.removeGigTracking(gigId)
    return true
  }

  protected isChainingSafeToStartNew(): { safe: boolean; maxCars: 2 | 3; quoteSynergySafe: boolean } {
    if (!this.chainConfig.enabled || this.level < 3) {
      return { safe: false, maxCars: 2, quoteSynergySafe: false }
    }
    if (this.chainConfig.scarcityGated === false) {
      return {
        safe: true,
        maxCars: this.chainConfig.maxOrdersPerChain,
        quoteSynergySafe: this.chainConfig.quoteSynergyEnabled,
      }
    }
    const liveOT = this.liveOnTimeRatio()
    const bookedDenom = Math.max(12, this.telemetry.totalGigsBooked || this.orders.size)
    const dropRate = this.telemetry.gigDrops / bookedDenom
    const maxWaitAllowed = Math.max(
      4,
      Math.round(Math.max(1, this.roster.length) * this.strategy.maxActiveWaitingPerDriver),
    )
    const waiting = this.waitingOrdersCount()
    const curDay = Math.floor(this.now / DAY)
    const beforeDayCutoff =
      this.chainConfig.maxChainStartDay === undefined || curDay <= this.chainConfig.maxChainStartDay
    const safe =
      beforeDayCutoff &&
      liveOT >= this.strategy.targetOnTimeBuffer &&
      dropRate <= 0.145 &&
      waiting < maxWaitAllowed * 0.85
    const maxCars: 2 | 3 =
      safe && this.chainConfig.maxOrdersPerChain === 3 && liveOT >= 0.95 && dropRate <= 0.105 ? 3 : 2
    const quoteSynergySafe =
      safe &&
      this.chainConfig.quoteSynergyEnabled &&
      liveOT >= 0.945 &&
      waiting < maxWaitAllowed * 0.65
    return { safe, maxCars, quoteSynergySafe }
  }

  /**
   * Periodic consolidation sweep across all open unbooked gigs (2-car & 3-car).
   * Safely flushes unsent posts in outbox when needed so gigIds exist, then batches
   * withdraws + new chained post cleanly.
   */
  async consolidateOpenGigs(force = false): Promise<number> {
    const safeGate = this.isChainingSafeToStartNew()
    if (!safeGate.safe) return 0
    if (!force && this.now - this.lastConsolidationAt < this.chainConfig.consolidationIntervalMinutes) {
      return 0
    }
    this.lastConsolidationAt = this.now

    // Flush pending outbox posts so every open order has a concrete gigId before pairing
    if (this.outbox.some((a) => a.type === "post")) {
      await this.send()
    }

    const { openSingleGigs, openMultiGigs } = this.collectOpenChainable()
    if (openSingleGigs.length + openMultiGigs.length < 2) return 0

    const effChainCfg: ChainingConfig = { ...this.chainConfig, maxOrdersPerChain: safeGate.maxCars }
    const plans = findBestChainPlans(
      openSingleGigs,
      openMultiGigs,
      this.now,
      (a, b) => this.roadMinutes(a, b),
      effChainCfg,
      this.rejectedChainCombos,
      this.isSnowActiveAt,
    )

    let created = 0
    for (const plan of plans) {
      // Ensure every target gig is still open and unbooked before withdrawing any
      const allOpen = plan.replacesGigIds.every(
        (gid) => gid && this.posts.has(gid) && !this.booked.has(gid) && !this.started.has(gid),
      )
      if (!allOpen) continue
      for (const gid of plan.replacesGigIds) {
        this.withdrawGigForConsolidation(gid)
      }
      this.queueChainedPost(plan)
      created++
    }

    if (created > 0) {
      this.chainStats.periodicConsolidations += created
      await this.send()
    }
    return created
  }

  private async splitMultiOrderGig(
    gigId: string,
    reason: "urgent" | "expired" | "dropped" | "cancelled",
    boostFromLastBookedCents = 0,
  ): Promise<void> {
    const oIds = this.ordersInGig(gigId)
    const wasBooked = this.booked.has(gigId)

    if (reason === "urgent" || reason === "dropped") {
      if (this.posts.has(gigId) && !wasBooked) {
        this.outbox.push({ type: "withdraw", gigId })
      }
    }
    this.removeGigTracking(gigId)

    if (oIds.length > 1) {
      this.rejectedChainCombos.add(canonicalComboKey(oIds))
      if (reason === "urgent") this.chainStats.chainSplitsOnUrgent++
      else if (reason === "expired") this.chainStats.chainSplitsOnExpire++
      else if (reason === "dropped") this.chainStats.chainSplitsOnDrop++
      else if (reason === "cancelled") this.chainStats.chainSplitsOnCancel++
    }

    const activeOrders = oIds
      .map((id) => this.orders.get(id))
      .filter((o): o is Order => Boolean(o && o.status !== "cancelled"))

    const totalRef = activeOrders.reduce((s, o) => s + (this.requests.get(o.id)?.referenceFeeCents ?? 100), 0)

    for (const o of activeOrders) {
      const remainingLegs = o.legs
        .map((_, idx) => idx)
        .filter((idx) => o.deliveredAt[idx] === null && !this.pickedUpStops.has(`${o.id}:${idx}`))
      if (remainingLegs.length === 0) continue
      if (o.lastPickupAt - this.now <= 360) {
        this.urgent.add(o.id)
      }
      await this.post(o, remainingLegs)
      if (boostFromLastBookedCents > 0 && totalRef > 0) {
        const lastAction = this.outbox[this.outbox.length - 1]
        const req = this.requests.get(o.id)
        if (lastAction && lastAction.type === "post" && req) {
          const shareFloor = Math.round((boostFromLastBookedCents * req.referenceFeeCents * 1.05) / totalRef)
          for (const step of lastAction.schedule) {
            step.feeCents = Math.max(step.feeCents, shareFloor)
          }
        }
      }
    }
  }

  override quote(request: PriceRequest): void {
    const safeGate = this.isChainingSafeToStartNew()
    if (!safeGate.quoteSynergySafe || this.level <= 3) {
      super.quote(request)
      return
    }

    const { allOpenContexts } = this.collectOpenChainable()
    const synergy = findQuoteChainSynergy(
      request,
      allOpenContexts,
      this.now,
      (a, b) => this.roadMinutes(a, b),
      this.strategy.flags.noteNLP,
      this.chainConfig,
      this.isSnowActiveAt,
    )

    if (!synergy.matched) {
      super.quote(request)
      return
    }

    this.lastQuoteSynergy.set(request.id, synergy)
    this.chainStats.quoteSynergyHits++

    // Temporarily reflect chained fee economics in strategy multipliers so super.quote()
    // lowers expectedFeeCents & minRequiredPrice safely (restored in finally!).
    const origBaseFee = this.strategy.baseFeeMultiplier
    const origScarcity = this.strategy.scarcityTownFeeBoost
    const origMaxWaiting = this.strategy.maxActiveWaitingPerDriver
    const origMinMargin = this.strategy.minExpectedMarginRatio

    const pickupPlace = request.legs[0]!.pickup.placeId
    const townDayKey = `${Math.floor(this.now / DAY)}:${pickupPlace}`
    const prevTownWins = this.townDayWins.get(townDayKey)

    try {
      // Discount expectedFeeCents to ~0.78-0.84x of solo cost
      this.strategy.baseFeeMultiplier = Number((origBaseFee * synergy.feeDiscountFactor).toFixed(4))
      this.strategy.scarcityTownFeeBoost = Number((origScarcity * 0.5).toFixed(4))
      // Allow +10% headroom in waiting queue when a new car joins an existing unbooked chain
      if (this.chainConfig.allowChainedCapacityBypass && this.liveOnTimeRatio() >= this.strategy.targetOnTimeBuffer) {
        this.strategy.maxActiveWaitingPerDriver = Number((origMaxWaiting * 1.12).toFixed(4))
        if (prevTownWins !== undefined && prevTownWins > 0) {
          this.townDayWins.set(townDayKey, Math.max(0, prevTownWins - 1))
        }
      }
      super.quote(request)
    } finally {
      this.strategy.baseFeeMultiplier = origBaseFee
      this.strategy.scarcityTownFeeBoost = origScarcity
      this.strategy.maxActiveWaitingPerDriver = origMaxWaiting
      this.strategy.minExpectedMarginRatio = origMinMargin
      if (prevTownWins !== undefined) {
        this.townDayWins.set(townDayKey, prevTownWins)
      }
    }
  }

  override async win(order: Order): Promise<void> {
    if (!this.requests.has(order.id) || this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    this.telemetry.wonOrders++
    this.dealerWins.set(order.dealerId, (this.dealerWins.get(order.dealerId) ?? 0) + 1)

    const day = Math.floor(this.now / DAY)
    const pickupPlace = order.legs[0]!.pickup.placeId
    const townDayKey = `${day}:${pickupPlace}`
    this.townDayWins.set(townDayKey, (this.townDayWins.get(townDayKey) ?? 0) + 1)
    this.townOutageStreak.set(townDayKey, (this.townOutageStreak.get(townDayKey) ?? 0) + 1)

    const prevDealerOffset = this.dealerPriceOffset.get(order.dealerId) ?? 0
    this.dealerPriceOffset.set(order.dealerId, Math.min(0.22, prevDealerOffset + 0.02))

    if (this.targetedRequests.has(order.id)) {
      this.recentOutcomes.push(true)
      if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
    }

    // Immediate chaining check against open unbooked 1-car or 2-car gigs
    const safeGate = this.isChainingSafeToStartNew()
    if (safeGate.safe) {
      const ctx = this.isOrderChainEligible(order)
      if (ctx) {
        if (this.outbox.some((a) => a.type === "post")) {
          await this.send()
        }
        const { openSingleGigs, openMultiGigs } = this.collectOpenChainable()
        // Add newly won order as an unposted single item (gigId="") to test 2-car & 3-car plans
        const effChainCfg: ChainingConfig = { ...this.chainConfig, maxOrdersPerChain: safeGate.maxCars }
        const plans = findBestChainPlans(
          [{ gigId: "", ctx }, ...openSingleGigs],
          openMultiGigs,
          this.now,
          (a, b) => this.roadMinutes(a, b),
          effChainCfg,
          this.rejectedChainCombos,
          this.isSnowActiveAt,
        )
        const matchingPlan = plans.find((p) => p.contexts.some((c) => c.order.id === order.id))
        if (matchingPlan) {
          const allOpen = matchingPlan.replacesGigIds.every(
            (gid) => !gid || (this.posts.has(gid) && !this.booked.has(gid) && !this.started.has(gid)),
          )
          if (allOpen) {
            for (const gid of matchingPlan.replacesGigIds) {
              if (gid) this.withdrawGigForConsolidation(gid)
            }
            this.queueChainedPost(matchingPlan)
            await this.send()
            if (this.hasGigOrPendingPost(order.id)) return
          }
        }
      }
    }

    if (this.hasGigOrPendingPost(order.id)) return
    const remaining = order.legs.map((_, l) => l).filter((l) => order.deliveredAt[l] === null)
    await this.post(order, remaining)
  }

  override async handle(event: DeskEvent): Promise<void> {
    if (event.kind === "picked_up") {
      this.pickedUpStops.add(`${event.orderId}:${event.leg}`)
    } else if (event.kind === "visit_failed") {
      this.failedOrderIds.add(event.orderId)
      this.telemetry.visitFailures[event.reason] = (this.telemetry.visitFailures[event.reason] ?? 0) + 1
      await this.retry(event.orderId, event.leg, event.reason)
      return
    } else if (event.kind === "order_cancelled") {
      const prevOrder = this.orders.get(event.orderId)
      this.orders.delete(event.orderId)
      this.legGigs.delete(event.orderId)
      this.urgent.delete(event.orderId)
      if (prevOrder) {
        for (const cg of event.gigs) {
          this.booked.delete(cg.gigId)
          if (cg.outcome === "withdrawn") {
            await this.splitMultiOrderGig(cg.gigId, "cancelled")
          }
        }
      }
      return
    } else if (event.kind === "gig_viewed") {
      let viewers = this.gigViewers.get(event.gigId)
      if (!viewers) {
        viewers = new Set()
        this.gigViewers.set(event.gigId, viewers)
      }
      viewers.add(event.driverId)
      const oIds = this.ordersInGig(event.gigId)
      if (oIds.some((id) => this.urgent.has(id)) && !this.booked.has(event.gigId)) {
        this.tryDirectOfferToDriver(event.gigId, event.driverId)
      }
      return
    } else if (event.kind === "gig_dropped" || event.kind === "no_show") {
      if (event.kind === "gig_dropped") this.telemetry.gigDrops++
      else this.telemetry.noShows++
      const droppedDriver = this.gigBookedByDriver.get(event.gigId)
      if (droppedDriver) {
        for (const set of this.repositionedDriversAtPlace.values()) {
          set.delete(droppedDriver)
        }
      }
      this.booked.delete(event.gigId)
      this.gigBookedByDriver.delete(event.gigId)
      const oIds = this.ordersInGig(event.gigId)
      if (oIds.length > 1) {
        const lastBooked = this.bookedFeeByGig.get(event.gigId) ?? 0
        await this.splitMultiOrderGig(event.gigId, "dropped", lastBooked)
        return
      }
      const orderId = oIds[0] ?? this.gigOrder.get(event.gigId)
      if (orderId) {
        await this.onGigLostDriver(orderId, event.gigId)
      }
      return
    } else if (event.kind === "gig_expired") {
      const oIds = this.ordersInGig(event.gigId)
      if (oIds.length > 1) {
        await this.splitMultiOrderGig(event.gigId, "expired")
        return
      }
    } else if (event.kind === "driver_late") {
      const oIds = this.ordersInGig(event.gigId)
      if (oIds.length > 1) {
        const activeOrders = oIds
          .map((id) => this.orders.get(id))
          .filter((o): o is Order => Boolean(o && o.status !== "cancelled"))
        const firstOrder = activeOrders[0]
        const lateOrder = activeOrders.find((o) => event.pickupAt > o.lastPickupAt && o.lastPickupAt - this.now >= 150)
        if (
          firstOrder &&
          lateOrder &&
          !this.started.has(event.gigId) &&
          this.localDriverCount(firstOrder.legs[0]!.pickup.placeId) >= 2
        ) {
          this.outbox.push({ type: "release", gigId: event.gigId })
          this.removeGigTracking(event.gigId)
          this.rejectedChainCombos.add(canonicalComboKey(oIds))
          for (const o of activeOrders) {
            if (event.pickupAt > o.lastPickupAt) this.urgent.add(o.id)
            const rem = o.legs
              .map((_, l) => l)
              .filter((l) => o.deliveredAt[l] === null && !this.pickedUpStops.has(`${o.id}:${l}`))
            if (rem.length > 0) await this.post(o, rem)
          }
        }
        return
      }
    }

    await super.handle(event)

    // Periodic consolidation sweep over open unbooked gigs
    if (
      this.chainConfig.enabled &&
      this.level >= 3 &&
      this.now - this.lastConsolidationAt >= this.chainConfig.consolidationIntervalMinutes
    ) {
      await this.consolidateOpenGigs()
    }
  }

  override repost(gigId: string): void {
    const oIds = this.ordersInGig(gigId)
    if (oIds.length > 1) {
      void this.splitMultiOrderGig(gigId, "expired")
      return
    }
    super.repost(gigId)
  }

  override async raise(orderId: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    this.urgent.add(orderId)
    await this.sendPostOf(orderId)

    for (const gigId of this.gigsOf(orderId)) {
      if (!this.booked.has(gigId)) {
        const oIds = this.ordersInGig(gigId)
        if (oIds.length > 1) {
          await this.splitMultiOrderGig(gigId, "urgent")
          continue
        }
        const postAction = this.posts.get(gigId)
        if (postAction) {
          const cars = postAction.stops.filter((s) => s.kind === "pickup").length
          this.outbox.push({
            type: "reprice",
            gigId,
            schedule: this.feesFor(order, cars),
          })
          this.dispatchDirectOffersForGig(gigId, order)
        }
      }
    }
  }

  override async withdraw(orderId: string): Promise<boolean> {
    await this.sendPostOf(orderId)
    const gigs = this.gigsOf(orderId)
    if (gigs.some((gigId) => this.booked.has(gigId))) return false

    const siblingOrdersToRepost = new Set<Order>()
    for (const gigId of gigs) {
      const oIds = this.ordersInGig(gigId)
      if (oIds.length > 1) {
        for (const oid of oIds) {
          if (oid !== orderId) {
            const sib = this.orders.get(oid)
            if (sib && sib.status !== "cancelled") siblingOrdersToRepost.add(sib)
          }
        }
      }
      this.outbox.push({ type: "withdraw", gigId })
      this.removeGigTracking(gigId)
    }
    this.legGigs.delete(orderId)

    for (const sib of siblingOrdersToRepost) {
      const rem = sib.legs.map((_, l) => l).filter((l) => sib.deliveredAt[l] === null && !this.pickedUpStops.has(`${sib.id}:${l}`))
      if (rem.length > 0) await this.post(sib, rem)
    }
    return true
  }

  override tryDirectOfferToDriver(gigId: string, driverId: string, maxOpenOffers = 3): void {
    const oIds = this.ordersInGig(gigId)
    if (oIds.length <= 1) {
      super.tryDirectOfferToDriver(gigId, driverId, maxOpenOffers)
      return
    }
    if (this.level < 3 || !this.strategy.flags.repositionOffers) return
    const minuteOfDay = this.now % DAY
    if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return
    if ((this.gigOpenOffers.get(gigId) ?? 0) >= maxOpenOffers) return

    const pairKey = `${gigId}:${driverId}`
    if (this.offeredPairs.has(pairKey)) return

    const day = Math.floor(this.now / DAY)
    const driverDayKey = `${day}:${driverId}`
    const sentToday = this.driverOffersByDay.get(driverDayKey) ?? 0
    if (sentToday >= 3) return

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
    const isUrgent = oIds.some((id) => this.urgent.has(id))
    const combinedRef = oIds.reduce((sum, id) => sum + (this.requests.get(id)?.referenceFeeCents ?? 0), 0)
    const minRef = Math.max(100, Math.round(combinedRef * 0.82))
    const nonUrgentOfferMult = Math.max(1.02, this.strategy.directOfferDiscount)
    const offerFee = Math.max(100, minRef, Math.round(currentFee * (isUrgent ? 1.12 : nonUrgentOfferMult)))

    this.outbox.push({ type: "offer", gigId, driverId, feeCents: offerFee })
    this.offeredPairs.add(pairKey)
    this.driverOffersByDay.set(driverDayKey, sentToday + 1)
    this.gigOpenOffers.set(gigId, (this.gigOpenOffers.get(gigId) ?? 0) + 1)
    this.telemetry.totalDirectOffers++
  }

  override readResults(actions: any[], results: any[]): void {
    super.readResults(actions, results)
    actions.forEach((action, i) => {
      if (action.type === "post" && results[i] && !results[i].ok) {
        const orderIds = [...new Set<string>(action.stops.map((s: StopRef) => s.orderId))]
        if (orderIds.length > 1) {
          this.chainStats.rejectedChainPosts++
          this.rejectedChainCombos.add(canonicalComboKey(orderIds))
          for (const oid of orderIds) {
            const o = this.orders.get(oid)
            if (o && o.status !== "cancelled" && !this.hasGigOrPendingPost(oid)) {
              const rem = o.legs.map((_, l) => l).filter((l) => o.deliveredAt[l] === null)
              if (rem.length > 0) void this.post(o, rem)
            }
          }
        }
      }
    })
  }

  /** Reconstruct multi-stop active gigs after mid-simulation WebSocket reconnect (--final). */
  override async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    await super.rejoin(snapshot, history)
    for (const g of snapshot.gigs) {
      if (g.status === "withdrawn" || g.status === "done") continue
      const uniqueOrders: string[] = []
      for (const s of g.stops) {
        if (!uniqueOrders.includes(s.orderId)) uniqueOrders.push(s.orderId)
      }
      if (uniqueOrders.length >= 2) {
        const ctxs: ChainOrderContext[] = []
        for (const oid of uniqueOrders) {
          const o = this.orders.get(oid)
          if (!o) continue
          const ctx = buildChainOrderContext(
            o,
            this.requests.get(o.id),
            this.strategy.flags.noteNLP,
            (p) => this.placesById.get(p)?.hours ?? null,
          )
          ctxs.push(ctx)
          this.orderToGig.set(oid, g.id)
        }
        if (ctxs.length >= 2) {
          this.gigRoutes.set(g.id, {
            gigId: g.id,
            orderIds: uniqueOrders,
            contexts: ctxs,
            postedAt: g.postedAt,
            booked: g.status === "booked" || g.status === "working",
            bookedDriverId: g.driverId ?? undefined,
          })
        }
      }
    }
  }
}


/**
 * Local Offline Unit Test Suite verifying geometry, 12h driving cap, 45m gap limit,
 * OpeningHours (weekdays, Saturday, Sunday, note daily closes), plates/charging stop overhead,
 * 2-car & 3-car chaining plans, 0.78–0.85x fee scheduling, and quote() synergy discounting.
 */
export function runChainingUnitTests(): { passed: number; failed: number; details: string[] } {
  const details: string[] = []
  let passed = 0
  let failed = 0

  const assert = (cond: boolean, label: string) => {
    if (cond) {
      passed++
      details.push(`PASS: ${label}`)
    } else {
      failed++
      details.push(`FAIL: ${label}`)
    }
  }

  // Synthetic road graph
  const distances: Record<string, number> = {
    "HSL->TRE": 110,
    "TRE->HSL": 110,
    "TRE->TKU": 100,
    "TKU->TRE": 100,
    "TKU->SLO": 35,
    "SLO->TKU": 35,
    "SLO->HSL": 70,
    "HSL->SLO": 70,
    "HSL->OLU": 380,
    "OLU->HSL": 380,
    "OLU->ROI": 135,
    "ROI->OLU": 135,
    "TKU->OLU": 420,
    "OLU->TKU": 420,
    "TRE->JKL": 95,
    "JKL->TRE": 95,
    "JKL->KPO": 90,
    "KPO->JKL": 90,
    "KPO->OLU": 190,
    "OLU->KPO": 190,
    "JKL->HSL": 170,
    "HSL->JKL": 170,
    "VAA->TRE": 150,
    "TRE->VAA": 150,
  }
  const roadFn: RoadMinutesFn = (a, b) => {
    if (a === b) return 0
    return distances[`${a}->${b}`] ?? 300
  }

  const stdHours: OpeningHours = {
    opens: 8 * HOUR, // 480
    closes: 18 * HOUR, // 1080
    weekdays: [0, 1, 2, 3, 4],
    saturday: { opens: 9 * HOUR, closes: 14 * HOUR },
  }
  const noSatHours: OpeningHours = {
    opens: 9 * HOUR,
    closes: 17 * HOUR,
    weekdays: [0, 1, 2, 3, 4],
    saturday: null,
  }

  const makeOrderReq = (
    id: string,
    from: string,
    to: string,
    now: number,
    opts: {
      deadline?: number
      lastPickupAt?: number
      refCents?: number
      pickupHours?: OpeningHours | null
      deliveryHours?: OpeningHours | null
      privatePickup?: boolean
      privateDelivery?: boolean
      note?: Note | null
      electricLow?: boolean
    } = {},
  ): { order: Order; req: PriceRequest } => {
    const deadline = opts.deadline ?? 4 * DAY + 20 * HOUR // Friday 20:00
    const drive = roadFn(from, to)
    const lastPickupAt = opts.lastPickupAt ?? deadline - drive - 60
    const pickupWin: TimeWindow = { from: now, to: deadline }
    const delivWin: TimeWindow = { from: now, to: deadline }
    const order: Order = {
      id,
      dealerId: "D01",
      option: "within_3_days",
      priceCents: 35000,
      deadline,
      legs: [
        {
          car: {
            premium: false,
            electric: Boolean(opts.electricLow),
            chargePercent: opts.electricLow ? 20 : 80,
          },
          pickup: {
            placeId: from,
            privateAddress: Boolean(opts.privatePickup),
            window: pickupWin,
            hours: opts.pickupHours === undefined ? stdHours : opts.pickupHours,
          },
          delivery: {
            placeId: to,
            privateAddress: Boolean(opts.privateDelivery),
            window: delivWin,
            hours: opts.deliveryHours === undefined ? stdHours : opts.deliveryHours,
          },
        },
      ],
      status: "waiting",
      deliveredAt: [null],
      lastPickupAt,
    }
    const req: PriceRequest = {
      id,
      dealerId: "D01",
      batchId: null,
      arrivedAt: Math.floor(now / DAY) * DAY + 9 * HOUR,
      respondBy: now + 15,
      legs: order.legs,
      options: [{ kind: "within_3_days", deadline, listPriceCents: 30000 }],
      referenceFeeCents: opts.refCents ?? 10000,
      note: opts.note ?? null,
    }
    return { order, req }
  }

  const mon9am = 9 * HOUR // min 540

  // Test 1: OpeningHours checks (weekday, Saturday, Sunday, note daily closing)
  assert(isSiteOpenAt(mon9am, stdHours, 15) === true, "Monday 09:00 is open")
  assert(isSiteOpenAt(17 * HOUR + 50, stdHours, 15) === false, "Monday 17:50 fails 15m closing buffer (closes 18:00)")
  assert(isSiteOpenAt(5 * DAY + 11 * HOUR, stdHours, 15) === true, "Saturday 11:00 open with Saturday hours")
  assert(isSiteOpenAt(5 * DAY + 11 * HOUR, noSatHours, 15) === false, "Saturday 11:00 closed when saturday=null")
  assert(isSiteOpenAt(6 * DAY + 11 * HOUR, stdHours, 15) === false, "Sunday 11:00 always closed")

  const nextAfterSun = nextSiteOpenAt(6 * DAY + 10 * HOUR, stdHours, 15)
  assert(nextAfterSun === 7 * DAY + 8 * HOUR, `Next open after Sunday jumps to next Monday 08:00 (got ${nextAfterSun})`)

  // Test 2: Zero-gap 2-car chain (HSL -> TRE -> TKU = 110 + 0 + 100 = 210 min <= 720)
  const o1 = makeOrderReq("O1", "HSL", "TRE", mon9am, { refCents: 10000 })
  const o2 = makeOrderReq("O2", "TRE", "TKU", mon9am, { refCents: 9500 })
  const ctx1 = buildChainOrderContext(o1.order, o1.req, true)!
  const ctx2 = buildChainOrderContext(o2.order, o2.req, true)!
  const ev2 = evaluateChainSequence([ctx1, ctx2], mon9am, roadFn, DEFAULT_CHAINING_CONFIG)
  assert(ev2.feasible === true, `2-car zero-gap HSL->TRE->TKU feasible (${ev2.reason ?? "ok"})`)
  assert(ev2.stats.totalDriveMinutes === 210 && ev2.stats.maxGapMinutes === 0, "2-car drive=210m, gap=0m")

  // Test 3: Non-zero gap <= 45 min allowed (HSL->TKU via TRE->TKU->SLO->HSL: TRE->TKU (100), gap TKU->SLO (35), SLO->HSL (70))
  const o3 = makeOrderReq("O3", "SLO", "HSL", mon9am, { refCents: 9000 })
  const ctx3 = buildChainOrderContext(o3.order, o3.req, true)!
  const ev3 = evaluateChainSequence([ctx1, ctx2, ctx3], mon9am, roadFn, DEFAULT_CHAINING_CONFIG)
  // Drive = 110 (HSL->TRE) + 0 + 100 (TRE->TKU) + 35 (TKU->SLO) + 70 (SLO->HSL) = 315 min <= 720!
  assert(ev3.feasible === true, `3-car chain HSL->TRE->TKU~(35m)~SLO->HSL feasible (${ev3.reason ?? "ok"})`)
  assert(ev3.stats.totalDriveMinutes === 315 && ev3.stats.maxGapMinutes === 35, `3-car drive=315m, maxGap=35m`)

  // Test 4: Gap > 45 min rejected (HSL->TRE then JKL->HSL has gap TRE->JKL = 95m > 45m)
  const oFarGap = makeOrderReq("O_GAP", "JKL", "HSL", mon9am)
  const ctxFarGap = buildChainOrderContext(oFarGap.order, oFarGap.req, true)!
  const evBadGap = evaluateChainSequence([ctx1, ctxFarGap], mon9am, roadFn, DEFAULT_CHAINING_CONFIG)
  assert(evBadGap.feasible === false, `Gap 95m > 45m strictly rejected (${evBadGap.reason})`)

  // Test 5: 12-hour (720 min) RULES.md:68 cap enforcement
  // HSL->OLU (380) + gap OLU->OLU (0) + OLU->HSL (380) = 760 > 720
  const oLong1 = makeOrderReq("O_L1", "HSL", "OLU", mon9am, { refCents: 22000 })
  const oLong2 = makeOrderReq("O_L2", "OLU", "HSL", mon9am, { refCents: 22000 })
  const evOver720 = evaluateChainSequence(
    [buildChainOrderContext(oLong1.order, oLong1.req, true)!, buildChainOrderContext(oLong2.order, oLong2.req, true)!],
    mon9am,
    roadFn,
    DEFAULT_CHAINING_CONFIG,
  )
  assert(evOver720.feasible === false, `760m > 720m 12h cap strictly rejected (${evOver720.reason})`)

  // Test 6: Plates (30m) + Charging (40m) overhead pushed past closing hour
  // Start Monday 16:00 (960): HSL->TRE (110m) arrives 17:50 (after 17:45 buffer) OR plates+charging at 15:00 -> 15:00 + 70m + 110m = 18:00 (past 18:00 close -> pushed to Tue 08:00!)
  // If deadline is Monday 20:00 (same day), pushing to Tuesday 08:00 misses Monday 20:00 deadline!
  const mon1500 = 15 * HOUR
  const oTight = makeOrderReq("O_TIGHT", "HSL", "TRE", mon1500, {
    deadline: 20 * HOUR,
    lastPickupAt: 20 * HOUR - 120,
    electricLow: true,
    note: { text: "no plates", language: "en" },
  })
  const oTight2 = makeOrderReq("O_TIGHT2", "TRE", "TKU", mon1500, {
    deadline: 20 * HOUR,
    lastPickupAt: 20 * HOUR - 120,
  })
  const ctxTight1 = buildChainOrderContext(oTight.order, oTight.req, true)!
  const ctxTight2 = buildChainOrderContext(oTight2.order, oTight2.req, true)!
  const evTight = evaluateChainSequence([ctxTight1, ctxTight2], mon1500, roadFn, DEFAULT_CHAINING_CONFIG)
  assert(
    ctxTight1.pickupOverheadMinutes === 70 && evTight.feasible === false,
    `Plates+charging 70m overhead + slack guard prevents deadline miss (${evTight.reason})`,
  )

  // Test 7: Note closing hour restriction ("haettava ennen klo 15.30")
  const mon1430 = 14 * HOUR + 30
  const oNoteClose = makeOrderReq("O_CLOSE", "TRE", "TKU", mon1430, {
    note: { text: "haettava ennen klo 15.30", language: "fi" },
  })
  const ctxNoteClose = buildChainOrderContext(oNoteClose.order, oNoteClose.req, true)!
  // Starting O1 at 14:30+45=15:15 -> arrives TRE at 17:05 > 15:30! Should reject!
  const evNoteClose = evaluateChainSequence([ctx1, ctxNoteClose], mon1430, roadFn, DEFAULT_CHAINING_CONFIG)
  assert(
    evNoteClose.feasible === false,
    `Note early pickup closing 15:30 blocks late chain arrival (${evNoteClose.reason})`,
  )

  // Test 8: Private address excluded
  const oPriv = makeOrderReq("O_PRIV", "TRE", "TKU", mon9am, { privatePickup: true })
  assert(buildChainOrderContext(oPriv.order, oPriv.req, true) === null, "Private pickup excluded from chaining")

  // Test 9: Chained fee schedule within 0.78-0.85 * sum(refFee) opening and strictly monotonic
  const mockStrat = {
    version: 15,
    baseQuoteMultiplier: 1.46,
    sameDayQuotePremium: 0.22,
    minExpectedMarginRatio: 0.18,
    targetWinRate: 0.3,
    maxActiveWaitingPerDriver: 0.45,
    maxOrdersPerBatch: 5,
    baseFeeMultiplier: 1.0,
    maxNormalFeeMultiplier: 1.34,
    urgentFeeMultiplier: 1.75,
    maxUrgentFeeMultiplier: 2.2,
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
      chainGigs: true,
      slackFees: true,
    },
  } as StrategyConfig
  const sched3 = chainedFeesFor([ctx1, ctx2, ctx3], ev3.stats, mon9am, mockStrat, () => 5, DEFAULT_CHAINING_CONFIG)
  const sumRef3 = 10000 + 9500 + 9000 // 28500
  const openRatio = sched3[0]!.feeCents / sumRef3
  const monotonic = sched3.every((s, idx) => idx === 0 || (s.at > sched3[idx - 1]!.at && s.feeCents >= sched3[idx - 1]!.feeCents))
  assert(
    openRatio >= 0.78 && openRatio <= 0.85 && monotonic,
    `3-car chained opening fee ratio=${openRatio.toFixed(4)} in [0.78, 0.85] & monotonic (${sched3.length} steps)`,
  )

  // Test 10: Periodic plan selection finds 3-car chain over 2-car pair when compatible
  const plans = findBestChainPlans(
    [
      { gigId: "g1", ctx: ctx1 },
      { gigId: "g2", ctx: ctx2 },
      { gigId: "g3", ctx: ctx3 },
    ],
    [],
    mon9am,
    roadFn,
    DEFAULT_CHAINING_CONFIG,
    new Set(),
  )
  assert(
    plans.length === 1 && plans[0]!.contexts.length === 3,
    `Planner selects optimal 3-car chain instead of splitting into 2+1 (got ${plans.length} plans, len=${plans[0]?.contexts.length})`,
  )

  // Test 11: Quote synergy discount detects partner order and returns 0.78-0.84 discount factor
  const oIncoming = makeOrderReq("REQ_IN", "TRE", "TKU", mon9am, { refCents: 9500 })
  const syn = findQuoteChainSynergy(oIncoming.req, [ctx1], mon9am, roadFn, true, DEFAULT_CHAINING_CONFIG)
  assert(
    syn.matched && syn.partnerOrderIds[0] === "O1" && syn.feeDiscountFactor >= 0.78 && syn.feeDiscountFactor <= 0.85,
    `Quote synergy matched O1 with gap=${syn.gapMinutes}m and feeDiscount=${syn.feeDiscountFactor}`,
  )

  return { passed, failed, details }
}

// =============================================================================

// 3. INTEGRATED TOP-10 DESK & REJOIN SUPPORT

// =============================================================================

export interface IntegratedDeskOptions {
  chaining: Partial<ChainingConfig>
  pricer: Partial<Top10PricerConfig>
  useBayesianPricer: boolean
  useZeroHoldoutScheduler: boolean
}

export function strategyToPricerConfig(strategy: StrategyConfig, level: number): Partial<Top10PricerConfig> {
  return {
    level,
    baseQuoteMultiplier: strategy.baseQuoteMultiplier,
    sameDayQuotePremium: strategy.sameDayQuotePremium,
    minExpectedMarginRatio: strategy.minExpectedMarginRatio,
    targetWinRate: strategy.targetWinRate,
    maxActiveWaitingPerDriver: strategy.maxActiveWaitingPerDriver,
    maxOrdersPerBatch: strategy.maxOrdersPerBatch,
    baseFeeMultiplier: strategy.baseFeeMultiplier,
    maxNormalFeeMultiplier: strategy.maxNormalFeeMultiplier,
    urgentFeeMultiplier: strategy.urgentFeeMultiplier,
    maxUrgentFeeMultiplier: strategy.maxUrgentFeeMultiplier,
    scarcityTownFeeBoost: strategy.scarcityTownFeeBoost,
    directOfferMultiplier: Math.max(1.025, strategy.directOfferDiscount),
    targetOnTimeBuffer: strategy.targetOnTimeBuffer,
  }
}

export class Top10IntegratedDesk extends Top10ChainingDesk {
  readonly pricer: BayesianCompetitorPricer
  readonly feeScheduler: ZeroHoldoutFeeScheduler
  readonly useBayesianPricer: boolean
  readonly useZeroHoldoutScheduler: boolean

  readonly revenueCountedOnTime = new Set<string>()
  readonly activeRepriceDropFloor = new Map<string, number>()
  readonly peakFeeByKey = new Map<string, number>()
  readonly prevSchedByKey = new Map<string, FeeStep[]>()

  constructor(
    world: any,
    level: number,
    now: number,
    map: any,
    roster: any[],
    strategy: StrategyConfig,
    opts: Partial<IntegratedDeskOptions> = {},
  ) {
    super(world, level, now, map, roster, strategy, opts.chaining ?? {})
    this.useBayesianPricer = opts.useBayesianPricer ?? true
    this.useZeroHoldoutScheduler = opts.useZeroHoldoutScheduler ?? true

    const pricerCfg: Partial<Top10PricerConfig> = {
      ...strategyToPricerConfig(strategy, level),
      ...(opts.pricer ?? {}),
    }
    this.pricer = new BayesianCompetitorPricer(map, pricerCfg)
    this.feeScheduler = new ZeroHoldoutFeeScheduler(pricerCfg)
  }

  override quote(request: PriceRequest): void {
    if (!this.useBayesianPricer || this.level <= 3) {
      super.quote(request)
      return
    }

    this.requests.set(request.id, request)
    this.telemetry.totalRequests++
    this.dealerRequests.set(request.dealerId, (this.dealerRequests.get(request.dealerId) ?? 0) + 1)

    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupPlace = leg0.pickup.placeId
    const deliveryPlace = lastLeg.delivery.placeId

    let chainingDiscountRatio: number | undefined
    const chainSafeGate = this.isChainingSafeToStartNew()
    if (chainSafeGate.quoteSynergySafe) {
      const openContexts = this.getOpenChainableContextsForQuote()
      const synergy = findQuoteChainSynergy(
        request,
        openContexts,
        this.now,
        (a, b) => this.roadMinutes(a, b),
        this.strategy.flags.noteNLP,
        this.chainConfig,
        (pid, at) => (this.snowPlaces.get(pid) ?? 0) > at,
      )
      if (synergy.matched) {
        chainingDiscountRatio = synergy.feeDiscountFactor
        this.lastQuoteSynergy.set(request.id, synergy)
        this.chainStats.quoteSynergyHits++
      }
    }

    let activeUnbookedUrgent = 0
    for (const id of [...this.urgent]) {
      const o = this.orders.get(id)
      const undeliv = o ? o.legs.filter((_, l) => o.deliveredAt[l] === null) : []
      if (!o || o.status === "cancelled" || undeliv.length === 0) {
        this.urgent.delete(id)
        continue
      }
      const gigs = this.gigsOf(id)
      const allBooked = gigs.length > 0 && gigs.every((gId) => this.booked.has(gId))
      if (!allBooked) activeUnbookedUrgent++
    }

    const day = Math.floor(this.now / DAY)
    const townDayKey = `${day}:${pickupPlace}`
    const totalRoadMins = request.legs.reduce((s, l) => s + this.roadMinutes(l.pickup.placeId, l.delivery.placeId), 0)
    const totalRoadKm = request.legs.reduce((s, l) => s + this.roadKm(l.pickup.placeId, l.delivery.placeId), 0)

    const pricingCtx: PricingContext = {
      now: this.now,
      waitingCount: this.waitingOrdersCount(),
      activeUnbookedUrgent,
      totalDrivers: Math.max(1, this.roster.length),
      liveOnTimeShare: this.liveOnTimeRatio(),
      pickupDrivers: this.localDriverCount(pickupPlace),
      deliveryDrivers: this.localDriverCount(deliveryPlace),
      repositionedAtPickup: this.repositionedDriverCount(pickupPlace),
      townWinsToday: this.townDayWins.get(townDayKey) ?? 0,
      batchWinsSoFar: request.batchId !== null ? (this.batchCounts.get(request.batchId) ?? 0) : 0,
      snowAtPickup: (this.snowPlaces.get(pickupPlace) ?? 0) > this.now,
      snowAtDelivery: (this.snowPlaces.get(deliveryPlace) ?? 0) > this.now,
      totalRoadMins,
      totalRoadKm,
      noteFlags: parseNoteFlags(request.note, this.strategy.flags.noteNLP),
      chainingDiscountRatio,
    }

    const decision = this.pricer.evaluateQuote(request, pricingCtx)
    if (decision.action === "decline" || Object.keys(decision.prices).length === 0) {
      const opt = request.options[request.options.length - 1]!
      const declinePrice = Math.max(1000, Math.round(opt.listPriceCents * 4.2))
      this.outbox.push({ type: "quote", requestId: request.id, prices: { [opt.kind]: declinePrice } })
      this.telemetry.declinedHighQuote++
      return
    }

    this.outbox.push({ type: "quote", requestId: request.id, prices: decision.prices })
    this.targetedRequests.add(request.id)
    this.telemetry.quotedToWin++
    if (request.batchId !== null) {
      this.batchCounts.set(request.batchId, (this.batchCounts.get(request.batchId) ?? 0) + 1)
    }
  }

  private getOpenChainableContextsForQuote(): ChainOrderContext[] {
    const result: ChainOrderContext[] = []
    for (const [gigId, action] of this.posts.entries()) {
      if (this.booked.has(gigId) || this.started.has(gigId)) continue
      if ((this.gigOpenOffers.get(gigId) ?? 0) > 0) continue
      const uniqueOids = [...new Set(action.stops.map((s) => s.orderId))]
      if (uniqueOids.length !== 1) continue
      const order = this.orders.get(uniqueOids[0]!)
      if (!order || order.status === "cancelled" || order.legs.length !== 1) continue
      if (order.deliveredAt[0] !== null || this.pickedUpStops.has(`${order.id}:0`)) continue
      if (this.urgent.has(order.id) || this.failedOrderIds.has(order.id)) continue
      if (this.legGigs.get(order.id)?.get(0) !== gigId) continue
      if (order.lastPickupAt - this.now < this.chainConfig.minOrderSlackMinutes) continue
      const req = this.requests.get(order.id)
      if (!req) continue
      const ctx = buildChainOrderContext(order, req, this.strategy.flags.noteNLP)
      if (ctx) result.push(ctx)
    }
    return result
  }

  override async win(order: Order): Promise<void> {
    if (this.useBayesianPricer && !this.orders.has(order.id)) {
      this.pricer.observeOutcome(order.id, true, order.option as DeliveryOptionKind, this.now)
    }
    await super.win(order)
  }

  override lose(requestId: string): void {
    if (this.useBayesianPricer) {
      this.pricer.observeOutcome(requestId, false, undefined, this.now)
    }
    super.lose(requestId)
  }

  override feesFor(order: Order, cars: number): FeeStep[] {
    if (!this.useZeroHoldoutScheduler) {
      return super.feesFor(order, cars)
    }
    const req = this.requests.get(order.id)
    const pickupPlace = order.legs[0]!.pickup.placeId
    const deliveryPlace = order.legs[order.legs.length - 1]!.delivery.placeId
    const isUrgent = this.urgent.has(order.id) || Math.max(0, order.lastPickupAt - this.now) <= 4.5 * HOUR
    const lastBookedFeeCents = this.activeRepriceDropFloor.get(order.id) ?? 0
    const peakFromKey = this.pricer.config.repostNoFeeDrop
      ? resolveOrderActivePeakFee({
          order,
          cars,
          now: this.now,
          peakFeeByKey: this.peakFeeByKey,
          prevSchedByKey: this.prevSchedByKey,
        })
      : 0
    const effectivePeakFloor = Math.max(lastBookedFeeCents, peakFromKey) || undefined

    const refFeeCents = req?.referenceFeeCents ?? Math.round(order.priceCents * 0.72)

    if (this.pricer.config.smoothFeeStaircase) {
      const roadMin = order.legs.reduce((s, l) => s + this.roadMinutes(l.pickup.placeId, l.delivery.placeId), 0)
      const roadKm = order.legs.reduce((s, l) => s + this.roadKm(l.pickup.placeId, l.delivery.placeId), 0)
      const noteFlags = parseNoteFlags(req?.note ?? null, this.strategy.flags.noteNLP)
      const leg0Car = order.legs[0]!.car
      const leg0Km = this.roadKm(order.legs[0]!.pickup.placeId, order.legs[0]!.delivery.placeId)
      const needsCharge = Boolean(leg0Car.electric && leg0Car.chargePercent !== null && leg0Car.chargePercent < 30 && leg0Km > 200)
      const overheadMin = (noteFlags.withPlates ? 30 : 0) + (needsCharge ? 40 : 0)
      return buildSmoothFeeSchedule({
        order,
        referenceFeeCents: refFeeCents,
        cars,
        now: this.now,
        pickupDrivers: this.localDriverCount(pickupPlace),
        roadMin,
        roadKm,
        overheadMin,
        config: this.pricer.config,
        prevPeakFeeCents: effectivePeakFloor,
        urgent: isUrgent,
      })
    }

    const schedule = this.feeScheduler.buildSchedule({
      now: this.now,
      order,
      referenceFeeCents: refFeeCents,
      carsInGig: cars,
      pickupDrivers: this.localDriverCount(pickupPlace),
      deliveryDrivers: this.localDriverCount(deliveryPlace),
      isUrgent,
      lastBookedFeeCents: effectivePeakFloor,
    })
    if (this.pricer.config.repostNoFeeDrop && peakFromKey > 0 && order.deadline - this.now < 4.5 * HOUR) {
      return schedule.map((step) => ({ ...step, feeCents: Math.max(step.feeCents, peakFromKey) }))
    }
    return schedule
  }

  private applyOutboxUpgrades(): void {
    if (!this.pricer.config.hardenPostStops && !this.pricer.config.repostNoFeeDrop) return
    hardenOutboxPostActions({
      outbox: this.outbox,
      now: this.now,
      orders: this.orders,
      requests: this.requests,
      roadKm: (a, b) => this.roadKm(a, b),
      roadMinutes: (a, b) => this.roadMinutes(a, b),
      noteNLP: this.strategy.flags.noteNLP,
      hardenStops: Boolean(this.pricer.config.hardenPostStops),
      repostNoFeeDrop: Boolean(this.pricer.config.repostNoFeeDrop),
      peakFeeByKey: this.peakFeeByKey,
      prevSchedByKey: this.prevSchedByKey,
    })
  }

  override async onGigLostDriver(orderId: string, gigId: string): Promise<void> {
    const lastBooked = this.bookedFeeByGig.get(gigId) ?? 0
    if (lastBooked > 0) this.activeRepriceDropFloor.set(orderId, lastBooked)
    try {
      await super.onGigLostDriver(orderId, gigId)
    } finally {
      this.activeRepriceDropFloor.delete(orderId)
    }
  }

  override async handle(event: DeskEvent): Promise<void> {
    if (event.kind === "ledger" && this.useBayesianPricer) {
      const { kind, cents, orderId } = event.line
      this.telemetry.ledgerBreakdownCents[kind] = (this.telemetry.ledgerBreakdownCents[kind] ?? 0) + cents
      if (kind === "revenue" && orderId) {
        const order = this.orders.get(orderId)
        if (order) {
          const allOnTime = order.deliveredAt.every((t) => t !== null && t <= order.deadline)
          if (allOnTime) {
            this.revenueCountedOnTime.add(orderId)
            this.telemetry.onTimeDeliveries++
            this.pricer.recordDelivery(order.dealerId, true)
            this.dealerTrust.set(order.dealerId, this.pricer.getDealerTrust(order.dealerId))
          } else {
            this.telemetry.lateDeliveries++
            this.pricer.recordDelivery(order.dealerId, false)
            this.dealerTrust.set(order.dealerId, this.pricer.getDealerTrust(order.dealerId))
          }
        }
      } else if (kind === "late_refund" && orderId) {
        if (this.revenueCountedOnTime.has(orderId)) {
          this.revenueCountedOnTime.delete(orderId)
          this.telemetry.onTimeDeliveries = Math.max(0, this.telemetry.onTimeDeliveries - 1)
          this.telemetry.lateDeliveries++
          const order = this.orders.get(orderId)
          if (order) {
            this.pricer.recordDelivery(order.dealerId, false)
            this.dealerTrust.set(order.dealerId, this.pricer.getDealerTrust(order.dealerId))
          }
        }
      }
      return
    }
    await super.handle(event)
    this.applyOutboxUpgrades()
  }

  override dispatchDirectOffersForGig(gigId: string, order: Order): void {
    const postAction = this.posts.get(gigId)
    if (!this.useZeroHoldoutScheduler || !postAction) {
      super.dispatchDirectOffersForGig(gigId, order)
      return
    }
    const uniqueOrders = new Set(postAction.stops.map((s) => s.orderId))
    if (uniqueOrders.size > 1) {
      // Multi-order chained gig: delegate to Top10ChainingDesk direct-offer logic
      super.dispatchDirectOffersForGig(gigId, order)
      return
    }
    if (this.level < 3 || !this.strategy.flags.repositionOffers) return
    const req = this.requests.get(order.id)
    if (!req) return

    const pickupPlace = order.legs[0]!.pickup.placeId
    const candidates = this.feeScheduler.selectDirectOfferCandidates({
      now: this.now,
      gigId,
      order,
      audience: postAction.audience,
      currentSchedule: postAction.schedule,
      referenceFeeCents: req.referenceFeeCents,
      carsInGig: postAction.stops.filter((s) => s.kind === "pickup").length,
      isUrgent: this.urgent.has(order.id),
      roster: this.roster,
      placesById: this.placesById,
      driverLastDelivery: this.driverLastDelivery,
      gigViewers: this.gigViewers.get(gigId) ?? new Set(),
      driversNearPickup: this.driversNearPlace.get(pickupPlace) ?? [],
      repositionedEnRoute: this.repositionedDriversAtPlace.get(pickupPlace) ?? new Set(),
      offeredPairs: this.offeredPairs,
      driverOffersToday: this.driverOffersByDay,
      openOffersOnGig: this.gigOpenOffers.get(gigId) ?? 0,
    })

    const day = Math.floor(this.now / DAY)
    for (const c of candidates) {
      let offerFeeCents = c.feeCents
      if (this.pricer.config.smartDirectOffers) {
        const drv = this.roster.find((d: any) => d.id === c.driverId)
        if (!drv) continue
        const chk = shouldAllowSmartDirectOffer({
          order,
          referenceFeeCents: req.referenceFeeCents,
          now: this.now,
          roadMin: this.roadMinutes(pickupPlace, order.legs[0]!.delivery.placeId),
          pickupDrivers: this.localDriverCount(pickupPlace),
          driver: drv,
          offerFeeCents,
        })
        if (!chk.allow) continue
        offerFeeCents = chk.minFeeCents
      }
      this.outbox.push({ type: "offer", gigId, driverId: c.driverId, feeCents: offerFeeCents })
      this.offeredPairs.add(`${gigId}:${c.driverId}`)
      this.driverOffersByDay.set(`${day}:${c.driverId}`, (this.driverOffersByDay.get(`${day}:${c.driverId}`) ?? 0) + 1)
      this.gigOpenOffers.set(gigId, (this.gigOpenOffers.get(gigId) ?? 0) + 1)
      this.telemetry.totalDirectOffers++
    }
  }

  /** Reconstruct pricer beliefs and pending requests during live --final reconnect. */
  override async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    await super.rejoin(snapshot, history)
    for (const ev of history) {
      if (ev.kind === "price_request") {
        this.requests.set(ev.request.id, ev.request)
      } else if (ev.kind === "order_won") {
        const req = this.requests.get(ev.order.id)
        if (req) {
          this.pricer.observeHistoricalWin(req, ev.order)
        }
      } else if (ev.kind === "ledger") {
        const { kind, orderId } = ev.line
        if (kind === "revenue" && orderId) {
          const ord = this.orders.get(orderId)
          if (ord) {
            this.pricer.recordDelivery(ord.dealerId, true)
            this.dealerTrust.set(ord.dealerId, this.pricer.getDealerTrust(ord.dealerId))
          }
        } else if (kind === "late_refund" && orderId) {
          const ord = this.orders.get(orderId)
          if (ord) {
            this.pricer.recordDelivery(ord.dealerId, false)
            this.dealerTrust.set(ord.dealerId, this.pricer.getDealerTrust(ord.dealerId))
          }
        }
      }
    }
    for (const r of snapshot.openRequests) {
      this.requests.set(r.id, r)
    }
    this.applyOutboxUpgrades()
  }
}

export function getTop10DeskOptions(strategy: StrategyConfig): IntegratedDeskOptions {
  const anyStrat = strategy as StrategyConfig & {
    pricerOptions?: Partial<Top10PricerConfig>
    chainingOptions?: Partial<ChainingConfig>
    useStructuralPriors?: boolean
    positivePriorsOnly?: boolean
    hardenPostStops?: boolean
    repostNoFeeDrop?: boolean
    smoothFeeStaircase?: boolean
    softCapacitySurge?: boolean
    adverseSelectionGuard?: boolean
    smartDirectOffers?: boolean
  }
  const chainingEnabled = Boolean(strategy.flags.chainGigs)
  return {
    useBayesianPricer: true,
    useZeroHoldoutScheduler: true,
    pricer: {
      strictCapacityGate: true,
      minQuoteMultiplier: 1.29,
      worldBaseMuFloor: 1.32,
      useStructuralPriors: anyStrat.useStructuralPriors ?? false,
      positivePriorsOnly: anyStrat.positivePriorsOnly ?? false,
      hybridMarginFilter: false,
      broadFeeTiers: false,
      optionAwareFee: false,
      minAbsoluteMarginCents: 1200,
      congestedAbsoluteMarginCents: 1550,
      hardenPostStops: anyStrat.hardenPostStops ?? false,
      repostNoFeeDrop: anyStrat.repostNoFeeDrop ?? false,
      smoothFeeStaircase: anyStrat.smoothFeeStaircase ?? false,
      softCapacitySurge: anyStrat.softCapacitySurge ?? false,
      adverseSelectionGuard: anyStrat.adverseSelectionGuard ?? false,
      smartDirectOffers: anyStrat.smartDirectOffers ?? false,
      ...(anyStrat.pricerOptions ?? {}),
    },
    chaining: chainingEnabled
      ? {
          enabled: true,
          maxOrdersPerChain: 2,
          maxGapMinutes: 25,
          minOrderSlackMinutes: 600,
          openFeeMinMult: 0.88,
          openFeeMaxMult: 0.92,
          quoteSynergyEnabled: false,
          allowChainedCapacityBypass: false,
          scarcityGated: true,
          ...(anyStrat.chainingOptions ?? {}),
        }
      : { enabled: false },
  }
}

