/* Assertions and reporting.
 *
 * Deliberately dependency-free and isomorphic: the same module is imported by
 * the pure suites running under Node and by the DOM suites running inside a
 * real browser, so both halves report through one channel.
 */

const results = [];
let currentSuite = 'general';

export function suite(name) {
  currentSuite = name;
  results.push({ suite: name, heading: true });
}

export function check(name, fn) {
  try {
    const note = fn();
    results.push({ suite: currentSuite, name, pass: true, note: note || '' });
  } catch (err) {
    results.push({ suite: currentSuite, name, pass: false, note: err.message });
  }
}

export async function checkAsync(name, fn) {
  try {
    const note = await fn();
    results.push({ suite: currentSuite, name, pass: true, note: note || '' });
  } catch (err) {
    results.push({ suite: currentSuite, name, pass: false, note: err.message });
  }
}

export function skip(name, why) {
  results.push({ suite: currentSuite, name, skipped: true, note: why });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

export function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'not equal'}: got ${format(actual)}, wanted ${format(expected)}`);
  }
}

export function near(actual, expected, tolerance, message) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'not close enough'}: got ${format(actual)}, wanted ${expected} ±${tolerance}`);
  }
}

const format = (value) => (typeof value === 'string' ? `"${value}"` : String(value));

/** The collected rows, for shipping browser results back to Node. */
export function collected() {
  return results.slice();
}

export function absorb(rows) {
  for (const row of rows) results.push(row);
}

export function report() {
  let failures = 0;
  let skipped = 0;

  for (const row of results) {
    if (row.heading) {
      console.log(`\n\x1b[1m${row.suite}\x1b[0m`);
      continue;
    }
    if (row.skipped) {
      skipped++;
      console.log(`  \x1b[33m−\x1b[0m ${row.name}  \x1b[90m${row.note}\x1b[0m`);
    } else if (row.pass) {
      console.log(`  \x1b[32m✓\x1b[0m ${row.name}${row.note ? `  \x1b[90m${row.note}\x1b[0m` : ''}`);
    } else {
      failures++;
      console.log(`  \x1b[31m✗ ${row.name}\x1b[0m  ${row.note}`);
    }
  }

  const total = results.filter(row => !row.heading && !row.skipped).length;
  const tail = skipped ? `, ${skipped} skipped` : '';
  console.log(`\n${total - failures}/${total} passed${tail}`);
  return failures;
}
