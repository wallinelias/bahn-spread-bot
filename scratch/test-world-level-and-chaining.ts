import { Client, type Audience, type DeskEvent, type DeskEventKind, type FeeStep, type Order, type PriceRequest, type StopRef, type TimeWindow } from "../spread.ts"
import { QuantitativeDesk, parseNoteFlags } from "../bot.ts"
import { loadStrategy, type StrategyConfig } from "../strategy-config.ts"
import { formatResultMarkdown, type BenchmarkResult } from "../experiment-runners.ts"

const HOUR = 60
const DAY = 24 * HOUR

const WAKE_ON = [
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
] as const

const undelivered = (order: Order): number[] =>
  order.legs.map((_, leg) => leg).filter((leg) => order.deliveredAt[leg] === null)

const withoutWindows = (stops: StopRef[], before: number): StopRef[] =>
  stops.map((stop) => (stop.window && stop.window.to < before ? { ...stop, window: undefined } : stop))

export interface CandidateOptions {
  lowWorldPriceAdapt?: boolean
  safeBackhaulChaining?: boolean
  exactTrustOnLateRefund?: boolean
}

export class CandidateDesk extends QuantitativeDesk {
  readonly opts: CandidateOptions
  readonly revenueCountedOnTime = new Set<string>()
  readonly trustBeforeRevenue = new Map<string, number>()

  constructor(
    world: any,
    level: number,
    now: number,
    map: any,
    roster: any[],
    strategy: StrategyConfig,
    opts: CandidateOptions = {},
  ) {
    super(world, level, now, map, roster, strategy)
    this.opts = opts
  }

  override async handle(event: DeskEvent): Promise<void> {
    if (this.opts.exactTrustOnLateRefund && event.kind === "ledger") {
      const { kind, cents, orderId } = event.line
      this.telemetry.ledgerBreakdownCents[kind] = (this.telemetry.ledgerBreakdownCents[kind] ?? 0) + cents
      if (kind === "revenue" && orderId) {
        const order = this.orders.get(orderId)
        if (order) {
          const allOnTime = order.deliveredAt.every((t) => t !== null && t <= order.deadline)
          const prevTrust = this.dealerTrust.get(order.dealerId) ?? 0
          this.trustBeforeRevenue.set(orderId, prevTrust)
          if (allOnTime) {
            this.revenueCountedOnTime.add(orderId)
            this.telemetry.onTimeDeliveries++
            this.dealerTrust.set(order.dealerId, Math.min(25, prevTrust + 1))
          } else {
            this.telemetry.lateDeliveries++
            this.dealerTrust.set(order.dealerId, Math.floor(prevTrust / 2))
          }
        }
      } else if (kind === "late_refund" && orderId) {
        if (this.revenueCountedOnTime.has(orderId)) {
          this.revenueCountedOnTime.delete(orderId)
          this.telemetry.onTimeDeliveries = Math.max(0, this.telemetry.onTimeDeliveries - 1)
          this.telemetry.lateDeliveries++
          const order = this.orders.get(orderId)
          if (order) {
            const prevTrust = this.trustBeforeRevenue.get(orderId) ?? (this.dealerTrust.get(order.dealerId) ?? 0)
            this.dealerTrust.set(order.dealerId, Math.floor(prevTrust / 2))
          }
        }
      }
      return
    }
    await super.handle(event)
  }

