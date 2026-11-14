import { Client } from "./spread.ts"

const client = new Client()
const board = await client.board(8)
const bob = board.current.teams.find((t: any) => t.team === "bob-the-builders")
const house = board.current.teams.find((t: any) => t.team === "house-strong")

console.log("Bob keys:", Object.keys(bob || {}))
console.log("Bob run 0:", bob?.runs[0])
console.log("House run 0:", house?.runs[0])
