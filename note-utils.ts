import type { Note, OpeningHours, TimeWindow } from "./spread.ts"

const MINUTE = 1
const HOUR = 60
const DAY = 24 * HOUR

export interface ParsedNoteInfo {
  manualLicence: boolean
  withPlates: boolean
  summerTyres: boolean
  hasTightDeadline: boolean
}

export interface DailyHoursOverride {
  pickupOpens?: number
  pickupCloses?: number
  deliveryOpens?: number
  deliveryCloses?: number
  weekdaysOnly?: boolean
}

const WEEKDAYS_FI: Record<string, number> = {
  maanantaina: 0,
  maanantai: 0,
  ma: 0,
  tiistaina: 1,
  tiistai: 1,
  ti: 1,
  keskiviikkona: 2,
  keskiviikko: 2,
  ke: 2,
  torstaina: 3,
  torstai: 3,
  to: 3,
  perjantaina: 4,
  perjantai: 4,
  pe: 4,
  lauantaina: 5,
  lauantai: 5,
  la: 5,
  sunnuntaina: 6,
  sunnuntai: 6,
  su: 6,
}

const WEEKDAYS_SV: Record<string, number> = {
  mandag: 0,
  måndag: 0,
  tisdag: 1,
  onsdag: 2,
  torsdag: 3,
  fredag: 4,
  lordag: 5,
  lördag: 5,
  sondag: 6,
  söndag: 6,
}

const WEEKDAYS_EN: Record<string, number> = {
  monday: 0,
  mon: 0,
  tuesday: 1,
  tue: 1,
  tues: 1,
  wednesday: 2,
  wed: 2,
  thursday: 3,
  thu: 3,
  thur: 3,
  thurs: 3,
  friday: 4,
  fri: 4,
  saturday: 5,
  sat: 5,
  sunday: 6,
  sun: 6,
}

// Spoken Finnish clock words (e.g. "kahdelta", "kolmelta", "viideltä", "kuudelta", "kaheksalta")
const WORD_HOURS_FI: Record<string, number> = {
  yhdeltä: 13,
  yhdelta: 13,
  kahelta: 14,
  kahdelta: 14,
  kolmelta: 15,
  neljältä: 16,
  neljalta: 16,
  viideltä: 17,
  viidelta: 17,
  viieltä: 17,
  kuudelta: 18,
  seitsemältä: 19,
  seitsemalta: 19,
  seiskalta: 19,
  kahdeksalta: 8,
  kaheksalta: 8,
  yhdeksältä: 9,
  yhdeksalta: 9,
  kymmeneltä: 10,
  kymmenelta: 10,
  yhdeltätoista: 11,
  yhdeltatoista: 11,
  kahdeltatoista: 12,
  kaheltatoista: 12,
  aamukahdeksalta: 8,
  aamuysiltä: 9,
  puolenpäivän: 12,
}

const MANUAL_POS = /\b(manuaali\w*|käsivaiht\w*|kasivaiht\w*|keppivaiht\w*|kytkin\w*|manuell\w*|manual\b|stick\s*shift)/i
const MANUAL_NEG = /\b(ei\s+manuaali\w*|inte\s+manuell\w*|ej\s+manuell\w*|not\s+manual|automaat\w*|automat\w*)/i

const PLATES_POS =
  /\b(siirtokilv\w*|koee?kilv\w*|tarrakilv\w*|ilman\s+kilp\w*|ilman\s+rekkareit\w*|ei\s+kilp\w*|ei\s+rekkareit\w*|rekkareit\w*\s+puut\w*|kilvet\s+puut\w*|kilpien?\s+tarv\w*|kilvet\s+mukaan|ota\s+kilvet|(?:rekisteri)?kilvet\s+irrot\w*|rekisteröimät\w*|provskylt\w*|saluvagnsskylt\w*|utan\s+skylt\w*|inga\s+skylt\w*|medtag\s+skylt\w*|skylt\w*\s+borttag\w*|oregistrerad\w*|no\s+plates|without\s+plates|plates\s+removed|transfer\s+plates|trade\s+plates|bring\s+plates|needs\s+plates|unregistered)/i
