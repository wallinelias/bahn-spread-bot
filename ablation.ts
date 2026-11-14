import fs from "node:fs"
import { parseArgs } from "node:util"
import { runSimulationRound } from "./bot.ts"
import { loadStrategy, DEFAULT_FLAGS, type Flags, type StrategyConfig } from "./strategy-config.ts"

/**
 * On/off ablation benchmark.
 *   node --env-file=.env ablation.ts --seeds 5 --concurrency 6
 * Runs the current strategy (all ideas ON) and one variant per idea turned OFF, on the same Level 8 seeds
 * (spread-1..spread-N), with no Gemini tuning and nothing persisted, so differences come from the idea only.
 */
const { values: args } = parseArgs({
  options: {
    seeds: { type: "string", default: "5" },
    concurrency: { type: "string", default: "6" },
    out: { type: "string", default: "data/ablation.json" },
    only: { type: "string" },
  },
})

const seedCount = Number(args.seeds)
const concurrency = Number(args.concurrency)
const base: StrategyConfig = loadStrategy()
const seeds = Array.from({ length: seedCount }, (_, i) => `spread-${i + 1}`)
const flagNames = Object.keys(DEFAULT_FLAGS) as (keyof Flags)[]

const variants: { name: string; strategy: StrategyConfig }[] = [
  { name: "ALL ON (baseline)", strategy: { ...base, flags: { ...DEFAULT_FLAGS } } },
  ...flagNames.map((f) => ({
    name: DEFAULT_FLAGS[f] ? `OFF: ${f}` : `ON: ${f}`,
    strategy: { ...base, flags: { ...DEFAULT_FLAGS, [f]: !DEFAULT_FLAGS[f] } },
  })),
]
const onlyTerms = args.only ? args.only.split(",").map((s) => s.trim()) : null
const selected = onlyTerms ? variants.filter((v) => onlyTerms.some((t) => v.name.includes(t))) : variants

type Result = { variant: string; seed: string; marginCents: number; onTimeShare: number; wonOrders: number; ranked: boolean; error?: string }
const results: Result[] = []
const jobs = selected.flatMap((v) => seeds.map((seed) => ({ v, seed })))

const realLog = console.log
console.log = () => {}
let done = 0
async function worker(): Promise<void> {
  while (jobs.length) {
    const job = jobs.shift()!
    let attempt = 0
    while (true) {
      try {
        const s = await runSimulationRound({ level: 8, seed: job.seed, tuneWithGemini: false, persist: false, strategyOverride: job.v.strategy })
        results.push({ variant: job.v.name, seed: job.seed, marginCents: s.score.marginCents, onTimeShare: s.score.onTimeShare, wonOrders: s.score.wonOrders, ranked: s.score.ranked })
        break
      } catch (e) {
        if (++attempt >= 3) {
          results.push({ variant: job.v.name, seed: job.seed, marginCents: 0, onTimeShare: 0, wonOrders: 0, ranked: false, error: (e as Error).message })
          break
        }
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    done++
    realLog(`progress ${done}/${selected.length * seeds.length}`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
console.log = realLog

fs.mkdirSync("data", { recursive: true })
fs.writeFileSync(args.out!, JSON.stringify({ strategyVersion: base.version, seeds, results }, null, 2))

const eur = (c: number) => `€${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
const rows = selected.map((v) => {
  const r = results.filter((x) => x.variant === v.name && !x.error)
  const n = r.length || 1
  return {
    name: v.name,
    n: r.length,
    avgMargin: r.reduce((a, x) => a + x.marginCents, 0) / n,
    avgOnTime: r.reduce((a, x) => a + x.onTimeShare, 0) / n,
    minOnTime: Math.min(...r.map((x) => x.onTimeShare), 1),
    ranked: r.filter((x) => x.ranked).length,
    avgOrders: r.reduce((a, x) => a + x.wonOrders, 0) / n,
  }
})
const baseRow = rows.find((r) => r.name.startsWith("ALL ON"))
console.log(`\nStrategy v${base.version}, Level 8, seeds ${seeds.join(", ")}\n`)
console.log("| Variant | Runs | Avg margin/week | Δ vs baseline | Avg on-time | Worst on-time | Ranked | Avg orders |")
console.log("|---|---|---|---|---|---|---|---|")
for (const r of rows) {
  const d = baseRow ? r.avgMargin - baseRow.avgMargin : 0
  console.log(`| ${r.name} | ${r.n} | ${eur(r.avgMargin)} | ${r.name === baseRow?.name ? "-" : (d >= 0 ? "+" : "") + eur(d)} | ${(r.avgOnTime * 100).toFixed(1)}% | ${(r.minOnTime * 100).toFixed(1)}% | ${r.ranked}/${r.n} | ${r.avgOrders.toFixed(0)} |`)
}
const errs = results.filter((r) => r.error)
if (errs.length) console.log(`\n${errs.length} runs failed, e.g.: ${errs[0]!.error}`)
