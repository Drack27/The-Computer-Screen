const { app, BrowserWindow, ipcMain, session, net, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// The vault is the campaign folder: campaign.json + Maps/ + Data/ + notes.
let VAULT = null;
let STATE_DIR, STATE_FILE, HOTSPOTS_FILE, INGEST_SETTINGS_FILE, WORLD_FILE;

const VENV_DIR = path.join(os.homedir(), '.gm-transcription');
const IS_WIN = process.platform === 'win32';
const VENV_WHISPERX = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'whisperx.exe')
  : path.join(VENV_DIR, 'bin', 'whisperx');

let mainWin = null;

// ── Vault resolution ─────────────────────────────────────────────────────────

const VAULT_CONFIG_FILE = () => path.join(app.getPath('userData'), 'vault-config.json');

function loadSavedVaultPath() {
  try {
    const cfg = JSON.parse(fs.readFileSync(VAULT_CONFIG_FILE(), 'utf8'));
    if (cfg.vaultPath && fs.existsSync(cfg.vaultPath)) return cfg.vaultPath;
  } catch { /* nothing saved yet */ }
  return null;
}

function saveVaultPath(vaultPath) {
  fs.writeFileSync(VAULT_CONFIG_FILE(), JSON.stringify({ vaultPath }, null, 2), 'utf8');
}

function isVault(dir) {
  return fs.existsSync(path.join(dir, 'campaign.json'));
}

function resolveVaultRoot() {
  const saved = loadSavedVaultPath();
  if (saved && isVault(saved)) return saved;

  const devGuess = path.join(__dirname, '..');
  if (isVault(devGuess)) {
    saveVaultPath(devGuess);
    return devGuess;
  }

  const chosen = dialog.showOpenDialogSync({
    title: 'Select your campaign folder',
    message: 'Choose the folder containing campaign.json, Maps/, and your notes.',
    defaultPath: devGuess,
    properties: ['openDirectory'],
    buttonLabel: 'Use this folder',
  });
  if (!chosen || !chosen[0]) return null;
  saveVaultPath(chosen[0]);
  return chosen[0];
}

// ── Safe path helpers ────────────────────────────────────────────────────────

function withinVault(rel, sub) {
  const base = path.resolve(sub ? path.join(VAULT, sub) : VAULT);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── Window & menu ────────────────────────────────────────────────────────────

function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Campaign',
      submenu: [
        {
          label: 'Change Campaign Folder…',
          click: () => {
            try { fs.unlinkSync(VAULT_CONFIG_FILE()); } catch { /* none */ }
            app.relaunch();
            app.exit(0);
          },
        },
        {
          label: 'Open Campaign Folder',
          click: () => shell.openPath(VAULT),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
  ]));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0b0a0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'Masks GM',
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin = win;
  return win;
}

app.whenReady().then(() => {
  VAULT = resolveVaultRoot();
  if (!VAULT) {
    dialog.showErrorBox('No campaign selected',
      'Masks GM needs a campaign folder containing campaign.json. Relaunch to try again.');
    app.quit();
    return;
  }

  const userData = app.getPath('userData');
  STATE_DIR = path.join(userData, 'state');
  STATE_FILE = path.join(STATE_DIR, 'app-state.json');
  HOTSPOTS_FILE = path.join(STATE_DIR, 'hotspots.json');
  WORLD_FILE = path.join(STATE_DIR, 'world.json');
  INGEST_SETTINGS_FILE = path.join(STATE_DIR, 'ingest-settings.json');
  fs.mkdirSync(STATE_DIR, { recursive: true });

  buildAppMenu();

  // gmapp://maps/<path>  → <vault>/Maps/<path>
  // gmapp://root/<path>  → <vault>/<path>
  session.defaultSession.protocol.handle('gmapp', async (request) => {
    const url = new URL(request.url);
    const sub = url.host === 'maps' ? 'Maps' : null;
    const rel = decodeURIComponent(url.pathname.slice(1));
    const filePath = withinVault(rel, sub);
    if (!filePath || !fs.existsSync(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const win = createWindow();
  setupFileWatcher(win);
  attachDiagnostics(win);
  if (process.argv.includes('--selftest')) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => runSelfTest(win), 1200);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC: campaign data ───────────────────────────────────────────────────────

ipcMain.handle('campaign:load', () => {
  const campaign = readJson(path.join(VAULT, 'campaign.json'), null);
  const data = {};
  for (const name of ['npcs', 'timeline', 'maps']) {
    data[name] = readJson(path.join(VAULT, 'Data', name + '.json'), []);
  }
  return { campaign, data, vaultPath: VAULT };
});

ipcMain.handle('list-markdown-files', () => {
  const walk = (dir, prefix = '') => {
    let out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'gm-app') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out = out.concat(walk(path.join(dir, e.name), rel));
      } else if (e.name.endsWith('.md')) {
        out.push(rel);
      }
    }
    return out;
  };
  return walk(VAULT).sort();
});

ipcMain.handle('list-map-files', () => {
  const root = path.join(VAULT, 'Maps');
  const walk = (dir, prefix = '') => {
    let out = [];
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel));
      else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) out.push(rel);
    }
    return out;
  };
  return walk(root).sort();
});

