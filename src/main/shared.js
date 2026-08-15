/* Bridge from the CommonJS main process to the ES modules in shared/.
 *
 * The main process stays CJS because that's the path of least resistance for
 * Electron and its native dependencies; shared/ is ESM so the renderer can
 * import it directly with a plain <script type="module">. Dynamic import is
 * the seam. Paths go through pathToFileURL or Windows drive letters break it.
 */

const path = require('path');
const { pathToFileURL } = require('url');

const SHARED_DIR = path.join(__dirname, '..', '..', 'shared');

let cache = null;

async function loadShared() {
  if (cache) return cache;
  const load = (file) => import(pathToFileURL(path.join(SHARED_DIR, file)).href);
  const [calendar, schema, ids] = await Promise.all([
    load('calendar.js'),
    load('schema.js'),
    load('ids.js'),
  ]);
  cache = { ...calendar, ...schema, ...ids };
  return cache;
}

/** Synchronous access once loadShared() has resolved — call it at startup and
 *  everything after may assume it's there. */
function shared() {
  if (!cache) throw new Error('shared modules used before loadShared()');
  return cache;
}

module.exports = { loadShared, shared };
