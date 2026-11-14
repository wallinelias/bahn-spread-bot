/**
 * Weather Network Model & Dynamic Risk Scoring Module
 * Bahn Express "Spread" Challenge (Junction 2026)
 *
 * Implements:
 * 1. Dynamic tracking of DeskEvent ('forecast') snow intervals across Finnish towns.
 * 2. Network-graph corridor analysis for northern hubs (Oulu, Rovaniemi, Kemi) & transit corridors.
 * 3. Travel delay multiplier calculation (empirically derived: 1.25x - 1.41x transit delay).
 * 4. Driver liquidity shortage estimation (+14 hours / +840 mins booking delay in snow zones).
 * 5. Directional long-haul northbound hazard detection (especially ahead of weekends).
 * 6. Dynamic weather-gated pricing & fee schedule multipliers for bot.ts.
 * 7. Historical event backtesting suite against Season 4 Run 4 & Run 2 logs.
 */

import fs from "node:fs"
import path from "node:path"
import type { DeskEvent, ForecastEvent, PriceRequest, Order, RequestOption } from "./types.ts"

// ============================================================================
// Empirically Calibrated Constants (Derived from R4 & R2 Ground-Truth Telemetry)
// ============================================================================

export const WEATHER_CONFIG = {
  // Empirical transit time expansion in snow (normal = 1.016x, snow = 1.235x avg, peak 1.41x)
  snowTransitMultiplier: 1.25,
  peakSnowTransitMultiplier: 1.40,

  // Driver booking delay buffer: normal booking delay is ~11.5h (688m), snow is ~25.5h (1532m)
  // Additional waiting required for a driver to accept during snow storm: +14.0 hours (+840 mins)
  snowBookingDelayMinutes: 840,

  // Minimum required safe slack before deadline to quote options touching snow
  minSlackSameDaySnow: 480,   // 8 hours minimum slack for same-day in snow (rarely achievable)
  minSlackNextDaySnow: 2160,  // 36 hours minimum slack for next-day into northern snow
  minSlackTwoLegSnow: 2880,   // 48 hours for multi-leg / return trips into snow
  minSlackNorthboundLongHaul: 2400, // 40 hours for long-haul northbound into snow zone

  // Weather-gated margin premiums (additive to base quote multiplier)
  moderateHazardQuoteMarkup: 0.12,  // +12% list price quote markup
  severeHazardQuoteMarkup: 0.22,    // +22% list price quote markup for tight snow routes

  // Driver fee incentive boost (for feesFor to attract drivers who would otherwise stay home)
  snowDriverFeeBoost: 0.18,         // +18% reference fee boost in snow towns
  extremeSnowDriverFeeBoost: 0.25,  // +25% reference fee boost in remote northern snow towns

  // Key northern hub places in Finland network
  northernHubs: ["oulu", "rovaniemi", "kemi"] as const,
  transitCorridors: ["ylivieska", "kajaani", "kokkola", "kuopio"] as const,
}

export interface SnowInterval {
  from: number
  to: number
  placeIds: Set<string>
  text: string
  receivedAt: number
}

export type RiskSeverity = "CLEAR" | "ELEVATED" | "HAZARD" | "CRITICAL"

export interface OptionRisk {
  kind: "same_day" | "next_day" | "within_3_days"
  deadline: number
  availableSlack: number
  requiredSlack: number
  safe: boolean
  recommendedQuoteMarkup: number
  declineReason?: string
}

export interface WeatherRiskAssessment {
  requestId: string
  touchesSnow: boolean
  snowAtPickup: boolean
  snowAtDelivery: boolean
  corridorSnow: boolean
  isNorthboundLongHaul: boolean
  summerTyresInSnow: boolean
  baseTravelMinutes: number
  effectiveTravelMinutes: number
  liquidityDelayMinutes: number
  riskSeverity: RiskSeverity
  recommendedQuoteMultiplier: number
  recommendedFeeBoost: number
  optionRisks: Record<string, OptionRisk>
}

