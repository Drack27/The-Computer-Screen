/* API keys.
 *
 * Keys go through Electron's safeStorage, which hands them to the OS keychain
 * (Keychain on macOS, DPAPI on Windows, libsecret on Linux). If the platform
 * can't encrypt — a Linux box with no keyring — we say so plainly and store
 * nothing rather than writing a plaintext key to disk behind the user's back.
 */

const path = require('path');
const { app, safeStorage } = require('electron');
const { readJson, writeJsonAtomic } = require('../vault');

const KEY_FILE = () => path.join(app.getPath('userData'), 'credentials.json');

function available() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function load() {
  const raw = readJson(KEY_FILE(), {});
  return raw && typeof raw === 'object' ? raw : {};
}

/** Which providers have a key stored — never the keys themselves. */
function list() {
  const stored = load();
  return Object.keys(stored).filter(id => stored[id]);
}

function get(providerId) {
  if (!available()) return null;
  const stored = load();
  const encoded = stored[providerId];
  if (!encoded) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    return null;
  }
}

function set(providerId, key) {
  if (!available()) {
    throw new Error(
      'This system has no secure credential store available, so an API key can\'t be saved safely. '
      + 'Local models still work, and you can set the key as an environment variable instead.');
  }
  const stored = load();
  if (key) stored[providerId] = safeStorage.encryptString(key).toString('base64');
  else delete stored[providerId];
  writeJsonAtomic(KEY_FILE(), stored);
  return true;
}

/** Environment variables win, so a developer can run without storing anything. */
function resolve(providerId, envName) {
  if (envName && process.env[envName]) return process.env[envName];
  return get(providerId);
}

module.exports = { available, list, get, set, resolve };
