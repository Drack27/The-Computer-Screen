/* The calendar engine — the piece everything else counts on. */

import { suite, check, assert, equal } from './harness.js';
import {
  createCalendar, GREGORIAN, HARPTOS, GOLARION, EBERRON, SIMPLE, normalizeDef,
} from '../shared/calendar.js';

export default function runCalendar() {
  suite('calendar · gregorian');

  const gregorian = createCalendar(GREGORIAN);

  check('matches the civil calendar', () => {
    // Day 0 is 1970-01-01 by construction; compare against UTC arithmetic for
    // dates the Date object handles honestly (it remaps years 0-99).
    const dates = [[1970, 1, 1], [1925, 5, 1], [1900, 3, 1], [2000, 2, 29], [1899, 12, 31], [2026, 8, 15]];
    for (const [y, m, d] of dates) {
      const mine = gregorian.toDay({ y, m, d });
      const theirs = Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1970, 0, 1)) / 86400000);
      equal(mine, theirs, `${y}-${m}-${d}`);
    }
    return `${dates.length} dates`;
  });

  check('round-trips proleptic years', () => {
    // 0001-01-01 proleptic Gregorian is 719162 days before the epoch.
    equal(gregorian.toDay({ y: 1, m: 1, d: 1 }), -719162, 'year 1');
    for (const day of [-719162, -25567, 0, 11016, 20680]) {
      equal(gregorian.toDay(gregorian.fromDay(day)), day, `day ${day}`);
    }
    return 'exact';
  });

  check('knows its leap years', () => {
    equal(gregorian.daysInYear(1900), 365, '1900');
    equal(gregorian.daysInYear(2000), 366, '2000');
    equal(gregorian.daysInMonth(2024, 1), 29, 'February 2024');
    equal(gregorian.daysInMonth(2023, 1), 28, 'February 2023');
    return 'century rules hold';
  });

  check('names the weekday', () => {
    equal(gregorian.weekdayOf(gregorian.toDay({ y: 2026, m: 8, d: 15 })), 'Saturday');
    return 'Saturday';
  });

  check('formats and parses', () => {
    const day = gregorian.dayOf('1925-05-01');
    equal(gregorian.format(day, 'long'), '1 May 1925');
    equal(gregorian.stringify(day), '1925-05-01');
    assert(gregorian.parse('nonsense') === null, 'nonsense should not parse');
    return '1 May 1925';
  });

  suite('calendar · harptos');

  const harptos = createCalendar(HARPTOS);

  check('365 days, 366 on Shieldmeet years', () => {
    equal(harptos.daysInYear(1491), 365, 'common year');
    equal(harptos.daysInYear(1492), 366, 'leap year');
    equal(harptos.daysInMonth(1492, 9), 2, 'Midsummer in a Shieldmeet year');
    equal(harptos.daysInMonth(1491, 9), 1, 'Midsummer otherwise');
    return '365 / 366';
  });

  check('every day of every year round-trips', () => {
    let days = 0;
    for (const year of [1490, 1491, 1492, 1493, 0, -5]) {
      const start = harptos.toDay({ y: year, m: 1, d: 1 });
      const length = harptos.daysInYear(year);
      for (let offset = 0; offset < length; offset++) {
        const date = harptos.fromDay(start + offset);
        equal(harptos.toDay(date), start + offset, `year ${year} day ${offset}`);
        days++;
      }
      equal(harptos.toDay({ y: year + 1, m: 1, d: 1 }) - start, length, `length of ${year}`);
    }
    return `${days} days across 6 years`;
  });

  check('festivals read as festivals', () => {
    equal(harptos.format(harptos.dayOf('1491-02-01'), 'long'), 'Midwinter, 1491 DR');
    equal(harptos.format(harptos.dayOf('1492-10-02'), 'long'), '2nd day of Midsummer, 1492 DR');
    equal(harptos.format(harptos.dayOf('1491-01-15'), 'long'), '15 Hammer, 1491 DR');
    return 'Midwinter, 1491 DR';
  });

  check('tendays instead of weeks', () => {
    equal(harptos.weekdays.length, 10, 'ten weekday names');
    const first = harptos.dayOf('1491-01-01');
    equal(harptos.weekdayOf(first), harptos.weekdayOf(first + 10), 'repeats every ten days');
    return '10-day cycle';
  });

  check('out-of-range days clamp instead of exploding', () => {
    // Hammer has 30 days; asking for the 31st should not produce a NaN.
    const day = harptos.dayOf('1491-01-31');
    assert(Number.isFinite(day), 'day number should be finite');
    equal(harptos.stringify(day), '1491-01-30');
    return 'clamped';
  });

  suite('calendar · others');

  check('golarion leaps every eighth year', () => {
    const golarion = createCalendar(GOLARION);
    equal(golarion.daysInYear(4721), 365, 'common');
    equal(golarion.daysInYear(4720), 366, 'leap');
    return '365 / 366';
  });

  check('eberron is 336 days with no leap', () => {
    const eberron = createCalendar(EBERRON);
    equal(eberron.daysInYear(998), 336);
    equal(eberron.daysInYear(999), 336);
    return '12 × 28';
  });

  check('a homebrew definition survives normalization', () => {
    const wonky = normalizeDef({
      kind: 'custom',
      name: 'Two Moons',
      months: ['Rise', { name: 'Fall', days: 45 }, { name: 'Long Night', days: 3, intercalary: true }],
      leap: { every: 3, month: 99, extraDays: 2 },
      era: 'TM',
    });
    const calendar = createCalendar(wonky);
    equal(calendar.months.length, 3, 'three months');
    equal(calendar.months[0].days, 30, 'bare string month defaults to 30 days');
    equal(wonky.leap.month, 2, 'out-of-range leap month clamped into the list');
    equal(calendar.daysInYear(3), 30 + 45 + 3 + 2, 'leap year length');
    equal(calendar.daysInYear(4), 78, 'common year length');
    const day = calendar.dayOf('12-02-40');
    equal(calendar.stringify(day), '0012-02-40');
    return calendar.format(day, 'long');
  });

  check('a nonsense definition falls back rather than throwing', () => {
    const calendar = createCalendar(normalizeDef({ kind: 'custom', months: [] }));
    equal(calendar.months.length, SIMPLE.months.length, 'falls back to the simple calendar');
    assert(Number.isFinite(calendar.dayOf('1-1-1')), 'still produces day numbers');
    return 'fell back to 12 × 30';
  });
}
