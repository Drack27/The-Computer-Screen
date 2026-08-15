/* The renderer, driven in a real browser against the fantasy fixture. */

import { suite, check, checkAsync, assert, equal } from './harness.js';
import { bootRenderer, all, textOf, click, key, input } from './dom.js';

export default async function runRenderer() {
  const app = await bootRenderer('riverlands');
  const { store } = app;
  const { S } = store;
  const D = document;

  suite('renderer · boot');

  check('the campaign loads and names itself', () => {
    equal(textOf('#brand-title'), 'THE RIVERLANDS');
    equal(textOf('#brand-sub'), 'A test campaign on a fantasy calendar');
    return textOf('#brand-title');
  });

  check('the clock speaks Harptos', () => {
    const date = textOf('#clock-date');
    equal(date, '15 Hammer, 1491 DR');
    const tenday = textOf('#clock-weekday');
    assert(S.cal.weekdays.includes(tenday), `"${tenday}" is not a tenday name`);
    return `${date} (${tenday})`;
  });

  check('the countdown finds the next deadline', () => {
    const text = textOf('#clock-doom');
    assert(/until the Nightfall Rite/.test(text), `got "${text}"`);
    return text;
  });

  check('deadline ticks appear under the slider', () => {
    equal(all('#clock-marks .clock-mark').length, 1);
    return '1 mark';
  });

  check('world state is seeded from the entities', () => {
    assert(app.written.world, 'world was never saved');
    equal(app.written.world.movements.length, 5, 'one movement per entity');
    const maren = app.written.world.movements.find(m => m.entity === 'maren-vosk');
    equal(maren.location, 'drowned-crow', 'parked at their home location');
    return `${app.written.world.movements.length} movements`;
  });

  suite('renderer · the map stage');

  check('the world map draws its placed children', () => {
    equal(S.currentLoc, 'world');
    const spots = all('#hotspot-layer .hotspot');
    equal(spots.length, 2, 'the Riverlands and the Frostmarch');
    return spots.map(node => node.textContent).join(', ');
  });

  check('blips resolve up the tree onto the current map', () => {
    // Everyone lives in a pub, a temple or a keep — several levels down — yet
    // each one has to land on the continent that contains them.
    const blips = all('#blip-layer .blip');
    equal(blips.length, 2, 'one cluster per continent');
    const cluster = blips.find(node => node.classList.contains('cluster'));
    assert(cluster, 'expected a cluster');
    return blips.map(node => node.querySelector('.blip-tip').textContent).join(' | ');
  });

  check('cluster counts add up to everyone placed', () => {
    const counts = all('#blip-layer .blip.cluster')
      .map(node => Number(node.firstChild.textContent))
      .filter(Number.isFinite);
    const singles = all('#blip-layer .blip:not(.cluster)').length;
    const total = counts.reduce((sum, n) => sum + n, 0) + singles;
    equal(total, 5, 'all five entities are drawn somewhere');
    return `${total} people on the world map`;
  });

  suite('renderer · navigation');

  check('drilling into a continent', () => {
    const riverlands = all('#hotspot-layer .hotspot').find(node => node.textContent.includes('Riverlands'));
    click(riverlands);
    equal(S.currentLoc, 'riverlands');
    const crumbs = all('.crumb').map(node => node.textContent);
    equal(crumbs.join(' › '), 'The Known World › The Riverlands');
    return crumbs.join(' › ');
  });

  check('layers refresh — no hotspots bleed through from the last map', () => {
    const targets = all('#hotspot-layer .hotspot').map(node => node.textContent);
    assert(!targets.some(text => text.includes('Frostmarch')), `stale: ${targets.join(', ')}`);
    equal(targets.length, 2, 'Kessington and Millhaven');
    return targets.join(', ');
  });

  check('an unplaced child gets a tray rather than a dead end', () => {
    store.goTo('kessington');
    const tray = D.getElementById('unplaced-tray');
    assert(tray, 'no tray rendered');
    const items = all('.tray-item', tray).map(node => node.textContent);
    equal(items.length, 1);
    equal(items[0], 'Temple of Tymora');
    return items[0];
  });

  check('the tray navigates where the map cannot', () => {
    const item = all('#unplaced-tray .tray-item')[0];
    click(item);
    // The temple has no map and no children, so it opens in the panel instead.
    assert(!D.getElementById('panel').classList.contains('hidden'), 'panel stayed closed');
    equal(textOf('#panel-title'), 'Temple of Tymora');
    return 'opened in the panel';
  });

  check('a location with no map still shows what is inside it', () => {
    store.goTo('millhaven');
    const missing = D.querySelector('.map-missing');
    assert(missing, 'no fallback panel');
    assert(/Millhaven/.test(missing.textContent), 'names the place');
    assert(/Add a map image/.test(missing.textContent), 'offers a way forward');
    return 'fallback panel drawn';
  });

  check('backspace walks up the tree', () => {
    key('Backspace');
    equal(S.currentLoc, 'riverlands');
    key('Backspace');
    equal(S.currentLoc, 'world');
    return 'world';
  });

  suite('renderer · the clock drives the map');

  check('scrubbing the slider changes the date', () => {
    const slider = D.getElementById('clock-slider');
    // Festivals take a month slot each, so the fourth month is Ches, not the
    // fourth 30-day month. Tarsakh is the fifth.
    input(slider, String(S.cal.dayOf('1491-04-01')));
    equal(textOf('#clock-date'), '1 Ches, 1491 DR');
    input(slider, String(S.cal.dayOf('1491-05-01')));
    equal(textOf('#clock-date'), '1 Tarsakh, 1491 DR');
    return textOf('#clock-date');
  });

  check('arrow keys nudge, shift jumps a tenday', () => {
    const before = S.currentDay;
    key('ArrowRight');
    equal(S.currentDay, before + 1);
    key('ArrowRight', { shiftKey: true });
    equal(S.currentDay, before + 8);
    key('ArrowLeft', { shiftKey: true });
    key('ArrowLeft');
    equal(S.currentDay, before);
    return 'nudge and jump';
  });

  check('the clock cannot leave the campaign range', () => {
    const startDay = S.cal.dayOf(S.campaign.clock.start);
    store.setDay(startDay - 500);
    equal(S.currentDay, startDay, 'clamped at the start');
    store.setDay(S.cal.dayOf(S.campaign.clock.end) + 500);
    equal(S.currentDay, S.cal.dayOf(S.campaign.clock.end), 'clamped at the end');
    store.setDay(S.cal.dayOf('1491-01-15'));
    return 'clamped both ways';
  });

  check('moving someone changes who is on the map', () => {
    const before = all('#blip-layer .blip').length;
    // Send the choirmaster south for a tenday.
    store.addMovement({ entity: 'sister-oree', location: 'kessington', from: '1491-02-01', to: '1491-02-01' });
    store.setDay(S.cal.dayOf('1491-02-01'));

    const tips = all('#blip-layer .blip-tip').map(node => node.textContent).join(' | ');
    assert(/Sister Oree/.test(tips), `Oree should be visible: ${tips}`);

    store.setDay(S.cal.dayOf('1491-01-15'));
    equal(all('#blip-layer .blip').length, before, 'and back again afterwards');
    return 'movement respected on both sides of the date';
  });

  suite('renderer · rails and panel');

  check('the places rail lists the whole tree', () => {
    D.querySelector('.rail-tab[data-rail="places"]').click();
    const items = all('#rail-body .rail-item');
    equal(items.length, 8, 'every location');
    return `${items.length} places`;
  });

  check('the filter keeps parents of matches', () => {
    const filter = D.getElementById('rail-filter');
    input(filter, 'crow');
    const names = all('#rail-body .rail-item').map(node => node.textContent);
    assert(names.some(name => name.includes('The Drowned Crow')), 'the match itself');
    assert(names.some(name => name.includes('Kessington')), 'its parent, so it stays reachable');
    input(filter, '');
    return names.join(' › ');
  });

  check('the people rail groups by group', () => {
    D.querySelector('.rail-tab[data-rail="people"]').click();
    equal(all('#rail-body .rail-item').length, 5);
    equal(all('#rail-body .rail-group').length, 2);
    return '5 people in 2 groups';
  });

  check('the events rail is sorted and dated', () => {
    D.querySelector('.rail-tab[data-rail="events"]').click();
    const items = all('#rail-body .rail-item');
    equal(items.length, 5, 'every event');
    assert(items[0].textContent.includes('lower mill'), 'earliest first');
    return items.length + ' events';
  });

  await checkAsync('opening an entity shows where they are today', async () => {
    D.querySelector('.rail-tab[data-rail="people"]').click();
    click(all('#rail-body .rail-item')[0]);
    assert(!D.getElementById('panel').classList.contains('hidden'), 'panel closed');
    const body = D.getElementById('panel-body').textContent;
    assert(/On 15 Hammer, 1491 DR/.test(body), `expected a dated line, got: ${body.slice(0, 120)}`);
    assert(/Movements/.test(body), 'movement list missing');
    return textOf('#panel-title');
  });

  check('escape closes the panel', () => {
    key('Escape');
    assert(D.getElementById('panel').classList.contains('hidden'), 'still open');
    return 'closed';
  });

  check('an event jumps the clock to its day', () => {
    D.querySelector('.rail-tab[data-rail="events"]').click();
    const first = all('#rail-body .rail-item')[0];
    click(first);
    const jump = all('#panel-body button').find(node => /Set the clock/.test(node.textContent));
    click(jump);
    equal(S.cal.stringify(S.currentDay), '1491-01-08');
    store.setDay(S.cal.dayOf('1491-01-15'));
    return '1491-01-08';
  });

  suite('renderer · robustness');

  check('prose with angle brackets is text, not markup', () => {
    store.updateEntity('captain-hew', { description: 'Shouts <b>constantly</b> & spits.' });
    store.emit('open-entity', 'captain-hew');
    const body = D.getElementById('panel-body');
    equal(body.querySelectorAll('b').length, 0, 'no injected element');
    assert(/<b>constantly<\/b> & spits/.test(body.textContent), 'text preserved verbatim');
    key('Escape');
    return 'escaped';
  });

  check('no uncaught errors during the whole run', () => {
    if (app.errors.length) throw new Error(app.errors.join(' | '));
    return 'clean';
  });

  return app;
}
