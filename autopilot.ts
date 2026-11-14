/**
 * 24/7 Autonomous Watchdog, Hill-Climber & Competition Auto-Pilot (`autopilot.ts`)
 * ================================================================================
 * Run with:
 *   caffeinate -dimsu npm run autopilot
 *
 * What it does continuously until Sunday 10:00 AM:
 * 1. Checks if a Test Final (Saturday 14:00 / 20:00) or Sunday 08:00 AM Final is open (`client.final()`).
 *    If open and not ended, immediately plays the Final via WebSocket with auto-reconnect!
 * 2. Checks if a new Official Level 8 Ranking Round (`client.board(8)`) has unplayed runs (< 5 runs).
 *    If yes, automatically plays all remaining runs so our team stays ranked on every leaderboard!
 * 3. Between ranking rounds, runs continuous multi-seed practice hill-climbing + Gemini 4 Hydrogen
 *    self-tuning, promoting any strategy that achieves >= 93.0% On-Time and higher Gross Margin.
 */

import { Client, SpreadError } from "./spread.ts"
import { runSimulationRound } from "./bot.ts"
import { runAutoSweep, runOfficialBoardRound } from "./auto-trainer.ts"
import { loadStrategy, saveStrategy, type StrategyConfig } from "./strategy-config.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function jitter(val: number, scale: number, min: number, max: number): number {
  const delta = (Math.random() * 2 - 1) * scale
  return Number(Math.min(max, Math.max(min, val + delta)).toFixed(3))
}

function mutateStrategy(base: StrategyConfig): StrategyConfig {
  return {
    ...base,
    version: base.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "manual",
    baseQuoteMultiplier: jitter(base.baseQuoteMultiplier, 0.03, 1.28, 1.58),
    sameDayQuotePremium: jitter(base.sameDayQuotePremium, 0.02, 0.08, 0.26),
    maxActiveWaitingPerDriver: jitter(base.maxActiveWaitingPerDriver, 0.04, 0.28, 0.55),
    baseFeeMultiplier: jitter(base.baseFeeMultiplier, 0.025, 0.98, 1.24),
    urgentFeeMultiplier: jitter(base.urgentFeeMultiplier, 0.04, 1.60, 2.05),
    scarcityTownFeeBoost: jitter(base.scarcityTownFeeBoost, 0.02, 0.10, 0.28),
  }
}

async function checkAndPlayFinal(client: Client): Promise<boolean> {
  try {
    const finalInfo = await client.final()
    const world = client.world(finalInfo.worldId)
    const snap = await world.snapshot()
    if (snap.now < snap.endsAt) {
      console.log(`\n🚨 [AUTOPILOT] LIVE FINAL / TEST FINAL DETECTED (World ${finalInfo.worldId}, startsAt=${finalInfo.startsAt})!`)
      await runSimulationRound({ final: true, tuneWithGemini: false })
      console.log(`✅ [AUTOPILOT] Completed Final World ${finalInfo.worldId}!`)
      return true
    }
  } catch (err) {
    if (!(err instanceof SpreadError && err.status === 404)) {
      console.warn(`[AUTOPILOT] Final check warning: ${(err as Error).message}`)
    }
  }
  return false
}

async function checkAndPlayRankingBoard(): Promise<boolean> {
  try {
    const summaries = await runOfficialBoardRound(8, 5, (msg) => console.log(msg))
    if (summaries.length > 0) {
      console.log(`✅ [AUTOPILOT] Finished ${summaries.length} new Official Ranking Board runs!`)
      return true
    }
  } catch (err) {
    console.warn(`[AUTOPILOT] Ranking board check warning: ${(err as Error).message}`)
  }
  return false
}

const VERIFICATION_SEEDS = ["spread-1", "spread-2", "spread-3", "spread-4", "spread-5"] as const
const MIN_SEED_ON_TIME = 0.93

interface FiveSeedEval {
  avgMarginCents: number
  minOnTimeShare: number
  avgOnTimeShare: number
  allRankedAndSafe: boolean
}

async function evaluateFiveSeeds(client: Client, strategy: StrategyConfig, label: string): Promise<FiveSeedEval> {
  let totalMargin = 0
  let totalOnTime = 0
  let minOnTime = 1
  let allRankedAndSafe = true

  for (const seed of VERIFICATION_SEEDS) {
    await checkAndPlayFinal(client)
    await checkAndPlayRankingBoard()
    const res = await runSimulationRound({
      level: 8,
      seed,
      board: false,
      tuneWithGemini: false,
      persist: false,
      strategyOverride: strategy,
    })
    totalMargin += res.score.marginCents
    totalOnTime += res.score.onTimeShare
    minOnTime = Math.min(minOnTime, res.score.onTimeShare)
    if (!res.score.ranked || res.score.onTimeShare < MIN_SEED_ON_TIME) {
      allRankedAndSafe = false
    }
    console.log(
      `[AUTOPILOT][${label}] ${seed}: €${(res.score.marginCents / 100).toFixed(2)} | OT ${(res.score.onTimeShare * 100).toFixed(1)}% (${res.score.ranked ? "RANKED" : "UNRANKED"})`,
    )
  }

  return {
    avgMarginCents: totalMargin / VERIFICATION_SEEDS.length,
    minOnTimeShare: minOnTime,
    avgOnTimeShare: totalOnTime / VERIFICATION_SEEDS.length,
    allRankedAndSafe,
  }
}

