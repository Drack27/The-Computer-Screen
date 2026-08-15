/* Live reload when the vault changes underneath us.
 *
 * A GM editing notes in Obsidian while the app is open should see the change
 * without restarting. Writes the app made itself are filtered out, or every
 * save would echo back as an external change.
 */

const path = require('path');
const selfWrites = require('./selfwrites');

const IGNORED = [
  /(^|[\\/])\../,                  // dotfiles, including our .tmp writes
  /node_modules/,
  /[\\/]Extracted[\\/]/,
  /\.(pdf|zip|mp4|mkv|wav|m4a|gguf|onnx)$/i,
];

function startWatcher(vault, win) {
  let chokidar;
  try {
    chokidar = require('chokidar');
  } catch {
    console.warn('chokidar not installed — live reload disabled.');
    return null;
  }

  const watcher = chokidar.watch(vault.root, {
    ignored: IGNORED,
    persistent: true,
    ignoreInitial: true,
    depth: 6,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 60 },
  });

  const notify = (type) => (filePath) => {
    if (!win || win.isDestroyed()) return;
    if (selfWrites.isRecent(filePath)) return;
    win.webContents.send('vault:file-changed', {
      type,
      path: path.relative(vault.root, filePath).replace(/\\/g, '/'),
    });
  };

  watcher.on('change', notify('change'));
  watcher.on('add', notify('add'));
  watcher.on('unlink', notify('remove'));
  watcher.on('error', (err) => console.warn('watcher error:', err.message));

  return watcher;
}

module.exports = { startWatcher };
