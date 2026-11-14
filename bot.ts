import fs from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { Client, SpreadError, Unreachable, World } from "./spread.ts"
import type {
  Action,
  ActionResult,
  Audience,
  DeskEvent,
  DeskEventKind,
  DeskSnapshot,
  DriverProfile,
  FeeStep,
  Note,
  Order,
  Place,
  PostAction,
  PriceRequest,
  Score,
  StopRef,
  TimeWindow,
  WorldMap,
} from "./spread.ts"
import type { DailyMetric, RoundSummary, StrategyConfig } from "./strategy-config.ts"
import { appendRun, loadStrategy } from "./strategy-config.ts"
import { tuneStrategyWithGemini } from "./gemini-strategist.ts"
import { clampPickupWindowForNow, extractDailyHoursFromNote, parseNoteFlagsV2, windowFromNoteV2 } from "./note-utils.ts"

const HOUR = 60
const DAY = 24 * HOUR
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

const WAKE_ON: DeskEventKind[] = [
  "price_request",
  "order_won",
  "order_lost",
  "order_changed",
  "order_cancelled",
  "visit_failed",
  "gig_expired",
  "gig_dropped",
  "no_show",
  "driver_late",
  "deadline_close",
]

type Retry = { pickupFrom: number; manualLicence: boolean; plates: boolean }

export interface ParsedNoteInfo {
  manualLicence: boolean
  withPlates: boolean
  summerTyres: boolean
  hasTightDeadline: boolean
}

const MANUAL_POS = /\b(manuaali\w*|käsivaiht\w*|keppivaiht\w*|kytkin\w*|manuell\w*|manual\b|stick\s*shift)/i
const MANUAL_NEG = /\b(ei\s+manuaali\w*|inte\s+manuell\w*|ej\s+manuell\w*|not\s+manual)/i

const PLATES_POS =
  /\b(siirtokilv\w*|koekilv\w*|tarrakilv\w*|ilman\s+kilp\w*|ei\s+kilp\w*|kilvet\s+puut\w*|kilvet\s+mukaan|ota\s+kilvet|(?:rekisteri)?kilvet\s+irrot\w*|rekisteröimät\w*|provskylt\w*|utan\s+skylt\w*|inga\s+skylt\w*|medtag\s+skylt\w*|skylt\w*\s+borttag\w*|oregistrerad\w*|no\s+plates|without\s+plates|plates\s+removed|transfer\s+plates|trade\s+plates|bring\s+plates|needs\s+plates|unregistered)/i
const PLATES_NEG = /\b(kilvet\s+on\b|kilvet\s+paikalla\w*|med\s+skyltar|plates\s+on\s+car|has\s+plates)/i

const SUMMER_TYRES_RE = /\b(kesärenka\w*|kesäpyör\w*|sommardäck\w*|s(?:um|mu)mer\s+t[yi]res?)/i
const SUMMER_TYRES_SPARE_RE = /\b(takakont\w*|tavaratil\w*|kontissa|takapenk\w*|kyydissä|mukaan|mukana|trunk|boot|\bin\s+the\s+back\b|bagage\w*|skuff\w*)/i
const SUMMER_TYRES_MOUNTED_RE = /\b(alla|paikalla\w*|autossa|päälle|päällä|on\s+car|mounted|fitted)\b/i

export function parseNoteFlags(note: Note | null, on = true): ParsedNoteInfo {
  return parseNoteFlagsV2(note, on)
  if (!on || !note || !note.text) {
    return { manualLicence: false, withPlates: false, summerTyres: false, hasTightDeadline: false }
  }
  const t = note.text
  const manualLicence = MANUAL_POS.test(t) && !MANUAL_NEG.test(t)
  const withPlates = PLATES_POS.test(t) && !PLATES_NEG.test(t)
  const clauses = t.toLowerCase().split(/[.!?\n;]+/)
  const summerClauses = t.toLowerCase().split(/[.!?\n;,]+/)
  const summerTyres = summerClauses.some(
    (c) => SUMMER_TYRES_RE.test(c) && (SUMMER_TYRES_MOUNTED_RE.test(c) || !SUMMER_TYRES_SPARE_RE.test(c)),
  )
  const hasTightDeadline = clauses.some((c) => DELIVERY.test(c) && (BEFORE.test(c) || CLOSED_AT.test(c)))
  return { manualLicence, withPlates, summerTyres, hasTightDeadline }
}

const AFTER =
  /jälkeen|all?kaen|aikaisintaan|vasta|\bafter\b|\bfrom\b|earliest|not\s+befo?re|ei\s+ennen|vall?mm?is|\bready\b|efter|tidigast|inte\s+före|klar|först|maksun|maskettu|maksettu|paid/
const BEFORE = /ennen|mennessä|viim|asti|saakka|\bbefore\b|\bby\b|\buntil\b|\btill\b|latest|före|senast|innan/
const CLOSED_AT = /kiinn+i\s+(?:klo|kello)?\s*\d|close[sd]?\s+(?:at|after)\s+\d|stänger\s+(?:kl\.?|klockan)?\s*\d/
const DELIVERY = /toimit|perillä|perille|vastaanot|kohde|deliver|arrive|destination|receiv|leverera|leverans|framme|mottag/
const PICKUP_CUE = /nouto|noudettav\w*|haettav\w*|valmis|vall?mm?is|luovut\w*|pickup|pick\s*up|\bready\b|released|klar\b|hämt\w*|utlämn\w*/
const CALL_AHEAD_RE =
  /\b(?:call|ring|soita|ilmoita|text|tekstaa|viesti)\b[^.!?\n;]{0,45}\b(?:before|innan|ennen)\b[^.!?\n;]*/gi
const CLOCK =
  /(?:klo|kello|kl\.?)\s*(\d{1,2})(?:[.:](\d{2}))?|\b(\d{1,2})[.:](\d{2})\b|\b([0-2]?\d)\s*(?=(?:jälkeen|alkaen|allkaen|mennessä|asti|saakka)\b)/g
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

export function normalizeNoteTimeWords(raw: string): string {
  let s = raw.toLowerCase()
  // Strip phone-call courtesy instructions ("Call 10 min before you arrive", "Soita 30 min ennen kuin olet perillä")
  s = s.replace(CALL_AHEAD_RE, " ")
  // Normalize trailing weekday corrections: "valmis torstaina klo 11.30. Korjaus: perjantaina" -> replace earlier weekday with corrected weekday
  const corrDayRe = new RegExp(
    `\\b(${ANY_WEEKDAY_TOKEN})\\b([^!?;\\n]{0,55}?)[.!?;,\\s]+(?:korjaus|rättelse|correction)\\s*:\\s*(${ANY_WEEKDAY_TOKEN})\\b`,
    "gi",
  )
  s = s.replace(corrDayRe, "$3$2")
  // Keep weekday abbreviations like "ke." attached to the following time cue ("ke. 8 jälkeen")
  s = s.replace(/\b(ma|ti|ke|to|pe|la|su)\.(?=\s+\S)/gi, "$1")
  // Normalize decimal times like 15.30 or 11.30 into 15:30 / 11:30 before sentence splitting!
  s = s.replace(/\b(\d{1,2})\.(\d{2})\b/g, "$1:$2")
  // Normalize self-corrections: "klo 17, ei kun klo 18" or "klo 10.30 alkaen. Korjaus: klo 11.30" (preserving Finnish postposition cue)
  s = s.replace(
    /(?:(?:klo|kello|kl\.?|at|from|by|before|after)\s*)?\d{1,2}(?:[.:]\d{2})?(\s*(?:jälkeen|alkaen|allkaen|mennessä|asti|saakka|onwards))?\s*(?:,|(?:\.|;)\s*(?=(?:ei\s*kun|eiku|eikun|nej\s*men|eller\s*nej|no\s*wait|sorry|actually|korjaus|rättelse|correction)))\s*(?:ei\s*kun|eiku|eikun|nej\s*men|eller\s*nej|no\s*wait|sorry|actually|(?:korjaus|rättelse|correction)\s*:?)\s*/gi,
    "$1 ",
  )
  // Strip parenthetical negated times: "(not 12:00)", "(ei klo 12)"
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
  s = s.replace(/\b([7-9]|1[0-2])(?::(\d{2}))?\s*am\b/gi, (_, h, m) => `${Number(h)}:${m ?? "00"}`)
  s = s.replace(/\b([1-9]|1[0-1])(?::(\d{2}))?\s*pm\b/gi, (_, h, m) => `${Number(h) + 12}:${m ?? "00"}`)
  for (const [words, hhmm, strict] of WORD_HOUR_MAP) {
    const prep = strict ? WORD_TIME_PREP_STRICT : WORD_TIME_PREP_FULL
    const preRe = new RegExp(`\\b(${prep})\\s+(?:${words})\\b`, "gi")
    s = s.replace(preRe, `$1 ${hhmm}`)
    const postRe = new RegExp(`\\b(?:${words})\\s+(${WORD_TIME_POST})\\b`, "gi")
    s = s.replace(postRe, `klo ${hhmm} $1`)
  }
  // Strip explicit negated times (e.g., "ei klo 15", "not at 15:00", "inte kl 15") while preserving "ei ennen klo ..."
  s = s.replace(/\b(?:ei\s+klo|ei\s+kello|inte\s+kl(?:ockan)?|ej\s+kl(?:ockan)?|not\s+at|not\s+around|not)\s+\d{1,2}(?:[:.]\d{2})?(?:\s*pm)?\b/gi, " ")
  return s
}

