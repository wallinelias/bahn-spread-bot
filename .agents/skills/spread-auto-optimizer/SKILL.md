---
name: spread-auto-optimizer
description: Autonomous optimization, ranking-round execution, and jury slide generation skill for the Bahn Express "Spread" Challenge (Junction 2026) and Google DeepMind "Best Use of Gemini API" challenge. Use whenever improving the dispatch bot, running multi-seed training sweeps, playing the 5-world official ranking rounds (--board), preparing for the Saturday test finals / Sunday 08:00 AM final, or updating the Top 10 jury presentation.
---

# Spread Auto-Optimizer Skill (Junction 2026)

This skill teaches the agent how to autonomously evaluate, tune, and compete in the **Bahn Express "Spread"** dispatch challenge (`https://spread.bahnexpress.com`) while showcasing **Gemini 4 Hydrogen** (`@google/genai` Structured Outputs).

## 1. Core Golden Rules of the Spread Challenge
1. **The 90% On-Time Delivery Minimum (`onTimeShare >= 0.90`):**
   - A team is **only ranked** if **at least 90.0%** of its won orders arrive by their deadline (`score.ranked === true`).
   - In Ranking Rounds (5 secret Level 8 worlds), **all 5 runs** must achieve `>= 90.0%` on-time for the team to be ranked on the leaderboard.
   - Always keep `targetOnTimeBuffer >= 0.935` (93.5%) so even severe driver-shortage seeds stay safely above `91%–95%`.
2. **Never Commit Secrets:**
   - `SPREAD_KEY` and `GEMINI_API_KEY` live in `.env` (which is ignored by `.gitignore`). Never hardcode keys in source files.
3. **Use Current Gemini SDK & Model (`@google/genai` >= 3.2.0):**
   - Always use `client.interactions.create` with `model: "gemini-4-hydrogen"` and `response_format: { type: "text", mime_type: "application/json", schema }` in `gemini-strategist.ts`.

## 2. Automated Workflows & Commands

### A. Multi-Seed Self-Tuning Sweep (`npm run sweep`)
To test code changes or let `gemini-4-hydrogen` self-tune across multiple deterministic Level 8 worlds (`spread-1`, `spread-2`, `spread-3`, etc.):
```bash
node --env-file=.env auto-trainer.ts --sweep 3
```
- Compares every seed against the Champion Strategy in `data/strategy.json`.
- Only promotes a new strategy parameter set if `ranked === true` and `onTimeShare >= 0.92`.

### B. Play All 5 Official Ranking Board Worlds (`npm run board-all`)
New Ranking Rounds open at:
- **Friday:** `19:30`
- **Saturday:** `00:00`, `09:00`, `12:00`, `15:00`, `18:00`, `21:00`
- **Sunday:** `00:00`, `03:00`, `06:00`

Run all 5 worlds of the active Level 8 Ranking Round automatically:
```bash
node --env-file=.env auto-trainer.ts --board-round
```

### C. Saturday Test Finals (`14:00` & `20:00`) and Sunday `08:00 AM` Live Final
Start the final runner **15–30 minutes before** start time (`13:45` / `19:45` Saturday, or `07:30` Sunday). It automatically waits for `GET /v1/final` to open, connects via WebSocket stream, and recovers from server restarts:
```bash
npm run final
# Or in the cloud on Modal:
modal run modal_deploy.py --final
```

### D. Live Command Center & Jury Slide Deck (`http://localhost:3001`)
Keep `server.ts` running on port `3001`:
```bash
npm run dashboard
```
- Dashboard: `http://localhost:3001/`
- Interactive Jury Presentation Deck: `http://localhost:3001/presentation`
