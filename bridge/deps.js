// Locate playwright-core: the repo's own node_modules (dev checkout) or the bridge home (plugin installs,
// where the plugin directory is replaced on every update). Installs it into the bridge home on first use.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');
const cfg = require('./config');

const SEARCH = [path.join(__dirname, '..'), cfg.HOME];

function resolvePlaywright() {
  for (const base of SEARCH) {
    try { return createRequire(path.join(base, 'noop.js'))('playwright-core'); } catch {}
  }
  return null;
}

function ensurePlaywright(log = () => {}) {
  if (resolvePlaywright()) return true;
  log(`installing playwright-core@${cfg.PLAYWRIGHT_VERSION} into ${cfg.HOME} (one-time, no browser download)...`);
  fs.mkdirSync(cfg.HOME, { recursive: true });
  const pkg = path.join(cfg.HOME, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'neon-bridge-home', private: true }, null, 1));
  // On Windows npm is npm.cmd, so it has to run through the shell, and the shell gets the args joined
  // with plain spaces. Quote them, or a home path with a space (C:\Users\First Last) splits in two.
  const win = process.platform === 'win32';
  const args = ['install', `playwright-core@${cfg.PLAYWRIGHT_VERSION}`, '--no-audit', '--no-fund', '--prefix', cfg.HOME];
  const r = spawnSync('npm', win ? args.map(a => `"${a}"`) : args, {
    stdio: ['ignore', 'ignore', 'inherit'], shell: win,
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  if (r.status !== 0 || !resolvePlaywright()) throw new Error('Could not install playwright-core (is npm on PATH?)');
  return true;
}

module.exports = { resolvePlaywright, ensurePlaywright };