const PLATES_NEG =
  /\b(kilvet\s+on\b|kilvet\s+paikalla\w*|kilvet\s+löytyy|kilvet\s+loytyy|ei\s+(?:tarvita|tarvitse)\s+(?:\w*kilp\w*|rekkareit\w*)|med\s+skyltar|skyltar\s+på|plates\s+on\s+car|has\s+plates|no\s+transfer\s+plates)/i

const SUMMER_POS =
  /\b(kesärenk\w*|kesarenk\w*|kesäkume\w*|kesakume\w*|kesäpyör\w*|kesapyor\w*|sommardäck\w*|sommardack\w*|summer\s+tyres?|summer\s+tires?|slicks)\b/i
const SUMMER_TRUNK =
  /\b(kontissa|takakont\w*|tavaratil\w*|mukana\s+tulee|tulee\s+mukana|kyydissä|kyydissa|pussissa|vanteineen|i\s+bakluck\w*|i\s+bagage\w*|medföljer|följer\s+med|extra\s+(?:set|tyres|tires|wheels)|second\s+set|in\s+(?:the\s+)?(?:trunk|boot|back)|go\s+with\s+(?:the\s+)?car)\b/i

const TIGHT_HINT =
  /\b(viimeistään|viimeitsään|viim\.?|ehdottomasti|mennessä|ennen|aikaisintaan|vasta|valmmis|valmis|kiinnni|kiinni|sulkeutuu|senasst|senast|måste|senare\s+än|stänger|öppet|framme|before|by|until|closes?|must\s+be|no\s+later\s+than|at\s+the\s+latest|korjaus)\b/i

export function normalizeNoteText(raw: string): string {
  let s = raw
    .replace(/viimeitsään|viimeistaan|viimeistään|viimeistää\b/gi, "viimeistaan")
    .replace(/senasst|senast/gi, "senast")
    .replace(/valmmis|valmis/gi, "valmis")
    .replace(/kiinnni|kiinni/gi, "kiinni")
    .replace(/koee?kilv/gi, "koekilv")
    // Crucial: negated "before" ("not before", "ei ennen", "inte före") means earliest pickup ("aikaisintaan"), NEVER deadline!
    .replace(/\b(?:ei|not|inte|ej)\s+(?:ennen(?:\s*kuin)?|before|f[öo]re|innan)\b/gi, "aikaisintaan")
    // Prevent sentence split after common abbreviations (viim., klo., kl., ma., ti., ke., to., pe., la., su.)
    .replace(/\b(viim|klo|kl|ma|ti|ke|to|pe|la|su|mon|tue|wed|thu|fri|sat|sun|mån|tis|ons|tor|fre|lör|sön)\./gi, "$1")
    // Normalize Finnish/Swedish diacritics where regex word-boundaries matter for time words
    .replace(/\b(1[0-2]|0?[1-9])(?:[:.](\d{2}))?\s*(am|pm)\b/gi, (_, hStr, mStr, ap) => {
      let h = Number(hStr)
      const isPm = ap.toLowerCase() === "pm"
      if (isPm && h < 12) h += 12
      if (!isPm && h === 12) h = 0
      return `${String(h).padStart(2, "0")}:${mStr ?? "00"}`
    })
  const wordsPattern = new RegExp(`(?<![a-zäöå0-9])(${Object.keys(WORD_HOURS_FI).join("|")})(?![a-zäöå0-9])`, "gi")
  s = s.replace(wordsPattern, (m) => {
    const h = WORD_HOURS_FI[m.toLowerCase()]
    return h !== undefined ? `${String(h).padStart(2, "0")}:00` : m
  })
  return s
}

