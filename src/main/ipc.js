/* Every channel the renderer can reach.
 *
 * The renderer has no Node access, so this is the whole surface: reads and
 * writes go through here, and each one is bounded by the vault's path guard.
 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, app } = require('electron');
const { pathToFileURL } = require('url');

const { shared } = require('./shared');
const { loadConfig, saveConfig, forgetVault } = require('./store');
const { sanitizeFilename } = require('./vault');

function registerIpc(ctx) {
  const need = () => {
    if (!ctx.vault) throw new Error('No campaign is open.');
    return ctx.vault;
  };

  // Wrap every handler so a thrown error arrives as a value the renderer can
  // show in a toast, rather than an unhandled rejection in the console.
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        console.error(`[ipc ${channel}]`, err);
        return { ok: false, error: err.message || String(err) };
      }
    });
  };

  // ── Campaign document ──────────────────────────────────────────────────────

  handle('campaign:load', () => {
    const vault = need();
    const doc = vault.read();
    const { validateCampaign } = shared();
    const world = ctx.play.load('world.json', null);
    return {
      ...doc,
      vaultPath: vault.root,
      state: ctx.play.load('app-state.json', null),
      hotspots: ctx.play.load('hotspots.json', {}),
      world,
      problems: validateCampaign(doc.campaign, { entities: doc.entities, world }),
      product: ctx.product,
      version: app.getVersion(),
    };
  });

  handle('campaign:save', (campaign) => {
    const vault = need();
    const { normalizeCampaign } = shared();
    const clean = normalizeCampaign(campaign);
    vault.writeCampaign(clean);
    if (ctx.win && !ctx.win.isDestroyed()) ctx.win.setTitle(`${clean.title} — ${ctx.product}`);
    return clean;
  });

  handle('entities:save', (entities) => {
    const vault = need();
    const { normalizeEntities } = shared();
    const clean = normalizeEntities(entities, vault.read().campaign);
    vault.writeEntities(clean);
    return clean;
  });

  handle('timeline:save', (timeline) => {
    const vault = need();
    const { normalizeTimeline } = shared();
    const clean = normalizeTimeline(timeline, vault.read().campaign);
    vault.writeTimeline(clean);
    return clean;
  });

  // ── Play state (outside the vault) ─────────────────────────────────────────

  handle('state:load', () => ctx.play.load('app-state.json', null));
  handle('state:save', (state) => ctx.play.save('app-state.json', state));
  handle('hotspots:load', () => ctx.play.load('hotspots.json', {}));
  handle('hotspots:save', (hotspots) => ctx.play.save('hotspots.json', hotspots));
  handle('world:load', () => ctx.play.load('world.json', null));
  handle('world:save', (world) => ctx.play.save('world.json', world));

  // ── Notes and maps ─────────────────────────────────────────────────────────

  handle('notes:list', () => need().listNotes());
  handle('notes:read', (rel) => need().readNote(rel));
  handle('notes:write', (rel, text) => {
    if (typeof text !== 'string') throw new Error('Note body must be text.');
    if (!need().writeNote(rel, text)) throw new Error(`Could not write ${rel}`);
    return true;
  });

  handle('notes:create', (folder, title) => {
    const vault = need();
    const base = sanitizeFilename(title || 'Untitled');
    const dir = folder ? sanitizeFilename(folder) : '';
    let rel = dir ? `${dir}/${base}.md` : `${base}.md`;
    let n = 2;
    while (fs.existsSync(vault.resolve(rel) || '')) {
      rel = dir ? `${dir}/${base}-${n}.md` : `${base}-${n}.md`;
      n++;
    }
    vault.writeNote(rel, `# ${title || 'Untitled'}\n\n`);
    return rel;
  });

  handle('maps:list', () => need().listMaps());

  handle('maps:import', async (preferredName) => {
    const vault = need();
    const picked = await dialog.showOpenDialog(ctx.win, {
      title: 'Choose a map image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    return vault.importMap(picked.filePaths[0], preferredName);
  });

  // ── Source books ───────────────────────────────────────────────────────────

  handle('sources:open', (sourceId, page) => {
    const vault = need();
    const { campaign } = vault.read();
    const source = campaign.sources.find(s => s.id === sourceId) || campaign.sources[0];
    if (!source || !source.path) throw new Error('That source has no file attached.');
    const file = vault.resolve(source.path);
    if (!file || !fs.existsSync(file)) throw new Error(`Missing source file: ${source.path}`);
    const url = pathToFileURL(file).toString() + (page ? `#page=${page}` : '');
    shell.openExternal(url);
    return true;
  });

  handle('sources:attach', async () => {
    const vault = need();
    const picked = await dialog.showOpenDialog(ctx.win, {
      title: 'Attach a source book',
      properties: ['openFile'],
      filters: [
        { name: 'Books', extensions: ['pdf', 'epub', 'md', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;

    const chosen = picked.filePaths[0];
    // Keep the file where it is if it already lives in the vault; otherwise
    // copy it in so the campaign folder stays self-contained.
    const inside = chosen.startsWith(vault.root + path.sep);
    let rel;
    if (inside) {
      rel = path.relative(vault.root, chosen).replace(/\\/g, '/');
    } else {
      const name = sanitizeFilename(path.basename(chosen, path.extname(chosen))) + path.extname(chosen);
      fs.copyFileSync(chosen, vault.file(name));
      rel = name;
    }
    return { path: rel, title: path.basename(chosen, path.extname(chosen)) };
  });

  // ── Vault management ───────────────────────────────────────────────────────

  handle('vault:choose', () => ctx.chooseVault());
  handle('vault:open', (vaultPath) => ctx.openVault(vaultPath));
  handle('vault:reveal', () => shell.openPath(need().root));
  handle('vault:recent', () => loadConfig().vaults);
  handle('vault:forget', (vaultPath) => forgetVault(vaultPath).vaults);

  handle('vault:new', async (options) => {
    let dir = options && options.dir;
    if (!dir) {
      const picked = await dialog.showOpenDialog(ctx.win, {
        title: 'Where should the campaign folder go?',
        message: 'Pick a parent folder. A new folder will be created inside it.',
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: 'Create here',
      });
      if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
      dir = path.join(picked.filePaths[0], sanitizeFilename(options.title || 'New Campaign'));
    }
    if (fs.existsSync(path.join(dir, 'campaign.json'))) {
      throw new Error('There is already a campaign in that folder.');
    }
    return ctx.newCampaign({ ...options, dir });
  });

  // ── App preferences ────────────────────────────────────────────────────────

  handle('config:load', () => loadConfig());
  handle('config:save', (patch) => {
    const config = loadConfig();
    return saveConfig({ ...config, ...patch, vaults: config.vaults });
  });
}

module.exports = { registerIpc };
