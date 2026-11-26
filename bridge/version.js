// Keeping every caller on the newest installed bridge.
//
// Claude Code installs each plugin version in its own folder (.../cache/<market>/<plugin>/<version>/),
// and a long-running chat keeps calling the folder it started with. So an old copy that finds a newer
// version next to it hands the request over to that one, and a daemon started by an older copy is
// replaced once it is idle.
const fs = require('fs');
const path = require('path');

const own = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();
const SEMVER = /^\d+\.\d+\.\d+$/;

// -1 / 0 / 1. Anything that isn't a version (e.g. an old daemon that doesn't report one) counts as oldest.
function compare(a, b) {
  const pa = SEMVER.test(a || '') ? a.split('.').map(Number) : [-1, 0, 0];
  const pb = SEMVER.test(b || '') ? b.split('.').map(Number) : [-1, 0, 0];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// The newest installed copy of the CLI, if it is newer than the one in bridgeDir.
function newerCopy(bridgeDir = __dirname, version = own) {
  const versionDir = path.dirname(bridgeDir);
  if (!SEMVER.test(path.basename(versionDir))) return null; // not running from a versioned plugin folder
  const base = path.dirname(versionDir);
  let best = null;
  try {
    for (const v of fs.readdirSync(base)) {
      const file = path.join(base, v, 'bridge', 'neon.js');
      if (SEMVER.test(v) && compare(v, version) > 0 && (!best || compare(v, best.version) > 0) && fs.existsSync(file)) best = { version: v, file };
    }
  } catch {}
  return best;
}

module.exports = { own, compare, newerCopy };