function toMinutesOfDay(h: number, m = 0): number | null {
  if (!Number.isFinite(h) || !Number.isFinite(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  return h * 60 + m
}

function dayStartOf(min: number): number {
  return Math.floor(min / DAY) * DAY
}

function splitClauses(text: string): string[] {
  return text
    .split(/\.(?!\d)|[;!\n]+/)
    .map((c) => c.trim())
    .filter(Boolean)
}

function detectWeekdayOffset(clause: string, refMin: number): number | null {
  const low = clause.toLowerCase()
  const refDay = Math.floor(refMin / DAY)
  const refDow = ((refDay % 7) + 7) % 7

  if (/\b(tänään|tanaan|idag|today)\b/.test(low)) return 0
  if (/\b(huomenna|imorgon|tomorrow)\b/.test(low)) return 1

  const allDays: Record<string, number> = { ...WEEKDAYS_FI, ...WEEKDAYS_SV, ...WEEKDAYS_EN }
  // Clean periods on weekday abbrevs ("ma.", "pe.", "mon.")
  const cleaned = low.replace(/\b(ma|ti|ke|to|pe|la|su|mon|tue|wed|thu|fri|sat|sun)\./g, "$1")
  const tokens = cleaned.split(/[\s,:/()-]+/).filter(Boolean)
  for (const tok of tokens) {
    const dow = allDays[tok]
    if (dow !== undefined) {
      let diff = (dow - refDow + 7) % 7
      // If same weekday token appears AND it's late or explicit future weekday ("ma" on Fri -> Mon = +3; on Mon morning = 0)
      return diff
    }
  }
  return null
}

function isPickupClause(clause: string): boolean {
  return /(?:^|[^a-zäöå])(nouto|haku|hakea|haeta\w*|haettava|heattava|noudettav\w*|valmis|meillä|meilla|täältä|taalta|myyjä\w*|lähtö|lahto|pickup|pick\s*up|collect\w*|ready|released|payment|maksun|shop|avhämt\w*|avhamt\w*|hämt\w*|hamt\w*|säljare\w*)(?=$|[^a-zäöå])/i.test(
    clause,
  )
}

function isDeliveryClause(clause: string): boolean {
  return /(?:^|[^a-zäöå])(toimitus|perillä|perilla|vienti|viedä|tuonti|kohde|kohteessa|asiakas|vastaanott\w*|delivery|deliver|destination|arrive\w*|drop\s*off|framme|leverans|mottag\w*)(?=$|[^a-zäöå])/i.test(
    clause,
  )
}

export function parseNoteFlagsV2(note: Note | null, on = true): ParsedNoteInfo {
  if (!on || !note?.text) {
    return { manualLicence: false, withPlates: false, summerTyres: false, hasTightDeadline: false }
  }
  const text = normalizeNoteText(note.text)
  const clauses = splitClauses(text)

  let manualLicence = false
  let withPlates = false
  let summerTyres = false
  let hasTightDeadline = false

  for (const c of clauses) {
    if (MANUAL_POS.test(c) && !MANUAL_NEG.test(c)) manualLicence = true
    if (PLATES_POS.test(c) && !PLATES_NEG.test(c)) withPlates = true
    if (SUMMER_POS.test(c) && !SUMMER_TRUNK.test(c)) summerTyres = true
    if (TIGHT_HINT.test(c)) hasTightDeadline = true
  }
  if (!hasTightDeadline && /\b\d{1,2}[:.]\d{2}\b/.test(text)) {
    hasTightDeadline = true
  }

  return { manualLicence, withPlates, summerTyres, hasTightDeadline }
}

export function extractDailyHoursFromNote(note: Note | null): DailyHoursOverride {
  if (!note?.text) return {}
  const text = normalizeNoteText(note.text)
  const clauses = splitClauses(text)
  const out: DailyHoursOverride = {}

  const RANGE_RE = /\b(\d{1,2})(?:[:.](\d{2}))?\s*[-–—]\s*(\d{1,2})(?:[:.](\d{2}))?\b/g
  const BEFORE_CLOSE_RE =
    /(?:^|[^a-zäöå])(?:ennen\s+(?:klo|kello)?|kiinni\s+(?:klo|kello)?|closes?\s+(?:at)?|stänger\s+(?:kl|klockan)?|till\s+(?:kl|klockan)?|until|sulkee|viimeistaan\s*(?:klo|kello)?)\s*(\d{1,2})(?:[:.](\d{2}))?/i
  const TIME_BEFORE_CLOSE_RE = /\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:kiinni|sulkee|suljetaan|closes?|stänger)\b/i
  const AFTER_OPEN_RE =
    /\b(?:avoinna|auki|open|öppet)\s+(?:arkisin|ma[-–]pe|weekdays|arkipäivisin)?\s*(?:alkaen|klo|kl)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:jälkeen|after|->)/i

  for (const c of clauses) {
    const pick = isPickupClause(c)
    const deliv = isDeliveryClause(c)
    if (/\b(arkisin|ma\s*[-–]\s*pe|weekdays?\s+only|weekdays|mån[-–]fre)\b/i.test(c)) {
      out.weekdaysOnly = true
    }

    for (const m of c.matchAll(RANGE_RE)) {
      const op = toMinutesOfDay(Number(m[1]), Number(m[2] ?? 0))
      const cl = toMinutesOfDay(Number(m[3]), Number(m[4] ?? 0))
      if (op === null || cl === null || op >= cl) continue
      if (deliv && !pick) {
        out.deliveryOpens = out.deliveryOpens === undefined ? op : Math.max(out.deliveryOpens, op)
        out.deliveryCloses = out.deliveryCloses === undefined ? cl : Math.min(out.deliveryCloses, cl)
      } else {
        out.pickupOpens = out.pickupOpens === undefined ? op : Math.max(out.pickupOpens, op)
        out.pickupCloses = out.pickupCloses === undefined ? cl : Math.min(out.pickupCloses, cl)
      }
    }

    const bc = BEFORE_CLOSE_RE.exec(c) ?? TIME_BEFORE_CLOSE_RE.exec(c)
    if (bc && (pick || !/(?:^|[^a-zäöå])(perillä|perilla|framme|destination|senast)(?=$|[^a-zäöå])/i.test(c))) {
      const cl = toMinutesOfDay(Number(bc[1]), Number(bc[2] ?? 0))
      if (cl !== null && cl >= 7 * 60 && cl <= 21 * 60) {
        if (deliv && !pick) {
          out.deliveryCloses = out.deliveryCloses === undefined ? cl : Math.min(out.deliveryCloses, cl)
        } else {
          out.pickupCloses = out.pickupCloses === undefined ? cl : Math.min(out.pickupCloses, cl)
        }
      }
    } else if (bc && deliv) {
      if (/\b(kiinni|closes?|stänger|mottagning\s+till|liike\s+kiinni)\b/i.test(c)) {
        const cl = toMinutesOfDay(Number(bc[1]), Number(bc[2] ?? 0))
        if (cl !== null && cl >= 7 * 60 && cl <= 21 * 60) {
          out.deliveryCloses = out.deliveryCloses === undefined ? cl : Math.min(out.deliveryCloses, cl)
        }
      }
    }

    const ao = AFTER_OPEN_RE.exec(c)
    if (ao) {
      const op = toMinutesOfDay(Number(ao[1]), Number(ao[2] ?? 0))
      if (op !== null) {
        if (deliv && !pick) out.deliveryOpens = out.deliveryOpens === undefined ? op : Math.max(out.deliveryOpens, op)
        else out.pickupOpens = out.pickupOpens === undefined ? op : Math.max(out.pickupOpens, op)
      }
    }
  }

  return out
}