ipcMain.handle('read-file', (_e, filename) => {
  const p = withinVault(filename);
  if (!p || !fs.existsSync(p)) return null;
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
});

ipcMain.handle('open-pdf-at', (_e, pageNumber) => {
  const campaign = readJson(path.join(VAULT, 'campaign.json'), {});
  if (!campaign.pdf) return false;
  const p = withinVault(campaign.pdf);
  if (!p || !fs.existsSync(p)) return false;
  // Most viewers accept #page=N on a file URL.
  shell.openExternal(pathToFileURL(p).toString() + `#page=${pageNumber}`);
  return true;
});

// ── IPC: persisted state ─────────────────────────────────────────────────────

ipcMain.handle('load-state', () => readJson(STATE_FILE, null));
ipcMain.handle('save-state', (_e, s) => writeJson(STATE_FILE, s));
ipcMain.handle('load-hotspots', () => readJson(HOTSPOTS_FILE, {}));
ipcMain.handle('save-hotspots', (_e, h) => writeJson(HOTSPOTS_FILE, h));

// world.json holds everything the clock drives: entity movements, party
// events, and per-location state changes. Seeded from Data/ on first run.
ipcMain.handle('load-world', () => readJson(WORLD_FILE, null));
ipcMain.handle('save-world', (_e, w) => writeJson(WORLD_FILE, w));

// ── IPC: ingest pipeline (carried over from Roselake) ────────────────────────

function sendLog(step, text) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('ingest:log', { step, text });
}

ipcMain.handle('ingest:load-settings', () => readJson(INGEST_SETTINGS_FILE, {}));
ipcMain.handle('ingest:save-settings', (_e, s) => writeJson(INGEST_SETTINGS_FILE, s));

ipcMain.handle('ingest:check-deps', async () => {
  const check = (cmd, args) => new Promise(resolve => {
    const proc = spawn(cmd, args);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', code => resolve({ code, out }));
    proc.on('error', () => resolve({ code: -1, out: '' }));
  });
  const py3 = await check('python3', ['--version']);
  const pyf = await check('python', ['--version']);
  const python = (py3.code === 0 && py3.out.includes('Python 3')) ||
                 (pyf.code === 0 && pyf.out.includes('Python 3'));
  const ffmpeg = (await check('ffmpeg', ['-version'])).code === 0;
  return { python, ffmpeg, venv: fs.existsSync(VENV_DIR), whisperx: fs.existsSync(VENV_WHISPERX) };
});