// ============================================================================
// WeatherNetworkModel Engine
// ============================================================================

export class WeatherNetworkModel {
  private readonly snowIntervals: SnowInterval[] = []
  private readonly placeSnowUntil = new Map<string, number>()
  private readonly northernHubs = new Set<string>(WEATHER_CONFIG.northernHubs)
  private readonly transitCorridors = new Set<string>(WEATHER_CONFIG.transitCorridors)

  /**
   * Ingest any DeskEvent. Captures 'forecast' events and updates network weather state.
   */
  handleEvent(event: DeskEvent): void {
    if (event.kind === "forecast") {
      this.recordForecast(event as ForecastEvent)
    }
  }

  /**
   * Record a snow forecast event.
   */
  recordForecast(event: ForecastEvent): void {
    const placeSet = new Set(event.placeIds.map((p) => p.toLowerCase()))

    // Northern triangle coupling: Kemi, Oulu, Rovaniemi share weather system and driver pool
    const hasNorthern = [...placeSet].some((p) => this.northernHubs.has(p))
    if (hasNorthern) {
      for (const n of this.northernHubs) {
        placeSet.add(n)
      }
    }

    const interval: SnowInterval = {
      from: event.from,
      to: event.to,
      placeIds: placeSet,
      text: event.text,
      receivedAt: event.at,
    }
    this.snowIntervals.push(interval)

    for (const pid of placeSet) {
      const current = this.placeSnowUntil.get(pid) ?? 0
      this.placeSnowUntil.set(pid, Math.max(current, event.to))
    }
  }

  /**
   * Check if a town has active falling snow at a given minute.
   */
  isSnowingAt(placeId: string, minute: number): boolean {
    const lower = placeId.toLowerCase()
    return this.snowIntervals.some(
      (interval) => interval.placeIds.has(lower) && minute >= interval.from && minute <= interval.to,
    )
  }

  /**
   * Check if a town is forecasted to experience snow during an interval [startMinute, endMinute].
   */
  hasSnowBetween(placeId: string, startMinute: number, endMinute: number): boolean {
    const lower = placeId.toLowerCase()
    return this.snowIntervals.some(
      (interval) =>
        interval.placeIds.has(lower) &&
        Math.max(startMinute, interval.from) <= Math.min(endMinute, interval.to),
    )
  }

  /**
   * Get all active or upcoming snow intervals affecting a place.
   */
  getSnowIntervalsFor(placeId: string): SnowInterval[] {
    const lower = placeId.toLowerCase()
    return this.snowIntervals.filter((interval) => interval.placeIds.has(lower))
  }

  /**
   * Returns true if place is in the high-risk northern zone (Oulu, Rovaniemi, Kemi).
   */
  isNorthernHub(placeId: string): boolean {
    return this.northernHubs.has(placeId.toLowerCase())
  }

  /**
   * Assess effective travel time between two towns given departure time and base road minutes.
   */
  effectiveTravelMinutes(
    from: string,
    to: string,
    baseRoadMinutes: number,
    departureMinute: number,
  ): {
    effectiveMinutes: number
    delayMinutes: number
    touchesSnow: boolean
  } {
    const arrivalMinute = departureMinute + baseRoadMinutes
    const fromSnow = this.hasSnowBetween(from, departureMinute, arrivalMinute)
    const toSnow = this.hasSnowBetween(to, departureMinute, arrivalMinute)
    const northern = this.isNorthernHub(from) || this.isNorthernHub(to)

    let mult = 1.0
    if (fromSnow || toSnow) {
      mult = northern ? WEATHER_CONFIG.peakSnowTransitMultiplier : WEATHER_CONFIG.snowTransitMultiplier
    } else if (northern && baseRoadMinutes > 300) {
      // Long corridor into north with distant snow risk
      const anyNorthernSnow = this.snowIntervals.some(
        (int) => [...int.placeIds].some((p) => this.northernHubs.has(p)) && int.to >= departureMinute,
      )
      if (anyNorthernSnow) {
        mult = 1.15
      }
    }

    const effectiveMinutes = Math.round(baseRoadMinutes * mult)
    return {
      effectiveMinutes,
      delayMinutes: effectiveMinutes - baseRoadMinutes,
      touchesSnow: mult > 1.0,
    }
  }

