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
  pricerOptions?: Record<string, unknown>
  chainingOptions?: Record<string, unknown>
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
  version: 23,
  updatedAt: "2026-11-14T16:36:00.000Z",
  updatedBy: "manual",
  flags: { ...DEFAULT_FLAGS },
  baseQuoteMultiplier: 1.42,
  sameDayQuotePremium: 0.25,
  minExpectedMarginRatio: 0.19,
  targetWinRate: 0.32,
  maxActiveWaitingPerDriver: 0.41,
  maxOrdersPerBatch: 5,
  baseFeeMultiplier: 1.05,
  maxNormalFeeMultiplier: 1.36,
  urgentFeeMultiplier: 1.75,
  maxUrgentFeeMultiplier: 2.20,
  scarcityTownFeeBoost: 0.14,
  directOfferDiscount: 1.015,
  targetOnTimeBuffer: 0.935,
  pricerOptions: {
    strictCapacityGate: true,
    minQuoteMultiplier: 1.22,
    worldBaseMuFloor: 1.2,
    softCapacitySurge: true,
    adverseSelectionGuard: true,
    cleanAdverseGuard: true,
    smartDirectOffers: false,
    slaRegimeControl: true,
    dealerShadowPricing: false,
    fortressRescueEnabled: false,
    smartDirectOffersV2: true,
  },
  reasoningSummary:
    "Promoted F3 Champion (v23): Top10IntegratedDesk with BayesianCompetitorPricer (1.22/1.20 floor + softCapacitySurge + cleanAdverseGuard), Dual-Regime Intra-Week SLA Controller (FORTRESS/BALANCED/HARVEST), ZeroHoldoutFeeScheduler + smartDirectOffersV2; verified 5/5 RANKED across spread-1..5 (€38,086.58, minOT 94.22%, avgOT 95.48%).",
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
    return {
      ...DEFAULT_STRATEGY,
      ...raw,
      flags: { ...DEFAULT_FLAGS, ...(raw.flags ?? {}) },
      pricerOptions: raw.pricerOptions
        ? { ...(DEFAULT_STRATEGY.pricerOptions ?? {}), ...raw.pricerOptions }
        : DEFAULT_STRATEGY.pricerOptions,
    }
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
