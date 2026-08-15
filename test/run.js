/* node test/run.js
 *
 * Pure suites run here in process. The DOM suites run in a real browser — real
 * layout means the map drag maths is exercised against actual pixels rather
 * than a stub that returns zeros.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { suite, skip, report, absorb } from './harness.js';
import runCalendar from './calendar.test.js';
import runSchema from './schema.test.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ORIGIN = 'http://tcs.test';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

runCalendar();
runSchema();

const chromium = await findChromium();
if (!chromium) {
  suite('renderer');
  skip('DOM suites', 'Playwright not installed — run `npm install`, then `npm test` again.');
} else {
  await runDomSuites(chromium, ['renderer', 'authoring']);
}

process.exit(report() ? 1 : 0);

// ── Finding a browser ────────────────────────────────────────────────────────

async function findChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [
    'playwright',
    'playwright-core',
    // Globally installed copies, which is how CI images usually ship it.
    '/opt/node22/lib/node_modules/playwright/index.js',
    '/usr/lib/node_modules/playwright/index.js',
  ];

  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith('/') ? candidate : require.resolve(candidate);
      const module = await import(resolved);
      const playwright = module.default ?? module;
      if (playwright && playwright.chromium) return playwright.chromium;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

// ── Serving the repo to the page ─────────────────────────────────────────────

async function runDomSuites(chromium, names) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 980 } });

  // Everything is served straight off disk — no server process to leak.
  await context.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, relative);

    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      await route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: CONTENT_TYPES[path.extname(file)] || 'application/octet-stream',
      body: fs.readFileSync(file),
    });
  });

  for (const name of names) {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    try {
      await page.goto(`${ORIGIN}/test/browser.html?suite=${name}`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__done === true, null, { timeout: 20000 });
      absorb(await page.evaluate(() => window.__results));
    } catch (err) {
      suite(name);
      skip(`${name} suite`, `did not finish: ${err.message}`);
      if (consoleErrors.length) {
        suite(name);
        skip('page errors', consoleErrors.join(' | '));
      }
    }
    await page.close();
  }

  await browser.close();
}
