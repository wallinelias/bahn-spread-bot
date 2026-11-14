import fs from "node:fs"
import path from "node:path"
import { GoogleGenAI } from "@google/genai"
import type { RoundSummary, StrategyConfig } from "./strategy-config.ts"
import { saveStrategy } from "./strategy-config.ts"

export interface GeminiDecisionEvaluation {
  model: string
  usedLiveApi: boolean
  evaluatedAt: string
  worldId: string
  level: number
  seed: string | null
  marginEur: number
  onTimePct: number
  onTimeSafeProb: number
  marginSustainableProb: number
  noteRegressionProb: number
  decision: "PROMOTE" | "HOLD"
  confidence: string
  totalOutputTokens: number
}

const DECISIONS_FILE = path.join(process.cwd(), "data", "gemini-decisions.json")

export function loadGeminiDecisions(): GeminiDecisionEvaluation[] {
  try {
    if (!fs.existsSync(DECISIONS_FILE)) return []
    const parsed = JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8"))
    return Array.isArray(parsed) ? (parsed as GeminiDecisionEvaluation[]) : []
  } catch {
    return []
  }
}

function saveGeminiDecision(entry: GeminiDecisionEvaluation): void {
  try {
    const dir = path.dirname(DECISIONS_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const existing = loadGeminiDecisions()
    const next = [entry, ...existing].slice(0, 30)
    fs.writeFileSync(DECISIONS_FILE, JSON.stringify(next, null, 2), "utf8")
  } catch {
    // Non-fatal logging error
  }
}

/**
 * Evaluates a simulation round against calibrated Noul decision rubrics using `gemini-decision-1`
 * (`v1beta` Decisions API, 0 output tokens) to gate candidate promotions safely above the 90% floor.
 */
export async function evaluatePromotionWithGeminiDecision(
  summary: RoundSummary,
  overrideApiKey?: string,
): Promise<{
  onTimeSafeProb: number
  marginSustainableProb: number
  noteRegressionProb: number
  decision: "PROMOTE" | "HOLD"
  confidence: string
  usedLiveApi: boolean
}> {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  const marginEur = Number((summary.score.marginCents / 100).toFixed(2))
  const onTimePct = Number((summary.score.onTimeShare * 100).toFixed(2))
  const totalVisitFailures = Object.values(summary.telemetry.visitFailures ?? {}).reduce((a, b) => a + b, 0)

  const deterministicFallback = () => {
    const onTimeSafeProb = summary.score.onTimeShare >= 0.945 ? 0.92 : summary.score.onTimeShare >= 0.935 ? 0.78 : 0.25
    const marginSustainableProb = marginEur >= 8000 ? 0.88 : marginEur >= 6000 ? 0.72 : 0.35
    const noteRegressionProb = totalVisitFailures <= 2 ? 0.08 : Math.min(0.95, 0.2 + totalVisitFailures * 0.1)
    const composite = Math.min(onTimeSafeProb, marginSustainableProb, 1 - noteRegressionProb)
    const decision: "PROMOTE" | "HOLD" =
      onTimeSafeProb >= 0.72 && marginSustainableProb >= 0.65 && noteRegressionProb <= 0.35 && summary.score.ranked
        ? "PROMOTE"
        : "HOLD"
    const entry: GeminiDecisionEvaluation = {
      model: "deterministic-decision-fallback",
      usedLiveApi: false,
      evaluatedAt: new Date().toISOString(),
      worldId: summary.worldId,
      level: summary.level,
      seed: summary.seed,
      marginEur,
      onTimePct,
      onTimeSafeProb,
      marginSustainableProb,
      noteRegressionProb,
      decision,
      confidence: `${(composite * 100).toFixed(1)}%`,
      totalOutputTokens: 0,
    }
    saveGeminiDecision(entry)
    return {
      onTimeSafeProb,
      marginSustainableProb,
      noteRegressionProb,
      decision,
      confidence: entry.confidence,
      usedLiveApi: false,
    }
  }

  if (!apiKey) return deterministicFallback()

  try {
    const clientBeta = new GoogleGenAI({ apiKey, apiVersion: "v1beta" })
    const sharedInput = JSON.stringify({
      worldId: summary.worldId,
      level: summary.level,
      seed: summary.seed,
      ranked: summary.score.ranked,
      marginEur,
      revenueEur: Number((summary.score.revenueCents / 100).toFixed(2)),
      onTimeShare: summary.score.onTimeShare,
      undeliveredShare: summary.score.undeliveredShare,
      wonOrders: summary.score.wonOrders,
      totalRequests: summary.telemetry.totalRequests,
      winRateAll: summary.telemetry.winRateAll,
      winRateTargeted: summary.telemetry.winRateTargeted,
      gigDrops: summary.telemetry.gigDrops,
      noShows: summary.telemetry.noShows,
      deadlineWarnings: summary.telemetry.deadlineWarnings,
      visitFailures: summary.telemetry.visitFailures,
      strategyVersion: summary.strategyUsed.version,
    })

    const res = await clientBeta.decisions.create({
      model: "gemini-decision-1",
      input: sharedInput,
      questions: {
        is_on_time_safe: {
          type: "noul",
          instructions:
            "Determine whether the on-time share has sufficient safety cushion (>= 0.935) above the hard 0.900 disqualification floor without late-week queue collapse.",
          criteria: {
            true_description: "ranked=true, onTimeShare >= 0.935, low undeliveredShare and manageable deadlineWarnings.",
            false_description: "ranked=false, or onTimeShare < 0.935, or high undeliveredShare risk.",
          },
        },
        is_margin_sustainable: {
          type: "noul",
          instructions:
            "Determine whether gross margin and win rate are strong and sustainable without over-flooding fleet capacity.",
          criteria: {
            true_description: "High gross margin (>= €6,000/wk typical or strong marginShare) with disciplined targeted win rate and low gigDrops.",
            false_description: "Weak margin, unprofitable fee overpay, or excessive gigDrops/overload.",
          },
        },
        has_note_parsing_regressions: {
          type: "noul",
          instructions:
            "Determine whether visitFailures (closed, not_ready, no_plates, licence) indicate significant NLP note-parsing regressions.",
          criteria: {
            true_description: "High count (> 6) of visitFailures in a week suggesting missed pickup windows, plates, or manual requirements.",
            false_description: "Minimal visitFailures (<= 5 across the full week).",
          },
        },
      },
    })

    const a = res.answers ?? {}
    const onTimeSafeProb = a.is_on_time_safe?.type === "noul" ? a.is_on_time_safe.noul : 0.5
    const marginSustainableProb = a.is_margin_sustainable?.type === "noul" ? a.is_margin_sustainable.noul : 0.5
    const noteRegressionProb = a.has_note_parsing_regressions?.type === "noul" ? a.has_note_parsing_regressions.noul : 0.5

    const compositeConf = Math.min(
      a.is_on_time_safe?.type === "noul" ? a.is_on_time_safe.confidence : 0.5,
      a.is_margin_sustainable?.type === "noul" ? a.is_margin_sustainable.confidence : 0.5,
    )
    const decision: "PROMOTE" | "HOLD" =
      summary.score.ranked && onTimeSafeProb >= 0.65 && marginSustainableProb >= 0.6 && noteRegressionProb <= 0.45
        ? "PROMOTE"
        : "HOLD"

    const confidence = `${(compositeConf * 100).toFixed(1)}%`
    const entry: GeminiDecisionEvaluation = {
      model: "gemini-decision-1",
      usedLiveApi: true,
      evaluatedAt: new Date().toISOString(),
      worldId: summary.worldId,
      level: summary.level,
      seed: summary.seed,
      marginEur,
      onTimePct,
      onTimeSafeProb,
      marginSustainableProb,
      noteRegressionProb,
      decision,
      confidence,
      totalOutputTokens: res.usage?.total_output_tokens ?? 0,
    }
    saveGeminiDecision(entry)

    return {
      onTimeSafeProb,
      marginSustainableProb,
      noteRegressionProb,
      decision,
      confidence,
      usedLiveApi: true,
    }
  } catch (err) {
    console.warn(`[gemini-decision-1] Fallback due to error: ${(err as Error).message}`)
    return deterministicFallback()
  }
}

const TUNING_JSON_SCHEMA = {
  type: "object",
  properties: {
    analysis: {
      type: "string",
      description:
        "Concise quantitative post-mortem of the round: analyze gross margin, win rate, driver fee ratio, late refunds, and on-time share vs the 90% ranking threshold.",
    },
    keyAdjustments: {
      type: "array",
      items: { type: "string" },
      description: "3 to 5 bullet-point parameter changes and why they will improve gross margin while keeping on-time share >= 92%.",
    },
    baseQuoteMultiplier: {
      type: "number",
      description: "Baseline multiplier on listPriceCents for Level 7/8 quoting (range 1.15 to 1.65).",
    },
    sameDayQuotePremium: {
      type: "number",
      description: "Additional quote multiplier on same_day options to steer toward next_day/within_3_days (range 0.05 to 0.30).",
    },
    minExpectedMarginRatio: {
      type: "number",
      description: "Minimum expected margin ratio required to quote competitively (range 0.10 to 0.35).",
    },
    targetWinRate: {
      type: "number",
      description: "Target win rate among requests to prevent fleet overload in shortages (range 0.15 to 0.55).",
    },
    maxActiveWaitingPerDriver: {
      type: "number",
      description: "Maximum ratio of unbooked waiting orders to total roster drivers before throttling quotes (range 0.25 to 0.80).",
    },
    maxOrdersPerBatch: {
      type: "number",
      description: "Maximum cars to bid competitively on in a single bulk order batchId (integer 2 to 10).",
    },
    baseFeeMultiplier: {
      type: "number",
      description: "Opening driver fee multiplier relative to referenceFeeCents (range 0.92 to 1.35).",
    },
    maxNormalFeeMultiplier: {
      type: "number",
      description: "Peak multiplier on normal 6-step rising fee schedule (range 1.25 to 1.85).",
    },
    urgentFeeMultiplier: {
      type: "number",
      description: "Opening multiplier when deadline_close warning triggers (range 1.45 to 2.10).",
    },
    maxUrgentFeeMultiplier: {
      type: "number",
      description: "Maximum multiplier on urgent fee schedule to guarantee pickup before deadline (range 1.90 to 2.80).",
    },
    scarcityTownFeeBoost: {
      type: "number",
      description: "Additional fee multiplier boost when pickup town has < 3 local drivers within 30km (range 0.05 to 0.35).",
    },
    directOfferDiscount: {
      type: "number",
      description: "Multiplier on current gig fee when sending 10-minute direct offers to drivers (range 0.88 to 1.05).",
    },
    targetOnTimeBuffer: {
      type: "number",
      description: "Target on-time share safety buffer above the 0.90 hard rule (range 0.92 to 0.97).",
    },
  },
  required: [
    "analysis",
    "keyAdjustments",
    "baseQuoteMultiplier",
    "sameDayQuotePremium",
    "minExpectedMarginRatio",
    "targetWinRate",
    "maxActiveWaitingPerDriver",
    "maxOrdersPerBatch",
    "baseFeeMultiplier",
    "maxNormalFeeMultiplier",
    "urgentFeeMultiplier",
    "maxUrgentFeeMultiplier",
    "scarcityTownFeeBoost",
    "directOfferDiscount",
    "targetOnTimeBuffer",
  ],
}

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min
  return Number(Math.min(max, Math.max(min, val)).toFixed(3))
}

