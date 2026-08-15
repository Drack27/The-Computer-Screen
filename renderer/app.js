'use strict';

// ── State ────────────────────────────────────────────────────────────────────

let campaign = null;      // campaign.json
let data = {};            // { npcs, timeline, maps }
let locById = new Map();
let childrenOf = new Map();
let mdFiles = [];
let mapFiles = [];
let hotspots = {};        // { "<locationId>": [ {id,x,y,w,h,target,label} ] }
let world = null;         // { movements, events, locationState }
let appState = {};

let currentLoc = 'world';
let currentDay = 0;       // days since clock.start
let activeRail = 'places';
let editMode = false;
let drag = null;

const DAY = 86400000;

// ── Small helpers ────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function dayToDate(day) {
  return new Date(parseDate(campaign.clock.start) + day * DAY);
}

function dateToDay(iso) {
  return Math.round((parseDate(iso) - parseDate(campaign.clock.start)) / DAY);
}

function isoOf(day) {
  return dayToDate(day).toISOString().slice(0, 10);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function prettyDate(day) {
  const d = dayToDate(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function chapterOf(id) {
  return (campaign.chapters || []).find(c => c.id === id) || { color: '#8a8f98', name: id };
}

function ancestors(locId) {
  const out = [];
  let cur = locById.get(locId);
  while (cur) {
    out.unshift(cur);
    cur = cur.parent ? locById.get(cur.parent) : null;
  }
  return out;
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  const loaded = await window.api.loadCampaign();
  campaign = loaded.campaign;
  data = loaded.data || {};

  if (!campaign) {
    document.body.innerHTML =
      '<div style="padding:60px;font-family:serif;color:#a49b8e">' +
      'No <code>campaign.json</code> found in the selected folder.<br>' +
      'Use <b>Campaign → Change Campaign Folder…</b> to pick the right one.</div>';
    return;
  }

  for (const l of campaign.locations) {
    locById.set(l.id, l);
    if (!childrenOf.has(l.parent)) childrenOf.set(l.parent, []);
    childrenOf.get(l.parent).push(l);
  }

  [mdFiles, mapFiles, hotspots] = await Promise.all([
    window.api.listMarkdownFiles(),
    window.api.listMapFiles(),
    window.api.loadHotspots(),
  ]);

  appState = (await window.api.loadState()) || { notes: {}, seen: {} };
  world = (await window.api.loadWorld()) || seedWorld();

  $('brand-title').textContent = (campaign.title || 'CAMPAIGN').toUpperCase();
  $('brand-sub').textContent = campaign.subtitle || '';

  const span = dateToDay(campaign.clock.end);
  const slider = $('clock-slider');
  slider.max = String(span);
  currentDay = dateToDay(campaign.clock.current || campaign.clock.start);
  slider.value = String(currentDay);

  wireClock();
  wireRail();
  wirePanel();

  renderLegend();
  renderAll();

  window.api.onFileChanged(() => {
    window.api.listMarkdownFiles().then(f => { mdFiles = f; if (activeRail === 'notes') renderRail(); });
  });
}

// world.json seed: every NPC starts parked in their chapter's root location
// for the whole campaign. Refine positions per-NPC from the UI.
function seedWorld() {
  const rootOfChapter = {};
  for (const l of campaign.locations) {
    if (l.parent === 'world' && !rootOfChapter[l.chapter]) rootOfChapter[l.chapter] = l.id;
  }
  const movements = (data.npcs || []).map(n => ({
    entity: n.id,
    name: n.name,
    kind: 'npc',
    chapter: n.chapter,
    location: rootOfChapter[n.chapter] || 'world',
    from: campaign.clock.start,
    to: null,
  }));
  const events = (data.timeline || []).map((t, i) => ({
    id: 'w' + i,
    date: t.date,
    text: t.text,
    track: 'world',
    location: null,
    page: t.page || null,
  }));
  const w = { movements, events, locationState: {} };
  window.api.saveWorld(w);
  return w;
}

const persistWorld = () => window.api.saveWorld(world);

// ── Clock ────────────────────────────────────────────────────────────────────

function wireClock() {
  $('clock-slider').addEventListener('input', (e) => {
    currentDay = parseInt(e.target.value, 10);
    renderAll();
  });
  $('clock-prev').addEventListener('click', () => nudge(-1));
  $('clock-next').addEventListener('click', () => nudge(1));
  $('clock-today').addEventListener('click', () => {
    const last = latestPartyDay();
    setDay(last == null ? dateToDay(campaign.clock.current) : last);
  });
}

function nudge(n) { setDay(currentDay + n); }

function setDay(d) {
  const max = parseInt($('clock-slider').max, 10);
  currentDay = Math.max(0, Math.min(max, d));
  $('clock-slider').value = String(currentDay);
  renderAll();
}

function latestPartyDay() {
  const party = (world.events || []).filter(e => e.track === 'party');
  if (!party.length) return null;
  return Math.max(...party.map(e => dateToDay(e.date)));
}

function renderClock() {
  $('clock-date').textContent = prettyDate(currentDay);

  const doom = campaign.clock.doomsday ? dateToDay(campaign.clock.doomsday) : null;
  const doomEl = $('clock-doom');
  if (doom == null) {
    doomEl.textContent = '';
  } else if (currentDay < doom) {
    doomEl.textContent = `${doom - currentDay} days until ${campaign.clock.doomsdayLabel || 'the end'}`;
  } else if (currentDay === doom) {
    doomEl.textContent = `${campaign.clock.doomsdayLabel || 'The end'} — today`;
  } else {
    doomEl.textContent = `${currentDay - doom} days after ${campaign.clock.doomsdayLabel || 'the end'}`;
  }

  // Events within a short window of the current date, nearest first.
  const here = [];
  for (const e of world.events || []) {
    const d = dateToDay(e.date);
    if (Math.abs(d - currentDay) <= 21) here.push({ e, d, gap: Math.abs(d - currentDay) });
  }
  here.sort((a, b) => a.gap - b.gap || a.d - b.d);

  const list = $('clock-events');
  list.innerHTML = '';
  if (!here.length) {
    list.appendChild(el('div', 'lane-empty', 'Nothing within three weeks.'));
    return;
  }
  for (const { e, d } of here.slice(0, 24)) {
    const item = el('div', 'lane-item ' + (e.track || 'world'));
    const when = el('span', 'when',
      d === currentDay ? 'Today' : (d < currentDay ? `${currentDay - d} days ago` : `in ${d - currentDay} days`));
    item.appendChild(when);
    item.appendChild(document.createTextNode(e.text));
    item.title = e.date;
    if (e.page) item.addEventListener('click', () => window.api.openPdfAt(e.page));
    list.appendChild(item);
  }
}

function renderLegend() {
  const box = $('clock-legend');
  box.innerHTML = '';
  for (const c of campaign.chapters || []) {
    if (['front', 'end'].includes(c.id)) continue;
    const row = el('div', 'legend-row');
    const dot = el('span', 'legend-dot');
    dot.style.background = c.color;
    row.appendChild(dot);
    row.appendChild(el('span', null, c.name));
    box.appendChild(row);
  }
}

// ── Where is an entity on a given day? ───────────────────────────────────────

function movementActive(m, day) {
  const from = dateToDay(m.from);
  const to = m.to == null ? Infinity : dateToDay(m.to);
  return day >= from && day <= to;
}

function entitiesOn(day) {
  const seen = new Map();
  for (const m of world.movements || []) {
    if (!movementActive(m, day)) continue;
    // Later-starting movements win, so an NPC who moves stays moved.
    const prev = seen.get(m.entity);
    if (!prev || dateToDay(m.from) >= dateToDay(prev.from)) seen.set(m.entity, m);
  }
  return [...seen.values()];
}

/** Which direct child of `rootId` contains `locId`? Returns the child, `rootId`
 *  itself when the entity is standing on this very map, or null if unrelated. */
function resolveToChild(locId, rootId) {
  let cur = locById.get(locId);
  if (!cur) return null;
  if (cur.id === rootId) return cur;
  while (cur && cur.parent) {
    if (cur.parent === rootId) return cur;
    cur = locById.get(cur.parent);
  }
  return null;
}

// ── Map stage ────────────────────────────────────────────────────────────────

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  bc.innerHTML = '';
  const chain = ancestors(currentLoc);
  chain.forEach((l, i) => {
    if (i) bc.appendChild(el('span', 'crumb-sep', '›'));
    const c = el('span', 'crumb' + (i === chain.length - 1 ? ' current' : ''), l.name);
    if (i < chain.length - 1) c.addEventListener('click', () => goTo(l.id));
    bc.appendChild(c);
  });
}

function renderTools() {
  const bar = $('stage-tools');
  bar.innerHTML = '';
  const loc = locById.get(currentLoc);

  const unplaced = (childrenOf.get(currentLoc) || []).filter(k => !k.pos);
  const label = editMode
    ? 'Done placing'
    : (unplaced.length ? `Place ${unplaced.length} unplaced` : 'Adjust placement');
  const edit = el('button', editMode ? 'on' : '', label);
  edit.addEventListener('click', () => {
    editMode = !editMode;
    renderAll();
  });
  if (loc && loc.map && (childrenOf.get(currentLoc) || []).length) bar.appendChild(edit);

  if (loc && loc.page) {
    const pdf = el('button', '', `PDF p.${loc.page}`);
    pdf.addEventListener('click', () => window.api.openPdfAt(loc.page));
    bar.appendChild(pdf);
  }

  const up = el('button', '', 'Up');
  up.addEventListener('click', () => {
    const l = locById.get(currentLoc);
    if (l && l.parent) goTo(l.parent);
  });
  if (loc && loc.parent) bar.appendChild(up);
}

function renderStage() {
  const loc = locById.get(currentLoc);
  const wrap = $('map-wrap');
  const content = $('content-view');
  content.classList.add('hidden');
  wrap.classList.remove('hidden');

  const container = $('map-container');
  const img = $('map-img');

  if (!loc.map) {
    // No map for this place: list its children and its book text instead.
    container.classList.add('hidden');
    let miss = document.querySelector('.map-missing');
    if (!miss) {
      miss = el('div', 'map-missing');
      wrap.appendChild(miss);
    }
    miss.classList.remove('hidden');
    miss.innerHTML = '';
    miss.appendChild(el('div', null, `No map for ${loc.name}.`));
    const kids = childrenOf.get(loc.id) || [];
    if (kids.length) {
      miss.appendChild(el('div', null,
        `${kids.length} place${kids.length > 1 ? 's' : ''} inside — see the Places rail.`));
    }
    if (loc.page) {
      const b = el('button', '', `Read the book, page ${loc.page}`);
      b.style.marginTop = '14px';
      b.addEventListener('click', () => window.api.openPdfAt(loc.page));
      miss.appendChild(b);
    }
    return;
  }

  const miss = document.querySelector('.map-missing');
  if (miss) miss.classList.add('hidden');
  container.classList.remove('hidden');
  container.classList.toggle('editing', editMode);

  const url = window.api.mapUrl(loc.map);
  if (img.dataset.src !== url) {
    img.dataset.src = url;
    img.src = url;
    // Overlays are positioned in percentages, so they don't need the bitmap.
    // Redraw on load anyway in case the map's aspect ratio changes the frame.
    img.onload = () => { renderHotspots(); renderBlips(); };
    img.onerror = () => toast('Missing map file: ' + loc.map);
  }
  renderHotspots();
  renderBlips();
}

function renderHotspots() {
  const layer = $('hotspot-layer');
  layer.innerHTML = '';
  const kids = (childrenOf.get(currentLoc) || []).filter(k => k.pos);

  for (const kid of kids) {
    const spot = (hotspots[currentLoc] || []).find(h => h.target === kid.id);
    const box = el('div', 'hotspot');
    if (spot) {
      box.style.left = spot.x + '%';
      box.style.top = spot.y + '%';
      box.style.width = spot.w + '%';
      box.style.height = spot.h + '%';
    } else {
      // Positioned but never boxed: draw a small default target.
      box.style.left = (kid.pos[0] - 2.2) + '%';
      box.style.top = (kid.pos[1] - 2.2) + '%';
      box.style.width = '4.4%';
      box.style.height = '4.4%';
    }
    box.style.borderColor = chapterOf(kid.chapter).color;
    box.appendChild(el('div', 'hotspot-label', kid.name));
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      if (editMode) return;
      if (kid.map || (childrenOf.get(kid.id) || []).length) goTo(kid.id);
      else openLocationPanel(kid);
    });
    layer.appendChild(box);
  }
}