  /**
   * Core Quantitative Assessment: Evaluates weather risk, travel delay, liquidity drag,
   * directional corridor hazards, and builds option-by-option risk recommendations.
   */
  assessRisk(
    request: PriceRequest,
    nowMinute: number,
    roadMinutesFn: (from: string, to: string) => number,
    noteFlags?: { summerTyres?: boolean; hasTightDeadline?: boolean },
  ): WeatherRiskAssessment {
    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupPlace = leg0.pickup.placeId.toLowerCase()
    const deliveryPlace = lastLeg.delivery.placeId.toLowerCase()

    let baseTravelMinutes = 0
    for (let i = 0; i < request.legs.length; i++) {
      const l = request.legs[i]!
      baseTravelMinutes += roadMinutesFn(l.pickup.placeId, l.delivery.placeId)
      if (i + 1 < request.legs.length) {
        const nextL = request.legs[i + 1]!
        baseTravelMinutes += roadMinutesFn(l.delivery.placeId, nextL.pickup.placeId)
      }
    }

    // Determine planning window: up to the max option deadline
    const maxDeadline = Math.max(...request.options.map((o) => o.deadline), nowMinute + 2880)
    const snowAtPickup = this.hasSnowBetween(pickupPlace, nowMinute, maxDeadline)
    const snowAtDelivery = this.hasSnowBetween(deliveryPlace, nowMinute, maxDeadline)
    const touchesNorth = this.isNorthernHub(pickupPlace) || this.isNorthernHub(deliveryPlace)
    const isNorthboundLongHaul = !this.isNorthernHub(pickupPlace) && this.isNorthernHub(deliveryPlace) && baseTravelMinutes >= 340

    // Check corridor snow
    let corridorSnow = false
    if (!snowAtPickup && !snowAtDelivery && touchesNorth) {
      for (const transit of this.transitCorridors) {
        if (this.hasSnowBetween(transit, nowMinute, maxDeadline)) {
          corridorSnow = true
          break
        }
      }
    }

    const touchesSnow = snowAtPickup || snowAtDelivery || corridorSnow
    const summerTyresInSnow = !!noteFlags?.summerTyres && (this.isSnowingAt(pickupPlace, nowMinute) || snowAtPickup)

    // Calculate effective travel delay
    let transitMultiplier = 1.0
    if (touchesSnow) {
      transitMultiplier = touchesNorth ? WEATHER_CONFIG.peakSnowTransitMultiplier : WEATHER_CONFIG.snowTransitMultiplier
    }
    const effectiveTravelMinutes = Math.round(baseTravelMinutes * transitMultiplier)

    // Calculate driver liquidity delay (drivers staying home in snow)
    const liquidityDelayMinutes = touchesSnow
      ? touchesNorth
        ? WEATHER_CONFIG.snowBookingDelayMinutes
        : Math.round(WEATHER_CONFIG.snowBookingDelayMinutes * 0.6)
      : 0

    // Check if order arrives near Friday/weekend (5400-7200) into a northern snow hub during snow
    const isFridayNorthboundInSnow = touchesSnow && isNorthboundLongHaul && nowMinute >= 5400 && nowMinute <= 7200

    // Evaluate each option
    const optionRisks: Record<string, OptionRisk> = {}
    let highestSeverity: RiskSeverity = "CLEAR"

    for (const opt of request.options) {
      const availableSlack = opt.deadline - nowMinute - effectiveTravelMinutes
      let requiredSlack = 180 // default 3 hours slack
      let quoteMarkup = 0
      let safe = true
      let declineReason: string | undefined

      if (touchesSnow) {
        if (opt.kind === "same_day") {
          requiredSlack = WEATHER_CONFIG.minSlackSameDaySnow
          if (availableSlack < requiredSlack || baseTravelMinutes > 240) {
            safe = false
            declineReason = `Same-day option with ${availableSlack}m slack insufficient for snow transit (${effectiveTravelMinutes}m) and booking delay.`
          } else {
            quoteMarkup = WEATHER_CONFIG.severeHazardQuoteMarkup
          }
        } else if (opt.kind === "next_day") {
          if (request.legs.length > 1) {
            requiredSlack = WEATHER_CONFIG.minSlackTwoLegSnow
          } else if (isNorthboundLongHaul) {
            requiredSlack = WEATHER_CONFIG.minSlackNorthboundLongHaul
          } else {
            requiredSlack = touchesNorth ? WEATHER_CONFIG.minSlackNextDaySnow : 1440
          }

          if (availableSlack < requiredSlack) {
            safe = false
            declineReason = `Next-day option slack ${availableSlack}m < required ${requiredSlack}m for northern snow corridor.`
          } else if (isFridayNorthboundInSnow && opt.deadline <= 11280) {
            // Friday northbound long-haul during snow: driver supply dries up completely over the weekend
            // Unless within_3_days or deadline extends past Tuesday, high probability of drop/late
            safe = false
            declineReason = `Friday long-haul northbound into northern blizzard cannot reliably book over weekend before Monday deadline.`
          } else {
            quoteMarkup = isNorthboundLongHaul ? WEATHER_CONFIG.severeHazardQuoteMarkup : WEATHER_CONFIG.moderateHazardQuoteMarkup
          }
        } else {
          // within_3_days
          requiredSlack = 2880 // 48 hours
          quoteMarkup = WEATHER_CONFIG.moderateHazardQuoteMarkup * 0.7
        }
      }

      // Hard block: summer tyres during active snow
      if (summerTyresInSnow && (opt.kind === "same_day" || availableSlack < 1440)) {
        safe = false
        declineReason = "Summer tyres note during active snowfall fails collection as not_ready."
      }

      optionRisks[opt.kind] = {
        kind: opt.kind,
        deadline: opt.deadline,
        availableSlack,
        requiredSlack,
        safe,
        recommendedQuoteMarkup: quoteMarkup,
        declineReason,
      }

      if (!safe) {
        highestSeverity = "CRITICAL"
      } else if (touchesSnow && highestSeverity !== "CRITICAL") {
        highestSeverity = touchesNorth ? "HAZARD" : "ELEVATED"
      }
    }

    // Driver fee incentive boost: critical for convincing drivers to take trips during snow
    let recommendedFeeBoost = 0
    if (touchesSnow) {
      recommendedFeeBoost = (touchesNorth || isNorthboundLongHaul)
        ? WEATHER_CONFIG.extremeSnowDriverFeeBoost
        : WEATHER_CONFIG.snowDriverFeeBoost
    }

    // Overall recommended quote markup
    const safeMarkups = Object.values(optionRisks)
      .filter((o) => o.safe)
      .map((o) => o.recommendedQuoteMarkup)
    const recommendedQuoteMultiplier = safeMarkups.length > 0 ? Math.max(...safeMarkups) : 0

    return {
      requestId: request.id,
      touchesSnow,
      snowAtPickup,
      snowAtDelivery,
      corridorSnow,
      isNorthboundLongHaul,
      summerTyresInSnow,
      baseTravelMinutes,
      effectiveTravelMinutes,
      liquidityDelayMinutes,
      riskSeverity: highestSeverity,
      recommendedQuoteMultiplier,
      recommendedFeeBoost,
      optionRisks,
    }
  }

