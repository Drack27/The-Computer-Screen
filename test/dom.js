/* Booting the real renderer inside a real browser.
 *
 * The page is assembled from src/renderer/index.html itself rather than a copy,
 * so the markup under test can never drift from the markup that ships. Only
 * boot.js is skipped — scripts inserted via innerHTML don't execute — which
 * leaves the tests in charge of when the app starts.
 */

import { fakeApi } from './fake-api.js';

export async function bootRenderer(fixture) {
  const response = await fetch('/src/renderer/index.html');
  const html = await response.text();
  const parsed = new DOMParser().parseFromString(html, 'text/html');

  document.body.innerHTML = parsed.body.innerHTML;

  // Nothing lays out a bitmap that doesn't exist, and the drag maths needs a
  // frame with real dimensions, so pin the map to a known size.
  const style = document.createElement('style');
  style.textContent = '#map-img { width: 1000px; height: 700px; object-fit: fill; }';
  document.head.appendChild(style);

  const errors = [];
  window.addEventListener('error', (event) => errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));

  const fake = await fakeApi(fixture);
  window.api = fake.api;

  const app = await import('/src/renderer/app.js');
  const store = await import('/src/renderer/store.js');
  await app.boot();

  return { app, store, errors, ...fake };
}

// ── Interaction helpers ──────────────────────────────────────────────────────

export const all = (selector, root = document) => [...root.querySelectorAll(selector)];

export function textOf(selector, root = document) {
  const node = root.querySelector(selector);
  return node ? node.textContent : null;
}

export function click(node) {
  if (!node) throw new Error('tried to click nothing');
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function key(name, options = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, ...options }));
}

export function input(node, value) {
  node.value = value;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Drag a box across the map, in percentages of the image. */
export function dragBox(from, to) {
  const container = document.getElementById('map-container');
  const rect = document.getElementById('map-img').getBoundingClientRect();
  const send = (type, point) => {
    container.dispatchEvent(new MouseEvent(type, {
      clientX: rect.left + (point[0] / 100) * rect.width,
      clientY: rect.top + (point[1] / 100) * rect.height,
      bubbles: true,
      cancelable: true,
    }));
  };
  send('mousedown', from);
  send('mousemove', to);
  send('mouseup', to);
}

/** Wait for the next animation frame, so a render has actually painted. */
export const settle = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
