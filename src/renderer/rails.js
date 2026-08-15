/* The right rail: four ways into the same campaign.
 *
 *   Places  the location tree
 *   People  everyone alive and placed on the current date
 *   Events  the timeline around now
 *   Notes   the markdown in the vault
 */

import { $, el, clear, toast } from './ui.js';
import {
  S, group, childrenOf, entitiesOn, rootLocationId,
  goTo, emit, on,
} from './store.js';

let filter = '';
let notes = [];

export function wireRails() {
  document.querySelectorAll('.rail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      S.activeRail = tab.dataset.rail;
      renderRail();
    });
  });

  const search = $('rail-filter');
  search.addEventListener('input', () => {
    filter = search.value.trim().toLowerCase();
    renderRailBody();
  });

  $('rail-add').addEventListener('click', () => {
    const what = { places: 'location', people: 'entity', events: 'event', notes: 'note' }[S.activeRail];
    emit('add', what);
  });

  on('render', renderRail);
  on('notes-changed', (list) => { notes = list; if (S.activeRail === 'notes') renderRailBody(); });
}

export function setNotes(list) {
  notes = list;
}

const matches = (text) => !filter || String(text || '').toLowerCase().includes(filter);

function renderRail() {
  document.querySelectorAll('.rail-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.rail === S.activeRail);
  });

  const labels = { places: 'place', people: 'person', events: 'event', notes: 'note' };
  $('rail-add').title = `Add a ${labels[S.activeRail] || 'thing'}`;
  renderRailBody();
}

function renderRailBody() {
  const body = clear($('rail-body'));
  if (S.activeRail === 'places') renderPlaces(body);
  else if (S.activeRail === 'people') renderPeople(body);
  else if (S.activeRail === 'events') renderEvents(body);
  else renderNotes(body);
}

// ── Places ───────────────────────────────────────────────────────────────────

function renderPlaces(body) {
  const root = rootLocationId();
  if (!root) {
    body.appendChild(el('div', 'lane-empty', 'No locations yet.'));
    return;
  }

  // When filtering, keep any branch that contains a match so the tree stays
  // navigable rather than collapsing to orphaned leaves.
  const keep = new Set();
  if (filter) {
    const mark = (location) => {
      let hit = matches(location.name) || matches(location.summary);
      for (const kid of childrenOf(location.id)) hit = mark(kid) || hit;
      if (hit) keep.add(location.id);
      return hit;
    };
    mark(S.locById.get(root));
  }

  const add = (location, depth) => {
    if (filter && !keep.has(location.id)) return;

    const item = el('button', 'rail-item' + (location.id === S.currentLoc ? ' active' : ''));
    item.style.paddingLeft = (12 + depth * 12) + 'px';

    const dot = el('span', 'rail-dot');
    dot.style.background = group(location.group).color;
    item.appendChild(dot);
    item.appendChild(el('span', 'rail-name', location.name));

    const kids = childrenOf(location.id);
    if (!location.map && kids.length) item.appendChild(el('span', 'sub', `${kids.length}`));
    else if (!location.map) item.appendChild(el('span', 'sub', '·'));

    item.addEventListener('click', () => goTo(location.id));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      emit('open-location', location.id);
    });
    body.appendChild(item);

    for (const kid of kids) add(kid, depth + 1);
  };

  add(S.locById.get(root), 0);
  if (!body.childElementCount) body.appendChild(el('div', 'lane-empty', 'Nothing matches.'));
}

// ── People ───────────────────────────────────────────────────────────────────

function renderPeople(body) {
  const active = entitiesOn(S.currentDay).filter(m => matches(m.name));
  const byGroup = new Map();

  for (const movement of active) {
    const key = movement.group || '';
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(movement);
  }

  const order = [...S.campaign.groups.map(g => g.id), ''];
  for (const groupId of order) {
    const list = byGroup.get(groupId);
    if (!list || !list.length) continue;

    body.appendChild(el('div', 'rail-group', groupId ? group(groupId).name : 'Ungrouped'));
    list.sort((a, b) => a.name.localeCompare(b.name));

    for (const movement of list) {
      const item = el('button', 'rail-item');
      const dot = el('span', 'rail-dot');
      dot.style.background = group(movement.group).color;
      item.appendChild(dot);
      item.appendChild(el('span', 'rail-name', movement.name));

      const where = S.locById.get(movement.location);
      if (where) {
        const chip = el('span', 'sub where', where.name);
        item.appendChild(chip);
      }

      item.addEventListener('click', () => emit('open-entity', movement.entity));
      body.appendChild(item);
    }
  }

  if (!body.childElementCount) {
    body.appendChild(el('div', 'lane-empty',
      filter ? 'Nobody matches.' : `Nobody is placed on ${S.cal.format(S.currentDay, 'long')}.`));
  }
}

// ── Events ───────────────────────────────────────────────────────────────────

function renderEvents(body) {
  const events = S.world.events
    .filter(event => matches(event.text) || matches(event.detail))
    .map(event => ({ event, day: S.cal.dayOf(event.date) }))
    .filter(entry => entry.day != null)
    .sort((a, b) => a.day - b.day);

  if (!events.length) {
    body.appendChild(el('div', 'lane-empty', filter ? 'Nothing matches.' : 'No events yet.'));
    return;
  }

  let lastYear = null;
  for (const { event, day } of events) {
    const year = S.cal.fromDay(day).y;
    if (year !== lastYear) {
      body.appendChild(el('div', 'rail-group', String(year)));
      lastYear = year;
    }

    const item = el('button', 'rail-item event' + (day === S.currentDay ? ' active' : ''));
    const dot = el('span', 'rail-dot');
    dot.style.background = event.track === 'party' ? '#d9a441' : group(null).color;
    item.appendChild(dot);
    item.appendChild(el('span', 'rail-name', event.text));
    item.appendChild(el('span', 'sub', S.cal.format(day, 'short').replace(/, \d+.*$/, '')));
    item.addEventListener('click', () => emit('open-event', event.id));
    body.appendChild(item);
  }
}

// ── Notes ────────────────────────────────────────────────────────────────────

function renderNotes(body) {
  const visible = notes.filter(matches);
  if (!visible.length) {
    body.appendChild(el('div', 'lane-empty',
      notes.length ? 'Nothing matches.' : 'No markdown notes in this campaign folder yet.'));
    return;
  }

  const folders = new Map();
  for (const file of visible) {
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    if (!folders.has(folder)) folders.set(folder, []);
    folders.get(folder).push(file);
  }

  for (const [folder, files] of [...folders].sort((a, b) => a[0].localeCompare(b[0]))) {
    body.appendChild(el('div', 'rail-group', folder || 'Top level'));
    for (const file of files.sort()) {
      const name = file.split('/').pop().replace(/\.md$/, '');
      const item = el('button', 'rail-item');
      item.appendChild(el('span', 'rail-name', name));
      item.addEventListener('click', () => emit('open-note', file));
      body.appendChild(item);
    }
  }
}

export async function refreshNotes() {
  try {
    notes = await window.api.notes.list();
    if (S.activeRail === 'notes') renderRailBody();
  } catch (err) {
    toast(err.message, 'error');
  }
}
