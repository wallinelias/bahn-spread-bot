import { parseArgs } from "node:util"
import { Client, SpreadError } from "./spread.ts"
import { runSimulationRound } from "./bot.ts"
import { loadStrategy, saveStrategy, type RoundSummary, type StrategyConfig } from "./strategy-config.ts"

/**
 * Automated Multi-Seed Self-Tuning Trainer & Official Ranking Round Runner.
 *
 * Modes:
 *   1. `node --env-file=.env auto-trainer.ts --sweep 3`
 *      Runs a multi-seed practice sweep, invoking Gemini 4 Hydrogen after each seed and
 *      checkpointing the Champion Strategy whenever On-Time >= 92.5% and Margin improves.
 *   2. `node --env-file=.env auto-trainer.ts --board-round`
 *      Automatically plays all remaining worlds (1..5) of the current Level 8 Official Ranking Round
 *      so our team posts a complete, ranked 5-world score on https://spread.bahnexpress.com/leaderboard.
 */
export async function runAutoSweep(
  seeds: string[] = ["spread-1", "spread-2", "spread-3"],
  level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 8,
  onStep?: (msg: string, summary?: RoundSummary) => void,
): Promise<{ champion: StrategyConfig; summaries: RoundSummary[] }> {
  let champion = loadStrategy()
  let bestScoreMetric = -Infinity
  const summaries: RoundSummary[] = []

  for (const seed of seeds) {
    onStep?.(`[Auto-Trainer] Running Level ${level} practice world on seed "${seed}"...`)
    const summary = await runSimulationRound({
      level,
      seed,
      board: false,
      tuneWithGemini: true,
    })
    summaries.push(summary)

    const { marginCents, onTimeShare, ranked } = summary.score
    // Score metric rewards high margin while heavily penalizing <92.5% on-time
    const safetyBonus = onTimeShare >= 0.925 ? 0 : -5_000_000 * (0.925 - onTimeShare)
    const metric = marginCents + safetyBonus

    if (ranked && onTimeShare >= 0.92 && metric > bestScoreMetric) {
      bestScoreMetric = metric
      champion = summary.geminiTuning?.nextStrategy ?? loadStrategy()
      onStep?.(
        `[Auto-Trainer] Seed "${seed}" complete: Margin €${(marginCents / 100).toFixed(2)}, On-Time ${(onTimeShare * 100).toFixed(1)}% (RANKED). Promoted Strategy v${champion.version} as Champion.`,
        summary,
      )
    } else if (!ranked || onTimeShare < 0.915) {
      // Revert to champion and tighten safety buffer slightly
      const safeChampion: StrategyConfig = {
        ...champion,
        version: champion.version + 1,
        updatedAt: new Date().toISOString(),
        maxActiveWaitingPerDriver: Number(Math.max(0.28, champion.maxActiveWaitingPerDriver - 0.04).toFixed(3)),
        baseFeeMultiplier: Number(Math.min(1.25, champion.baseFeeMultiplier + 0.03).toFixed(3)),
      }
      champion = safeChampion
      saveStrategy(safeChampion)
      onStep?.(
        `[Auto-Trainer] Seed "${seed}" had tight On-Time (${(onTimeShare * 100).toFixed(1)}%). Hardened Champion Strategy to v${safeChampion.version}.`,
        summary,
      )
    } else {
      onStep?.(
        `[Auto-Trainer] Seed "${seed}" complete: Margin €${(marginCents / 100).toFixed(2)}, On-Time ${(onTimeShare * 100).toFixed(1)}%.`,
        summary,
      )
    }
  }

  saveStrategy(champion)
  return { champion, summaries }
}

export async function runOfficialBoardRound(
  level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = 8,
  maxRuns = 5,
  onStep?: (msg: string, summary?: RoundSummary) => void,
): Promise<RoundSummary[]> {
  const summaries: RoundSummary[] = []
  for (let i = 0; i < maxRuns; i++) {
    try {
      onStep?.(`[Ranking Board Auto-Pilot] Starting Official Level ${level} Ranking Run (${i + 1}/${maxRuns})...`)
      const summary = await runSimulationRound({
        level,
        board: true,
        tuneWithGemini: false,
      })
      summaries.push(summary)
      onStep?.(
        `[Ranking Board Auto-Pilot] Completed Board Run: Margin €${(summary.score.marginCents / 100).toFixed(2)} | On-Time ${(summary.score.onTimeShare * 100).toFixed(1)}% (${summary.score.ranked ? "RANKED" : "UNRANKED"})`,
        summary,
      )
    } catch (err) {
      if (err instanceof SpreadError && err.status === 409) {
        onStep?.(`[Ranking Board Auto-Pilot] All 5 runs of the current Ranking Round are complete (or no round active): ${err.message}`)
        break
      }
      throw err
    }
  }
  return summaries
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      sweep: { type: "string" },
      "board-round": { type: "boolean" },
      level: { type: "string", default: "8" },
    },
  })
  const level = Number(args.level) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  if (args["board-round"]) {
    const runs = await runOfficialBoardRound(level, 5, (msg) => console.log(msg))
    console.log(`\nFinished ${runs.length} Official Ranking Board runs.`)
    const client = new Client()
    const board = await client.board(level)
    const top = board.current?.teams?.slice(0, 6) ?? []
    console.log("\n=== LIVE LEVEL 8 PRACTICE LEADERBOARD ===")
    for (const t of top) {
      const m = t.marginCents !== null ? `€${(t.marginCents / 100).toFixed(2)}` : "in progress"
      const ot = t.onTimeShare !== null ? `${(t.onTimeShare * 100).toFixed(1)}%` : "-"
      console.log(`Rank ${t.rank ?? "-"} | ${t.name.padEnd(20)} | Played: ${t.played}/5 | Ranked: ${t.ranked} | Total Margin: ${m} | On-Time: ${ot}`)
    }
  } else {
    const count = Number(args.sweep || 3)
    const seeds = Array.from({ length: count }, (_, idx) => `spread-${idx + 1}`)
    await runAutoSweep(seeds, level, (msg) => console.log(msg))
  }
}
