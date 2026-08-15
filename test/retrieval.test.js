/* Search and the live campaign brief — the parts of the assistant that work
 * without a model, a key, or a network. */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { suite, check, assert, equal } from './harness.js';
import { normalizeCampaign, normalizeEntities, normalizeTimeline } from '../shared/schema.js';
import { createCalendar } from '../shared/calendar.js';
import { SearchIndex } from '../src/main/rag/search.js';
import { tokenize, chunkMarkdown } from '../src/main/rag/text.js';
import { documentsFor, briefFor } from '../src/main/rag/campaign.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (file) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'riverlands', file), 'utf8'));

const NOTE = `# The Hollow Keep

The keep has stood empty since the Duke's men left. Locals will not walk the
road past it after dark, and the shepherds have started losing animals.

## What the players can learn

Asking in Kessington turns up three things: the singing started at midwinter,
Sister Oree was seen buying lamp oil in quantity, and nobody has seen the
old caretaker since the thaw.

## Behind the screen

The Pale Choir are keeping the caretaker alive in the cistern. He is the only
person who knows where the lower door is.
`;

export default function runRetrieval() {
  const campaign = normalizeCampaign(read('campaign.json'));
  const entities = normalizeEntities(read('entities.json'), campaign);
  const timeline = normalizeTimeline(read('timeline.json'), campaign);
  const calendar = createCalendar(campaign.calendar);

  const world = {
    movements: [
      { id: 'm1', entity: 'maren-vosk', name: 'Maren Vosk', location: 'drowned-crow', from: '1491-01-01', to: null },
      { id: 'm2', entity: 'sister-oree', name: 'Sister Oree', location: 'hollow-keep', from: '1491-01-01', to: null },
      { id: 'm3', entity: 'captain-hew', name: 'Captain Hew', location: 'kessington', from: '1491-01-01', to: null },
    ],
    events: timeline,
  };

  const documents = documentsFor({
    campaign, entities, timeline, world, calendar,
    notes: [{ path: 'Notes/The Hollow Keep.md', text: NOTE }],
  });

  suite('retrieval · chunking');

  check('markdown splits on its own headings', () => {
    const chunks = chunkMarkdown(NOTE, { title: 'The Hollow Keep', source: 'note.md' });
    assert(chunks.length >= 3, `expected several sections, got ${chunks.length}`);
    assert(chunks.some(chunk => /What the players can learn/.test(chunk.title)), 'heading kept in the title');
    assert(chunks.every(chunk => chunk.text.length < 2200), 'no runaway chunk');
    return `${chunks.length} chunks`;
  });

  check('tokenizing folds plurals but leaves names alone', () => {
    const tokens = tokenize('The cultists of Nyarlathotep were watching the shepherds');
    assert(tokens.includes('cultist'), 'cultists → cultist');
    assert(tokens.includes('shepherd'), 'shepherds → shepherd');
    assert(tokens.includes('nyarlathotep'), 'proper noun preserved');
    assert(!tokens.includes('the'), 'stopword dropped');
    return tokens.join(' ');
  });

  suite('retrieval · the corpus');

  check('every kind of campaign record becomes searchable', () => {
    const kinds = new Set(documents.map(document => document.kind));
    for (const kind of ['entity', 'location', 'event', 'note']) {
      assert(kinds.has(kind), `no ${kind} documents`);
    }
    return `${documents.length} documents across ${kinds.size} kinds`;
  });

  check('a location with nothing written about it is not indexed', () => {
    // Millhaven has a name and nothing else; indexing it would only add noise.
    const ids = new Set(documents.map(document => document.id));
    assert(!ids.has('location:millhaven'), 'bare location should be skipped');
    assert(ids.has('location:kessington') || ids.has('location:riverlands'), 'described ones are kept');
    return 'skipped';
  });

  suite('retrieval · search');

  const index = new SearchIndex();
  index.build(documents);

  check('finds a person by their role rather than their name', () => {
    const hits = index.search('who runs the inn');
    assert(hits.length, 'no hits');
    assert(hits.slice(0, 3).some(hit => hit.title === 'Maren Vosk'),
      `expected Maren Vosk near the top, got ${hits.slice(0, 3).map(h => h.title).join(', ')}`);
    return hits[0].title;
  });

  check('finds a note passage by its content', () => {
    const hits = index.search('who has been buying lamp oil');
    assert(hits.length, 'no hits');
    assert(hits[0].kind === 'note', `expected a note, got ${hits[0].kind}`);
    assert(/lamp oil/.test(hits[0].text), 'the passage should contain the answer');
    return hits[0].title;
  });

  check('a question about nothing returns nothing rather than noise', () => {
    equal(index.search('zzzxqq').length, 0);
    equal(index.search('   ').length, 0);
    return 'empty';
  });

  check('results can be narrowed to one kind', () => {
    const hits = index.search('keep', { kinds: ['location'] });
    assert(hits.every(hit => hit.kind === 'location'), 'filter leaked');
    return `${hits.length} locations`;
  });

  check('the index survives a save and reload', () => {
    const restored = new SearchIndex(JSON.parse(JSON.stringify(index.toJSON())));
    equal(restored.size, index.size, 'same number of chunks');
    const before = index.search('lamp oil')[0];
    const after = restored.search('lamp oil')[0];
    equal(after.id, before.id, 'same top hit');
    assert(Math.abs(after.score - before.score) < 1e-9, 'same score');
    return `${restored.size} chunks round-tripped`;
  });

  suite('retrieval · the live brief');

  check('the brief states the date in the campaign calendar', () => {
    const brief = briefFor({
      campaign, entities, world, calendar,
      currentDate: '1491-01-15',
      currentLocation: 'kessington',
    });
    assert(/15 Hammer, 1491 DR/.test(brief), 'campaign date missing');
    assert(/Calendar of Harptos/.test(brief), 'calendar not named');
    return '15 Hammer, 1491 DR';
  });

  check('it separates who is here from who is elsewhere', () => {
    const brief = briefFor({
      campaign, entities, world, calendar,
      currentDate: '1491-01-15',
      currentLocation: 'kessington',
    });
    const [hereSection, elsewhereSection] = brief.split('Elsewhere in the campaign today:');
    assert(/Maren Vosk/.test(hereSection), 'Maren is inside Kessington and should be here');
    assert(/Captain Hew/.test(hereSection), 'Captain Hew is in Kessington itself');
    assert(elsewhereSection && /Sister Oree/.test(elsewhereSection),
      'Sister Oree is in the Frostmarch and should be elsewhere');
    return 'presence resolved through the location tree';
  });

  check('moving the clock changes who the brief reports', () => {
    const later = {
      ...world,
      movements: [...world.movements,
        { id: 'm4', entity: 'sister-oree', name: 'Sister Oree', location: 'kessington', from: '1491-02-01', to: null }],
    };
    const brief = briefFor({
      campaign, entities, world: later, calendar,
      currentDate: '1491-02-02',
      currentLocation: 'kessington',
    });
    const [hereSection] = brief.split('Elsewhere in the campaign today:');
    assert(/Sister Oree/.test(hereSection), 'she should have arrived by February');
    return 'movement respected';
  });

  check('an upcoming deadline is called out', () => {
    const brief = briefFor({
      campaign, entities, world, calendar,
      currentDate: '1491-07-01',
      currentLocation: 'world',
    });
    assert(/Deadline: the Nightfall Rite/.test(brief), 'the mark should be surfaced');
    return 'deadline surfaced';
  });

  check('a campaign with no movements still produces a usable brief', () => {
    const brief = briefFor({
      campaign, entities, world: { movements: [], events: [] }, calendar,
      currentDate: '1491-01-15',
      currentLocation: 'kessington',
    });
    assert(/Nobody is placed here/.test(brief), 'should say so plainly');
    assert(brief.length > 80, 'still describes the campaign');
    return 'graceful';
  });
}
