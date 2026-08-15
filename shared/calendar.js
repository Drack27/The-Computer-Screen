/* Calendar engine.
 *
 * Everything in the app counts in *day numbers* — plain integers. The calendar
 * is the only thing that knows what a day number means, so a campaign can run
 * on the Gregorian calendar, the Calendar of Harptos, or something a GM made up
 * over breakfast, and the clock, the blips and the timeline never notice.
 *
 * A date is written "Y-M-D" with 1-based month and day, e.g. "1925-05-01" or
 * "1491-4-15". That string is calendar-agnostic: the same triple means
 * different things under different calendars, which is exactly what we want.
 */

// ── Integer helpers ──────────────────────────────────────────────────────────
// JS % and / truncate toward zero, which breaks for years before the epoch.

const floorDiv = (a, b) => Math.floor(a / b);
const mod = (a, b) => ((a % b) + b) % b;

// ── Calendar definitions ─────────────────────────────────────────────────────

/**
 * A calendar definition is plain JSON, so it lives happily in campaign.json:
 *
 * {
 *   id, name,
 *   kind: "gregorian" | "custom",
 *   months: [{ name, days, intercalary?, abbr? }],
 *   weekdays: [string],            // optional; omit for calendars without them
 *   weekdayOffset: number,         // which weekday day-number 0 falls on
 *   leap: { every, offset, month, extraDays } | null,
 *   era: string,                   // "AD", "DR", "AR" — appended when formatting
 *   yearLabel: "suffix" | "prefix" | "none"
 * }
 *
 * `kind: "gregorian"` ignores `months`/`leap` and uses the real leap rules
 * (4/100/400) so historical campaigns get real dates.
 */

const GREGORIAN_MONTHS = [
  ['January', 31], ['February', 28], ['March', 31], ['April', 30],
  ['May', 31], ['June', 30], ['July', 31], ['August', 31],
  ['September', 30], ['October', 31], ['November', 30], ['December', 31],
].map(([name, days]) => ({ name, days, abbr: name.slice(0, 3) }));

export const GREGORIAN = {
  id: 'gregorian',
  name: 'Gregorian',
  kind: 'gregorian',
  months: GREGORIAN_MONTHS,
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  weekdayOffset: 4,          // 1970-01-01 (day 0 of the civil algorithm) was a Thursday
  leap: null,
  era: '',
  yearLabel: 'none',
};

/* The Calendar of Harptos — Forgotten Realms. Twelve 30-day months with five
 * festival days wedged between them, plus Shieldmeet every fourth year. The
 * festivals are modelled as one-day months so they occupy a slot in the month
 * list and the arithmetic stays uniform. */
export const HARPTOS = {
  id: 'harptos',
  name: 'Calendar of Harptos',
  kind: 'custom',
  months: [
    { name: 'Hammer', days: 30, abbr: 'Ham' },
    { name: 'Midwinter', days: 1, intercalary: true },
    { name: 'Alturiak', days: 30, abbr: 'Alt' },
    { name: 'Ches', days: 30, abbr: 'Che' },
    { name: 'Tarsakh', days: 30, abbr: 'Tar' },
    { name: 'Greengrass', days: 1, intercalary: true },
    { name: 'Mirtul', days: 30, abbr: 'Mir' },
    { name: 'Kythorn', days: 30, abbr: 'Kyt' },
    { name: 'Flamerule', days: 30, abbr: 'Fla' },
    { name: 'Midsummer', days: 1, intercalary: true },
    { name: 'Eleasis', days: 30, abbr: 'Ele' },
    { name: 'Eleint', days: 30, abbr: 'Elt' },
    { name: 'Highharvestide', days: 1, intercalary: true },
    { name: 'Marpenoth', days: 30, abbr: 'Mar' },
    { name: 'Uktar', days: 30, abbr: 'Ukt' },
    { name: 'The Feast of the Moon', days: 1, intercalary: true },
    { name: 'Nightal', days: 30, abbr: 'Nig' },
  ],
  // Tendays, not weeks.
  weekdays: ['First', 'Second', 'Third', 'Fourth', 'Fifth',
    'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'],
  weekdayOffset: 0,
  // Shieldmeet follows Midsummer (month index 9) in leap years.
  leap: { every: 4, offset: 0, month: 9, extraDays: 1 },
  era: 'DR',
  yearLabel: 'suffix',
};

