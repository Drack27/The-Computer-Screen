/* Renderer state, its derived indexes, and the writes back to disk.
 *
 * One mutable object rather than a framework: views read `S`, mutate through
 * the helpers here, and call `emit('render')`. Saves are debounced because a
 * clock drag can fire fifty times a second and none of those need a file write.
 */

import { createCalendar } from '../../shared/calendar.js';
import { uniqueId, randomId } from '../../shared/ids.js';

export const S = {
  // Documents
  campaign: null,
  entities: [],
  timeline: [],
  world: { movements: [], events: [], locationState: {}, revealed: {} },
  hotspots: {},
  appState: { notes: {}, positions: {}, pins: [] },
  problems: [],

  // Environment
  vaultPath: '',
  product: 'The Computer Screen',
  version: '',

  // Derived
  cal: null,
  locById: new Map(),
  childrenOf: new Map(),
  entityById: new Map(),
  groupById: new Map(),

  // View
  currentLoc: null,
  currentDay: 0,
  activeRail: 'places',
  editMode: false,
  ready: false,
};

// ── Event bus ────────────────────────────────────────────────────────────────

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) || []) {
    try {
      handler(payload);
    } catch (err) {
      console.error(`listener for "${event}" failed:`, err);
    }
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

export async function loadAll() {
  const loaded = await window.api.campaign.load();

  S.campaign = loaded.campaign;
  S.entities = loaded.entities || [];
  S.timeline = loaded.timeline || [];
  S.vaultPath = loaded.vaultPath;
  S.product = loaded.product || S.product;
  S.version = loaded.version || '';
  S.problems = loaded.problems || [];
  S.hotspots = loaded.hotspots || {};
  S.appState = loaded.state || { notes: {}, positions: {}, pins: [] };
  S.appState.positions = S.appState.positions || {};
  S.appState.notes = S.appState.notes || {};

  S.cal = createCalendar(S.campaign.calendar);

  reindex();
  applySavedPositions();

  S.world = loaded.world ? normalizeLoadedWorld(loaded.world) : seedWorld();

  // The clock starts where the campaign says, unless a previous session left a
  // bookmark inside the campaign's range.
  const remembered = S.appState.currentDate ? S.cal.dayOf(S.appState.currentDate) : null;
  const startDay = S.cal.dayOf(S.campaign.clock.start);
  const endDay = S.cal.dayOf(S.campaign.clock.end);
  const currentDay = S.cal.dayOf(S.campaign.clock.current);
  S.currentDay = clamp(remembered ?? currentDay, startDay, endDay);

  S.currentLoc = (S.appState.currentLoc && S.locById.has(S.appState.currentLoc))
    ? S.appState.currentLoc
    : rootLocationId();

  S.ready = true;
  return loaded;
}

function normalizeLoadedWorld(world) {
  return {
    movements: Array.isArray(world.movements) ? world.movements : [],
    events: Array.isArray(world.events) ? world.events : [],
    locationState: world.locationState || {},
    revealed: world.revealed || {},
  };
}

/** First run against a campaign: park every entity at its home (or its group's
 *  root location) for the whole span, and copy the authored timeline into play
 *  state where it becomes editable. */
function seedWorld() {
  const rootOfGroup = {};
  const root = rootLocationId();
  for (const location of S.campaign.locations) {
    if (location.parent === root && location.group && !rootOfGroup[location.group]) {
      rootOfGroup[location.group] = location.id;
    }
  }

  const movements = S.entities.map(entity => ({
    id: randomId('mv'),
    entity: entity.id,
    name: entity.name,
    kind: entity.kind,
    group: entity.group,
    location: (entity.home && S.locById.has(entity.home) ? entity.home : null)
      || rootOfGroup[entity.group]
      || root,
    from: S.campaign.clock.start,
    to: null,
    note: '',
  }));

  const world = {
    movements,
    events: S.timeline.map(event => ({ ...event })),
    locationState: {},
    revealed: {},
  };
  window.api.state.saveWorld(world).catch(() => {});
  return world;
}

export function reindex() {
  S.locById = new Map();
  S.childrenOf = new Map();
  for (const location of S.campaign.locations) {
    S.locById.set(location.id, location);
    if (!S.childrenOf.has(location.parent)) S.childrenOf.set(location.parent, []);
    S.childrenOf.get(location.parent).push(location);
  }
  S.entityById = new Map(S.entities.map(e => [e.id, e]));
  S.groupById = new Map(S.campaign.groups.map(g => [g.id, g]));
}

export function rootLocationId() {
  const root = S.campaign.locations.find(l => l.parent === null);
  return root ? root.id : (S.campaign.locations[0] ? S.campaign.locations[0].id : null);
}

/** Coordinates are edited constantly during prep, so they live in play state
 *  and are re-applied over the campaign file on load. */
function applySavedPositions() {
  for (const [id, pos] of Object.entries(S.appState.positions || {})) {
    const location = S.locById.get(id);
    if (location && Array.isArray(pos)) location.pos = pos;
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export function group(id) {
  return S.groupById.get(id) || { id: null, name: 'Ungrouped', color: '#8a8f98' };
}

export function ancestors(locId) {
  const chain = [];
  const seen = new Set();
  let current = S.locById.get(locId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parent ? S.locById.get(current.parent) : null;
  }
  return chain;
}

export function childrenOf(locId) {
  return S.childrenOf.get(locId) || [];
}

/** Every location inside `locId`, itself included. */
export function descendants(locId) {
  const out = [];
  const walk = (id) => {
    out.push(id);
    for (const child of childrenOf(id)) walk(child.id);
  };
  walk(locId);
  return out;
}

export function movementActive(movement, day) {
  const from = S.cal.dayOf(movement.from);
  const to = movement.to == null ? Infinity : S.cal.dayOf(movement.to);
  return from != null && day >= from && day <= to;
}

/** Where everyone is on `day` — the latest movement wins, so someone who moves
 *  stays moved. */
export function entitiesOn(day) {
  const latest = new Map();
  for (const movement of S.world.movements) {
    if (!movementActive(movement, day)) continue;
    const previous = latest.get(movement.entity);
    if (!previous || S.cal.dayOf(movement.from) >= S.cal.dayOf(previous.from)) {
      latest.set(movement.entity, movement);
    }
  }
  return [...latest.values()];
}

/** Which direct child of `rootId` contains `locId`? Returns `rootId`'s own
 *  location when the entity stands on this very map, or null if unrelated. */
export function resolveToChild(locId, rootId) {
  let current = S.locById.get(locId);
  if (!current) return null;
  if (current.id === rootId) return current;
  const seen = new Set();
  while (current && current.parent && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parent === rootId) return current;
    current = S.locById.get(current.parent);
  }
  return null;
}

export function eventsNear(day, window = 21) {
  const near = [];
  for (const event of S.world.events) {
    const eventDay = S.cal.dayOf(event.date);
    if (eventDay == null) continue;
    const gap = Math.abs(eventDay - day);
    if (gap <= window) near.push({ event, day: eventDay, gap });
  }
  near.sort((a, b) => a.gap - b.gap || a.day - b.day);
  return near;
}

/** The next deadline at or after `day`, for the countdown under the clock. */
export function nextMark(day) {
  const marks = S.campaign.clock.marks || [];
  let upcoming = null;
  let passed = null;
  for (const mark of marks) {
    const markDay = S.cal.dayOf(mark.date);
    if (markDay == null) continue;
    if (markDay >= day) {
      if (!upcoming || markDay < upcoming.day) upcoming = { mark, day: markDay };
    } else if (!passed || markDay > passed.day) {
      passed = { mark, day: markDay };
    }
  }
  return upcoming || passed;
}

// ── Saving ───────────────────────────────────────────────────────────────────

const timers = new Map();

function debounce(key, fn, ms = 350) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    Promise.resolve(fn()).catch(err => emit('error', err));
  }, ms));
}