/** A map whose children have no coordinates yet would be a dead end, so list
 *  them over the map until they're placed. */
function renderUnplacedTray() {
  const old = document.getElementById('unplaced-tray');
  if (old) old.remove();

  const loc = locById.get(currentLoc);
  if (!loc || !loc.map) return;
  const unplaced = (childrenOf.get(currentLoc) || []).filter(k => !k.pos);
  if (!unplaced.length) return;

  const tray = el('div', 'unplaced-tray');
  tray.id = 'unplaced-tray';
  tray.appendChild(el('div', 'tray-head',
    editMode ? 'Drag a box on the map, then pick one' : 'Not yet placed on this map'));
  for (const kid of unplaced) {
    const b = el('button', 'tray-item', kid.name);
    b.style.borderLeftColor = chapterOf(kid.chapter).color;
    b.addEventListener('click', () => {
      if (kid.map || (childrenOf.get(kid.id) || []).length) goTo(kid.id);
      else openLocationPanel(kid);
    });
    tray.appendChild(b);
  }
  $('map-wrap').appendChild(tray);
}

function renderBlips() {
  const layer = $('blip-layer');
  layer.innerHTML = '';
  renderUnplacedTray();

  const buckets = new Map();   // childLocationId -> [movement]
  for (const m of entitiesOn(currentDay)) {
    const child = resolveToChild(m.location, currentLoc);
    if (!child) continue;
    if (!buckets.has(child.id)) buckets.set(child.id, []);
    buckets.get(child.id).push(m);
  }

  for (const [childId, list] of buckets) {
    const child = locById.get(childId);
    const pos = childId === currentLoc ? [50, 50] : child.pos;
    if (!pos) continue;

    if (list.length === 1) {
      const m = list[0];
      const b = el('div', 'blip');
      b.style.left = pos[0] + '%';
      b.style.top = pos[1] + '%';
      b.style.background = chapterOf(m.chapter).color;
      const tip = el('div', 'blip-tip', `${m.name} — ${child.name}`);
      b.appendChild(tip);
      b.addEventListener('click', () => openNpcPanel(m.entity));
      layer.appendChild(b);
    } else {
      const b = el('div', 'blip cluster', String(list.length));
      b.style.left = pos[0] + '%';
      b.style.top = pos[1] + '%';
      b.style.background = chapterOf(list[0].chapter).color;
      const tip = el('div', 'blip-tip', list.map(m => m.name).join(', '));
      b.appendChild(tip);
      b.addEventListener('click', () => {
        if (child.id !== currentLoc && (child.map || (childrenOf.get(child.id) || []).length)) goTo(child.id);
        else openLocationPanel(child);
      });
      layer.appendChild(b);
    }
  }
}

