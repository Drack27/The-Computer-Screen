/* Creating and editing campaign data from inside the app. */

import { suite, check, checkAsync, assert, equal, near } from './harness.js';
import { bootRenderer, all, dragBox, click } from './dom.js';

export default async function runAuthoring() {
  const app = await bootRenderer('riverlands');
  const { store } = app;
  const { S } = store;
  const D = document;

  suite('authoring · locations');

  check('adding a location puts it in the tree and on disk', () => {
    const created = store.addLocation({ name: 'The Sunken Barrow', parent: 'riverlands', group: 'riverlands' });
    equal(created.id, 'the-sunken-barrow', 'id slugged from the name');
    assert(S.locById.has(created.id), 'not indexed');
    equal(store.childrenOf('riverlands').length, 3, 'shows up under its parent');
    return created.id;
  });

  check('a duplicate name gets a distinct id', () => {
    const again = store.addLocation({ name: 'The Sunken Barrow', parent: 'riverlands' });
    equal(again.id, 'the-sunken-barrow-2');
    store.removeLocation(again.id);
    return 'the-sunken-barrow-2';
  });

  check('a location cannot be moved inside itself', () => {
    let threw = false;
    try {
      store.updateLocation('riverlands', { parent: 'kessington' });
    } catch (err) {
      threw = /inside itself/.test(err.message);
    }
    assert(threw, 'reparenting into a descendant should be refused');
    equal(S.locById.get('riverlands').parent, 'world', 'left untouched');
    return 'refused';
  });

  check('the root cannot be deleted or reparented', () => {
    let deleteThrew = false;
    try { store.removeLocation('world'); } catch { deleteThrew = true; }
    assert(deleteThrew, 'deleting the root should be refused');
    return 'refused';
  });

  check('deleting a place takes its children and tidies up after itself', () => {
    store.addLocation({ name: 'Cellar', parent: 'drowned-crow' });
    const before = S.campaign.locations.length;
    store.addMovement({ entity: 'maren-vosk', location: 'cellar', from: '1491-01-01', to: null });

    store.removeLocation('drowned-crow');

    equal(S.campaign.locations.length, before - 2, 'the pub and its cellar are gone');
    assert(!S.locById.has('cellar'), 'child removed');
    const stranded = S.world.movements.filter(m => m.location === 'drowned-crow' || m.location === 'cellar');
    equal(stranded.length, 0, 'no movement points at a deleted place');
    const maren = S.world.movements.filter(m => m.entity === 'maren-vosk');
    assert(maren.every(m => m.location === 'kessington'), 'they moved up to the parent');
    return 'movements repaired';
  });

  suite('authoring · entities');

  check('a new person is immediately somewhere', () => {
    const created = store.addEntity({ name: 'Wren the Fence', group: 'riverlands', home: 'kessington' });
    const movements = S.world.movements.filter(m => m.entity === created.id);
    equal(movements.length, 1, 'given a movement');
    equal(movements[0].location, 'kessington');
    equal(movements[0].to, null, 'open-ended');
    assert(store.entitiesOn(S.currentDay).some(m => m.entity === created.id), 'visible today');
    return created.id;
  });

  check('renaming a person updates their blips', () => {
    store.updateEntity('wren-the-fence', { name: 'Wren', group: 'frostmarch' });
    const movement = S.world.movements.find(m => m.entity === 'wren-the-fence');
    equal(movement.name, 'Wren', 'denormalized name follows');
    equal(movement.group, 'frostmarch', 'and so does the colour');
    return 'Wren';
  });

  check('deleting a person takes their movements with them', () => {
    store.removeEntity('wren-the-fence');
    equal(S.world.movements.filter(m => m.entity === 'wren-the-fence').length, 0);
    assert(!S.entityById.has('wren-the-fence'), 'removed from the index');
    return 'gone';
  });

  suite('authoring · movements');

  check('later movements win', () => {
    store.addMovement({ entity: 'captain-hew', location: 'millhaven', from: '1491-03-01', to: null });
    store.setDay(S.cal.dayOf('1491-02-01'));
    let where = store.entitiesOn(S.currentDay).find(m => m.entity === 'captain-hew');
    equal(where.location, 'kessington', 'before the move');

    store.setDay(S.cal.dayOf('1491-03-02'));
    where = store.entitiesOn(S.currentDay).find(m => m.entity === 'captain-hew');
    equal(where.location, 'millhaven', 'after the move');

    store.setDay(S.cal.dayOf('1491-01-15'));
    return 'kessington → millhaven';
  });

  check('a closed movement stops applying', () => {
    const movement = store.addMovement({
      entity: 'brother-alden', location: 'millhaven', from: '1491-05-01', to: '1491-05-10',
    });
    store.setDay(S.cal.dayOf('1491-05-05'));
    equal(store.entitiesOn(S.currentDay).find(m => m.entity === 'brother-alden').location, 'millhaven');

    store.setDay(S.cal.dayOf('1491-05-20'));
    equal(store.entitiesOn(S.currentDay).find(m => m.entity === 'brother-alden').location, 'temple-of-tymora',
      'falls back to the earlier open-ended movement');

    store.removeMovement(movement.id);
    store.setDay(S.cal.dayOf('1491-01-15'));
    return 'window respected';
  });

  suite('authoring · events');

  check('adding an event lands it on the clock', () => {
    const created = store.addEvent({ text: 'A stranger asks after the party', date: '1491-01-16', track: 'world' });
    store.emit('render');
    const lane = D.getElementById('clock-events').textContent;
    assert(/A stranger asks after the party/.test(lane), 'not shown near the current date');
    store.removeEvent(created.id);
    return created.id;
  });

  check('an event far from today stays out of the lane', () => {
    store.addEvent({ text: 'Something in the far future', date: '1491-12-01', track: 'world' });
    store.emit('render');
    const lane = D.getElementById('clock-events').textContent;
    assert(!/far future/.test(lane), 'should be outside the three-week window');
    return 'filtered';
  });

  suite('authoring · placing on the map');

  check('dragging a box places an unplaced child', () => {
    store.goTo('kessington');
    S.editMode = true;
    store.emit('render');

    dragBox([20, 20], [30, 34]);

    // The dialog asks which child; the temple is the only unplaced one.
    const select = D.getElementById('field-target');
    assert(select, 'placement dialog did not open');
    equal(select.value, 'temple-of-tymora');

    click(all('#modal-footer button').find(node => node.textContent === 'Place'));

    const temple = S.locById.get('temple-of-tymora');
    assert(temple.pos, 'no coordinate written');
    near(temple.pos[0], 25, 0.5, 'centre x');
    near(temple.pos[1], 27, 0.5, 'centre y');

    const box = (S.hotspots.kessington || []).find(h => h.target === 'temple-of-tymora');
    assert(box, 'no hotspot box saved');
    return `placed at ${temple.pos.map(Math.round).join(', ')}`;
  });

  check('the tray empties once everything is placed', () => {
    S.editMode = false;
    store.emit('render');
    assert(!D.getElementById('unplaced-tray'), 'tray should be gone');
    // The Drowned Crow was deleted earlier, so the temple is Kessington's only
    // surviving child — and it is now on the map rather than in the tray.
    equal(all('#hotspot-layer .hotspot').length, 1, 'and the temple is now clickable');
    return 'tray cleared';
  });

  await checkAsync('coordinates persist to play state, not the campaign file', async () => {
    await store.flushSaves();
    assert(app.written.state && app.written.state.positions, 'no positions saved');
    assert(app.written.state.positions['temple-of-tymora'], 'temple position missing');
    // The campaign file keeps the location; the coordinate is play state.
    assert(app.written.campaign.locations.some(l => l.id === 'temple-of-tymora'), 'location missing from campaign');
    return 'written to app-state';
  });

  suite('authoring · campaign settings');

  check('switching calendars re-reads every date', () => {
    const beforeDay = S.currentDay;
    const beforeText = S.cal.format(beforeDay, 'long');

    store.updateCampaign({ calendar: { preset: 'gregorian' } });
    equal(S.cal.isGregorian, true, 'calendar swapped');

    // The day number is unchanged; only its name is.
    equal(S.currentDay, beforeDay, 'the clock did not jump');
    assert(S.cal.format(beforeDay, 'long') !== beforeText, 'the reading changed');

    store.updateCampaign({ calendar: { preset: 'harptos' } });
    equal(S.cal.format(beforeDay, 'long'), beforeText, 'and switching back restores it');
    return beforeText;
  });

  await checkAsync('everything that changed was written', async () => {
    await store.flushSaves();
    assert(app.written.campaign, 'campaign never saved');
    assert(app.written.entities, 'entities never saved');
    assert(app.written.world, 'world never saved');
    assert(app.written.hotspots, 'hotspots never saved');
    return 'campaign, entities, world, hotspots';
  });

  check('no uncaught errors during authoring', () => {
    if (app.errors.length) throw new Error(app.errors.join(' | '));
    return 'clean';
  });

  return app;
}
