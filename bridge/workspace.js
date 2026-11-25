// The agent-mode workspace: one or more folders Neon may read, and the rules for what it may see.
// - several folders appear as top-level names ("portal/app/x.php", "frontend/src/y.ts")
// - in git repos, files git ignores are hidden (build output, local junk, anything in .gitignore)
// - data files (spreadsheets, CSVs, database files, dumps, upload folders) are hidden unless allowed
// - values that look like credentials are redacted from everything Neon is shown
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SECRETS } = require('./chat');

const DENY = [/(^|[\\/])\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i, /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)/i,
  /credentials?(\.json)?$/i, /(^|[\\/])secrets?(\.|[\\/]|$)/i, /(^|[\\/])\.git[\\/]/i, /(^|[\\/])\.(npmrc|netrc|pypirc)$/i,
  /(^|[\\/])\.(ssh|aws|gnupg|docker|kube)[\\/]/i];
const denied = p => DENY.some(r => r.test(p));
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', 'bin', 'obj', '.neon-bridge']);
const DATA_EXT = /\.(csv|tsv|xlsx?|xlsm|xlsb|ods|numbers|parquet|feather|avro|orc|sqlite3?|db|mdb|accdb|dbf|dump|bak|pkl|pickle|npy|npz|h5|hdf5|jsonl|ndjson)$/i;
const DATA_DIRS = /(^|[\\/])(uploads?|dumps?|backups?|exports?)([\\/]|$)/i;
const isData = rel => DATA_EXT.test(rel) || DATA_DIRS.test(rel);
const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|py|php|rb|go|rs|java|kt|kts|cs|cpp|cc|c|h|hpp|swift|scala|sql|vue|svelte|dart|lua|pl|sh|ps1)$/i;

