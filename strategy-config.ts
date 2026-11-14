import fs from "node:fs"
import path from "node:path"

export interface Flags {
  selectiveDecline: boolean   // capacity gating + risk filters + batch cap
  optionSteering: boolean     // withhold/premium same_day when flexible options exist
  flatFees: boolean           // flat-opening fee schedule (vs hourly rising)
  repositionOffers: boolean   // direct offers to repositioned drivers / viewers
  noteNLP: boolean            // parse notes for licence/plates/windows
  dealerLearning: boolean     // per-dealer offset, outage streak, trust premium
  chainGigs: boolean          // 2-car gig chaining for nearby open orders
  slackFees: boolean          // open lower when >=18h slack & >=4 local drivers
}

export const DEFAULT_FLAGS: Flags = {
  selectiveDecline: true,
  optionSteering: true,
  flatFees: true,
  repositionOffers: true,
  noteNLP: true,
  dealerLearning: true,
  chainGigs: false,
  slackFees: true,
}

export interface StrategyConfig {
  version: number
  updatedAt: string
  updatedBy: "default" | "gemini-4-hydrogen" | "quantitative-fallback" | "manual"
  flags: Flags
  baseQuoteMultiplier: number
  sameDayQuotePremium: number
  minExpectedMarginRatio: number
  targetWinRate: number
  maxActiveWaitingPerDriver: number
  maxOrdersPerBatch: number
  baseFeeMultiplier: number
  maxNormalFeeMultiplier: number
  urgentFeeMultiplier: number
  maxUrgentFeeMultiplier: number
  scarcityTownFeeBoost: number
  directOfferDiscount: number
  targetOnTimeBuffer: number
  reasoningSummary: string
}

export interface DailyMetric {
  dayIndex: number
  dayName: string
  nowMinute: number
  marginCents: number
  revenueCents: number
  wonOrders: number
  onTimeShare: number
  undeliveredShare: number
  ranked: boolean
}

export interface RoundSummary {
  runId: string
  worldId: string
  level: number
  seed: string | null
  board: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  score: {
    marginCents: number
    revenueCents: number
    marginShare: number
    wonOrders: number
    onTimeShare: number
    undeliveredShare: number
    ranked: boolean
  }
  telemetry: {
    totalRequests: number
    quotedToWin: number
    declinedHighQuote: number
    wonOrders: number
    lostOrders: number
    winRateAll: number
    winRateTargeted: number
    totalGigsPosted: number
    totalGigsBooked: number
    totalDirectOffers: number
    acceptedDirectOffers: number
    gigDrops: number
    noShows: number
    visitFailures: Record<string, number>
    deadlineWarnings: number
    lateDeliveries: number
    onTimeDeliveries: number
    ledgerBreakdownCents: Record<string, number>
  }
  dailyMetrics: DailyMetric[]
  strategyUsed: StrategyConfig
  geminiTuning?: {
    model: string
    usedLiveApi: boolean
    analysis: string
    keyAdjustments: string[]
    nextStrategy: StrategyConfig
  }
}

export const DEFAULT_STRATEGY: StrategyConfig = {
  version: 1,
  updatedAt: new Date().toISOString(),
  updatedBy: "default",
  flags: { ...DEFAULT_FLAGS },
  baseQuoteMultiplier: 1.38,
  sameDayQuotePremium: 0.14,
  minExpectedMarginRatio: 0.18,
  targetWinRate: 0.30,
  maxActiveWaitingPerDriver: 0.45,
  maxOrdersPerBatch: 5,
  baseFeeMultiplier: 1.06,
  maxNormalFeeMultiplier: 1.45,
  urgentFeeMultiplier: 1.75,
  maxUrgentFeeMultiplier: 2.40,
  scarcityTownFeeBoost: 0.16,
  directOfferDiscount: 0.96,
  targetOnTimeBuffer: 0.935,
  reasoningSummary:
    "Initial quantitative baseline calibrated for Level 8 driver shortages & dealer trust: selective quoting at ~1.38x list price, steering multi-option requests toward next_day/within_3_days, and proactive fee schedules + direct offers to protect >92% on-time arrival.",
}

const DATA_DIR = path.join(process.cwd(), "data")
const STRATEGY_FILE = path.join(DATA_DIR, "strategy.json")
const RUNS_FILE = path.join(DATA_DIR, "runs.json")

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
  }
}

export function loadStrategy(): StrategyConfig {
  ensureDataDir()
  if (!fs.existsSync(STRATEGY_FILE)) {
    saveStrategy(DEFAULT_STRATEGY)
    return { ...DEFAULT_STRATEGY }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"))
    return { ...DEFAULT_STRATEGY, ...raw, flags: { ...DEFAULT_FLAGS, ...(raw.flags ?? {}) } }
  } catch {
    return { ...DEFAULT_STRATEGY }
  }
}

export function saveStrategy(config: StrategyConfig): void {
  ensureDataDir()
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(config, null, 2), "utf8")
}

export function loadRuns(): RoundSummary[] {
  ensureDataDir()
  if (!fs.existsSync(RUNS_FILE)) return []
  try {
    return JSON.parse(fs.readFileSync(RUNS_FILE, "utf8")) as RoundSummary[]
  } catch {
    return []
  }
}

export function appendRun(summary: RoundSummary): void {
  ensureDataDir()
  const runs = loadRuns()
  runs.unshift(summary)
  // Keep latest 50 runs
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs.slice(0, 50), null, 2), "utf8")
}
