// neon-bridge daemon: keeps a hidden Chrome (dedicated, signed-in profile) alive and exposes the Gemini web app
// over a localhost-only HTTP API. Started automatically by neon.js; stops itself after an idle period.
//   GET  /health                 -> {ok, sessions}
//   GET  /sessions               -> [{name, url, temp, turns, live}]
//   POST /check {model}          -> {ok, model}            (signed in + model selectable?)
//   POST /ask {session, prompt, attach[], temp, model, timeoutSec} -> {ok, answer, session, url, model, warnings[], partial, ms}
//   POST /end {session}
//   POST /shutdown
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const cfg = require('./config');
const { resolvePlaywright } = require('./deps');

const pw = resolvePlaywright();
if (!pw) { console.error('playwright-core missing; run: node neon.js setup'); process.exit(1); }
const { chromium } = pw;

const SHOW = process.argv.includes('--show');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(cfg.HOME, { recursive: true });
const log = (...m) => { try { fs.appendFileSync(cfg.LOG, new Date().toISOString() + ' ' + m.join(' ') + '\n'); } catch {} };

let browser, ctx, chromeProc, userAgent, lastActivity = Date.now();
const sessions = new Map(); // name -> {page, url, temp, model, lastUsed, turns, busy}
let uiChain = Promise.resolve();
// UI interactions (focus, typing, clicking) are serialized; waiting for replies runs in parallel.
const withUi = fn => { const run = uiChain.then(fn, fn); uiChain = run.catch(() => {}); return run; };

function loadStore() { try { return JSON.parse(fs.readFileSync(cfg.STORE, 'utf8')); } catch { return {}; } }
function saveStore() {
  const s = loadStore();
  for (const [k, v] of sessions) if (!k.startsWith('_') && !v.temp && /\/app\/[0-9a-f]+/.test(v.url || '')) s[k] = { url: v.url, turns: v.turns };
  fs.writeFileSync(cfg.STORE, JSON.stringify(s, null, 1));
}

async function startChrome() {
  const connect = () => chromium.connectOverCDP(`http://127.0.0.1:${cfg.CDP_PORT}`);
  try { browser = await connect(); }
  catch {
    const exe = cfg.findBrowser();
    if (!exe) throw new Error('No Chrome/Edge/Chromium found; set NEON_BROWSER to its path');
    const flags = [`--user-data-dir=${cfg.PROFILE}`, `--remote-debugging-port=${cfg.CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'];
    if (!SHOW) flags.unshift('--headless=new');
    chromeProc = spawn(exe, flags, { stdio: 'ignore' });
    for (let i = 0; i < 40 && !browser; i++) { await sleep(500); try { browser = await connect(); } catch {} }
    if (!browser) throw new Error('Browser did not start');
  }
  ctx = browser.contexts()[0];
  // Headless Chrome advertises "HeadlessChrome" in its user agent; present the normal one instead.
  userAgent = (await (await browser.newBrowserCDPSession()).send('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
  browser.on('disconnected', () => { log('browser disconnected'); process.exit(1); });
}

const SEL = {
  input: 'div.ql-editor[contenteditable="true"]',
  mode: '[data-test-id="bard-mode-menu-button"]',
  resp: 'model-response',
  stop: 'button[aria-label^="Stop"]',
  temp: 'button[aria-label="Turn on temporary chat"]',
  file: 'input.hidden-file-input',
  chip: 'uploader-file-preview',
  abPick: 'This response is more helpful',
};

class BridgeError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function ensureModel(page, model) {
  const mode = page.locator(SEL.mode);
  try { await mode.first().waitFor({ timeout: 15000 }); } catch { throw new BridgeError('LAYOUT', 'Model picker not found'); }
  const label = (await mode.getAttribute('aria-label')) || '';
  if (new RegExp('currently\\s+' + esc(model) + '\\b', 'i').test(label)) return;
  await mode.click(); await sleep(800);
  // Picker items look like "4 Neon" / "4 Hydrogen"; tolerate future version numbers.
  const item = page.getByText(new RegExp('^\\s*[\\d.]*\\s*' + esc(model) + '\\s*$', 'i'));
  if (!(await item.count())) { await page.keyboard.press('Escape'); throw new BridgeError('NO_MODEL', `"${model}" not in the model picker (current: ${label})`); }
  await item.first().click(); await sleep(800);
  if (!new RegExp(esc(model), 'i').test((await mode.getAttribute('aria-label')) || '')) {
    await page.keyboard.press('Escape');
    throw new BridgeError('NO_MODEL', `Could not switch to "${model}" (not included in this account's plan?)`);
  }
}

async function openSession(name, temp, resumeUrl) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1600, height: 1000 });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setUserAgentOverride', { userAgent });
  await page.goto(resumeUrl || cfg.GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.locator(SEL.input).first().waitFor({ timeout: 30000 }); }
  catch {
    const url = page.url(); await page.close();
    if (/accounts\.google\.com|signin|ServiceLogin/i.test(url)) throw new BridgeError('SIGNED_OUT', 'Not signed in; run: node neon.js setup');
    throw new BridgeError('LAYOUT', 'Gemini input box not found at ' + url);
  }
  const warnings = [];
  if (temp && !resumeUrl) {
    try { await page.locator(SEL.temp).first().waitFor({ timeout: 8000 }); await page.locator(SEL.temp).first().click(); await sleep(800); }
    catch { warnings.push('temporary-chat toggle not found; this chat may be saved to history'); }
  }
  const s = { page, url: page.url(), temp, lastUsed: Date.now(), turns: 0 };
  sessions.set(name, s);
  return { s, warnings };
}

