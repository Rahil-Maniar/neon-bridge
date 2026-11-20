// Shared configuration: paths, ports, browser detection. Everything can be overridden with env vars
// or a config.json in the bridge home directory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const HOME = path.resolve(process.env.NEON_BRIDGE_HOME || path.join(os.homedir(), '.neon-bridge'));
let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch {}

const num = (env, key, def) => +(process.env[env] || file[key] || def);

function findBrowser() {
  const explicit = process.env.NEON_BROWSER || file.browserPath;
  if (explicit) return explicit;
  const env = process.env;
  const candidates = process.platform === 'win32' ? [
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try { const p = execSync(`command -v ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (p) return p; } catch {}
    }
  }
  return null;
}

module.exports = {
  HOME,
  PROFILE: path.join(HOME, 'profile'),
  STORE: path.join(HOME, 'sessions.json'),
  LOG: path.join(HOME, 'daemon.log'),
  TMP: path.join(HOME, 'tmp'),
  CDP_PORT: num('NEON_CDP_PORT', 'cdpPort', 9333),
  API_PORT: num('NEON_API_PORT', 'apiPort', 9334),
  IDLE_MIN: num('NEON_IDLE_MINUTES', 'idleMinutes', 45),
  DEFAULT_MODEL: process.env.NEON_MODEL || file.model || 'Neon',
  GEMINI_URL: 'https://gemini.google.com/app',
  PLAYWRIGHT_VERSION: '1.49.1',
  findBrowser,
};