function goTo(locId) {
  if (!locById.has(locId)) return;
  currentLoc = locId;
  editMode = false;
  renderAll();
}

// ── Placing children on a map (drag a box) ───────────────────────────────────

function wireStageDrag() {
  const container = $('map-container');

  container.addEventListener('mousedown', (e) => {
    if (!editMode) return;
    const img = $('map-img');
    const r = img.getBoundingClientRect();
    drag = {
      x0: ((e.clientX - r.left) / r.width) * 100,
      y0: ((e.clientY - r.top) / r.height) * 100,
      node: el('div', 'hotspot draft'),
    };
    $('hotspot-layer').appendChild(drag.node);
    e.preventDefault();
  });

  container.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const img = $('map-img');
    const r = img.getBoundingClientRect();
    const x1 = ((e.clientX - r.left) / r.width) * 100;
    const y1 = ((e.clientY - r.top) / r.height) * 100;
    const x = Math.min(drag.x0, x1), y = Math.min(drag.y0, y1);
    const w = Math.abs(x1 - drag.x0), h = Math.abs(y1 - drag.y0);
    Object.assign(drag.node.style,
      { left: x + '%', top: y + '%', width: w + '%', height: h + '%' });
    drag.rect = { x, y, w, h };
  });

  container.addEventListener('mouseup', () => {
    if (!drag) return;
    const rect = drag.rect;
    drag.node.remove();
    drag = null;
    if (!rect || rect.w < 0.6 || rect.h < 0.6) return;
    askWhichChild(rect);
  });
}

