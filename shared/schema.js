/* The campaign document.
 *
 * One job: take whatever JSON is in the vault — hand-written, migrated from the
 * Masks-era layout, or written by this app last Tuesday — and turn it into one
 * predictable shape. Everything downstream may then assume its fields exist.
 *
 * Migration is one-way and in-memory. Nothing is rewritten on disk until the
 * user actually edits something, so opening an old vault read-only leaves it
 * exactly as it was.
 */

import { normalizeDef, GREGORIAN, createCalendar } from './calendar.js';
import { slugify, uniqueId, randomId } from './ids.js';

export const SCHEMA_VERSION = 2;

export const ENTITY_KINDS = ['npc', 'pc', 'faction', 'creature', 'item', 'place-marker'];

/** Fallback palette for groups that arrive without a colour. Distinct hues that
 *  survive being shrunk to a 9px map blip. */
const PALETTE = [
  '#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d68910',
  '#16a085', '#c2185b', '#5d6d7e', '#7f8c8d', '#af601a',
];

const str = (v, fallback = '') => (typeof v === 'string' ? v : v == null ? fallback : String(v));
const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (Number.isFinite(v) ? v : Number.isFinite(+v) ? +v : null);

// ── Source references ────────────────────────────────────────────────────────
// v1 wrote `"page": 214` and assumed the single PDF named in campaign.pdf.
// v2 allows several books, so a reference is { source, page }.

function normalizeSourceRef(raw, defaultSourceId) {
  if (raw == null) return null;
  if (typeof raw === 'number' || /^\d+$/.test(String(raw))) {
    return defaultSourceId ? { source: defaultSourceId, page: +raw } : null;
  }
  if (typeof raw === 'object') {
    const page = num(raw.page);
    const source = str(raw.source || raw.id || defaultSourceId) || defaultSourceId;
    if (!source) return null;
    return page == null ? { source } : { source, page };
  }
  return null;
}

function normalizeSources(raw, legacyPdfPath, campaignTitle) {
  const out = [];
  const seen = new Set();

  for (const s of arr(raw)) {
    const id = uniqueId(s.id || s.title || 'source', seen, 'source');
    seen.add(id);
    out.push({
      id,
      title: str(s.title, id),
      path: str(s.path),
      kind: str(s.kind) || guessKind(s.path),
    });
  }

  // v1's single `campaign.pdf` becomes the default source, keeping every bare
  // page number in the old data meaningful.
  if (legacyPdfPath && !out.some(s => s.path === legacyPdfPath)) {
    const id = uniqueId('book', seen, 'book');
    seen.add(id);
    out.unshift({ id, title: campaignTitle || 'Rulebook', path: legacyPdfPath, kind: 'pdf' });
  }
  return out;
}

function guessKind(path) {
  const p = str(path).toLowerCase();
  if (p.endsWith('.pdf')) return 'pdf';
  if (p.endsWith('.md') || p.endsWith('.txt')) return 'text';
  if (p.endsWith('.epub')) return 'epub';
  return 'other';
}

// ── Groups (were "chapters") ─────────────────────────────────────────────────

function normalizeGroups(raw) {
  const seen = new Set();
  const out = arr(raw).map((g, i) => {
    const source = typeof g === 'string' ? { name: g } : g;
    const id = uniqueId(source.id || source.name || `group-${i + 1}`, seen, 'group');
    seen.add(id);
    return {
      id,
      name: str(source.name, id),
      color: str(source.color) || PALETTE[i % PALETTE.length],
      summary: str(source.summary || source.description),
      hidden: !!source.hidden,
    };
  });
  return out;
}

// ── Locations ────────────────────────────────────────────────────────────────

function normalizeLocations(raw, defaultSourceId, groupIds) {
  const seen = new Set();
  const out = [];

  for (const l of arr(raw)) {
    if (!l || typeof l !== 'object') continue;
    const id = uniqueId(l.id || l.name, seen, 'location');
    seen.add(id);
    out.push({
      id,
      name: str(l.name, id),
      parent: l.parent == null || l.parent === '' ? null : str(l.parent),
      group: pickGroup(l.group ?? l.chapter, groupIds),
      map: str(l.map) || null,
      pos: normalizePos(l.pos),
      summary: str(l.summary || l.description),
      source: normalizeSourceRef(l.source ?? l.page, defaultSourceId),
      tags: arr(l.tags).map(t => str(t)).filter(Boolean),
      hidden: !!l.hidden,
    });
  }

  return repairTree(out);
}

