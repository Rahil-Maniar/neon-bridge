// Agent-mode tools: the model asks for these in a ```neon-tools block, the CLI runs them inside ROOT
// and sends the results back. Everything here is read-only except RUN, which only runs commands the
// caller explicitly allowed with --allow-run.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DENY = [/(^|[\\/])\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i, /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)/i,
  /credentials?(\.json)?$/i, /(^|[\\/])secrets?(\.|[\\/]|$)/i, /(^|[\\/])\.git[\\/]/i, /(^|[\\/])\.(npmrc|netrc|pypirc)$/i,
  /(^|[\\/])\.(ssh|aws|gnupg|docker|kube)[\\/]/i];
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', 'bin', 'obj', '.neon-bridge']);
const MAX_OUT = 60000;
const TOOL_NAMES = ['READ', 'LIST', 'GREP', 'FIND', 'DEFS', 'GIT', 'RUN'];
const denied = p => DENY.some(r => r.test(p));

function resolveIn(root, p) {
  const full = path.resolve(root, p || '.');
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the allowed folder');
  if (denied(full)) throw new Error('denied (sensitive file)');
  return full;
}
let walked = 0;
function* walk(dir, depth = 0, maxDepth = 12) {
  if (depth === 0) walked = 0;
  if (++walked > 20000) return;
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && depth < maxDepth) { yield { f, dir: true, depth }; yield* walk(f, depth + 1, maxDepth); } }
    else yield { f, dir: false, depth };
  }
}
const isText = f => { try { return !fs.readFileSync(f).subarray(0, 4096).includes(0); } catch { return false; } };

