import { Client } from "./spread.ts"
import { writeFileSync, mkdirSync } from "node:fs"

const client = new Client()

console.log("Fetching data for Run 4 (wd853cce8d9e84a5a0237) and Run 2 (wf0dbca2fbe4c65afb1ae)...")

const [w4Snap, w4Events, w4Roster] = await Promise.all([
  client.world("wd853cce8d9e84a5a0237").snapshot(),
  client.world("wd853cce8d9e84a5a0237").events(),
  client.world("wd853cce8d9e84a5a0237").roster(),
])

const [w2Snap, w2Events, w2Roster] = await Promise.all([
  client.world("wf0dbca2fbe4c65afb1ae").snapshot(),
  client.world("wf0dbca2fbe4c65afb1ae").events(),
  client.world("wf0dbca2fbe4c65afb1ae").roster(),
])

console.log(`Run 4: ${w4Events.length} events, ${w4Snap.orders.length} orders, ${w4Snap.gigs.length} gigs, ${w4Roster.length} drivers`)
console.log(`Run 2: ${w2Events.length} events, ${w2Snap.orders.length} orders, ${w2Snap.gigs.length} gigs, ${w2Roster.length} drivers`)

// Let's summarize event types
function summarizeEvents(events: any[]) {
  const counts: Record<string, number> = {}
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] || 0) + 1
  }
  return counts
}

console.log("\n--- Event Counts Run 4 ---")
console.table(summarizeEvents(w4Events))

console.log("\n--- Event Counts Run 2 ---")
console.table(summarizeEvents(w2Events))

// Save events to scratch for fast querying
mkdirSync("./scratch", { recursive: true })
writeFileSync("./scratch/r4_events.json", JSON.stringify(w4Events))
writeFileSync("./scratch/r4_snap.json", JSON.stringify(w4Snap))
writeFileSync("./scratch/r4_roster.json", JSON.stringify(w4Roster))
writeFileSync("./scratch/r2_events.json", JSON.stringify(w2Events))
writeFileSync("./scratch/r2_snap.json", JSON.stringify(w2Snap))
writeFileSync("./scratch/r2_roster.json", JSON.stringify(w2Roster))

console.log("\nSaved data to ./scratch/")
