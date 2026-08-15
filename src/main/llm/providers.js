/* Cloud providers.
 *
 * One shape in, one shape out: `chat({ system, messages, model, maxTokens })`
 * yields text deltas. Requests are made from the main process only — the
 * renderer never sees a key, and its content security policy blocks outbound
 * connections anyway.
 *
 * These are plain HTTPS calls rather than each vendor's SDK. The layer is
 * deliberately provider-neutral, and a desktop app that has to bundle its own
 * runtime is better off with one small fetch wrapper than four dependency
 * trees, each with its own release cadence, inside the executable.
 */

const keys = require('./keys');

const USER_AGENT = 'TheComputerScreen/0.2 (+https://github.com/Drack27/The-Computer-Screen)';

/** Providers, in the order they're offered in the UI. */
const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5 — most capable' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 — balanced' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fastest' },
    ],
    defaultModel: 'claude-opus-5',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini — faster' },
    ],
    defaultModel: 'gpt-4o',
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVar: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    models: [
      { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    ],
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'compatible',
    label: 'Any OpenAI-compatible server',
    envVar: 'OPENAI_COMPATIBLE_API_KEY',
    needsBaseUrl: true,
    models: [],
    defaultModel: '',
    hint: 'Point this at LM Studio, vLLM, OpenRouter, a llama.cpp server — anything that speaks the OpenAI chat API.',
  },
];

function describe() {
  const stored = new Set(keys.list());
  return PROVIDERS.map(provider => ({
    id: provider.id,
    label: provider.label,
    models: provider.models,
    defaultModel: provider.defaultModel,
    needsBaseUrl: !!provider.needsBaseUrl,
    keyUrl: provider.keyUrl || null,
    hint: provider.hint || null,
    hasKey: stored.has(provider.id) || !!(provider.envVar && process.env[provider.envVar]),
    envVar: provider.envVar,
  }));
}

function byId(id) {
  return PROVIDERS.find(provider => provider.id === id) || null;
}

// ── Streaming helpers ────────────────────────────────────────────────────────

/** Read an SSE body and hand each `data:` payload to `onEvent`. */
async function readEventStream(response, onEvent) {
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; a single read can hold several.
    let split;
    while ((split = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);

      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          // A partial or non-JSON keepalive frame; nothing to do.
        }
      }
    }
  }
}

async function failure(response, providerLabel) {
  let detail = '';
  try {
    const body = await response.text();
    const parsed = JSON.parse(body);
    detail = (parsed.error && (parsed.error.message || parsed.error.type)) || body.slice(0, 300);
  } catch {
    detail = `HTTP ${response.status}`;
  }

  if (response.status === 401 || response.status === 403) {
    return new Error(`${providerLabel} rejected the API key. ${detail}`);
  }
  if (response.status === 429) {
    return new Error(`${providerLabel} is rate limiting: ${detail}`);
  }
  return new Error(`${providerLabel} error (${response.status}): ${detail}`);
}

// ── Anthropic ────────────────────────────────────────────────────────────────

async function anthropicChat({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      stream: true,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) throw await failure(response, 'Anthropic');

  let stopReason = null;
  await readEventStream(response, (event) => {
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      onDelta(event.delta.text);
    } else if (event.type === 'message_delta' && event.delta) {
      stopReason = event.delta.stop_reason || stopReason;
    } else if (event.type === 'error' && event.error) {
      throw new Error(event.error.message || 'Anthropic stream error');
    }
  });

  // A refusal comes back as a successful response with no content, which would
  // otherwise look like the assistant simply saying nothing.
  if (stopReason === 'refusal') {
    throw new Error('The model declined to answer that one. Try rephrasing, or use a different model.');
  }
  return { stopReason };
}

// ── OpenAI and anything that speaks its chat API ─────────────────────────────

async function openAiChat({ apiKey, baseUrl, model, system, messages, maxTokens, signal, onDelta }) {
  const root = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', 'user-agent': USER_AGENT };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${root}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!response.ok) throw await failure(response, 'The server');

  await readEventStream(response, (event) => {
    const delta = event.choices && event.choices[0] && event.choices[0].delta;
    if (delta && delta.content) onDelta(delta.content);
  });
  return {};
}

// ── Google ───────────────────────────────────────────────────────────────────

async function googleChat({ apiKey, model, system, messages, maxTokens, signal, onDelta }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`
    + `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({
      systemInstruction: system ? { parts: [{ text: system }] } : undefined,
      generationConfig: { maxOutputTokens: maxTokens },
      contents: messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    }),
  });

  if (!response.ok) throw await failure(response, 'Google');

  await readEventStream(response, (event) => {
    const parts = event.candidates
      && event.candidates[0]
      && event.candidates[0].content
      && event.candidates[0].content.parts;
    for (const part of parts || []) {
      if (part.text) onDelta(part.text);
    }
  });
  return {};
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Stream a completion. `onDelta` is called with each text fragment.
 * Throws with a message meant to be shown to the user.
 */
async function chat({ provider, model, baseUrl, system, messages, maxTokens = 4096, signal, onDelta }) {
  const spec = byId(provider);
  if (!spec) throw new Error(`Unknown provider: ${provider}`);

  const apiKey = keys.resolve(spec.id, spec.envVar);
  if (!apiKey && spec.id !== 'compatible') {
    throw new Error(`No API key saved for ${spec.label}. Add one in the assistant's settings.`);
  }
  if (spec.needsBaseUrl && !baseUrl) {
    throw new Error('That provider needs a server address before it can be used.');
  }

  const args = { apiKey, baseUrl, model, system, messages, maxTokens, signal, onDelta };
  switch (spec.id) {
    case 'anthropic': return anthropicChat(args);
    case 'google': return googleChat(args);
    default: return openAiChat(args);
  }
}

/** A cheap round trip to prove a key works before the user relies on it. */
async function test({ provider, model, baseUrl }) {
  let text = '';
  await chat({
    provider,
    model: model || (byId(provider) || {}).defaultModel,
    baseUrl,
    system: 'Reply with the single word: ready.',
    messages: [{ role: 'user', content: 'ready?' }],
    maxTokens: 16,
    onDelta: (delta) => { text += delta; },
  });
  return text.trim();
}

module.exports = { PROVIDERS, describe, byId, chat, test };
