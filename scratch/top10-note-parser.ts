import type { Note, TimeWindow } from "../spread.ts"
import type { ParsedNoteInfo } from "../bot.ts"

const HOUR = 60
const DAY = 24 * HOUR

const MANUAL_POS = /\b(manuaali\w*|käsivaiht\w*|keppivaiht\w*|kytkin\w*|manuell\w*|manual\b|stick\s*shift)/i
const MANUAL_NEG = /\b(ei\s+manuaali\w*|inte\s+manuell\w*|ej\s+manuell\w*|not\s+manual)/i

const PLATES_POS =
  /\b(siirtokilv\w*|koekilv\w*|tarrakilv\w*|ilman\s+kilp\w*|ei\s+kilp\w*|kilvet\s+puut\w*|kilvet\s+mukaan|ota\s+kilvet|(?:rekisteri)?kilvet\s+irrot\w*|rekisteröimät\w*|provskylt\w*|utan\s+skylt\w*|inga\s+skylt\w*|medtag\s+skylt\w*|skylt\w*\s+borttag\w*|oregistrerad\w*|no\s+plates|without\s+plates|plates\s+removed|transfer\s+plates|trade\s+plates|bring\s+plates|needs\s+plates|unregistered)/i
const PLATES_NEG = /\b(kilvet\s+on\b|kilvet\s+paikalla\w*|med\s+skyltar|plates\s+on\s+car|has\s+plates)/i

const SUMMER_TYRES_RE = /\b(kesärenka\w*|kesäpyör\w*|sommardäck\w*|s(?:um|mu)mer\s+t[yi]res?)/i
const SUMMER_TYRES_MOUNTED_RE = /\b(alla\b|asennettu\w*|päällä\b|on\s+the\s+car|fitted|mounted|på\s+bilen|sitter\s+på)/i
const SUMMER_TYRES_SPARE_RE =
  /\b(takakont\w*|tavaratil\w*|kontissa|takapenk\w*|kyydissä|mukaan|mukana|trunk|boot|\bin\s+the\s+back\b|bagage\w*|skuff\w*)/i

const AFTER =
  /jälkeen|all?kaen|aikaisintaan|vasta|\bafter\b|\bfrom\b|earliest|not\s+befo?re|ei\s+ennen|vall?mm?is|\bready\b|efter|tidigast|inte\s+före|klar|först|maksun|maskettu|maksettu|paid/
const BEFORE = /enn?en|mennessä|viim|asti|saakka|\bbefore\b|\bby\b|\buntil\b|\btill\b|latest|före|senast|innan/
const CLOSED_AT = /kiinn+i\s+(?:klo|kello)?\s*\d|close[sd]?\s+(?:at|after)\s+\d|stänger\s+(?:kl\.?|klockan)?\s*\d/
const DELIVERY = /toimit|perillä|perille|vastaanot|kohde|deliver|arrive|destination|receiv|leverera|leverans|framme|mottag/
const PICKUP_CUE = /nouto|noudettav\w*|haettav\w*|vall?mm?is|luovut\w*|pickup|pick\s*up|\bready\b|released|klar\b|hämt\w*|utlämn\w*/
const CALL_AHEAD_RE =
  /\b(?:call|ring|soita|ilmoita|text|tekstaa|viesti)\b[^.!?\n;]{0,45}\b(?:before|innan|ennen)\b[^.!?\n;]*/gi
const CLOCK = /(?:klo|kello|kl\.?)\s*(\d{1,2})(?:[.:](\d{2}))?|\b(\d{1,2})[.:](\d{2})\b/g
const BARE_HOUR_POST =
  /\b(\d{1,2})\s+(?=(?:jälkeen|alkaen|allkaen|aikaisintaan|mennessä|viimeistään|asti|saakka)\b)/g
const RANGE = /\b(\d{1,2})(?:[.:](\d{2}))?\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?\b/g

const WORD_TIME_PREP_FULL =
  "(?:klo|kello|kl\\.?|klockan|at|before|befre|after|by|from|until|till|före|efter|senast|innan|ennen|jälkeen|alkaen|allkaen|aikaisintaan|mennessä|viimeistään|vasta|först|noin|around)"
const WORD_TIME_PREP_STRICT =
  "(?:klo|kello|kl\\.?|klockan|before|befre|after|by|until|till|före|efter|senast|innan|ennen|jälkeen|alkaen|allkaen|aikaisintaan|mennessä|viimeistään|vasta|först)"
const WORD_TIME_POST = "(?:alkaen|allkaen|jälkeen|mennessä|asti|saakka)"