export function windowFromNoteV2(
  note: Note | null,
  window: TimeWindow,
  stop: "pickup" | "delivery",
  arrivedAt = window.from,
): TimeWindow {
  let { from, to } = window
  if (!note?.text) return { from, to }
  const text = normalizeNoteText(note.text)
  const clauses = splitClauses(text)

  const READY_AFTER =
    /(?:^|[^a-zäöå])(?:valmis|ready|klar|noudettavissa|aikaisintaan|tidigast|from|alkaen|jälkeen|jalkeen|efter|after)\s*[^0-9]*?(?:klo|kello|kl)?\s*(\d{1,2})(?:[:.](\d{2}))?/i
  const AFTER_TIME_FI =
    /\b(?:klo|kello|kl)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:jälkeen|jalkeen|alkaen|efter|onwards)(?=$|[^a-zäöå])/i
  const DEADLINE_BY =
    /(?:^|[^a-zäöå])(?:viimeistaan|viim|ennen|mennessä|mennessa|senast|före|fore|innan|by|before|until|latest)(?=$|[^a-zäöå])[^0-9]*?(?:klo|kello|kl)?\s*(\d{1,2})(?:[:.](\d{2}))?/i
  const BY_TIME_TRAILING =
    /(?:^|[^a-zäöå])(?:perillä|perilla|framme|destination|at\s+destination|deliver\w*)(?=$|[^a-zäöå]).*?(?:klo|kello|kl)?\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*menness[aä])?/i
  const KORJAUS_RE = /\b(?:korjaus|correction|ändring|oikaisu)\s*[:\-]?\s*([a-zäöå]+)/i

  let lastDeadlineTimeOfDay: number | null = null
  let lastDeadlineBaseDay: number | null = null

  for (const c of clauses) {
    const pick = isPickupClause(c)
    const deliv = isDeliveryClause(c)
    const dayOff = detectWeekdayOffset(c, arrivedAt)

    // Handle "korjaus: ma" or "correction: 14:00" / "eikun klo 15" updating previously parsed deadline
    const timeCorr = /\b(?:korjaus|correction|ändring|oikaisu|eikun|eiku)\b[^0-9]*?(?:klo|kello|kl)?\s*(\d{1,2})(?:[:.](\d{2}))?(?![0-9])/i.exec(c)
    if (timeCorr && stop === "delivery" && lastDeadlineBaseDay !== null) {
      const cTod = toMinutesOfDay(Number(timeCorr[1]), Number(timeCorr[2] ?? 0))
      if (cTod !== null && cTod >= 6 * 60 && cTod <= 23 * 60) {
        const targetDay = dayStartOf(arrivedAt) + (dayOff ?? lastDeadlineBaseDay) * DAY
        const candidate = targetDay + cTod
        if (candidate >= arrivedAt && candidate <= window.to) {
          // Re-anchor to corrected value rather than keeping stale earlier time via Math.min
          to = Math.min(window.to, candidate)
          lastDeadlineTimeOfDay = cTod
          lastDeadlineBaseDay = dayOff ?? lastDeadlineBaseDay
          continue
        }
      }
    }
    const korj = KORJAUS_RE.exec(c)
    if (korj && stop === "delivery" && lastDeadlineTimeOfDay !== null) {
      const korjOff = detectWeekdayOffset(korj[1]!, arrivedAt)
      if (korjOff !== null) {
        const target = dayStartOf(arrivedAt) + korjOff * DAY + lastDeadlineTimeOfDay
        if (target >= from && target <= window.to) {
          to = Math.min(window.to, target)
          lastDeadlineBaseDay = korjOff
        }
        continue
      }
    }

    if (stop === "pickup") {
      if (deliv && !pick) continue
      const m1 = READY_AFTER.exec(c) ?? AFTER_TIME_FI.exec(c)
      if (m1 && !/\b(auki|open|öppet|perillä|framme)\b/i.test(c)) {
        const min = toMinutesOfDay(Number(m1[1]), Number(m1[2] ?? 0))
        if (min !== null) {
          const targetDay = dayOff !== null ? dayStartOf(arrivedAt) + dayOff * DAY : dayStartOf(from)
          from = Math.max(from, targetDay + min)
        }
      }
      // Note-specified daily close on pickup when closing hour is TODAY only if single day,
      // while multi-day pickup clamping happens dynamically at post/repost time via extractDailyHoursFromNote!
      const daily = extractDailyHoursFromNote({ text: c, language: note.language })
      if (daily.pickupOpens !== undefined && Math.floor(from / DAY) === Math.floor(to / DAY)) {
        from = Math.max(from, dayStartOf(from) + daily.pickupOpens)
      }
      if (daily.pickupCloses !== undefined && dayOff !== null && dayStartOf(arrivedAt) + dayOff * DAY + daily.pickupCloses >= from) {
        to = Math.min(to, dayStartOf(arrivedAt) + dayOff * DAY + daily.pickupCloses)
      }
    } else {
      // Delivery stop deadline
      if (pick && !deliv && !/\b(perillä|perilla|framme|korjaus|viimeistään|senast|must\s+be)\b/i.test(c)) continue
      // Skip recurring opening/receiving hours statements ("open until 2pm only", "closes at 16:30", "liike kiinni klo 17") unless paired with an explicit deadline cue
      const isHoursStatement =
        /\b(auki|avoinna|open|öppet|receiving|kiinni|closes?|stänger)\b/i.test(c) &&
        !/\b(viimeistään|viimeistaan|viim|mennessä|mennessa|senast|must\s+be|latest|perillä\s+viim|framme\s+senast)\b/i.test(c)
      if (isHoursStatement) continue

      const dm = DEADLINE_BY.exec(c) ?? BY_TIME_TRAILING.exec(c)
      if (dm) {
        const tod = toMinutesOfDay(Number(dm[1]), Number(dm[2] ?? 0))
        if (tod !== null && tod >= 6 * 60 && tod <= 23 * 60) {
          let targetDay = dayStartOf(arrivedAt) + (dayOff ?? 0) * DAY
          // If no weekday given and tod is earlier than arrival time of day on arrival day, push +1 day
          if (dayOff === null && targetDay + tod < arrivedAt) {
            targetDay += DAY
          }
          const candidate = targetDay + tod
          if (candidate >= arrivedAt && candidate <= to) {
            to = Math.min(to, candidate)
            lastDeadlineTimeOfDay = tod
            lastDeadlineBaseDay = dayOff ?? Math.floor((targetDay - dayStartOf(arrivedAt)) / DAY)
          }
        }
      }
    }
  }

  return from <= to ? { from, to } : { from: Math.min(from, window.to), to: window.to }
}