function askWhichChild(rect) {
  const kids = childrenOf.get(currentLoc) || [];
  if (!kids.length) {
    toast('Nothing is nested under this location in campaign.json.');
    return;
  }
  const unplaced = kids.filter(k => !k.pos);
  const options = unplaced.length ? unplaced : kids;

  showModal({
    title: 'Place which location?',
    bodyHtml:
      '<label>Location</label><select id="m-target">' +
      options.map(k => `<option value="${k.id}">${k.name}</option>`).join('') +
      '</select>' +
      (unplaced.length ? '' : '<div style="font-size:12px">All children are placed — this will move the one you pick.</div>'),
    confirm: 'Place',
    onConfirm: () => {
      const id = document.getElementById('m-target').value;
      const kid = locById.get(id);
      kid.pos = [rect.x + rect.w / 2, rect.y + rect.h / 2];
      if (!hotspots[currentLoc]) hotspots[currentLoc] = [];
      const existing = hotspots[currentLoc].find(h => h.target === id);
      const box = { target: id, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (existing) Object.assign(existing, box);
      else hotspots[currentLoc].push(box);
      window.api.saveHotspots(hotspots);
      savePositions();
      renderStage();
      toast(`${kid.name} placed.`);
    },
  });
}

// Positions live in campaign.json conceptually, but we persist overrides in
// app state so the vault file stays hand-editable.
function savePositions() {
  appState.positions = appState.positions || {};
  for (const l of campaign.locations) {
    if (l.pos) appState.positions[l.id] = l.pos;
  }
  window.api.saveState(appState);
}

function applySavedPositions() {
  const saved = appState.positions || {};
  for (const [id, pos] of Object.entries(saved)) {
    const l = locById.get(id);
    if (l) l.pos = pos;
  }
}

// ── Right rail ───────────────────────────────────────────────────────────────

function wireRail() {
  document.querySelectorAll('.rail-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.rail-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeRail = tab.dataset.rail;
      renderRail();
    });
  });
}

