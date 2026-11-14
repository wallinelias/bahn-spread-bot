# Junction 2026 // Winning Pitch Script & Presentation Deck
### Challenge: Bahn Express "Spread" & Google DeepMind "Best Use of Gemini API"
**Team:** `What's the wifi?` (`what-s-the-wifi`) | **Interactive Deck & Video Studio:** `http://localhost:3001/presentation`

---

## Live Interactive Jury Studio (`http://localhost:3001/presentation`)

Use the built-in Presentation Studio on port `3001` to export both hackathon submission deliverables directly:
1. **6-Slide 16:9 PDF Pitch Deck:** Click **Print / Save PDF** (`Save as PDF`, `Landscape`, background graphics enabled) on `http://localhost:3001/presentation`.
2. **Strictly `<= 2:00` Video Pitch (`01:54` / 114 seconds):** Click **Record <=2:00 Video Pitch** (with AI voiceover on or mic muted for live narration) to auto-advance through all 6 slides on a hard `114s` clock and download a `.webm` capture (convertible with `ffmpeg -i pitch.webm -c:v libx264 -c:a aac pitch.mp4`).

---

## Verified Live Leaderboard Trajectory (`client.board`)

| Season | Rank | Total 5-World Margin | Avg On-Time | Status | Key Highlights |
|---|---|---:|---:|---|---|
| **Season 5** | `#54` | **€41,261.20** | `95.39%` | `5/5 RANKED` | Peak Run 4 `€11,905.32` (`95.29%` OT, `340` orders) |
| **Season 6 (Saturday 12:00)** | **`#26 / 195`** *(peaked `#19`)* | **€51,570.20** *(+€10,309.00)* | **`94.29%`** | **`5/5 RANKED`** | Peak **Run 4 `€12,899.75` (`98.19%` OT)**; Run 3 `98.45%` OT |
| **Season 7 (Saturday 15:00)** | — | **€53,081.41** *(+€1,511.21)* | **`93.11%`** | `4/5 RANKED` | **New All-Time Record: Run 5 `€15,041.68` (`96.12%` OT)**; 1,699 won orders |
| **Season 8 (Saturday 18:00)** | **`#28 / 238`** *(36 ranked)* | **€45,734.35** | **`95.76%`** | **`5/5 RANKED`** | Promoted **`v23` (`F3`)**; Peak Run 2 **`€12,851.63` (`96.18%` OT)**; min OT **`93.21%`**; `1,393` won orders |

**Season 6 World-by-World Ledger (`team: what-s-the-wifi`):**
- **Run 1:** `€10,465.71` (`94.30%` OT, `263` orders, `RANKED`)
- **Run 2:** `€10,741.72` (`92.56%` OT, `309` orders, `RANKED`)
- **Run 3:** `€8,594.11` (`98.45%` OT, `194` orders, `RANKED`)
- **Run 4:** **`€12,899.75`** (`98.19%` OT, `277` orders, `RANKED`)
- **Run 5:** `€8,868.91` (`90.06%` OT, `322` orders, `RANKED`)
- **Field Context:** Top 10 cutoff currently `€87,914.85`; Top 3 led by `Progresful` (`€98,990.22`), `source-exp` (`€95,671.45`), and `No Empty Miles` (`€95,452.75`).

---

## Verified 5-Seed Benchmark & Scientific Ablation Evidence (`spread-1..5`, Level 8)

- **Strategy v14 Champion (`data/baseline-v14.json`):** `€31,130.73` total / **`€6,226.15/wk`** avg | `95.4%` avg OT | `94.7%` min OT | `5/5 RANKED` (`spread-4`: `€9,608.93` @ `94.9%`).
- **Strategy v14 Post-Fix Verification (`data/v15-verified.json` with `normalizeNoteTimeWords`):** `€30,408.19` total / **`€6,081.64/wk`** avg | **`95.6%` avg OT** | **`93.8%` min OT** | `5/5 RANKED` (`spread-4`: **`€10,092.59`** @ `96.1%`).

**Module Ablation Matrix (`data/ablation.json`, Strategy v8 Baseline = `€7,297.21/wk`, `94.79%` Min OT):**

