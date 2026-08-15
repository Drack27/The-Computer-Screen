/* The assistant.
 *
 * Retrieval and the live campaign brief are assembled here, in the main
 * process, and only the finished prompt goes to a provider. Answers stream back
 * to the renderer a fragment at a time.
 *
 * The system prompt is deliberately narrow: this is a reference desk for one
 * GM's campaign, not a co-author. It answers from the notes, says when the
 * notes don't cover something, and never quietly invents a fact the GM will
 * later have to un-say at the table.
 */

const { SearchIndex } = require('../rag/search');
const { documentsFor, briefFor } = require('../rag/campaign');
const providers = require('./providers');
const local = require('./local');
const keys = require('./keys');
const { shared } = require('../shared');

const INDEX_FILE = 'search-index.json';

const SYSTEM_PROMPT = `You are the reference desk for a tabletop roleplaying campaign, sitting beside the Game Master while they prepare or run a session.

You have two sources, and only two:
1. THE CURRENT STATE — the campaign's date, the place the GM is looking at, and who is where today. Treat this as authoritative fact about right now.
2. RETRIEVED NOTES — passages from the GM's own campaign notes and records, each with a [number] label.

How to answer:
- Answer from those sources. Cite the passage you used with its [number] label, inline, where you use it.
- When the notes don't cover something, say so plainly in one sentence. Do not fill the gap with invented specifics — no invented names, dates, or events. A GM acting on a fact you made up will contradict themselves at the table.
- Clearly separate what the notes say from anything you suggest. If the GM asks you to invent something (a name, a rumour, a complication), invent freely and say that you are doing so.
- Keep answers short and usable mid-session. A GM reading this may have five players waiting.
- The GM sees everything, including secrets. There is nothing to hide from them.`;

class Assistant {
  constructor(ctx) {
    this.ctx = ctx;
    this.index = null;
    this.indexedVault = null;
    this.abort = null;
  }

  // ── Index ──────────────────────────────────────────────────────────────────

  /** Load a saved index for the active vault, or note that none exists yet. */
  load() {
    if (!this.ctx.play) return null;
    if (this.indexedVault === this.ctx.vault.root && this.index) return this.index;

    const saved = this.ctx.play.load(INDEX_FILE, null);
    this.index = new SearchIndex(saved);
    this.indexedVault = this.ctx.vault.root;
    return this.index;
  }

  async rebuild() {
    const vault = this.ctx.vault;
    if (!vault) throw new Error('No campaign is open.');

    const { createCalendar } = shared();
    const doc = vault.read();
    const calendar = createCalendar(doc.campaign.calendar);
    const world = this.ctx.play.load('world.json', null);

    const notes = [];
    for (const rel of vault.listNotes()) {
      const text = vault.readNote(rel);
      if (text) notes.push({ path: rel, text });
    }

    const documents = documentsFor({
      campaign: doc.campaign,
      entities: doc.entities,
      timeline: doc.timeline,
      world,
      notes,
      calendar,
    });

    const index = new SearchIndex();
    const count = index.build(documents);
    this.index = index;
    this.indexedVault = vault.root;
    this.ctx.play.save(INDEX_FILE, index.toJSON());

    return { chunks: count, notes: notes.length, builtAt: index.builtAt };
  }

  /** Plain search, no model involved — powers the search box as well as RAG. */
  search(query, options = {}) {
    const index = this.load();
    if (!index || !index.size) return [];
    return index.search(query, options);
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async status() {
    const index = this.load();
    const engine = await local.engineStatus();
    return {
      index: {
        chunks: index ? index.size : 0,
        builtAt: index ? index.builtAt : null,
      },
      providers: providers.describe(),
      keychain: keys.available(),
      local: {
        engine,
        installed: local.installed().map(model => ({
          id: model.id,
          label: model.label,
          bytes: model.bytes,
          size: local.formatBytes(model.bytes),
        })),
        catalog: local.CATALOG.map(entry => ({
          id: entry.id,
          label: entry.label,
          blurb: entry.blurb,
          ram: entry.ram,
          approxSize: local.formatBytes(entry.approxBytes),
        })),
        directory: local.modelsDir(),
      },
    };
  }

  // ── Asking ─────────────────────────────────────────────────────────────────

  /**
   * Stream an answer. `onEvent` receives:
   *   { type: 'sources', sources }  once, before any text
   *   { type: 'delta', text }       repeatedly
   *   { type: 'done' } | { type: 'error', message }
   */
  async ask({ question, history = [], settings, view }, onEvent) {
    const vault = this.ctx.vault;
    if (!vault) throw new Error('No campaign is open.');

    this.stop();
    this.abort = new AbortController();

    const { createCalendar } = shared();
    const doc = vault.read();
    const calendar = createCalendar(doc.campaign.calendar);
    const world = this.ctx.play.load('world.json', null);

    const brief = briefFor({
      campaign: doc.campaign,
      entities: doc.entities,
      world,
      calendar,
      currentDate: (view && view.date) || doc.campaign.clock.current,
      currentLocation: (view && view.location) || (doc.campaign.locations[0] || {}).id,
    });

    const index = this.load();
    const hits = index && index.size ? index.search(question, { limit: 8 }) : [];

    const sources = hits.map((hit, i) => ({
      n: i + 1,
      title: hit.title,
      kind: hit.kind,
      ref: hit.ref,
      excerpt: hit.text.length > 240 ? `${hit.text.slice(0, 240)}…` : hit.text,
    }));
    onEvent({ type: 'sources', sources });

    const retrieved = hits.length
      ? hits.map((hit, i) => `[${i + 1}] ${hit.title}\n${hit.text}`).join('\n\n---\n\n')
      : '(No notes matched this question.)';

    const system = `${SYSTEM_PROMPT}\n\n# THE CURRENT STATE\n\n${brief}\n\n# RETRIEVED NOTES\n\n${retrieved}`;

    const messages = [
      ...history.slice(-8).map(turn => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: question },
    ];

    const common = {
      system,
      messages,
      maxTokens: settings.maxTokens || 2048,
      signal: this.abort.signal,
      onDelta: (text) => onEvent({ type: 'delta', text }),
    };

    try {
      if (settings.provider === 'local') {
        if (!settings.model) throw new Error('Choose a downloaded model first.');
        await local.chat({ model: settings.model, ...common });
      } else {
        await providers.chat({
          provider: settings.provider,
          model: settings.model,
          baseUrl: settings.baseUrl,
          ...common,
        });
      }
      onEvent({ type: 'done' });
    } catch (err) {
      if (err.name === 'AbortError') onEvent({ type: 'done', cancelled: true });
      else onEvent({ type: 'error', message: err.message });
    } finally {
      this.abort = null;
    }
  }

  stop() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
      return true;
    }
    return false;
  }
}

module.exports = { Assistant, SYSTEM_PROMPT };