function normalizePos(pos) {
  if (!Array.isArray(pos) || pos.length < 2) return null;
  const x = num(pos[0]);
  const y = num(pos[1]);
  if (x == null || y == null) return null;
  return [clamp(x, 0, 100), clamp(y, 0, 100)];
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function pickGroup(value, groupIds) {
  const v = str(value);
  if (v && groupIds.has(v)) return v;
  return v || null;
}

/** A location tree with a dangling parent or a cycle would hang the renderer
 *  when it walks upward, so fix both here rather than defending everywhere. */
function repairTree(locations) {
  const byId = new Map(locations.map(l => [l.id, l]));
  let root = locations.find(l => l.parent === null) || null;

  // Parents that don't exist get reattached to the root.
  for (const l of locations) {
    if (l.parent !== null && !byId.has(l.parent)) l.parent = root ? root.id : null;
  }

  if (!root && locations.length) {
    root = locations[0];
    root.parent = null;
  }

  // Break cycles by reparenting the first node that loops back on itself.
  for (const l of locations) {
    const path = new Set([l.id]);
    let cur = l;
    while (cur && cur.parent !== null) {
      if (path.has(cur.parent)) { cur.parent = root && root.id !== cur.id ? root.id : null; break; }
      path.add(cur.parent);
      cur = byId.get(cur.parent);
    }
  }

  return locations;
}

// ── Clock ────────────────────────────────────────────────────────────────────

function normalizeClock(raw, calendar) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const cal = createCalendar(calendar);

  const fallbackStart = cal.stringify(cal.isGregorian ? cal.toDay({ y: 1925, m: 1, d: 1 }) : cal.toDay({ y: 1, m: 1, d: 1 }));
  const start = validDate(c.start, cal) || fallbackStart;

  // A campaign with no declared end still needs a slider that goes somewhere.
  let end = validDate(c.end, cal);
  if (!end || cal.dayOf(end) <= cal.dayOf(start)) {
    end = cal.stringify(cal.dayOf(start) + Math.max(cal.daysInYear(cal.fromDay(cal.dayOf(start)).y), 60));
  }

  let current = validDate(c.current, cal) || start;
  if (cal.dayOf(current) < cal.dayOf(start)) current = start;
  if (cal.dayOf(current) > cal.dayOf(end)) current = end;

  const marks = arr(c.marks)
    .map(m => {
      const date = validDate(m && m.date, cal);
      if (!date) return null;
      return {
        id: str(m.id) || randomId('mark'),
        date,
        label: str(m.label, 'Deadline'),
        kind: str(m.kind) || 'deadline',
        color: str(m.color) || null,
      };
    })
    .filter(Boolean);

  // v1 kept a single doomsday on the clock. Promote it to a mark so the UI has
  // one concept, but keep the fields so an old vault re-read still validates.
  const doom = validDate(c.doomsday, cal);
  if (doom && !marks.some(m => m.date === doom)) {
    marks.push({
      id: 'doomsday',
      date: doom,
      label: str(c.doomsdayLabel, 'the end'),
      kind: 'doom',
      color: '#c0392b',
    });
  }

  marks.sort((a, b) => cal.dayOf(a.date) - cal.dayOf(b.date));
  return { start, end, current, marks };
}

function validDate(value, cal) {
  const parsed = cal.parse(value);
  return parsed ? cal.stringify(cal.toDay(parsed)) : null;
}

// ── Campaign ─────────────────────────────────────────────────────────────────

