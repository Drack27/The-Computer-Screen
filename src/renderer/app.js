/* Wiring. Everything else is a view; this is what connects them.
 *
 * Views never call each other directly — they emit on the store's bus and this
 * module decides what happens, which keeps the dependency graph a tree rather
 * than a web.
 */

import { $, el, toast, hideModal, isModalOpen } from './ui.js';
import {
  S, loadAll, on, emit, setDay, goTo, save, flushSaves,
} from './store.js';
import { wireClock } from './clock.js';
import { wireAtlas, attachMap, unplace } from './atlas.js';
import { wireRails, refreshNotes } from './rails.js';
import { wirePanel, closePanel } from './panel.js';
import {
  locationDialog, entityDialog, eventDialog, movementDialog,
  campaignSettingsDialog, newCampaignDialog, groupsDialog, refreshMapFiles,
} from './editors.js';
import { wireAssistant, toggle as toggleAssistant } from './assistant.js';

export async function boot() {
  try {
    await loadAll();
  } catch (err) {
    showFatal(err);
    return;
  }

  await refreshMapFiles();

  wireClock();
  wireAtlas();
  wireRails();
  wirePanel();
  wireAssistant();
  wireBrand();
  wireActions();
  wireKeyboard();
  wireExternalChanges();

  await refreshNotes();
  reportProblems();
  emit('render');
  return S;
}

function showFatal(err) {
  const body = document.body;
  body.innerHTML = '';
  const panel = el('div', 'fatal');
  panel.appendChild(el('h1', null, 'Could not open the campaign'));
  panel.appendChild(el('p', null, err.message || String(err)));
  panel.appendChild(el('p', 'sub', 'Use Campaign → Open Campaign Folder to pick a different one.'));
  body.appendChild(panel);
}

function wireBrand() {
  const render = () => {
    $('brand-title').textContent = (S.campaign.title || 'Campaign').toUpperCase();
    $('brand-sub').textContent = S.campaign.subtitle || S.campaign.system || '';
  };
  render();
  on('render', render);
  on('campaign-renamed', render);

  $('brand-title').addEventListener('click', campaignSettingsDialog);
}

function wireActions() {
  on('add', (what) => {
    if (what === 'location') locationDialog(null, { parent: S.currentLoc });
    else if (what === 'entity') entityDialog();
    else if (what === 'event') eventDialog(null, { date: S.cal.stringify(S.currentDay), location: S.currentLoc });
    else if (what === 'note') createNote();
  });

  on('add-location', (defaults) => locationDialog(null, defaults));
  on('add-movement', (defaults) => movementDialog(null, defaults));

  on('edit', ({ kind, id }) => {
    if (kind === 'location') locationDialog(id);
    else if (kind === 'entity') entityDialog(id);
    else if (kind === 'event') eventDialog(id);
    else if (kind === 'movement') movementDialog(id);
  });

  on('attach-map', (id) => {
    const location = S.locById.get(id);
    if (location) attachMap(location);
  });

  on('unplace', (id) => unplace(id));
  on('set-day', (day) => setDay(day));
  on('close-panel', closePanel);
  on('error', (err) => toast(err.message || String(err), 'error'));

  $('groups-button').addEventListener('click', groupsDialog);

  // Menu commands arrive from the main process.
  window.api.events.onMenu(({ action, what }) => {
    if (action === 'new-campaign') newCampaignDialog();
    else if (action === 'campaign-settings') campaignSettingsDialog();
    else if (action === 'add') emit('add', what);
    else if (action === 'search') focusSearch();
    else if (action === 'import') toast('Import arrives in the next build.');
    else if (action === 'toggle-assistant') emit('toggle-assistant');
  });
}

async function createNote() {
  try {
    const file = await window.api.notes.create('Notes', `Note ${new Date().toISOString().slice(0, 10)}`);
    await refreshNotes();
    S.activeRail = 'notes';
    emit('render');
    emit('open-note', file);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function focusSearch() {
  const search = $('rail-filter');
  search.focus();
  search.select();
}

function wireKeyboard() {
  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);

    if (event.key === 'Escape') {
      if (isModalOpen()) hideModal();
      else if (!$('assistant').classList.contains('hidden')) toggleAssistant(false);
      else closePanel();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      focusSearch();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
      event.preventDefault();
      emit('toggle-assistant');
      return;
    }

    if (typing) return;

    if (event.key === 'ArrowLeft') setDay(S.currentDay - (event.shiftKey ? 7 : 1));
    else if (event.key === 'ArrowRight') setDay(S.currentDay + (event.shiftKey ? 7 : 1));
    else if (event.key === 'Backspace') {
      const location = S.locById.get(S.currentLoc);
      if (location && location.parent) goTo(location.parent);
    }
  });

  // Don't lose the last few hundred milliseconds of edits on quit.
  window.addEventListener('beforeunload', () => { flushSaves(); });
}

function wireExternalChanges() {
  window.api.events.onFileChanged((change) => {
    if (!change) return;
    if (change.path.endsWith('.md')) {
      refreshNotes();
      return;
    }
    // A campaign file edited in another program: reload rather than fight it.
    if (/^(campaign|entities|timeline)\.json$/.test(change.path)) {
      toast('Campaign changed on disk — reloading.');
      reload();
    }
  });

  window.api.events.onVaultChanged(() => reload());
}

async function reload() {
  try {
    await flushSaves();
    await loadAll();
    await refreshMapFiles();
    await refreshNotes();
    closePanel();
    reportProblems();
    emit('campaign-renamed');
    emit('render');
  } catch (err) {
    showFatal(err);
  }
}

function reportProblems() {
  const errors = S.problems.filter(problem => problem.level === 'error');
  if (errors.length) toast(errors[0].message, 'error');
}

export { S };
