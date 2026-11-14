import { Client } from "./spread.ts"

const client = new Client()
const board = await client.board(8)
const myTeam = board.current.teams.find((t: any) => t.team === "what-s-the-wifi")
console.log("My team:", JSON.stringify(myTeam, null, 2))
