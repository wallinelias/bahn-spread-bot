import { Client } from "../spread.ts"
import { QuantitativeDesk } from "../bot.ts"
import { loadStrategy } from "../strategy-config.ts"

const client = new Client()
const map = await client.map()
const strategy = loadStrategy()

// Class that removes the dealer ratchet
class DeskNoRatchet extends QuantitativeDesk {
  override quote(request: any): void {
    // Save original dealerWins
    const savedWins = this.dealerWins.get(request.dealerId)
    // Temporarily set dealerWins to 0 so ratchet does not fire
    this.dealerWins.set(request.dealerId, 0)
    super.quote(request)
    if (savedWins !== undefined) {
      this.dealerWins.set(request.dealerId, savedWins)
    } else {
      this.dealerWins.delete(request.dealerId)
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

console.log("Running spread-1 with DeskNoRatchet...")
const scoreNoRatchet = await runSeed("spread-1", DeskNoRatchet)
console.log(`DeskNoRatchet on spread-1: Margin €${(scoreNoRatchet.marginCents / 100).toFixed(2)} | OT ${(scoreNoRatchet.onTimeShare * 100).toFixed(1)}% | Won ${scoreNoRatchet.wonOrders}`)

console.log("Running spread-1 with QuantitativeDesk (with ratchet)...")
const scoreWithRatchet = await runSeed("spread-1", QuantitativeDesk)
console.log(`QuantitativeDesk on spread-1: Margin €${(scoreWithRatchet.marginCents / 100).toFixed(2)} | OT ${(scoreWithRatchet.onTimeShare * 100).toFixed(1)}% | Won ${scoreWithRatchet.wonOrders}`)
