/* The preload bridge, faked.
 *
 * Reads fixture files over fetch (the test page is served from the repo root)
 * and keeps every write in memory, so a test can assert on what the app tried
 * to persist without touching the disk.
 */

import { normalizeCampaign, normalizeEntities, normalizeTimeline, validateCampaign }
  from '../shared/schema.js';

async function readJson(url, fallback) {
  try {
    const response = await fetch(url);
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export async function fakeApi(fixture) {
  const root = `/test/fixtures/${fixture}`;

  const written = {
    campaign: null, entities: null, timeline: null,
    world: null, hotspots: null, state: null, notes: {},
  };

  // Fixture files are fetched once; the app's own writes go to `written`.
  const files = {
    campaign: await readJson(`${root}/campaign.json`, {}),
    entities: await readJson(`${root}/entities.json`, null),
    legacyEntities: await readJson(`${root}/Data/npcs.json`, []),
    timeline: await readJson(`${root}/timeline.json`, null),
    legacyTimeline: await readJson(`${root}/Data/timeline.json`, []),
    notes: await readJson(`${root}/notes-index.json`, []),
  };

  const api = {
    campaign: {
      load: async () => {
        const campaign = normalizeCampaign(files.campaign);
        const entities = normalizeEntities(files.entities ?? files.legacyEntities, campaign);
        const timeline = normalizeTimeline(files.timeline ?? files.legacyTimeline, campaign);
        return {
          campaign,
          entities,
          timeline,
          vaultPath: root,
          state: written.state,
          hotspots: written.hotspots || {},
          world: written.world,
          problems: validateCampaign(campaign, { entities }),
          product: 'The Computer Screen',
          version: 'test',
        };
      },
      save: async (campaign) => { written.campaign = campaign; return campaign; },
    },
    entities: { save: async (value) => { written.entities = value; return value; } },
    timeline: { save: async (value) => { written.timeline = value; return value; } },
    state: {
      load: async () => written.state,
      save: async (value) => { written.state = value; return true; },
      loadHotspots: async () => written.hotspots || {},
      saveHotspots: async (value) => { written.hotspots = value; return true; },
      loadWorld: async () => written.world,
      saveWorld: async (value) => { written.world = value; return true; },
    },
    notes: {
      list: async () => [...files.notes, ...Object.keys(written.notes)].sort(),
      read: async (rel) => {
        if (written.notes[rel] != null) return written.notes[rel];
        try {
          const response = await fetch(`${root}/${rel}`);
          return response.ok ? await response.text() : null;
        } catch {
          return null;
        }
      },
      write: async (rel, text) => { written.notes[rel] = text; return true; },
      create: async (folder, title) => {
        const rel = `${folder ? folder + '/' : ''}${title}.md`;
        written.notes[rel] = `# ${title}\n\n`;
        return rel;
      },
    },
    maps: {
      list: async () => ['world.png', 'riverlands.png', 'kessington.png', 'frostmarch.png'],
      import: async () => 'imported.png',
      // Fixtures ship no bitmaps, so hand back a 1×1 pixel that always loads.
      url: () => PIXEL,
    },
    sources: { open: async () => true, attach: async () => null },
    vault: {
      choose: async () => ({ ok: false, cancelled: true }),
      open: async () => ({ ok: true }),
      reveal: async () => true,
      recent: async () => [],
      forget: async () => [],
      create: async () => ({ ok: true }),
    },
    config: { load: async () => ({}), save: async (patch) => patch },

    // The assistant is stubbed rather than absent: the renderer wires it up at
    // boot, so a missing surface here would take the whole app down.
    assistant: {
      status: async () => ({
        index: { chunks: 0, builtAt: null },
        providers: [{ id: 'anthropic', label: 'Anthropic', models: [], defaultModel: '', hasKey: false }],
        keychain: true,
        local: { engine: { available: false, error: 'not built in tests' }, installed: [], catalog: [], directory: '/models' },
      }),
      reindex: async () => ({ chunks: 0, notes: 0, builtAt: Date.now() }),
      search: async () => [],
      ask: async () => true,
      stop: async () => true,
      saveKey: async () => true,
      test: async () => 'ready',
      planDownload: async () => null,
      download: async () => null,
      cancelDownload: async () => true,
      removeModel: async () => true,
      pickModelFile: async () => null,
      onEvent: () => () => {},
      onDownloadProgress: () => () => {},
    },
    markdown: (text) => String(text || '').replace(/[<>]/g, ''),
    events: {
      onFileChanged: () => () => {},
      onVaultChanged: () => () => {},
      onMenu: () => () => {},
    },
  };

  return { api, written, root };
}

const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