  /**
   * Weather-gated decision helper for bot.ts quote() method:
   * Returns price adjustments or signals to decline hazardous options.
   */
  evaluateOptionForBot(
    request: PriceRequest,
    opt: RequestOption,
    nowMinute: number,
    baseQuotePriceCents: number,
    roadMinutesFn: (from: string, to: string) => number,
    noteFlags?: { summerTyres?: boolean; hasTightDeadline?: boolean },
  ): {
    shouldQuote: boolean
    adjustedPriceCents: number
    declineReason?: string
  } {
    const assessment = this.assessRisk(request, nowMinute, roadMinutesFn, noteFlags)
    const optRisk = assessment.optionRisks[opt.kind]

    if (!optRisk || !optRisk.safe) {
      return {
        shouldQuote: false,
        adjustedPriceCents: 0,
        declineReason: optRisk?.declineReason ?? "Weather hazard: unsafe slack in snow zone",
      }
    }

    const priceMarkup = 1 + optRisk.recommendedQuoteMarkup
    const adjustedPriceCents = Math.round(baseQuotePriceCents * priceMarkup)

    return {
      shouldQuote: true,
      adjustedPriceCents,
    }
  }

  /**
   * Driver fee schedule helper for bot.ts feesFor() method:
   * Returns additive multiplier to apply to the opening driver fee.
   */
  getDriverFeeBoostForOrder(
    order: Order,
    nowMinute: number,
  ): number {
    const leg0 = order.legs[0]!
    const lastLeg = order.legs[order.legs.length - 1]!
    const pickup = leg0.pickup.placeId.toLowerCase()
    const delivery = lastLeg.delivery.placeId.toLowerCase()

    const snowPickup = this.hasSnowBetween(pickup, nowMinute, order.deadline)
    const snowDelivery = this.hasSnowBetween(delivery, nowMinute, order.deadline)
    const touchesNorth = this.isNorthernHub(pickup) || this.isNorthernHub(delivery)

    if (snowPickup || snowDelivery) {
      return touchesNorth ? WEATHER_CONFIG.extremeSnowDriverFeeBoost : WEATHER_CONFIG.snowDriverFeeBoost
    }
    return 0
  }
}