/** Flush every pending write — called before the window closes. */
export async function flushSaves() {
  const pending = [...timers.keys()];
  for (const key of pending) {
    clearTimeout(timers.get(key));
    timers.delete(key);
  }
  await Promise.all(pending.map(key => saveNow[key] && saveNow[key]()));
}

const saveNow = {
  campaign: () => window.api.campaign.save(S.campaign),
  entities: () => window.api.entities.save(S.entities),
  timeline: () => window.api.timeline.save(S.timeline),
  world: () => window.api.state.saveWorld(S.world),
  hotspots: () => window.api.state.saveHotspots(S.hotspots),
  state: () => window.api.state.save(S.appState),
};

export const save = {
  campaign: () => debounce('campaign', saveNow.campaign),
  entities: () => debounce('entities', saveNow.entities),
  timeline: () => debounce('timeline', saveNow.timeline),
  world: () => debounce('world', saveNow.world),
  hotspots: () => debounce('hotspots', saveNow.hotspots),
  state: () => debounce('state', saveNow.state, 700),
};

// ── Mutations ────────────────────────────────────────────────────────────────
// Each one keeps the indexes and the disk in step, so views never have to.

export function setDay(day) {
  const startDay = S.cal.dayOf(S.campaign.clock.start);
  const endDay = S.cal.dayOf(S.campaign.clock.end);
  S.currentDay = clamp(Math.round(day), startDay, endDay);
  S.appState.currentDate = S.cal.stringify(S.currentDay);
  save.state();
  emit('render');
}