let cachedDealerPriors: Map<string, number> | null = null
function loadDealerProfilePriors(): Map<string, number> {
  if (cachedDealerPriors) return cachedDealerPriors
  const map = new Map<string, number>()
  try {
    const file = path.join(process.cwd(), "data", "dealer-profiles.json")
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        profiles?: Record<string, { recommendedQuoteOffset?: number }>
      }
      for (const [dealerId, prof] of Object.entries(parsed.profiles ?? {})) {
        const off = Number(prof.recommendedQuoteOffset)
        if (Number.isFinite(off) && off !== 0) {
          map.set(dealerId, Math.min(0.08, Math.max(-0.04, off)))
        }
      }
    }
  } catch {
    // Non-fatal if profiles file is absent
  }
  cachedDealerPriors = map
  return map
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

export function windowFromNote(note: Note | null, window: TimeWindow, stop: "pickup" | "delivery", arrivedAt = window.from): TimeWindow {
  return windowFromNoteV2(note, window, stop, arrivedAt)
  if (!note) return window
  const fullNormalized = normalizeNoteTimeWords(note.text)
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
      const m = minutes(Number(match[1] ?? match[3] ?? match[5]), Number(match[2] ?? match[4] ?? 0))
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

function haversineKm(a: Place, b: Place): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const sinDLat = Math.sin(dLat / 2)
  const sinDLon = Math.sin(dLon / 2)
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface LiveProgressUpdate {
  worldId: string
  level: number
  now: number
  dayName: string
  score: Score
  telemetry: RoundSummary["telemetry"]
  recentEvent?: string
}

export class QuantitativeDesk {
  readonly world: World
  readonly level: number
  readonly strategy: StrategyConfig
  readonly map: WorldMap
  readonly roster: DriverProfile[]
  now: number

  readonly outbox: Action[] = []
  readonly requests = new Map<string, PriceRequest>()
  readonly orders = new Map<string, Order>()
  readonly legGigs = new Map<string, Map<number, string>>()
  readonly gigOrder = new Map<string, string>()
  readonly booked = new Set<string>()
  readonly started = new Set<string>()
  readonly posts = new Map<string, PostAction>()
  readonly urgent = new Set<string>()

  // Topology & driver intelligence
  readonly placesById = new Map<string, Place>()
  readonly roadMinutesMap = new Map<string, number>()
  readonly roadKmMap = new Map<string, number>()
  readonly driversNearPlace = new Map<string, DriverProfile[]>()
  readonly gigViewers = new Map<string, Set<string>>()
  readonly repositionedDriversAtPlace = new Map<string, Set<string>>() // placeId -> driverIds finishing there today
  readonly gigBookedByDriver = new Map<string, string>() // gigId -> driverId
  readonly driverLastDelivery = new Map<string, { placeId: string; at: number }>() // idle driverId -> last delivered stop & minute
  readonly snowPlaces = new Map<string, number>() // placeId -> snow endsAt minute

  // Online learning & capacity state
  readonly dealerPriorOffsets: Map<string, number> // Warm-start offsets loaded from data/dealer-profiles.json
  readonly dealerTrust = new Map<string, number>() // Level 8: 0..25 on-time count per dealer
  readonly dealerPriceOffset = new Map<string, number>() // Learned price sensitivity per dealer
  readonly dealerRequests = new Map<string, number>() // Dealer total requests
  readonly dealerWins = new Map<string, number>() // Dealer total wins
  readonly bookedFeeByGig = new Map<string, number>() // gigId -> last booked feeCents
  readonly townOutageStreak = new Map<string, number>() // Detects regional competitor outage (+30% backup price!)
  readonly recentOutcomes: boolean[] = [] // true=won, false=lost for targeted quotes
  readonly targetedRequests = new Set<string>()
  readonly batchCounts = new Map<string, number>()
  readonly townDayWins = new Map<string, number>()

  // Direct offer rate limit tracking
  readonly driverOffersByDay = new Map<string, number>() // `${day}:${driverId}` -> count (max 3)
  readonly gigOpenOffers = new Map<string, number>() // gigId -> open offer count (max 3)
  readonly offeredPairs = new Set<string>() // `${gigId}:${driverId}`

  // Telemetry counters
  readonly telemetry: RoundSummary["telemetry"] = {
    totalRequests: 0,
    quotedToWin: 0,
    declinedHighQuote: 0,
    wonOrders: 0,
    lostOrders: 0,
    winRateAll: 0,
    winRateTargeted: 0,
    totalGigsPosted: 0,
    totalGigsBooked: 0,
    totalDirectOffers: 0,
    acceptedDirectOffers: 0,
    gigDrops: 0,
    noShows: 0,
    visitFailures: {},
    deadlineWarnings: 0,
    lateDeliveries: 0,
    onTimeDeliveries: 0,
    ledgerBreakdownCents: {},
  }

  constructor(world: World, level: number, now: number, map: WorldMap, roster: DriverProfile[], strategy: StrategyConfig) {
    this.world = world
    this.level = level
    this.now = now
    this.map = map
    this.roster = roster
    this.strategy = strategy
    this.dealerPriorOffsets = loadDealerProfilePriors()

    for (const p of map.places) {
      this.placesById.set(p.id, p)
    }
    for (const r of map.roads) {
      this.roadMinutesMap.set(`${r.from}->${r.to}`, r.minutes)
      this.roadKmMap.set(`${r.from}->${r.to}`, r.km)
    }
    // Precompute drivers living within 30km straight line of each place (notification radius!)
    for (const p of map.places) {
      const nearby: DriverProfile[] = []
      for (const d of roster) {
        const home = this.placesById.get(d.homePlaceId)
        if (home && haversineKm(p, home) <= 30.0) {
          nearby.push(d)
        }
      }
      nearby.sort((a, b) => a.drops / (a.completedGigs + 5) - b.drops / (b.completedGigs + 5) || b.rating - a.rating)
      this.driversNearPlace.set(p.id, nearby)
    }
  }

  roadMinutes(from: string, to: string): number {
    return this.roadMinutesMap.get(`${from}->${to}`) ?? 180
  }

  roadKm(from: string, to: string): number {
    return this.roadKmMap.get(`${from}->${to}`) ?? 150
  }

  localDriverCount(placeId: string): number {
    return this.driversNearPlace.get(placeId)?.length ?? 0
  }

  repositionedDriverCount(placeId: string): number {
    const today = Math.floor(this.now / DAY)
    const activeSet = new Set<string>()
    for (const [driverId, lastDeliv] of this.driverLastDelivery.entries()) {
      if (
        lastDeliv.placeId === placeId &&
        Math.floor(lastDeliv.at / DAY) === today &&
        this.now - lastDeliv.at <= 6 * HOUR
      ) {
        activeSet.add(driverId)
      }
    }
    const finishingSet = this.repositionedDriversAtPlace.get(placeId)
    if (finishingSet) {
      for (const dId of finishingSet) activeSet.add(dId)
    }
    return activeSet.size
  }

  waitingOrdersCount(): number {
    let count = 0
    for (const order of this.orders.values()) {
      if (order.status === "cancelled") continue
      const undeliv = undelivered(order)
      if (undeliv.length === 0) continue
      const gigs = this.gigsOf(order.id)
      const allBooked = gigs.length > 0 && gigs.every((gId) => this.booked.has(gId))
      if (!allBooked) count++
    }
    return count
  }

  liveOnTimeRatio(): number {
    const totalDone = this.telemetry.onTimeDeliveries + this.telemetry.lateDeliveries
    if (totalDone < 5) return 1.0
    return this.telemetry.onTimeDeliveries / totalDone
  }

  effectiveOnTimeRatio(): number {
    const totalDone = this.telemetry.onTimeDeliveries + this.telemetry.lateDeliveries
    let overdueActive = 0
    let urgentUndelivered = 0
    for (const order of this.orders.values()) {
      if (order.status === "cancelled") continue
      if (undelivered(order).length === 0) continue
      if (this.now > order.deadline) overdueActive++
      else if (this.urgent.has(order.id)) urgentUndelivered++
    }
    if (totalDone + overdueActive < 5 && urgentUndelivered < 4) return 1.0
    const projectedLate = totalDone >= 15 ? 0.35 * urgentUndelivered : 0
    const denom = totalDone + overdueActive + projectedLate
    if (denom <= 0) return 1.0
    return this.telemetry.onTimeDeliveries / denom
  }

  async rejoin(snapshot: DeskSnapshot, history: DeskEvent[]): Promise<void> {
    const posted = Map.groupBy(snapshot.gigs, (gig) => gig.stops[0]!.orderId)
    for (const gig of snapshot.gigs) {
      if (["booked", "working", "done"].includes(gig.status)) this.booked.add(gig.id)
      if (["working", "done"].includes(gig.status)) this.started.add(gig.id)
      if (["open", "booked", "working"].includes(gig.status)) {
        this.carry({ type: "post", stops: gig.stops, audience: gig.audience, schedule: gig.schedule }, gig.id)
      }
    }
    const historyOrders = new Map<string, Order>()
    const lateRefundOrders = new Set<string>()
    let firstWonAt = Infinity
    for (const event of history) {
      if (event.kind === "order_won" && event.at < firstWonAt) {
        firstWonAt = event.at
      }
      if (event.kind === "ledger" && event.line.kind === "late_refund" && event.line.orderId) {
        lateRefundOrders.add(event.line.orderId)
      }
    }
    const currentDay = Math.floor(this.now / DAY)
    for (const event of history) {
      if (event.kind === "price_request") {
        this.requests.set(event.request.id, event.request)
        if (event.at >= firstWonAt) {
          this.dealerRequests.set(event.request.dealerId, (this.dealerRequests.get(event.request.dealerId) ?? 0) + 1)
        }
      } else if (event.kind === "order_won") {
        historyOrders.set(event.order.id, event.order)
        this.dealerWins.set(event.order.dealerId, (this.dealerWins.get(event.order.dealerId) ?? 0) + 1)
        const prevOffset = this.dealerPriceOffset.get(event.order.dealerId) ?? 0
        this.dealerPriceOffset.set(event.order.dealerId, Math.min(0.22, prevOffset + 0.020))
        if (event.at >= firstWonAt) {
          this.recentOutcomes.push(true)
          if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
        }
        const evDay = Math.floor(event.at / DAY)
        if (evDay === currentDay) {
          const pickupPlace = event.order.legs[0]?.pickup.placeId
          if (pickupPlace) {
            const key = `${evDay}:${pickupPlace}`
            this.townDayWins.set(key, (this.townDayWins.get(key) ?? 0) + 1)
          }
        }
      } else if (event.kind === "order_lost" && event.at >= firstWonAt) {
        const req = this.requests.get(event.requestId)
        if (req) {
          const prevOffset = this.dealerPriceOffset.get(req.dealerId) ?? 0
          this.dealerPriceOffset.set(req.dealerId, Math.max(-0.25, prevOffset - 0.018))
        }
        this.recentOutcomes.push(false)
        if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
      } else if (event.kind === "deadline_close") {
        this.urgent.add(event.orderId)
      } else if (event.kind === "forecast") {
        for (const pid of event.placeIds) {
          this.snowPlaces.set(pid, Math.max(this.snowPlaces.get(pid) ?? 0, event.to))
        }
      } else if (event.kind === "ledger") {
        const { kind, cents, orderId } = event.line
        this.telemetry.ledgerBreakdownCents[kind] = (this.telemetry.ledgerBreakdownCents[kind] ?? 0) + cents
        if (kind === "revenue" && orderId) {
          const order = historyOrders.get(orderId) ?? snapshot.orders.find((o) => o.id === orderId)
          if (order) {
            if (!lateRefundOrders.has(orderId)) {
              this.telemetry.onTimeDeliveries++
              const prevTrust = this.dealerTrust.get(order.dealerId) ?? 0
              this.dealerTrust.set(order.dealerId, Math.min(25, prevTrust + 1))
            } else {
              this.telemetry.lateDeliveries++
              const prevTrust = this.dealerTrust.get(order.dealerId) ?? 0
              this.dealerTrust.set(order.dealerId, Math.floor(prevTrust / 2))
            }
          }
        }
      }
    }
    for (const order of snapshot.orders) {
      if (this.requests.has(order.id) && order.status !== "cancelled") {
        this.orders.set(order.id, order)
      }
    }
    for (const id of [...this.urgent]) {
      const o = this.orders.get(id)
      if (!o || o.status === "cancelled" || undelivered(o).length === 0) {
        this.urgent.delete(id)
      }
    }
    for (const order of this.orders.values()) {
      if (order.status === "waiting" && this.gigsOf(order.id).length === 0) {
        await this.post(order, undelivered(order))
      }
    }
    for (const event of history) {
      const order = "orderId" in event && event.orderId ? this.orders.get(event.orderId) : undefined
      if (!order) continue
      if (event.kind === "visit_failed" && order.deliveredAt[event.leg] === null) {
        const later = (posted.get(order.id) ?? []).filter((gig) => gig.postedAt >= event.at && gig.id !== event.gigId)
        if (!later.some((gig) => gig.stops.some((stop) => stop.leg === event.leg))) {
          await this.retry(order.id, event.leg, event.reason)
        }
      }
    }
    for (const request of snapshot.openRequests) {
      this.quote(request)
    }
  }

  async handle(event: DeskEvent): Promise<void> {
    if (event.kind === "price_request") {
      this.quote(event.request)
    } else if (event.kind === "order_won") {
      await this.win(event.order)
    } else if (event.kind === "order_lost") {
      this.lose(event.requestId)
    } else if (event.kind === "order_changed") {
      await this.change(event.order)
    } else if (event.kind === "order_cancelled") {
      const prevOrder = this.orders.get(event.orderId)
      this.orders.delete(event.orderId)
      this.legGigs.delete(event.orderId)
      this.urgent.delete(event.orderId)
      if (prevOrder) {
        for (const cg of event.gigs) {
          this.booked.delete(cg.gigId)
        }
      }
    } else if (event.kind === "visit_failed") {
      this.telemetry.visitFailures[event.reason] = (this.telemetry.visitFailures[event.reason] ?? 0) + 1
      await this.retry(event.orderId, event.leg, event.reason)
    } else if (event.kind === "gig_expired") {
      this.repost(event.gigId)
    } else if (event.kind === "deadline_close") {
      this.telemetry.deadlineWarnings++
      await this.raise(event.orderId)
    } else if (event.kind === "gig_viewed") {
      let viewers = this.gigViewers.get(event.gigId)
      if (!viewers) {
        viewers = new Set()
        this.gigViewers.set(event.gigId, viewers)
      }
      viewers.add(event.driverId)
      const orderId = this.gigOrder.get(event.gigId)
      const order = orderId ? this.orders.get(orderId) : undefined
      const post = this.posts.get(event.gigId)
      const viewerProfile = this.roster.find((d) => d.id === event.driverId)
      if (orderId && order && !this.booked.has(event.gigId) && viewerProfile) {
        const isUrg = this.urgent.has(orderId)
        const gigAge = post ? this.now - post.at : 0
        const deliveryPlaceId = order.legs[order.legs.length - 1]?.delivery.placeId
        const homePlace = this.placesById.get(viewerProfile.homePlaceId)
        const deliveryPlace = deliveryPlaceId ? this.placesById.get(deliveryPlaceId) : undefined
        const isHomeward = Boolean(
          homePlace &&
            deliveryPlace &&
            Math.hypot((homePlace.lat - deliveryPlace.lat) * 111, (homePlace.lon - deliveryPlace.lon) * 55) <= 45,
        )
        const isActiveViewer = viewerProfile.completedGigs >= 15 || this.driverLastDelivery.has(event.driverId)
        if ((isUrg && viewerProfile.completedGigs >= 8) || (isActiveViewer && (isHomeward || gigAge >= 30))) {
          this.tryDirectOfferToDriver(event.gigId, event.driverId)
        }
      }
    } else if (event.kind === "gig_booked") {
      this.booked.add(event.gigId)
      this.gigBookedByDriver.set(event.gigId, event.driverId)
      this.driverLastDelivery.delete(event.driverId)
      for (const set of this.repositionedDriversAtPlace.values()) {
        set.delete(event.driverId)
      }
      this.telemetry.totalGigsBooked++
      const postAction = this.posts.get(event.gigId)
      let fee = postAction?.schedule[0]?.feeCents ?? 100
      for (const step of postAction?.schedule ?? []) {
        if (step.at <= this.now) fee = step.feeCents
      }
      this.bookedFeeByGig.set(event.gigId, fee)
      // Record where this driver will finish so we know we have a repositioned driver there!
      const lastStop = postAction?.stops[postAction.stops.length - 1]
      if (lastStop) {
        const order = this.orders.get(lastStop.orderId)
        const delivPlace = order?.legs[lastStop.leg]?.delivery.placeId
        if (delivPlace) {
          let set = this.repositionedDriversAtPlace.get(delivPlace)
          if (!set) {
            set = new Set()
            this.repositionedDriversAtPlace.set(delivPlace, set)
          }
          set.add(event.driverId)
        }
      }
    } else if (event.kind === "gig_started") {
      this.started.add(event.gigId)
    } else if (event.kind === "gig_dropped" || event.kind === "no_show") {
      if (event.kind === "gig_dropped") this.telemetry.gigDrops++
      else this.telemetry.noShows++
      const droppedDriver = this.gigBookedByDriver.get(event.gigId)
      if (droppedDriver) {
        for (const set of this.repositionedDriversAtPlace.values()) {
          set.delete(droppedDriver)
        }
      }
      this.booked.delete(event.gigId)
      this.gigBookedByDriver.delete(event.gigId)
      const orderId = this.gigOrder.get(event.gigId)
      if (orderId) {
        await this.onGigLostDriver(orderId, event.gigId)
      }
    } else if (event.kind === "driver_late") {
      const orderId = this.gigOrder.get(event.gigId)
      const order = orderId ? this.orders.get(orderId) : undefined
      if (
        order &&
        !this.started.has(event.gigId) &&
        event.pickupAt > order.lastPickupAt &&
        order.lastPickupAt - this.now >= 150 &&
        this.localDriverCount(order.legs[0]!.pickup.placeId) >= 2
      ) {
        this.booked.delete(event.gigId)
        this.legGigs.delete(order.id)
        this.outbox.push({ type: "release", gigId: event.gigId })
        this.urgent.add(order.id)
        await this.post(order, undelivered(order))
      }
    } else if (event.kind === "offer_answered") {
      const openCount = this.gigOpenOffers.get(event.gigId) ?? 1
      this.gigOpenOffers.set(event.gigId, Math.max(0, openCount - 1))
      if (event.answer === "accepted") {
        this.booked.add(event.gigId)
        this.gigBookedByDriver.set(event.gigId, event.driverId)
        this.driverLastDelivery.delete(event.driverId)
        for (const set of this.repositionedDriversAtPlace.values()) {
          set.delete(event.driverId)
        }
        this.telemetry.acceptedDirectOffers++
      }
    } else if (event.kind === "delivered") {
      this.delivered(event.orderId, event.leg, event.at, event.placeId, event.gigId)
    } else if (event.kind === "forecast") {
      for (const pid of event.placeIds) {
        this.snowPlaces.set(pid, Math.max(this.snowPlaces.get(pid) ?? 0, event.to))
      }
    } else if (event.kind === "ledger") {
      const { kind, cents, orderId } = event.line
      this.telemetry.ledgerBreakdownCents[kind] = (this.telemetry.ledgerBreakdownCents[kind] ?? 0) + cents
      if (kind === "revenue" && orderId) {
        const order = this.orders.get(orderId)
        if (order) {
          const allOnTime = order.deliveredAt.every((t) => t !== null && t <= order.deadline)
          if (allOnTime) {
            this.telemetry.onTimeDeliveries++
            const prevTrust = this.dealerTrust.get(order.dealerId) ?? 0
            this.dealerTrust.set(order.dealerId, Math.min(25, prevTrust + 1))
          } else {
            this.telemetry.lateDeliveries++
            const prevTrust = this.dealerTrust.get(order.dealerId) ?? 0
            this.dealerTrust.set(order.dealerId, Math.floor(prevTrust / 2))
          }
        }
      }
    }
  }

  delivered(orderId: string, leg: number, at: number, placeId: string, gigId: string): void {
    this.legGigs.get(orderId)?.delete(leg)
    const order = this.orders.get(orderId)
    if (order) {
      order.deliveredAt[leg] = at
      if (undelivered(order).length === 0) this.urgent.delete(orderId)
    } else {
      this.urgent.delete(orderId)
    }
    const driverId = this.gigBookedByDriver.get(gigId)
    if (driverId) {
      for (const set of this.repositionedDriversAtPlace.values()) {
        set.delete(driverId)
      }
      this.driverLastDelivery.set(driverId, { placeId, at })
    }
  }

  /**
   * Quantitative Pricing & Selection Engine v2:
   * - Learns per-dealer price elasticity and regional outage surges (+30%).
   * - Uses repositioned driver network (drivers finishing deliveries at pickupPlace).
   * - Steers multi-option requests while capturing high-margin urgent options when safe.
   */
  quote(request: PriceRequest): void {
    this.requests.set(request.id, request)
    this.telemetry.totalRequests++
    this.dealerRequests.set(request.dealerId, (this.dealerRequests.get(request.dealerId) ?? 0) + 1)

    if (this.level <= 3) {
      const first = request.options[0]!
      this.outbox.push({ type: "quote", requestId: request.id, prices: { [first.kind]: first.listPriceCents } })
      this.telemetry.quotedToWin++
      return
    }

    const leg0 = request.legs[0]!
    const lastLeg = request.legs[request.legs.length - 1]!
    const pickupPlace = leg0.pickup.placeId
    const deliveryPlace = lastLeg.delivery.placeId
    const pickupDrivers = this.localDriverCount(pickupPlace)
    const deliveryDrivers = this.localDriverCount(deliveryPlace)
    const repositionedAtPickup = this.repositionedDriverCount(pickupPlace)
    const effectivePickupSupply = pickupDrivers + repositionedAtPickup * 1.5
    const F = this.strategy.flags
    const noteFlags = parseNoteFlags(request.note, F.noteNLP)

    const declineRequest = () => {
      const opt = request.options[request.options.length - 1]!
      const declinePrice = Math.max(1000, Math.round(opt.listPriceCents * 4.2))
      this.outbox.push({ type: "quote", requestId: request.id, prices: { [opt.kind]: declinePrice } })
      this.telemetry.declinedHighQuote++
    }

    // 1. Bulk order batch cap (30-40 cars from one yard)
    if (F.selectiveDecline && request.batchId !== null) {
      const batchSoFar = this.batchCounts.get(request.batchId) ?? 0
      if (batchSoFar >= this.strategy.maxOrdersPerBatch) {
        declineRequest()
        return
      }
    }

    // 2. Per-town daily saturation cap based on actual WON orders today
    const day = Math.floor(this.now / DAY)
    const townDayKey = `${day}:${pickupPlace}`
    const townWinsToday = this.townDayWins.get(townDayKey) ?? 0
    const maxTownWinsToday = Math.max(2, Math.ceil(effectivePickupSupply * 0.70))
    if (F.selectiveDecline && townWinsToday >= maxTownWinsToday && pickupDrivers < 10) {
      declineRequest()
      return
    }

    // 3. Fleet capacity & On-Time safety buffer gate
    const waiting = this.waitingOrdersCount()
    const totalDrivers = Math.max(1, this.roster.length)
    const liveOnTime = this.liveOnTimeRatio()
    const isShortageLevel = this.level >= 7
    const onTimeHealthy = liveOnTime >= this.strategy.targetOnTimeBuffer
    const maxWaitingAllowed = Math.max(
      4,
      Math.round(
        totalDrivers *
          (onTimeHealthy ? this.strategy.maxActiveWaitingPerDriver : this.strategy.maxActiveWaitingPerDriver * 0.55),
      ),
    )

    let activeUnbookedUrgent = 0
    for (const id of [...this.urgent]) {
      const o = this.orders.get(id)
      if (!o || o.status === "cancelled" || undelivered(o).length === 0) {
        this.urgent.delete(id)
        continue
      }
      const gigs = this.gigsOf(id)
      const allBooked = gigs.length > 0 && gigs.every((gId) => this.booked.has(gId))
      if (!allBooked) activeUnbookedUrgent++
    }

    if (F.selectiveDecline && (waiting >= maxWaitingAllowed || activeUnbookedUrgent >= Math.max(4, Math.round(totalDrivers * 0.12)))) {
      declineRequest()
      return
    }

    // 4. Hard risk filters in shortage worlds
    const hasFlexibleOption = request.options.some((o) => o.kind === "next_day" || o.kind === "within_3_days")
    const totalRoadMins = request.legs.reduce((sum, l) => sum + this.roadMinutes(l.pickup.placeId, l.delivery.placeId), 0)

    const snowAtPickup = (this.snowPlaces.get(pickupPlace) ?? 0) > this.now
    const snowAtDelivery = (this.snowPlaces.get(deliveryPlace) ?? 0) > this.now
    if (F.selectiveDecline && noteFlags.summerTyres && (snowAtPickup || snowAtDelivery) && !hasFlexibleOption) {
      declineRequest()
      return
    }

    if (F.selectiveDecline && isShortageLevel && effectivePickupSupply < 1 && !hasFlexibleOption) {
      declineRequest()
      return
    }

    if (F.selectiveDecline && !hasFlexibleOption) {
      const onlyOpt = request.options[0]!
      const slackBeforeDeadline = onlyOpt.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins
      if (
        (isShortageLevel && effectivePickupSupply < 1.5 && slackBeforeDeadline < 360) ||
        slackBeforeDeadline < 240 ||
        (leg0.pickup.privateAddress && effectivePickupSupply < 2.5) ||
        noteFlags.hasTightDeadline
      ) {
        declineRequest()
        return
      }
    }

    // 5. Estimate realistic driver fee to enforce minimum margin
    let estFeeMultiplier = this.strategy.baseFeeMultiplier
    if (effectivePickupSupply < 3) estFeeMultiplier += this.strategy.scarcityTownFeeBoost
    else if (repositionedAtPickup > 0) estFeeMultiplier -= 0.04
    if (deliveryDrivers < 2) estFeeMultiplier += 0.08
    if (leg0.pickup.privateAddress || lastLeg.delivery.privateAddress) estFeeMultiplier += 0.07
    if (noteFlags.manualLicence || noteFlags.withPlates) estFeeMultiplier += 0.07
    if (request.legs.some((l) => l.car.premium)) estFeeMultiplier += 0.05
    const expectedFeeCents = request.referenceFeeCents * estFeeMultiplier

    // 6. Compute dynamic quote multiplier based on Level, Online Win Rate, Per-Dealer Learning & Outage Streaks
    let baseMult = 1.05
    if (this.level === 4 || this.level === 5) baseMult = 1.04
    else if (this.level === 6) baseMult = 1.08
    else if (this.level === 7) baseMult = Math.max(1.22, this.strategy.baseQuoteMultiplier - 0.12)
    else if (this.level === 8) baseMult = this.strategy.baseQuoteMultiplier

    // Online proportional adaptation from recent targeted quotes
    if (this.recentOutcomes.length >= 10) {
      const recentWins = this.recentOutcomes.filter(Boolean).length
      const recentWinRate = recentWins / this.recentOutcomes.length
      const winGap = recentWinRate - this.strategy.targetWinRate
      if (winGap > 0.04) {
        baseMult += Math.min(0.10, winGap * 0.45)
      } else if (winGap < -0.04 && waiting < maxWaitingAllowed * 0.80 && liveOnTime >= this.strategy.targetOnTimeBuffer) {
        baseMult += Math.max(-0.26, winGap * 0.80)
      }
    }

    // Per-dealer learned price offset
    const dReqs = this.dealerRequests.get(request.dealerId) ?? 0
    const dWins = this.dealerWins.get(request.dealerId) ?? 0
    const dealerOffset = F.dealerLearning ? (this.dealerPriceOffset.get(request.dealerId) ?? 0) : 0
    baseMult += dealerOffset

    // Inelastic Dealer Ratchet (Strategy 2c Champion): Asymmetric upward ratchet for captive dealers
    if (F.dealerLearning) {
      const dWinRate = dWins / Math.max(1, dReqs)
      if (dWinRate >= 0.35 && dReqs >= 4) {
        baseMult += Math.min(0.18, dWins * 0.015)
      }
    }

    // Regional outage surge detector (if we won >= 3 in a row from this town today, competitor may have an outage!)
    const streak = F.dealerLearning ? (this.townOutageStreak.get(townDayKey) ?? 0) : 0
    if (streak >= 3) {
      baseMult += Math.min(0.16, (streak - 2) * 0.04)
    }

    // Level 8 Dealer Trust bonus (+1% per on-time order up to 25)
    if (this.level === 8 && F.dealerLearning) {
      const trust = this.dealerTrust.get(request.dealerId) ?? 0
      baseMult *= 1 + 0.0085 * Math.min(25, trust)
    }

    // Scarcity lane markup (competitor's lane factor is also higher on scarce lanes!)
    if (deliveryDrivers <= 1) baseMult *= 1.05
    if (pickupDrivers <= 2) baseMult *= 1.04

    // Build option prices
    const prices: Partial<Record<"same_day" | "next_day" | "within_3_days", number>> = {}
    const minRequiredPrice = expectedFeeCents / Math.max(0.5, 1 - this.strategy.minExpectedMarginRatio)

    for (const opt of request.options) {
      // Captive urgency extraction (Strategy 2c Champion): single same_day option with no alternatives
      if (opt.kind === "same_day" && request.options.length === 1 && F.dealerLearning) {
        const quotePrice = Math.max(minRequiredPrice * 1.08, opt.listPriceCents * (baseMult + 0.08))
        prices.same_day = Math.max(100, Math.round(quotePrice))
        continue
      }

      if (opt.kind === "same_day" && hasFlexibleOption && F.optionSteering) {
        const slack = opt.deadline - Math.max(this.now, leg0.pickup.window.from) - totalRoadMins
        if (effectivePickupSupply >= 4 && slack >= 300 && !noteFlags.hasTightDeadline && onTimeHealthy) {
          const rawSameDay = opt.listPriceCents * (baseMult + this.strategy.sameDayQuotePremium)
          if (rawSameDay >= minRequiredPrice * 1.05) {
            prices.same_day = Math.max(100, Math.round(rawSameDay))
          }
        }
        continue
      }

      const optMult = opt.kind === "same_day" ? baseMult + this.strategy.sameDayQuotePremium * 0.65 : baseMult
      const targetPrice = opt.listPriceCents * optMult
      if (targetPrice * 1.08 < minRequiredPrice) {
        continue
      }
      const finalPrice = Math.max(targetPrice, minRequiredPrice)
      prices[opt.kind] = Math.max(100, Math.round(finalPrice))
    }

    if (Object.keys(prices).length === 0) {
      declineRequest()
      return
    }

    this.outbox.push({ type: "quote", requestId: request.id, prices })
    this.targetedRequests.add(request.id)
    this.telemetry.quotedToWin++
    if (request.batchId !== null) {
      this.batchCounts.set(request.batchId, (this.batchCounts.get(request.batchId) ?? 0) + 1)
    }
  }

  async win(order: Order): Promise<void> {
    if (!this.requests.has(order.id) || this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    this.telemetry.wonOrders++
    this.dealerWins.set(order.dealerId, (this.dealerWins.get(order.dealerId) ?? 0) + 1)

    const day = Math.floor(this.now / DAY)
    const pickupPlace = order.legs[0]!.pickup.placeId
    const townDayKey = `${day}:${pickupPlace}`
    this.townDayWins.set(townDayKey, (this.townDayWins.get(townDayKey) ?? 0) + 1)
    this.townOutageStreak.set(townDayKey, (this.townOutageStreak.get(townDayKey) ?? 0) + 1)

    const prevDealerOffset = this.dealerPriceOffset.get(order.dealerId) ?? 0
    this.dealerPriceOffset.set(order.dealerId, Math.min(0.22, prevDealerOffset + 0.020))

    if (this.targetedRequests.has(order.id)) {
      this.recentOutcomes.push(true)
      if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
    }
    if (this.strategy.flags.chainGigs && this.level >= 3 && (await this.tryChainOrder(order))) {
      return
    }
    await this.post(order, undelivered(order))
  }

  async tryChainOrder(orderB: Order): Promise<boolean> {
    if (orderB.legs.length !== 1) return false
    const legB = orderB.legs[0]!
    if (legB.pickup.privateAddress || legB.delivery.privateAddress) return false
    if (orderB.lastPickupAt - this.now < 12 * HOUR) return false
    const reqB = this.requests.get(orderB.id)
    if (!reqB) return false
    const flagsB = parseNoteFlags(reqB.note, this.strategy.flags.noteNLP)

    for (const [gigId, postAction] of this.posts.entries()) {
      if (this.booked.has(gigId) || postAction.stops.length !== 2) continue
      const orderAId = postAction.stops[0]!.orderId
      const orderA = this.orders.get(orderAId)
      if (!orderA || orderA.id === orderB.id || orderA.status === "cancelled" || orderA.legs.length !== 1) continue
      if (this.urgent.has(orderA.id) || this.legGigs.get(orderA.id)?.get(0) !== gigId) continue
      if (orderA.lastPickupAt - this.now < 12 * HOUR) continue
      const legA = orderA.legs[0]!
      if (legA.pickup.privateAddress || legA.delivery.privateAddress) continue

      const driveA = this.roadMinutes(legA.pickup.placeId, legA.delivery.placeId)
      const driveB = this.roadMinutes(legB.pickup.placeId, legB.delivery.placeId)
      const gapAB = this.roadMinutes(legA.delivery.placeId, legB.pickup.placeId)
      const gapBA = this.roadMinutes(legB.delivery.placeId, legA.pickup.placeId)

      let first: Order, second: Order, totalDrive: number
      if (gapAB <= 45 && driveA + gapAB + driveB <= 600) {
        first = orderA; second = orderB; totalDrive = driveA + gapAB + driveB
      } else if (gapBA <= 45 && driveB + gapBA + driveA <= 600) {
        first = orderB; second = orderA; totalDrive = driveB + gapBA + driveA
      } else {
        continue
      }
      void totalDrive

      if (!(await this.withdraw(orderA.id))) continue
      const req1 = this.requests.get(first.id)!
      const req2 = this.requests.get(second.id)!
      const f1 = parseNoteFlags(req1.note, this.strategy.flags.noteNLP)
      const f2 = parseNoteFlags(req2.note, this.strategy.flags.noteNLP)
      const s1 = withoutWindows(stopsFor(first, [0], this.strategy.flags.noteNLP ? req1.note : null, { pickupFrom: 0, manualLicence: f1.manualLicence, plates: f1.withPlates }, req1.arrivedAt, (a, b) => this.roadKm(a, b)), this.now + 15)
      const s2 = withoutWindows(stopsFor(second, [0], this.strategy.flags.noteNLP ? req2.note : null, { pickupFrom: 0, manualLicence: f2.manualLicence, plates: f2.withPlates }, req2.arrivedAt, (a, b) => this.roadKm(a, b)), this.now + 15)
      const combinedStops = [...s1, ...s2]
      const audience: Audience = {
        experienced: first.legs[0]!.car.premium || second.legs[0]!.car.premium,
        manualLicence: f1.manualLicence || f2.manualLicence,
      }
      const combinedRef = req1.referenceFeeCents + req2.referenceFeeCents
      const openFee = Math.max(100, Math.round(combinedRef * this.strategy.baseFeeMultiplier * 0.86))
      const midFee = Math.max(openFee, Math.round(combinedRef * this.strategy.maxNormalFeeMultiplier * 0.84))
      const peakFee = Math.max(midFee, Math.round(combinedRef * this.strategy.maxNormalFeeMultiplier * 0.96))
      const schedule: FeeStep[] = [
        { at: this.now, feeCents: openFee },
        { at: this.now + 240, feeCents: midFee },
        { at: this.now + 420, feeCents: peakFee },
      ]
      this.outbox.push({ type: "post", stops: combinedStops, audience, schedule })
      this.telemetry.totalGigsPosted++
      await this.send()
      // Fallback to individual posts if server rejected the 2-car gig
      if (this.gigsOf(orderA.id).length === 0) await this.post(orderA, [0])
      if (this.gigsOf(orderB.id).length === 0) await this.post(orderB, [0])
      return true
    }
    return false
  }

  lose(requestId: string): void {
    this.telemetry.lostOrders++
    const req = this.requests.get(requestId)
    if (req && this.targetedRequests.has(requestId)) {
      const day = Math.floor(this.now / DAY)
      const pickupPlace = req.legs[0]!.pickup.placeId
      this.townOutageStreak.set(`${day}:${pickupPlace}`, 0)

      const prevDealerOffset = this.dealerPriceOffset.get(req.dealerId) ?? 0
      this.dealerPriceOffset.set(req.dealerId, Math.max(-0.25, prevDealerOffset - 0.018))

      this.recentOutcomes.push(false)
      if (this.recentOutcomes.length > 35) this.recentOutcomes.shift()
    }
  }

  async change(order: Order): Promise<void> {
    if (!this.orders.has(order.id)) return
    this.orders.set(order.id, order)
    if (await this.withdraw(order.id)) {
      await this.post(order, undelivered(order))
    }
  }

  repost(gigId: string): void {
    const action = this.posts.get(gigId)
    if (!action || !action.stops.some(({ orderId, leg }) => this.legGigs.get(orderId)?.get(leg) === gigId)) return
    for (const { orderId, leg } of action.stops) this.legGigs.get(orderId)?.delete(leg)
    const order = this.orders.get(action.stops[0]!.orderId)
    if (!order) return
    if (order.lastPickupAt - this.now <= 360) {
      this.urgent.add(order.id)
    }
    this.outbox.push({
      ...action,
      stops: withoutWindows(action.stops, Infinity),
      schedule: this.feesFor(order, pickups(action)),
    })
    this.telemetry.totalGigsPosted++
  }

  async onGigLostDriver(orderId: string, gigId: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    const action = this.posts.get(gigId)
    if (!action) return
    if (order.lastPickupAt - this.now <= 360) {
      this.urgent.add(orderId)
    }
    const lastBooked = this.bookedFeeByGig.get(gigId) ?? 0
    const sched = this.feesFor(order, pickups(action))
    if (lastBooked > 0) {
      for (const s of sched) {
        s.feeCents = Math.max(s.feeCents, Math.round(lastBooked * 1.05))
      }
    }
    this.outbox.push({
      type: "reprice",
      gigId,
      schedule: sched,
    })
    this.dispatchDirectOffersForGig(gigId, order)
  }

  async raise(orderId: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    this.urgent.add(orderId)
    await this.sendPostOf(orderId)
    for (const gigId of this.gigsOf(orderId)) {
      if (!this.booked.has(gigId)) {
        const postAction = this.posts.get(gigId)
        if (postAction) {
          this.outbox.push({
            type: "reprice",
            gigId,
            schedule: this.feesFor(order, pickups(postAction)),
          })
          this.dispatchDirectOffersForGig(gigId, order)
        }
      }
    }
  }

  /**
   * Game-Theoretic Flat-Opening Fee Schedule:
   * - Keeps the fee FLAT during the initial booking window so drivers learn `bookedFee / firstViewedFee = 1.00`
   *   and never hold out waiting for hourly raises!
   * - Embeds an automatic pre-deadline escalation starting 5 hours before `lastPickupAt` to guarantee >92% on-time.
   */
  feesFor(order: Order, cars: number): FeeStep[] {
    const req = this.requests.get(order.id)!
    const baseRefFee = (req.referenceFeeCents * cars) / order.legs.length
    if (this.level === 1) {
      return [{ at: this.now, feeCents: Math.max(100, Math.round(baseRefFee * 1.15)) }]
    }

    const pickupPlace = order.legs[0]!.pickup.placeId
    const deliveryPlace = order.legs[order.legs.length - 1]!.delivery.placeId
    const pickupDrivers = this.localDriverCount(pickupPlace)
    const deliveryDrivers = this.localDriverCount(deliveryPlace)

    let scarcityAdd = 0
    if (this.level >= 7) {
      if (pickupDrivers <= 2) scarcityAdd += this.strategy.scarcityTownFeeBoost
      else if (pickupDrivers <= 4) scarcityAdd += this.strategy.scarcityTownFeeBoost * 0.45
      if (deliveryDrivers <= 1) scarcityAdd += 0.08
    }

    const slackToLastPickup = Math.max(0, order.lastPickupAt - this.now)
    const isUrgent = this.urgent.has(order.id) || slackToLastPickup <= 240

    if (isUrgent) {
      const startMult = Math.max(this.strategy.urgentFeeMultiplier, this.strategy.baseFeeMultiplier + scarcityAdd + 0.45)
      const peakMult = Math.max(startMult + 0.4, this.strategy.maxUrgentFeeMultiplier + scarcityAdd)
      const steps = [0, 1, 2, 3, 4, 5]
      return steps.map((k) => {
        const frac = k / (steps.length - 1)
        const mult = startMult + frac * (peakMult - startMult)
        return {
          at: this.now + k * 25,
          feeCents: Math.max(100, Math.round(baseRefFee * mult)),
        }
      })
    }

    if (!this.strategy.flags.flatFees) {
      const openM = this.strategy.baseFeeMultiplier + scarcityAdd
      return [0, 1, 2, 3, 4, 5].map((k) => ({
        at: this.now + k * 60,
        feeCents: Math.max(100, Math.round(baseRefFee * openM * (1 + k / 10))),
      }))
    }
    // Game-Theoretic Flat-Opening Schedule:
    // Hold fee flat at `openMult` for the initial booking window so drivers who view immediately book at 1.0x ratio!
    let openMult = this.strategy.baseFeeMultiplier + scarcityAdd
    let midMult = Math.max(openMult + 0.18, this.strategy.maxNormalFeeMultiplier * 0.92 + scarcityAdd)
    let normalPeak = Math.max(midMult + 0.15, this.strategy.maxNormalFeeMultiplier + scarcityAdd)
    let flatHoldMins = 240
    let peakOffsetMins = 360

    if (this.strategy.flags.slackFees && pickupDrivers >= 4) {
      if (slackToLastPickup >= 30 * HOUR) {
        openMult = 0.88 + scarcityAdd
        midMult = 1.05 + scarcityAdd
        normalPeak = 1.26 + scarcityAdd
        flatHoldMins = 360
        peakOffsetMins = 720
      } else if (slackToLastPickup >= 16 * HOUR) {
        openMult = 0.98 + scarcityAdd
        midMult = 1.16 + scarcityAdd
        normalPeak = 1.35 + scarcityAdd
        flatHoldMins = 240
        peakOffsetMins = 420
      }
    }
    const urgentPeak = Math.max(normalPeak + 0.35, this.strategy.maxUrgentFeeMultiplier + scarcityAdd)

    const rawSteps: FeeStep[] = [
      { at: this.now, feeCents: Math.max(100, Math.round(baseRefFee * openMult)) },
      { at: this.now + flatHoldMins, feeCents: Math.max(100, Math.round(baseRefFee * midMult)) },
      { at: this.now + peakOffsetMins, feeCents: Math.max(100, Math.round(baseRefFee * normalPeak)) },
    ]

    // Embedded urgency ramp starting 5 hours before lastPickupAt
    const escalateStart = Math.max(this.now + 60, order.lastPickupAt - 300)
    for (let j = 1; j <= 4; j++) {
      const frac = j / 4
      const mult = normalPeak + frac * (urgentPeak - normalPeak)
      rawSteps.push({
        at: escalateStart + (j - 1) * 45,
        feeCents: Math.max(100, Math.round(baseRefFee * mult)),
      })
    }

    const schedule: FeeStep[] = []
    for (const s of rawSteps) {
      const prev = schedule[schedule.length - 1]
      if (!prev) {
        schedule.push(s)
      } else if (s.at > prev.at) {
        schedule.push({
          at: s.at,
          feeCents: Math.max(prev.feeCents, s.feeCents),
        })
      }
    }
    return schedule
  }

  dispatchContinuationDirectOffers(gigId: string, order: Order): void {
    if (this.level < 3 || !this.strategy.flags.repositionOffers) return
    const minuteOfDay = this.now % DAY
    if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return
    if (this.driverLastDelivery.size === 0) return

    const pickupPlaceId = order.legs[0]!.pickup.placeId
    const deliveryPlaceId = order.legs[order.legs.length - 1]!.delivery.placeId
    const pickupPlace = this.placesById.get(pickupPlaceId)
    const deliveryPlace = this.placesById.get(deliveryPlaceId)
    if (!pickupPlace) return

    const candidates: { driverId: string; priority: number }[] = []
    for (const [driverId, lastDeliv] of this.driverLastDelivery.entries()) {
      if (this.now - lastDeliv.at > 14 * HOUR) continue
      const lastPlace = this.placesById.get(lastDeliv.placeId)
      if (!lastPlace) continue
      const distFromPickup = haversineKm(lastPlace, pickupPlace)
      if (distFromPickup > 35.0) continue

      const profile = this.roster.find((d) => d.id === driverId)
      if (!profile) continue
      const homePlace = this.placesById.get(profile.homePlaceId)
      const awayFromHome = homePlace ? haversineKm(homePlace, pickupPlace) > 30.0 : false
      const homeward = homePlace && deliveryPlace ? haversineKm(homePlace, deliveryPlace) <= 40.0 : false

      // App only notifies drivers <=30km of home; prioritize stranded idle drivers who never see this gig!
      let priority = (awayFromHome ? 100 : 10) + (homeward ? 50 : 0) - distFromPickup
      candidates.push({ driverId, priority })
    }

    candidates.sort((a, b) => b.priority - a.priority)
    for (const c of candidates) {
      if ((this.gigOpenOffers.get(gigId) ?? 0) >= 2) break
      this.tryDirectOfferToDriver(gigId, c.driverId, 2)
    }
  }

  dispatchDirectOffersForGig(gigId: string, order: Order): void {
    if (this.level < 3 || !this.strategy.flags.repositionOffers) return
    const minuteOfDay = this.now % DAY
    if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return

    const postAction = this.posts.get(gigId)
    if (!postAction) return

    const pickupPlace = order.legs[0]!.pickup.placeId
    const today = Math.floor(this.now / DAY)
    const idleDeliveredHere: string[] = []
    for (const [dId, lastDeliv] of this.driverLastDelivery.entries()) {
      if (lastDeliv.placeId === pickupPlace && Math.floor(lastDeliv.at / DAY) === today && this.now - lastDeliv.at <= 10 * HOUR) {
        idleDeliveredHere.push(dId)
      }
    }
    const viewers = [...(this.gigViewers.get(gigId) ?? [])]
    const nearby = this.driversNearPlace.get(pickupPlace) ?? []
    const enRoute = [...(this.repositionedDriversAtPlace.get(pickupPlace) ?? [])]

    // Prioritize genuinely idle delivered drivers here, then viewers, then local drivers, then en-route repositioned
    const candidateIds = [...new Set([...idleDeliveredHere, ...viewers, ...nearby.map((d) => d.id), ...enRoute])]
    for (const driverId of candidateIds) {
      if ((this.gigOpenOffers.get(gigId) ?? 0) >= 3) break
      this.tryDirectOfferToDriver(gigId, driverId)
    }
  }

  tryDirectOfferToDriver(gigId: string, driverId: string, maxOpenOffers = 3): void {
    if (this.level < 3 || !this.strategy.flags.repositionOffers) return
    const minuteOfDay = this.now % DAY
    if (minuteOfDay < 7 * HOUR || minuteOfDay >= 22 * HOUR + 45) return
    if ((this.gigOpenOffers.get(gigId) ?? 0) >= maxOpenOffers) return

    const pairKey = `${gigId}:${driverId}`
    if (this.offeredPairs.has(pairKey)) return

    const day = Math.floor(this.now / DAY)
    const driverDayKey = `${day}:${driverId}`
    const sentToday = this.driverOffersByDay.get(driverDayKey) ?? 0
    if (sentToday >= 3) return

    const postAction = this.posts.get(gigId)
    if (!postAction) return

    const profile = this.roster.find((d) => d.id === driverId)
    if (!profile) return

    if (postAction.audience.experienced && (profile.rating < 4.8 || profile.completedGigs < 50)) return
    if (postAction.audience.manualLicence && profile.licence !== "manual") return

    let currentFee = postAction.schedule[0]!.feeCents
    for (const step of postAction.schedule) {
      if (step.at <= this.now) currentFee = step.feeCents
    }
    const orderId = this.gigOrder.get(gigId)
    const isUrgent = orderId ? this.urgent.has(orderId) : false
    const req = orderId ? this.requests.get(orderId) : undefined
    const order = orderId ? this.orders.get(orderId) : undefined
    const minRef = req ? Math.round((req.referenceFeeCents * pickups(postAction)) / Math.max(1, order?.legs.length ?? 1)) : 100
    const nonUrgentOfferMult = Math.max(1.02, this.strategy.directOfferDiscount)
    const offerFee = Math.max(100, minRef, Math.round(currentFee * (isUrgent ? 1.12 : nonUrgentOfferMult)))

    this.outbox.push({
      type: "offer",
      gigId,
      driverId,
      feeCents: offerFee,
    })
    this.offeredPairs.add(pairKey)
    this.driverOffersByDay.set(driverDayKey, sentToday + 1)
    this.gigOpenOffers.set(gigId, (this.gigOpenOffers.get(gigId) ?? 0) + 1)
    this.telemetry.totalDirectOffers++
  }

  async retry(orderId: string, leg: number, reason: string): Promise<void> {
    const order = this.orders.get(orderId)
    if (!order) return
    this.legGigs.get(orderId)?.delete(leg)
    const carNotThere = reason === "not_ready" || reason === "closed"
    const pickupFrom = carNotThere ? retryFrom(order, this.requests.get(orderId)!, leg, this.now) : 0
    const prevFlags = parseNoteFlags(this.requests.get(orderId)?.note ?? null, this.strategy.flags.noteNLP)
    await this.post(order, [leg], {
      pickupFrom,
      manualLicence: prevFlags.manualLicence || reason === "licence",
      plates: prevFlags.withPlates || reason === "no_plates",
    })
  }

  async post(order: Order, legs: number[], retry?: Retry): Promise<void> {
    const req = this.requests.get(order.id)!
    const noteFlags = parseNoteFlags(req.note, this.strategy.flags.noteNLP)
    const effectiveRetry: Retry = retry ?? {
      pickupFrom: 0,
      manualLicence: noteFlags.manualLicence,
      plates: noteFlags.withPlates,
    }

    if (legs.length > 1) {
      let totalMinutes = 0
      for (let i = 0; i < legs.length; i++) {
        const l = order.legs[legs[i]!]!
        totalMinutes += this.roadMinutes(l.pickup.placeId, l.delivery.placeId)
        if (i + 1 < legs.length) {
          const nextL = order.legs[legs[i + 1]!]!
          totalMinutes += this.roadMinutes(l.delivery.placeId, nextL.pickup.placeId)
        }
      }
      if (totalMinutes > 12 * HOUR) {
        for (const leg of legs) {
          await this.post(order, [leg], effectiveRetry)
        }
        return
      }
    }

    const audience: Audience = {
      experienced: order.legs.some((leg) => leg.car.premium),
      manualLicence: effectiveRetry.manualLicence,
    }
    const stops = withoutWindows(stopsFor(order, legs, this.strategy.flags.noteNLP ? req.note : null, effectiveRetry, req.arrivedAt, (a, b) => this.roadKm(a, b)), this.now + 15)
    this.outbox.push({
      type: "post",
      stops,
      audience,
      schedule: this.feesFor(order, legs.length),
    })
    this.telemetry.totalGigsPosted++
    if (legs.length === 1) return

    await this.send()
    if (this.gigsOf(order.id).length === 0) {
      for (const leg of legs) await this.post(order, [leg], effectiveRetry)
    }
  }

  gigsOf(orderId: string): string[] {
    return [...new Set(this.legGigs.get(orderId)?.values())]
  }

  carry(action: PostAction, gigId: string): void {
    for (const { orderId, leg } of action.stops) {
      this.legGigs.set(orderId, (this.legGigs.get(orderId) ?? new Map()).set(leg, gigId))
      this.gigOrder.set(gigId, orderId)
    }
    this.posts.set(gigId, action)
  }

  async withdraw(orderId: string): Promise<boolean> {
    await this.sendPostOf(orderId)
    const gigs = this.gigsOf(orderId)
    if (gigs.some((gigId) => this.booked.has(gigId))) return false
    this.legGigs.delete(orderId)
    for (const gigId of gigs) this.outbox.push({ type: "withdraw", gigId })
    return true
  }

  async sendPostOf(orderId: string): Promise<void> {
    if (this.outbox.some((action) => action.type === "post" && action.stops[0]!.orderId === orderId)) {
      await this.send()
    }
  }

  async send(): Promise<void> {
    const actions = this.outbox.splice(0)
    if (actions.length > 0) this.readResults(actions, await this.world.act(actions))
  }

  readResults(actions: Action[], results: ActionResult[]): void {
    actions.forEach((action, i) => {
      if (action.type === "post" && results[i]?.ok) {
        const gigId = results[i]!.id
        this.carry(action, gigId)
        const orderId = action.stops[0]?.orderId
        const order = orderId ? this.orders.get(orderId) : undefined
        if (order) {
          if (this.urgent.has(order.id) || order.lastPickupAt - this.now <= 300) {
            this.dispatchDirectOffersForGig(gigId, order)
          }
        }
      }
    })
  }

  finalizeTelemetry(): void {
    this.telemetry.winRateAll =
      this.telemetry.totalRequests > 0 ? this.telemetry.wonOrders / this.telemetry.totalRequests : 0
    this.telemetry.winRateTargeted =
      this.telemetry.quotedToWin > 0 ? this.telemetry.wonOrders / this.telemetry.quotedToWin : 0
  }
}

function retryFrom(order: Order, request: PriceRequest, leg: number, now: number): number {
  const promised = request.options.find((option) => option.kind === order.option)?.deadline ?? order.deadline
  const delay = Math.max(0, order.deadline - promised)
  return Math.round(Math.max(now + 2 * HOUR, order.legs[leg]!.pickup.window.from + delay))
}

const undelivered = (order: Order): number[] =>
  order.legs.map((_, leg) => leg).filter((leg) => order.deliveredAt[leg] === null)

const pickups = (action: PostAction): number => action.stops.filter((stop) => stop.kind === "pickup").length

const withoutWindows = (stops: StopRef[], before: number): StopRef[] =>
  stops.map((stop) => (stop.window && stop.window.to < before ? { ...stop, window: undefined } : stop))

function stopsFor(
  order: Order,
  legs: number[],
  note: Note | null,
  retry: Retry,
  arrivedAt?: number,
  roadKmFn?: (a: string, b: string) => number,
): StopRef[] {
  return legs.flatMap((leg): StopRef[] => {
    const { car, pickup, delivery } = order.legs[leg]!
    const noted = windowFromNote(note, pickup.window, "pickup", arrivedAt ?? pickup.window.from)
    const start = Math.round(Math.max(noted.from, retry.pickupFrom, pickup.window.from))
    const pickupTo = pickup.privateAddress
      ? Math.round(Math.min(pickup.window.to, Math.max(noted.to, start)))
      : Math.round(Math.max(noted.to, start))
    const pickupWindow = { from: start, to: Math.max(start, pickupTo) }
    const deliveryBase = { from: delivery.window.from, to: Math.max(delivery.window.from, order.deadline) }
    const deliveryWindow = windowFromNote(note, deliveryBase, "delivery", arrivedAt ?? delivery.window.from)
    const legKm = roadKmFn ? roadKmFn(pickup.placeId, delivery.placeId) : Infinity
    const lowBattery = car.electric && car.chargePercent !== null && car.chargePercent < 30 && legKm > 200
    const first: StopRef = {
      orderId: order.id,
      leg,
      kind: "pickup",
      withPlates: retry.plates,
      withCharging: lowBattery,
    }
    const second: StopRef = { orderId: order.id, leg, kind: "delivery" }
    return [narrower(first, pickupWindow, pickup.window), narrower(second, deliveryWindow, deliveryBase)]
  })
}

const narrower = (stop: StopRef, window: TimeWindow, base: TimeWindow): StopRef =>
  window.from > base.from || window.to < base.to ? { ...stop, window } : stop

export interface RunSimulationOptions {
  level?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  seed?: string
  board?: boolean
  final?: boolean
  tuneWithGemini?: boolean
  geminiApiKey?: string
  strategyOverride?: StrategyConfig
  persist?: boolean
  quiet?: boolean
  onProgress?: (update: LiveProgressUpdate) => void
  onDayReport?: (metric: DailyMetric) => void
}

export async function runSimulationRound(options: RunSimulationOptions = {}): Promise<RoundSummary> {
  const level = (options.level ?? 8) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  const strategy = options.strategyOverride ?? loadStrategy()
  const client = new Client()
  const map = await client.map()
  const startedAt = new Date().toISOString()
  const startPerf = performance.now()

  const dailyMetrics: DailyMetric[] = []
  let world: World | undefined
  let desk: QuantitativeDesk | undefined
  let finalScore: Score | undefined

  const createDesk = async (w: World, lvl: number, nowMin: number, drvRoster: DriverProfile[]) => {
    if (lvl >= 4) {
      const { Top10IntegratedDesk, getTop10DeskOptions } = await import("./top10-engine.ts")
      return new Top10IntegratedDesk(w, lvl, nowMin, map, drvRoster, strategy, getTop10DeskOptions(strategy))
    }
    return new QuantitativeDesk(w, lvl, nowMin, map, drvRoster, strategy)
  }

  if (options.final) {
    while (true) {
      try {
        if (!world) {
          world = await nextFinal(client)
          console.log(`Final world ${world.id}.`)
        }
        const history = await world.events()
        const snapshot = await world.snapshot()
        const roster = await world.roster()
        const worldLevel = (await world.client.worlds()).find((s) => s.worldId === world!.id)?.level ?? 8
        desk = await createDesk(world, worldLevel, snapshot.now, roster)
        if (snapshot.now < snapshot.endsAt) {
          await desk.rejoin(snapshot, history)
          await desk.send()
          for await (const event of world.stream({ after: history.at(-1)?.seq ?? -1, idleMs: 1000 })) {
            const day = Math.floor(desk.now / DAY)
            desk.now = event === null ? (await world.client.final()).now : Math.max(desk.now, event.at)
            if (event !== null) await desk.handle(event)
            await desk.send()
            if (Math.floor(desk.now / DAY) > day) {
              const s = await world.score()
              const dayName = WEEKDAYS[day % 7]!
              report(dayName, s)
              const metric: DailyMetric = {
                dayIndex: day,
                dayName,
                nowMinute: desk.now,
                marginCents: s.marginCents,
                revenueCents: s.revenueCents,
                wonOrders: s.wonOrders,
                onTimeShare: s.onTimeShare,
                undeliveredShare: s.undeliveredShare,
                ranked: s.ranked,
              }
              dailyMetrics.push(metric)
              options.onDayReport?.(metric)
              desk.finalizeTelemetry()
              options.onProgress?.({
                worldId: world.id,
                level: worldLevel,
                now: desk.now,
                dayName,
                score: s,
                telemetry: { ...desk.telemetry },
              })
            }
            if (desk.now >= snapshot.endsAt) break
          }
        }
        finalScore = await world.score()
        break
      } catch (error) {
        if (!(error instanceof Unreachable)) throw error
        console.error(`spread: ${error.message}. Trying again in 5 seconds.`)
        await new Promise((done) => setTimeout(done, 5000))
      }
    }
  } else {
    const run = await client.create(level, { seed: options.seed, board: options.board })
    world = run
    const name = `${options.board ? "Ranking run" : "Practice world"} ${run.id}`
    console.log(`${name}, level ${level}${options.seed ? `, seed "${options.seed}"` : ""}.`)
    const remove = () => run.delete().then(() => true, () => false)

    try {
      const [{ now, endsAt }, roster] = await Promise.all([run.snapshot(), run.roster()])
      desk = await createDesk(run, level, now, roster)
      while (desk.now < endsAt) {
        const day = Math.floor(desk.now / DAY)
        const midnight = (day + 1) * DAY
        const actions = desk.outbox.splice(0)
        const step = await run.advance({ untilEvent: WAKE_ON, max: Math.min(endsAt, midnight), actions })
        desk.readResults(actions, step.results)
        desk.now = step.now
        for (const event of step.events) await desk.handle(event)
        if (Math.floor(desk.now / DAY) > day) {
          const s = await run.score()
          const dayName = WEEKDAYS[day % 7]!
          report(dayName, s)
          const metric: DailyMetric = {
            dayIndex: day,
            dayName,
            nowMinute: desk.now,
            marginCents: s.marginCents,
            revenueCents: s.revenueCents,
            wonOrders: s.wonOrders,
            onTimeShare: s.onTimeShare,
            undeliveredShare: s.undeliveredShare,
            ranked: s.ranked,
          }
          dailyMetrics.push(metric)
          options.onDayReport?.(metric)
          desk.finalizeTelemetry()
          options.onProgress?.({
            worldId: run.id,
            level,
            now: desk.now,
            dayName,
            score: s,
            telemetry: { ...desk.telemetry },
          })
        }
      }
      finalScore = await run.score()
      if (!options.board && !options.final) {
        await remove()
      }
    } catch (err) {
      await remove()
      throw err
    }
  }

  desk!.finalizeTelemetry()
  report("End", finalScore!)
  console.log(
    finalScore!.ranked
      ? "Ranked."
      : finalScore!.wonOrders === 0
        ? "Not ranked: no order won."
        : "Not ranked: the delivery minimum is 90% of the orders on time.",
  )

  const durationMs = Math.round(performance.now() - startPerf)
  const summary: RoundSummary = {
    runId: `run-${Date.now()}`,
    worldId: world!.id,
    level,
    seed: options.seed ?? null,
    board: Boolean(options.board),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs,
    score: finalScore!,
    telemetry: desk!.telemetry,
    dailyMetrics,
    strategyUsed: strategy,
  }

  if (options.tuneWithGemini !== false) {
    console.log("\n[Gemini 4 Hydrogen Strategist] Analyzing round telemetry & updating strategy parameters...")
    const tuning = await tuneStrategyWithGemini(summary, strategy, options.geminiApiKey)
    summary.geminiTuning = tuning
    console.log(`[Gemini 4 Hydrogen Strategist] Analysis: ${tuning.analysis}`)
    for (const adj of tuning.keyAdjustments) {
      console.log(`  • ${adj}`)
    }
  }

  if (options.persist !== false) appendRun(summary)
  return summary
}

function report(label: string, score: Score): void {
  const euros = (cents: number) =>
    (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(11)
  const percent = (share: number, width: number) => `${(100 * share).toFixed(1)}%`.padStart(width)
  const orders = `${String(score.wonOrders).padStart(4)} orders  ${percent(score.onTimeShare, 6)} on time  ${percent(score.undeliveredShare, 5)} not delivered`
  console.log(`${label.padEnd(9)}  margin €${euros(score.marginCents)}  revenue €${euros(score.revenueCents)}  ${orders}`)
}

async function nextFinal(client: Client): Promise<World> {
  for (let said = false; ; said = true) {
    const set = await client.final().catch((error: unknown) => {
      if (error instanceof SpreadError && error.status === 404) return null
      throw error
    })
    const world = set ? client.world(set.worldId) : null
    if (world) {
      const snapshot = await world.snapshot()
      if (snapshot.now < snapshot.endsAt) return world
    }
    if (!said) {
      console.log(
        "No final is set. Waiting for it: the organisers set a test final 15 minutes before its start, and the final 30 minutes before.",
      )
    }
    await new Promise((done) => setTimeout(done, 10_000))
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      level: { type: "string", default: "8" },
      seed: { type: "string" },
      board: { type: "boolean" },
      final: { type: "boolean" },
      "no-tune": { type: "boolean" },
    },
  })
  const level = Number(args.level) as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
  await runSimulationRound({
    level,
    seed: args.seed,
    board: args.board,
    final: args.final,
    tuneWithGemini: !args["no-tune"],
  })
}