  override quote(request: PriceRequest): void {
    if (!this.opts.lowWorldPriceAdapt) {
      super.quote(request)
      return
    }

    // Temporarily adjust baseQuoteMultiplier when in a verified low-price world (like spread-3 / spread-2)
    // and only on safe corridors with plenty of local driver supply and healthy on-time buffer.
    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupDrivers = this.localDriverCount(leg0.pickup.placeId)
    const deliveryDrivers = this.localDriverCount(lastLeg.delivery.placeId)
    const waiting = this.waitingOrdersCount()
    const totalDrivers = Math.max(1, this.roster.length)
    const liveOnTime = this.liveOnTimeRatio()
    const maxWaitingAllowed = Math.max(4, Math.round(totalDrivers * this.strategy.maxActiveWaitingPerDriver))

    const quoted = this.telemetry.quotedToWin
    const overallWinRate = quoted > 0 ? this.telemetry.wonOrders / quoted : this.strategy.targetWinRate
    const recentWins = this.recentOutcomes.filter(Boolean).length
    const recentWinRate = this.recentOutcomes.length >= 10 ? recentWins / this.recentOutcomes.length : overallWinRate

    const origBaseQuote = this.strategy.baseQuoteMultiplier
    if (
      quoted >= 25 &&
      pickupDrivers >= 3 &&
      deliveryDrivers >= 2 &&
      waiting < maxWaitingAllowed * 0.45 &&
      liveOnTime >= 0.945 &&
      this.urgent.size <= 3
    ) {
      if (overallWinRate < 0.16 && recentWinRate < 0.18) {
        this.strategy.baseQuoteMultiplier = origBaseQuote - 0.055
      } else if (overallWinRate < 0.22 && recentWinRate < 0.22) {
        this.strategy.baseQuoteMultiplier = origBaseQuote - 0.03
      }
    }

    try {
      super.quote(request)
    } finally {
      this.strategy.baseQuoteMultiplier = origBaseQuote
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
    this.dealerPriceOffset.set(order.dealerId, Math.min(0.18, prevDealerOffset + 0.015))

    if (this.targetedRequests.has(order.id)) {
      this.recentOutcomes.push(true)
      if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
    }
    if (this.opts.safeBackhaulChaining && this.level >= 3 && (await this.trySafeChainOrder(order))) {
      return
    }
    await this.post(order, undelivered(order))
  }

  async trySafeChainOrder(orderB: Order): Promise<boolean> {
    if (orderB.legs.length !== 1) return false
    const legB = orderB.legs[0]!
    if (legB.pickup.privateAddress || legB.delivery.privateAddress) return false
    if (orderB.lastPickupAt - this.now < 16 * HOUR) return false
    const reqB = this.requests.get(orderB.id)
    if (!reqB) return false
    const flagsB = parseNoteFlags(reqB.note, this.strategy.flags.noteNLP)
    if (flagsB.summerTyres || flagsB.hasTightDeadline) return false

    for (const [gigId, postAction] of this.posts.entries()) {
      if (this.booked.has(gigId) || postAction.stops.length !== 2) continue
      const orderAId = postAction.stops[0]!.orderId
      const orderA = this.orders.get(orderAId)
      if (!orderA || orderA.id === orderB.id || orderA.status === "cancelled" || orderA.legs.length !== 1) continue
      if (this.urgent.has(orderA.id) || this.legGigs.get(orderA.id)?.get(0) !== gigId) continue
      if (orderA.lastPickupAt - this.now < 16 * HOUR) continue
      const legA = orderA.legs[0]!
      if (legA.pickup.privateAddress || legA.delivery.privateAddress) continue
      const reqA = this.requests.get(orderA.id)
      if (!reqA) continue
      const flagsA = parseNoteFlags(reqA.note, this.strategy.flags.noteNLP)
      if (flagsA.summerTyres || flagsA.hasTightDeadline) continue

      const driveA = this.roadMinutes(legA.pickup.placeId, legA.delivery.placeId)
      const driveB = this.roadMinutes(legB.pickup.placeId, legB.delivery.placeId)
      const gapAB = legA.delivery.placeId === legB.pickup.placeId ? 0 : this.roadMinutes(legA.delivery.placeId, legB.pickup.placeId)
      const gapBA = legB.delivery.placeId === legA.pickup.placeId ? 0 : this.roadMinutes(legB.delivery.placeId, legA.pickup.placeId)

      let first: Order, second: Order
      if (gapAB === 0 && driveA + driveB <= 390) {
        first = orderA
        second = orderB
      } else if (gapBA === 0 && driveB + driveA <= 390) {
        first = orderB
        second = orderA
      } else {
        continue
      }

      const stopA = postAction.stops
      // Ensure windows don't conflict
      const firstLeg = first.legs[0]!
      const secondLeg = second.legs[0]!
      const earliestFirstStart = Math.max(this.now + 30, firstLeg.pickup.window.from)
      const firstFinish = earliestFirstStart + this.roadMinutes(firstLeg.pickup.placeId, firstLeg.delivery.placeId) + 30
      if (firstFinish > second.lastPickupAt - 180) continue
      void stopA

      if (!(await this.withdraw(orderA.id))) continue
      const req1 = this.requests.get(first.id)!
      const req2 = this.requests.get(second.id)!
      const f1 = parseNoteFlags(req1.note, this.strategy.flags.noteNLP)
      const f2 = parseNoteFlags(req2.note, this.strategy.flags.noteNLP)

      // Post individual stops temporarily to extract exact stopsFor windows
      await this.post(first, [0])
      const action1 = this.outbox.pop() as any
      this.telemetry.totalGigsPosted--
      await this.post(second, [0])
      const action2 = this.outbox.pop() as any
      this.telemetry.totalGigsPosted--

      const combinedStops: StopRef[] = [...action1.stops, ...action2.stops]
      const audience: Audience = {
        experienced: firstLeg.car.premium || secondLeg.car.premium,
        manualLicence: f1.manualLicence || f2.manualLicence,
      }

      const combinedRef = req1.referenceFeeCents + req2.referenceFeeCents
      const minLastPickup = Math.min(first.lastPickupAt, second.lastPickupAt)
      const openFee = Math.max(100, Math.round(combinedRef * 0.86))
      const midFee = Math.max(openFee, Math.round(combinedRef * 1.04))
      const peakFee = Math.max(midFee, Math.round(combinedRef * 1.24))
      const urgentPeak = Math.max(peakFee, Math.round(combinedRef * 1.95))

      const rawSteps: FeeStep[] = [
        { at: this.now, feeCents: openFee },
        { at: this.now + 240, feeCents: midFee },
        { at: this.now + 420, feeCents: peakFee },
      ]
      const escalateStart = Math.max(this.now + 120, minLastPickup - 300)
      for (let j = 1; j <= 4; j++) {
        const frac = j / 4
        rawSteps.push({
          at: escalateStart + (j - 1) * 45,
          feeCents: Math.max(peakFee, Math.round(peakFee + frac * (urgentPeak - peakFee))),
        })
      }
      const schedule: FeeStep[] = []
      for (const s of rawSteps) {
        const prev = schedule[schedule.length - 1]
        if (!prev) schedule.push(s)
        else if (s.at > prev.at) schedule.push({ at: s.at, feeCents: Math.max(prev.feeCents, s.feeCents) })
      }

      this.outbox.push({ type: "post", stops: combinedStops, audience, schedule })
      this.telemetry.totalGigsPosted++
      await this.send()
      if (this.gigsOf(orderA.id).length === 0) await this.post(orderA, [0])
      if (this.gigsOf(orderB.id).length === 0) await this.post(orderB, [0])
      return true
    }
    return false
  }

  // If a multi-order chained gig expires, loses its driver, or hits deadline_close unbooked, split it back into individual orders!
  override repost(gigId: string): void {
    const action = this.posts.get(gigId)
    if (!action) return
    const orderIds = [...new Set(action.stops.map((s) => s.orderId))]
    if (orderIds.length > 1) {
      for (const { orderId, leg } of action.stops) this.legGigs.get(orderId)?.delete(leg)
      for (const oid of orderIds) {
        const o = this.orders.get(oid)
        if (o && o.status !== "cancelled" && undelivered(o).length > 0) {
          void this.post(o, undelivered(o))
        }
      }
      return
    }
    super.repost(gigId)
  }

  override async onGigLostDriver(orderId: string, gigId: string): Promise<void> {
    const action = this.posts.get(gigId)
    if (action) {
      const orderIds = [...new Set(action.stops.map((s) => s.orderId))]
      if (orderIds.length > 1) {
        this.legGigs.forEach((m) => {
          for (const [l, g] of m.entries()) if (g === gigId) m.delete(l)
        })
        this.outbox.push({ type: "withdraw", gigId })
        for (const oid of orderIds) {
          const o = this.orders.get(oid)
          if (o && o.status !== "cancelled" && undelivered(o).length > 0) {
            await this.post(o, undelivered(o))
          }
        }
        return
      }
    }
    await super.onGigLostDriver(orderId, gigId)
  }
}

export async function benchmarkCandidate(
  name: string,
  strategy: StrategyConfig,
  opts: CandidateOptions,
  seeds = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"],
  concurrency = 1,
): Promise<BenchmarkResult> {
  const client = new Client()
  const map = await client.map()
  const seedResults: BenchmarkResult["seedResults"] = []
  const queue = [...seeds]
  const origLog = console.log
  console.log = () => {}

  async function worker() {
    while (queue.length > 0) {
      const seed = queue.shift()!
      const run = await client.create(8, { seed, board: false })
      try {
        const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
        const desk = new CandidateDesk(run, 8, now, map, roster, { ...strategy }, opts)
        while (desk.now < endsAt) {
          const day = Math.floor(desk.now / DAY)
          const midnight = (day + 1) * DAY
          const actions = desk.outbox.splice(0)
          const step = await run.advance({ untilEvent: WAKE_ON as any, max: Math.min(endsAt, midnight), actions })
          desk.readResults(actions, step.results)
          desk.now = step.now
          for (const event of step.events) await desk.handle(event)
        }
        const score = await run.score()
        desk.finalizeTelemetry()
        const quoted = desk.telemetry.quotedToWin || 1
        seedResults.push({
          seed,
          marginEur: Number((score.marginCents / 100).toFixed(2)),
          onTimeShare: Number(score.onTimeShare.toFixed(4)),
          wonOrders: score.wonOrders,
          winRate: Number((score.wonOrders / quoted).toFixed(4)),
          gigDrops: desk.telemetry.gigDrops ?? 0,
          lateDeliveries: desk.telemetry.lateDeliveries ?? 0,
          deadlineWarnings: desk.telemetry.deadlineWarnings ?? 0,
          ranked: score.ranked,
        })
        origLog(`[candidate] ${name}: finished ${seed} -> €${(score.marginCents / 100).toFixed(2)} | OT ${(score.onTimeShare * 100).toFixed(1)}%`)
      } finally {
        await run.delete().catch(() => {})
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, seeds.length) }, worker))
  console.log = origLog
  seedResults.sort((a, b) => seeds.indexOf(a.seed) - seeds.indexOf(b.seed))
  const totalMargin = seedResults.reduce((s, r) => s + r.marginEur, 0)
  const avgMargin = totalMargin / seedResults.length
  const avgOT = seedResults.reduce((s, r) => s + r.onTimeShare, 0) / seedResults.length
  const minOT = Math.min(...seedResults.map((r) => r.onTimeShare))
  const avgWon = seedResults.reduce((s, r) => s + r.wonOrders, 0) / seedResults.length
  return {
    name,
    toggles: opts as any,
    seeds,
    seedResults,
    avgMarginEur: Number(avgMargin.toFixed(2)),
    totalMarginEur: Number(totalMargin.toFixed(2)),
    avgOnTimeShare: Number(avgOT.toFixed(4)),
    minOnTimeShare: Number(minOT.toFixed(4)),
    avgWonOrders: Number(avgWon.toFixed(1)),
    allRanked: seedResults.every((r) => r.ranked && r.onTimeShare >= 0.90),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const strat = loadStrategy()
  console.log("=== Testing Candidate B: Low-World-Price Safe Corridor Adaptation + Exact Trust ===")
  const resB = await benchmarkCandidate("Candidate B (Low-World-Price Adaptation + Exact Trust)", strat, {
    lowWorldPriceAdapt: true,
    exactTrustOnLateRefund: true,
  })
  console.log(formatResultMarkdown(resB))

  console.log("=== Testing Candidate C: Safe Backhaul Chaining + Low-World-Price Adaptation ===")
  const resC = await benchmarkCandidate("Candidate C (Safe Backhaul Chaining + Low-World-Price Adaptation)", strat, {
    lowWorldPriceAdapt: true,
    safeBackhaulChaining: true,
    exactTrustOnLateRefund: true,
  })
  console.log(formatResultMarkdown(resC))
}