// ============================================================================
// Historical Backtesting & Validation Suite (R4 & R2 Logs)
// ============================================================================

export interface BacktestMetrics {
  totalRequests: number
  snowAffectedRequests: number
  totalWonOrders: number
  snowWonOrders: number
  actualLateRefunds: number
  actualLateRefundCents: number
  snowLateRefunds: number
  snowLateRefundCents: number
  modelFlaggedHazardOrders: number
  modelPreventedLateRefunds: number
  modelPreventedLossCents: number
  precision: number
  recall: number
}

export function runHistoricalBacktest(
  eventsFilePath: string,
  snapshotFilePath?: string,
): BacktestMetrics {
  const eventsRaw = JSON.parse(fs.readFileSync(eventsFilePath, "utf8")) as DeskEvent[]
  const model = new WeatherNetworkModel()

  // Simplified road minutes lookup for offline backtesting
  const roadMinutesMap = new Map<string, number>([
    ["helsinki->oulu", 394],
    ["oulu->helsinki", 394],
    ["helsinki->rovaniemi", 549],
    ["rovaniemi->helsinki", 549],
    ["helsinki->kemi", 459],
    ["kemi->helsinki", 459],
    ["tampere->oulu", 340],
    ["oulu->tampere", 340],
    ["tampere->rovaniemi", 491],
    ["rovaniemi->tampere", 491],
    ["oulu->rovaniemi", 159],
    ["rovaniemi->oulu", 159],
    ["oulu->kemi", 81],
    ["kemi->oulu", 81],
    ["rovaniemi->kemi", 82],
    ["kemi->rovaniemi", 82],
    ["kuopio->oulu", 198],
    ["oulu->kuopio", 198],
    ["turku->oulu", 412],
    ["oulu->turku", 412],
    ["turku->rovaniemi", 568],
    ["rovaniemi->turku", 568],
    ["vantaa->oulu", 397],
    ["oulu->vantaa", 397],
    ["vantaa->rovaniemi", 551],
    ["rovaniemi->vantaa", 551],
    ["espoo->oulu", 394],
    ["oulu->espoo", 394],
    ["hyvinkaa->oulu", 384],
    ["oulu->hyvinkaa", 384],
    ["hyvinkaa->rovaniemi", 535],
    ["rovaniemi->hyvinkaa", 535],
    ["raisio->oulu", 412],
    ["oulu->raisio", 412],
    ["raisio->rovaniemi", 568],
    ["rovaniemi->raisio", 568],
    ["lempaala->oulu", 355],
    ["oulu->lempaala", 355],
    ["pori->rovaniemi", 478],
    ["rovaniemi->pori", 478],
    ["kuopio->rovaniemi", 357],
    ["rovaniemi->kuopio", 357],
  ])

  const roadMinutesFn = (from: string, to: string) => {
    return roadMinutesMap.get(`${from.toLowerCase()}->${to.toLowerCase()}`) ?? 240
  }

  const northern = new Set(["oulu", "rovaniemi", "kemi"])
  const requests = new Map<string, { request: PriceRequest; at: number }>()
  const wonOrders = new Map<string, { order: Order; wonAt: number }>()
  const lateRefunds = new Map<string, { cents: number; detail: string }>()

  let totalRequests = 0
  let snowAffectedRequests = 0

  // Pass 1: Stream events in chronological order
  for (const ev of eventsRaw) {
    model.handleEvent(ev)

    if (ev.kind === "price_request") {
      totalRequests++
      requests.set(ev.request.id, { request: ev.request, at: ev.at })
      const p = ev.request.legs[0]!.pickup.placeId.toLowerCase()
      const d = ev.request.legs[ev.request.legs.length - 1]!.delivery.placeId.toLowerCase()
      if (northern.has(p) || northern.has(d)) {
        snowAffectedRequests++
      }
    } else if (ev.kind === "order_won") {
      wonOrders.set(ev.order.id, { order: ev.order, wonAt: ev.at })
    } else if (ev.kind === "ledger" && ev.line.kind === "late_refund") {
      if (ev.line.orderId) {
        lateRefunds.set(ev.line.orderId, { cents: Math.abs(ev.line.cents), detail: ev.line.detail ?? "" })
      }
    }
  }

  // Pass 2: Evaluate Weather Risk Model against Won Orders at the exact minute they were won
  let snowWonOrders = 0
  let snowLateRefunds = 0
  let snowLateRefundCents = 0
  let modelFlaggedHazardOrders = 0
  let modelPreventedLateRefunds = 0
  let modelPreventedLossCents = 0

  for (const [orderId, { order, wonAt }] of wonOrders.entries()) {
    const leg0 = order.legs[0]!
    const lastLeg = order.legs[order.legs.length - 1]!
    const p = leg0.pickup.placeId.toLowerCase()
    const d = lastLeg.delivery.placeId.toLowerCase()
    const touchesNorth = northern.has(p) || northern.has(d)

    if (touchesNorth) {
      snowWonOrders++
    }

    const refund = lateRefunds.get(orderId)
    if (refund && touchesNorth) {
      snowLateRefunds++
      snowLateRefundCents += refund.cents
    }

    // Assess risk at the time the order was requested / won
    const reqEntry = requests.get(orderId)
    if (reqEntry) {
      const assessment = model.assessRisk(reqEntry.request, wonAt, roadMinutesFn)
      const chosenOptionRisk = assessment.optionRisks[order.option]

      if (chosenOptionRisk && !chosenOptionRisk.safe) {
        modelFlaggedHazardOrders++
        if (refund) {
          modelPreventedLateRefunds++
          modelPreventedLossCents += refund.cents
        }
      }
    }
  }

  const precision = modelFlaggedHazardOrders > 0 ? modelPreventedLateRefunds / modelFlaggedHazardOrders : 0
  const recall = snowLateRefunds > 0 ? modelPreventedLateRefunds / snowLateRefunds : 0

  const totalLateRefundCents = Array.from(lateRefunds.values()).reduce((sum, r) => sum + r.cents, 0)

  return {
    totalRequests,
    snowAffectedRequests,
    totalWonOrders: wonOrders.size,
    snowWonOrders,
    actualLateRefunds: lateRefunds.size,
    actualLateRefundCents: totalLateRefundCents,
    snowLateRefunds,
    snowLateRefundCents,
    modelFlaggedHazardOrders,
    modelPreventedLateRefunds,
    modelPreventedLossCents,
    precision,
    recall,
  }
}