const WORD_HOUR_MAP: [string, string, boolean][] = [
  ["yhdeksän|yhdeksältä|yhdeksään|yhdeksästä|nio|nine", "9:00", false],
  ["kymmenen|kymmeneltä|kymmeneksi|kymmenestä|tio|ten", "10:00", false],
  ["yksitoista|yhdentoista|yhdestätoista|elva|eleven", "11:00", false],
  ["kaksitoista|kahdentoista|kahdestatoista|tolv|twelve|noon", "12:00", false],
  ["yksi|yhdeltä|yhdeksi|yhdestä|ett|one", "13:00", true],
  ["kaksi|kahdelta|kahdeksi|kahdesta|två|two", "14:00", true],
  ["kolme|kolmelta|kolmekseen|kolmeksi|kolmesta|tre|three", "15:00", false],
  ["neljä|neljältä|neljäksi|neljästä|fyra|four", "16:00", false],
  ["viisi|viideltä|viideksi|viidestä|fem|five", "17:00", false],
]

const ANY_WEEKDAY_TOKEN =
  "(?:maanantai\\w*|måndag\\w*|monday|mon|ma|tiistai\\w*|tisdag\\w*|tuesday|tue|ti|keskivi+k\\w*|onsdag\\w*|wednesday|wed|ke|torstai\\w*|torsdag\\w*|thursday|thu|thurs|to|perjantai\\w*|fredag\\w*|friday|fri|pe|lauantai\\w*|lördag\\w*|saturday|sat|la|sunnuntai\\w*|söndag\\w*|sunday|sun|su|tänään|huomenna|ylihuomenna|idag|imorgon|i\\s+morgon|today|tomorrow|tmrw)"

export function parseNoteFlagsV2(note: Note | null, on = true): ParsedNoteInfo {
  if (!on || !note || !note.text) {
    return { manualLicence: false, withPlates: false, summerTyres: false, hasTightDeadline: false }
  }
  const t = note.text
  const manualLicence = MANUAL_POS.test(t) && !MANUAL_NEG.test(t)
  const withPlates = PLATES_POS.test(t) && !PLATES_NEG.test(t)
  const clauses = t.toLowerCase().split(/[.!?\n;]+/)

  // Clause-scoped summer tyres detection: don't let "4 rengasta tavaratilassa" suppress "kesärenkaat alla"!
  let summerTyres = false
  for (const c of clauses) {
    if (SUMMER_TYRES_RE.test(c)) {
      if (SUMMER_TYRES_MOUNTED_RE.test(c) || !SUMMER_TYRES_SPARE_RE.test(c)) {
        summerTyres = true
        break
      }
    }
  }
  const hasTightDeadline = clauses.some((c) => DELIVERY.test(c) && (BEFORE.test(c) || CLOSED_AT.test(c)))
  return { manualLicence, withPlates, summerTyres, hasTightDeadline }
}

