/* Everything that lives outside the vault.
 *
 * Play state is kept in the OS's app-data folder rather than in the campaign
 * folder, so replacing the executable — or handing your campaign folder to
 * another GM — never disturbs where your party actually got to.
 *
 * State is namespaced per vault. The old build kept one global state folder,
 * which meant opening a second campaign inherited the first one's NPC
 * positions; anything found there is migrated into the active vault's slot the
 * first time it's opened.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { readJson, writeJsonAtomic } = require('./vault');

const userData = () => app.getPath('userData');

const CONFIG_FILE = () => path.join(userData(), 'config.json');
const STATE_ROOT = () => path.join(userData(), 'state');

// ── Config: which campaigns this install knows about ─────────────────────────

const DEFAULT_CONFIG = {
  activeVault: null,
  vaults: [],           // [{ path, title, lastOpened }]
  ui: {},
  assistant: {},        // provider choice, model ids — never secrets
};

function loadConfig() {
  const raw = readJson(CONFIG_FILE(), null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    vaults: Array.isArray(raw.vaults) ? raw.vaults.filter(v => v && typeof v.path === 'string') : [],
  };
}

function saveConfig(config) {
  writeJsonAtomic(CONFIG_FILE(), config);
  return config;
}

function rememberVault(vaultPath, title) {
  const config = loadConfig();
  const rest = config.vaults.filter(v => path.resolve(v.path) !== path.resolve(vaultPath));
  config.vaults = [{ path: vaultPath, title: title || path.basename(vaultPath), lastOpened: Date.now() }, ...rest]
    .slice(0, 20);
  config.activeVault = vaultPath;
  return saveConfig(config);
}

function forgetVault(vaultPath) {
  const config = loadConfig();
  config.vaults = config.vaults.filter(v => path.resolve(v.path) !== path.resolve(vaultPath));
  if (config.activeVault && path.resolve(config.activeVault) === path.resolve(vaultPath)) {
    config.activeVault = config.vaults[0] ? config.vaults[0].path : null;
  }
  return saveConfig(config);
}

// ── Per-vault play state ─────────────────────────────────────────────────────

/** A short, stable folder name for a vault path. The basename keeps it legible
 *  when someone goes looking; the hash keeps two "Campaign" folders apart. */
function slotFor(vaultPath) {
  const resolved = path.resolve(vaultPath);
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  const base = path.basename(resolved).replace(/[^a-zA-Z0-9-_ ]/g, '').trim().slice(0, 32) || 'campaign';
  return `${base}-${hash}`;
}

class PlayState {
  constructor(vaultPath) {
    this.vaultPath = vaultPath;
    this.dir = path.join(STATE_ROOT(), slotFor(vaultPath));
    fs.mkdirSync(this.dir, { recursive: true });
    this.#migrateGlobalState();
  }

  file(name) {
    return path.join(this.dir, name);
  }

  /** The pre-namespacing build wrote straight into state/. If those files are
   *  there and this vault has no state yet, adopt them — for the person
   *  upgrading, that's their Masks campaign, and losing it would be rude. */
  #migrateGlobalState() {
    const names = ['app-state.json', 'hotspots.json', 'world.json', 'ingest-settings.json'];
    for (const name of names) {
      const legacy = path.join(STATE_ROOT(), name);
      const target = this.file(name);
      if (fs.existsSync(legacy) && !fs.existsSync(target)) {
        try {
          fs.copyFileSync(legacy, target);
        } catch { /* a failed migration just means starting fresh */ }
      }
    }
  }

  load(name, fallback = null) {
    return readJson(this.file(name), fallback);
  }

  save(name, value) {
    try {
      writeJsonAtomic(this.file(name), value);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { loadConfig, saveConfig, rememberVault, forgetVault, PlayState, slotFor, STATE_ROOT };