// Runs in the page: convert the latest rendered reply back to markdown.
function domToMarkdown() {
  const root = [...document.querySelectorAll('model-response message-content')].pop();
  if (!root) return '';
  const SKIP = new Set(['BUTTON', 'MAT-ICON', 'GEM-ICON', 'GEM-ICON-BUTTON', 'SOURCE-FOOTNOTE', 'SOURCES-CAROUSEL-INLINE', 'SOURCE-INLINE-CHIP', 'SUP', 'STYLE', 'SCRIPT']);
  const skipEl = el => SKIP.has(el.tagName) || el.hasAttribute('hide-from-message-actions') || el.classList.contains('code-block-decoration') || el.classList.contains('table-footer');
  const inline = n => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1 || skipEl(n)) return '';
    const t = n.tagName, inner = () => [...n.childNodes].map(inline).join('');
    if (t === 'B' || t === 'STRONG') { const x = inner(); return x.trim() ? `**${x}**` : x; }
    if (t === 'I' || t === 'EM') { const x = inner(); return x.trim() ? `*${x}*` : x; }
    if (t === 'CODE') return '`' + n.textContent + '`';
    if (t === 'A') return `[${inner()}](${n.getAttribute('href') || ''})`;
    if (t === 'BR') return '\n';
    return inner();
  };
  const block = (n, indent = '') => {
    if (n.nodeType === 3) return n.textContent.trim() ? n.textContent : '';
    if (n.nodeType !== 1 || skipEl(n)) return '';
    const t = n.tagName, kids = () => [...n.childNodes].map(c => block(c, indent)).join('');
    if (/^H[1-6]$/.test(t)) return '\n' + '#'.repeat(+t[1]) + ' ' + inline(n).trim() + '\n\n';
    if (t === 'P') return inline(n).trim() + '\n\n';
    if (t === 'HR') return '---\n\n';
    if (t === 'BLOCKQUOTE') return kids().trim().split('\n').map(l => '> ' + l).join('\n') + '\n\n';
    if (t === 'CODE-BLOCK') {
      const lang = ((n.querySelector('.code-block-decoration span') || {}).textContent || '').trim().toLowerCase();
      const code = (n.querySelector('code') || n).textContent.replace(/\n$/, '');
      return '```' + lang + '\n' + code + '\n```\n\n';
    }
    if (t === 'PRE') return '```\n' + n.textContent.replace(/\n$/, '') + '\n```\n\n';
    if (t === 'UL' || t === 'OL') {
      let i = 1;
      return [...n.children].filter(li => li.tagName === 'LI').map(li => {
        const bullet = t === 'OL' ? `${i++}. ` : '- ';
        let seen = false;
        const parts = [...li.childNodes].map(c => {
          if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) { seen = true; return '\n' + block(c, indent + '   ').trimEnd(); }
          const txt = c.nodeType === 1 ? (c.tagName === 'P' ? inline(c) : block(c, indent + '   ')).trim() : c.textContent;
          if (!txt.trim()) return txt;
          const out = (seen ? '\n\n' + indent + '   ' : '') + txt + ' '; seen = true; return out;
        });
        return indent + bullet + parts.join('').trim();
      }).join('\n') + '\n\n';
    }
    if (t === 'TABLE') {
      const rows = [...n.querySelectorAll('tr')].map(r => [...r.children].map(c => inline(c).trim().replace(/\|/g, '\\|')));
      if (!rows.length) return '';
      return ['| ' + rows[0].join(' | ') + ' |', '| ' + rows[0].map(() => '---').join(' | ') + ' |', ...rows.slice(1).map(r => '| ' + r.join(' | ') + ' |')].join('\n') + '\n\n';
    }
    if (['SPAN', 'B', 'STRONG', 'I', 'EM', 'A', 'CODE'].includes(t)) return inline(n);
    return kids();
  };
  return block(root).replace(/\n{3,}/g, '\n\n').trim();
}