/**
 * Deterministic quantitative optimizer used as fallback if GEMINI_API_KEY is not set
 * or if the remote API call fails, ensuring 100% reliability during live rounds.
 */
function computeQuantitativeFallback(
  summary: RoundSummary,
  current: StrategyConfig,
): NonNullable<RoundSummary["geminiTuning"]> {
  const { score, telemetry } = summary
  const onTime = score.onTimeShare
  const winRate = telemetry.winRateAll
  const marginEuros = (score.marginCents / 100).toFixed(2)
  const revenueEuros = (score.revenueCents / 100).toFixed(2)

  let baseQuoteMultiplier = current.baseQuoteMultiplier
  let sameDayQuotePremium = current.sameDayQuotePremium
  let minExpectedMarginRatio = current.minExpectedMarginRatio
  let targetWinRate = current.targetWinRate
  let maxActiveWaitingPerDriver = current.maxActiveWaitingPerDriver
  let maxOrdersPerBatch = current.maxOrdersPerBatch
  let baseFeeMultiplier = current.baseFeeMultiplier
  let maxNormalFeeMultiplier = current.maxNormalFeeMultiplier
  let urgentFeeMultiplier = current.urgentFeeMultiplier
  let maxUrgentFeeMultiplier = current.maxUrgentFeeMultiplier
  let scarcityTownFeeBoost = current.scarcityTownFeeBoost
  let directOfferDiscount = current.directOfferDiscount
  let targetOnTimeBuffer = current.targetOnTimeBuffer

  const adjustments: string[] = []

  if (onTime < 0.925) {
    // Protect the 90% ranking requirement aggressively
    baseQuoteMultiplier = clamp(baseQuoteMultiplier + 0.04, 1.15, 1.65)
    sameDayQuotePremium = clamp(sameDayQuotePremium + 0.03, 0.05, 0.30)
    maxActiveWaitingPerDriver = clamp(maxActiveWaitingPerDriver - 0.06, 0.25, 0.80)
    baseFeeMultiplier = clamp(baseFeeMultiplier + 0.05, 0.92, 1.35)
    urgentFeeMultiplier = clamp(urgentFeeMultiplier + 0.08, 1.45, 2.10)
    adjustments.push(
      `On-Time Share (${(onTime * 100).toFixed(1)}%) dipped below 92.5% safety buffer → raised baseQuoteMultiplier to ${baseQuoteMultiplier} and tightened maxActiveWaitingPerDriver to ${maxActiveWaitingPerDriver}.`,
      `Boosted baseFeeMultiplier to ${baseFeeMultiplier} and urgentFeeMultiplier to ${urgentFeeMultiplier} to accelerate driver bookings.`,
    )
  } else if (onTime > 0.965 && score.wonOrders > 0) {
    // High on-time margin cushion: expand volume and trim excess driver fee overpayment
    if (winRate < current.targetWinRate * 0.85) {
      baseQuoteMultiplier = clamp(baseQuoteMultiplier - 0.025, 1.15, 1.65)
      adjustments.push(
        `On-Time Share is rock-solid (${(onTime * 100).toFixed(1)}%) with win rate ${(winRate * 100).toFixed(1)}% → trimmed baseQuoteMultiplier to ${baseQuoteMultiplier} to capture more profitable lanes.`,
      )
    } else {
      baseQuoteMultiplier = clamp(baseQuoteMultiplier + 0.015, 1.15, 1.65)
      adjustments.push(
        `Strong On-Time Share (${(onTime * 100).toFixed(1)}%) and healthy win rate (${(winRate * 100).toFixed(1)}%) → nudged baseQuoteMultiplier to ${baseQuoteMultiplier} to extract additional dealer trust margin.`,
      )
    }
    baseFeeMultiplier = clamp(baseFeeMultiplier - 0.015, 0.95, 1.35)
    adjustments.push(
      `Trimmed opening baseFeeMultiplier to ${baseFeeMultiplier} since drivers are booking well ahead of deadlines.`,
    )
  } else {
    // Between 92.5% and 96.5% on-time: fine-tune margin extraction
    if (winRate > 0.36) {
      baseQuoteMultiplier = clamp(baseQuoteMultiplier + 0.02, 1.15, 1.65)
      adjustments.push(
        `Win rate (${(winRate * 100).toFixed(1)}%) is above optimal shortage capacity → increased baseQuoteMultiplier to ${baseQuoteMultiplier} to monetize price-inelastic requests.`,
      )
    } else if (winRate < 0.18) {
      baseQuoteMultiplier = clamp(baseQuoteMultiplier - 0.02, 1.15, 1.65)
      adjustments.push(
        `Win rate (${(winRate * 100).toFixed(1)}%) is conservative → lowered baseQuoteMultiplier to ${baseQuoteMultiplier} to win more next_day/within_3_days orders.`,
      )
    }
    if (telemetry.deadlineWarnings > score.wonOrders * 0.12) {
      scarcityTownFeeBoost = clamp(scarcityTownFeeBoost + 0.02, 0.05, 0.35)
      adjustments.push(
        `Observed ${telemetry.deadlineWarnings} deadline_close warnings → increased scarcityTownFeeBoost to ${scarcityTownFeeBoost} for remote pickup towns.`,
      )
    }
  }

  if (adjustments.length === 0) {
    adjustments.push(
      `Maintained balanced shortage dispatch posture at ${(onTime * 100).toFixed(1)}% on-time and €${marginEuros} gross margin.`,
    )
  }

  const nextStrategy: StrategyConfig = {
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: "quantitative-fallback",
    flags: current.flags,
    baseQuoteMultiplier,
    sameDayQuotePremium,
    minExpectedMarginRatio,
    targetWinRate,
    maxActiveWaitingPerDriver,
    maxOrdersPerBatch,
    baseFeeMultiplier,
    maxNormalFeeMultiplier,
    urgentFeeMultiplier,
    maxUrgentFeeMultiplier,
    scarcityTownFeeBoost,
    directOfferDiscount,
    targetOnTimeBuffer,
    reasoningSummary: adjustments.join(" "),
  }

  return {
    model: "rule-based fallback (NOT Gemini)",
    usedLiveApi: false,
    analysis: `Round ${summary.worldId} (Level ${summary.level}) finished with Gross Margin €${marginEuros} on Revenue €${revenueEuros} (${(score.marginShare * 100).toFixed(1)}% margin share), ${score.wonOrders} won orders, and ${(onTime * 100).toFixed(1)}% On-Time Arrival (${score.ranked ? "RANKED" : "UNRANKED"}).`,
    keyAdjustments: adjustments,
    nextStrategy,
  }
}

