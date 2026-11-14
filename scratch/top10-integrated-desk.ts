import type { DeskEvent, FeeStep, Order, PriceRequest } from "../spread.ts"
import { parseNoteFlags } from "../bot.ts"
import type { StrategyConfig } from "../strategy-config.ts"
import {
  BayesianCompetitorPricer,
  ZeroHoldoutFeeScheduler,
  type DeliveryOptionKind,
  type PricingContext,
  type Top10PricerConfig,
} from "./top10-pricer-and-fee.ts"
import {
  Top10ChainingDesk,
  buildChainOrderContext,
  findQuoteChainSynergy,
  type ChainOrderContext,
  type ChainingConfig,
} from "./top10-chaining.ts"

const HOUR = 60
const DAY = 24 * HOUR

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
    if (this.chainConfig.enabled && this.chainConfig.quoteSynergyEnabled) {
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
    const req = this.requests.get(order.id)!
    const pickupPlace = order.legs[0]!.pickup.placeId
    const deliveryPlace = order.legs[order.legs.length - 1]!.delivery.placeId
    const isUrgent = this.urgent.has(order.id) || Math.max(0, order.lastPickupAt - this.now) <= 4.5 * HOUR
    const lastBookedFeeCents = this.activeRepriceDropFloor.get(order.id)

    return this.feeScheduler.buildSchedule({
      now: this.now,
      order,
      referenceFeeCents: req.referenceFeeCents,
      carsInGig: cars,
      pickupDrivers: this.localDriverCount(pickupPlace),
      deliveryDrivers: this.localDriverCount(deliveryPlace),
      isUrgent,
      lastBookedFeeCents,
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
      this.outbox.push({ type: "offer", gigId, driverId: c.driverId, feeCents: c.feeCents })
      this.offeredPairs.add(`${gigId}:${c.driverId}`)
      this.driverOffersByDay.set(`${day}:${c.driverId}`, (this.driverOffersByDay.get(`${day}:${c.driverId}`) ?? 0) + 1)
      this.gigOpenOffers.set(gigId, (this.gigOpenOffers.get(gigId) ?? 0) + 1)
      this.telemetry.totalDirectOffers++
    }
  }
}
