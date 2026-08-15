/* The app writes into the same folder it watches, so without this every save
 * would bounce back as a "file changed on disk" and re-render on top of the
 * user's cursor. Writes announce themselves here; the watcher checks. */

const path = require('path');

const recent = new Map();   // absolute path → timestamp
const WINDOW_MS = 1500;

function note(file) {
  const key = path.resolve(file);
  recent.set(key, Date.now());
  if (recent.size > 200) prune();
}

function isRecent(file) {
  const key = path.resolve(file);
  const at = recent.get(key);
  if (at == null) return false;
  if (Date.now() - at > WINDOW_MS) {
    recent.delete(key);
    return false;
  }
  return true;
}

function prune() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [key, at] of recent) if (at < cutoff) recent.delete(key);
}

module.exports = { note, isRecent };