export function normalizeNoteTimeWordsV2(raw: string): string {
  let s = raw.toLowerCase()
  s = s.replace(CALL_AHEAD_RE, " ")

  // Remove dotted weekday abbreviations like "ke. 8 jälkeen" or "to. klo 14" so period doesn't split weekday from time
  s = s.replace(/\b(ma|ti|ke|to|pe|la|su)\.(?=\s)/gi, "$1")

  // Normalize trailing weekday corrections
  const corrDayRe = new RegExp(
    `\\b(${ANY_WEEKDAY_TOKEN})\\b([^!?;\\n]{0,55}?)[.!?;,\\s]+(?:korjaus|rättelse|correction)\\s*:\\s*(${ANY_WEEKDAY_TOKEN})\\b`,
    "gi",
  )
  s = s.replace(corrDayRe, "$3$2")

  // Normalize decimal times like 15.30 or 11.30 into 15:30 / 11:30 before sentence splitting
  s = s.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2")

  // Convert am/pm including 7pm-11pm BEFORE correction stripping!
  s = s.replace(/\b([7-9]|1[0-2])\s*(?::(\d{2}))?\s*am\b/gi, (_, h, m) => `${Number(h)}:${m ?? "00"}`)
  s = s.replace(/\b([1-9]|1[0-1])\s*(?::(\d{2}))?\s*pm\b/gi, (_, h, m) => `${Number(h) + 12}:${m ?? "00"}`)

  // Normalize self-corrections across commas OR periods ("klo 10.30 alkaen. Korjaus: klo 11.30")
  s = s.replace(
    /(?:(?:klo|kello|kl\.?|at|from|by|before|after)\s*)?\d{1,2}(?:[.:]\d{2})?(?:\s*(?:alkaen|allkaen|jälkeen|mennessä|asti|saakka))?\s*[.,;]\s*(?:ei\s*kun|eiku|eikun|nej\s*men|eller\s*nej|no\s*wait|sorry|actually|(?:korjaus|rättelse|correction)\s*:?)\s*/gi,
    " ",
  )

  // Strip parenthetical negated times
  s = s.replace(/\(\s*(?:ei|not|inte|ej)\b[^)]*\)/gi, " ")

  const halfRules: [RegExp, string][] = [
    [/\b(?:puoli\s+kymmenen|halv\s+tio|half\s+(?:ten|past\s+nine))\b/gi, "09:30"],
    [/\b(?:puoli\s+yksitoista|halv\s+elva|half\s+(?:eleven|past\s+ten))\b/gi, "10:30"],
    [/\b(?:puoli\s+kaksitoista|halv\s+tolv|half\s+(?:twelve|past\s+eleven))\b/gi, "11:30"],
    [/\b(?:puoli\s+yksi|halv\s+ett|half\s+(?:one|past\s+twelve))\b/gi, "12:30"],
    [/\b(?:puoli\s+kaksi|halv\s+två|half\s+(?:two|past\s+one))\b/gi, "13:30"],
    [/\b(?:puoli\s+kolme|halv\s+tre|half\s+(?:three|past\s+two))\b/gi, "14:30"],
    [/\b(?:puoli\s+neljä|halv\s+fyra|half\s+(?:four|past\s+three))\b/gi, "15:30"],
    [/\b(?:puoli\s+viisi|halv\s+fem|half\s+(?:five|past\s+four))\b/gi, "16:30"],
  ]
  for (const [re, repl] of halfRules) {
    s = s.replace(re, repl)
  }

  for (const [words, hhmm, strict] of WORD_HOUR_MAP) {
    const prep = strict ? WORD_TIME_PREP_STRICT : WORD_TIME_PREP_FULL
    const preRe = new RegExp(`\\b(${prep})\\s+(?:${words})\\b`, "gi")
    s = s.replace(preRe, `$1 ${hhmm}`)
    const postRe = new RegExp(`\\b(?:${words})\\s+(${WORD_TIME_POST})\\b`, "gi")
    s = s.replace(postRe, `klo ${hhmm} $1`)
  }

  // Promote bare integer hours right before Finnish time postpositions ("8 jälkeen", "15 asti")
  s = s.replace(BARE_HOUR_POST, (_, h) => {
    const num = Number(h)
    return num >= 6 && num <= 22 ? `klo ${num}:00 ` : `${h} `
  })

  // Strip explicit negated times
  s = s.replace(
    /\b(?:ei\s+klo|ei\s+kello|inte\s+kl(?:ockan)?|ej\s+kl(?:ockan)?|not\s+at|not\s+around|not)\s+\d{1,2}(?:[:.]\d{2})?(?:\s*pm)?\b/gi,
    " ",
  )
  return s
}

function resolveNoteDayStart(around: string, arrivedAt: number, fallbackDayStart: number): number {
  const arrivedDay = Math.floor(arrivedAt / DAY) * DAY
  const arrivedWd = Math.floor(arrivedAt / DAY) % 7
  if (/ylihuomenna|i övermorgon|day after tomorrow/.test(around)) return arrivedDay + 2 * DAY
  if (/huomenna|i morgon|imorgon|tomorrow|tmrw/.test(around)) return arrivedDay + DAY
  if (/tänään|idag|today/.test(around)) return arrivedDay
  const wdRules: [RegExp, number][] = [
    [/\b(maanantai\w*|måndag\w*|monday|mon|ma)\b/, 0],
    [/\b(tiistai\w*|tisdag\w*|tuesday|tue|ti)\b/, 1],
    [/\b(keskivi+k\w*|onsdag\w*|wednesday|wed|ke)\b/, 2],
    [/\b(torstai\w*|torsdag\w*|thursday|thu|thurs|to)\b/, 3],
    [/\b(perjantai\w*|fredag\w*|friday|fri|pe)\b/, 4],
    [/\b(lauantai\w*|lördag\w*|saturday|sat|la)\b/, 5],
    [/\b(sunnuntai\w*|söndag\w*|sunday|sun|su)\b/, 6],
  ]
  for (const [re, targetWd] of wdRules) {
    if (re.test(around)) {
      let diff = (targetWd - arrivedWd + 7) % 7
      if (diff < 2) diff += 7
      if (diff <= 6) return arrivedDay + diff * DAY
    }
  }
  return fallbackDayStart
}