export function goTo(locId) {
  if (!S.locById.has(locId)) return;
  S.currentLoc = locId;
  S.editMode = false;
  S.appState.currentLoc = locId;
  save.state();
  emit('render');
}

export function takenLocationIds() {
  return new Set(S.campaign.locations.map(l => l.id));
}

export function addLocation({ name, parent, group = null, map = null, summary = '' }) {
  const location = {
    id: uniqueId(name, takenLocationIds(), 'location'),
    name,
    parent: parent ?? rootLocationId(),
    group,
    map,
    pos: null,
    summary,
    source: null,
    tags: [],
    hidden: false,
  };
  S.campaign.locations.push(location);
  reindex();
  save.campaign();
  return location;
}

export function updateLocation(id, patch) {
  const location = S.locById.get(id);
  if (!location) return null;

  // Reparenting into your own subtree would orphan the branch from the root.
  if (patch.parent !== undefined && patch.parent !== location.parent) {
    if (patch.parent === id || descendants(id).includes(patch.parent)) {
      throw new Error(`${location.name} can't be moved inside itself.`);
    }
    if (location.parent === null) throw new Error('The root location has to stay at the top.');
  }

  Object.assign(location, patch);
  if (patch.pos !== undefined) {
    S.appState.positions[id] = patch.pos;
    save.state();
  }
  reindex();
  save.campaign();
  return location;
}

export function removeLocation(id) {
  const location = S.locById.get(id);
  if (!location) return false;
  if (location.parent === null) throw new Error('The root location can\'t be deleted.');

  const doomed = new Set(descendants(id));
  S.campaign.locations = S.campaign.locations.filter(l => !doomed.has(l.id));

  // Anything that pointed here now points at the deleted place's parent.
  for (const movement of S.world.movements) {
    if (doomed.has(movement.location)) movement.location = location.parent;
  }
  for (const event of S.world.events) {
    if (doomed.has(event.location)) event.location = null;
  }
  for (const entity of S.entities) {
    if (doomed.has(entity.home)) entity.home = null;
  }
  for (const key of doomed) {
    delete S.hotspots[key];
    delete S.appState.positions[key];
  }
  for (const [parentId, boxes] of Object.entries(S.hotspots)) {
    S.hotspots[parentId] = boxes.filter(box => !doomed.has(box.target));
  }

  reindex();
  save.campaign();
  save.world();
  save.entities();
  save.hotspots();
  save.state();
  if (doomed.has(S.currentLoc)) goTo(location.parent);
  return true;
}

