#!/usr/bin/env node
// neon: use the Gemini web app (default model: Neon) from the command line or from Claude Code.
//
//   node neon.js setup                         one-time: install deps, sign in to Google, verify the model
//   node neon.js doctor                        check browser, deps, sign-in and model access
//   node neon.js ask [options] [prompt]        prompt from argument, --file, or stdin
//     -s, --session NAME   multi-turn: the same NAME continues the conversation
//     -a, --attach PATH    attach a file (repeatable): code, pdf, images, ...
//     --agent ROOT         agent mode: the model can LIST/READ/GREP/FIND files under ROOT (read-only)
//     --model NAME         Gemini mode to use (default: Neon, or NEON_MODEL / config.json "model")
//     --save               keep the chat in Gemini history (default: temporary chat)
//     --max-rounds N       agent-mode tool rounds (default 12)
//     --file PATH          read the prompt from a file
//     --timeout SEC        per-turn timeout (default 600)
//     --json               print the raw JSON result
//   node neon.js sessions | end NAME | status | stop [--force]
//
// Exit codes: 0 ok, 2 signed out, 3 model unavailable, 4 timeout/partial answer, 1 other error.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cfg = require('./config');
const { ensurePlaywright, resolvePlaywright } = require('./deps');

const err = (...m) => process.stderr.write('[neon] ' + m.join(' ') + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(cfg.TMP, { recursive: true });

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: cfg.API_PORT, agent: false, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Bad response: ' + d.slice(0, 200))); } });
    });
    req.on('error', reject); req.setTimeout(0);
    if (data) req.write(data); req.end();
  });
}

async function daemonUp() { try { await call('GET', '/health'); return true; } catch { return false; } }

async function ensureDaemon() {
  if (await daemonUp()) return;
  if (!fs.existsSync(cfg.PROFILE)) throw Object.assign(new Error(`Not set up yet; run: node "${__filename}" setup`), { exit: 2 });
  ensurePlaywright(err);
  err('starting daemon (hidden browser)...');
  const p = spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore', windowsHide: true });
  p.unref();
  for (let i = 0; i < 60; i++) { await sleep(500); if (await daemonUp()) return; }
  throw new Error('Daemon did not start; see ' + cfg.LOG);
}

async function forceCloseBrowser() {
  const pw = resolvePlaywright(); if (!pw) return false;
  try { const b = await pw.chromium.connectOverCDP(`http://127.0.0.1:${cfg.CDP_PORT}`); const s = await b.newBrowserCDPSession(); await s.send('Browser.close').catch(() => {}); return true; }
  catch { return false; }
}

// ---------- agent tools (read-only, confined to ROOT) ----------
const DENY = [/(^|[\\/])\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i, /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)/i,
  /credentials?(\.json)?$/i, /(^|[\\/])secrets?(\.|[\\/]|$)/i, /(^|[\\/])\.git[\\/]/i, /(^|[\\/])\.(npmrc|netrc|pypirc)$/i,
  /(^|[\\/])\.(ssh|aws|gnupg|docker|kube)[\\/]/i];
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', 'bin', 'obj', '.neon-bridge']);
const MAX_OUT = 60000;

