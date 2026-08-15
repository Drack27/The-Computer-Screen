/* The centre stage: a map you drill down through, with everyone alive on the
 * current date drawn on top of it.
 *
 * Blips are the reason the clock matters. Every entity has a location and a
 * date range; on any given map we ask each of them "is your location somewhere
 * inside this one?" and, if so, walk up the tree until we find the direct child
 * to draw the dot on. One piece of data, a dot on every map that contains it.
 */

import { $, el, clear, toast, formDialog, confirmDialog } from './ui.js';
import {
  S, group, ancestors, childrenOf, entitiesOn, resolveToChild,
  goTo, updateLocation, addLocation, save, emit, on,
} from './store.js';

let drag = null;

export function wireAtlas() {
  wireStageDrag();
  on('render', renderStage);
}

// ── Breadcrumb and tools ─────────────────────────────────────────────────────

function renderBreadcrumb() {
  const bar = clear($('breadcrumb'));
  const chain = ancestors(S.currentLoc);

  chain.forEach((location, index) => {
    if (index) bar.appendChild(el('span', 'crumb-sep', '›'));
    const isLast = index === chain.length - 1;
    const crumb = el('span', 'crumb' + (isLast ? ' current' : ''), location.name);
    if (!isLast) crumb.addEventListener('click', () => goTo(location.id));
    else crumb.addEventListener('click', () => emit('open-location', location.id));
    bar.appendChild(crumb);
  });
}

function renderTools() {
  const bar = clear($('stage-tools'));
  const location = S.locById.get(S.currentLoc);
  if (!location) return;

  const kids = childrenOf(S.currentLoc);
  const unplaced = kids.filter(kid => !kid.pos);

  if (location.map) {
    const label = S.editMode
      ? 'Done placing'
      : (unplaced.length ? `Place ${unplaced.length} unplaced` : 'Place things');
    const toggle = el('button', S.editMode ? 'on' : '', label);
    toggle.title = 'Drag a box on the map to place a location inside it';
    toggle.addEventListener('click', () => {
      S.editMode = !S.editMode;
      emit('render');
    });
    bar.appendChild(toggle);
  } else {
    const attach = el('button', '', 'Add a map');
    attach.addEventListener('click', () => attachMap(location));
    bar.appendChild(attach);
  }

  const add = el('button', '', 'New place here');
  add.title = `Add a location inside ${location.name}`;
  add.addEventListener('click', () => emit('add-location', { parent: location.id }));
  bar.appendChild(add);

  if (location.source) {
    const book = el('button', '', location.source.page ? `Book p.${location.source.page}` : 'Book');
    book.addEventListener('click', () => openSource(location.source));
    bar.appendChild(book);
  }

  if (location.parent) {
    const up = el('button', '', 'Up');
    up.addEventListener('click', () => goTo(location.parent));
    bar.appendChild(up);
  }
}

