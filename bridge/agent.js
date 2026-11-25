// Agent-mode tools: the model asks for these in a ```neon-tools block, the CLI runs them inside ROOT
// and sends the results back. Everything here is read-only except RUN, which only runs commands the
// caller explicitly allowed with --allow-run.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { createWorkspace, redactSecrets, denied } = require('./workspace');
const MAX_OUT = 60000;
const TOOL_NAMES = ['READ', 'LIST', 'GREP', 'FIND', 'DEFS', 'GIT', 'RUN'];

// Older callers pass a folder path; turn it into a (cached) one-folder workspace.
const wsCache = new Map();
const asWorkspace = w => {
  if (typeof w !== 'string') return w;
  if (!wsCache.has(w)) wsCache.set(w, createWorkspace([{ dir: w }]));
  return wsCache.get(w);
};
const isText = f => { try { return !fs.readFileSync(f).subarray(0, 4096).includes(0); } catch { return false; } };

// Visible text files under the given folders, as [shownPath, lines, file].
function* searchable(ws, targets) {
  for (const t of targets) {
    const items = fs.statSync(t.dir).isDirectory() ? ws.walk(t.root, t.dir) : [{ f: t.dir, dir: false }];
    for (const e of items) {
      if (e.dir) continue;
      try { if (fs.statSync(e.f).size > 2e6 || !isText(e.f)) continue; } catch { continue; }
      yield [ws.show(t.root, e.f), fs.readFileSync(e.f, 'utf8').split(/\r?\n/), e.f];
    }
  }
}

// With several folders, GIT and RUN name the folder first ("GIT frontend log -n 5").
function pickRoot(ws, arg) {
  if (!ws.multi) return { root: ws.roots[0], rest: arg };
  const m = arg.match(/^(\S+)\s*([\s\S]*)$/) || [];
  const root = ws.roots.find(r => r.name.toLowerCase() === String(m[1] || '').toLowerCase());
  if (!root) throw new Error(`name the folder first, one of: ${ws.roots.map(r => r.name).join(', ')}`);
  return { root, rest: m[2] || '' };
}

// Split a command line into args, honoring "double" and 'single' quotes.
function tokenize(s) {
  const out = []; let cur = '', q = null, has = false;
  for (const c of s) {
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") { q = c; has = true; }
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += c;
  }
  if (q) throw new Error('unbalanced quote');
  if (cur || has) out.push(cur);
  return out;
}

const clip = (s, head = 3000, tail = 15000) => s.length > head + tail ? s.slice(0, head) + `\n... (${s.length - head - tail} chars omitted) ...\n` + s.slice(-tail) : s;

// ---------- GIT (read-only subcommands) ----------
const GIT_SUBS = new Set(['diff', 'log', 'show', 'blame', 'status', 'ls-files', 'grep', 'shortlog', 'rev-parse', 'branch', 'tag']);
// Options that write files, run programs, or reach outside the repo.
const GIT_BAD_ARG = /^(--output|--ext-diff|--no-index|--exec|--upload-pack|--receive-pack|--open-files-in-pager|-O|--contents)/;
// branch/tag can create, delete or rename, so only listing flags are accepted there.
const GIT_LIST_ARG = /^(-a|-r|-l|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--contains(=.*)?|--no-contains(=.*)?|--merged(=.*)?|--no-merged(=.*)?|--points-at(=.*)?|--sort=.*|--format=.*|-n\d*)$/;

// Drop per-file diff sections whose path looks sensitive.
function filterDiff(out) {
  let skip = false;
  return out.split('\n').filter(l => {
    const m = l.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) skip = denied(m[1]) || denied(m[2]);
    else if (/^commit [0-9a-f]{7,}/.test(l)) skip = false;
    return !skip;
  }).join('\n');
}