function resolveIn(root, p) {
  const full = path.resolve(root, p || '.');
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the allowed folder');
  if (DENY.some(r => r.test(full))) throw new Error('denied (sensitive file)');
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

function runTool(root, line) {
  const m = line.trim().match(/^(READ|LIST|GREP|FIND)\s*(.*)$/i);
  if (!m) return `ERROR: unknown command "${line.trim()}"`;
  const cmd = m[1].toUpperCase(), arg = m[2].trim();
  try {
    if (cmd === 'READ') {
      const mm = arg.match(/^(.+?)(?:\s+(\d+)\s*[-:]\s*(\d+))?$/);
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
      const mm = arg.match(/^\/(.+)\/([a-z]*)\s*(.*)$/) || arg.match(/^(\S+)()\s*(.*)$/);
      const re = new RegExp(mm[1], (mm[2] || '').replace(/[^imsu]/g, '')), d = resolveIn(root, mm[3] || '.'), out = [];
      for (const e of walk(d)) {
        if (e.dir || DENY.some(r => r.test(e.f))) continue;
        try { if (fs.statSync(e.f).size > 2e6 || !isText(e.f)) continue; } catch { continue; }
        fs.readFileSync(e.f, 'utf8').split(/\r?\n/).forEach((l, i) => { if (out.length < 150 && re.test(l)) out.push(`${path.relative(root, e.f)}:${i + 1}: ${l.slice(0, 240)}`); });
        if (out.length >= 150) { out.push('... (truncated at 150 matches)'); break; }
      }
      return out.join('\n') || '(no matches)';
    }
    if (cmd === 'FIND') {
      const needle = arg.toLowerCase().replace(/\*/g, ''), out = [];
      for (const e of walk(root)) { if (path.basename(e.f).toLowerCase().includes(needle)) out.push(path.relative(root, e.f) + (e.dir ? '/' : '')); if (out.length >= 200) break; }
      return out.join('\n') || '(nothing found)';
    }
  } catch (e) { return 'ERROR: ' + e.message; }
}

const agentPreamble = root => `You are working as a careful engineering assistant with READ-ONLY access to a folder on my computer (the "workspace", root = ${root}). You cannot see it unless you ask.

To use a tool, reply with ONLY a fenced block like this and nothing else, then stop and wait:
\`\`\`neon-tools
LIST . depth=2
READ src/app.py
READ src/app.py 200-400
GREP /def handle_\\w+/ src
FIND config
\`\`\`
Commands (paths relative to the root; one per line; up to 8 per block):
- LIST <dir> [depth=N]  : directory tree (default depth 2)
- READ <file> [a-b]     : file with line numbers (800 lines per call)
- GREP /regex/[i] [dir] : search file contents
- FIND <name-part>      : find files/folders by name
I will reply with the results. Use as many rounds as you need, but batch commands. Do not guess file contents—read them.
When you have enough information, give your FINAL answer as normal markdown with NO neon-tools block. Cite files as path:line where relevant.

TASK:
`;

function extractTools(answer) {
  // The web UI may relabel the fence (e.g. "code snippet"), so accept any info string whose body is only tool lines.
  const m = answer.match(/```neon-tools\s*\n([\s\S]*?)```/i) || answer.match(/```[^\n]*\n((?:[ \t]*(?:READ|LIST|GREP|FIND)\b[^\n]*\n?)+)```/i);
  return m ? m[1].split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8) : null;
}

// ---------- commands ----------
const EXIT = { SIGNED_OUT: 2, NO_MODEL: 3, TIMEOUT: 4 };

async function doctor(model) {
  let ok = true;
  const line = (good, msg) => { console.log((good ? '  ok   ' : '  FAIL ') + msg); if (!good) ok = false; };
  console.log('neon-bridge doctor');
  line(+process.versions.node.split('.')[0] >= 18, `node ${process.versions.node} (need >= 18)`);
  const exe = cfg.findBrowser();
  line(!!exe, 'browser: ' + (exe || 'none found (install Chrome, or set NEON_BROWSER)'));
  line(!!resolvePlaywright(), 'playwright-core installed');
  line(fs.existsSync(cfg.PROFILE), 'profile: ' + cfg.PROFILE);
  if (!ok) return 1;
  await ensureDaemon();
  const r = await call('POST', '/check', { model });
  line(r.ok, r.ok ? `signed in; "${model}" is selectable` : `${r.code}: ${r.error}`);
  return r.ok ? 0 : (EXIT[r.code] || 1);
}

async function setup(model) {
  ensurePlaywright(err);
  const exe = cfg.findBrowser();
  if (!exe) { err('No Chrome/Edge/Chromium found. Install Google Chrome, or set NEON_BROWSER to the browser executable.'); return 1; }
  if (await daemonUp()) await call('POST', '/shutdown').catch(() => {});
  await sleep(1000); await forceCloseBrowser();
  fs.mkdirSync(cfg.PROFILE, { recursive: true });
  console.log(`\nA browser window will open with a separate profile (${cfg.PROFILE}).`);
  console.log('1. Sign in to Google with the account that has your Gemini subscription.');
  console.log('2. Make sure gemini.google.com loads and the model picker shows "' + model + '".');
  console.log('3. Close that browser window to continue.\n');
  // Plain launch (no automation flags) so Google sign-in behaves normally.
  const p = spawn(exe, [`--user-data-dir=${cfg.PROFILE}`, '--no-first-run', '--no-default-browser-check', cfg.GEMINI_URL], { stdio: 'ignore' });
  await new Promise(r => p.on('exit', r));
  await sleep(1500);
  console.log('Browser closed; verifying...\n');
  return doctor(model);
}