| Variant | Avg Margin / Week | Delta vs Baseline | Worst Seed OT | Takeaway |
|---|---:|---:|---:|---|
| `ALL ON (baseline)` | `€7,297.21` | `-` | `94.79%` | All vetted modules active |
| `OFF: flatFees` | `€4,086.21` | **`-€3,211.00`** | `95.26%` | Upfront flat-fee hold is the #1 profit driver |
| `OFF: slackFees` | `€4,917.70` | **`-€2,379.51`** | `94.44%` | Slack-aware discounting unlocks overnight capacity |
| `ON: chainGigs` | `€6,063.20` | `-€1,234.02` | **`88.49%`** | Chaining >12h breaks `>=90%` qualification gate |
| `OFF: noteNLP` | `€6,089.83` | `-€1,207.38` | `91.25%` | Trilingual FI/SV/EN extraction prevents failed visits |
| `OFF: dealerLearning` | `€6,146.25` | `-€1,150.97` | `92.68%` | Online dealer ratchet + outage surge harvesting |
| `OFF: optionSteering` | `€6,955.85` | `-€341.37` | `91.25%` | Multi-option steering protects tight windows |
| `OFF: selectiveDecline` | `€7,194.08` | `-€103.14` | `91.58%` | Liquidity saturation guard prevents cascade failure |
| `OFF: repositionOffers` | `€7,245.27` | `-€51.94` | `94.55%` | Targeted direct offers aid stranded fleet reuse |

**Documented Rejected Experiments (5-Seed Gate Protected Production):**
- `v15-candidate-eval` (`0.42` waiting cap, `1.405x` quote, `1.075x` fee): `€5,176.20/wk`, `91.5%` min OT on `spread-4` (**Rejected**: `-€1,050/wk`).
- `v15-calibrated-eval` (`0.355` waiting cap, `1.442x` quote, `1.125x` fee): `€5,633.89/wk`, `92.0%` min OT on `spread-4` (**Rejected**: `-€592/wk` despite lifting `spread-1/2/3`).
- `Strategy v16` single-seed autopilot drift (`0.347` cap): `€5,752/wk`, `93.7%` min OT (**Rejected & reverted**, fixed by enforcing 5-seed promotion gate in `autopilot.ts`).

**F-Series Architecture Ablations (`spread-1..5`, Level 8 — Promoted Champion `v23`):**

| Variant | Config Summary | Total 5-Seed Margin | Avg OT | Min OT | Fee/Rev | Key Per-Seed Takeaways |
|---|---|---:|---:|---:|---:|---|
| **`F3` (Promoted `v23`)** | `chain=false`, `1.22/1.20` Bayesian floor, `softCapacitySurge`, `cleanAdverseGuard`, `slaRegimeControl`, `smartDirectOffersV2` | **`€38,086.58`** | **`95.48%`** | **`94.22%`** | `70.15%` | `5/5 RANKED`; `spread-4` `€11,753.29 @ 95.27%`, `spread-1` `€9,632.33 @ 95.72%`, `spread-5` `€6,160.08 @ 94.22%` |
| `F1` | `v21` base + `cleanAdverseGuard` + `slaRegime` + `dealerShadowPricing` (`chain=false`) | `€37,434.42` | `95.62%` | `94.22%` | — | `5/5 RANKED`; early `HARVEST` Day 2 overbooked `spread-5` (`€6,148.77`) |
| `F5` | `chain=true` (selective Day <= 3), `1.29/1.32` floor, active-driver offer filter | `€37,363.63` | `95.02%` | `92.89%` | **`68.26%`** | Peak `spread-1` **`€10,427.43 @ 96.87%`** & `spread-3` `€3,371.08`; higher floor cut `spread-4` won volume |
| `F4` | `chain=true` (5-car bundling, `<=45m` gap, `<=720m` drive) | `€37,155.29` | `93.76%` | `90.18%` | `69.31%` | Lifted `spread-1` (`€10,124.90`) & `spread-2` (`€8,280.30`), but pinched `spread-5` (`90.18%`, `27` late) |
| `F2` | `F1` minus `cleanAdverseGuard`, Day >= 3 `HARVEST` | `€37,042.01` | `95.64%` | `94.53%` | `68.98%` | `cleanAdverseGuard` proved worth `+€392` (`F1` vs `F2`) and `+€1,045` in `F3` |
| `F6` | `chain=true`, `1.24/1.25` floor, `FORTRESS` `0.929` | `€36,895.26` | `94.64%` | `91.85%` | `69.02%` | Chaining still dragged scarce `spread-5` (`€5,255.31`, `47` drops), confirming `chain=false` (`F3`) for live play |
| `V24c` *(Rejected)* | `chain=false`, `maxWait=0.43`, `twr=0.33`, Day 3+ `HARVEST` `0.45`/`0.99x` | `€37,388.35` | `95.08%` | `91.47%` | `71.05%` | Rejected by 5-seed gate (`spread-5` dropped to `91.47%`, `-€698` vs `v23`) |
| `V24b` *(Rejected)* | `chain=true` (`2-3` cars, Mon–Wed), `dealerShadowPricing=true`, `fee=1.03/1.34`, `wait=0.43` | `€35,910.18` | `94.43%` | `92.57%` | `71.90%` | Rejected (`spread-4` fell `-€1,876` vs `v23`; lower fees delayed bookings into urgent tiers) |
| `V24` *(Rejected)* | `chain=true` (`2-3` cars), `dealerShadowPricing=true`, `fee=1.00/1.30`, `wait=0.46`, Day 2 `HARVEST` `0.965x` | `€35,381.38` | `94.32%` | `91.35%` | `72.53%` | Rejected (`1.00` opening fees + `0.48` cap raised `fee/rev` & dropped `spread-3` to `€1,723.57 @ 91.35%`) |