/**
 * Calls `gemini-4-hydrogen` via `@google/genai` Interactions API with Structured Outputs
 * (`response_format: { type: 'text', mime_type: 'application/json', schema }`) to self-tune
 * our pricing and dispatch parameters after each simulation round.
 */
export async function tuneStrategyWithGemini(
  summary: RoundSummary,
  current: StrategyConfig,
  overrideApiKey?: string,
): Promise<NonNullable<RoundSummary["geminiTuning"]>> {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!apiKey) {
    const fallback = computeQuantitativeFallback(summary, current)
    saveStrategy(fallback.nextStrategy)
    return fallback
  }

  try {
    const client = new GoogleGenAI({ apiKey })

    const prompt = `You are the Autonomous Quantitative Dispatch Strategist for Bahn Express "Spread" (Junction 2026).
Your objective: Maximize Gross Margin (in Euros) at Level ${summary.level} while keeping On-Time Arrival % strictly >= 92.5% (the hard disqualification threshold is 90.0%).

Here are the telemetry results from the simulation week just completed:
- World ID: ${summary.worldId} (Level ${summary.level}, Seed: ${summary.seed ?? "random/board"})
- Gross Margin: €${(summary.score.marginCents / 100).toFixed(2)} (${(summary.score.marginShare * 100).toFixed(1)}% of revenue)
- Revenue: €${(summary.score.revenueCents / 100).toFixed(2)}
- Won Orders: ${summary.score.wonOrders} / ${summary.telemetry.totalRequests} requests (${(summary.telemetry.winRateAll * 100).toFixed(1)}% overall win rate, ${(summary.telemetry.winRateTargeted * 100).toFixed(1)}% targeted win rate)
- Declined (High Quote): ${summary.telemetry.declinedHighQuote} requests
- On-Time Arrival Share: ${(summary.score.onTimeShare * 100).toFixed(2)}% (Ranked: ${summary.score.ranked})
- Undelivered Share: ${(summary.score.undeliveredShare * 100).toFixed(2)}%
- Deadline Warnings (3h before lastPickupAt): ${summary.telemetry.deadlineWarnings}
- Gig Drops: ${summary.telemetry.gigDrops}, No-Shows: ${summary.telemetry.noShows}
- Direct Offers Sent: ${summary.telemetry.totalDirectOffers} (Accepted: ${summary.telemetry.acceptedDirectOffers})
- Visit Failures by Reason: ${JSON.stringify(summary.telemetry.visitFailures)}
- Ledger Breakdown (cents): ${JSON.stringify(summary.telemetry.ledgerBreakdownCents)}

Current Strategy Parameters (v${current.version}):
${JSON.stringify(current, null, 2)}

Domain Rules & Physics to keep in mind:
1. At Level 7 & 8 there is a severe driver shortage (only 26%-40% of normal drivers, uneven by town) and competitor prices are 26%-54% above listPriceCents.
2. Dealers at Level 8 grant +1% price tolerance per on-time order delivered to them (up to +25%), and halve trust on a late delivery.
3. Quoting a higher premium on 'same_day' steers dealers to choose 'next_day' or 'within_3_days', which gives our drivers 24-72h slack and keeps On-Time % above 93%.
4. If On-Time Share was below 92.5%, tighten capacity (lower maxActiveWaitingPerDriver, raise baseQuoteMultiplier, or increase baseFeeMultiplier/urgentFeeMultiplier).
5. If On-Time Share was comfortably >= 94.5%, optimize gross margin by tuning baseQuoteMultiplier, directOfferDiscount, and baseFeeMultiplier without risking the 92% safety floor.

Return the updated strategy parameters in the required JSON schema.`

    let rawText = ""
    let usedModel = "gemini-4-hydrogen"

    // Run calibrated Noul guardrail check via gemini-decision-1 (0 output tokens) alongside tuning
    const decisionGate = await evaluatePromotionWithGeminiDecision(summary, apiKey).catch(() => null)

    try {
      const interaction = await client.interactions.create({
        model: "gemini-4-hydrogen",
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: TUNING_JSON_SCHEMA,
        },
      })
      rawText = interaction.output_text || ""
    } catch (apiErr) {
      console.warn(`Primary gemini-4-hydrogen error (${(apiErr as Error).message}). Failing over to gemini-3.5-flash-lite...`)
      usedModel = "gemini-3.5-flash-lite"
      const fallbackInteraction = await client.interactions.create({
        model: "gemini-3.5-flash-lite",
        input: prompt,
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: TUNING_JSON_SCHEMA,
        },
      })
      rawText = fallbackInteraction.output_text || ""
    }

    if (!rawText) {
      throw new Error(`Empty output_text from LLM strategist (${usedModel})`)
    }
    const parsed = JSON.parse(rawText)

    const nextStrategy: StrategyConfig = {
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: usedModel as StrategyConfig["updatedBy"],
      flags: current.flags,
      baseQuoteMultiplier: clamp(parsed.baseQuoteMultiplier, 1.15, 1.65),
      sameDayQuotePremium: clamp(parsed.sameDayQuotePremium, 0.05, 0.30),
      minExpectedMarginRatio: clamp(parsed.minExpectedMarginRatio, 0.10, 0.35),
      targetWinRate: clamp(parsed.targetWinRate, 0.15, 0.55),
      maxActiveWaitingPerDriver: clamp(parsed.maxActiveWaitingPerDriver, 0.25, 0.80),
      maxOrdersPerBatch: Math.round(clamp(parsed.maxOrdersPerBatch, 2, 10)),
      baseFeeMultiplier: clamp(parsed.baseFeeMultiplier, 0.92, 1.35),
      maxNormalFeeMultiplier: clamp(parsed.maxNormalFeeMultiplier, 1.25, 1.85),
      urgentFeeMultiplier: clamp(parsed.urgentFeeMultiplier, 1.45, 2.10),
      maxUrgentFeeMultiplier: clamp(parsed.maxUrgentFeeMultiplier, 1.90, 2.80),
      scarcityTownFeeBoost: clamp(parsed.scarcityTownFeeBoost, 0.05, 0.35),
      directOfferDiscount: clamp(parsed.directOfferDiscount, 0.88, 1.05),
      targetOnTimeBuffer: clamp(parsed.targetOnTimeBuffer, 0.92, 0.97),
      reasoningSummary: parsed.analysis || `Tuned by ${usedModel} Structured Outputs.`,
    }

    saveStrategy(nextStrategy)

    return {
      model: usedModel,
      usedLiveApi: true,
      analysis: decisionGate
        ? `${parsed.analysis} [gemini-decision-1: ${decisionGate.decision}, P(safe)=${(decisionGate.onTimeSafeProb * 100).toFixed(1)}%, P(margin)=${(decisionGate.marginSustainableProb * 100).toFixed(1)}%]`
        : parsed.analysis,
      keyAdjustments: Array.isArray(parsed.keyAdjustments) ? parsed.keyAdjustments : [],
      nextStrategy,
    }
  } catch (err) {
    console.warn(`Gemini API call fallback (${(err as Error).message}). Using quantitative solver.`)
    await evaluatePromotionWithGeminiDecision(summary, apiKey).catch(() => null)
    const fallback = computeQuantitativeFallback(summary, current)
    saveStrategy(fallback.nextStrategy)
    return fallback
  }
}
