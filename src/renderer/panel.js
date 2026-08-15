/* The slide-out detail panel.
 *
 * Everything here is built as DOM nodes rather than an HTML string: campaign
 * text is the GM's own prose, and prose contains angle brackets, ampersands and
 * the occasional stray script tag from a badly-converted PDF. Only markdown
 * notes get the innerHTML treatment, and those go through the sanitizer in the
 * preload bridge first.
 */

import { $, el, clear, tree, toast, button } from './ui.js';
import {
  S, group, childrenOf, entitiesOn, resolveToChild, movementActive,
  goTo, emit, on, save,
} from './store.js';

let current = null;   // { kind, id }

export function wirePanel() {
  $('panel-close').addEventListener('click', closePanel);
  $('panel-edit').addEventListener('click', () => {
    if (!current) return;
    emit('edit', current);
  });
  $('panel-source').addEventListener('click', openCurrentSource);

  on('open-location', (id) => openLocation(id));
  on('open-entity', (id) => openEntity(id));
  on('open-event', (id) => openEvent(id));
  on('open-note', (file) => openNote(file));
  on('render', () => { if (current) refresh(); });
}

export function closePanel() {
  current = null;
  $('panel').classList.add('hidden');
}

function refresh() {
  if (!current) return;
  const { kind, id } = current;
  if (kind === 'location') openLocation(id);
  else if (kind === 'entity') openEntity(id);
  else if (kind === 'event') openEvent(id);
}

function show({ kind, id, title, subtitle, body, source, editable = true }) {
  current = { kind, id };
  $('panel-title').textContent = title;
  $('panel-subtitle').textContent = subtitle || '';
  clear($('panel-body')).appendChild(body);
  $('panel-edit').classList.toggle('hidden', !editable);
  $('panel-source').classList.toggle('hidden', !source);
  $('panel').dataset.source = source ? JSON.stringify(source) : '';
  $('panel').classList.remove('hidden');
}