async function getSession(name, temp) {
  let s = sessions.get(name), warnings = [];
  if (!s) {
    const stored = loadStore()[name];
    const r = await withUi(() => openSession(name, temp, stored && stored.url));
    s = r.s; warnings = r.warnings;
    if (stored) s.turns = stored.turns || 0;
  }
  return { s, warnings };
}

async function ask({ session, prompt, attach = [], temp = true, model = cfg.DEFAULT_MODEL, timeoutSec = 600 }) {
  const t0 = Date.now();
  const name = session || ('_once_' + t0 + Math.random().toString(36).slice(2, 6));
  const { s, warnings } = await getSession(name, temp);
  if (s.busy) throw new BridgeError('BUSY', `Session "${name}" is already handling a request`);
  s.busy = true;
  const page = s.page;
  try {
    let before, abBefore;
    await withUi(async () => {
      await page.bringToFront(); // background tabs don't render, which stalls input
      await ensureModel(page, model);
      if (attach.length) {
        const chips0 = await page.locator(SEL.chip).count();
        await page.locator(SEL.file).first().setInputFiles(attach);
        const until = Date.now() + 120000;
        while ((await page.locator(SEL.chip).count()) < chips0 + attach.length) {
          if (Date.now() > until) throw new BridgeError('UPLOAD', 'Attachments did not appear'); await sleep(500);
        }
        await sleep(1500);
      }
      before = await page.locator(SEL.resp).count();
      abBefore = await page.getByText(SEL.abPick).count();
      const input = page.locator(SEL.input).first();
      await input.click();
      await input.fill(prompt);
      await sleep(300);
      const until = Date.now() + 120000; // Enter is ignored while uploads finish; retry until the box clears
      while (true) {
        await page.keyboard.press('Enter'); await sleep(1200);
        if (!((await input.innerText().catch(() => '')) || '').trim()) break;
        if (Date.now() > until) throw new BridgeError('SEND', 'Prompt could not be sent');
      }
    });

    const deadline = Date.now() + timeoutSec * 1000;
    while ((await page.locator(SEL.resp).count()) <= before) {
      if (Date.now() > deadline) throw new BridgeError('TIMEOUT', 'No reply started');
      const ab = page.getByText(SEL.abPick);
      if ((await ab.count()) > abBefore) { // A/B "Choice A / Choice B": let both drafts finish, then pick A
        let prev = -1, stable = Date.now();
        while (Date.now() - stable < 3000 && Date.now() < deadline) { await sleep(800); const n = await page.evaluate(() => document.body.innerText.length); if (n !== prev) { prev = n; stable = Date.now(); } }
        await withUi(async () => { await page.bringToFront(); await ab.first().click(); });
        warnings.push('Gemini showed an A/B comparison; picked Choice A');
        await sleep(1500);
      }
      await sleep(500);
    }
    let last = '', stableSince = Date.now(), partial = false;
    while (true) {
      if (Date.now() > deadline) { partial = true; warnings.push('timed out; answer may be partial'); break; }
      await sleep(1000);
      const txt = await page.evaluate(() => { const m = [...document.querySelectorAll('model-response message-content')].pop(); return m ? m.innerText : ''; });
      // Two independent "still generating" signals: the Stop button, and aria-busy on the reply.
      const busy = (await page.locator(SEL.stop).count()) +
        (await page.evaluate(() => { const m = [...document.querySelectorAll('model-response message-content')].pop(); return m && m.querySelector('[aria-busy="true"]') ? 1 : 0; }));
      if (txt !== last) { last = txt; stableSince = Date.now(); }
      else if (txt && !busy && Date.now() - stableSince > 2000) break;
    }
    const md = await page.evaluate(domToMarkdown);
    s.turns++; s.lastUsed = Date.now(); s.url = page.url();
    if (session) saveStore();
    return { ok: true, answer: md || last, session: session || null, url: s.temp ? null : s.url, model, warnings, partial, ms: Date.now() - t0 };
  } finally {
    s.busy = false;
    if (!session) { sessions.delete(name); await page.close().catch(() => {}); }
  }
}