function runGit(root, arg) {
  const args = tokenize(arg);
  const sub = (args[0] || '').toLowerCase();
  if (!GIT_SUBS.has(sub)) return `ERROR: GIT supports only: ${[...GIT_SUBS].join(', ')}`;
  for (const a of args.slice(1)) {
    if (GIT_BAD_ARG.test(a)) return `ERROR: option not allowed: ${a}`;
    if (denied(a.replace(/^[^:]*:/, '')) || denied(a)) return `ERROR: denied (sensitive path): ${a}`;
    if ((sub === 'branch' || sub === 'tag') && !GIT_LIST_ARG.test(a)) return `ERROR: GIT ${sub} can only list (option not allowed: ${a})`;
  }
  const r = spawnSync('git', ['--no-pager', '-c', 'color.ui=never', '-c', 'core.quotepath=off', ...args],
    { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, input: '', windowsHide: true });
  if (r.error) return 'ERROR: ' + (r.error.code === 'ENOENT' ? 'git is not installed' : r.error.message);
  let out = redactSecrets(filterDiff((r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''))).text;
  if (r.status !== 0) out = `(exit ${r.status})\n` + out;
  return clip(out.trimEnd()) || '(no output)';
}

// ---------- RUN (only commands the caller allowed) ----------
// cmd.exe would interpret these even inside our quoting, so they are refused on Windows.
const WIN_UNSAFE = /[&|<>^%"\r\n]/;

function runCommand(root, arg, opts) {
  const allow = opts.allowRun || [];
  if (!allow.length) return 'ERROR: RUN is not enabled for this task';
  let argv; try { argv = tokenize(arg); } catch (e) { return 'ERROR: ' + e.message; }
  if (!argv.length) return 'ERROR: empty command';
  const ok = allow.some(a => { const p = tokenize(a); return p.length && p.every((t, i) => argv[i] === t); });
  if (!ok) return `ERROR: not an allowed command. Allowed (each may be followed by extra arguments): ${allow.join(' | ')}`;
  const win = process.platform === 'win32';
  if (win && argv.some(t => WIN_UNSAFE.test(t))) return 'ERROR: arguments may not contain & | < > ^ % or quotes';
  const timeout = (opts.runTimeoutSec || 300) * 1000, t0 = Date.now();
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
  // On Windows npm/npx/yarn are .cmd shims that need a shell; the args were checked above.
  const child = win
    ? spawn(argv.map(t => /\s/.test(t) || t === '' ? `"${t}"` : t).join(' '), { cwd: root, shell: true, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(argv[0], argv.slice(1), { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    const cap = (acc, c) => acc.length < 8e6 ? acc + c : acc;
    child.stdout.setEncoding('utf8').on('data', c => { stdout = cap(stdout, c); });
    child.stderr.setEncoding('utf8').on('data', c => { stderr = cap(stderr, c); });
    const finish = text => { if (done) return; done = true; clearTimeout(timer); clearTimeout(grace); resolve(text); };
    // Kill the whole process tree: with a shell, killing only the shell would leave the real command running.
    const killTree = () => {
      try { if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    let grace;
    const timer = setTimeout(() => { timedOut = true; killTree(); grace = setTimeout(() => finish(report(null)), 5000); }, timeout);
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    const report = code => {
      const out = redactSecrets((stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).replace(/\x1b\[[0-9;]*m/g, '').trimEnd(), 'output.log').text;
      return timedOut ? `ERROR: timed out after ${secs()}s\n` + clip(out) : `(exit ${code}, ${secs()}s)\n` + (clip(out) || '(no output)');
    };
    child.on('error', e => finish('ERROR: ' + (e.code === 'ENOENT' ? `command not found: ${argv[0]}` : e.message)));
    child.on('close', code => finish(report(code)));
  });
}

// ---------- DEFS (find where a symbol is defined) ----------
function defsRegex(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp([
    `\\b(?:function\\*?|def|class|interface|type|struct|enum|trait|impl|fn|func|module|namespace|record|object|protocol|macro|sub|typedef)\\s+${n}\\b`,
    `\\b(?:const|let|var|val)\\s+${n}\\s*[:=]`,
    `(?:^|[\\s,{])${n}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`,
    `^\\s*(?:(?:export|default|public|private|protected|internal|static|async|override|abstract|virtual|final|readonly|inline|pub(?:\\([^)]*\\))?)\\s+)*${n}\\s*\\([^;]*\\)\\s*(?::[^;{]*)?\\{\\s*$`,
    `\\bfunc\\s+\\([^)]*\\)\\s+${n}\\b`,
    `#\\s*define\\s+${n}\\b`,
    `^\\s*(?:export\\s+)?(?:default\\s+)?${n}\\s*=\\s*(?!=)`,
  ].join('|'));
}

async function runTool(workspace, line, opts = {}) {
  const m = line.trim().match(new RegExp(`^(${TOOL_NAMES.join('|')})\\b\\s*(.*)$`, 'i'));
  if (!m) return `ERROR: unknown command "${line.trim()}"`;
  const cmd = m[1].toUpperCase(), arg = m[2].trim();
  try {
    const ws = asWorkspace(workspace);
    if (cmd === 'READ') {
      const mm = arg.match(/^(.+?)(?:\s+(\d+)\s*[-:]\s*(\d+))?$/);
      if (!mm) return 'ERROR: usage: READ <file> [a-b]';
      const r = ws.resolve(mm[1], { allowRoot: false });
      if (r.isDir) return 'ERROR: that is a folder; use LIST';
      if (!isText(r.full)) return 'ERROR: binary or unreadable file';
      const lines = fs.readFileSync(r.full, 'utf8').split(/\r?\n/);
      const a = mm[2] ? Math.max(1, +mm[2]) : 1, b = mm[3] ? Math.min(lines.length, +mm[3]) : Math.min(lines.length, a + 799);
      // Redact before numbering the lines, so patterns that start at the beginning of a line still match.
      const red = redactSecrets(lines.slice(a - 1, b).join('\n'), r.full);
      let out = red.text.split('\n').map((l, i) => `${a + i}\t${l}`).join('\n');
      if (b < lines.length) out += `\n... (${lines.length} lines total; READ ${ws.show(r.root, r.full)} ${b + 1}-${Math.min(lines.length, b + 800)} for more)`;
      if (red.count) out += `\n(${red.count} value(s) that looked like credentials were redacted)`;
      return out;
    }
    if (cmd === 'LIST') {
      const mm = arg.match(/^(.*?)(?:\s+depth=(\d+))?$/);
      const maxD = mm[2] ? +mm[2] : 2, out = [], p = mm[1] || '.';
      if (ws.multi && (p === '.' || p === '')) { // several folders: show each one's top levels
        for (const root of ws.roots) {
          out.push(root.name + '/');
          for (const e of ws.walk(root, root.dir, maxD - 2)) { out.push('  '.repeat(e.depth + 1) + path.basename(e.f) + (e.dir ? '/' : '')); if (out.length >= 400) break; }
          if (out.length >= 400) { out.push('... (truncated)'); break; }
        }
        return out.join('\n') || '(empty)';
      }
      const r = ws.resolve(p);
      for (const e of ws.walk(r.root, r.full, maxD - 1)) { out.push('  '.repeat(e.depth) + path.basename(e.f) + (e.dir ? '/' : '')); if (out.length >= 400) { out.push('... (truncated)'); break; } }
      return out.join('\n') || '(empty)';
    }
    if (cmd === 'GREP') {
      let a = arg, ctx = 0;
      const cm = a.match(/\s+context=(\d+)\s*$/); if (cm) { ctx = Math.min(5, +cm[1]); a = a.slice(0, cm.index); }
      const mm = a.match(/^\/(.+)\/([a-z]*)\s*(.*)$/) || a.match(/^(\S+)()\s*(.*)$/);
      if (!mm) return 'ERROR: usage: GREP /regex/[i] [dir] [context=N]';
      const re = new RegExp(mm[1], (mm[2] || '').replace(/[^imsu]/g, '')), out = [];
      let hits = 0, redacted = 0;
      outer: for (const [shown, lines, file] of searchable(ws, ws.targets(mm[3]))) {
        let shownTo = -1;
        const emit = (j, mark) => { const r = redactSecrets(lines[j].slice(0, 240), file); redacted += r.count; out.push(`${shown}:${j + 1}${mark} ${r.text}`); };
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (++hits > 150) { out.push('... (truncated at 150 matches)'); break outer; }
          if (!ctx) { emit(i, ':'); continue; }
          const from = Math.max(0, i - ctx, shownTo + 1), to = Math.min(lines.length - 1, i + ctx);
          if (from > shownTo + 1 && out.length) out.push('--');
          for (let j = from; j <= to; j++) emit(j, j === i ? ':' : '-');
          shownTo = to;
        }
      }
      if (redacted) out.push(`(${redacted} value(s) that looked like credentials were redacted)`);
      return out.join('\n') || '(no matches)';
    }
    if (cmd === 'FIND') {
      const needle = arg.toLowerCase().replace(/\*/g, ''), out = [];
      for (const root of ws.roots) for (const e of ws.walk(root, root.dir)) {
        if (path.basename(e.f).toLowerCase().includes(needle)) out.push(ws.show(root, e.f) + (e.dir ? '/' : ''));
        if (out.length >= 200) return out.join('\n');
      }
      return out.join('\n') || '(nothing found)';
    }
    if (cmd === 'DEFS') {
      const mm = arg.match(/^(\S+)\s*(.*)$/);
      if (!mm) return 'ERROR: usage: DEFS <name> [dir]';
      const re = defsRegex(mm[1]), out = [];
      for (const [shown, lines, file] of searchable(ws, ws.targets(mm[2]))) {
        lines.forEach((l, i) => { if (out.length < 100 && re.test(l)) out.push(`${shown}:${i + 1}: ${redactSecrets(l.trim().slice(0, 240), file).text}`); });
        if (out.length >= 100) { out.push('... (truncated at 100)'); break; }
      }
      return out.join('\n') || `(no definition of "${mm[1]}" found; try GREP)`;
    }
    if (cmd === 'GIT') { const { root, rest } = pickRoot(ws, arg); return runGit(root.dir, rest); }
    if (cmd === 'RUN') { const { root, rest } = pickRoot(ws, arg); return await runCommand(root.dir, rest, opts); }
  } catch (e) { return 'ERROR: ' + e.message; }
}

function agentPreamble(workspace, opts = {}) {
  const ws = asWorkspace(workspace);
  const run = (opts.allowRun || []).length;
  const where = ws.multi
    ? `several folders on my computer (the "workspace"): ${ws.roots.map(r => '`' + r.name + '/`').join(', ')}. Paths start with the folder name (e.g. \`${ws.roots[1].name}/README.md\`); GIT${run ? ' and RUN' : ''} take the folder name first (e.g. \`GIT ${ws.roots[0].name} log --oneline -n 10\`)`
    : `a folder on my computer (the "workspace", root = ${ws.roots[0].dir})`;
  return `You are working as a careful engineering assistant with access to ${where}. You cannot see it unless you ask. ${run ? 'You can read anything and run a few allowed commands, but you cannot edit files.' : 'Your access is read-only.'} Only files that are part of the project are visible: data files and secrets are hidden, and values that look like credentials show as [REDACTED].

To use a tool, reply with ONLY a fenced block like this and nothing else, then stop and wait:
\`\`\`neon-tools
LIST . depth=2
READ src/app.py 200-400
GREP /def handle_\\w+/ src context=2
DEFS handle_request
GIT log --oneline -n 20 -- src/app.py
\`\`\`
Commands (paths relative to the root; one per line; up to 8 per block):
- LIST <dir> [depth=N]            : directory tree (default depth 2)
- READ <file> [a-b]               : file with line numbers (800 lines per call)
- GREP /regex/[i] [dir] [context=N] : search file contents, optionally with N lines of context (max 5)
- FIND <name-part>                : find files/folders by name
- DEFS <name> [dir]               : find where a function/class/variable is defined
- GIT <subcommand> [args]         : read-only git: diff, log, show, blame, status, ls-files, grep, shortlog, rev-parse, branch, tag (e.g. GIT blame -L 40,80 src/app.py, GIT show HEAD~1 --stat)
${run ? `- RUN <command> [args]           : run a command in the root and get its exit code and output. Only these are allowed (each may be followed by extra arguments): ${opts.allowRun.map(a => '`' + a + '`').join(', ')}. Use it to check your ideas, e.g. run the tests before and after reasoning about a fix.\n` : ''}I will reply with the results. Use as many rounds as you need, but batch commands. Do not guess file contents—read them.
When you have enough information, give your FINAL answer as normal markdown with NO neon-tools block. Cite files as path:line where relevant.
${opts.patch ? `
If your answer involves code changes, include them in your FINAL answer as ONE unified diff (like \`git diff\` output, paths prefixed a/ and b/, relative to the root, with correct context lines copied exactly from the files) inside a fenced block labeled neon-patch:
\`\`\`neon-patch
diff --git a/src/app.py b/src/app.py
--- a/src/app.py
+++ b/src/app.py
@@ -10,3 +10,4 @@
 unchanged line
-old line
+new line
\`\`\`
I will check that it applies and tell you if it does not. I will not apply it myself; it is a proposal.
` : ''}
TASK:
`;
}

function extractTools(answer) {
  // The web UI may relabel the fence (e.g. "code snippet"), so accept any info string whose body is only tool lines.
  const names = TOOL_NAMES.join('|');
  const m = answer.match(/```neon-tools\s*\n([\s\S]*?)```/i) || answer.match(new RegExp('```[^\\n]*\\n((?:[ \\t]*(?:' + names + ')\\b[^\\n]*\\n?)+)```', 'i'));
  return m ? m[1].split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8) : null;
}

// ---------- patches ----------
// Pull unified diffs out of the final answer: neon-patch blocks first, otherwise any fenced diff.
function extractPatch(answer) {
  const blocks = [...answer.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
  const looksLikeDiff = b => /^(diff --git |--- )/m.test(b) && /^\+\+\+ /m.test(b) && /^@@ /m.test(b);
  let picked = blocks.filter(m => /neon-patch/i.test(m[1]));
  if (!picked.length) picked = blocks.filter(m => looksLikeDiff(m[2]));
  if (!picked.length) return null;
  return picked.map(m => m[2].replace(/\r\n/g, '\n').replace(/\n*$/, '\n')).join('');
}

function patchPaths(patch) {
  const set = new Set();
  for (const m of patch.matchAll(/^(?:---|\+\+\+) (\S+)/gm)) if (m[1] !== '/dev/null') set.add(m[1].replace(/^[ab]\//, ''));
  return [...set];
}

// Split a unified diff into per-file sections: [{ path, text }].
function patchSections(patch) {
  const lines = patch.split('\n'), out = [];
  const hasGitHeaders = lines.some(l => l.startsWith('diff --git '));
  let cur = null;
  lines.forEach((l, i) => {
    const starts = hasGitHeaders ? l.startsWith('diff --git ') : (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ '));
    if (starts) out.push(cur = { lines: [] });
    if (cur) cur.lines.push(l);
  });
  return out.map(s => {
    const text = s.lines.join('\n').replace(/\n*$/, '\n');
    const p = patchPaths(text).find(x => x) || '';
    return { path: p, text };
  });
}

function gitApplyCheck(dir, file, strips) {
  let firstErr = '';
  for (const strip of strips) {
    const r = spawnSync('git', ['apply', '--check', '--recount', '--ignore-whitespace', `-p${strip}`, file], { cwd: dir, encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.error) return { ok: null, error: r.error.code === 'ENOENT' ? 'git is not installed, so the patch could not be checked' : r.error.message };
    if (r.status === 0) return { ok: true, strip };
    if (!firstErr) firstErr = (r.stderr || r.stdout || '').trim();
  }
  return { ok: false, error: firstErr || 'git apply --check failed' };
}

// Check (never apply) a patch against the workspace. Returns {ok, strip, error, parts}.
// With several folders, paths start with the folder name and each folder's part is checked (and
// saved) separately: parts = [{ root, dir, file, strip }].
function checkPatch(workspace, patch, file) {
  const ws = asWorkspace(workspace);
  for (const p of patchPaths(patch)) {
    try { ws.resolve(p, { allowRoot: false }); } catch (e) { return { ok: false, error: `${p}: ${e.message}` }; }
  }
  fs.writeFileSync(file, patch);
  if (!ws.multi) return gitApplyCheck(ws.roots[0].dir, file, [1, 0]);
  const groups = new Map();
  for (const s of patchSections(patch)) {
    const name = s.path.split(/[\\/]/)[0].toLowerCase();
    const root = ws.roots.find(r => r.name.toLowerCase() === name);
    if (!root) return { ok: false, error: `${s.path}: paths must start with a folder name (${ws.roots.map(r => r.name).join(', ')})` };
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s.text);
  }
  const parts = [];
  for (const [root, texts] of groups) {
    const partFile = file.replace(/(\.[^.\\/]*)?$/, `.${root.name}$1`);
    fs.writeFileSync(partFile, texts.join(''));
    const r = gitApplyCheck(root.dir, partFile, [2, 1]); // a/<folder>/path or <folder>/path
    if (!r.ok) return { ...r, error: `${root.name}: ${r.error}` };
    parts.push({ root: root.name, dir: root.dir, file: partFile, strip: r.strip });
  }
  return { ok: true, strip: null, parts };
}

module.exports = { runTool, agentPreamble, extractTools, extractPatch, checkPatch, patchPaths, tokenize, MAX_OUT };