async function openCurrentSource() {
  const raw = $('panel').dataset.source;
  if (!raw) return;
  try {
    const ref = JSON.parse(raw);
    await window.api.sources.open(ref.source, ref.page);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Sections ─────────────────────────────────────────────────────────────────

function section(heading, node) {
  if (!node) return null;
  return tree('section', 'panel-section', [el('h3', null, heading), node]);
}

function paragraphs(text) {
  if (!text) return null;
  const wrap = el('div', 'prose');
  for (const chunk of String(text).split(/\n{2,}/)) {
    if (chunk.trim()) wrap.appendChild(el('p', null, chunk.trim()));
  }
  return wrap.childElementCount ? wrap : null;
}

function chipList(items, onClick) {
  if (!items.length) return null;
  const wrap = el('div', 'chip-row');
  for (const item of items) {
    const chip = el('button', 'chip', item.label);
    if (item.color) chip.style.borderLeftColor = item.color;
    if (onClick) chip.addEventListener('click', () => onClick(item));
    wrap.appendChild(chip);
  }
  return wrap;
}

// ── Location ─────────────────────────────────────────────────────────────────

export function openLocation(id) {
  const location = S.locById.get(id);
  if (!location) return;

  const body = el('div');
  const kids = childrenOf(id);
  const here = entitiesOn(S.currentDay).filter(m => resolveToChild(m.location, id));

  if (location.summary) body.appendChild(paragraphs(location.summary));

  const presence = section(`Here on ${S.cal.format(S.currentDay, 'long')}`,
    chipList(here.map(m => ({
      label: m.name,
      color: group(m.group).color,
      id: m.entity,
    })), (item) => openEntity(item.id)));
  if (here.length) body.appendChild(presence);

  if (kids.length) {
    body.appendChild(section('Inside', chipList(kids.map(kid => ({
      label: kid.name,
      color: group(kid.group).color,
      id: kid.id,
    })), (item) => goTo(item.id))));
  }

  const actions = el('div', 'panel-actions-row');
  if (location.map || kids.length) {
    actions.appendChild(button('Go there', { className: 'primary', onClick: () => { goTo(id); } }));
  }
  if (!location.map) {
    actions.appendChild(button('Add a map', { onClick: () => emit('attach-map', id) }));
  }
  actions.appendChild(button('Add a place inside', { onClick: () => emit('add-location', { parent: id }) }));
  if (location.pos) {
    actions.appendChild(button('Unplace', { onClick: () => emit('unplace', id) }));
  }
  body.appendChild(actions);

  show({
    kind: 'location',
    id,
    title: location.name,
    subtitle: [group(location.group).name, location.map ? null : 'no map'].filter(Boolean).join(' · '),
    body,
    source: location.source,
  });
}

// ── Entity ───────────────────────────────────────────────────────────────────

export function openEntity(id) {
  const entity = S.entityById.get(id);
  if (!entity) return;

  const body = el('div');
  const movement = S.world.movements.find(m => m.entity === id && movementActive(m, S.currentDay));
  const where = movement ? S.locById.get(movement.location) : null;

  if (where) {
    const line = el('div', 'panel-where');
    line.appendChild(el('span', 'panel-where-label', `On ${S.cal.format(S.currentDay, 'long')}`));
    const link = el('button', 'link', where.name);
    link.addEventListener('click', () => goTo(where.id));
    line.appendChild(link);
    body.appendChild(line);
  }

  if (entity.summary) body.appendChild(paragraphs(entity.summary));
  const description = section('Description', paragraphs(entity.description));
  if (description) body.appendChild(description);
  const traits = section('Traits', paragraphs(entity.traits));
  if (traits) body.appendChild(traits);
  const hooks = section('Roleplaying hooks', paragraphs(entity.hooks));
  if (hooks) body.appendChild(hooks);
  const stats = section('Stats', entity.stats ? el('pre', 'stats', entity.stats) : null);
  if (stats) body.appendChild(stats);

  if (entity.links.length) {
    body.appendChild(section('Links', chipList(
      entity.links.map(link => ({ label: link.text, id: link.target })),
      (item) => { if (item.id && S.entityById.has(item.id)) openEntity(item.id); },
    )));
  }

  if (entity.prose.length) {
    const prose = el('div', 'prose');
    for (const chunk of entity.prose) prose.appendChild(el('p', null, chunk));
    body.appendChild(section('From the book', prose));
  }

  body.appendChild(section('Movements', movementList(id)));

  show({
    kind: 'entity',
    id,
    title: entity.name,
    subtitle: [entity.age, entity.role, group(entity.group).name].filter(Boolean).join(' · '),
    body,
    source: entity.source,
  });
}

/** Where someone is over time, editable — this is how a GM says "the cultist
 *  leaves for Cairo on the 14th". */
function movementList(entityId) {
  const wrap = el('div', 'movement-list');
  const movements = S.world.movements
    .filter(m => m.entity === entityId)
    .sort((a, b) => S.cal.dayOf(a.from) - S.cal.dayOf(b.from));

  for (const movement of movements) {
    const row = el('div', 'movement-row');
    const where = S.locById.get(movement.location);
    const active = movementActive(movement, S.currentDay);
    if (active) row.classList.add('active');

    const label = el('span', 'movement-where', where ? where.name : 'nowhere');
    const span = el('span', 'movement-when',
      `${S.cal.format(S.cal.dayOf(movement.from), 'short')} → ${movement.to ? S.cal.format(S.cal.dayOf(movement.to), 'short') : 'onwards'}`);

    row.appendChild(label);
    row.appendChild(span);
    row.appendChild(button('Edit', { className: 'tiny', onClick: () => emit('edit', { kind: 'movement', id: movement.id }) }));
    wrap.appendChild(row);
  }

  wrap.appendChild(button('＋ Move them', {
    className: 'tiny add',
    onClick: () => emit('add-movement', { entity: entityId }),
  }));
  return wrap;
}

// ── Event ────────────────────────────────────────────────────────────────────

export function openEvent(id) {
  const event = S.world.events.find(e => e.id === id);
  if (!event) return;

  const day = S.cal.dayOf(event.date);
  const body = el('div');

  const jump = el('div', 'panel-actions-row');
  jump.appendChild(button('Set the clock to this day', {
    className: 'primary',
    onClick: () => { emit('set-day', day); },
  }));
  if (event.location && S.locById.has(event.location)) {
    jump.appendChild(button(`Go to ${S.locById.get(event.location).name}`, {
      onClick: () => goTo(event.location),
    }));
  }
  body.appendChild(jump);

  const detail = paragraphs(event.detail);
  if (detail) body.appendChild(detail);

  const involved = (event.entities || []).map(entityId => S.entityById.get(entityId)).filter(Boolean);
  if (involved.length) {
    body.appendChild(section('Involving', chipList(
      involved.map(entity => ({ label: entity.name, color: group(entity.group).color, id: entity.id })),
      (item) => openEntity(item.id),
    )));
  }

  show({
    kind: 'event',
    id,
    title: event.text,
    subtitle: `${S.cal.format(day, 'long')} · ${event.track}`,
    body,
    source: event.source,
  });
}

// ── Note ─────────────────────────────────────────────────────────────────────

export async function openNote(file) {
  let raw;
  try {
    raw = await window.api.notes.read(file);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  if (raw == null) {
    toast(`Could not read ${file}`, 'error');
    return;
  }

  const body = el('div');
  const view = el('div', 'note-view prose');
  view.innerHTML = window.api.markdown(raw);
  body.appendChild(view);

  const actions = el('div', 'panel-actions-row');
  actions.appendChild(button('Edit', {
    className: 'primary',
    onClick: () => editNote(file, raw, body, view, actions),
  }));
  body.appendChild(actions);

  current = { kind: 'note', id: file };
  $('panel-title').textContent = file.split('/').pop().replace(/\.md$/, '');
  $('panel-subtitle').textContent = file;
  clear($('panel-body')).appendChild(body);
  $('panel-edit').classList.add('hidden');
  $('panel-source').classList.add('hidden');
  $('panel').dataset.source = '';
  $('panel').classList.remove('hidden');
}

function editNote(file, raw, body, view, actions) {
  const editor = el('textarea', 'note-editor');
  editor.value = raw;
  body.replaceChild(editor, view);
  clear(actions);

  actions.appendChild(button('Save', {
    className: 'primary',
    onClick: async () => {
      try {
        await window.api.notes.write(file, editor.value);
        toast('Saved.');
        openNote(file);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  }));
  actions.appendChild(button('Cancel', { onClick: () => openNote(file) }));
  editor.focus();
}

export function currentTarget() {
  return current;
}
