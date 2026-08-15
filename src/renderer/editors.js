/* Every "add" and "edit" dialog in the app.
 *
 * These are what make the app a place you build a campaign rather than a viewer
 * for someone else's JSON. Each one is a list of field descriptors handed to
 * formDialog, so adding a field to a record is a line here and nothing else.
 */

import { formDialog, confirmDialog, toast, el, clear, button, tree } from './ui.js';
import { PRESETS, presetById, normalizeDef, createCalendar } from '../../shared/calendar.js';
import { ENTITY_KINDS } from '../../shared/schema.js';
import {
  S, group, descendants, emit, save, reindex,
  addLocation, updateLocation, removeLocation,
  addEntity, updateEntity, removeEntity,
  addEvent, updateEvent, removeEvent,
  addMovement, updateMovement, removeMovement,
  addGroup, updateCampaign, rootLocationId,
} from './store.js';

let mapFiles = [];

export async function refreshMapFiles() {
  try {
    mapFiles = await window.api.maps.list();
  } catch {
    mapFiles = [];
  }
  return mapFiles;
}

const NEW_GROUP = '__new_group__';
const IMPORT_MAP = '__import_map__';

function groupOptions(includeNew = true) {
  const options = S.campaign.groups.map(g => ({ value: g.id, label: g.name }));
  options.unshift({ value: '', label: '— none —' });
  if (includeNew) options.push({ value: NEW_GROUP, label: '＋ New group…' });
  return options;
}

/** Resolve the "new group" placeholder into a real group id. */
function settleGroup(values) {
  if (values.group !== NEW_GROUP) return values.group || null;
  const name = (values.groupName || '').trim();
  if (!name) {
    toast('Name the new group, or pick an existing one.', 'error');
    return undefined;   // signals "don't submit"
  }
  const palette = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#d68910', '#16a085'];
  return addGroup({ name, color: values.groupColor || palette[S.campaign.groups.length % palette.length] }).id;
}

const groupFields = (value) => [
  { key: 'group', label: 'Group', type: 'select', options: groupOptions(), value: value || '',
    hint: 'Groups colour the map blips — chapters, factions, regions, whatever you sort by.' },
  { key: 'groupName', label: 'New group name', type: 'text', when: (v) => v.group === NEW_GROUP },
  { key: 'groupColor', label: 'Colour', type: 'color', value: '#c0392b', when: (v) => v.group === NEW_GROUP },
];

function locationOptions({ exclude = null, includeNone = false, noneLabel = '— none —' } = {}) {
  const forbidden = exclude ? new Set(descendants(exclude)) : new Set();
  const options = [];
  if (includeNone) options.push({ value: '', label: noneLabel });

  const walk = (id, depth) => {
    if (forbidden.has(id)) return;
    const location = S.locById.get(id);
    if (!location) return;
    options.push({ value: id, label: `${'  '.repeat(depth)}${location.name}` });
    for (const kid of (S.childrenOf.get(id) || [])) walk(kid.id, depth + 1);
  };
  const root = rootLocationId();
  if (root) walk(root, 0);
  return options;
}

function mapOptions(current) {
  const options = [{ value: '', label: '— no map —' }];
  for (const file of mapFiles) options.push({ value: file, label: file });
  if (current && !mapFiles.includes(current)) options.push({ value: current, label: `${current} (missing)` });
  options.push({ value: IMPORT_MAP, label: '＋ Import an image…' });
  return options;
}

// ── Location ─────────────────────────────────────────────────────────────────

