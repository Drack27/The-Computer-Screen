/* Runs the real renderer against the real campaign data in jsdom, so runtime
   errors surface without needing a display. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const VAULT = '/sessions/optimistic-serene-turing/mnt/Masks of Nyarlathotep';
const APP = path.join(VAULT, 'gm-app');

const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');

const readJson = (p, d) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; }
};

const walk = (dir, test, prefix = '') => {
  let out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'gm-app') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), test, rel));
    else if (test(e.name)) out.push(rel);
  }
  return out;
};

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

const errors = [];
window.addEventListener('error', (e) => errors.push('window error: ' + e.message));

let savedWorld = null;
let savedState = null;
let savedHotspots = null;

window.api = {
  loadCampaign: async () => ({
    campaign: readJson(path.join(VAULT, 'campaign.json'), null),
    data: {
      npcs: readJson(path.join(VAULT, 'Data', 'npcs.json'), []),
      timeline: readJson(path.join(VAULT, 'Data', 'timeline.json'), []),
      maps: readJson(path.join(VAULT, 'Data', 'maps.json'), []),
    },
    vaultPath: VAULT,
  }),
  listMarkdownFiles: async () => walk(VAULT, n => n.endsWith('.md')).sort(),
  listMapFiles: async () => walk(path.join(VAULT, 'Maps'), n => /\.(png|jpe?g)$/i.test(n)).sort(),
  readFile: async (f) => { try { return fs.readFileSync(path.join(VAULT, f), 'utf8'); } catch { return null; } },
  openPdfAt: async () => true,
  loadState: async () => null,
  saveState: async (s) => { savedState = s; return true; },
  loadHotspots: async () => ({}),
  saveHotspots: async (h) => { savedHotspots = h; return true; },
  loadWorld: async () => null,
  saveWorld: async (w) => { savedWorld = w; return true; },
  parseMarkdown: (t) => String(t).replace(/[<>]/g, ''),
  mapUrl: (f) => 'gmapp://maps/' + f,
  onFileChanged: () => {},
  offFileChanged: () => {},
};

// Element.getBoundingClientRect returns zeros in jsdom; give the map a size so
// the drag maths is exercised rather than dividing by zero.
window.HTMLElement.prototype.getBoundingClientRect = function () {
  return { left: 0, top: 0, width: 1000, height: 700, right: 1000, bottom: 700, x: 0, y: 0 };
};

const results = [];
const check = (name, fn) => {
  try {
    const msg = fn();
    results.push(['PASS', name, msg || '']);
  } catch (err) {
    results.push(['FAIL', name, err.message]);
  }
};

window.eval(appJs);

setTimeout(() => {
  const D = window.document;

  check('campaign loaded', () => {
    const t = D.getElementById('brand-title').textContent;
    if (t !== 'MASKS OF NYARLATHOTEP') throw new Error('title was ' + t);
    return t;
  });

  check('clock renders a date', () => {
    const d = D.getElementById('clock-date').textContent;
    if (!/\d{4}/.test(d)) throw new Error('bad date: ' + d);
    return d;
  });

  check('doomsday countdown', () => {
    const t = D.getElementById('clock-doom').textContent;
    if (!/days until/.test(t)) throw new Error('got: ' + t);
    return t;
  });

  check('world.json seeded', () => {
    if (!savedWorld) throw new Error('never saved');
    if (!savedWorld.movements.length) throw new Error('no movements');
    if (!savedWorld.events.length) throw new Error('no events');
    return `${savedWorld.movements.length} movements, ${savedWorld.events.length} events`;
  });

  check('world map shows continent hotspots', () => {
    const spots = D.querySelectorAll('#hotspot-layer .hotspot');
    if (spots.length < 5) throw new Error('only ' + spots.length);
    return spots.length + ' hotspots';
  });

  check('blips render on the world map', () => {
    const blips = D.querySelectorAll('#blip-layer .blip');
    if (!blips.length) throw new Error('no blips');
    return blips.length + ' blips';
  });

  check('places rail lists the tree', () => {
    D.querySelector('.rail-tab[data-rail="places"]').click();
    const items = D.querySelectorAll('#rail-body .rail-item');
    if (items.length < 50) throw new Error('only ' + items.length);
    return items.length + ' places';
  });

  check('people rail groups by chapter', () => {
    D.querySelector('.rail-tab[data-rail="people"]').click();
    const items = D.querySelectorAll('#rail-body .rail-item');
    const groups = D.querySelectorAll('#rail-body .rail-group');
    if (items.length < 80) throw new Error('only ' + items.length + ' people');
    return `${items.length} people in ${groups.length} chapters`;
  });

  check('notes rail survives an empty vault', () => {
    D.querySelector('.rail-tab[data-rail="notes"]').click();
    return D.getElementById('rail-body').textContent.slice(0, 46);
  });

  check('drag the clock forward', () => {
    const s = D.getElementById('clock-slider');
    s.value = '200';
    s.dispatchEvent(new window.Event('input'));
    const d = D.getElementById('clock-date').textContent;
    if (!/1925/.test(d)) throw new Error('got ' + d);
    return d;
  });

  check('clock reaches doomsday', () => {
    const s = D.getElementById('clock-slider');
    s.value = s.max;
    s.dispatchEvent(new window.Event('input'));
    return D.getElementById('clock-doom').textContent;
  });

  check('scrub back to the start', () => {
    const s = D.getElementById('clock-slider');
    s.value = '0';
    s.dispatchEvent(new window.Event('input'));
    return D.getElementById('clock-date').textContent;
  });

  check('drill into New York', () => {
    D.querySelector('.rail-tab[data-rail="places"]').click();
    const btn = [...D.querySelectorAll('#rail-body .rail-item')]
      .find(b => b.textContent.includes('New York'));
    if (!btn) throw new Error('New York not in rail');
    btn.click();
    const crumbs = [...D.querySelectorAll('.crumb')].map(c => c.textContent);
    if (crumbs[crumbs.length - 1] !== 'New York') throw new Error(crumbs.join(' > '));
    return crumbs.join(' › ');
  });

  check('map layers refresh on navigation (no stale hotspots)', () => {
    // New York's children have no coordinates yet, so the hotspot layer must
    // be empty here — anything left over is the world map bleeding through.
    const spots = D.querySelectorAll('#hotspot-layer .hotspot').length;
    if (spots !== 0) throw new Error(spots + ' stale hotspots from the previous map');
    return 'layer cleared';
  });

  check('unplaced children get a tray instead of a dead end', () => {
    const tray = D.getElementById('unplaced-tray');
    if (!tray) throw new Error('no tray rendered');
    const items = tray.querySelectorAll('.tray-item');
    if (!items.length) throw new Error('tray is empty');
    return items.length + ' unplaced listed';
  });

  check('tray navigates into Harlem', () => {
    const btn = [...D.querySelectorAll('#unplaced-tray .tray-item')]
      .find(b => b.textContent === 'Harlem');
    if (!btn) throw new Error('Harlem not in tray');
    btn.click();
    const crumbs = [...D.querySelectorAll('.crumb')].map(c => c.textContent);
    if (crumbs[crumbs.length - 1] !== 'Harlem') throw new Error(crumbs.join(' > '));
    return crumbs.join(' › ');
  });

  check('drill to Ju-Ju House', () => {
    const go = (name) => {
      const btn = [...D.querySelectorAll('#rail-body .rail-item')]
        .find(b => b.textContent.includes(name));
      if (!btn) throw new Error(name + ' not found');
      btn.click();
    };
    go('Ju-Ju House');
    const crumbs = [...D.querySelectorAll('.crumb')].map(c => c.textContent);
    if (crumbs[crumbs.length - 1] !== 'Ju-Ju House') throw new Error(crumbs.join(' > '));
    return crumbs.join(' › ');
  });

  check('backspace walks up the tree', () => {
    D.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Backspace' }));
    const crumbs = [...D.querySelectorAll('.crumb')].map(c => c.textContent);
    return crumbs.join(' › ');
  });

  check('open an NPC panel', () => {
    D.querySelector('.rail-tab[data-rail="people"]').click();
    const btn = D.querySelector('#rail-body .rail-item');
    btn.click();
    const p = D.getElementById('panel');
    if (p.classList.contains('hidden')) throw new Error('panel stayed closed');
    const title = D.getElementById('panel-title').textContent;
    const len = D.getElementById('panel-body').textContent.length;
    if (len < 40) throw new Error('panel body nearly empty');
    return `${title} (${len} chars)`;
  });

  check('escape closes the panel', () => {
    D.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    if (!D.getElementById('panel').classList.contains('hidden')) throw new Error('still open');
    return 'closed';
  });

  check('every chapter root is reachable and placed', () => {
    const c = readJson(path.join(VAULT, 'campaign.json'), {});
    const roots = c.locations.filter(l => l.parent === 'world');
    const unplaced = roots.filter(l => !l.pos).map(l => l.id);
    if (unplaced.length) throw new Error('unplaced: ' + unplaced.join(','));
    return roots.length + ' continents placed';
  });

  check('no uncaught window errors', () => {
    if (errors.length) throw new Error(errors.join(' | '));
    return 'clean';
  });

  let fails = 0;
  for (const [status, name, msg] of results) {
    if (status === 'FAIL') fails++;
    console.log(`${status}  ${name}${msg ? '  — ' + msg : ''}`);
  }
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
}, 900);
