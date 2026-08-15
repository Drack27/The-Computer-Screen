/* Stable, readable identifiers.
 *
 * Ids end up in save files and in hand-edited JSON, so they're slugs rather
 * than UUIDs — "ju-ju-house" survives a merge conflict with its meaning intact.
 */

export function slugify(text, fallback = 'item') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')     // strip accents
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** A slug that isn't already taken. `taken` may be a Set, Map, array or object. */
export function uniqueId(text, taken, fallback = 'item') {
  const has = (id) => {
    if (!taken) return false;
    if (taken instanceof Set || taken instanceof Map) return taken.has(id);
    if (Array.isArray(taken)) return taken.includes(id);
    return Object.prototype.hasOwnProperty.call(taken, id);
  };
  const base = slugify(text, fallback);
  if (!has(base)) return base;
  let n = 2;
  while (has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** For records with no meaningful name to slug (movements, chat turns). */
export function randomId(prefix = 'x') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