export function locationDialog(existing = null, defaults = {}) {
  const location = existing ? S.locById.get(existing) : null;
  const isRoot = location && location.parent === null;

  formDialog({
    title: location ? `Edit ${location.name}` : 'New location',
    confirmLabel: location ? 'Save' : 'Create',
    wide: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: location ? location.name : '', required: true,
        placeholder: 'e.g. The Blue Pyramid' },
      isRoot ? null : {
        key: 'parent', label: 'Inside', type: 'select',
        options: locationOptions({ exclude: location ? location.id : null }),
        value: location ? location.parent : (defaults.parent || rootLocationId()),
      },
      ...groupFields(location ? location.group : defaults.group),
      { key: 'map', label: 'Map image', type: 'select', options: mapOptions(location && location.map),
        value: (location && location.map) || '',
        hint: 'Drop images into the Maps folder, or import one here.' },
      { key: 'summary', label: 'Summary', type: 'textarea', rows: 4,
        value: location ? location.summary : '',
        placeholder: 'What the players see when they arrive.' },
      { key: 'page', label: 'Book page', type: 'number', min: 1,
        value: location && location.source ? location.source.page : null,
        hint: S.campaign.sources.length ? '' : 'Attach a source book in Campaign Settings to make this clickable.' },
    ].filter(Boolean),

    onSubmit: (values) => {
      const groupId = settleGroup(values);
      if (groupId === undefined) return false;

      if (values.map === IMPORT_MAP) {
        // Import first, then re-open with the new file selected.
        window.api.maps.import(values.name).then(async (file) => {
          await refreshMapFiles();
          if (!file) return;
          applyLocation(location, { ...values, group: groupId, map: file });
        }).catch(err => toast(err.message, 'error'));
        return true;
      }

      try {
        applyLocation(location, { ...values, group: groupId });
      } catch (err) {
        toast(err.message, 'error');
        return false;
      }
    },

    extraActions: location && !isRoot
      ? [{
        label: 'Delete', danger: true, onClick: async (_values, close) => {
          const kids = descendants(location.id).length - 1;
          const ok = await confirmDialog({
            title: `Delete ${location.name}?`,
            message: kids
              ? `This also deletes ${kids} place${kids > 1 ? 's' : ''} inside it. Anyone standing there moves up to ${S.locById.get(location.parent).name}.`
              : `Anyone standing there moves up to ${S.locById.get(location.parent).name}.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          try {
            removeLocation(location.id);
            close();
            emit('render');
            toast('Deleted.');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }]
      : [],
  });
}

function applyLocation(location, values) {
  const patch = {
    name: values.name.trim(),
    group: values.group || null,
    map: values.map || null,
    summary: values.summary || '',
    source: values.page
      ? { source: S.campaign.sources[0] ? S.campaign.sources[0].id : 'book', page: values.page }
      : null,
  };
  if (values.parent !== undefined) patch.parent = values.parent || null;

  if (location) {
    updateLocation(location.id, patch);
    toast('Saved.');
  } else {
    const created = addLocation({
      name: patch.name,
      parent: patch.parent,
      group: patch.group,
      map: patch.map,
      summary: patch.summary,
    });
    if (patch.source) updateLocation(created.id, { source: patch.source });
    toast(`${created.name} added.`);
  }
  emit('render');
}

// ── Entity ───────────────────────────────────────────────────────────────────

const KIND_LABELS = {
  npc: 'Person', pc: 'Player character', faction: 'Faction',
  creature: 'Creature', item: 'Item', 'place-marker': 'Marker',
};

export function entityDialog(existing = null, defaults = {}) {
  const entity = existing ? S.entityById.get(existing) : null;

  formDialog({
    title: entity ? `Edit ${entity.name}` : 'New person or thing',
    confirmLabel: entity ? 'Save' : 'Create',
    wide: true,
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: entity ? entity.name : '', required: true },
      { key: 'kind', label: 'Kind', type: 'select', value: entity ? entity.kind : 'npc',
        options: ENTITY_KINDS.map(kind => ({ value: kind, label: KIND_LABELS[kind] || kind })) },
      { key: 'role', label: 'Role', type: 'text', value: entity ? entity.role : '',
        placeholder: 'e.g. Cult leader, publican, retired inspector' },
      { key: 'age', label: 'Age', type: 'text', value: entity ? entity.age : '' },
      ...groupFields(entity ? entity.group : defaults.group),
      { key: 'home', label: 'Usually found at', type: 'select',
        options: locationOptions({ includeNone: true, noneLabel: '— nowhere in particular —' }),
        value: entity ? (entity.home || '') : (defaults.home || ''),
        hint: entity ? '' : 'A new person gets a movement here covering the whole campaign.' },
      { key: 'summary', label: 'Summary', type: 'textarea', rows: 2, value: entity ? entity.summary : '' },
      { key: 'description', label: 'Description', type: 'textarea', rows: 4, value: entity ? entity.description : '' },
      { key: 'traits', label: 'Traits', type: 'textarea', rows: 2, value: entity ? entity.traits : '' },
      { key: 'hooks', label: 'Roleplaying hooks', type: 'textarea', rows: 3, value: entity ? entity.hooks : '' },
      { key: 'stats', label: 'Stat block', type: 'textarea', rows: 4, value: entity ? entity.stats : '',
        hint: 'Kept as plain text — paste whatever your system uses.' },
      { key: 'page', label: 'Book page', type: 'number', min: 1,
        value: entity && entity.source ? entity.source.page : null },
    ],

    onSubmit: (values) => {
      const groupId = settleGroup(values);
      if (groupId === undefined) return false;

      const patch = {
        name: values.name.trim(),
        kind: values.kind,
        role: values.role,
        age: values.age,
        group: groupId,
        home: values.home || null,
        summary: values.summary,
        description: values.description,
        traits: values.traits,
        hooks: values.hooks,
        stats: values.stats,
        source: values.page
          ? { source: S.campaign.sources[0] ? S.campaign.sources[0].id : 'book', page: values.page }
          : null,
      };

      if (entity) {
        updateEntity(entity.id, patch);
        toast('Saved.');
      } else {
        const created = addEntity(patch);
        toast(`${created.name} added.`);
      }
      emit('render');
    },

    extraActions: entity
      ? [{
        label: 'Delete', danger: true, onClick: async (_values, close) => {
          const ok = await confirmDialog({
            title: `Delete ${entity.name}?`,
            message: 'Their movements go too. Events that mention them stay.',
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          removeEntity(entity.id);
          close();
          emit('close-panel');
          emit('render');
          toast('Deleted.');
        },
      }]
      : [],
  });
}

// ── Event ────────────────────────────────────────────────────────────────────

export function eventDialog(existing = null, defaults = {}) {
  const event = existing ? S.world.events.find(e => e.id === existing) : null;

  formDialog({
    title: event ? 'Edit event' : 'New event',
    confirmLabel: event ? 'Save' : 'Create',
    wide: true,
    fields: [
      { key: 'text', label: 'What happens', type: 'text', required: true,
        value: event ? event.text : '', placeholder: 'e.g. Jackson Elias is murdered' },
      { key: 'date', label: 'When', type: 'date', calendar: S.cal,
        value: event ? event.date : (defaults.date || S.cal.stringify(S.currentDay)) },
      { key: 'track', label: 'Track', type: 'select', value: event ? event.track : 'world',
        options: [
          { value: 'world', label: 'The world moves' },
          { value: 'party', label: 'The party did this' },
          { value: 'secret', label: 'Behind the screen' },
        ],
        hint: 'Party events are what the "Now" button jumps to.' },
      { key: 'location', label: 'Where', type: 'select',
        options: locationOptions({ includeNone: true, noneLabel: '— nowhere in particular —' }),
        value: event ? (event.location || '') : (defaults.location || '') },
      { key: 'detail', label: 'Detail', type: 'textarea', rows: 4, value: event ? event.detail : '' },
    ],

    onSubmit: (values) => {
      const patch = {
        text: values.text.trim(),
        date: values.date,
        track: values.track,
        location: values.location || null,
        detail: values.detail,
      };
      if (event) updateEvent(event.id, patch);
      else addEvent(patch);
      toast('Saved.');
      emit('render');
    },

    extraActions: event
      ? [{
        label: 'Delete', danger: true, onClick: async (_values, close) => {
          const ok = await confirmDialog({
            title: 'Delete this event?', message: event.text, confirmLabel: 'Delete', danger: true,
          });
          if (!ok) return;
          removeEvent(event.id);
          close();
          emit('close-panel');
          emit('render');
        },
      }]
      : [],
  });
}

// ── Movement ─────────────────────────────────────────────────────────────────

export function movementDialog(existing = null, defaults = {}) {
  const movement = existing ? S.world.movements.find(m => m.id === existing) : null;
  const entityId = movement ? movement.entity : defaults.entity;
  const entity = S.entityById.get(entityId);
  if (!entity) {
    toast('Pick a person first.', 'error');
    return;
  }

  formDialog({
    title: movement ? `Where is ${entity.name}?` : `Move ${entity.name}`,
    confirmLabel: 'Save',
    fields: [
      { key: 'location', label: 'Location', type: 'select', options: locationOptions(),
        value: movement ? movement.location : (defaults.location || S.currentLoc) },
      { key: 'from', label: 'From', type: 'date', calendar: S.cal,
        value: movement ? movement.from : S.cal.stringify(S.currentDay) },
      { key: 'to', label: 'Until', type: 'date', calendar: S.cal, allowEmpty: true,
        value: movement ? movement.to : null,
        hint: 'Leave open-ended and they stay there for the rest of the campaign.' },
      { key: 'note', label: 'Note', type: 'text', value: movement ? movement.note : '',
        placeholder: 'e.g. hiding in the cellar' },
    ],

    onSubmit: (values) => {
      if (values.to && S.cal.dayOf(values.to) < S.cal.dayOf(values.from)) {
        toast('The end date is before the start date.', 'error');
        return false;
      }
      const patch = {
        location: values.location,
        from: values.from,
        to: values.to || null,
        note: values.note,
      };
      if (movement) updateMovement(movement.id, patch);
      else addMovement({ entity: entityId, ...patch });
      emit('render');
      toast('Saved.');
    },

    extraActions: movement
      ? [{
        label: 'Delete', danger: true, onClick: (_values, close) => {
          removeMovement(movement.id);
          close();
          emit('render');
        },
      }]
      : [],
  });
}

// ── Campaign settings ────────────────────────────────────────────────────────

export function campaignSettingsDialog() {
  const campaign = S.campaign;

  formDialog({
    title: 'Campaign settings',
    confirmLabel: 'Save',
    wide: true,
    fields: [
      { key: 'title', label: 'Title', type: 'text', value: campaign.title, required: true },
      { key: 'subtitle', label: 'Subtitle', type: 'text', value: campaign.subtitle,
        placeholder: 'e.g. Call of Cthulhu · 1925' },
      { key: 'system', label: 'System', type: 'text', value: campaign.system,
        placeholder: 'e.g. Call of Cthulhu 7e, D&D 5e, Blades in the Dark' },

      { key: 'clockHeading', label: 'The clock', type: 'heading' },
      { key: 'start', label: 'Campaign begins', type: 'date', calendar: S.cal, value: campaign.clock.start },
      { key: 'end', label: 'Campaign ends', type: 'date', calendar: S.cal, value: campaign.clock.end,
        hint: 'Just the range the slider covers — extend it whenever you like.' },

      { key: 'calHeading', label: 'Calendar', type: 'heading' },
      { key: 'calendar', label: 'Calendar', type: 'custom', value: campaign.calendar.id,
        render: (setValue, value) => calendarPicker(setValue, value) },

      { key: 'sourceHeading', label: 'Source books', type: 'heading' },
      { key: 'sources', label: 'Books', type: 'custom', value: campaign.sources,
        render: (setValue, value) => sourceList(setValue, value) },
    ],

    onSubmit: (values) => {
      const calendar = values.calendar && typeof values.calendar === 'object'
        ? values.calendar
        : (presetById(values.calendar) || campaign.calendar);

      if (S.cal.dayOf(values.end) <= S.cal.dayOf(values.start)) {
        toast('The campaign has to end after it begins.', 'error');
        return false;
      }

      updateCampaign({
        title: values.title.trim(),
        subtitle: values.subtitle,
        system: values.system,
        calendar: normalizeDef(calendar),
        clock: { ...campaign.clock, start: values.start, end: values.end },
        sources: values.sources,
      });
      emit('campaign-renamed');
      toast('Saved.');
    },
  });
}

/** Preset list plus a live preview, so picking Harptos shows you Harptos. */
function calendarPicker(setValue, currentId) {
  const wrap = el('div', 'calendar-picker');
  const select = el('select');
  const preview = el('div', 'calendar-preview');

  const custom = !PRESETS.some(p => p.id === currentId);
  for (const preset of PRESETS) {
    const option = el('option', null, preset.name);
    option.value = preset.id;
    select.appendChild(option);
  }
  if (custom) {
    const option = el('option', null, `${S.campaign.calendar.name} (this campaign)`);
    option.value = '__current__';
    select.appendChild(option);
  }
  select.value = custom ? '__current__' : currentId;

  function update() {
    const def = select.value === '__current__' ? S.campaign.calendar : presetById(select.value);
    setValue(def);
    const calendar = createCalendar(def);
    const sample = calendar.toDay({ y: calendar.fromDay(S.currentDay).y, m: 1, d: 1 });
    clear(preview);
    preview.appendChild(el('div', null,
      `${calendar.months.length} months · ${calendar.daysInYear(calendar.fromDay(sample).y)} days a year`));
    preview.appendChild(el('div', 'calendar-months',
      calendar.months.map(m => m.name).join(' · ')));
    preview.appendChild(el('div', 'form-hint',
      `Today would read: ${calendar.format(S.currentDay, 'long')}`));
  }

  select.addEventListener('change', update);
  update();

  wrap.appendChild(select);
  wrap.appendChild(preview);
  wrap.appendChild(el('div', 'form-hint',
    'Changing the calendar re-reads every date under the new rules — the numbers stay, their meaning shifts.'));
  return wrap;
}

function sourceList(setValue, sources) {
  const list = [...(sources || [])];
  const wrap = el('div', 'source-list');

  const redraw = () => {
    clear(wrap);
    for (const source of list) {
      const row = el('div', 'source-row');
      row.appendChild(el('span', 'source-title', source.title));
      row.appendChild(el('span', 'sub', source.path || 'no file'));
      row.appendChild(button('Remove', {
        className: 'tiny danger',
        onClick: () => {
          const index = list.indexOf(source);
          if (index >= 0) list.splice(index, 1);
          setValue(list);
          redraw();
        },
      }));
      wrap.appendChild(row);
    }
    if (!list.length) wrap.appendChild(el('div', 'lane-empty', 'No books attached.'));

    wrap.appendChild(button('＋ Attach a book', {
      className: 'tiny add',
      onClick: async () => {
        try {
          const attached = await window.api.sources.attach();
          if (!attached) return;
          const id = attached.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'book';
          list.push({ id, title: attached.title, path: attached.path, kind: 'pdf' });
          setValue(list);
          redraw();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }));
  };

  redraw();
  setValue(list);
  return wrap;
}

// ── New campaign ─────────────────────────────────────────────────────────────

export function newCampaignDialog() {
  formDialog({
    title: 'New campaign',
    confirmLabel: 'Choose a folder…',
    wide: true,
    fields: [
      { key: 'title', label: 'Campaign title', type: 'text', required: true,
        placeholder: 'e.g. The Enemy Within' },
      { key: 'system', label: 'System', type: 'text', placeholder: 'e.g. WFRP 4e' },
      { key: 'calendar', label: 'Calendar', type: 'select',
        options: PRESETS.map(preset => ({ value: preset.id, label: preset.name })),
        value: 'gregorian' },
      { key: 'year', label: 'Starting year', type: 'number', value: new Date().getUTCFullYear(),
        hint: 'The campaign opens on the first day of this year; adjust the range later in settings.' },
    ],

    onSubmit: async (values) => {
      const preset = presetById(values.calendar) || PRESETS[0];
      const calendar = createCalendar(preset);
      const start = calendar.stringify(calendar.toDay({ y: values.year || 1, m: 1, d: 1 }));

      try {
        const result = await window.api.vault.create({
          title: values.title.trim(),
          system: values.system,
          calendar: preset,
          start,
        });
        if (result && result.cancelled) return;
        if (result && result.ok === false) throw new Error(result.error);
        // The main process reopens the window on the new vault, which reloads.
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  });
}

// ── Groups ───────────────────────────────────────────────────────────────────

export function groupsDialog() {
  const body = el('div', 'group-editor');

  const redraw = () => {
    clear(body);
    for (const g of S.campaign.groups) {
      const row = el('div', 'group-row');

      const swatch = el('input', 'group-color');
      swatch.type = 'color';
      swatch.value = g.color;
      swatch.addEventListener('input', () => { g.color = swatch.value; save.campaign(); emit('render'); });

      const name = el('input', 'group-name');
      name.type = 'text';
      name.value = g.name;
      name.addEventListener('input', () => { g.name = name.value; save.campaign(); });

      row.appendChild(swatch);
      row.appendChild(name);
      row.appendChild(button('Remove', {
        className: 'tiny danger',
        onClick: async () => {
          const used = S.campaign.locations.filter(l => l.group === g.id).length
            + S.entities.filter(e => e.group === g.id).length;
          const ok = await confirmDialog({
            title: `Remove ${g.name}?`,
            message: used
              ? `${used} thing${used > 1 ? 's use' : ' uses'} this group. They'll become ungrouped.`
              : 'Nothing uses it.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (!ok) return;
          S.campaign.groups = S.campaign.groups.filter(x => x.id !== g.id);
          for (const location of S.campaign.locations) if (location.group === g.id) location.group = null;
          for (const entity of S.entities) if (entity.group === g.id) entity.group = null;
          reindex();
          save.campaign();
          save.entities();
          redraw();
          emit('render');
        },
      }));
      body.appendChild(row);
    }

    body.appendChild(button('＋ Add a group', {
      className: 'tiny add',
      onClick: () => {
        addGroup({ name: 'New group', color: '#8a8f98' });
        redraw();
        emit('render');
      },
    }));
  };

  redraw();

  formDialog({
    title: 'Groups',
    confirmLabel: 'Done',
    fields: [{ key: 'groups', label: '', type: 'custom', render: () => body }],
    onSubmit: () => { emit('render'); },
  });
}

export { KIND_LABELS };