export function normalizeCampaign(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const title = str(c.title, 'Untitled Campaign');

  const calendar = normalizeDef(c.calendar || GREGORIAN);
  const sources = normalizeSources(c.sources, str(c.pdf) || null, title);
  const defaultSourceId = sources.length ? sources[0].id : null;

  const groups = normalizeGroups(c.groups || c.chapters);
  const groupIds = new Set(groups.map(g => g.id));

  const locations = normalizeLocations(c.locations, defaultSourceId, groupIds);

  // Any group referenced by a location but never declared still needs a colour.
  for (const l of locations) {
    if (l.group && !groupIds.has(l.group)) {
      groups.push({
        id: l.group,
        name: l.group.replace(/-/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()),
        color: PALETTE[groups.length % PALETTE.length],
        summary: '',
        hidden: false,
      });
      groupIds.add(l.group);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    subtitle: str(c.subtitle),
    system: str(c.system),
    author: str(c.author),
    calendar,
    clock: normalizeClock(c.clock, calendar),
    groups,
    locations,
    sources,
    settings: {
      mapRoot: str(c.settings && c.settings.mapRoot) || 'Maps',
      noteRoot: str(c.settings && c.settings.noteRoot) || '',
      ...(c.settings && typeof c.settings === 'object' ? stripKnown(c.settings) : {}),
    },
  };
}

function stripKnown(settings) {
  const { mapRoot, noteRoot, ...rest } = settings;
  return rest;
}

// ── Entities (were Data/npcs.json) ───────────────────────────────────────────

export function normalizeEntities(raw, campaign) {
  const groupIds = new Set(campaign.groups.map(g => g.id));
  const defaultSourceId = campaign.sources.length ? campaign.sources[0].id : null;
  const seen = new Set();

  // Accept both a bare array and { entities: [...] }.
  const list = Array.isArray(raw) ? raw : arr(raw && raw.entities);

  return list.map(e => {
    if (!e || typeof e !== 'object') return null;
    const id = uniqueId(e.id || e.name, seen, 'entity');
    seen.add(id);
    const kind = ENTITY_KINDS.includes(str(e.kind)) ? str(e.kind) : 'npc';
    return {
      id,
      name: str(e.name, id),
      kind,
      group: pickGroup(e.group ?? e.chapter, groupIds),
      role: str(e.role || e.occupation),
      age: str(e.age),
      summary: str(e.summary),
      description: str(e.description),
      traits: str(e.traits),
      hooks: str(e.hooks),
      stats: str(e.stats),
      home: str(e.home || e.location) || null,
      portrait: str(e.portrait) || null,
      links: arr(e.links).map(l => (typeof l === 'string'
        ? { text: l, target: null }
        : { text: str(l.text || l.name), target: str(l.target) || null })).filter(l => l.text),
      prose: arr(e.prose).map(p => str(p)).filter(Boolean),
      tags: arr(e.tags).map(t => str(t)).filter(Boolean),
      source: normalizeSourceRef(e.source ?? e.page, defaultSourceId),
      hidden: !!e.hidden,
    };
  }).filter(Boolean);
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export function normalizeTimeline(raw, campaign) {
  const cal = createCalendar(campaign.calendar);
  const defaultSourceId = campaign.sources.length ? campaign.sources[0].id : null;
  const seen = new Set();
  const list = Array.isArray(raw) ? raw : arr(raw && raw.events);

  return list.map((t, i) => {
    if (!t || typeof t !== 'object') return null;
    const date = validDate(t.date, cal);
    if (!date) return null;
    const id = uniqueId(t.id || `event-${i + 1}`, seen, 'event');
    seen.add(id);
    return {
      id,
      date,
      text: str(t.text || t.title, 'Untitled event'),
      detail: str(t.detail || t.description),
      track: str(t.track) || 'world',
      location: str(t.location) || null,
      entities: arr(t.entities).map(x => str(x)).filter(Boolean),
      source: normalizeSourceRef(t.source ?? t.page, defaultSourceId),
      hidden: !!t.hidden,
    };
  }).filter(Boolean);
}

// ── Play state (world.json) ──────────────────────────────────────────────────

export function normalizeWorld(raw, campaign, entities) {
  const cal = createCalendar(campaign.calendar);
  const locIds = new Set(campaign.locations.map(l => l.id));
  const entityById = new Map(entities.map(e => [e.id, e]));
  const w = raw && typeof raw === 'object' ? raw : {};

  const movements = arr(w.movements).map(m => {
    if (!m || typeof m !== 'object') return null;
    const entity = str(m.entity);
    if (!entity) return null;
    const from = validDate(m.from, cal) || campaign.clock.start;
    const to = m.to == null ? null : validDate(m.to, cal);
    const known = entityById.get(entity);
    return {
      id: str(m.id) || randomId('mv'),
      entity,
      name: str(m.name) || (known ? known.name : entity),
      kind: str(m.kind) || (known ? known.kind : 'npc'),
      group: str(m.group ?? m.chapter) || (known ? known.group : null),
      location: locIds.has(str(m.location)) ? str(m.location) : (campaign.locations[0]?.id ?? null),
      from,
      to,
      note: str(m.note),
    };
  }).filter(m => m && m.location);

  const events = normalizeTimeline(arr(w.events), campaign);

  return {
    movements,
    events,
    locationState: (w.locationState && typeof w.locationState === 'object') ? w.locationState : {},
    revealed: (w.revealed && typeof w.revealed === 'object') ? w.revealed : {},
  };
}

// ── Blank campaign ───────────────────────────────────────────────────────────

/** A brand-new campaign that opens to something usable rather than an error. */
export function blankCampaign({ title = 'New Campaign', system = '', calendar = GREGORIAN, start = null } = {}) {
  const cal = createCalendar(calendar);
  const startDate = start || cal.stringify(cal.isGregorian
    ? cal.toDay({ y: new Date().getUTCFullYear(), m: 1, d: 1 })
    : cal.toDay({ y: 1, m: 1, d: 1 }));
  const startDay = cal.dayOf(startDate);

  return {
    schemaVersion: SCHEMA_VERSION,
    title,
    subtitle: '',
    system,
    author: '',
    calendar: normalizeDef(calendar),
    clock: {
      start: startDate,
      end: cal.stringify(startDay + cal.daysInYear(cal.fromDay(startDay).y)),
      current: startDate,
      marks: [],
    },
    groups: [
      { id: 'main', name: 'Main thread', color: PALETTE[0], summary: '', hidden: false },
    ],
    locations: [
      { id: 'world', name: title, parent: null, group: 'main', map: null, pos: null,
        summary: 'The top of your map stack. Give it a map image, then nest places inside it.',
        source: null, tags: [], hidden: false },
    ],
    sources: [],
    settings: { mapRoot: 'Maps', noteRoot: '' },
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Non-fatal problems worth showing the GM in a health panel. Normalization has
 *  already fixed anything that would actually crash. */
export function validateCampaign(campaign, { entities = [], world = null } = {}) {
  const problems = [];
  const locIds = new Set(campaign.locations.map(l => l.id));
  const entityIds = new Set(entities.map(e => e.id));
  const cal = createCalendar(campaign.calendar);

  if (!campaign.locations.length) {
    problems.push({ level: 'error', message: 'No locations — add at least one place to hang the map on.' });
  }
  if (campaign.locations.filter(l => l.parent === null).length > 1) {
    problems.push({ level: 'warn', message: 'More than one root location; only the first is used as the top of the map stack.' });
  }

  for (const l of campaign.locations) {
    if (l.source && l.source.source && !campaign.sources.some(s => s.id === l.source.source)) {
      problems.push({ level: 'warn', message: `Location "${l.name}" cites a source that isn't listed.`, ref: l.id });
    }
  }

  for (const e of entities) {
    if (e.home && !locIds.has(e.home)) {
      problems.push({ level: 'warn', message: `${e.name} lists a home location that doesn't exist.`, ref: e.id });
    }
  }

  if (world) {
    for (const m of world.movements) {
      if (!entityIds.has(m.entity)) {
        problems.push({ level: 'warn', message: `A movement references the unknown entity "${m.entity}".`, ref: m.id });
      }
      if (m.to && cal.dayOf(m.to) < cal.dayOf(m.from)) {
        problems.push({ level: 'warn', message: `${m.name}'s movement ends before it begins.`, ref: m.id });
      }
    }
  }

  return problems;
}

export { slugify, uniqueId, randomId };