function renderRail() {
  const body = $('rail-body');
  body.innerHTML = '';
  if (activeRail === 'places') renderPlacesRail(body);
  else if (activeRail === 'people') renderPeopleRail(body);
  else renderNotesRail(body);
}

function renderPlacesRail(body) {
  const add = (loc, depth) => {
    const btn = el('button', 'rail-item' + (loc.id === currentLoc ? ' active' : ''));
    btn.style.paddingLeft = (14 + depth * 12) + 'px';
    const dot = el('span', 'rail-dot');
    dot.style.background = chapterOf(loc.chapter).color;
    btn.appendChild(dot);
    btn.appendChild(el('span', null, loc.name));
    if (!loc.map) {
      const s = el('span', 'sub', '·');
      s.title = 'No map';
      btn.appendChild(s);
    }
    btn.addEventListener('click', () => goTo(loc.id));
    body.appendChild(btn);
    for (const kid of childrenOf.get(loc.id) || []) add(kid, depth + 1);
  };
  const root = campaign.locations.find(l => !l.parent);
  if (root) add(root, 0);
}

function renderPeopleRail(body) {
  const active = entitiesOn(currentDay);
  const byChapter = new Map();
  for (const m of active) {
    if (!byChapter.has(m.chapter)) byChapter.set(m.chapter, []);
    byChapter.get(m.chapter).push(m);
  }
  for (const ch of campaign.chapters) {
    const list = byChapter.get(ch.id);
    if (!list) continue;
    body.appendChild(el('div', 'rail-group', ch.name));
    list.sort((a, b) => a.name.localeCompare(b.name));
    for (const m of list) {
      const btn = el('button', 'rail-item');
      const dot = el('span', 'rail-dot');
      dot.style.background = ch.color;
      btn.appendChild(dot);
      btn.appendChild(el('span', null, m.name));
      const where = locById.get(m.location);
      if (where) {
        const chip = el('span', 'sub', where.name);
        chip.style.marginLeft = 'auto';
        btn.appendChild(chip);
      }
      btn.addEventListener('click', () => openNpcPanel(m.entity));
      body.appendChild(btn);
    }
  }
  if (!active.length) body.appendChild(el('div', 'lane-empty', 'Nobody placed on this date.'));
}

