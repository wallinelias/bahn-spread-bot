import { Client } from "./spread.ts"

const client = new Client()
const w4 = client.world("wd853cce8d9e84a5a0237")

try {
  const snap = await w4.snapshot()
  console.log("Snapshot ok! Keys:", Object.keys(snap), "orders:", snap.orders?.length, "gigs:", snap.gigs?.length)
} catch (e: any) {
  console.log("Snapshot failed:", e.message)
}

try {
  const ev = await w4.events()
  console.log("Events ok! Count:", ev.length)
} catch (e: any) {
  console.log("Events failed:", e.message)
}

try {
  const ros = await w4.roster()
  console.log("Roster ok! Count:", ros.length)
} catch (e: any) {
  console.log("Roster failed:", e.message)
}
