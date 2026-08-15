/* Turning a campaign into searchable pieces.
 *
 * Chunks follow the document's own structure — markdown headings, one record
 * per NPC — rather than a fixed character count, so a retrieved passage is
 * something a GM would recognise as a unit and can be cited back by name.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'of', 'on', 'or', 'she', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'to', 'was', 'were', 'what', 'when', 'which', 'who',
  'will', 'with', 'you', 'your',
]);

/** Lowercase word tokens, stopwords dropped, light plural folding so "cultists"
 *  finds "cultist". Deliberately not a real stemmer — over-stemming makes
 *  proper nouns collide, and campaign text is mostly proper nouns. */
function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9'’]+/)) {
    if (!raw) continue;
    const word = raw.replace(/['’]s$/, '');
    if (word.length < 2 || STOPWORDS.has(word)) continue;
    out.push(word.length > 4 && word.endsWith('s') && !word.endsWith('ss')
      ? word.slice(0, -1)
      : word);
  }
  return out;
}

const MAX_CHARS = 1400;

/** Split markdown on headings, then on paragraphs when a section runs long. */
function chunkMarkdown(text, { title, source }) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let heading = title;
  let buffer = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    buffer = [];
    if (body) sections.push({ heading, body });
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim() || title;
    } else {
      buffer.push(line);
    }
  }
  flush();

  const chunks = [];
  for (const section of sections) {
    for (const piece of splitLong(section.body)) {
      chunks.push({
        title: section.heading === title ? title : `${title} — ${section.heading}`,
        text: piece,
        source,
      });
    }
  }
  // Every non-empty section is kept, however short. A two-sentence "behind the
  // screen" note is precisely the passage a GM needs found, and BM25's length
  // normalisation already stops short chunks from dominating the ranking.
  return chunks.filter(chunk => chunk.text.trim().length > 0);
}

/** Break an over-long section on paragraph boundaries, keeping a little overlap
 *  so a sentence spanning the seam is still findable from either side. */
function splitLong(body) {
  if (body.length <= MAX_CHARS) return [body];

  const paragraphs = body.split(/\n{2,}/);
  const out = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length > MAX_CHARS) {
      out.push(current.trim());
      const tail = current.slice(-200);
      current = `${tail}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) out.push(current.trim());

  // A single paragraph longer than the limit still has to be cut somewhere.
  return out.flatMap(piece => (piece.length <= MAX_CHARS * 1.5
    ? [piece]
    : piece.match(new RegExp(`[\\s\\S]{1,${MAX_CHARS}}(\\s|$)`, 'g')) || [piece]));
}

/** Campaign records read better to a model as short labelled prose than as
 *  JSON, and it keeps quoted passages readable when they're cited back. */
function describeEntity(entity, { groupName, locationName }) {
  const lines = [`${entity.name} — ${entity.kind}${entity.role ? `, ${entity.role}` : ''}`];
  if (groupName) lines.push(`Group: ${groupName}`);
  if (locationName) lines.push(`Usually at: ${locationName}`);
  if (entity.age) lines.push(`Age: ${entity.age}`);
  if (entity.summary) lines.push(entity.summary);
  if (entity.description) lines.push(entity.description);
  if (entity.traits) lines.push(`Traits: ${entity.traits}`);
  if (entity.hooks) lines.push(`Roleplaying hooks: ${entity.hooks}`);
  if (entity.stats) lines.push(`Stats: ${entity.stats}`);
  for (const paragraph of entity.prose || []) lines.push(paragraph);
  return lines.join('\n');
}

function describeLocation(location, { groupName, parentName, childNames }) {
  const lines = [`${location.name}${parentName ? ` (inside ${parentName})` : ''}`];
  if (groupName) lines.push(`Group: ${groupName}`);
  if (location.summary) lines.push(location.summary);
  if (childNames && childNames.length) lines.push(`Contains: ${childNames.join(', ')}`);
  return lines.join('\n');
}

function describeEvent(event, { dateLabel, locationName }) {
  const lines = [`${dateLabel}: ${event.text}`];
  if (locationName) lines.push(`Where: ${locationName}`);
  if (event.detail) lines.push(event.detail);
  return lines.join('\n');
}

module.exports = { tokenize, chunkMarkdown, describeEntity, describeLocation, describeEvent };