/* Golarion — Pathfinder. Twelve months, Gregorian-shaped lengths, its own
 * names and a 7-day week. */
export const GOLARION = {
  id: 'golarion',
  name: 'Absalom Reckoning',
  kind: 'custom',
  months: [
    { name: 'Abadius', days: 31 }, { name: 'Calistril', days: 28 },
    { name: 'Pharast', days: 31 }, { name: 'Gozran', days: 30 },
    { name: 'Desnus', days: 31 }, { name: 'Sarenith', days: 30 },
    { name: 'Erastus', days: 31 }, { name: 'Arodus', days: 31 },
    { name: 'Rova', days: 30 }, { name: 'Lamashan', days: 31 },
    { name: 'Neth', days: 30 }, { name: 'Kuthona', days: 31 },
  ],
  weekdays: ['Moonday', 'Toilday', 'Wealday', 'Oathday', 'Fireday', 'Starday', 'Sunday'],
  weekdayOffset: 0,
  leap: { every: 8, offset: 0, month: 1, extraDays: 1 },
  era: 'AR',
  yearLabel: 'suffix',
};

/* Eberron — twelve 28-day months, four 7-day weeks each, no leap year. The
 * tidiest calendar in fantasy. */
export const EBERRON = {
  id: 'eberron',
  name: 'Galifar Calendar',
  kind: 'custom',
  months: [
    { name: 'Zarantyr', days: 28 }, { name: 'Olarune', days: 28 },
    { name: 'Therendor', days: 28 }, { name: 'Eyre', days: 28 },
    { name: 'Dravago', days: 28 }, { name: 'Nymm', days: 28 },
    { name: 'Lharvion', days: 28 }, { name: 'Barrakas', days: 28 },
    { name: 'Rhaan', days: 28 }, { name: 'Sypheros', days: 28 },
    { name: 'Aryth', days: 28 }, { name: 'Vult', days: 28 },
  ],
  weekdays: ['Sul', 'Mol', 'Zol', 'Wir', 'Zor', 'Far', 'Sar'],
  weekdayOffset: 0,
  leap: null,
  era: 'YK',
  yearLabel: 'suffix',
};

/* A neutral starting point for homebrew: twelve 30-day months, plainly named,
 * meant to be renamed in the calendar editor. */
export const SIMPLE = {
  id: 'simple',
  name: 'Simple (12 × 30)',
  kind: 'custom',
  months: Array.from({ length: 12 }, (_, i) => ({ name: `Month ${i + 1}`, days: 30 })),
  weekdays: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh'],
  weekdayOffset: 0,
  leap: null,
  era: '',
  yearLabel: 'none',
};

export const PRESETS = [GREGORIAN, HARPTOS, GOLARION, EBERRON, SIMPLE];

export function presetById(id) {
  return PRESETS.find(p => p.id === id) || null;
}

// ── Gregorian core ───────────────────────────────────────────────────────────
// Howard Hinnant's days-from-civil. Exact for any year, including negatives,
// and it never touches the Date object — so no timezone can spoil a session.

function gregorianToDay({ y, m, d }) {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = floorDiv(yy, 400);
  const yoe = yy - era * 400;                                   // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;                           // 0 == 1970-01-01
}

function gregorianFromDay(n) {
  const z = n + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;                                 // [0, 146096]
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const yy = yoe + era * 400;
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: yy + (m <= 2 ? 1 : 0), m, d };
}

const isGregorianLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// ── Calendar ─────────────────────────────────────────────────────────────────

class Calendar {
  constructor(def) {
    this.def = normalizeDef(def);
    this.isGregorian = this.def.kind === 'gregorian';
    this.months = this.def.months;
    this.weekdays = this.def.weekdays || [];
    // Length of a common year, used for the year-boundary arithmetic below.
    this.commonYearDays = this.months.reduce((n, m) => n + m.days, 0);
  }

  get name() { return this.def.name; }

  /** Is `y` a leap year in this calendar? */
  isLeapYear(y) {
    if (this.isGregorian) return isGregorianLeap(y);
    const l = this.def.leap;
    if (!l || !l.every) return false;
    return mod(y - (l.offset || 0), l.every) === 0;
  }