export function addEntity(fields) {
  const taken = new Set(S.entities.map(e => e.id));
  const entity = {
    id: uniqueId(fields.name, taken, 'entity'),
    name: fields.name,
    kind: fields.kind || 'npc',
    group: fields.group || null,
    role: fields.role || '',
    age: fields.age || '',
    summary: fields.summary || '',
    description: fields.description || '',
    traits: fields.traits || '',
    hooks: fields.hooks || '',
    stats: fields.stats || '',
    home: fields.home || null,
    portrait: null,
    links: [],
    prose: [],
    tags: [],
    source: null,
    hidden: false,
  };
  S.entities.push(entity);
  reindex();
  save.entities();

  // A person with nowhere to be never shows up on a map, so give every new
  // entity a movement covering the whole campaign.
  if (entity.home) {
    addMovement({ entity: entity.id, location: entity.home, from: S.campaign.clock.start, to: null });
  }
  return entity;
}

export function updateEntity(id, patch) {
  const entity = S.entityById.get(id);
  if (!entity) return null;
  Object.assign(entity, patch);
  // Movements carry a denormalized name and colour for fast blip drawing.
  for (const movement of S.world.movements) {
    if (movement.entity === id) {
      movement.name = entity.name;
      movement.group = entity.group;
      movement.kind = entity.kind;
    }
  }
  reindex();
  save.entities();
  save.world();
  return entity;
}

export function removeEntity(id) {
  S.entities = S.entities.filter(e => e.id !== id);
  S.world.movements = S.world.movements.filter(m => m.entity !== id);
  for (const event of S.world.events) {
    if (Array.isArray(event.entities)) event.entities = event.entities.filter(e => e !== id);
  }
  reindex();
  save.entities();
  save.world();
  return true;
}

export function addMovement({ entity, location, from, to = null, note = '' }) {
  const known = S.entityById.get(entity);
  const movement = {
    id: randomId('mv'),
    entity,
    name: known ? known.name : entity,
    kind: known ? known.kind : 'npc',
    group: known ? known.group : null,
    location,
    from: from || S.campaign.clock.start,
    to,
    note,
  };
  S.world.movements.push(movement);
  save.world();
  return movement;
}

export function updateMovement(id, patch) {
  const movement = S.world.movements.find(m => m.id === id);
  if (!movement) return null;
  Object.assign(movement, patch);
  save.world();
  return movement;
}

export function removeMovement(id) {
  S.world.movements = S.world.movements.filter(m => m.id !== id);
  save.world();
  return true;
}

export function addEvent(fields) {
  const taken = new Set(S.world.events.map(e => e.id));
  const event = {
    id: uniqueId(fields.text || 'event', taken, 'event'),
    date: fields.date,
    text: fields.text,
    detail: fields.detail || '',
    track: fields.track || 'world',
    location: fields.location || null,
    entities: fields.entities || [],
    source: null,
    hidden: false,
  };
  S.world.events.push(event);
  save.world();
  return event;
}

export function updateEvent(id, patch) {
  const event = S.world.events.find(e => e.id === id);
  if (!event) return null;
  Object.assign(event, patch);
  save.world();
  return event;
}

export function removeEvent(id) {
  S.world.events = S.world.events.filter(e => e.id !== id);
  save.world();
  return true;
}

export function addGroup({ name, color }) {
  const taken = new Set(S.campaign.groups.map(g => g.id));
  const group = { id: uniqueId(name, taken, 'group'), name, color, summary: '', hidden: false };
  S.campaign.groups.push(group);
  reindex();
  save.campaign();
  return group;
}

export function updateCampaign(patch) {
  Object.assign(S.campaign, patch);
  if (patch.calendar) S.cal = createCalendar(S.campaign.calendar);
  save.campaign();
  emit('render');
  return S.campaign;
}