/**
 * Dynamically clamp a stop's [from, to] to the NEXT open interval matching BOTH API `hours` and note `daily` hours.
 * Ensures drivers cannot visit after note-stated closing times on ANY day (Mon..Sat), while letting `gig_expired`
 * cleanly wake the bot at close to repost for tomorrow morning.
 */
export function clampPickupWindowForNow(
  baseWin: TimeWindow,
  hours: OpeningHours | null,
  daily: DailyHoursOverride,
  now: number,
  safetyBufferMin = 15,
): TimeWindow {
  const effectiveFrom = Math.max(baseWin.from, now)
  const hardTo = baseWin.to
  if (effectiveFrom >= hardTo) return baseWin
  if (daily.pickupOpens === undefined && daily.pickupCloses === undefined && !daily.weekdaysOnly) {
    return baseWin
  }

  let cursor = effectiveFrom
  for (let d = 0; d < 8; d++) {
    const dStart = dayStartOf(cursor)
    const dow = ((Math.floor(cursor / DAY) % 7) + 7) % 7
    if (dow === 6) {
      cursor = dStart + DAY
      continue
    }
    let apiOpen = 0
    let apiClose = 24 * HOUR
    let openDay = true
    if (hours) {
      if (dow === 5) {
        if (!hours.saturday || daily.weekdaysOnly) openDay = false
        else {
          apiOpen = hours.saturday.opens
          apiClose = hours.saturday.closes
        }
      } else {
        if (!hours.weekdays.includes(dow)) openDay = false
        else {
          apiOpen = hours.opens
          apiClose = hours.closes
        }
      }
    } else if (dow === 5 && daily.weekdaysOnly) {
      openDay = false
    }

    if (!openDay) {
      cursor = dStart + DAY
      continue
    }

    const effOpen = daily.pickupOpens !== undefined ? Math.max(apiOpen, daily.pickupOpens) : apiOpen
    const effClose = daily.pickupCloses !== undefined ? Math.min(apiClose, daily.pickupCloses) : apiClose
    const dayWinFrom = Math.max(effectiveFrom, dStart + effOpen)
    const dayWinTo = Math.min(hardTo, dStart + effClose - safetyBufferMin)
    if (dayWinFrom < dayWinTo) {
      return { from: dayWinFrom, to: dayWinTo }
    }
    cursor = dStart + DAY
  }
  return baseWin
}