function parseArgs(argv) {
  const o = { attach: [], rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-s' || a === '--session') o.session = argv[++i];
    else if (a === '-a' || a === '--attach') o.attach.push(path.resolve(argv[++i]));
    else if (a === '--agent') o.agent = path.resolve(argv[++i]);
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--save') o.save = true;
    else if (a === '--max-rounds') o.maxRounds = +argv[++i];
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--timeout') o.timeout = +argv[++i];
    else if (a === '--json') o.json = true;
    else if (a === '--force') o.force = true;
    else o.rest.push(a);
  }
  return o;
}

async function readStdin() { if (process.stdin.isTTY) return ''; let s = ''; for await (const c of process.stdin) s += c; return s; }

async function ask(o) {
  let prompt = (o.file ? fs.readFileSync(o.file, 'utf8') : (o.rest.length ? o.rest.join(' ') : await readStdin())).trim();
  if (!prompt) { err('empty prompt'); return 1; }
  for (const f of o.attach) if (!fs.existsSync(f)) { err('attachment not found: ' + f); return 1; }
  await ensureDaemon();

  const attach = [...o.attach];
  const asFile = (text, label) => { const f = path.join(cfg.TMP, `${label}-${Date.now()}.md`); fs.writeFileSync(f, text); return f; };
  if (prompt.length > 20000) { // long prompts go up as an attached file
    const f = asFile(prompt, 'context'); attach.push(f);
    prompt = 'The full request is in the attached file ' + path.basename(f) + '. Read all of it and respond to it.';
  }

  const session = o.session || (o.agent ? `_agent_${Date.now()}` : undefined);
  const base = { session, temp: !o.save, timeoutSec: o.timeout || 600, model: o.model || cfg.DEFAULT_MODEL };
  let r = await call('POST', '/ask', { ...base, prompt: o.agent ? agentPreamble(o.agent) + prompt : prompt, attach });
  const rounds = o.maxRounds || 12;
  for (let i = 0; o.agent && r.ok && i < rounds; i++) {
    const tools = extractTools(r.answer);
    if (!tools) break;
    err(`round ${i + 1}: ` + tools.join(' ; '));
    let results = tools.map(t => `### ${t}\n\`\`\`\n${runTool(o.agent, t)}\n\`\`\``).join('\n\n');
    if (results.length > MAX_OUT) results = results.slice(0, MAX_OUT) + '\n... (results truncated; request smaller ranges)';
    const msg = 'Tool results:\n\n' + results + (i === rounds - 1 ? '\n\nThis was the last tool round. Give your FINAL answer now.' : '');
    r = msg.length > 20000
      ? await call('POST', '/ask', { ...base, prompt: `Tool results for round ${i + 1} are in the attached file. Read it fully, then continue (more neon-tools commands, or your FINAL answer).`, attach: [asFile(msg, 'tools')] })
      : await call('POST', '/ask', { ...base, prompt: msg });
  }
  if (o.agent && !o.session) await call('POST', '/end', { session }).catch(() => {});

  if (o.json) console.log(JSON.stringify(r, null, 1));
  else if (!r.ok) err(`${r.code}: ${r.error}`);
  else {
    for (const w of r.warnings || []) err('warning: ' + w);
    err(`model: Gemini ${r.model} | ${Math.round(r.ms / 1000)}s` + (o.session ? ` | session: ${o.session}` : ''));
    process.stdout.write(r.answer + '\n');
  }
  if (!r.ok) return EXIT[r.code] || 1;
  return r.partial ? 4 : 0;
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const o = parseArgs(argv);
  const model = o.model || cfg.DEFAULT_MODEL;
  switch (cmd) {
    case 'setup': return setup(model);
    case 'doctor': return doctor(model);
    case 'ask': return ask(o);
    case 'status': console.log((await daemonUp()) ? 'running' : 'not running'); return 0;
    case 'stop': {
      const up = await daemonUp();
      if (up) await call('POST', '/shutdown').catch(() => {});
      const forced = o.force ? await forceCloseBrowser() : false;
      err(up ? 'daemon stopped' : 'daemon not running'); if (forced) err('closed orphaned browser'); return 0;
    }
    case 'sessions': await ensureDaemon(); console.log(JSON.stringify(await call('GET', '/sessions'), null, 1)); return 0;
    case 'end': await ensureDaemon(); await call('POST', '/end', { session: o.rest[0] }); err('ended', o.rest[0]); return 0;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
      return cmd ? 1 : 0;
  }
}

main().then(c => process.exit(c), e => { err('error: ' + e.message); process.exit(e.exit || 1); });
