import { readFileSync } from "node:fs"

const runs = JSON.parse(readFileSync("./data/runs.json", "utf-8"))
console.log("Total entries in runs.json:", runs.length)

const r4 = runs.find((r: any) => r.worldId === "wd853cce8d9e84a5a0237")
const r2 = runs.find((r: any) => r.worldId === "wf0dbca2fbe4c65afb1ae")

console.log("=== RUN 4 IN RUNS.JSON ===")
console.log(JSON.stringify(r4, null, 2))

console.log("=== RUN 2 IN RUNS.JSON ===")
console.log(JSON.stringify(r2, null, 2))
