# LIVE STRATEGY SUMMARY // Bahn Express "Spread" Level 8

- **Last Updated:** `2026-11-14T16:41:00.000Z`
- **Active Production Champion:** **Strategy `v23`** (`F3` — `Top10IntegratedDesk` + Dual-Regime SLA Control)
- **Current 5-Seed Stress Score (`spread-1..5`):** **€38,086.58** (avg `€7,617.32/wk` | avgOT `95.48%` | minOT `94.22%` | `5/5 RANKED`)
- **Latest Official Board Result (Season 8 `Saturday 18:00`):** **`#28 / 238`** (`36` ranked) — **€45,734.35** | **`95.76%` OT** | **`5/5 RANKED`** (`Run 1: €9,876.09 @ 95.64%`, `Run 2: €12,851.63 @ 96.18%`, `Run 3: €8,922.69 @ 93.21%`, `Run 4: €6,631.91 @ 96.67%`, `Run 5: €7,452.03 @ 97.45%`; Top-10 cutoff: `€71,401.81`)

## (a) What Exact Change Was Just Made
Promoted **`F3` (`v23`)** into [`data/strategy.json`](file:///Users/wallinelias/Downloads/bahn-spread-bot/data/strategy.json), [`strategy-config.ts`](file:///Users/wallinelias/Downloads/bahn-spread-bot/strategy-config.ts), and [`top10-engine.ts`](file:///Users/wallinelias/Downloads/bahn-spread-bot/top10-engine.ts), locking `pricerOptions` (`minQuoteMultiplier: 1.22`, `worldBaseMuFloor: 1.2`, `softCapacitySurge: true`, `cleanAdverseGuard: true`, `slaRegimeControl: true`, `smartDirectOffersV2: true`, `chainGigs: false`) and preserving `pricerOptions`/`chainingOptions` across [`gemini-strategist.ts`](file:///Users/wallinelias/Downloads/bahn-spread-bot/gemini-strategist.ts) updates.

## (b) F-Series 5-Seed Ablation Summary (`spread-1..5`, Level 8)
- **`F3` (`chain=false`, Promoted `v23`):** **€38,086.58** | `minOT 94.22%` | `avgOT 95.48%` | `5/5 RANKED` (`spread-4`: `€11,753.29 @ 95.27%`, `spread-1`: `€9,632.33 @ 95.72%`, `spread-2`: `€7,757.80 @ 95.72%`, `spread-3`: `€2,783.08 @ 96.45%`, `spread-5`: `€6,160.08 @ 94.22%`)
- **`F1`:** `€37,434.42` | `minOT 94.22%` | `avgOT 95.62%` | `5/5 RANKED`
- **`F5` (`chain=true`, `1.29/1.32` floor):** `€37,363.63` | `minOT 92.89%` | `avgOT 95.02%` | `5/5 RANKED` (`fee/rev 68.26%`, peak `spread-1 €10,427.43 @ 96.87%`)
- **`F4` (`chain=true`):** `€37,155.29` | `minOT 90.18%` | `avgOT 93.76%` | `5/5 RANKED`
- **`F2`:** `€37,042.01` | `minOT 94.53%` | `avgOT 95.64%` | `5/5 RANKED`
- **`F6` (`chain=true`, `1.24/1.25` floor, `FORTRESS 0.929`):** `€36,895.26` | `minOT 91.85%` | `avgOT 94.64%` | `5/5 RANKED`

- **Active Knobs (`v23`):** `baseQuoteMultiplier=1.42`, `sameDayQuotePremium=0.25`, `minExpectedMarginRatio=0.19`, `targetWinRate=0.32`, `maxActiveWaitingPerDriver=0.41`, `maxOrdersPerBatch=5`, `baseFeeMultiplier=1.05`, `maxNormalFeeMultiplier=1.36`, `urgentFeeMultiplier=1.75`, `maxUrgentFeeMultiplier=2.20`, `scarcityTownFeeBoost=0.14`, `directOfferDiscount=1.015`, `targetOnTimeBuffer=0.935`, `chainGigs=false`.