// ---------- redaction ----------
const SECRET_KEY = '(?:password|passwd|pwd|passphrase|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|client[_ -]?secret|auth)';
// In code, only literal strings assigned to secret-named keys (so `password = request.form[...]` stays readable).
const CODE_ASSIGN = new RegExp(`\\b([\\w.$-]*${SECRET_KEY}[\\w.$-]*["']?\\s*(?:[:=]|=>)\\s*)(["'\`])([^"'\`\\s]{4,})\\2`, 'gi');
// In notes, configs and logs, any value after a secret-named key ("password: 12 chars, starts 'ab'").
const TEXT_ASSIGN = new RegExp(`^(\\s*[-#*>\\w .]*?${SECRET_KEY}[\\w .-]*?\\s*[:=]\\s*)(?!\\[REDACTED\\])(\\S.*)$`, 'gim');
// Credentials embedded in URLs: scheme://user:password@host
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{2,})(@)/gi;
const PLACEHOLDER = /^(\.\.\.|x+|\*+|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|changeme|your[_-]?\w*|example\w*|placeholder|null|none|true|false|""|''|os\.environ.*|process\.env.*|getenv.*|env\(.*)$/i;

function redactSecrets(text, file = '') {
  let n = 0;
  const hit = () => { n++; return '[REDACTED]'; };
  for (const re of SECRETS) text = text.replace(re, hit);
  text = text.replace(URL_CREDS, (m, a, pw, at) => (PLACEHOLDER.test(pw) ? m : (n++, `${a}[REDACTED]${at}`)));
  text = text.replace(CODE_ASSIGN, (m, a, q, v) => (PLACEHOLDER.test(v) ? m : (n++, `${a}${q}[REDACTED]${q}`)));
  if (!CODE_EXT.test(file)) {
    text = text.replace(TEXT_ASSIGN, (m, a, v) => (PLACEHOLDER.test(v.trim()) || /^(str|string|int|bool|Optional|=)\b/.test(v) ? m : (n++, `${a}[REDACTED]`)));
  }
  return { text, count: n };
}

// ---------- workspace ----------
function gitTracked(dir) {
  // Tracked files plus new files that aren't ignored: what `git status` would show.
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: dir, encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return null; // not a git repo (or git missing): no git filter
  const files = new Set(), dirs = new Set(['']);
  for (const f of r.stdout.split('\0').filter(Boolean)) {
    const p = f.replace(/\//g, path.sep);
    files.add(p);
    for (let d = path.dirname(p); d !== '.' && !dirs.has(d); d = path.dirname(d)) dirs.add(d);
  }
  return { files, dirs };
}

// specs: [{ name?, dir }]. With one folder, paths are relative to it; with several, each is a top-level name.
function createWorkspace(specs, { trackedOnly = true, includeData = false } = {}) {
  if (!specs.length) throw new Error('no folders given');
  const used = new Set();
  const roots = specs.map(s => {
    const dir = path.resolve(s.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('agent folder not found: ' + dir);
    let name = (s.name || path.basename(dir) || 'root').replace(/[^\w.-]/g, '_');
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${s.name || path.basename(dir)}-${i}`;
    used.add(name.toLowerCase());
    return { name, dir, real: fs.realpathSync(dir), tracked: trackedOnly ? gitTracked(dir) : null };
  });
  const multi = roots.length > 1;

  // Is this file or folder (inside root) something Neon may see?
  const visible = (root, full, isDir) => {
    const rel = path.relative(root.dir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    if (denied(full)) return false;
    if (rel && rel.split(path.sep).some(seg => SKIP_DIRS.has(seg))) return false;
    if (!includeData && rel && isData(rel)) return false;
    if (root.tracked && rel) return isDir ? root.tracked.dirs.has(rel) : root.tracked.files.has(rel);
    return true;
  };

  const ws = {
    roots, multi,
    // Resolve a path Neon gave ("frontend/src/x.ts", or "src/x.ts" with one folder).
    resolve(p, { allowRoot = true } = {}) {
      const clean = String(p || '.').replace(/^["']|["']$/g, '').replace(/^\.?[\\/]+/, '') || '.';
      let root = roots[0], rest = clean;
      if (multi) {
        if (clean === '.' ) { if (allowRoot) return { root: null, full: null, top: true }; throw new Error('give a path inside one of: ' + roots.map(r => r.name).join(', ')); }
        const [head, ...tail] = clean.split(/[\\/]/);
        root = roots.find(r => r.name.toLowerCase() === head.toLowerCase());
        if (!root) throw new Error(`unknown folder "${head}"; the workspace has: ${roots.map(r => r.name).join(', ')}`);
        rest = tail.join('/') || '.';
      }
      const full = path.resolve(root.dir, rest);
      const rel = path.relative(root.dir, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the allowed folder');
      if (denied(full)) throw new Error('denied (sensitive file)');
      // Follow symlinks: the real target must still be inside an allowed folder.
      if (fs.existsSync(full)) {
        const real = fs.realpathSync(full);
        if (!roots.some(r => real === r.real || real.startsWith(r.real + path.sep))) throw new Error('outside the allowed folder (symlink)');
      }
      const isDir = fs.existsSync(full) && fs.statSync(full).isDirectory();
      if (rel && fs.existsSync(full) && !visible(root, full, isDir)) {
        if (!includeData && isData(rel)) throw new Error('hidden (data file; the user can allow these with --include-data)');
        if (root.tracked) throw new Error('hidden (ignored by git)');
        throw new Error('hidden');
      }
      return { root, full, rel, isDir };
    },
    // Path as Neon should see it.
    show(root, full) {
      const rel = path.relative(root.dir, full).split(path.sep).join('/');
      return multi ? (rel ? `${root.name}/${rel}` : root.name) : (rel || '.');
    },
    // Walk visible entries under a folder.
    *walk(root, dir, maxDepth = 12) {
      let count = 0;
      const go = function* (d, depth) {
        if (++count > 20000) return;
        let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        ents.sort((a, b) => a.name.localeCompare(b.name));
        for (const e of ents) {
          if (e.isSymbolicLink()) continue; // never follow links while walking
          const f = path.join(d, e.name), isDir = e.isDirectory();
          if (!visible(root, f, isDir)) continue;
          if (isDir) { if (depth < maxDepth) { yield { f, dir: true, depth }; yield* go(f, depth + 1); } }
          else yield { f, dir: false, depth };
        }
      };
      yield* go(dir, 0);
    },
    // The folders to search for a path argument ("" or "." = everything).
    targets(p) {
      if (!p || p === '.') return roots.map(r => ({ root: r, dir: r.dir }));
      const r = ws.resolve(p);
      return [{ root: r.root, dir: r.full }];
    },
    summary() {
      return roots.map(r => `${r.name} (${r.tracked ? `${r.tracked.files.size} files, git-ignored ones hidden` : 'not a git repo: all files'})`).join(', ') +
        (includeData ? '' : '; data files hidden');
    },
  };
  return ws;
}

// "--agent name=DIR" or "--agent DIR"
function parseAgentArg(s) {
  const m = String(s).match(/^([A-Za-z][\w.-]*)=(.+)$/);
  return m && !/^[A-Za-z]:[\\/]/.test(s) ? { name: m[1], dir: m[2] } : { dir: s };
}

module.exports = { createWorkspace, parseAgentArg, redactSecrets, denied, isData };
