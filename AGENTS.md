# AGENTS.md — Bahn Express "Spread" Quantitative Dispatch Rules

- **Challenge:** Bahn Express "Spread" (Junction 2026) + Google DeepMind "Best Use of Gemini API".
- **Hard Constraint:** Every simulation run and ranking board run MUST maintain `onTimeShare >= 0.90` (target `>= 0.935` safety buffer) to qualify as `RANKED`.
- **Port Requirement:** The Live Command Center (`server.ts`) must always run on port `3001` (`http://localhost:3001`).
- **Gemini SDK Rule:** Always use `@google/genai` (`client.interactions.create`) with `model: "gemini-4-hydrogen"` and JSON Schema `response_format`.
- **Skill Reference:** Activate `.agents/skills/spread-auto-optimizer/SKILL.md` whenever running sweeps, ranking rounds, or updating the dispatch engine.