async function check({ model = cfg.DEFAULT_MODEL }) {
  const name = '_check_' + Date.now();
  const { s } = await getSession(name, false);
  try { await withUi(async () => { await s.page.bringToFront(); await ensureModel(s.page, model); }); return { ok: true, model }; }
  finally { sessions.delete(name); await s.page.close().catch(() => {}); }
}

async function endSession(name) {
  const s = sessions.get(name);
  if (s) { await s.page.close().catch(() => {}); sessions.delete(name); }
  const st = loadStore(); delete st[name]; fs.writeFileSync(cfg.STORE, JSON.stringify(st, null, 1));
}

async function shutdown() {
  log('shutdown');
  for (const s of sessions.values()) await s.page.close().catch(() => {});
  try { const c = await browser.newBrowserCDPSession(); await c.send('Browser.close'); } catch {}
  if (chromeProc) chromeProc.kill();
  process.exit(0);
}

const readBody = req => new Promise((res, rej) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); });
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

(async () => {
  await startChrome();
  const server = http.createServer(async (req, res) => {
    lastActivity = Date.now();
    try {
      if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, sessions: [...sessions.keys()].filter(k => !k.startsWith('_')).length });
      if (req.method === 'GET' && req.url === '/sessions') {
        const stored = loadStore();
        const live = [...sessions].filter(([k]) => !k.startsWith('_')).map(([k, v]) => ({ name: k, url: v.temp ? null : v.url, temp: v.temp, turns: v.turns, live: true }));
        const saved = Object.keys(stored).filter(k => !sessions.has(k)).map(k => ({ name: k, url: stored[k].url, turns: stored[k].turns, live: false }));
        return send(res, 200, [...live, ...saved]);
      }
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.url === '/ask') { const r = await ask(body); lastActivity = Date.now(); return send(res, 200, r); }
      if (req.url === '/check') return send(res, 200, await check(body));
      if (req.url === '/end') { await endSession(body.session); return send(res, 200, { ok: true }); }
      if (req.url === '/shutdown') { send(res, 200, { ok: true }); return setTimeout(shutdown, 100); }
      send(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      log('error', e.code || '', e.message);
      send(res, 500, { ok: false, code: e.code || 'ERROR', error: e.message });
    }
  });
  server.timeout = 0; server.requestTimeout = 0; server.headersTimeout = 0;
  server.listen(cfg.API_PORT, '127.0.0.1', () => log('listening on', cfg.API_PORT));
  setInterval(() => { if (Date.now() - lastActivity > cfg.IDLE_MIN * 60000 && ![...sessions.values()].some(s => s.busy)) shutdown(); }, 60000);
})().catch(e => { log('fatal', e.message); console.error(e.message); process.exit(1); });