  /** Days in month index `mi` (0-based) of year `y`. */
  daysInMonth(y, mi) {
    const month = this.months[mi];
    if (!month) return 0;
    if (this.isGregorian) {
      return mi === 1 && isGregorianLeap(y) ? 29 : month.days;
    }
    const l = this.def.leap;
    if (l && l.month === mi && this.isLeapYear(y)) return month.days + (l.extraDays || 1);
    return month.days;
  }

  daysInYear(y) {
    if (this.isGregorian) return isGregorianLeap(y) ? 366 : 365;
    return this.commonYearDays + (this.isLeapYear(y) ? (this.def.leap.extraDays || 1) : 0);
  }

  monthName(mi) {
    const m = this.months[mi];
    return m ? m.name : '';
  }

  isIntercalary(mi) {
    return !!(this.months[mi] && this.months[mi].intercalary);
  }

  /** Number of leap years in [0, y). Handles negative years, hence the
   *  difference of two floors rather than a single division. */
  #leapsBefore(y) {
    const l = this.def.leap;
    if (!l || !l.every) return 0;
    const off = l.offset || 0;
    const f = (n) => floorDiv(n - 1 - off, l.every);
    return f(y) - f(0);
  }

  #daysBeforeYear(y) {
    if (this.isGregorian) return gregorianToDay({ y, m: 1, d: 1 });
    const extra = this.def.leap ? this.#leapsBefore(y) * (this.def.leap.extraDays || 1) : 0;
    return y * this.commonYearDays + extra;
  }

  /** Date triple → day number. Out-of-range months and days are clamped, so
   *  hand-edited JSON can't produce a NaN that poisons the whole clock. */
  toDay(date) {
    const { y, m, d } = coerce(date);
    if (this.isGregorian) {
      const mi = Math.min(Math.max(m, 1), 12);
      return gregorianToDay({ y, m: mi, d: Math.min(Math.max(d, 1), this.daysInMonth(y, mi - 1)) });
    }
    const mi = Math.min(Math.max(m - 1, 0), this.months.length - 1);
    let n = this.#daysBeforeYear(y);
    for (let i = 0; i < mi; i++) n += this.daysInMonth(y, i);
    return n + Math.min(Math.max(d, 1), this.daysInMonth(y, mi)) - 1;
  }

  /** Day number → date triple. */
  fromDay(n) {
    n = Math.round(n);
    if (this.isGregorian) return gregorianFromDay(n);

    // Estimate the year, then walk — one or two steps at most, and correct even
    // when the leap rule makes years uneven.
    const avg = this.commonYearDays || 1;
    let y = floorDiv(n, avg);
    while (this.#daysBeforeYear(y) > n) y--;
    while (this.#daysBeforeYear(y + 1) <= n) y++;

    let rem = n - this.#daysBeforeYear(y);
    let mi = 0;
    while (mi < this.months.length - 1 && rem >= this.daysInMonth(y, mi)) {
      rem -= this.daysInMonth(y, mi);
      mi++;
    }
    return { y, m: mi + 1, d: rem + 1 };
  }

  /** "1925-05-01" → { y: 1925, m: 5, d: 1 }. Tolerates negative years. */
  parse(str) {
    if (str == null) return null;
    if (typeof str === 'object') return coerce(str);
    const match = String(str).trim().match(/^(-?\d+)-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    return { y: +match[1], m: +match[2], d: +match[3] };
  }

  /** Date string → day number, or null when unparseable. */
  dayOf(str) {
    const parsed = this.parse(str);
    return parsed ? this.toDay(parsed) : null;
  }

  /** Day number → "1925-05-01". Zero-padded so string sorting matches date
   *  ordering for any year the app is likely to see. */
  stringify(n) {
    const { y, m, d } = this.fromDay(n);
    const yy = (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
    return `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  weekdayOf(n) {
    if (!this.weekdays.length) return null;
    return this.weekdays[mod(n + (this.def.weekdayOffset || 0), this.weekdays.length)];
  }

  /** Human-readable date.
   *  'long'    → "1 May 1925" / "15 Hammer, 1491 DR" / "Midwinter, 1491 DR"
   *  'short'   → "1 May 1925" without the era
   *  'numeric' → "1925-05-01" */
  format(n, style = 'long') {
    if (style === 'numeric') return this.stringify(n);
    const { y, m, d } = this.fromDay(n);
    const mi = m - 1;
    const era = style === 'long' ? this.#eraSuffix() : '';

    if (this.isIntercalary(mi)) {
      const month = this.months[mi];
      // Multi-day festivals still need to say which day it is.
      const dayPart = this.daysInMonth(y, mi) > 1 ? `${ordinal(d)} day of ` : '';
      return `${dayPart}${month.name}, ${y}${era}`;
    }

    const name = this.monthName(mi);
    if (this.isGregorian) return `${d} ${name} ${y}`;
    return `${d} ${name}, ${y}${era}`;
  }

  #eraSuffix() {
    const { era, yearLabel } = this.def;
    if (!era || yearLabel === 'none') return '';
    return yearLabel === 'prefix' ? '' : ` ${era}`;
  }

  /** "3 days", "2 months", "1 year" — for countdowns, where an exact day count
   *  stops being useful past a few weeks. */
  describeGap(days) {
    const n = Math.abs(days);
    if (n === 0) return 'today';
    if (n === 1) return '1 day';
    if (n < this.commonYearDays / 6) return `${n} days`;
    const yearLen = this.daysInYear(0) || 365;
    if (n < yearLen) {
      const monthLen = yearLen / Math.max(this.months.filter(m => !m.intercalary).length, 1);
      const months = Math.round(n / monthLen);
      return months <= 1 ? `${n} days` : `${months} months`;
    }
    const years = Math.round((n / yearLen) * 10) / 10;
    return years === 1 ? '1 year' : `${years} years`;
  }

  /** Month options for a date picker, given the year (leap years change the
   *  day count of exactly one month). */
  monthOptions(y) {
    return this.months.map((m, i) => ({
      index: i,
      value: i + 1,
      name: m.name,
      days: this.daysInMonth(y, i),
      intercalary: !!m.intercalary,
    }));
  }
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function coerce(date) {
  if (!date) return { y: 0, m: 1, d: 1 };
  const y = Number.isFinite(date.y) ? Math.trunc(date.y) : 0;
  const m = Number.isFinite(date.m) ? Math.trunc(date.m) : 1;
  const d = Number.isFinite(date.d) ? Math.trunc(date.d) : 1;
  return { y, m, d };
}

/** Fill in the gaps in a hand-written calendar definition so the engine never
 *  has to guard against a missing field. */
export function normalizeDef(def) {
  if (!def) return { ...GREGORIAN };
  if (typeof def === 'string') return { ...(presetById(def) || GREGORIAN) };

  // A definition can name a preset and override parts of it.
  const base = def.preset ? presetById(def.preset) : null;
  const merged = base ? { ...base, ...def } : { ...def };

  if (merged.kind === 'gregorian') {
    return { ...GREGORIAN, ...merged, months: GREGORIAN_MONTHS, kind: 'gregorian' };
  }

  const months = (Array.isArray(merged.months) && merged.months.length
    ? merged.months
    : SIMPLE.months
  ).map(m => (typeof m === 'string'
    ? { name: m, days: 30 }
    : { name: m.name || 'Month', days: Math.max(1, Math.trunc(m.days) || 30), intercalary: !!m.intercalary, abbr: m.abbr }
  ));

  let leap = null;
  if (merged.leap && merged.leap.every > 0) {
    const monthIdx = Math.min(Math.max(Math.trunc(merged.leap.month) || 0, 0), months.length - 1);
    leap = {
      every: Math.trunc(merged.leap.every),
      offset: Math.trunc(merged.leap.offset) || 0,
      month: monthIdx,
      extraDays: Math.max(1, Math.trunc(merged.leap.extraDays) || 1),
    };
  }

  return {
    id: merged.id || 'custom',
    name: merged.name || 'Custom calendar',
    kind: 'custom',
    months,
    weekdays: Array.isArray(merged.weekdays) ? merged.weekdays.filter(Boolean) : [],
    weekdayOffset: Math.trunc(merged.weekdayOffset) || 0,
    leap,
    era: merged.era || '',
    yearLabel: merged.yearLabel || (merged.era ? 'suffix' : 'none'),
  };
}

export function createCalendar(def) {
  return new Calendar(def);
}

export { Calendar };
