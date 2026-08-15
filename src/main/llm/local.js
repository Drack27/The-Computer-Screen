/* Local models — inference on this machine, nothing sent anywhere.
 *
 * The inference engine (node-llama-cpp) is bundled with the app, so there is
 * nothing for the user to install. The *weights* are not: a usable model is
 * gigabytes, which belongs in a deliberate download rather than in the
 * executable. Nothing is ever fetched without the user seeing the real size
 * first — see `plan()`, which resolves the actual file and asks the server how
 * big it is rather than trusting a number baked in at build time.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const GB = 1024 * 1024 * 1024;

const modelsDir = () => path.join(app.getPath('userData'), 'models');

/* A short, opinionated list. Files are resolved against the Hugging Face API at
 * download time rather than hard-coded, so a repository reorganising its
 * quantisations doesn't leave the app pointing at a dead link. */
const CATALOG = [
  {
    id: 'qwen2.5-7b-instruct',
    label: 'Qwen2.5 7B Instruct',
    repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    quant: 'Q4_K_M',
    approxBytes: 4.7 * GB,
    ram: '8 GB of RAM',
    blurb: 'The best all-rounder here. Good at following instructions about your notes.',
  },
  {
    id: 'llama-3.2-3b-instruct',
    label: 'Llama 3.2 3B Instruct',
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    quant: 'Q4_K_M',
    approxBytes: 2.0 * GB,
    ram: '4 GB of RAM',
    blurb: 'Small and quick. Fine for summarising and looking things up; weaker at long reasoning.',
  },
  {
    id: 'mistral-7b-instruct',
    label: 'Mistral 7B Instruct v0.3',
    repo: 'bartowski/Mistral-7B-Instruct-v0.3-GGUF',
    quant: 'Q4_K_M',
    approxBytes: 4.4 * GB,
    ram: '8 GB of RAM',
    blurb: 'A solid alternative with a lighter, less formal writing voice.',
  },
];

// ── The engine ───────────────────────────────────────────────────────────────

let enginePromise = null;

/** node-llama-cpp is an optional dependency: if the native build didn't happen
 *  for this platform, everything else in the app must still work. */
async function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = await import('node-llama-cpp');
      const llama = await mod.getLlama();
      return { mod, llama };
    })().catch((err) => {
      enginePromise = null;
      throw new Error(
        'The local inference engine isn\'t available in this build '
        + `(${err.message}). Cloud models still work.`);
    });
  }
  return enginePromise;
}

