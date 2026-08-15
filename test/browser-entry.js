/* Runs one DOM suite and parks the results where the Node side can collect
 * them. One page load per suite keeps event listeners from stacking up between
 * runs of the store. */

import { collected } from './harness.js';

const suiteName = new URLSearchParams(location.search).get('suite') || 'renderer';

const suites = {
  renderer: () => import('./renderer.test.js'),
  authoring: () => import('./authoring.test.js'),
};

try {
  const module = await suites[suiteName]();
  await module.default();
  window.__results = collected();
} catch (err) {
  window.__results = [{
    suite: suiteName,
    name: 'suite crashed before it could report',
    pass: false,
    note: `${err.message}\n${err.stack || ''}`,
  }];
}

window.__done = true;