export function windowFromNoteV2(
  note: Note | null,
  window: TimeWindow,
  stop: "pickup" | "delivery",
  arrivedAt = window.from,
): TimeWindow {
  if (!note) return window
  const fullNormalized = normalizeNoteTimeWordsV2(note.text)
  const clauses = fullNormalized
    .split(/(?:[.!?\n;]|,(?!\d))+/)
    .map((c) => c.trim())
    .filter(Boolean)
  const minutes = (hour: number, minute: number): number | null => (hour > 24 || minute > 59 ? null : hour * HOUR + minute)
  const dayStart = (t: number) => Math.floor(t / DAY) * DAY
  let { from, to } = window
  for (let clause of clauses) {
    const isDelivClause = DELIVERY.test(clause)
    const isPickupClause = PICKUP_CUE.test(clause)
    if (stop === "delivery") {
      if (!isDelivClause) continue
    } else {
      if (isDelivClause && !isPickupClause) continue
    }
    for (const match of clause.matchAll(RANGE)) {
      const opens = minutes(Number(match[1]), Number(match[2] ?? 0))
      const closes = minutes(Number(match[3]), Number(match[4] ?? 0))
      if (opens === null || closes === null || opens >= closes) continue
      from = Math.max(from, dayStart(from) + opens)
      to = Math.min(to, dayStart(to) + closes)
    }
    clause = clause.replace(RANGE, " ")
    for (const match of clause.matchAll(CLOCK)) {
      const m = minutes(Number(match[1] ?? match[3]), Number(match[2] ?? match[4] ?? 0))
      if (m === null) continue
      const around = clause.slice(Math.max(0, match.index - 52), match.index + match[0].length + 40)
      const targetDay = resolveNoteDayStart(around, arrivedAt, dayStart(window.from))
      const time = targetDay + m
      if (CLOSED_AT.test(around)) to = Math.min(to, time)
      else if (AFTER.test(around)) from = Math.max(from, time)
      else if (BEFORE.test(around)) to = Math.min(to, time)
    }
  }
  return from <= to ? { from: Math.round(from), to: Math.round(to) } : window
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let passed = 0
  let failed = 0
  const check = (cond: boolean, label: string) => {
    if (cond) {
      passed++
      console.log(`PASS: ${label}`)
    } else {
      failed++
      console.log(`FAIL: ${label}`)
    }
  }

  const mon09 = 9 * HOUR
  const baseWin: TimeWindow = { from: mon09, to: 4 * DAY + 20 * HOUR }

  // 1. 7pm-11pm & spaces before pm
  const w7pm = windowFromNoteV2({ text: "7 am-8 pm only", language: "en" }, baseWin, "pickup", mon09)
  check(w7pm.to === 4 * DAY + 20 * HOUR && w7pm.from === mon09, `7 am-8 pm range (${JSON.stringify(w7pm)})`)
  const wTmrw8pm = windowFromNoteV2({ text: "before tmrw 8pm", language: "en" }, baseWin, "pickup", mon09)
  check(wTmrw8pm.to === 1 * DAY + 20 * HOUR, `tmrw 8pm -> Day 1 20:00 (got ${wTmrw8pm.to})`)

  // 2. Typos valmmis & kiinnni
  const wValmmis = windowFromNoteV2({ text: "auto valmmis klo 11.00", language: "fi" }, baseWin, "pickup", mon09)
  check(wValmmis.from === 11 * HOUR, `typo valmmis -> 11:00 (got ${wValmmis.from})`)
  const wKiinnni = windowFromNoteV2({ text: "liike kiinnni klo 14", language: "fi" }, baseWin, "pickup", mon09)
  check(wKiinnni.to === 14 * HOUR, `typo kiinnni -> 14:00 (got ${wKiinnni.to})`)

  // 3. Bare hours + dotted weekday ("ke. 8 jälkeen", "15 asti")
  const wKe8 = windowFromNoteV2({ text: "nouto ke. 8 jälkeen", language: "fi" }, baseWin, "pickup", mon09)
  check(wKe8.from === 2 * DAY + 8 * HOUR, `ke. 8 jälkeen -> Wed 08:00 (got ${wKe8.from})`)
  const w15Asti = windowFromNoteV2({ text: "nouto 15 asti", language: "fi" }, baseWin, "pickup", mon09)
  check(w15Asti.to === 15 * HOUR, `15 asti -> 15:00 (got ${w15Asti.to})`)

  // 4. Period-separated Korjaus
  const wKorjaus = windowFromNoteV2(
    { text: "valmis huomenna klo 10.30 alkaen. Korjaus: klo 11.30", language: "fi" },
    baseWin,
    "pickup",
    mon09,
  )
  check(wKorjaus.from === 1 * DAY + 11 * HOUR + 30, `period-separated Korjaus -> Tue 11:30 (got ${wKorjaus.from})`)

  // 5. Clause-scoped summer tyres
  const fTyre = parseNoteFlagsV2(
    { text: "kesärenkaat alla. 4 rengasta tavaratilassa mukaan", language: "fi" },
    true,
  )
  check(fTyre.summerTyres === true, "kesärenkaat alla + tavaratilassa keeps summerTyres=true")
  const fSpareOnly = parseNoteFlagsV2({ text: "kesärenkaat tavaratilassa", language: "fi" }, true)
  check(fSpareOnly.summerTyres === false, "kesärenkaat tavaratilassa alone keeps summerTyres=false")

  console.log(`\nNote parser v2 tests: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}
