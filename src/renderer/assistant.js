/* The assistant drawer.
 *
 * Answers stream in as they're generated, with the passages they were drawn
 * from listed underneath so the GM can check the source rather than take the
 * model's word for it — clicking a citation opens the actual note, NPC or
 * event in the app.
 */

import { $, el, clear, tree, button, toast, modal, formDialog, confirmDialog } from './ui.js';
import { S, emit, on } from './store.js';

const state = {
  open: false,
  busy: false,
  status: null,
  turns: [],          // { role, content, sources? }
  settings: { provider: 'anthropic', model: '', baseUrl: '', maxTokens: 2048 },
  streaming: null,    // the assistant turn currently being written
};

export function wireAssistant() {
  $('assistant-close').addEventListener('click', () => toggle(false));
  $('assistant-settings').addEventListener('click', openSettings);
  $('assistant-reindex').addEventListener('click', reindex);

  const form = $('assistant-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send();
  });

  const input = $('assistant-input');
  input.addEventListener('keydown', (event) => {
    // Enter sends; Shift+Enter is a newline, as in every chat box ever.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  window.api.assistant.onEvent(handleEvent);
  on('toggle-assistant', () => toggle(!state.open));

  restoreSettings();
}

function restoreSettings() {
  const saved = S.appState.assistant;
  if (saved && typeof saved === 'object') Object.assign(state.settings, saved);
}

function persistSettings() {
  S.appState.assistant = { ...state.settings };
  window.api.state.save(S.appState).catch(() => {});
}

export async function toggle(open) {
  state.open = open;
  $('assistant').classList.toggle('hidden', !open);
  if (!open) return;

  $('assistant-input').focus();
  await refreshStatus();
}

async function refreshStatus() {
  try {
    state.status = await window.api.assistant.status();
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  renderStatus();
}

function renderStatus() {
  const bar = clear($('assistant-status'));
  const status = state.status;
  if (!status) return;

  const chunks = status.index.chunks;
  bar.appendChild(el('span', null,
    chunks ? `${chunks} passages indexed` : 'Nothing indexed yet'));

  const provider = describeProvider();
  bar.appendChild(el('span', 'dot', '·'));
  bar.appendChild(el('span', null, provider));
}

function describeProvider() {
  const { provider, model } = state.settings;
  if (provider === 'local') return model ? `local · ${model.replace(/\.gguf$/i, '')}` : 'local · no model';
  const spec = (state.status ? state.status.providers : []).find(p => p.id === provider);
  return `${spec ? spec.label : provider}${model ? ` · ${model}` : ''}`;
}

// ── Conversation ─────────────────────────────────────────────────────────────

async function send() {
  const input = $('assistant-input');
  const question = input.value.trim();
  if (!question || state.busy) return;

  if (!state.status) await refreshStatus();
  if (!state.status.index.chunks) {
    const build = await confirmDialog({
      title: 'Index the campaign first?',
      message: 'The assistant reads your notes through a search index, and this campaign hasn\'t been indexed yet. It takes a moment and stays on this machine.',
      confirmLabel: 'Index now',
    });
    if (!build) return;
    await reindex();
  }

  input.value = '';
  state.turns.push({ role: 'user', content: question });
  state.streaming = { role: 'assistant', content: '', sources: [] };
  state.turns.push(state.streaming);
  state.busy = true;
  renderTurns();

  try {
    await window.api.assistant.ask({
      question,
      history: state.turns.slice(0, -2).map(turn => ({ role: turn.role, content: turn.content })),
      settings: state.settings,
      view: { date: S.cal.stringify(S.currentDay), location: S.currentLoc },
    });
  } catch (err) {
    if (state.streaming) state.streaming.error = err.message;
    state.busy = false;
    renderTurns();
  }
}

function handleEvent(event) {
  if (!event || !state.streaming) return;

  if (event.type === 'sources') {
    state.streaming.sources = event.sources || [];
  } else if (event.type === 'delta') {
    state.streaming.content += event.text;
  } else if (event.type === 'done') {
    if (event.cancelled && !state.streaming.content) state.streaming.content = '(stopped)';
    state.streaming = null;
    state.busy = false;
  } else if (event.type === 'error') {
    state.streaming.error = event.message;
    state.streaming = null;
    state.busy = false;
  }
  renderTurns();
}

function renderTurns() {
  const log = clear($('assistant-log'));

  if (!state.turns.length) {
    log.appendChild(emptyState());
  }

  for (const turn of state.turns) {
    const node = el('div', `turn ${turn.role}`);

    if (turn.role === 'user') {
      node.appendChild(el('div', 'turn-body', turn.content));
    } else {
      const body = el('div', 'turn-body prose');
      if (turn.content) body.innerHTML = window.api.markdown(turn.content);
      else if (!turn.error) body.appendChild(el('span', 'thinking-dots', 'Reading your notes…'));
      node.appendChild(body);

      if (turn.error) {
        node.appendChild(el('div', 'turn-error', turn.error));
      }
      if (turn.sources && turn.sources.length) {
        node.appendChild(sourceList(turn.sources));
      }
    }
    log.appendChild(node);
  }

  const controls = clear($('assistant-controls'));
  if (state.busy) {
    controls.appendChild(button('Stop', { onClick: () => window.api.assistant.stop() }));
  }

  log.scrollTop = log.scrollHeight;
  renderStatus();
}

function emptyState() {
  const wrap = el('div', 'assistant-empty');
  wrap.appendChild(el('p', null,
    'Ask about your campaign. The assistant reads your notes, your NPCs and the timeline, and it knows what today\'s date is and who is standing where.'));

  const examples = el('div', 'assistant-examples');
  for (const example of [
    'Who is in this location today, and what do they want?',
    'What have my players not followed up on yet?',
    'Summarise everything I know about this place.',
    'Give me three rumours the locals might repeat.',
  ]) {
    const chip = el('button', 'chip', example);
    chip.addEventListener('click', () => {
      $('assistant-input').value = example;
      send();
    });
    examples.appendChild(chip);
  }
  wrap.appendChild(examples);
  return wrap;
}

function sourceList(sources) {
  const wrap = el('details', 'sources');
  wrap.appendChild(el('summary', null, `${sources.length} source${sources.length > 1 ? 's' : ''}`));

  for (const source of sources) {
    const row = el('button', 'source-row');
    row.appendChild(el('span', 'source-n', `[${source.n}]`));
    row.appendChild(el('span', 'source-title', source.title));
    row.appendChild(el('span', 'source-kind', source.kind));
    row.title = source.excerpt;
    row.addEventListener('click', () => openSource(source));
    wrap.appendChild(row);
  }
  return wrap;
}

function openSource(source) {
  const ref = source.ref;
  if (!ref) return;
  if (ref.kind === 'entity') emit('open-entity', ref.id);
  else if (ref.kind === 'location') emit('open-location', ref.id);
  else if (ref.kind === 'event') emit('open-event', ref.id);
  else if (ref.kind === 'note') emit('open-note', ref.id);
}

async function reindex() {
  try {
    toast('Indexing…');
    const result = await window.api.assistant.reindex();
    await refreshStatus();
    toast(`Indexed ${result.chunks} passages from ${result.notes} notes.`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function openSettings() {
  if (!state.status) await refreshStatus();
  const status = state.status;

  const providerOptions = [
    ...status.providers.map(p => ({ value: p.id, label: `${p.label}${p.hasKey ? ' ✓' : ''}` })),
    { value: 'local', label: 'On this computer (no internet)' },
  ];

  formDialog({
    title: 'Assistant settings',
    confirmLabel: 'Save',
    wide: true,
    fields: [
      { key: 'provider', label: 'Where the model runs', type: 'select',
        options: providerOptions, value: state.settings.provider },

      { key: 'model', label: 'Model', type: 'custom', value: state.settings.model,
        render: (setValue, value) => modelPicker(setValue, value, status) },

      { key: 'baseUrl', label: 'Server address', type: 'text', value: state.settings.baseUrl,
        placeholder: 'http://localhost:1234/v1',
        when: (values) => values.provider === 'compatible' },

      { key: 'key', label: 'API key', type: 'text', value: '',
        placeholder: 'Leave blank to keep the saved key',
        hint: status.keychain
          ? 'Stored in your operating system\'s keychain, never in the campaign folder.'
          : 'This system has no secure keychain available, so keys can\'t be saved. Use an environment variable instead.',
        when: (values) => values.provider !== 'local' },

      { key: 'localHeading', label: 'Local models', type: 'heading',
        when: (values) => values.provider === 'local' },
      { key: 'models', label: '', type: 'custom', value: null,
        render: () => localModelManager(status),
        when: (values) => values.provider === 'local' },
    ],

    onSubmit: async (values) => {
      state.settings.provider = values.provider;
      state.settings.model = values.model || '';
      state.settings.baseUrl = values.baseUrl || '';

      if (values.key && values.key.trim()) {
        try {
          await window.api.assistant.saveKey(values.provider, values.key.trim());
        } catch (err) {
          toast(err.message, 'error');
          return false;
        }
      }
      persistSettings();
      refreshStatus();
      toast('Saved.');
    },

    extraActions: [{
      label: 'Test',
      onClick: async (values) => {
        try {
          if (values.key && values.key.trim()) {
            await window.api.assistant.saveKey(values.provider, values.key.trim());
          }
          toast('Testing…');
          const reply = await window.api.assistant.test({
            provider: values.provider,
            model: values.model,
            baseUrl: values.baseUrl,
          });
          toast(reply ? `Working — the model replied "${reply}".` : 'Working.');
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    }],
  });
}

function modelPicker(setValue, current, status) {
  const select = el('select');

  const fill = (provider) => {
    clear(select);
    const options = provider === 'local'
      ? status.local.installed.map(m => ({ value: m.id, label: `${m.label} (${m.size})` }))
      : (status.providers.find(p => p.id === provider) || { models: [] }).models
        .map(m => ({ value: m.id, label: m.label }));

    if (!options.length) {
      const node = el('option', null,
        provider === 'local' ? 'No models downloaded yet' : 'Type a model name below');
      node.value = '';
      select.appendChild(node);
    }
    for (const option of options) {
      const node = el('option', null, option.label);
      node.value = option.value;
      select.appendChild(node);
    }
    select.value = options.some(o => o.value === current) ? current : (options[0] || {}).value || '';
    setValue(select.value);
  };

  select.addEventListener('change', () => setValue(select.value));

  // The dialog's own change events tell us when the provider flips.
  setTimeout(() => {
    const providerField = document.getElementById('field-provider');
    if (providerField) {
      providerField.addEventListener('change', () => fill(providerField.value));
      fill(providerField.value);
    }
  }, 0);

  const wrap = el('div');
  wrap.appendChild(select);

  const manual = el('input', 'model-manual');
  manual.type = 'text';
  manual.placeholder = '…or type an exact model name';
  manual.addEventListener('input', () => { if (manual.value.trim()) setValue(manual.value.trim()); });
  wrap.appendChild(manual);

  return wrap;
}

// ── Local model manager ──────────────────────────────────────────────────────

function localModelManager(status) {
  const wrap = el('div', 'model-manager');

  if (!status.local.engine.available) {
    wrap.appendChild(el('div', 'form-hint', status.local.engine.error));
  }

  for (const model of status.local.installed) {
    const row = el('div', 'model-row installed');
    row.appendChild(el('span', 'model-name', model.label));
    row.appendChild(el('span', 'sub', model.size));
    row.appendChild(button('Remove', {
      className: 'tiny danger',
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Delete ${model.label}?`,
          message: `This frees ${model.size} of disk space. You can download it again later.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await window.api.assistant.removeModel(model.id);
        await refreshStatus();
        row.remove();
      },
    }));
    wrap.appendChild(row);
  }

  wrap.appendChild(el('div', 'form-hint',
    'Downloaded models live in the app\'s own folder and run entirely on this computer.'));

  for (const entry of status.local.catalog) {
    const row = el('div', 'model-row');
    const label = el('div', 'model-offer');
    label.appendChild(el('span', 'model-name', entry.label));
    label.appendChild(el('span', 'sub', `about ${entry.approxSize} · needs ${entry.ram}`));
    label.appendChild(el('span', 'model-blurb', entry.blurb));
    row.appendChild(label);
    row.appendChild(button('Download', {
      className: 'tiny',
      onClick: () => offerDownload(entry.id),
    }));
    wrap.appendChild(row);
  }

  wrap.appendChild(button('Use a .gguf file I already have', {
    className: 'tiny add',
    onClick: async () => {
      try {
        const picked = await window.api.assistant.pickModelFile();
        if (!picked) return;
        state.settings.provider = 'local';
        state.settings.model = picked.path;
        persistSettings();
        await refreshStatus();
        toast(`Using ${picked.label}.`);
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  }));

  return wrap;
}

/** The consent step. Nothing is fetched before this is accepted, and the size
 *  shown is the size the server actually reported for the actual file. */
async function offerDownload(modelId) {
  let planned;
  try {
    toast('Checking the download…');
    planned = await window.api.assistant.planDownload(modelId);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  if (planned.alreadyInstalled) {
    toast('That model is already downloaded.');
    return;
  }

  const gb = (planned.bytes / (1024 ** 3)).toFixed(1);
  const free = planned.freeBytes == null
    ? null
    : `${(planned.freeBytes / (1024 ** 3)).toFixed(0)} GB free on this drive`;

  const body = el('div', 'download-consent');
  body.appendChild(el('p', 'consent-lead',
    `You're about to install an AI model on this computer. It is ${gb} GB${planned.bytesAreEstimated ? ' (approximately)' : ''}.`));

  const facts = el('ul', 'consent-facts');
  const fact = (text) => { const li = el('li', null, text); facts.appendChild(li); };
  fact(`${planned.label} — ${planned.filename}`);
  fact(`Needs roughly ${planned.ram} to run once installed.`);
  fact(`Saved to: ${planned.directory}`);
  if (free) fact(free);
  fact('Once it\'s downloaded it runs entirely on this machine. Nothing you ask it leaves the computer.');
  fact('You can delete it at any time from these settings.');
  body.appendChild(facts);

  if (!planned.fits) {
    body.appendChild(el('p', 'consent-warning',
      'There may not be enough free space on this drive for that download.'));
  }

  const progress = el('div', 'download-progress hidden');
  const bar = el('div', 'download-bar');
  const fill = el('div', 'download-fill');
  bar.appendChild(fill);
  const label = el('div', 'download-label', 'Starting…');
  progress.appendChild(bar);
  progress.appendChild(label);
  body.appendChild(progress);

  let close = null;
  let downloading = false;

  const offProgress = window.api.assistant.onDownloadProgress((update) => {
    if (update.filename !== planned.filename) return;
    const percent = update.total ? Math.round((update.received / update.total) * 100) : 0;
    fill.style.width = `${percent}%`;
    label.textContent = update.done
      ? 'Finishing…'
      : `${percent}% — ${(update.received / (1024 ** 3)).toFixed(2)} of ${gb} GB`;
  });

  close = modal({
    title: 'Install a local model?',
    body,
    wide: true,
    onClose: () => {
      offProgress();
      if (downloading) window.api.assistant.cancelDownload(planned.filename);
    },
    actions: [
      { label: 'Cancel', onClick: () => close() },
      {
        label: `Download ${gb} GB`,
        primary: true,
        onClick: async (/* no args */) => {
          if (downloading) return;
          downloading = true;
          progress.classList.remove('hidden');

          try {
            const result = await window.api.assistant.download(planned);
            downloading = false;
            state.settings.provider = 'local';
            state.settings.model = result.id;
            persistSettings();
            offProgress();
            close();
            await refreshStatus();
            toast(`${planned.label} is ready to use.`);
          } catch (err) {
            downloading = false;
            label.textContent = err.message;
            label.classList.add('failed');
          }
        },
      },
    ],
  });
}

export { state as assistantState };
