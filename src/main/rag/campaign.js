/* Two views of a campaign, for two different jobs.
 *
 *  documentsFor()  everything worth searching, flattened into chunks
 *  briefFor()      what is true *right now* — the date, the place, who is
 *                  standing there — which is the app's actual advantage over
 *                  pasting notes into a chat window
 */

const { chunkMarkdown, describeEntity, describeLocation, describeEvent } = require('./text');

/** Build the searchable corpus. `notes` is [{ path, text }]. */
function documentsFor({ campaign, entities, timeline, world, notes, calendar }) {
  const documents = [];
  const locationById = new Map(campaign.locations.map(l => [l.id, l]));
  const groupById = new Map(campaign.groups.map(g => [g.id, g]));
  const childrenOf = new Map();
  for (const location of campaign.locations) {
    if (!childrenOf.has(location.parent)) childrenOf.set(location.parent, []);
    childrenOf.get(location.parent).push(location.name);
  }

  const groupName = (id) => (groupById.get(id) || {}).name || null;

  for (const entity of entities) {
    if (entity.hidden) continue;
    documents.push({
      id: `entity:${entity.id}`,
      kind: 'entity',
      title: entity.name,
      ref: { kind: 'entity', id: entity.id },
      text: describeEntity(entity, {
        groupName: groupName(entity.group),
        locationName: entity.home ? (locationById.get(entity.home) || {}).name : null,
      }),
    });
  }

  for (const location of campaign.locations) {
    if (location.hidden) continue;
    // A location with no prose and nothing inside it is just a name; indexing
    // it adds a result that can never answer anything.
    const children = childrenOf.get(location.id) || [];
    if (!location.summary && !children.length) continue;

    const text = describeLocation(location, {
      groupName: groupName(location.group),
      parentName: location.parent ? (locationById.get(location.parent) || {}).name : null,
      childNames: children,
    });
    documents.push({
      id: `location:${location.id}`,
      kind: 'location',
      title: location.name,
      ref: { kind: 'location', id: location.id },
      text,
    });
  }

  const events = (world && world.events && world.events.length) ? world.events : timeline;
  for (const event of events || []) {
    const day = calendar.dayOf(event.date);
    documents.push({
      id: `event:${event.id}`,
      kind: 'event',
      title: event.text,
      ref: { kind: 'event', id: event.id },
      text: describeEvent(event, {
        dateLabel: day == null ? event.date : calendar.format(day, 'long'),
        locationName: event.location ? (locationById.get(event.location) || {}).name : null,
      }),
    });
  }

  for (const note of notes || []) {
    const title = note.path.split('/').pop().replace(/\.md$/i, '');
    const chunks = chunkMarkdown(note.text, { title, source: note.path });
    chunks.forEach((chunk, index) => {
      documents.push({
        id: `note:${note.path}#${index}`,
        kind: 'note',
        title: chunk.title,
        ref: { kind: 'note', id: note.path },
        text: chunk.text,
      });
    });
  }

  return documents;
}

/** The state of the world on the current date, as short prose. This is what
 *  lets the assistant answer "who's here?" without searching for anything. */
function briefFor({ campaign, entities, world, calendar, currentDate, currentLocation }) {
  const day = calendar.dayOf(currentDate);
  const locationById = new Map(campaign.locations.map(l => [l.id, l]));
  const entityById = new Map(entities.map(e => [e.id, e]));

  const lines = [];
  lines.push(`Campaign: ${campaign.title}${campaign.system ? ` (${campaign.system})` : ''}`);
  lines.push(`Calendar: ${calendar.name}`);
  lines.push(`Today in the campaign: ${day == null ? currentDate : calendar.format(day, 'long')}`);

  // Where the GM is looking, with its containing places, so "here" is unambiguous.
  const chain = [];
  let current = locationById.get(currentLocation);
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current.name);
    current = current.parent ? locationById.get(current.parent) : null;
  }
  if (chain.length) lines.push(`The GM is looking at: ${chain.join(' › ')}`);

  // Everyone whose movement window covers today.
  const here = [];
  const elsewhere = [];
  const latest = new Map();
  for (const movement of (world && world.movements) || []) {
    const from = calendar.dayOf(movement.from);
    const to = movement.to == null ? Infinity : calendar.dayOf(movement.to);
    if (from == null || day == null || day < from || day > to) continue;
    const previous = latest.get(movement.entity);
    if (!previous || from >= calendar.dayOf(previous.from)) latest.set(movement.entity, movement);
  }

  const inside = new Set(descendantIds(campaign, currentLocation));
  for (const movement of latest.values()) {
    const entity = entityById.get(movement.entity);
    if (!entity || entity.hidden) continue;
    const where = (locationById.get(movement.location) || {}).name || 'somewhere';
    const label = `${entity.name}${entity.role ? ` (${entity.role})` : ''} — ${where}`;
    if (inside.has(movement.location)) here.push(label);
    else elsewhere.push(label);
  }

  if (here.length) {
    lines.push('', `Present in ${chain[chain.length - 1] || 'this place'} today:`);
    for (const label of here) lines.push(`  · ${label}`);
  } else {
    lines.push('', 'Nobody is placed here on this date.');
  }
  if (elsewhere.length) {
    lines.push('', 'Elsewhere in the campaign today:');
    for (const label of elsewhere.slice(0, 25)) lines.push(`  · ${label}`);
    if (elsewhere.length > 25) lines.push(`  · …and ${elsewhere.length - 25} more`);
  }

  // Events within a few weeks, which is what a GM is usually steering toward.
  const near = [];
  for (const event of (world && world.events) || []) {
    const eventDay = calendar.dayOf(event.date);
    if (eventDay == null || day == null) continue;
    const gap = eventDay - day;
    if (Math.abs(gap) <= 30) near.push({ event, gap, eventDay });
  }
  near.sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap));
  if (near.length) {
    lines.push('', 'Events near this date:');
    for (const { event, gap, eventDay } of near.slice(0, 10)) {
      const when = gap === 0 ? 'today' : gap > 0 ? `in ${gap} days` : `${-gap} days ago`;
      lines.push(`  · ${calendar.format(eventDay, 'short')} (${when}) — ${event.text}`);
    }
  }

  for (const mark of campaign.clock.marks || []) {
    const markDay = calendar.dayOf(mark.date);
    if (markDay == null || day == null || markDay < day) continue;
    lines.push('', `Deadline: ${mark.label} in ${markDay - day} days (${calendar.format(markDay, 'long')}).`);
    break;
  }

  return lines.join('\n');
}

function descendantIds(campaign, rootId) {
  const children = new Map();
  for (const location of campaign.locations) {
    if (!children.has(location.parent)) children.set(location.parent, []);
    children.get(location.parent).push(location.id);
  }
  const out = [];
  const walk = (id) => {
    out.push(id);
    for (const child of children.get(id) || []) walk(child);
  };
  if (rootId) walk(rootId);
  return out;
}

module.exports = { documentsFor, briefFor };
