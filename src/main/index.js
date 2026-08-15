/* Electron main process.
 *
 * Boot order matters: shared/ is ESM and loaded dynamically, so nothing that
 * normalizes a campaign may run before loadShared() resolves.
 */

const { app, BrowserWindow, dialog, session, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { loadShared } = require('./shared');
const { Vault, createVault } = require('./vault');
const { loadConfig, rememberVault, PlayState } = require('./store');
const { buildMenu } = require('./menu');
const { startWatcher } = require('./watcher');
const { registerIpc } = require('./ipc');

const PRODUCT = 'The Computer Screen';

/** Everything the IPC layer and menu need, in one place, so switching
 *  campaigns is a matter of swapping fields rather than restarting. */
const ctx = {
  vault: null,
  play: null,
  win: null,
  watcher: null,
  product: PRODUCT,
  openVault,
  newCampaign,
  chooseVault,
};

// ── Deciding which campaign to open ──────────────────────────────────────────

/** Never block first launch on a folder picker. A GM who just double-clicked
 *  the icon gets an empty campaign they can immediately start typing into;
 *  opening an existing folder is a menu item, not a toll gate. */
function resolveVaultPath() {
  const config = loadConfig();

  if (config.activeVault && isVault(config.activeVault)) return config.activeVault;

  // Carried over from the Masks-era build, which stored the folder here.
  const legacyConfig = path.join(app.getPath('userData'), 'vault-config.json');
  try {
    const legacy = JSON.parse(fs.readFileSync(legacyConfig, 'utf8'));
    if (legacy.vaultPath && isVault(legacy.vaultPath)) return legacy.vaultPath;
  } catch { /* no previous install */ }

  for (const remembered of config.vaults) {
    if (isVault(remembered.path)) return remembered.path;
  }

  // Running from a checkout that sits inside a campaign folder.
  const devGuess = path.join(__dirname, '..', '..', '..');
  if (isVault(devGuess)) return devGuess;

  return null;
}

function isVault(dir) {
  try {
    return !!dir && fs.existsSync(path.join(dir, 'campaign.json'));
  } catch {
    return false;
  }
}

function defaultCampaignDir() {
  return path.join(app.getPath('documents') || app.getPath('userData'), PRODUCT, 'My First Campaign');
}

/** Point the app at a vault and tell the renderer to reload from it. */
function openVault(vaultPath, { reload = true } = {}) {
  if (!isVault(vaultPath)) return { ok: false, error: 'That folder has no campaign.json in it.' };

  if (ctx.watcher) {
    ctx.watcher.close();
    ctx.watcher = null;
  }

  ctx.vault = new Vault(vaultPath);
  ctx.play = new PlayState(vaultPath);

  let title = path.basename(vaultPath);
  try { title = ctx.vault.read().campaign.title; } catch { /* keep the folder name */ }
  rememberVault(vaultPath, title);

  if (ctx.win && !ctx.win.isDestroyed()) {
    ctx.watcher = startWatcher(ctx.vault, ctx.win);
    ctx.win.setTitle(`${title} — ${PRODUCT}`);
    if (reload) ctx.win.webContents.send('vault:changed', { vaultPath });
  }
  buildMenu(ctx);
  return { ok: true, vaultPath, title };
}

function newCampaign(options = {}) {
  const dir = options.dir || defaultCampaignDir();
  try {
    createVault(dir, options);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return openVault(dir);
}

async function chooseVault() {
  const chosen = await dialog.showOpenDialog(ctx.win, {
    title: 'Open a campaign folder',
    message: 'Choose a folder containing campaign.json.',
    properties: ['openDirectory'],
    buttonLabel: 'Open campaign',
  });
  if (chosen.canceled || !chosen.filePaths[0]) return { ok: false, cancelled: true };

  const picked = chosen.filePaths[0];
  if (!isVault(picked)) {
    const answer = await dialog.showMessageBox(ctx.win, {
      type: 'question',
      buttons: ['Start a campaign here', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'No campaign.json in that folder.',
      detail: 'Would you like to start a new campaign in it instead?',
    });
    if (answer.response !== 0) return { ok: false, cancelled: true };
    return newCampaign({ dir: picked, title: path.basename(picked) });
  }
  return openVault(picked);
}

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1040,
    minHeight: 660,
    backgroundColor: '#0b0a0c',
    show: false,
    title: PRODUCT,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Nothing in the app should navigate away from itself, and any http(s) link
  // in a note belongs in the user's browser, not in a chrome-less window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  return win;
}

function iconPath() {
  const png = path.join(__dirname, '..', '..', 'build', 'icon.png');
  return fs.existsSync(png) ? png : undefined;
}

// ── Custom protocol ──────────────────────────────────────────────────────────
// gmapp://maps/<path>  → <vault>/Maps/<path>
// gmapp://root/<path>  → <vault>/<path>
// gmapp://state/<path> → the active vault's play-state folder (portraits etc.)

function registerProtocol() {
  session.defaultSession.protocol.handle('gmapp', async (request) => {
    if (!ctx.vault) return new Response('No campaign open', { status: 503 });

    let url;
    try { url = new URL(request.url); } catch { return new Response('Bad URL', { status: 400 }); }

    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
    let filePath = null;

    if (url.host === 'maps') {
      // mapRoot is remembered from the last read, so serving an image doesn't
      // re-parse and re-normalize the whole campaign.
      filePath = ctx.vault.resolve(rel, path.basename(ctx.vault.mapRoot));
    } else if (url.host === 'root') {
      filePath = ctx.vault.resolve(rel);
    } else if (url.host === 'state' && ctx.play) {
      const target = path.resolve(ctx.play.dir, rel);
      filePath = target.startsWith(ctx.play.dir + path.sep) ? target : null;
    }

    if (!filePath || !fs.existsSync(filePath)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await loadShared();

  let vaultPath = resolveVaultPath();
  if (!vaultPath) {
    // First run on a fresh machine: make one rather than asking.
    const dir = defaultCampaignDir();
    try {
      createVault(dir, { title: 'My First Campaign' });
      vaultPath = dir;
    } catch (err) {
      dialog.showErrorBox('Could not start',
        `${PRODUCT} could not create a campaign folder at:\n${dir}\n\n${err.message}`);
      app.quit();
      return;
    }
  }

  registerProtocol();
  ctx.win = createWindow();
  registerIpc(ctx);
  openVault(vaultPath, { reload: false });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      ctx.win = createWindow();
      openVault(ctx.vault ? ctx.vault.root : vaultPath, { reload: false });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
