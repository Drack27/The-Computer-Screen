/* Normalization and the migration from the Masks-era layout. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { suite, check, assert, equal } from './harness.js';
import {
  normalizeCampaign, normalizeEntities, normalizeTimeline, normalizeWorld,
  blankCampaign, validateCampaign,
} from '../shared/schema.js';
import { createCalendar } from '../shared/calendar.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const readFixture = (name, file) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, name, file), 'utf8'));

export default function runSchema() {
  suite('schema · migration from the old layout');

  const raw = readFixture('legacy', 'campaign.json');
  const campaign = normalizeCampaign(raw);

  check('chapters become groups, keeping their colours', () => {
    equal(campaign.groups.length >= 2, true, 'at least the two declared groups');
    const newYork = campaign.groups.find(g => g.id === 'newyork');
    assert(newYork, 'newyork group missing');
    equal(newYork.color, '#c0392b', 'declared colour kept');
    const london = campaign.groups.find(g => g.id === 'london');
    assert(london && london.color, 'a group with no colour still gets one');
    return `${campaign.groups.length} groups`;
  });

  check('a group referenced only by a location is invented', () => {
    // "front" appears on the root location but is not in the chapters list.
    const front = campaign.groups.find(g => g.id === 'front');
    assert(front, 'front should have been created');
    equal(front.name, 'Front', 'name derived from the id');
    return 'front';
  });

  check('the single pdf becomes a source, and bare pages point at it', () => {
    equal(campaign.sources.length, 1, 'one source');
    equal(campaign.sources[0].path, 'Sourcebook.pdf');
    const newYork = campaign.locations.find(l => l.id === 'newyork');
    equal(newYork.source.source, campaign.sources[0].id, 'page reference bound to the book');
    equal(newYork.source.page, 24, 'page number kept');
    return `${campaign.sources[0].id} p.24`;
  });

  check('doomsday becomes a clock mark', () => {
    const doom = campaign.clock.marks.find(m => m.kind === 'doom');
    assert(doom, 'no doom mark');
    equal(doom.date, '1925-10-31');
    equal(doom.label, 'the rite');
    return doom.label;
  });

  check('no calendar declared means Gregorian', () => {
    equal(campaign.calendar.kind, 'gregorian');
    const calendar = createCalendar(campaign.calendar);
    equal(calendar.format(calendar.dayOf('1925-05-01'), 'long'), '1 May 1925');
    return 'gregorian';
  });

  suite('schema · repairing broken data');

  check('a dangling parent is reattached to the root', () => {
    const orphan = campaign.locations.find(l => l.id === 'orphan');
    equal(orphan.parent, 'world', 'reattached');
    return 'orphan → world';
  });

  check('a parent cycle is broken', () => {
    const byId = new Map(campaign.locations.map(l => [l.id, l]));
    // Walking up from any node must terminate.
    for (const location of campaign.locations) {
      let current = location;
      let steps = 0;
      while (current && current.parent) {
        current = byId.get(current.parent);
        if (++steps > campaign.locations.length) throw new Error(`cycle still reachable from ${location.id}`);
      }
    }
    return 'every path terminates';
  });

  check('exactly one root survives', () => {
    const roots = campaign.locations.filter(l => l.parent === null);
    equal(roots.length, 1, 'one root');
    equal(roots[0].id, 'world');
    return 'world';
  });

  check('an unparseable date is dropped, not kept as NaN', () => {
    const timeline = normalizeTimeline(readFixture('legacy', 'Data/timeline.json'), campaign);
    equal(timeline.length, 2, 'the bad row is gone');
    assert(timeline.every(event => /^\d{4}-\d{2}-\d{2}$/.test(event.date)), 'dates normalized');
    return `${timeline.length} events kept`;
  });

  suite('schema · entities');

  const entities = normalizeEntities(readFixture('legacy', 'Data/npcs.json'), campaign);

  check('npcs keep their chapter as a group and gain a kind', () => {
    const elias = entities.find(e => e.id === 'jackson-elias');
    equal(elias.group, 'newyork');
    equal(elias.kind, 'npc', 'defaults to npc');
    equal(elias.source.page, 22, 'page migrated');
    equal(elias.links[0].text, 'Wrote to the investigators');
    return `${entities.length} entities`;
  });

  check('duplicate ids are made unique instead of overwriting', () => {
    const doubled = normalizeEntities([
      { id: 'twin', name: 'Twin A' },
      { id: 'twin', name: 'Twin B' },
    ], campaign);
    equal(doubled.length, 2);
    assert(doubled[0].id !== doubled[1].id, 'ids must differ');
    return doubled.map(e => e.id).join(', ');
  });

  suite('schema · world state');

  check('movements pointing at deleted places are repaired', () => {
    const world = normalizeWorld({
      movements: [
        { entity: 'jackson-elias', location: 'harlem', from: '1925-05-01', to: null },
        { entity: 'silas-n-mkwei', location: 'a-place-that-burned-down', from: '1925-05-01', to: null },
        { location: 'harlem', from: '1925-05-01' },
      ],
      events: [],
    }, campaign, entities);
    equal(world.movements.length, 2, 'the entity-less row is dropped');
    equal(world.movements[1].location, campaign.locations[0].id, 'unknown location falls back');
    equal(world.movements[0].name, 'Jackson Elias', 'name filled in from the entity');
    return '2 movements';
  });

  suite('schema · new campaigns');

  check('a blank campaign is immediately usable', () => {
    const fresh = blankCampaign({ title: 'Test Campaign' });
    equal(fresh.locations.length, 1, 'one root location');
    equal(fresh.locations[0].parent, null);
    const calendar = createCalendar(fresh.calendar);
    assert(calendar.dayOf(fresh.clock.end) > calendar.dayOf(fresh.clock.start), 'end after start');
    equal(validateCampaign(fresh, { entities: [] }).filter(p => p.level === 'error').length, 0, 'no errors');
    return fresh.clock.start + ' → ' + fresh.clock.end;
  });

  check('an end before the start is corrected', () => {
    const broken = normalizeCampaign({
      title: 'Backwards',
      clock: { start: '1925-05-01', end: '1900-01-01' },
    });
    const calendar = createCalendar(broken.calendar);
    assert(calendar.dayOf(broken.clock.end) > calendar.dayOf(broken.clock.start), 'range repaired');
    return `${broken.clock.start} → ${broken.clock.end}`;
  });

  check('a campaign of nothing at all still normalizes', () => {
    const empty = normalizeCampaign(null);
    equal(empty.title, 'Untitled Campaign');
    equal(empty.locations.length, 0);
    assert(Array.isArray(empty.groups), 'groups is a list');
    const problems = validateCampaign(empty, {});
    assert(problems.some(p => p.level === 'error'), 'should flag the missing locations');
    return `${problems.length} problems reported`;
  });

  suite('schema · the fantasy fixture');

  check('a preset calendar reference is expanded', () => {
    const riverlands = normalizeCampaign(readFixture('riverlands', 'campaign.json'));
    equal(riverlands.calendar.kind, 'custom');
    equal(riverlands.calendar.months.length, 17, 'Harptos months plus festivals');
    const calendar = createCalendar(riverlands.calendar);
    equal(calendar.format(calendar.dayOf('1491-01-15'), 'long'), '15 Hammer, 1491 DR');
    return 'Harptos expanded from "preset"';
  });
}