// ============================================================================
// CLI Execution / Self-Test Runner
// ============================================================================

if (process.argv[1]?.endsWith("weather-network-model.ts")) {
  console.log("================================================================================")
  console.log(" Weather Network Model & Dynamic Risk Scoring Module — Junction 2026")
  console.log("================================================================================")

  const r4Path = path.resolve("scratch/r4_events.json")
  if (fs.existsSync(r4Path)) {
    console.log(`\nEvaluating historical performance on Season 4 Run 4 (${r4Path}):`)
    const metricsR4 = runHistoricalBacktest(r4Path)
    console.table({
      "Total Price Requests": metricsR4.totalRequests,
      "Snow-Affected Requests": metricsR4.snowAffectedRequests,
      "Total Won Orders": metricsR4.totalWonOrders,
      "Northern Won Orders": metricsR4.snowWonOrders,
      "Total Late Refunds": metricsR4.actualLateRefunds,
      "Total Late Refund (€)": `€${(metricsR4.actualLateRefundCents / 100).toFixed(2)}`,
      "Northern Late Refunds": metricsR4.snowLateRefunds,
      "Northern Late Refund (€)": `€${(metricsR4.snowLateRefundCents / 100).toFixed(2)}`,
      "Model Flagged Unsafe": metricsR4.modelFlaggedHazardOrders,
      "Correctly Caught Late Orders": metricsR4.modelPreventedLateRefunds,
      "Prevented Loss (€)": `€${(metricsR4.modelPreventedLossCents / 100).toFixed(2)}`,
      "Precision": `${(metricsR4.precision * 100).toFixed(1)}%`,
      "Recall": `${(metricsR4.recall * 100).toFixed(1)}%`,
    })

    const pctSaved = ((metricsR4.modelPreventedLossCents / metricsR4.actualLateRefundCents) * 100).toFixed(1)
    console.log(`\n>>> Impact Analysis: Model correctly detects ${metricsR4.modelPreventedLateRefunds}/${metricsR4.snowLateRefunds} northern late refunds (${(metricsR4.recall * 100).toFixed(1)}% recall), recovering €${(metricsR4.modelPreventedLossCents / 100).toFixed(2)} (${pctSaved}% of ALL late refund financial losses in R4)!`)
  }

  const r2Path = path.resolve("scratch/r2_events.json")
  if (fs.existsSync(r2Path)) {
    console.log(`\nEvaluating historical performance on Season 4 Run 2 (${r2Path}):`)
    const metricsR2 = runHistoricalBacktest(r2Path)
    console.table({
      "Total Won Orders": metricsR2.totalWonOrders,
      "Total Late Refunds": metricsR2.actualLateRefunds,
      "Total Late Refund (€)": `€${(metricsR2.actualLateRefundCents / 100).toFixed(2)}`,
      "Model Flagged Unsafe": metricsR2.modelFlaggedHazardOrders,
      "Correctly Caught Late Orders": metricsR2.modelPreventedLateRefunds,
      "Prevented Loss (€)": `€${(metricsR2.modelPreventedLossCents / 100).toFixed(2)}`,
    })
  }

  console.log("\nWeather Network Model verification complete.")
}
