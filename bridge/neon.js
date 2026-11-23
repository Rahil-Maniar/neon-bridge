#!/usr/bin/env node
// neon: use the Gemini web app (default model: Neon) from the command line or from Claude Code.
//
//   node neon.js setup                         one-time: install deps, sign in to Google, verify the model
//   node neon.js doctor                        check browser, deps, sign-in and model access
//   node neon.js ask [options] [prompt]        prompt from argument, --file, or stdin
//     -s, --session NAME   multi-turn: the same NAME continues the conversation
//     -a, --attach PATH    attach a file (repeatable): code, pdf, images, ...
//     --with-chat          share the current Claude Code conversation (what was said, not tool output;
//                          secrets redacted; newest turns kept) as an attached file
//     --chat-file PATH     share this transcript (.jsonl) instead of the current session's (implies --with-chat)
//     --chat-max CHARS     size limit for the shared conversation (default 80000)
//     --chat-preview       print what --with-chat would share, and send nothing
//     --agent ROOT         agent mode: the model can LIST/READ/GREP/FIND/DEFS/GIT under ROOT (read-only)
//     --allow-run CMD      agent mode: also let it RUN this command prefix in ROOT (repeatable), e.g. "npm test"
//     --run-timeout SEC    per-command limit for RUN (default 300)
//     --patch              agent mode: ask for changes as a unified diff; it is checked, never applied,
//                          and saved to a file (the model gets two tries to fix one that doesn't apply)
//     --patch-out PATH     where to save the patch (implies --patch; default: the bridge tmp folder)
//     --model NAME         Gemini mode to use (default: Neon, or NEON_MODEL / config.json "model")
//     --temp               use a temporary chat, kept out of Gemini history (default: saved chat;
//                          note: Neon may not reply in temporary chats)
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
const chat = require('./chat');
const agent = require('./agent');

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
    else if (a === '--with-chat') o.withChat = true;
    else if (a === '--chat-file') { o.withChat = true; o.chatFile = path.resolve(argv[++i]); }
    else if (a === '--chat-max') o.chatMax = +argv[++i];
    else if (a === '--chat-preview') { o.withChat = true; o.chatPreview = true; }
    else if (a === '--temp') o.temp = true;
    else if (a === '--save') o.temp = false; // the default; kept for older scripts
    else if (a === '--max-rounds') o.maxRounds = +argv[++i];
    else if (a === '--allow-run') (o.allowRun = o.allowRun || []).push(argv[++i]);
    else if (a === '--run-timeout') o.runTimeout = +argv[++i];
    else if (a === '--patch') o.patch = true;
    else if (a === '--patch-out') { o.patch = true; o.patchOut = path.resolve(argv[++i]); }
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
  if ((o.allowRun || o.patch) && !o.agent) { err('--allow-run and --patch need --agent ROOT'); return 1; }
  if (o.agent && !fs.existsSync(o.agent)) { err('agent folder not found: ' + o.agent); return 1; }
  const tools = { allowRun: o.allowRun, runTimeoutSec: o.runTimeout, patch: o.patch };
  let brief = null;
  if (o.withChat) {
    brief = chat.buildBrief(chat.findTranscript(o.chatFile), { maxChars: o.chatMax || 80000 });
    err(`conversation: ${brief.turns} turns, ${brief.chars} chars` + (brief.omittedTurns ? `, ${brief.omittedTurns} older turns left out` : '') + `, ${brief.redactions} secret(s) redacted`);
    if (o.chatPreview) { process.stdout.write(brief.text + '\n'); return 0; }
  }
  await ensureDaemon();

  const attach = [...o.attach];
  if (brief) { // a fixed file name so the model can refer to it
    const dir = path.join(cfg.TMP, `chat-${Date.now()}`); fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'conversation.md'); fs.writeFileSync(f, brief.text); attach.push(f);
    prompt = chat.chatPreamble + prompt;
  }
  const asFile = (text, label) => { const f = path.join(cfg.TMP, `${label}-${Date.now()}.md`); fs.writeFileSync(f, text); return f; };
  if (prompt.length > 20000) { // long prompts go up as an attached file
    const f = asFile(prompt, 'context'); attach.push(f);
    prompt = 'The full request is in the attached file ' + path.basename(f) + '. Read all of it and respond to it.';
  }

  const session = o.session || (o.agent ? `_agent_${Date.now()}` : undefined);
  const base = { session, temp: !!o.temp, timeoutSec: o.timeout || 600, model: o.model || cfg.DEFAULT_MODEL };
  const send = (msg, label) => msg.length > 20000
    ? call('POST', '/ask', { ...base, prompt: `The ${label} are in the attached file. Read it fully, then continue (more neon-tools commands, or your FINAL answer).`, attach: [asFile(msg, 'tools')] })
    : call('POST', '/ask', { ...base, prompt: msg });
  let r = await call('POST', '/ask', { ...base, prompt: o.agent ? agent.agentPreamble(o.agent, tools) + prompt : prompt, attach });
  const rounds = o.maxRounds || 12;
  let round = 0, fixes = 0, explanation = null, patch = null;
  while (o.agent && r.ok) {
    const cmds = agent.extractTools(r.answer);
    if (cmds) {
      if (round >= rounds) break;
      round++;
      err(`round ${round}: ` + cmds.join(' ; '));
      const parts = [];
      for (const t of cmds) parts.push(`### ${t}\n\`\`\`\n${await agent.runTool(o.agent, t, tools)}\n\`\`\``); // one at a time
      let results = parts.join('\n\n');
      if (results.length > agent.MAX_OUT) results = results.slice(0, agent.MAX_OUT) + '\n... (results truncated; request smaller ranges)';
      const last = round === rounds ? '\n\nThis was the last tool round. Give your FINAL answer now.' : '';
      r = await send('Tool results:\n\n' + results + last, `tool results for round ${round}`);
      continue;
    }
    // Final answer. With --patch, check any proposed diff and give the model two chances to fix it.
    if (!o.patch) break;
    const text = agent.extractPatch(r.answer);
    if (!text) break;
    const file = o.patchOut || path.join(cfg.TMP, `patch-${Date.now()}.diff`);
    const chk = agent.checkPatch(o.agent, text, file);
    patch = { file, applies: chk.ok, strip: chk.strip, error: chk.error || null };
    if (chk.ok !== false || fixes >= 2) break;
    fixes++;
    if (explanation === null) explanation = r.answer;
    err(`patch does not apply (${chk.error.split('\n')[0]}); asking for a fix (${fixes}/2)`);
    r = await send(`Your patch does not apply to the current files:\n\n\`\`\`\n${chk.error}\n\`\`\`\n\nRe-read the affected lines if needed (neon-tools still work), then reply with the complete corrected patch in ONE neon-patch block.`, 'patch check results');
  }
  if (o.agent && !o.session) await call('POST', '/end', { session }).catch(() => {});
  if (explanation !== null && r.ok) r.answer = explanation + '\n\n---\n**Corrected patch** (the patch above did not apply; this one replaces it):\n\n' + r.answer;
  if (patch) r.patch = patch;

  if (o.json) console.log(JSON.stringify(r, null, 1));
  else if (!r.ok) err(`${r.code}: ${r.error}`);
  else {
    for (const w of r.warnings || []) err('warning: ' + w);
    err(`model: Gemini ${r.model} | ${Math.round(r.ms / 1000)}s` + (o.session ? ` | session: ${o.session}` : ''));
    if (patch) err(patch.applies
      ? `patch: ${patch.file} (applies cleanly; to apply: git apply --recount --ignore-whitespace -p${patch.strip} "${patch.file}")`
      : `patch: ${patch.file} (${patch.applies === null ? 'not checked' : 'does NOT apply'}: ${patch.error.split('\n')[0]})`);
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
      { const lines = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).slice(1); console.log(lines.slice(0, lines.findIndex(l => !l.startsWith('//'))).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); }
      return cmd ? 1 : 0;
  }
}

main().then(c => process.exit(c), e => { err('error: ' + e.message); process.exit(e.exit || 1); });