async function engineStatus() {
  try {
    await engine();
    return { available: true, error: null };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

// ── Installed models ─────────────────────────────────────────────────────────

function installed() {
  try {
    return fs.readdirSync(modelsDir())
      .filter(name => name.endsWith('.gguf'))
      .map(name => {
        const file = path.join(modelsDir(), name);
        const stat = fs.statSync(file);
        return { id: name, label: prettyName(name), path: file, bytes: stat.size };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];
  }
}

function prettyName(filename) {
  return filename
    .replace(/\.gguf$/i, '')
    .replace(/-(GGUF|gguf)/g, '')
    .replace(/[-_]/g, ' ')
    .trim();
}

async function remove(id) {
  const file = path.join(modelsDir(), path.basename(id));
  if (!file.startsWith(modelsDir() + path.sep)) throw new Error('Not a model file.');
  await fsp.unlink(file);
  unloadAll();
  return true;
}

// ── Planning a download ──────────────────────────────────────────────────────

/** Ask Hugging Face which file actually matches the wanted quantisation. */
async function resolveFile(entry) {
  const response = await fetch(`https://huggingface.co/api/models/${entry.repo}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Could not read the model listing (HTTP ${response.status}).`);

  const data = await response.json();
  const files = (data.siblings || [])
    .map(sibling => sibling.rfilename)
    .filter(name => typeof name === 'string' && name.toLowerCase().endsWith('.gguf'));

  if (!files.length) throw new Error('That repository has no GGUF files in it.');

  // Prefer the exact quantisation; fall back to any single-part file, since a
  // split multi-part model needs joining and can't be streamed straight in.
  const single = files.filter(name => !/-0000\d-of-\d+\.gguf$/i.test(name));
  const wanted = single.find(name => name.toLowerCase().includes(entry.quant.toLowerCase()));
  const chosen = wanted || single[0] || files[0];

  return {
    filename: path.basename(chosen),
    url: `https://huggingface.co/${entry.repo}/resolve/main/${encodeURI(chosen)}?download=true`,
  };
}

async function sizeOf(url) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const length = response.headers.get('content-length');
    return length ? Number(length) : null;
  } catch {
    return null;
  }
}

async function freeSpace() {
  try {
    const stats = await fsp.statfs(app.getPath('userData'));
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Everything the consent dialog needs: the real file, the real size from the
 * server, where it will live, and whether it will actually fit.
 */
async function plan(modelId) {
  const entry = CATALOG.find(item => item.id === modelId);
  if (!entry) throw new Error('Unknown model.');

  const resolved = await resolveFile(entry);
  const bytes = await sizeOf(resolved.url);
  const free = await freeSpace();

  return {
    id: entry.id,
    label: entry.label,
    blurb: entry.blurb,
    ram: entry.ram,
    filename: resolved.filename,
    url: resolved.url,
    bytes: bytes ?? Math.round(entry.approxBytes),
    bytesAreEstimated: bytes == null,
    directory: modelsDir(),
    freeBytes: free,
    fits: free == null ? true : free > (bytes ?? entry.approxBytes) * 1.05,
    alreadyInstalled: fs.existsSync(path.join(modelsDir(), resolved.filename)),
  };
}

// ── Downloading ──────────────────────────────────────────────────────────────

const downloads = new Map();   // filename → AbortController

/** Stream to a .part file and rename on success, so an interrupted download
 *  never looks like a working model. */
async function download(planned, onProgress) {
  await fsp.mkdir(modelsDir(), { recursive: true });

  const target = path.join(modelsDir(), path.basename(planned.filename));
  const partial = `${target}.part`;

  const controller = new AbortController();
  downloads.set(planned.filename, controller);

  try {
    const response = await fetch(planned.url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);

    const total = Number(response.headers.get('content-length')) || planned.bytes || 0;
    const handle = await fsp.open(partial, 'w');
    let received = 0;
    let lastTick = 0;

    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(value);
        received += value.length;

        // Progress four times a second is plenty; more just floods IPC.
        const now = Date.now();
        if (now - lastTick > 250) {
          lastTick = now;
          onProgress({ received, total, done: false });
        }
      }
    } finally {
      await handle.close();
    }

    const stat = await fsp.stat(partial);
    if (total && stat.size !== total) {
      await fsp.unlink(partial).catch(() => {});
      throw new Error(`The download ended early (${formatBytes(stat.size)} of ${formatBytes(total)}).`);
    }

    await fsp.rename(partial, target);
    onProgress({ received: stat.size, total: stat.size, done: true });
    return { path: target, bytes: stat.size, id: path.basename(target) };
  } catch (err) {
    await fsp.unlink(partial).catch(() => {});
    if (err.name === 'AbortError') throw new Error('Download cancelled.');
    throw err;
  } finally {
    downloads.delete(planned.filename);
  }
}

function cancel(filename) {
  const controller = downloads.get(filename);
  if (controller) controller.abort();
  return !!controller;
}

/** Adopt a .gguf the user already has, without copying gigabytes around. */
async function adopt(sourcePath) {
  if (!sourcePath.toLowerCase().endsWith('.gguf')) throw new Error('That isn\'t a .gguf model file.');
  const stat = await fsp.stat(sourcePath);
  return { id: sourcePath, label: prettyName(path.basename(sourcePath)), path: sourcePath, bytes: stat.size };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// ── Inference ────────────────────────────────────────────────────────────────

let loaded = null;   // { path, model, context }

async function loadModel(modelPath) {
  if (loaded && loaded.path === modelPath) return loaded;
  unloadAll();

  const { llama } = await engine();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext();
  loaded = { path: modelPath, model, context };
  return loaded;
}

function unloadAll() {
  if (!loaded) return;
  try { loaded.context.dispose(); } catch { /* already gone */ }
  try { loaded.model.dispose(); } catch { /* already gone */ }
  loaded = null;
}

function resolvePath(modelId) {
  if (modelId && path.isAbsolute(modelId) && fs.existsSync(modelId)) return modelId;
  const file = path.join(modelsDir(), path.basename(modelId || ''));
  if (fs.existsSync(file)) return file;
  throw new Error('That model isn\'t downloaded. Open the assistant\'s settings to add one.');
}

async function chat({ model, system, messages, maxTokens = 1024, signal, onDelta }) {
  const { mod } = await engine();
  const { context } = await loadModel(resolvePath(model));

  const session = new mod.LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: system || undefined,
  });

  // llama.cpp sessions carry their own history, so replay everything before the
  // final turn and then prompt with it.
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];

  if (history.length && typeof session.setChatHistory === 'function') {
    session.setChatHistory(history.map(entry => ({
      type: entry.role === 'assistant' ? 'model' : 'user',
      text: entry.content,
      response: entry.role === 'assistant' ? [entry.content] : undefined,
    })));
  }

  await session.prompt(last ? last.content : '', {
    maxTokens,
    signal,
    onTextChunk: (chunk) => onDelta(chunk),
  });

  return {};
}

/** Embeddings from the same weights, when the model supports them. Used to add
 *  meaning-based search on top of the keyword index. */
async function embed(texts, modelId) {
  const { llama } = await engine();
  const modelPath = resolvePath(modelId);
  const model = await llama.loadModel({ modelPath });
  try {
    const context = await model.createEmbeddingContext();
    const out = [];
    for (const text of texts) {
      const embedding = await context.getEmbeddingFor(text);
      out.push(Array.from(embedding.vector));
    }
    context.dispose();
    return out;
  } finally {
    model.dispose();
  }
}

module.exports = {
  CATALOG, modelsDir, engineStatus, installed, remove,
  plan, download, cancel, adopt, chat, embed, unloadAll, formatBytes,
};
