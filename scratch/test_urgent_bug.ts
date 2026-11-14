import { Client } from "../spread.ts"
import { QuantitativeDesk } from "../bot.ts"
import { loadStrategy } from "../strategy-config.ts"

function undelivered(order: any): number[] {
  return order.deliveredAt
    .map((at: any, leg: number) => (at === null ? leg : null))
    .filter((x: any): x is number => x !== null)
}

const client = new Client()
const map = await client.map()
const strategy = loadStrategy()

class DeskCleanUrgent extends QuantitativeDesk {
  override delivered(orderId: string, leg: number, at: number, placeId: string, gigId: string): void {
    super.delivered(orderId, leg, at, placeId, gigId)
    const order = this.orders.get(orderId)
    if (order && undelivered(order).length === 0) {
      this.urgent.delete(orderId)
    }
  }

  override async handle(event: any): Promise<void> {
    await super.handle(event)
    if (event.kind === "gig_booked") {
      const orderId = this.gigOrder.get(event.gigId)
      if (orderId) {
        const gigs = this.gigsOf(orderId)
        if (gigs.length > 0 && gigs.every((g) => this.booked.has(g))) {
          this.urgent.delete(orderId)
        }
      }
    }
  }
}

async function runSeed(seed: string, DeskClass: typeof QuantitativeDesk) {
  const run = await client.create(8, { seed, board: false })
  const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
  const desk = new DeskClass(run, 8, now, map, roster, strategy)
  const WAKE_ON = ["price_request", "order_won", "order_lost", "order_changed", "order_cancelled", "visit_failed", "gig_expired", "gig_dropped", "no_show", "driver_late", "deadline_close"]

  while (desk.now < endsAt) {
    const day = Math.floor(desk.now / 1440)
    const midnight = (day + 1) * 1440
    const actions = desk.outbox.splice(0)
    const step = await run.advance({ untilEvent: WAKE_ON as any, max: Math.min(endsAt, midnight), actions })
    desk.readResults(actions, step.results)
    desk.now = step.now
    for (const e of step.events) await desk.handle(e)
  }
  const score = await run.score()
  await run.delete().catch(() => {})
  return score
}

console.log("Testing DeskCleanUrgent on spread-1...")
const sClean = await runSeed("spread-1", DeskCleanUrgent)
console.log(`Clean Urgent on spread-1: Margin €${(sClean.marginCents / 100).toFixed(2)} | OT ${(sClean.onTimeShare * 100).toFixed(1)}% | Won ${sClean.wonOrders}`)

console.log("Testing DeskCleanUrgent on spread-5...")
const sClean5 = await runSeed("spread-5", DeskCleanUrgent)
console.log(`Clean Urgent on spread-5: Margin €${(sClean5.marginCents / 100).toFixed(2)} | OT ${(sClean5.onTimeShare * 100).toFixed(1)}% | Won ${sClean5.wonOrders}`)