// Text files under dir that are safe to search, as [relPath, lines].
function* searchable(root, dir) {
  for (const e of walk(dir)) {
    if (e.dir || denied(e.f)) continue;
    try { if (fs.statSync(e.f).size > 2e6 || !isText(e.f)) continue; } catch { continue; }
    yield [path.relative(root, e.f), fs.readFileSync(e.f, 'utf8').split(/\r?\n/)];
  }
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
  let out = filterDiff((r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''));
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
      const out = (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
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

async function runTool(root, line, opts = {}) {
  const m = line.trim().match(new RegExp(`^(${TOOL_NAMES.join('|')})\\b\\s*(.*)$`, 'i'));
  if (!m) return `ERROR: unknown command "${line.trim()}"`;
  const cmd = m[1].toUpperCase(), arg = m[2].trim();
  try {
    if (cmd === 'READ') {
      const mm = arg.match(/^(.+?)(?:\s+(\d+)\s*[-:]\s*(\d+))?$/);
      if (!mm) return 'ERROR: usage: READ <file> [a-b]';
      const rel = mm[1].replace(/^["']|["']$/g, ''), f = resolveIn(root, rel);
      if (!isText(f)) return 'ERROR: binary or unreadable file';
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
      const a = mm[2] ? Math.max(1, +mm[2]) : 1, b = mm[3] ? Math.min(lines.length, +mm[3]) : Math.min(lines.length, a + 799);
      let out = lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n');
      if (b < lines.length) out += `\n... (${lines.length} lines total; READ ${rel} ${b + 1}-${Math.min(lines.length, b + 800)} for more)`;
      return out;
    }
    if (cmd === 'LIST') {
      const mm = arg.match(/^(.*?)(?:\s+depth=(\d+))?$/);
      const d = resolveIn(root, mm[1] || '.'), maxD = mm[2] ? +mm[2] : 2, out = [];
      for (const e of walk(d, 0, maxD - 1)) { out.push('  '.repeat(e.depth) + path.basename(e.f) + (e.dir ? '/' : '')); if (out.length >= 400) { out.push('... (truncated)'); break; } }
      return out.join('\n') || '(empty)';
    }
    if (cmd === 'GREP') {
      let a = arg, ctx = 0;
      const cm = a.match(/\s+context=(\d+)\s*$/); if (cm) { ctx = Math.min(5, +cm[1]); a = a.slice(0, cm.index); }
      const mm = a.match(/^\/(.+)\/([a-z]*)\s*(.*)$/) || a.match(/^(\S+)()\s*(.*)$/);
      if (!mm) return 'ERROR: usage: GREP /regex/[i] [dir] [context=N]';
      const re = new RegExp(mm[1], (mm[2] || '').replace(/[^imsu]/g, '')), d = resolveIn(root, mm[3] || '.'), out = [];
      let hits = 0;
      outer: for (const [rel, lines] of searchable(root, d)) {
        let shownTo = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (++hits > 150) { out.push('... (truncated at 150 matches)'); break outer; }
          if (!ctx) { out.push(`${rel}:${i + 1}: ${lines[i].slice(0, 240)}`); continue; }
          const from = Math.max(0, i - ctx, shownTo + 1), to = Math.min(lines.length - 1, i + ctx);
          if (from > shownTo + 1 && out.length) out.push('--');
          for (let j = from; j <= to; j++) out.push(`${rel}:${j + 1}${j === i ? ':' : '-'} ${lines[j].slice(0, 240)}`);
          shownTo = to;
        }
      }
      return out.join('\n') || '(no matches)';
    }
    if (cmd === 'FIND') {
      const needle = arg.toLowerCase().replace(/\*/g, ''), out = [];
      for (const e of walk(root)) { if (path.basename(e.f).toLowerCase().includes(needle)) out.push(path.relative(root, e.f) + (e.dir ? '/' : '')); if (out.length >= 200) break; }
      return out.join('\n') || '(nothing found)';
    }
    if (cmd === 'DEFS') {
      const mm = arg.match(/^(\S+)\s*(.*)$/);
      if (!mm) return 'ERROR: usage: DEFS <name> [dir]';
      const re = defsRegex(mm[1]), d = resolveIn(root, mm[2] || '.'), out = [];
      for (const [rel, lines] of searchable(root, d)) {
        lines.forEach((l, i) => { if (out.length < 100 && re.test(l)) out.push(`${rel}:${i + 1}: ${l.trim().slice(0, 240)}`); });
        if (out.length >= 100) { out.push('... (truncated at 100)'); break; }
      }
      return out.join('\n') || `(no definition of "${mm[1]}" found; try GREP)`;
    }
    if (cmd === 'GIT') return runGit(root, arg);
    if (cmd === 'RUN') return await runCommand(root, arg, opts);
  } catch (e) { return 'ERROR: ' + e.message; }
}

function agentPreamble(root, opts = {}) {
  const run = (opts.allowRun || []).length;
  return `You are working as a careful engineering assistant with access to a folder on my computer (the "workspace", root = ${root}). You cannot see it unless you ask. ${run ? 'You can read anything and run a few allowed commands, but you cannot edit files.' : 'Your access is read-only.'}

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

// Check (never apply) a patch against ROOT. Returns {ok, strip, error}.
function checkPatch(root, patch, file) {
  for (const p of patchPaths(patch)) {
    try { resolveIn(root, p); } catch (e) { return { ok: false, error: `${p}: ${e.message}` }; }
  }
  fs.writeFileSync(file, patch);
  let firstErr = '';
  for (const strip of [1, 0]) {
    const r = spawnSync('git', ['apply', '--check', '--recount', '--ignore-whitespace', `-p${strip}`, file], { cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.error) return { ok: null, error: r.error.code === 'ENOENT' ? 'git is not installed, so the patch could not be checked' : r.error.message };
    if (r.status === 0) return { ok: true, strip };
    if (strip === 1) firstErr = (r.stderr || r.stdout || '').trim();
  }
  return { ok: false, error: firstErr || 'git apply --check failed' };
}

module.exports = { runTool, agentPreamble, extractTools, extractPatch, checkPatch, patchPaths, tokenize, MAX_OUT };
