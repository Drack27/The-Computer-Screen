/* The only bridge between the renderer and Node.
 *
 * Main returns { ok, value } | { ok:false, error }; this unwraps it so renderer
 * code can write `await api.notes.read(f)` in a try/catch and forget that IPC
 * is involved at all.
 */

const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const createDOMPurify = require('dompurify');

const DOMPurify = createDOMPurify(window);
marked.use({ gfm: true, breaks: false });

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok === false) throw new Error(result.error || 'Unknown error');
  return result ? result.value : undefined;
}

/** Subscribe helper that returns its own unsubscribe, so views can clean up. */
function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');

contextBridge.exposeInMainWorld('api', {
  campaign: {
    load: () => call('campaign:load'),
    save: (campaign) => call('campaign:save', campaign),
  },
  entities: {
    save: (entities) => call('entities:save', entities),
  },
  timeline: {
    save: (timeline) => call('timeline:save', timeline),
  },
  state: {
    load: () => call('state:load'),
    save: (state) => call('state:save', state),
    loadHotspots: () => call('hotspots:load'),
    saveHotspots: (hotspots) => call('hotspots:save', hotspots),
    loadWorld: () => call('world:load'),
    saveWorld: (world) => call('world:save', world),
  },
  notes: {
    list: () => call('notes:list'),
    read: (rel) => call('notes:read', rel),
    write: (rel, text) => call('notes:write', rel, text),
    create: (folder, title) => call('notes:create', folder, title),
  },
  maps: {
    list: () => call('maps:list'),
    import: (preferredName) => call('maps:import', preferredName),
    url: (file) => 'gmapp://maps/' + encodePath(file),
  },
  sources: {
    open: (sourceId, page) => call('sources:open', sourceId, page),
    attach: () => call('sources:attach'),
  },
  vault: {
    choose: () => call('vault:choose'),
    open: (vaultPath) => call('vault:open', vaultPath),
    reveal: () => call('vault:reveal'),
    recent: () => call('vault:recent'),
    forget: (vaultPath) => call('vault:forget', vaultPath),
    create: (options) => call('vault:new', options),
  },
  config: {
    load: () => call('config:load'),
    save: (patch) => call('config:save', patch),
  },

  markdown: (text) => DOMPurify.sanitize(marked.parse(text || '')),

  events: {
    onFileChanged: (handler) => on('vault:file-changed', handler),
    onVaultChanged: (handler) => on('vault:changed', handler),
    onMenu: (handler) => {
      const offs = [
        on('menu:new-campaign', () => handler({ action: 'new-campaign' })),
        on('menu:campaign-settings', () => handler({ action: 'campaign-settings' })),
        on('menu:add', (what) => handler({ action: 'add', what })),
        on('menu:import', () => handler({ action: 'import' })),
        on('menu:toggle-assistant', () => handler({ action: 'toggle-assistant' })),
        on('menu:search', () => handler({ action: 'search' })),
      ];
      return () => offs.forEach(off => off());
    },
  },
});