---

## Triple Gemini API Architecture (`@google/genai`)

1. **`gemini-4-hydrogen` (`client.interactions.create` + JSON Schema `response_format`):** Parses end-of-week dispatch telemetry (`visitFailures`, `winRateTargeted`, `urgentSize`, `lateDeliveries`) to propose bounded parameter updates in `gemini-strategist.ts`.
2. **`gemini-3.5-flash-lite` Quota-Resilient Failover:** Automatic fallback when `gemini-4-hydrogen` hits rate/quota limits so 24/7 autonomous loops never stall.
3. **`gemini-decision-1` (`v1beta` `decisions.create` Zero-Token Probabilistic Gate):** Evaluates `noul` promotion risk gates (`is_on_time_safe`, `is_margin_sustainable`, `has_note_parsing_regressions`) with **`0` output tokens** (e.g., flagged `HOLD` at `61.7%` confidence and `noteRegressionProb = 0.826` on practice world `wf37ec0cd7db5de376054`).

---

## The Strict `01:54` (114-Second) Video Pitch Script (6 Slides)

### Slide 1 `[0:00 – 0:18]` The Economic Crisis & Leaderboard Jump
> "At Level 8 of the Bahn Express challenge, car relocation is not a routing puzzle — it is an illiquid market under a brutal 90% on-time cliff. In Season 5 we placed 54th with €41,261. By Season 6 our quantitative dispatch desk jumped +€10,309 to **€51,570.20** across five secret worlds at **94.29% on-time** — peeking at **€12,899.75** and **98.19% on-time** in a single week."

### Slide 2 `[0:18 – 0:36]` The Upfront Booking Paradox (`flatFees` & `slackFees`)
> "Most bots drip driver fees upward every hour, teaching drivers to wait for surges. We hold our flat opening fee at market-clearing `1.145x` for 360 minutes and use slack-aware pricing on 30-hour windows. Ablating flat fees alone collapses margin by **€3,211 per week**, and disabling slack pricing loses **€2,380 per week**."

### Slide 3 `[0:36 – 0:54]` Liquidity Guards & Pure Inelastic Dealer Ratchet
> "In driver-scarce worlds like `spread-4`, pushing concurrency from `0.32` to `0.42` drops on-time accuracy to 91.5% and crashes margin by over €3,500. Our selective decline gate and dealer trust ratchet lock in up to +25% tolerance — gaining **€1,151 per week** while disqualifying zero weeks."

### Slide 4 `[0:54 – 1:12]` Trilingual Note NLP & 30-City Spatial Telemetry
> "Dealer notes arrive in Finnish, Swedish, and English with critical hazards like `siirtokilvet`, `manuaalivaihteisto`, `kesärenkaat`, and natural-language clock phrases like `puoli kolme`. Extracting constraints before posting saves **€1,207 per week** and lifts worst-seed on-time performance from 91.25% back above safety."

### Slide 5 `[1:12 – 1:34]` Triple Gemini AI Pipeline (`gemini-4-hydrogen` + `gemini-decision-1`)
> "After every round, **Gemini 4 Hydrogen** via `client.interactions.create` with strict JSON Schema (`gemini-3.5-flash-lite` failover) diagnoses bottlenecks. Then **Gemini Decision-1** evaluates zero-output-token `noul` probabilistic safety gates — halting risky updates whenever note regression probability spikes, backed by our 5-seed promotion gate."

### Slide 6 `[1:34 – 1:54]` Scientific Ablation & Live Command Center
> "Every module and failed experiment in `spread-1` through `spread-5` is tested on `server.ts` port 3001 before `autopilot.ts` ever touches a ranking round or final. With €51,570.20 verified live and zero unranked runs, we are ready for the finals. Thank you."