ipcMain.handle('ingest:pick-file', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Select Session Recording',
    properties: ['openFile'],
    filters: [
      { name: 'Video/Audio', extensions: ['mkv', 'mp4', 'avi', 'mov', 'wav', 'm4a', 'flac'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('ingest:setup-venv', async () => {
  const pyCmd = await new Promise(resolve => {
    const p = spawn('python3', ['--version']);
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', c => resolve(c === 0 && out.includes('Python 3') ? 'python3' : 'python'));
    p.on('error', () => resolve('python'));
  });
  const run = (label, cmd, args) => new Promise((resolve, reject) => {
    sendLog('setup', `[${label}] ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args);
    proc.stdout.on('data', d => sendLog('setup', d.toString()));
    proc.stderr.on('data', d => sendLog('setup', d.toString()));
    proc.on('close', c => (c === 0 ? resolve() : reject(new Error(`${label} exited ${c}`))));
    proc.on('error', reject);
  });
  try {
    if (!fs.existsSync(VENV_DIR)) await run('create venv', pyCmd, ['-m', 'venv', VENV_DIR]);
    const pip = IS_WIN ? path.join(VENV_DIR, 'Scripts', 'pip.exe') : path.join(VENV_DIR, 'bin', 'pip');
    await run('upgrade pip', pip, ['install', '--upgrade', 'pip']);
    await run('install whisperx', pip, ['install', 'whisperx']);
    sendLog('setup', '[done] whisperx installed.');
    return { ok: true };
  } catch (err) {
    sendLog('setup', `[error] ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ingest:run-ffmpeg', async (_e, sourcePath, numTracks) => {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  const wavPath = path.join(dir, base + '.wav');
  const n = parseInt(numTracks, 10) || 1;
  const audioArgs = n > 1
    ? ['-filter_complex', `[0:a]amix=inputs=${n}:duration=longest,dynaudnorm`, '-vn']
    : ['-map', '0:a:0', '-vn'];
  return new Promise(resolve => {
    const proc = spawn('ffmpeg', ['-y', '-i', sourcePath, ...audioArgs, wavPath]);
    proc.stdout.on('data', d => sendLog('ffmpeg', d.toString()));
    proc.stderr.on('data', d => sendLog('ffmpeg', d.toString()));
    proc.on('close', c => resolve(c === 0
      ? { ok: true, wavPath }
      : { ok: false, error: `ffmpeg exited ${c}` }));
    proc.on('error', err => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('ingest:run-whisperx', async (_e, wavPath, numSpeakers, hfToken) => {
  const n = parseInt(numSpeakers, 10) || 1;
  const args = [wavPath, '--model', 'large-v2', '--diarize', '--hf_token', hfToken,
    '--min_speakers', String(n), '--max_speakers', String(n), '--language', 'en',
    '--compute_type', 'int8', '--output_dir', path.dirname(wavPath)];
  return new Promise(resolve => {
    sendLog('whisperx', 'Transcribing — this takes a while.');
    const proc = spawn(VENV_WHISPERX, args);
    proc.stdout.on('data', d => sendLog('whisperx', d.toString()));
    proc.stderr.on('data', d => sendLog('whisperx', d.toString()));
    proc.on('close', c => resolve(c === 0 ? { ok: true } : { ok: false, error: `whisperx exited ${c}` }));
    proc.on('error', err => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('ingest:copy-transcript', (_e, wavPath, outputName) => {
  try {
    const dir = path.dirname(wavPath);
    const base = path.basename(wavPath, '.wav');
    const target = withinVault(path.join('Sessions', outputName + '.txt'));
    if (!target) return { ok: false, error: 'Invalid output name' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    for (const cand of [base + '.txt', base + '_diarized.txt']) {
      const src = path.join(dir, cand);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, target);
        return { ok: true, filename: `Sessions/${outputName}.txt` };
      }
    }
    return { ok: false, error: 'Transcript file not found' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File watcher ─────────────────────────────────────────────────────────────

function setupFileWatcher(win) {
  let chokidar;
  try { chokidar = require('chokidar'); } catch {
    console.warn('chokidar missing — live reload disabled.');
    return;
  }
  const watcher = chokidar.watch(VAULT, {
    ignored: [/node_modules/, /\.git/, /gm-app[\\/]/, /\.(png|jpe?g|gif|webp|pdf)$/i],
    persistent: true,
    ignoreInitial: true,
    depth: 3,
  });
  const notify = (type) => (fp) => {
    if (win.isDestroyed()) return;
    win.webContents.send('file-changed', {
      type,
      filename: path.relative(VAULT, fp).replace(/\\/g, '/'),
    });
  };
  watcher.on('change', notify('change'));
  watcher.on('add', notify('add'));
  watcher.on('unlink', notify('remove'));
}
