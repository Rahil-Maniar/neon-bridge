// Dev helper for when Gemini's UI changes: attaches to the running bridge browser (start it with
// `node bridge/server.js --show` or let the daemon run), lists visible controls, and saves a screenshot.
// Usage: node bridge/dev/inspect.js [screenshot.png]
const path = require('path');
const cfg = require('../config');
const { resolvePlaywright } = require('../deps');

(async () => {
  const { chromium } = resolvePlaywright() || {};
  if (!chromium) throw new Error('playwright-core missing; run setup first');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.CDP_PORT}`);
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => p.url().includes('gemini.google.com')) || await ctx.newPage();
  if (!page.url().includes('gemini.google.com')) await page.goto(cfg.GEMINI_URL);
  await page.waitForTimeout(3000);
  console.log('URL:', page.url());
  const items = await page.evaluate(() => [...document.querySelectorAll('button, [role=button], [contenteditable=true], textarea, input, [role=menuitem], [role=option]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height; })
    .map(el => [el.tagName.toLowerCase(), el.getAttribute('aria-label') || '', el.getAttribute('data-test-id') || '', (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50)].join(' | ')));
  items.forEach(i => console.log(i));
  const shot = process.argv[2] || path.join(cfg.TMP, 'inspect.png');
  await page.screenshot({ path: shot });
  console.log('screenshot:', shot);
})().then(() => process.exit(0), e => { console.error(e.message); process.exit(1); });