async function openSource(ref) {
  try {
    await window.api.sources.open(ref.source, ref.page);
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function attachMap(location) {
  try {
    const file = await window.api.maps.import(location.name);
    if (!file) return;
    updateLocation(location.id, { map: file });
    toast(`Map attached to ${location.name}.`);
    emit('render');
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Stage ────────────────────────────────────────────────────────────────────

export function renderStage() {
  renderBreadcrumb();
  renderTools();

  const location = S.locById.get(S.currentLoc);
  const wrap = $('map-wrap');
  const container = $('map-container');
  const image = $('map-img');
  if (!location) return;

  if (!location.map) {
    container.classList.add('hidden');
    renderMapless(wrap, location);
    return;
  }

  const missing = wrap.querySelector('.map-missing');
  if (missing) missing.remove();
  container.classList.remove('hidden');
  container.classList.toggle('editing', S.editMode);

  const url = window.api.maps.url(location.map);
  if (image.dataset.src !== url) {
    image.dataset.src = url;
    image.src = url;
    image.alt = `Map of ${location.name}`;
    // Overlays are positioned in percentages so they don't need the bitmap,
    // but redraw on load in case a different aspect ratio moves the frame.
    image.onload = () => { renderHotspots(); renderBlips(); };
    image.onerror = () => toast(`Missing map file: ${location.map}`, 'error');
  }

  renderHotspots();
  renderBlips();
}

/** A location with no map still has to be a place you can stand: list what's
 *  inside it and offer the obvious next actions. */
function renderMapless(wrap, location) {
  clear($('hotspot-layer'));
  clear($('blip-layer'));
  const tray = $('unplaced-tray');
  if (tray) tray.remove();

  let panel = wrap.querySelector('.map-missing');
  if (!panel) {
    panel = el('div', 'map-missing');
    wrap.appendChild(panel);
  }
  clear(panel);

  panel.appendChild(el('h2', null, location.name));
  if (location.summary) panel.appendChild(el('p', 'map-missing-summary', location.summary));

  const kids = childrenOf(location.id);
  const here = entitiesOn(S.currentDay).filter(m => resolveToChild(m.location, location.id));

  panel.appendChild(el('p', 'map-missing-note',
    kids.length
      ? `${kids.length} place${kids.length > 1 ? 's' : ''} inside · ${here.length} here today`
      : 'Nothing inside this place yet.'));

  const row = el('div', 'map-missing-actions');
  const addMap = el('button', 'primary', 'Add a map image');
  addMap.addEventListener('click', () => attachMap(location));
  row.appendChild(addMap);

  const addChild = el('button', '', 'Add a place inside');
  addChild.addEventListener('click', () => emit('add-location', { parent: location.id }));
  row.appendChild(addChild);

  if (location.source) {
    const book = el('button', '', location.source.page ? `Read the book, page ${location.source.page}` : 'Open the source');
    book.addEventListener('click', () => openSource(location.source));
    row.appendChild(book);
  }
  panel.appendChild(row);

  if (kids.length) {
    const list = el('div', 'map-missing-children');
    for (const kid of kids) {
      const chip = el('button', 'tray-item', kid.name);
      chip.style.borderLeftColor = group(kid.group).color;
      chip.addEventListener('click', () => enter(kid));
      list.appendChild(chip);
    }
    panel.appendChild(list);
  }
}

function enter(location) {
  if (location.map || childrenOf(location.id).length) goTo(location.id);
  else emit('open-location', location.id);
}

// ── Hotspots ─────────────────────────────────────────────────────────────────

function renderHotspots() {
  const layer = clear($('hotspot-layer'));
  const placed = childrenOf(S.currentLoc).filter(kid => kid.pos);

  for (const kid of placed) {
    const box = (S.hotspots[S.currentLoc] || []).find(h => h.target === kid.id);
    const node = el('div', 'hotspot');

    if (box) {
      node.style.left = box.x + '%';
      node.style.top = box.y + '%';
      node.style.width = box.w + '%';
      node.style.height = box.h + '%';
    } else {
      // Placed but never boxed: a small default target around the coordinate.
      node.style.left = (kid.pos[0] - 2.2) + '%';
      node.style.top = (kid.pos[1] - 2.2) + '%';
      node.style.width = '4.4%';
      node.style.height = '4.4%';
    }

    node.style.borderColor = group(kid.group).color;
    node.appendChild(el('div', 'hotspot-label', kid.name));

    node.addEventListener('click', (event) => {
      event.stopPropagation();
      if (S.editMode) return;
      enter(kid);
    });
    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      emit('open-location', kid.id);
    });

    layer.appendChild(node);
  }
}

/** Children with no coordinates would otherwise be unreachable from the map, so
 *  they get a tray in the corner until they're placed. */
function renderUnplacedTray() {
  const existing = $('unplaced-tray');
  if (existing) existing.remove();

  const location = S.locById.get(S.currentLoc);
  if (!location || !location.map) return;

  const unplaced = childrenOf(S.currentLoc).filter(kid => !kid.pos);
  if (!unplaced.length) return;

  const tray = el('div', 'unplaced-tray');
  tray.id = 'unplaced-tray';
  tray.appendChild(el('div', 'tray-head',
    S.editMode ? 'Drag a box on the map, then pick one' : 'Not yet placed on this map'));

  for (const kid of unplaced) {
    const item = el('button', 'tray-item', kid.name);
    item.style.borderLeftColor = group(kid.group).color;
    item.addEventListener('click', () => enter(kid));
    tray.appendChild(item);
  }
  $('map-wrap').appendChild(tray);
}

// ── Blips ────────────────────────────────────────────────────────────────────

function renderBlips() {
  const layer = clear($('blip-layer'));
  renderUnplacedTray();

  const buckets = new Map();
  for (const movement of entitiesOn(S.currentDay)) {
    const child = resolveToChild(movement.location, S.currentLoc);
    if (!child) continue;
    if (!buckets.has(child.id)) buckets.set(child.id, []);
    buckets.get(child.id).push(movement);
  }

  for (const [childId, movements] of buckets) {
    const child = S.locById.get(childId);
    // Someone standing on this very map gets pinned to the middle of it.
    const pos = childId === S.currentLoc ? [50, 50] : child.pos;
    if (!pos) continue;

    const single = movements.length === 1;
    const node = el('div', single ? 'blip' : 'blip cluster', single ? '' : String(movements.length));
    node.style.left = pos[0] + '%';
    node.style.top = pos[1] + '%';
    node.style.background = group(movements[0].group).color;

    const names = movements.map(m => m.name);
    node.appendChild(el('div', 'blip-tip', single ? `${names[0]} — ${child.name}` : names.join(', ')));

    node.addEventListener('click', (event) => {
      event.stopPropagation();
      if (single) emit('open-entity', movements[0].entity);
      else if (child.id !== S.currentLoc && (child.map || childrenOf(child.id).length)) goTo(child.id);
      else emit('open-location', child.id);
    });

    layer.appendChild(node);
  }
}

// ── Placing children by dragging a box ───────────────────────────────────────

function wireStageDrag() {
  const container = $('map-container');

  const pointFrom = (event) => {
    const rect = $('map-img').getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
    };
  };

  container.addEventListener('mousedown', (event) => {
    if (!S.editMode) return;
    const start = pointFrom(event);
    if (!start) return;
    drag = { start, node: el('div', 'hotspot draft'), rect: null };
    $('hotspot-layer').appendChild(drag.node);
    event.preventDefault();
  });

  container.addEventListener('mousemove', (event) => {
    if (!drag) return;
    const point = pointFrom(event);
    if (!point) return;
    const rect = {
      x: Math.min(drag.start.x, point.x),
      y: Math.min(drag.start.y, point.y),
      w: Math.abs(point.x - drag.start.x),
      h: Math.abs(point.y - drag.start.y),
    };
    Object.assign(drag.node.style, {
      left: rect.x + '%', top: rect.y + '%',
      width: rect.w + '%', height: rect.h + '%',
    });
    drag.rect = rect;
  });

  const finish = () => {
    if (!drag) return;
    const rect = drag.rect;
    drag.node.remove();
    drag = null;
    if (!rect || rect.w < 0.6 || rect.h < 0.6) return;
    askWhichChild(rect);
  };

  container.addEventListener('mouseup', finish);
  container.addEventListener('mouseleave', finish);
}

function askWhichChild(rect) {
  const kids = childrenOf(S.currentLoc);
  const unplaced = kids.filter(kid => !kid.pos);
  const candidates = unplaced.length ? unplaced : kids;

  const NEW = '__new__';
  const options = [
    ...candidates.map(kid => ({ value: kid.id, label: kid.name })),
    { value: NEW, label: '＋ A new location…' },
  ];

  formDialog({
    title: 'What goes here?',
    confirmLabel: 'Place',
    fields: [
      { key: 'target', label: 'Location', type: 'select', options, value: options[0].value },
      {
        key: 'name', label: 'Name', type: 'text', placeholder: 'e.g. The Blue Pyramid',
        when: (values) => values.target === NEW,
      },
      !unplaced.length && kids.length
        ? { key: 'note', label: '', type: 'heading' }
        : null,
    ].filter(Boolean),
    onSubmit: (values) => {
      let target = values.target;
      if (target === NEW) {
        if (!values.name || !values.name.trim()) {
          toast('Give the new location a name.', 'error');
          return false;
        }
        const parent = S.locById.get(S.currentLoc);
        target = addLocation({
          name: values.name.trim(),
          parent: S.currentLoc,
          group: parent ? parent.group : null,
        }).id;
      }
      placeChild(target, rect);
    },
  });
}

function placeChild(locId, rect) {
  const location = S.locById.get(locId);
  if (!location) return;

  updateLocation(locId, { pos: [rect.x + rect.w / 2, rect.y + rect.h / 2] });

  if (!S.hotspots[S.currentLoc]) S.hotspots[S.currentLoc] = [];
  const box = { target: locId, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  const existing = S.hotspots[S.currentLoc].find(h => h.target === locId);
  if (existing) Object.assign(existing, box);
  else S.hotspots[S.currentLoc].push(box);

  save.hotspots();
  toast(`${location.name} placed.`);
  emit('render');
}

/** Remove a placement without deleting the location — it goes back to the tray. */
export async function unplace(locId) {
  const location = S.locById.get(locId);
  if (!location) return;
  const ok = await confirmDialog({
    title: `Unplace ${location.name}?`,
    message: 'It stays in the campaign, but comes off this map and back into the tray.',
    confirmLabel: 'Unplace',
  });
  if (!ok) return;

  updateLocation(locId, { pos: null });
  delete S.appState.positions[locId];
  for (const [parentId, boxes] of Object.entries(S.hotspots)) {
    S.hotspots[parentId] = boxes.filter(box => box.target !== locId);
  }
  save.hotspots();
  save.state();
  emit('render');
}
