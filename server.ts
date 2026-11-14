import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { Client } from "./spread.ts"
import { runSimulationRound, type LiveProgressUpdate } from "./bot.ts"
import { runAutoSweep, runOfficialBoardRound } from "./auto-trainer.ts"
import {
  loadRuns,
  loadStrategy,
  type DailyMetric,
} from "./strategy-config.ts"
import {
  evaluatePromotionWithGeminiDecision,
  loadGeminiDecisions,
  tuneStrategyWithGemini,
} from "./gemini-strategist.ts"

const PORT = Number(process.env.PORT || 3001)

interface ActiveRunState {
  running: boolean
  startedAt: string | null
  level: number
  seed: string | null
  board: boolean
  latestProgress: LiveProgressUpdate | null
  dailyMetrics: DailyMetric[]
  logs: string[]
}

const activeRun: ActiveRunState = {
  running: false,
  startedAt: null,
  level: 8,
  seed: "spread-1",
  board: false,
  latestProgress: null,
  dailyMetrics: [],
  logs: [],
}

const sseClients = new Set<http.ServerResponse>()

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

function addLog(msg: string): void {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  activeRun.logs.push(line)
  if (activeRun.logs.length > 100) activeRun.logs.shift()
  broadcast("log", { line })
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(JSON.stringify(body))
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SPREAD // Quantitative Dispatch & Gemini 4 Hydrogen Command Center</title>
  <style>
    :root {
      --bg: #07090e;
      --panel: #0f1420;
      --panel-alt: #151c2c;
      --border: #222d44;
      --text: #edf2ff;
      --muted: #8b9bb4;
      --accent: #38bdf8;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.14);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.14);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.14);
      --purple: #a855f7;
      --purple-bg: rgba(168, 85, 247, 0.15);
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --font-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 15% 0%, #111a2e 0%, var(--bg) 55%);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      padding: 20px 28px;
      line-height: 1.45;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-badge {
      background: linear-gradient(135deg, #0ea5e9, #6366f1);
      color: #fff;
      font-weight: 800;
      font-family: var(--font-mono);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 14px;
      letter-spacing: 0.06em;
      box-shadow: 0 0 20px rgba(56, 189, 248, 0.35);
    }
    .brand h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
    .brand p { font-size: 12.5px; color: var(--muted); }
    .status-pills { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      font-family: var(--font-mono);
      border: 1px solid var(--border);
      background: var(--panel);
    }
    .pill.green { color: var(--green); background: var(--green-bg); border-color: rgba(16,185,129,0.35); }
    .pill.purple { color: #c084fc; background: var(--purple-bg); border-color: rgba(168,85,247,0.35); }
    .pill.amber { color: var(--amber); background: var(--amber-bg); border-color: rgba(245,158,11,0.35); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }

    .controls-bar {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
      margin-bottom: 20px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.35);
    }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
    .field input, .field select {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 7px;
      font-size: 13px;
      font-family: var(--font-mono);
      outline: none;
    }
    .btn {
      cursor: pointer;
      border: none;
      padding: 9px 15px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      transition: all 0.15s ease;
    }
    .btn-primary {
      background: linear-gradient(135deg, #0ea5e9, #2563eb);
      color: #fff;
      box-shadow: 0 4px 16px rgba(14, 165, 233, 0.35);
    }
    .btn-emerald {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3);
    }
    .btn-purple {
      background: linear-gradient(135deg, #9333ea, #6366f1);
      color: #fff;
      box-shadow: 0 4px 16px rgba(147, 51, 234, 0.3);
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .kpi-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
      position: relative;
      overflow: hidden;
    }
    .kpi-card::after { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px; background: var(--accent); }
    .kpi-card.emerald::after { background: var(--green); }
    .kpi-card.purple::after { background: var(--purple); }
    .kpi-card.amber::after { background: var(--amber); }
    .kpi-label { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .kpi-value { font-size: 28px; font-weight: 800; font-family: var(--font-mono); letter-spacing: -0.03em; margin-bottom: 6px; }
    .kpi-sub { font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; align-items: center; }
    .badge { padding: 2px 8px; border-radius: 5px; font-size: 11px; font-weight: 700; font-family: var(--font-mono); }
    .badge.green { background: var(--green-bg); color: var(--green); }
    .badge.red { background: var(--red-bg); color: var(--red); }
    .badge.purple { background: var(--purple-bg); color: #c084fc; }

    .main-grid {
      display: grid;
      grid-template-columns: 1.55fr 1fr;
      gap: 18px;
      margin-bottom: 20px;
    }
    @media (max-width: 1100px) { .main-grid { grid-template-columns: 1fr; } }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .card-title { font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; display: flex; align-items: center; gap: 8px; }

    table { width: 100%; border-collapse: collapse; font-size: 12.5px; font-family: var(--font-mono); }
    th, td { padding: 9px 10px; text-align: right; border-bottom: 1px solid rgba(34, 45, 68, 0.6); }
    th:first-child, td:first-child { text-align: left; }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; font-weight: 600; }
    tr:hover td { background: rgba(56, 189, 248, 0.04); }

    .gemini-box {
      background: linear-gradient(180deg, rgba(168, 85, 247, 0.09) 0%, rgba(15, 20, 32, 0.9) 100%);
      border: 1px solid rgba(168, 85, 247, 0.35);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 14px;
    }
    .gemini-analysis { font-size: 13px; color: #e2e8f0; margin-bottom: 10px; line-height: 1.5; }
    .adj-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
    .adj-list li { font-size: 12px; color: #cbd5e1; padding-left: 16px; position: relative; font-family: var(--font-mono); }
    .adj-list li::before { content: '⚡'; position: absolute; left: 0; color: #c084fc; }

    .param-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); gap: 10px; }
    .param-item { background: var(--panel-alt); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
    .param-name { font-size: 11px; color: var(--muted); font-family: var(--font-mono); }
    .param-val { font-size: 16px; font-weight: 700; font-family: var(--font-mono); color: var(--accent); margin-top: 2px; }

    .log-box {
      background: #05070b;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-family: var(--font-mono);
      font-size: 11.5px;
      color: #94a3b8;
      max-height: 180px;
      overflow-y: auto;
    }
    .log-line { margin-bottom: 3px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-badge">BAHN // SPREAD</div>
      <div>
        <h1>Autonomous Quantitative Dispatch &amp; Gemini 4 Hydrogen Brain</h1>
        <p>Junction 2026 &bull; Real-Time Shortage Pricing, Multi-Option Steering, Multilingual Note NLP &amp; Auto-Pilot</p>
      </div>
    </div>
    <div class="status-pills">
      <div class="pill green" id="simStatusPill"><span class="dot"></span><span id="simStatusText">IDLE // READY</span></div>
      <div class="pill purple"><span class="dot"></span><span>GEMINI 4 HYDROGEN + DECISION-1</span></div>
      <div class="pill amber" id="strategyVerPill">STRATEGY v1</div>
      <a href="/presentation" class="btn btn-purple" style="text-decoration:none;padding:7px 14px;">&#127902;&#65039; Jury Deck &amp; 1:54 Video Studio</a>
    </div>
  </header>

  <section class="controls-bar">
    <div class="field">
      <label for="levelSelect">World Level</label>
      <select id="levelSelect">
        <option value="8" selected>Level 8 — Final (Trust + Shortage + Price War)</option>
        <option value="7">Level 7 — Driver Shortage</option>
        <option value="6">Level 6 — Surprises (Outage/Flu/Bulk)</option>
      </select>
    </div>
    <div class="field">
      <label for="seedInput">Deterministic Seed</label>
      <input id="seedInput" type="text" value="spread-1" placeholder="e.g. spread-1" style="width: 130px;" />
    </div>
    <div class="field">
      <label for="modeSelect">Run Mode</label>
      <select id="modeSelect">
        <option value="practice" selected>Practice Seed</option>
        <option value="board">Official Ranking Board (--board)</option>
      </select>
    </div>
    <div class="field">
      <label for="geminiKeyInput">Gemini API Key (Optional)</label>
      <input id="geminiKeyInput" type="password" placeholder="Uses .env GEMINI_API_KEY" style="width: 180px;" />
    </div>
    <button class="btn btn-primary" id="runBtn" onclick="startSimulation()">
      <span>&#9654; Run Simulation Round</span>
    </button>
    <button class="btn btn-emerald" id="sweepBtn" onclick="startAutoSweep()">
      <span>&#128257; Auto-Train 3-Seed Sweep</span>
    </button>
    <button class="btn btn-purple" id="boardBtn" onclick="startOfficialBoardRound()">
      <span>&#127942; Auto-Play 5x Ranking Board</span>
    </button>
  </section>

  <section class="kpi-grid">
    <div class="kpi-card emerald">
      <div class="kpi-label">Gross Margin (Score)</div>
      <div class="kpi-value" id="kpiMargin">&euro;0.00</div>
      <div class="kpi-sub">
        <span id="kpiRevenue">Rev: &euro;0.00 (0.0% margin)</span>
        <span class="badge green" id="kpiVsStarter">+&euro;72,612 vs Starter</span>
      </div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">On-Time Arrival % (&ge;90% Rule)</div>
      <div class="kpi-value" id="kpiOnTime">100.0%</div>
      <div class="kpi-sub">
        <span id="kpiUndelivered">0.0% undelivered</span>
        <span class="badge green" id="kpiRankedBadge">RANKED (&ge;90%)</span>
      </div>
    </div>
    <div class="kpi-card amber">
      <div class="kpi-label">Win Rate &amp; Selective Quoting</div>
      <div class="kpi-value" id="kpiWinRate">0.0%</div>
      <div class="kpi-sub">
        <span id="kpiOrdersWon">0 won / 0 targeted</span>
        <span id="kpiDeclined">0 risky declined</span>
      </div>
    </div>
    <div class="kpi-card purple">
      <div class="kpi-label">Dispatch &amp; Note NLP Telemetry</div>
      <div class="kpi-value" id="kpiGigsBooked">0 / 0</div>
      <div class="kpi-sub">
        <span id="kpiDirectOffers">0 Direct Offers</span>
        <span id="kpiVisitFails">0 Visit Fails</span>
      </div>
    </div>
  </section>

  <div class="main-grid">
    <div class="card">
      <div class="card-header">
        <div class="card-title">&#128200; Real-Time Week Trajectory (Day-by-Day Telemetry)</div>
        <span class="badge purple" id="currentWorldBadge">World: —</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Gross Margin</th>
            <th>Revenue</th>
            <th>Won Orders</th>
            <th>On-Time %</th>
            <th>Undelivered</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="dailyTableBody">
          <tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px;">Click "Run Simulation Round" or wait for active run...</td></tr>
        </tbody>
      </table>

      <div class="card-header" style="margin-top: 22px;">
        <div class="card-title">&#127942; Simulation Round History &amp; Leaderboard Benchmark</div>
      </div>
      <table>
        <thead>
          <tr>
            <th>World ID</th>
            <th>Lvl / Seed</th>
            <th>Gross Margin</th>
            <th>Revenue</th>
            <th>Orders (Win %)</th>
            <th>On-Time %</th>
            <th>Strategy</th>
          </tr>
        </thead>
        <tbody id="runsTableBody"></tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">&#129504; Gemini Multi-Model Strategist &amp; Decision Guardrail</div>
        <span class="badge purple">@google/genai v1beta + Interactions</span>
      </div>
      <div class="gemini-box">
        <div class="gemini-analysis" id="geminiAnalysisText">
          After each round, telemetry (win rate, late deliveries, deadline warnings, ledger breakdown) is passed to <code>gemini-4-hydrogen</code> with Structured Outputs to automatically calibrate pricing and driver fee schedules.
        </div>
        <ul class="adj-list" id="geminiAdjList"></ul>
      </div>

      <div class="gemini-box" style="background:linear-gradient(180deg, rgba(16,185,129,0.08) 0%, rgba(15,20,32,0.95) 100%); border-color: rgba(16,185,129,0.35);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#34d399;">Calibrated Guardrail (<code>gemini-decision-1</code>)</strong>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="badge green" id="decisionVerdictBadge">PROMOTE // READY</span>
            <button class="btn" onclick="triggerDecisionEval()" style="padding:3px 9px;font-size:11px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;">Re-score</button>
          </div>
        </div>
        <div id="decisionProbRow" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-family:var(--font-mono);font-size:11.5px;">
          <div class="param-item"><div class="param-name">P(On-Time Safe)</div><div class="param-val" id="decOnTimeProb">—</div></div>
          <div class="param-item"><div class="param-name">P(Margin Sustain)</div><div class="param-val" id="decMarginProb">—</div></div>
          <div class="param-item"><div class="param-name">P(Note Regress)</div><div class="param-val" id="decNoteProb">—</div></div>
        </div>
        <div id="decisionMeta" style="font-size:11px;color:var(--muted);margin-top:6px;font-family:var(--font-mono);">0 output tokens calibrated Noul evaluator</div>
      </div>

      <div class="card-header" style="margin-top: 16px;">
        <div class="card-title">&#127942; Official Season Leaderboard (Level 8)</div>
        <span class="badge green" id="seasonRankBadge">Loading...</span>
      </div>
      <div id="seasonBoardBox" style="font-family:var(--font-mono);font-size:12px;margin-bottom:14px;background:var(--panel-alt);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--muted);">
        Loading live Bahn Express Season Leaderboard...
      </div>

      <div class="card-header" style="margin-top: 16px;">
        <div class="card-title">&#9881;&#65039; Active Dispatch Parameters</div>
        <span class="badge green" id="updatedByBadge">default</span>
      </div>
      <div class="param-grid" id="paramGrid"></div>

      <div class="card-header" style="margin-top: 16px;">
        <div class="card-title">&#128187; Live Engine Event Stream</div>
      </div>
      <div class="log-box" id="logBox"></div>
    </div>
  </div>

  <script>
    const fmtEuro = (cents) => '€' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = (share) => (share * 100).toFixed(1) + '%';

    function renderStrategy(strategy, tuning) {
      if (!strategy) return;
      document.getElementById('strategyVerPill').textContent = 'STRATEGY v' + strategy.version;
      document.getElementById('updatedByBadge').textContent = strategy.updatedBy;

      const params = [
        ['baseQuoteMultiplier', strategy.baseQuoteMultiplier + 'x'],
        ['sameDayQuotePremium', '+' + (strategy.sameDayQuotePremium * 100).toFixed(0) + '%'],
        ['minExpectedMargin', (strategy.minExpectedMarginRatio * 100).toFixed(0) + '%'],
        ['targetWinRate', (strategy.targetWinRate * 100).toFixed(0) + '%'],
        ['maxWaitingPerDriver', strategy.maxActiveWaitingPerDriver],
        ['maxOrdersPerBatch', strategy.maxOrdersPerBatch + ' cars'],
        ['baseFeeMultiplier', strategy.baseFeeMultiplier + 'x'],
        ['maxNormalFeeMult', strategy.maxNormalFeeMultiplier + 'x'],
        ['urgentFeeMultiplier', strategy.urgentFeeMultiplier + 'x'],
        ['maxUrgentFeeMult', strategy.maxUrgentFeeMultiplier + 'x'],
        ['scarcityTownBoost', '+' + (strategy.scarcityTownFeeBoost * 100).toFixed(0) + '%'],
        ['targetOnTimeBuffer', (strategy.targetOnTimeBuffer * 100).toFixed(1) + '%'],
      ];
      document.getElementById('paramGrid').innerHTML = params.map(([k, v]) => \`
        <div class="param-item">
          <div class="param-name">\${k}</div>
          <div class="param-val">\${v}</div>
        </div>
      \`).join('');

      if (tuning) {
        document.getElementById('geminiAnalysisText').textContent = tuning.analysis;
        document.getElementById('geminiAdjList').innerHTML = (tuning.keyAdjustments || [])
          .map((item) => \`<li>\${item}</li>\`).join('');
      } else if (strategy.reasoningSummary) {
        document.getElementById('geminiAnalysisText').textContent = strategy.reasoningSummary;
      }
    }

    function renderKPIs(score, telemetry, worldId, level) {
      if (!score) return;
      const marginEl = document.getElementById('kpiMargin');
      marginEl.textContent = fmtEuro(score.marginCents);
      marginEl.style.color = score.marginCents >= 0 ? 'var(--green)' : 'var(--red)';

      document.getElementById('kpiRevenue').textContent = \`Rev: \${fmtEuro(score.revenueCents)} (\${fmtPct(score.marginShare || 0)} margin)\`;
      const diffStarter = score.marginCents - (-7261251);
      document.getElementById('kpiVsStarter').textContent = (diffStarter >= 0 ? '+' : '') + fmtEuro(diffStarter) + ' vs Starter';

      const onTimeEl = document.getElementById('kpiOnTime');
      onTimeEl.textContent = fmtPct(score.onTimeShare);
      onTimeEl.style.color = score.onTimeShare >= 0.92 ? 'var(--green)' : score.onTimeShare >= 0.90 ? 'var(--amber)' : 'var(--red)';

      document.getElementById('kpiUndelivered').textContent = fmtPct(score.undeliveredShare) + ' undelivered';
      const rankBadge = document.getElementById('kpiRankedBadge');
      rankBadge.textContent = score.ranked ? 'RANKED (≥90%)' : 'UNRANKED (<90%)';
      rankBadge.className = 'badge ' + (score.ranked ? 'green' : 'red');

      if (telemetry) {
        const winRate = telemetry.totalRequests > 0 ? telemetry.wonOrders / telemetry.totalRequests : 0;
        const targetWin = telemetry.quotedToWin > 0 ? telemetry.wonOrders / telemetry.quotedToWin : 0;
        document.getElementById('kpiWinRate').textContent = fmtPct(winRate) + ' (' + fmtPct(targetWin) + ' tgt)';
        document.getElementById('kpiOrdersWon').textContent = \`\${telemetry.wonOrders} won / \${telemetry.quotedToWin} bid\`;
        document.getElementById('kpiDeclined').textContent = \`\${telemetry.declinedHighQuote} risky declined\`;
        document.getElementById('kpiGigsBooked').textContent = \`\${telemetry.totalGigsBooked} / \${telemetry.totalGigsPosted} gigs\`;
        document.getElementById('kpiDirectOffers').textContent = \`\${telemetry.acceptedDirectOffers}/\${telemetry.totalDirectOffers} offers\`;
        const fails = Object.values(telemetry.visitFailures || {}).reduce((a, b) => a + b, 0);
        document.getElementById('kpiVisitFails').textContent = \`\${fails} visit fails\`;
      }
      if (worldId) {
        document.getElementById('currentWorldBadge').textContent = \`World: \${worldId} (Lvl \${level || 8})\`;
      }
    }

    function renderDailyMetrics(metrics) {
      const tbody = document.getElementById('dailyTableBody');
      if (!metrics || metrics.length === 0) return;
      tbody.innerHTML = metrics.map((m) => \`
        <tr>
          <td><strong>\${m.dayName}</strong> <span style="color:var(--muted)">(d\${m.dayIndex + 1})</span></td>
          <td style="color:\${m.marginCents >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700;">\${fmtEuro(m.marginCents)}</td>
          <td>\${fmtEuro(m.revenueCents)}</td>
          <td>\${m.wonOrders}</td>
          <td style="color:\${m.onTimeShare >= 0.90 ? 'var(--green)' : 'var(--red)'};font-weight:700;">\${fmtPct(m.onTimeShare)}</td>
          <td>\${fmtPct(m.undeliveredShare)}</td>
          <td><span class="badge \${m.ranked ? 'green' : 'red'}">\${m.ranked ? 'RANKED' : 'UNRANKED'}</span></td>
        </tr>
      \`).join('');
    }

    function renderRunsHistory(runs) {
      const tbody = document.getElementById('runsTableBody');
      if (!runs || runs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:16px;">No completed runs yet.</td></tr>';
        return;
      }
      tbody.innerHTML = runs.slice(0, 14).map((r) => \`
        <tr>
          <td><code>\${r.worldId}</code></td>
          <td>L\${r.level} / \${r.board ? 'BOARD' : (r.seed || 'rand')}</td>
          <td style="color:\${r.score.marginCents >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700;">\${fmtEuro(r.score.marginCents)}</td>
          <td>\${fmtEuro(r.score.revenueCents)}</td>
          <td>\${r.score.wonOrders} (\${fmtPct(r.telemetry?.winRateAll || 0)})</td>
          <td><span class="badge \${r.score.ranked ? 'green' : 'red'}">\${fmtPct(r.score.onTimeShare)}</span></td>
          <td>v\${r.strategyUsed?.version || 1} (\${(r.durationMs / 1000).toFixed(1)}s)</td>
        </tr>
      \`).join('');
    }

    function appendLogLine(line) {
      const box = document.getElementById('logBox');
      const div = document.createElement('div');
      div.className = 'log-line';
      div.textContent = line;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    async function loadInitialState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      renderStrategy(data.strategy, data.runs?.[0]?.geminiTuning);
      renderRunsHistory(data.runs);
      if (data.activeRun?.running) {
        setRunningUI(true);
        renderDailyMetrics(data.activeRun.dailyMetrics);
        if (data.activeRun.latestProgress) {
          const p = data.activeRun.latestProgress;
          renderKPIs(p.score, p.telemetry, p.worldId, p.level);
        }
      } else if (data.runs && data.runs.length > 0) {
        const latest = data.runs[0];
        renderKPIs(latest.score, latest.telemetry, latest.worldId, latest.level);
        renderDailyMetrics(latest.dailyMetrics);
      }
      (data.activeRun?.logs || []).forEach(appendLogLine);
      loadDecisionsWidget();
      loadSeasonBoardWidget();
    }

    async function loadDecisionsWidget() {
      try {
        const res = await fetch('/api/decisions');
        const data = await res.json();
        const latest = data.decisions?.[0];
        if (!latest) return;
        document.getElementById('decOnTimeProb').textContent = (latest.onTimeSafeProb * 100).toFixed(1) + '%';
        document.getElementById('decMarginProb').textContent = (latest.marginSustainableProb * 100).toFixed(1) + '%';
        document.getElementById('decNoteProb').textContent = (latest.noteRegressionProb * 100).toFixed(1) + '%';
        const badge = document.getElementById('decisionVerdictBadge');
        badge.textContent = latest.decision + ' (' + latest.confidence + ')';
        badge.className = 'badge ' + (latest.decision === 'PROMOTE' ? 'green' : 'red');
        document.getElementById('decisionMeta').textContent = latest.model + ' | ' + latest.totalOutputTokens + ' output tokens | world ' + latest.worldId;
      } catch {}
    }

    async function triggerDecisionEval() {
      const badge = document.getElementById('decisionVerdictBadge');
      badge.textContent = 'SCORING...';
      try {
        await fetch('/api/evaluate-decision', { method: 'POST' });
        await loadDecisionsWidget();
      } catch {}
    }

    async function loadSeasonBoardWidget() {
      try {
        const res = await fetch('/api/season-board');
        const data = await res.json();
        const badge = document.getElementById('seasonRankBadge');
        const box = document.getElementById('seasonBoardBox');
        if (data.ourCurrent) {
          badge.textContent = 'Rank #' + data.ourCurrent.rank + ' / ' + data.totalTeams + ' (€' + (data.ourCurrent.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')';
          badge.className = 'badge green';
          const prevTxt = data.ourPrevious ? ('Season ' + data.previousSeason + ': #' + data.ourPrevious.rank + ' (€' + (data.ourPrevious.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ')') : '';
          box.innerHTML = '<div><strong style="color:#10b981;">Season ' + data.currentSeason + ' (' + data.currentName + '):</strong> €' + (data.ourCurrent.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + ' &bull; ' + (data.ourCurrent.onTimeShare * 100).toFixed(2) + '% OT &bull; 5/5 Ranked</div>'
            + '<div style="margin-top:4px;">' + prevTxt + ' &rarr; <span style="color:#38bdf8;">+#10 Target: €' + ((data.top10ThresholdCents || 8234688) / 100).toLocaleString('en-US', { minimumFractionDigits: 0 }) + '</span></div>';
        }
      } catch {}
    }

    function setRunningUI(running) {
      document.getElementById('runBtn').disabled = running;
      document.getElementById('sweepBtn').disabled = running;
      document.getElementById('boardBtn').disabled = running;
      const pill = document.getElementById('simStatusPill');
      const text = document.getElementById('simStatusText');
      if (running) {
        pill.className = 'pill amber';
        text.textContent = 'RUNNING LIVE SIMULATION...';
      } else {
        pill.className = 'pill green';
        text.textContent = 'IDLE // READY';
      }
    }

    async function startSimulation() {
      const level = Number(document.getElementById('levelSelect').value);
      const seed = document.getElementById('seedInput').value.trim();
      const board = document.getElementById('modeSelect').value === 'board';
      const geminiApiKey = document.getElementById('geminiKeyInput').value.trim();
      document.getElementById('dailyTableBody').innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--accent);padding:20px;">Connecting to Spread server &amp; dispatching week...</td></tr>';
      setRunningUI(true);
      await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ level, seed: board ? undefined : (seed || undefined), board, geminiApiKey: geminiApiKey || undefined }),
      });
    }

    async function startAutoSweep() {
      setRunningUI(true);
      appendLogLine('Starting 3-Seed Auto-Training Sweep (spread-1, spread-2, spread-3)...');
      await fetch('/api/sweep', { method: 'POST' });
    }

    async function startOfficialBoardRound() {
      setRunningUI(true);
      appendLogLine('Starting 5-Run Official Ranking Board Auto-Pilot...');
      await fetch('/api/board-round', { method: 'POST' });
    }

    const evtSource = new EventSource('/api/events');
    evtSource.addEventListener('progress', (e) => {
      const p = JSON.parse(e.data);
      renderKPIs(p.score, p.telemetry, p.worldId, p.level);
    });
    evtSource.addEventListener('day', (e) => {
      const { dailyMetrics } = JSON.parse(e.data);
      renderDailyMetrics(dailyMetrics);
    });
    evtSource.addEventListener('complete', (e) => {
      const { summary, runs, strategy } = JSON.parse(e.data);
      setRunningUI(false);
      if (summary) {
        renderKPIs(summary.score, summary.telemetry, summary.worldId, summary.level);
        renderDailyMetrics(summary.dailyMetrics);
        renderStrategy(strategy, summary.geminiTuning);
      }
      renderRunsHistory(runs);
      loadDecisionsWidget();
      loadSeasonBoardWidget();
    });
    evtSource.addEventListener('log', (e) => {
      const { line } = JSON.parse(e.data);
      appendLogLine(line);
    });

    loadInitialState();
  </script>
</body>
</html>`

function readJsonSafe<T>(relPath: string, fallback: T): T {
  try {
    const full = path.join(process.cwd(), relPath)
    if (!fs.existsSync(full)) return fallback
    return JSON.parse(fs.readFileSync(full, "utf8")) as T
  } catch {
    return fallback
  }
}

const PRESENTATION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SPREAD // Jury Pitch Deck &amp; 1:54 Video Studio — Team What's the wifi?</title>
  <style>
    :root {
      --bg: #05070c;
      --panel: #0e1422;
      --panel2: #151e33;
      --border: #24314d;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --cyan: #38bdf8;
      --green: #10b981;
      --purple: #a855f7;
      --amber: #f59e0b;
      --red: #ef4444;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 20% 0%, #101b36 0%, var(--bg) 60%);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 14px 20px 28px;
    }
    .studio-bar {
      width: 100%;
      max-width: 1320px;
      background: rgba(14, 20, 34, 0.92);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 10px 16px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
      backdrop-filter: blur(10px);
    }
    .bar-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .btn {
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--panel2);
      color: var(--text);
      padding: 7px 13px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
      transition: transform 0.1s ease, background 0.15s ease;
    }
    .btn:hover { transform: translateY(-1px); background: #1e293b; }
    .btn-cyan { background: linear-gradient(135deg, #0ea5e9, #2563eb); border-color: transparent; }
    .btn-red { background: linear-gradient(135deg, #ef4444, #dc2626); border-color: transparent; }
    .btn-green { background: linear-gradient(135deg, #10b981, #059669); border-color: transparent; }
    .btn-purple { background: linear-gradient(135deg, #9333ea, #6366f1); border-color: transparent; }
    .timer-pill {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 800;
      padding: 6px 12px;
      border-radius: 8px;
      background: #090d16;
      border: 1px solid var(--cyan);
      color: var(--cyan);
    }

    .stage-wrap {
      width: 100%;
      max-width: 1320px;
      position: relative;
    }
    .slide {
      display: none;
      width: 100%;
      aspect-ratio: 16 / 9;
      background: linear-gradient(155deg, #0b1120 0%, #060912 100%);
      border: 1px solid #2b3a5c;
      border-radius: 16px;
      padding: 34px 44px 56px;
      position: relative;
      overflow: hidden;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.65);
      flex-direction: column;
      justify-content: space-between;
    }
    .slide.active { display: flex; }
    .slide::before {
      content: '';
      position: absolute;
      top: -120px;
      right: -120px;
      width: 380px;
      height: 380px;
      background: radial-gradient(circle, rgba(56, 189, 248, 0.14) 0%, transparent 70%);
      pointer-events: none;
    }
    .slide-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid rgba(56, 189, 248, 0.22);
      padding-bottom: 12px;
      margin-bottom: 16px;
    }
    .slide-tag {
      font-family: var(--mono);
      font-size: 12px;
      font-weight: 700;
      color: var(--cyan);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .slide-num {
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted);
    }
    h1.hero { font-size: 38px; font-weight: 900; letter-spacing: -0.03em; line-height: 1.12; margin-bottom: 10px; }
    h2.title { font-size: 28px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 12px; }
    .lead { font-size: 15.5px; color: #cbd5e1; line-height: 1.5; max-width: 940px; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 16px; }
    .grid-2 { display: grid; grid-template-columns: 1.15fr 1fr; gap: 22px; flex: 1; min-height: 0; align-items: stretch; }
    .stat-card {
      background: rgba(21, 30, 51, 0.78);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .stat-label { font-family: var(--mono); font-size: 11px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.06em; }
    .stat-big { font-family: var(--mono); font-size: 34px; font-weight: 900; margin: 8px 0 4px; }
    .stat-sub { font-size: 12.5px; color: #cbd5e1; }
    .pill-badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 700;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(16, 185, 129, 0.16);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.4);
    }
    .arch-flow {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      margin: 14px 0;
    }
    .arch-node {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(168, 85, 247, 0.45);
      border-radius: 10px;
      padding: 14px;
    }
    .arch-node h4 { font-size: 13px; color: #e9d5ff; margin-bottom: 5px; font-family: var(--mono); }
    .arch-node p { font-size: 12px; color: #cbd5e1; line-height: 1.4; }
    .slide-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      border-top: 1px solid rgba(36, 49, 77, 0.7);
      padding-top: 10px;
      margin-top: 12px;
    }
    .caption-bar {
      position: absolute;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      width: 88%;
      background: rgba(5, 7, 12, 0.92);
      border: 1px solid rgba(56, 189, 248, 0.45);
      border-radius: 10px;
      padding: 10px 18px;
      text-align: center;
      font-size: 15px;
      font-weight: 600;
      color: #f8fafc;
      z-index: 20;
      display: none;
      box-shadow: 0 10px 30px rgba(0,0,0,0.7);
    }
    .progress-track {
      width: 100%;
      max-width: 1320px;
      height: 5px;
      background: #131b2e;
      border-radius: 999px;
      overflow: hidden;
      margin-top: 10px;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--cyan), var(--purple), var(--green));
      transition: width 0.25s linear;
    }
    .bar-row { display: grid; grid-template-columns: 200px 1fr 90px 70px; align-items: center; gap: 10px; margin-bottom: 9px; font-family: var(--mono); font-size: 12px; }
    .bar-track { height: 18px; background: #090e1a; border-radius: 6px; border: 1px solid #1e293b; overflow: hidden; }
    .bar-val { height: 100%; border-radius: 5px; }
    .nlp-chip {
      cursor: pointer;
      font-family: var(--mono);
      font-size: 11px;
      background: #172036;
      border: 1px solid #334155;
      color: #cbd5e1;
      padding: 4px 8px;
      border-radius: 6px;
    }
    .nlp-chip:hover { border-color: var(--cyan); color: #fff; }
    textarea.nlp-input {
      width: 100%;
      background: #070b14;
      border: 1px solid var(--border);
      color: #f8fafc;
      border-radius: 8px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 12.5px;
      resize: none;
      margin: 8px 0;
    }

    @media print {
      @page { size: 16in 9in; margin: 0; }
      body { background: #05070c !important; padding: 0 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .studio-bar, .progress-track, .caption-bar { display: none !important; }
      .stage-wrap { max-width: none !important; width: 100% !important; }
      .slide {
        display: flex !important;
        width: 16in !important;
        height: 9in !important;
        aspect-ratio: auto !important;
        border: none !important;
        border-radius: 0 !important;
        page-break-after: always !important;
        break-after: page !important;
      }
      .slide:last-of-type { page-break-after: auto !important; break-after: auto !important; }
    }
  </style>
</head>
<body>
  <div class="studio-bar">
    <div class="bar-group">
      <a href="/" class="btn">&larr; Dashboard</a>
      <button class="btn" onclick="prevSlide()">&#9664; Prev</button>
      <span id="slideIndicator" style="font-family:var(--mono);font-size:12px;font-weight:700;">Slide 1 / 6</span>
      <button class="btn" onclick="nextSlide()">Next &#9654;</button>
    </div>
    <div class="bar-group">
      <div class="timer-pill" id="pitchTimer">00:00 / 01:54</div>
      <button class="btn btn-cyan" id="playPitchBtn" onclick="togglePitch()">&#9654; Play 1:54 Pitch</button>
      <button class="btn" id="voiceModeBtn" onclick="toggleVoiceMode()">&#128266; Gemini 3.8 TTS: ON</button>
      <a href="/api/tts/full-pitch-studio.wav" download="bahn-spread-gemini-3.8-tts-voiceover.wav" class="btn">&#11015; Voice (.wav)</a>
      <button class="btn btn-red" id="recBtn" onclick="recordPitchVideo()">&#128308; Record Video (.webm)</button>
      <button class="btn btn-green" onclick="window.print()">&#128424;&#65039; Export PDF Deck</button>
    </div>
  </div>

  <div class="stage-wrap">
    <div class="caption-bar" id="captionBar"></div>

    <!-- SLIDE 1 -->
    <section class="slide active" data-slide="1">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Junction 2026 &bull; Bahn Express "Spread" + Google DeepMind</div>
          <div class="slide-num">SLIDE 01 / 06 &bull; TEAM: WHAT'S THE WIFI?</div>
        </div>
        <h1 class="hero">SPREAD: Autonomous Quantitative Dispatch<br/>&amp; Dual-Model Gemini Engine</h1>
        <p class="lead">At Level 8, driver supply collapses by 60–75% while late deliveries slash dealer trust in half. We replaced greedy acceptance with an options-pricing liquidity desk backed by Gemini 4 Hydrogen and calibrated Noul safety guardrails.</p>
      </div>
      <div class="grid-3">
        <div class="stat-card" style="border-color:rgba(239,68,68,0.45);">
          <div class="stat-label">Baseline Starter Kit</div>
          <div class="stat-big" style="color:var(--red);">-€287,154</div>
          <div class="stat-sub">Accepts 100% of requests, collapses to 55.2% on-time arrival, <strong>DISQUALIFIED</strong> below the 90% floor.</div>
        </div>
        <div class="stat-card" style="border-color:rgba(56,189,248,0.45);">
          <div class="stat-label" id="s1SeasonLabel">Live Season Progression</div>
          <div class="stat-big" style="color:var(--cyan);" id="s1SeasonMargin">+€51,570</div>
          <div class="stat-sub" id="s1SeasonSub">Season 5 (€41,261) &rarr; Season 6 (€51,570.20, +25.0%), <strong>94.3% On-Time</strong>, 5/5 Runs Ranked!</div>
        </div>
        <div class="stat-card" style="border-color:rgba(16,185,129,0.5);">
          <div class="stat-label">Peak Live Weekly Margin</div>
          <div class="stat-big" style="color:var(--green);" id="s1PeakMargin">+€12,900</div>
          <div class="stat-sub" id="s1PeakSub">Run 4 (Saturday 12:00): <strong>€12,899.75</strong> margin on 277 orders with <strong>98.19%</strong> on-time arrival.</div>
        </div>
      </div>
      <div class="slide-foot">
        <span>Hard Constraint: Every run &ge; 90.0% on-time (Safety Floor &ge; 93.5%)</span>
        <span id="s1StrategyMeta">Strategy v14+ Live on localhost:3001</span>
      </div>
    </section>

    <!-- SLIDE 2 -->
    <section class="slide" data-slide="2">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Game-Theoretic Mechanism #1</div>
          <div class="slide-num">SLIDE 02 / 06 &bull; UPFRONT BOOKING PARADOX</div>
        </div>
        <h2 class="title">The Upfront Booking Paradox: Flat-Fee Clearing Equilibrium</h2>
        <p class="lead">Drivers remember the ratio <code>bookedFee / firstViewedFee</code>. Standard dispatchers start cheap and hike every hour—accidentally training drivers to boycott new gigs until hourly surges peak.</p>
      </div>
      <div class="grid-2">
        <div class="stat-card">
          <div class="stat-label" style="margin-bottom:8px;">Driver Fee Schedule vs. Time Posted (Visual Comparison)</div>
          <svg viewBox="0 0 520 220" style="width:100%;height:auto;max-height:230px;">
            <line x1="45" y1="185" x2="500" y2="185" stroke="#334155" stroke-width="1.5"/>
            <line x1="45" y1="20" x2="45" y2="185" stroke="#334155" stroke-width="1.5"/>
            <text x="50" y="34" fill="#94a3b8" font-size="11" font-family="monospace">1.9x Ref Fee</text>
            <text x="50" y="128" fill="#94a3b8" font-size="11" font-family="monospace">1.15x Clearing</text>
            <text x="395" y="204" fill="#94a3b8" font-size="11" font-family="monospace">t = +6h (Urgent)</text>
            <!-- Classic Ramp -->
            <polyline fill="none" stroke="#ef4444" stroke-width="3" stroke-dasharray="6,4" points="45,165 130,148 215,125 300,98 385,68 475,38"/>
            <circle cx="385" cy="68" r="5" fill="#ef4444"/>
            <text x="270" y="60" fill="#fca5a5" font-size="11" font-family="monospace">Rivals: Wait 4-5h &amp; Overpay</text>
            <!-- Flat Clearing Curve -->
            <polyline fill="none" stroke="#10b981" stroke-width="4" points="45,122 315,122 375,85 480,35"/>
            <circle cx="70" cy="122" r="6" fill="#10b981"/>
            <text x="82" y="108" fill="#34d399" font-size="12" font-weight="bold" font-family="monospace">Us: Book Immediately @ 1.00x Ratio!</text>
          </svg>
        </div>
        <div class="stat-card" style="justify-content:center;gap:14px;">
          <div>
            <div class="pill-badge">ABLATION PROVEN (+€3,211/WK)</div>
            <h3 style="margin-top:8px;font-size:19px;">Why Flat Fees Win Both Sides</h3>
          </div>
          <p style="font-size:13.5px;color:#cbd5e1;line-height:1.55;">By opening at a calibrated <strong>1.145x</strong> clearing price and holding it completely flat for 4–6 hours, our equilibrium locks <code>booked / firstViewed = 1.00</code>.</p>
          <div style="background:#080d18;border:1px solid var(--border);border-radius:8px;padding:12px;font-family:var(--mono);font-size:12.5px;">
            <div>Flat Fees ON : <strong style="color:var(--green);">€7,297/wk (95.3% OT)</strong></div>
            <div style="margin-top:4px;">Flat Fees OFF: <strong style="color:var(--red);">€4,086/wk (-44% Margin!)</strong></div>
          </div>
        </div>
      </div>
      <div class="slide-foot">
        <span>Zero Holdouts &rarr; Fewer deadline_close Emergencies</span>
        <span>Pre-deadline ramp auto-fires 5h before lastPickupAt</span>
      </div>
    </section>

    <!-- SLIDE 3 -->
    <section class="slide" data-slide="3">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Game-Theoretic Mechanism #2</div>
          <div class="slide-num">SLIDE 03 / 06 &bull; WORLD PRICING &amp; HIDDEN DIRECT OFFERS</div>
        </div>
        <h2 class="title">Inelastic Dealer Trust, World Price Regimes &amp; Hidden Drivers</h2>
        <p class="lead">Across secret worlds, rival pricing varies +26% to +54% above list price—and the Spread app only notifies drivers within 30 km of home.</p>
      </div>
      <div class="grid-3">
        <div class="stat-card">
          <div class="stat-label">1. Compounding Dealer Trust</div>
          <div class="stat-big" style="color:var(--amber);">+25%</div>
          <div class="stat-sub">Every on-time delivery grants +1% quote tolerance (late delivery halves trust). We defend &ge;94% OT so captive dealers accept up to <strong>1.65x+</strong> list price.</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">2. Adaptive World Price Guard</div>
          <div class="stat-big" style="color:var(--cyan);">Bayesian</div>
          <div class="stat-sub">Monitors rolling targeted win rate from Monday morning: when expensive worlds push win rate &gt;35.5%, quotes automatically ratchet up +0.12x to extract margin &amp; stop overload.</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">3. Delivery Continuation Offers</div>
          <div class="stat-big" style="color:var(--green);">&gt;30 km</div>
          <div class="stat-sub">Drivers finishing away from home never see app push alerts! Tracking actual <code>delivered</code> coordinates fires immediate homeward Direct Offers to stranded drivers.</div>
        </div>
      </div>
      <div class="slide-foot">
        <span>Regional Competitor Outage Streak Detector (+16% Surge Capture)</span>
        <span>Dynamic Margin Floor Enforced Per Request</span>
      </div>
    </section>

    <!-- SLIDE 4 -->
    <section class="slide" data-slide="4">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Physical World &amp; Language Intelligence</div>
          <div class="slide-num">SLIDE 04 / 06 &bull; 30-CITY FINLAND TOPOLOGY &amp; TRILINGUAL NLP</div>
        </div>
        <h2 class="title">Nordic Weather Corridors &amp; Trilingual Word-Number Note Parser</h2>
      </div>
      <div class="grid-2">
        <div class="stat-card" style="padding:14px;">
          <div class="stat-label" style="margin-bottom:6px;">Live 30-City Finland Dispatch &amp; Snow Topology</div>
          <svg id="finlandMapSvg" viewBox="0 0 360 320" style="width:100%;height:260px;background:#070b14;border-radius:8px;border:1px solid #1e293b;"></svg>
        </div>
        <div class="stat-card" style="padding:14px;">
          <div class="stat-label">Interactive Trilingual Note NLP Parser (FI / SV / EN)</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
            <button class="nlp-chip" onclick="setNlpSample(0)">FI: puoli kolme + siirtokilvet</button>
            <button class="nlp-chip" onclick="setNlpSample(1)">EN: not 3pm / half four / summer</button>
            <button class="nlp-chip" onclick="setNlpSample(2)">SV: senast kl fem / ej kl tre</button>
          </div>
          <textarea id="nlpInput" class="nlp-input" rows="2" oninput="runNlpDemo()">Nouto huomenna klo puoli kolme jälkeen, siirtokilvet mukaan, manuaalivaihteisto</textarea>
          <pre id="nlpOutput" style="background:#05080f;border:1px solid #1e293b;border-radius:8px;padding:10px;font-family:var(--mono);font-size:11.5px;color:#34d399;white-space:pre-wrap;flex:1;"></pre>
        </div>
      </div>
      <div class="slide-foot">
        <span>Turning Note NLP OFF costs -€1,207/wk in failed visits &amp; driver waste</span>
        <span>Handles Finnish/Swedish half-hours ("puoli kolme" = 14:30) + negations</span>
      </div>
    </section>

    <!-- SLIDE 5 -->
    <section class="slide" data-slide="5">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Google DeepMind Track // Best Use of Gemini API</div>
          <div class="slide-num">SLIDE 05 / 06 &bull; DUAL-MODEL GEMINI ARCHITECTURE</div>
        </div>
        <h2 class="title">Closed-Loop Gemini 4 Hydrogen + Calibrated Gemini-Decision-1</h2>
        <p class="lead">Instead of brittle single-shot prompting, we combine structured parameter optimization with zero-output-token calibrated probability guardrails in the official <code>@google/genai</code> SDK.</p>
      </div>
      <div class="arch-flow">
        <div class="arch-node">
          <h4>1. Live Telemetry</h4>
          <p>Streams 7-day ledger cents, win rates, visit failures &amp; urgent queue state per world.</p>
        </div>
        <div class="arch-node" style="border-color:rgba(56,189,248,0.6);">
          <h4>2. gemini-4-hydrogen</h4>
          <p><code>client.interactions.create</code> + JSON Schema <code>response_format</code> tunes 13 pricing &amp; fee parameters (with <code>gemini-3.5-flash-lite</code> failover).</p>
        </div>
        <div class="arch-node" style="border-color:rgba(16,185,129,0.65);">
          <h4>3. gemini-decision-1</h4>
          <p><code>v1beta decisions.create</code> calibrated <code>Noul</code> probabilities (<strong>0 output tokens</strong>) scoring safety, margin &amp; NLP health.</p>
        </div>
        <div class="arch-node" style="border-color:rgba(245,158,11,0.6);">
          <h4>4. 5-Seed Sci Gate</h4>
          <p>Only candidates beating Champion on all 5 seeds AND keeping <strong>min OT &ge; 93.5%</strong> promote to live rankings.</p>
        </div>
      </div>
      <div class="grid-3" id="s5DecisionCards">
        <div class="stat-card"><div class="stat-label">P(On-Time Safe &ge;93.5%)</div><div class="stat-big" style="color:var(--green);" id="s5ProbOt">--%</div><div class="stat-sub">gemini-decision-1 Noul score</div></div>
        <div class="stat-card"><div class="stat-label">P(Margin Sustainable)</div><div class="stat-big" style="color:var(--cyan);" id="s5ProbMargin">--%</div><div class="stat-sub">Output Tokens Used: <strong>0</strong></div></div>
        <div class="stat-card"><div class="stat-label">AI Promotion Gate</div><div class="stat-big" style="color:var(--purple);" id="s5Verdict">PROMOTE</div><div class="stat-sub" id="s5AnalysisBrief">Verified via @google/genai</div></div>
      </div>
      <div class="slide-foot">
        <span>Primary Model: gemini-4-hydrogen (Interactions API)</span>
        <span>Guardrail Model: gemini-decision-1 (Calibrated Decisions API)</span>
      </div>
    </section>

    <!-- SLIDE 6 -->
    <section class="slide" data-slide="6">
      <div>
        <div class="slide-top">
          <div class="slide-tag">Empirical Evidence &amp; Sunday Final Readiness</div>
          <div class="slide-num">SLIDE 06 / 06 &bull; 5-SEED ABLATION &amp; AUTONOMOUS BENCHMARK</div>
        </div>
        <h2 class="title">Every Module Scientifically Validated Across 5 Seeds (&ge; 93.5% Min OT)</h2>
      </div>
      <div class="stat-card" style="padding:18px 22px;flex:1;justify-content:center;">
        <div id="ablationChart">Loading measured 5-seed ablation data...</div>
      </div>
      <div class="slide-foot">
        <span>24/7 Watchdog (autopilot.ts) Armed for Test Finals &amp; Sunday 08:00 AM Final</span>
        <span>Team What's the wifi? &bull; Junction 2026 &bull; Thank You!</span>
      </div>
    </section>
  </div>

  <div class="progress-track"><div class="progress-fill" id="pitchProgress"></div></div>

  <script>
    const FINLAND_PLACES = [
      {id:"helsinki",name:"Helsinki",lat:60.1699,lon:24.9384},{id:"espoo",name:"Espoo",lat:60.2055,lon:24.6559},
      {id:"tampere",name:"Tampere",lat:61.4978,lon:23.761},{id:"vantaa",name:"Vantaa",lat:60.2934,lon:25.0378},
      {id:"oulu",name:"Oulu",lat:65.0121,lon:25.4651},{id:"turku",name:"Turku",lat:60.4518,lon:22.2666},
      {id:"jyvaskyla",name:"Jyväskylä",lat:62.2426,lon:25.7473},{id:"kuopio",name:"Kuopio",lat:62.8924,lon:27.677},
      {id:"lahti",name:"Lahti",lat:60.9827,lon:25.6612},{id:"pori",name:"Pori",lat:61.4851,lon:21.7975},
      {id:"kouvola",name:"Kouvola",lat:60.8679,lon:26.7042},{id:"joensuu",name:"Joensuu",lat:62.601,lon:29.7636},
      {id:"lappeenranta",name:"Lappeenranta",lat:61.0587,lon:28.1887},{id:"hameenlinna",name:"Hämeenlinna",lat:60.9959,lon:24.4643},
      {id:"vaasa",name:"Vaasa",lat:63.0951,lon:21.6165},{id:"seinajoki",name:"Seinäjoki",lat:62.7903,lon:22.8403},
      {id:"rovaniemi",name:"Rovaniemi",lat:66.5039,lon:25.7294},{id:"mikkeli",name:"Mikkeli",lat:61.6886,lon:27.2723},
      {id:"porvoo",name:"Porvoo",lat:60.3932,lon:25.665},{id:"salo",name:"Salo",lat:60.3833,lon:23.1333},
      {id:"kotka",name:"Kotka",lat:60.4664,lon:26.9458},{id:"kokkola",name:"Kokkola",lat:63.8385,lon:23.1307},
      {id:"hyvinkaa",name:"Hyvinkää",lat:60.6311,lon:24.8616},{id:"rauma",name:"Rauma",lat:61.1287,lon:21.5113},
      {id:"kajaani",name:"Kajaani",lat:64.2273,lon:27.7285},{id:"savonlinna",name:"Savonlinna",lat:61.8699,lon:28.8799},
      {id:"raisio",name:"Raisio",lat:60.4859,lon:22.1689},{id:"lempaala",name:"Lempäälä",lat:61.3139,lon:23.7529},
      {id:"kemi",name:"Kemi",lat:65.7364,lon:24.5637},{id:"ylivieska",name:"Ylivieska",lat:64.0731,lon:24.5395}
    ];

    function renderFinlandMap() {
      const svg = document.getElementById('finlandMapSvg');
      if (!svg) return;
      const proj = (lat, lon) => [40 + ((lon - 21.0) / 9.5) * 280, 295 - ((lat - 59.8) / 7.2) * 270];
      const byId = Object.fromEntries(FINLAND_PLACES.map(p => [p.id, proj(p.lat, p.lon)]));
      const corridors = [
        ['helsinki','tampere','#10b981'],['tampere','jyvaskyla','#38bdf8'],['jyvaskyla','kuopio','#38bdf8'],
        ['tampere','oulu','#f59e0b'],['oulu','rovaniemi','#ef4444'],['oulu','kemi','#ef4444'],
        ['helsinki','turku','#10b981'],['kuopio','kajaani','#f59e0b'],['kuopio','joensuu','#38bdf8']
      ];
      let html = '';
      for (const [a, b, col] of corridors) {
        const [x1,y1] = byId[a], [x2,y2] = byId[b];
        html += '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="'+col+'" stroke-width="2" stroke-opacity="0.65" stroke-dasharray="4,3"/>';
      }
      const snowHubs = new Set(['oulu','kemi','rovaniemi','kajaani']);
      for (const p of FINLAND_PLACES) {
        const [x,y] = byId[p.id];
        const isSnow = snowHubs.has(p.id);
        const major = ['helsinki','tampere','turku','oulu','kuopio','rovaniemi'].includes(p.id);
        html += '<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+(major?5.5:3)+'" fill="'+(isSnow?'#ef4444':'#38bdf8')+'" stroke="#05070c" stroke-width="1"/>';
        if (major) {
          html += '<text x="'+(x+7).toFixed(1)+'" y="'+(y+3).toFixed(1)+'" fill="#e2e8f0" font-size="10" font-family="monospace">'+p.name+'</text>';
        }
      }
      svg.innerHTML = html;
    }

    const NLP_SAMPLES = [
      "Nouto huomenna klo puoli kolme jälkeen, siirtokilvet mukaan, manuaalivaihteisto",
      "Pickup not 3pm, ready after half four, kesärenkaat on car, bring trade plates",
      "Hämtning senast kl fem, ej kl tre, leverans till Kuopio"
    ];
    function setNlpSample(i) {
      document.getElementById('nlpInput').value = NLP_SAMPLES[i] || '';
      runNlpDemo();
    }
    function runNlpDemo() {
      const raw = document.getElementById('nlpInput').value || '';
      let norm = raw.toLowerCase()
        .replace(/\\b(?:puoli\\s+kolme|halv\\s+tre|half\\s+three)\\b/g, '14:30')
        .replace(/\\b(?:puoli\\s+neljä|halv\\s+fyra|half\\s+four)\\b/g, '15:30')
        .replace(/\\b(?:klo|kl\\.?)\\s+fem\\b/g, 'kl 17:00')
        .replace(/\\b(?:klo|kl\\.?)\\s+tre\\b/g, 'kl 15:00')
        .replace(/\\b([1-6])(?::(\\d{2}))?\\s*pm\\b/g, (_,h,m)=>(Number(h)+12)+':'+(m||'00'))
        .replace(/\\b(?:ei\\s+klo|ej\\s+kl|not\\s+at|not)\\s+\\d{1,2}(?:[:.]\\d{2})?\\b/g, ' [NEGATED_REMOVED] ');
      const parsed = {
        normalizedText: norm,
        manualLicence: /manuaali|manuell|manual|stick\\s*shift/i.test(raw),
        withPlates: /siirtokil|koekil|trade\\s*plates|bring\\s*plates|utan\\s*skylt/i.test(raw),
        summerTyres: /kesärenka|sommardäck|summer\\s*t[yi]res/i.test(raw),
        extractedClockMatches: [...norm.matchAll(/\\b(\\d{1,2}:\\d{2})\\b/g)].map(m => m[1])
      };
      document.getElementById('nlpOutput').textContent = JSON.stringify(parsed, null, 2);
    }

    let currentSlide = 1;
    const totalSlides = 6;
    function showSlide(n) {
      currentSlide = Math.max(1, Math.min(totalSlides, n));
      document.querySelectorAll('.slide').forEach(el => el.classList.toggle('active', Number(el.dataset.slide) === currentSlide));
      document.getElementById('slideIndicator').textContent = 'Slide ' + currentSlide + ' / ' + totalSlides;
    }
    function nextSlide() { showSlide(currentSlide >= totalSlides ? 1 : currentSlide + 1); }
    function prevSlide() { showSlide(currentSlide <= 1 ? totalSlides : currentSlide - 1); }
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowRight' || e.key === ' ') nextSlide();
      if (e.key === 'ArrowLeft') prevSlide();
    });

    // Strict 114-second (01:54 < 02:00) Video Pitch Choreography (Gemini 3.8 Flash TTS Studio WAVs)
    const PITCH_BEATS = [
      { start: 0, end: 24, slide: 1, ttsUrl: "/api/tts/slide-0.wav", caption: "At Level 8 of the Bahn Express challenge, car relocation is an illiquid market under a brutal 90% on-time cliff. Season 5 (#54, €41,261) → Season 6: €51,570.20 across 5 worlds at 94.3% on-time (peak €12,899.75 @ 98.2% OT)." },
      { start: 24, end: 44, slide: 2, ttsUrl: "/api/tts/slide-1.wav", caption: "The Upfront Booking Paradox: Holding our flat opening fee at 1.145x for 360 mins + slack-aware pricing on 30h windows adds +€3,211/wk and +€2,380/wk in measured 5-seed ablation." },
      { start: 44, end: 63, slide: 3, ttsUrl: "/api/tts/slide-2.wav", caption: "In driver-scarce worlds like spread-4, raising concurrency from 0.32 to 0.42 drops on-time to 91.5% (-€3,500+). Our selective decline gate + dealer trust ratchet (+25%) adds +€1,151/wk." },
      { start: 63, end: 81, slide: 4, ttsUrl: "/api/tts/slide-3.wav", caption: "Trilingual Finnish/Swedish/English Note NLP extracts siirtokilvet, manuaalivaihteisto, kesärenkaat, and clock words like puoli kolme before posting—saving +€1,207/wk." },
      { start: 81, end: 98, slide: 5, ttsUrl: "/api/tts/slide-4.wav", caption: "DeepMind Track: Gemini 4 Hydrogen (JSON Schema) + Gemini 3.5 Flash-Lite failover diagnoses rounds, while Gemini Decision-1 evaluates 0-output-token Noul safety gates." },
      { start: 98, end: 114, slide: 6, ttsUrl: "/api/tts/slide-5.wav", caption: "Every module and rejected experiment across spread-1..5 is verified on localhost:3001 before autopilot touches a ranking round or final. €51,570.20 verified live—thank you!" }
    ];

    let pitchRunning = false;
    let voiceEnabled = true;
    let pitchTimerId = null;
    let pitchStartMs = 0;
    let lastBeatIdx = -1;
    let audioCtx = null;
    let ttsAudioEl = null;
    let ttsSourceNode = null;
    let ttsStreamDest = null;
    let mediaRecorder = null;
    let recordedChunks = [];

    function ensureAudioGraph() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      if (!ttsAudioEl) {
        ttsAudioEl = new Audio();
        ttsAudioEl.crossOrigin = "anonymous";
        ttsSourceNode = audioCtx.createMediaElementSource(ttsAudioEl);
        ttsStreamDest = audioCtx.createMediaStreamDestination();
        ttsSourceNode.connect(audioCtx.destination);
        ttsSourceNode.connect(ttsStreamDest);
      }
    }

    function toggleVoiceMode() {
      voiceEnabled = !voiceEnabled;
      document.getElementById("voiceModeBtn").textContent = voiceEnabled ? "🔊 Gemini 3.8 TTS: ON" : "🎙️ Live Mic Mode (Muted)";
      if (!voiceEnabled && ttsAudioEl) {
        ttsAudioEl.pause();
      }
    }

    function playSlideTts(beat) {
      if (!voiceEnabled) return;
      try {
        ensureAudioGraph();
        ttsAudioEl.pause();
        ttsAudioEl.src = beat.ttsUrl;
        ttsAudioEl.preservesPitch = true;
        const slotSec = Math.max(10, beat.end - beat.start - 0.5);
        ttsAudioEl.onloadedmetadata = () => {
          const dur = ttsAudioEl.duration || slotSec;
          ttsAudioEl.playbackRate = Math.max(1.05, Math.min(1.36, dur / slotSec));
          ttsAudioEl.play().catch(() => {});
        };
      } catch {}
    }

    function playAmbientPulse() {
      try {
        ensureAudioGraph();
        const now = audioCtx.currentTime;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(110, now);
        gain.gain.setValueAtTime(0.015, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        if (ttsStreamDest) gain.connect(ttsStreamDest);
        osc.start(now);
        osc.stop(now + 1.8);
      } catch {}
    }

    function stopPitch() {
      pitchRunning = false;
      clearInterval(pitchTimerId);
      if (ttsAudioEl) ttsAudioEl.pause();
      document.getElementById("playPitchBtn").textContent = "▶ Play 1:54 Pitch";
      document.getElementById("captionBar").style.display = "none";
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    }

    function startPitchTimeline() {
      pitchRunning = true;
      pitchStartMs = performance.now();
      lastBeatIdx = -1;
      document.getElementById("playPitchBtn").textContent = "⏹ Stop Pitch";
      document.getElementById("captionBar").style.display = "block";
      pitchTimerId = setInterval(() => {
        const elapsedSec = (performance.now() - pitchStartMs) / 1000;
        if (elapsedSec >= 114.2) {
          document.getElementById("pitchTimer").textContent = "01:54 / 01:54";
          document.getElementById("pitchProgress").style.width = "100%";
          stopPitch();
          return;
        }
        const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
        const ss = String(Math.floor(elapsedSec % 60)).padStart(2, "0");
        document.getElementById("pitchTimer").textContent = mm + ":" + ss + " / 01:54";
        document.getElementById("pitchProgress").style.width = ((elapsedSec / 114) * 100).toFixed(1) + "%";
        const beatIdx = PITCH_BEATS.findIndex(b => elapsedSec >= b.start && elapsedSec < b.end);
        if (beatIdx !== -1 && beatIdx !== lastBeatIdx) {
          lastBeatIdx = beatIdx;
          const b = PITCH_BEATS[beatIdx];
          showSlide(b.slide);
          document.getElementById("captionBar").textContent = b.caption;
          playSlideTts(b);
          playAmbientPulse();
        }
      }, 200);
    }

    function togglePitch() {
      if (pitchRunning) stopPitch(); else startPitchTimeline();
    }

    async function recordPitchVideo() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        alert("Use Chrome/Edge/Arc on localhost:3001 to record directly to WebM!");
        return;
      }
      try {
        ensureAudioGraph();
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: "browser" }, audio: true });
        const tracks = [...displayStream.getVideoTracks()];
        if (ttsStreamDest && ttsStreamDest.stream.getAudioTracks().length > 0) {
          tracks.push(...ttsStreamDest.stream.getAudioTracks());
        } else if (displayStream.getAudioTracks().length > 0) {
          tracks.push(...displayStream.getAudioTracks());
        }
        const combinedStream = new MediaStream(tracks);
        recordedChunks = [];
        const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus") ? "video/webm;codecs=vp9,opus" : "video/webm";
        mediaRecorder = new MediaRecorder(combinedStream, { mimeType });
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = () => {
          displayStream.getTracks().forEach(t => t.stop());
          const blob = new Blob(recordedChunks, { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "bahn-spread-whatsthewifi-pitch-1m54s.webm";
          a.click();
        };
        mediaRecorder.start(500);
        startPitchTimeline();
      } catch (err) {
        alert("Screen capture cancelled: " + err.message);
      }
    }

    async function hydratePresentation() {
      renderFinlandMap();
      runNlpDemo();
      try {
        const [stateRes, decRes, boardRes, ablRes] = await Promise.all([
          fetch('/api/state').then(r => r.json()).catch(() => ({})),
          fetch('/api/decisions').then(r => r.json()).catch(() => ({})),
          fetch('/api/season-board').then(r => r.json()).catch(() => ({})),
          fetch('/api/ablation').then(r => r.json()).catch(() => ({}))
        ]);
        if (stateRes.strategy) {
          document.getElementById('s1StrategyMeta').textContent = 'Strategy v' + stateRes.strategy.version + ' (' + stateRes.strategy.updatedBy + ') Live on localhost:3001';
        }
        if (boardRes.ourCurrent) {
          document.getElementById('s1SeasonLabel').textContent = 'Season ' + boardRes.currentSeason + ' (' + boardRes.currentName + ') // Rank #' + boardRes.ourCurrent.rank;
          document.getElementById('s1SeasonMargin').textContent = '+€' + (boardRes.ourCurrent.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
          const prevM = boardRes.ourPrevious ? ('€' + (boardRes.ourPrevious.marginCents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })) : '€41,261';
          document.getElementById('s1SeasonSub').innerHTML = 'Season ' + (boardRes.previousSeason || 5) + ' (' + prevM + ') &rarr; Rank #' + boardRes.ourCurrent.rank + ' / ' + boardRes.totalTeams + ', <strong>' + (boardRes.ourCurrent.onTimeShare * 100).toFixed(2) + '% On-Time</strong>, 5/5 Ranked';
          if (Array.isArray(boardRes.ourCurrent.runs)) {
            const bestRun = boardRes.ourCurrent.runs.reduce((best, r) => (!best || r.marginCents > best.marginCents ? r : best), null);
            if (bestRun) {
              document.getElementById('s1PeakMargin').textContent = '+€' + (bestRun.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 });
              document.getElementById('s1PeakSub').innerHTML = 'Season ' + boardRes.currentSeason + ' Run ' + bestRun.run + ': <strong>€' + (bestRun.marginCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '</strong> on ' + bestRun.wonOrders + ' orders with <strong>' + (bestRun.onTimeShare * 100).toFixed(2) + '%</strong> on-time arrival.';
            }
          }
        }
        const d0 = decRes.decisions?.[0];
        if (d0) {
          document.getElementById('s5ProbOt').textContent = (d0.onTimeSafeProb * 100).toFixed(1) + '%';
          document.getElementById('s5ProbMargin').textContent = (d0.marginSustainableProb * 100).toFixed(1) + '%';
          document.getElementById('s5Verdict').textContent = d0.decision;
          document.getElementById('s5Verdict').style.color = d0.decision === 'PROMOTE' ? 'var(--green)' : 'var(--red)';
          document.getElementById('s5AnalysisBrief').textContent = d0.model + ' (0 out tokens, conf ' + d0.confidence + ')';
        }
        const rows = ablRes.summaryRows || [];
        const chart = document.getElementById('ablationChart');
        if (rows.length > 0) {
          const maxM = Math.max(...rows.map(r => r.avgMarginEur), 8000);
          chart.innerHTML = rows.map(r => {
            const pct = Math.max(4, (r.avgMarginEur / maxM) * 100).toFixed(1);
            const col = r.highlight ? '#10b981' : (r.deltaEur < -800 ? '#ef4444' : '#38bdf8');
            const otCol = r.minOnTimePct >= 93.5 ? '#34d399' : '#f59e0b';
            return '<div class="bar-row">'
              + '<div style="color:#e2e8f0;font-weight:700;">' + r.name + '</div>'
              + '<div class="bar-track"><div class="bar-val" style="width:'+pct+'%;background:'+col+';"></div></div>'
              + '<div style="text-align:right;font-weight:800;">€' + Math.round(r.avgMarginEur).toLocaleString() + '/wk</div>'
              + '<div style="text-align:right;color:'+otCol+';">' + r.minOnTimePct.toFixed(1) + '% min</div>'
              + '</div>';
          }).join('');
        }
      } catch {}
    }

    hydratePresentation();
    if (new URLSearchParams(location.search).get('autoplay') === '1') {
      setTimeout(() => startPitchTimeline(), 600);
    }
  </script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`)

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(DASHBOARD_HTML)
      return
    }

    if (req.method === "GET" && url.pathname === "/presentation") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(PRESENTATION_HTML)
      return
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/tts/")) {
      const name = path.basename(url.pathname)
      const filePath = path.join(process.cwd(), "data", "tts", name)
      if (!name.endsWith(".wav") || !fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "TTS audio file not found" })
        return
      }
      const stat = fs.statSync(filePath)
      res.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": String(stat.size),
        "cache-control": "public, max-age=3600",
      })
      fs.createReadStream(filePath).pipe(res)
      return
    }

    if (req.method === "GET" && url.pathname === "/api/decisions") {
      let decisions = loadGeminiDecisions()
      if (decisions.length === 0) {
        const runs = loadRuns()
        if (runs.length > 0) {
          await evaluatePromotionWithGeminiDecision(runs[0]!)
          decisions = loadGeminiDecisions()
        }
      }
      sendJson(res, 200, { decisions, strategy: loadStrategy() })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/evaluate-decision") {
      const runs = loadRuns()
      if (runs.length === 0) {
        sendJson(res, 400, { error: "Run at least one simulation round first." })
        return
      }
      const result = await evaluatePromotionWithGeminiDecision(runs[0]!)
      sendJson(res, 200, { result, decisions: loadGeminiDecisions() })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/season-board") {
      const client = new Client()
      const board = await client.board(8).catch(() => null)
      const findTeam = (teams: Array<{ name: string; rank: number | null; marginCents: number; onTimeShare: number; played: number; ranked: boolean; runs?: unknown[] }> = []) =>
        teams.find((t) => t.name.toLowerCase().includes("wifi")) ?? null
      const curTeams = board?.current?.teams ?? []
      const prevTeams = board?.previous?.teams ?? []
      const top10 = curTeams.filter((t) => t.rank === 10)[0]
      sendJson(res, 200, {
        currentSeason: board?.current?.season ?? 6,
        currentName: board?.current?.name ?? "Saturday 12:00",
        totalTeams: curTeams.length,
        ourCurrent: findTeam(curTeams),
        previousSeason: board?.previous?.season ?? 5,
        ourPrevious: findTeam(prevTeams),
        top10ThresholdCents: top10?.marginCents ?? 8234688,
        top3: curTeams.slice(0, 3),
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/ablation") {
      const abl = readJsonSafe<{ strategyVersion?: number; results?: Array<{ variant: string; marginCents: number; onTimeShare: number; wonOrders: number; ranked: boolean; error?: string }> }>("data/ablation.json", {})
      const verified = readJsonSafe<{ strategyVersion?: number; results?: Array<{ marginCents: number; onTimeShare: number; wonOrders: number; ranked: boolean }> }>("data/v15-verified.json", {})
      const baseline = readJsonSafe<{ strategyVersion?: number; results?: Array<{ marginCents: number; onTimeShare: number; wonOrders: number; ranked: boolean }> }>("data/baseline-v14.json", {})
      const grouped = new Map<string, { margins: number[]; ots: number[]; orders: number[] }>()
      for (const r of abl.results ?? []) {
        if (r.error) continue
        const g = grouped.get(r.variant) ?? { margins: [], ots: [], orders: [] }
        g.margins.push(r.marginCents / 100)
        g.ots.push(r.onTimeShare * 100)
        g.orders.push(r.wonOrders)
        grouped.set(r.variant, g)
      }
      const baseAvg = grouped.get("ALL ON (baseline)")?.margins.reduce((a, b) => a + b, 0) / Math.max(1, grouped.get("ALL ON (baseline)")?.margins.length ?? 1)
      const summaryRows = [...grouped.entries()].map(([name, g]) => {
        const avgMarginEur = g.margins.reduce((a, b) => a + b, 0) / g.margins.length
        const minOnTimePct = Math.min(...g.ots)
        return {
          name,
          avgMarginEur,
          deltaEur: name === "ALL ON (baseline)" ? 0 : avgMarginEur - baseAvg,
          minOnTimePct,
          highlight: name.startsWith("ALL ON"),
        }
      })
      const liveSet = (verified.results?.length ?? 0) > 0 ? verified : baseline
      if ((liveSet.results?.length ?? 0) > 0) {
        const bRes = liveSet.results!
        summaryRows.unshift({
          name: `Current Champion Strategy (v${liveSet.strategyVersion ?? 14} Verified)`,
          avgMarginEur: bRes.reduce((a, r) => a + r.marginCents / 100, 0) / bRes.length,
          deltaEur: 0,
          minOnTimePct: Math.min(...bRes.map((r) => r.onTimeShare * 100)),
          highlight: true,
        })
      }
      sendJson(res, 200, { strategyVersion: abl.strategyVersion ?? 8, liveStrategyVersion: liveSet.strategyVersion ?? 14, summaryRows })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, 200, {
        strategy: loadStrategy(),
        runs: loadRuns(),
        activeRun,
        hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(`event: connected\ndata: {"ok":true}\n\n`)
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      if (activeRun.running) {
        sendJson(res, 409, { error: "A simulation round is already running" })
        return
      }
      const body = await readJsonBody(req)
      const level = (Number(body.level || 8) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)
      const seed = typeof body.seed === "string" && body.seed.trim() ? body.seed.trim() : undefined
      const board = Boolean(body.board)
      const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : undefined

      if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey

      activeRun.running = true
      activeRun.startedAt = new Date().toISOString()
      activeRun.level = level
      activeRun.seed = seed ?? null
      activeRun.board = board
      activeRun.dailyMetrics = []
      activeRun.latestProgress = null

      addLog(`Starting Level ${level} ${board ? "RANKING BOARD" : `practice (seed=${seed ?? "random"})`} simulation...`)
      sendJson(res, 202, { started: true })

      void (async () => {
        try {
          const summary = await runSimulationRound({
            level,
            seed,
            board,
            tuneWithGemini: true,
            geminiApiKey,
            onDayReport: (metric) => {
              activeRun.dailyMetrics.push(metric)
              addLog(
                `${metric.dayName}: Margin €${(metric.marginCents / 100).toFixed(2)} | Rev €${(metric.revenueCents / 100).toFixed(2)} | ${metric.wonOrders} orders | ${(metric.onTimeShare * 100).toFixed(1)}% on-time`,
              )
              broadcast("day", { metric, dailyMetrics: activeRun.dailyMetrics })
            },
            onProgress: (update) => {
              activeRun.latestProgress = update
              broadcast("progress", update)
            },
          })
          addLog(
            `Finished World ${summary.worldId}: Gross Margin €${(summary.score.marginCents / 100).toFixed(2)}, On-Time ${(summary.score.onTimeShare * 100).toFixed(1)}% (${summary.score.ranked ? "RANKED" : "UNRANKED"})`,
          )
          activeRun.running = false
          broadcast("complete", { summary, runs: loadRuns(), strategy: loadStrategy() })
        } catch (err) {
          activeRun.running = false
          addLog(`ERROR: ${(err as Error).message}`)
          broadcast("complete", { summary: loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
        }
      })()
      return
    }

    if (req.method === "POST" && url.pathname === "/api/sweep") {
      if (activeRun.running) {
        sendJson(res, 409, { error: "Already running" })
        return
      }
      activeRun.running = true
      sendJson(res, 202, { started: true })
      void (async () => {
        try {
          const { summaries } = await runAutoSweep(["spread-1", "spread-2", "spread-3"], 8, (msg) => addLog(msg))
          activeRun.running = false
          broadcast("complete", { summary: summaries.at(-1) ?? loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
        } catch (err) {
          activeRun.running = false
          addLog(`Sweep Error: ${(err as Error).message}`)
          broadcast("complete", { summary: loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
        }
      })()
      return
    }

    if (req.method === "POST" && url.pathname === "/api/board-round") {
      if (activeRun.running) {
        sendJson(res, 409, { error: "Already running" })
        return
      }
      activeRun.running = true
      sendJson(res, 202, { started: true })
      void (async () => {
        try {
          const summaries = await runOfficialBoardRound(8, 5, (msg) => addLog(msg))
          activeRun.running = false
          broadcast("complete", { summary: summaries.at(-1) ?? loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
        } catch (err) {
          activeRun.running = false
          addLog(`Board Error: ${(err as Error).message}`)
          broadcast("complete", { summary: loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
        }
      })()
      return
    }

    if (req.method === "POST" && url.pathname === "/api/tune") {
      const body = await readJsonBody(req)
      const geminiApiKey = typeof body.geminiApiKey === "string" ? body.geminiApiKey.trim() : undefined
      if (geminiApiKey) process.env.GEMINI_API_KEY = geminiApiKey

      const runs = loadRuns()
      if (runs.length === 0) {
        sendJson(res, 400, { error: "Run at least one simulation round first." })
        return
      }
      const current = loadStrategy()
      const tuning = await tuneStrategyWithGemini(runs[0]!, current, geminiApiKey)
      sendJson(res, 200, { tuning })
      return
    }

    if (req.method === "POST" && url.pathname === "/api/external-log") {
      const body = await readJsonBody(req)
      if (typeof body.line === "string" && body.line.trim()) {
        addLog(body.line.trim())
      }
      if (body.refreshState) {
        broadcast("complete", { summary: loadRuns()[0], runs: loadRuns(), strategy: loadStrategy() })
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === "GET" && url.pathname === "/api/leaderboard") {
      const level = (Number(url.searchParams.get("level") || 8) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)
      const client = new Client()
      const board = await client.board(level)
      sendJson(res, 200, board)
      return
    }

    sendJson(res, 404, { error: "Not found" })
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message })
  }
})

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Spread Command Center live at http://localhost:${PORT}`)
})