async function main(): Promise<void> {
  const client = new Client()
  let cycle = 1
  const benchmarkSeeds = ["spread-1", "spread-2", "spread-3"]
  let cachedChampionKey = ""
  let cachedChampionEval: FiveSeedEval | null = null

  console.log("================================================================================")
  console.log("🚀 SPREAD 24/7 AUTOPILOT ACTIVE (Final Watchdog + Ranking Board + Hill-Climber)")
  console.log("================================================================================")

  while (true) {
    console.log(`\n--- [AUTOPILOT CYCLE #${cycle}] ${new Date().toISOString()} ---`)

    // 1. Priority #1: Check if a Live Final or Saturday Test Final is open
    await checkAndPlayFinal(client)

    // 2. Priority #2: Check if a new Official Level 8 Ranking Round has unplayed runs
    await checkAndPlayRankingBoard()

    // 3. Priority #3: Run practice optimization on rotating seeds
    const seed = `autopilot-${cycle}-${benchmarkSeeds[cycle % benchmarkSeeds.length]}`
    const currentChampion = loadStrategy()
    const candidate = cycle % 2 === 0 ? mutateStrategy(currentChampion) : currentChampion

    console.log(`[AUTOPILOT] Evaluating Strategy v${candidate.version} on Level 8 seed "${seed}"...`)
    try {
      const summary = await runSimulationRound({
        level: 8,
        seed,
        board: false,
        tuneWithGemini: true,
        strategyOverride: candidate,
      })
      // tuneStrategyWithGemini() writes data/strategy.json on every single-seed call;
      // immediately restore the protected champion until 5-seed verification passes.
      saveStrategy(currentChampion)

      console.log(
        `[AUTOPILOT] Result on "${seed}": Margin €${(summary.score.marginCents / 100).toFixed(2)} | On-Time ${(summary.score.onTimeShare * 100).toFixed(1)}% (${summary.score.ranked ? "RANKED" : "UNRANKED"})`,
      )

      const proposed = summary.geminiTuning?.nextStrategy ?? candidate
      if (!summary.score.ranked || summary.score.onTimeShare < MIN_SEED_ON_TIME) {
        console.log(`[AUTOPILOT] Kept Champion Strategy v${currentChampion.version} (single-seed failed >=93.0% OT / RANKED).`)
      } else {
        const championKey = JSON.stringify(currentChampion)
        if (cachedChampionKey !== championKey || !cachedChampionEval) {
          cachedChampionEval = await evaluateFiveSeeds(client, currentChampion, `Champion v${currentChampion.version}`)
          cachedChampionKey = championKey
        }
        const proposedEval = await evaluateFiveSeeds(client, proposed, `Candidate v${proposed.version}`)
        if (proposedEval.allRankedAndSafe && proposedEval.avgMarginCents > cachedChampionEval.avgMarginCents) {
          const prevChampionAvg = cachedChampionEval.avgMarginCents
          saveStrategy(proposed)
          cachedChampionEval = proposedEval
          cachedChampionKey = JSON.stringify(proposed)
          console.log(
            `[AUTOPILOT] Promoted Strategy v${proposed.version}: €${(proposedEval.avgMarginCents / 100).toFixed(2)}/wk avg (min OT ${(proposedEval.minOnTimeShare * 100).toFixed(1)}%) > Champion €${(prevChampionAvg / 100).toFixed(2)}/wk.`,
          )
        } else {
          console.log(
            `[AUTOPILOT] Rejected Candidate v${proposed.version} after 5-seed check (€${(proposedEval.avgMarginCents / 100).toFixed(2)}/wk, min OT ${(proposedEval.minOnTimeShare * 100).toFixed(1)}%). Champion v${currentChampion.version} remains protected.`,
          )
        }
      }
    } catch (err) {
      saveStrategy(currentChampion)
      console.warn(`[AUTOPILOT] Practice run error: ${(err as Error).message}`)
    }

    cycle++
    // Check for an upcoming/live Final every 10 seconds during the 40-second cooldown between practice cycles
    for (let w = 0; w < 4; w++) {
      await sleep(10_000)
      await checkAndPlayFinal(client)
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  await main()
}