function renderNotesRail(body) {
  if (!mdFiles.length) {
    body.appendChild(el('div', 'lane-empty', 'No .md notes in the campaign folder yet.'));
    return;
  }
  const groups = new Map();
  for (const f of mdFiles) {
    const dir = f.includes('/') ? f.split('/')[0] : 'Root';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  for (const [dir, files] of [...groups].sort()) {
    body.appendChild(el('div', 'rail-group', dir));
    for (const f of files.sort()) {
      const name = f.split('/').pop().replace(/\.md$/, '');
      const btn = el('button', 'rail-item');
      btn.appendChild(el('span', null, name));
      btn.addEventListener('click', () => openNotePanel(f, name));
      body.appendChild(btn);
    }
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────

let panelPage = null;

function wirePanel() {
  $('panel-close').addEventListener('click', closePanel);
  $('panel-pdf').addEventListener('click', () => {
    if (panelPage) window.api.openPdfAt(panelPage);
  });
}

function openPanel(title, html, page) {
  $('panel-title').textContent = title;
  $('panel-body').innerHTML = html;
  panelPage = page || null;
  $('panel-pdf').classList.toggle('hidden', !page);
  $('panel').classList.remove('hidden');
}

function closePanel() { $('panel').classList.add('hidden'); }

function openLocationPanel(loc) {
  const kids = childrenOf.get(loc.id) || [];
  const here = entitiesOn(currentDay)
    .filter(m => resolveToChild(m.location, loc.id) || m.location === loc.id);
  let html = `<div class="meta-row">${chapterOf(loc.chapter).name}` +
    (loc.page ? ` · page ${loc.page}` : '') + `</div>`;
  if (here.length) {
    html += '<h3>Here on this date</h3><ul>' +
      here.map(m => `<li>${m.name}</li>`).join('') + '</ul>';
  }
  if (kids.length) {
    html += '<h3>Inside</h3><ul>' + kids.map(k => `<li>${k.name}</li>`).join('') + '</ul>';
  }
  if (!loc.map) html += '<p><i>No map yet for this location.</i></p>';
  openPanel(loc.name, html, loc.page);
}

function openNpcPanel(id) {
  const npc = (data.npcs || []).find(n => n.id === id);
  if (!npc) return;
  const mv = (world.movements || []).find(m => m.entity === id && movementActive(m, currentDay));
  const where = mv ? locById.get(mv.location) : null;

  let html = `<div class="meta-row">${npc.age ? npc.age + ' · ' : ''}${npc.role || ''}` +
    ` · ${chapterOf(npc.chapter).name}${npc.page ? ' · page ' + npc.page : ''}</div>`;
  if (where) html += `<p><b>On ${prettyDate(currentDay)}:</b> ${where.name}</p>`;
  if (npc.description) html += `<h4>Description</h4><p>${npc.description}</p>`;
  if (npc.traits) html += `<h4>Traits</h4><p>${npc.traits}</p>`;
  if (npc.hooks) html += `<h4>Roleplaying hooks</h4><p>${npc.hooks}</p>`;
  if (npc.links && npc.links.length) {
    html += '<h4>Links</h4><ul>' + npc.links.map(l => `<li>${l.text}</li>`).join('') + '</ul>';
  }
  if (npc.prose && npc.prose.length) {
    html += '<hr>' + npc.prose.map(p => `<p>${p}</p>`).join('');
  }
  openPanel(npc.name, html, npc.page);
}

async function openNotePanel(file, title) {
  const raw = await window.api.readFile(file);
  if (raw == null) { toast('Could not read ' + file); return; }
  openPanel(title, window.api.parseMarkdown(raw), null);
}

// ── Modal ────────────────────────────────────────────────────────────────────

function showModal({ title, bodyHtml, confirm, onConfirm }) {
  $('modal-header').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  const foot = $('modal-footer');
  foot.innerHTML = '';
  const cancel = el('button', '', 'Cancel');
  cancel.addEventListener('click', hideModal);
  const ok = el('button', 'on', confirm || 'OK');
  ok.addEventListener('click', () => { onConfirm(); hideModal(); });
  foot.appendChild(cancel);
  foot.appendChild(ok);
  $('modal-overlay').classList.remove('hidden');
}

function hideModal() { $('modal-overlay').classList.add('hidden'); }

// ── Render everything ────────────────────────────────────────────────────────

function renderAll() {
  renderClock();
  renderBreadcrumb();
  renderTools();
  renderStage();
  renderRail();
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') nudge(-1);
  if (e.key === 'ArrowRight') nudge(1);
  if (e.key === 'Escape') { closePanel(); hideModal(); }
  if (e.key === 'Backspace') {
    const l = locById.get(currentLoc);
    if (l && l.parent) goTo(l.parent);
  }
});

init().then(() => {
  applySavedPositions();
  wireStageDrag();
  renderAll();
});
