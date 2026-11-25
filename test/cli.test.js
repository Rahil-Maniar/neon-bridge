// Tests for the neon.js CLI flow against a fake daemon: session choice, sharing, result, stop, exit codes.
// No browser or Google account needed.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const CLI = path.join(__dirname, '..', 'bridge', 'neon.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-cli-'));
let home, port, server;

// The fake daemon: records every request and answers with the handlers a test sets.
const fake = { calls: [], ask: null, sessions: [], result: null, results: [], shutdown: null };
function reset() {
  fake.calls = [];
  fake.ask = body => ({ ok: true, answer: 'pong', model: 'Neon', ms: 1000, session: body.session || null, url: body.session ? 'https://gemini.google.com/app/abc123' : null, warnings: [] });
  fake.sessions = [];
  fake.result = () => ({ status: 'unknown' });
  fake.results = [];
  fake.shutdown = () => ({ ok: true });
}

before(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      const body = data ? JSON.parse(data) : {};
      fake.calls.push({ method: req.method, url: req.url, body });
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/health') return send(200, { ok: true });
      if (req.url === '/sessions') return send(200, fake.sessions);
      if (req.url === '/results') return send(200, fake.results);
      if (req.url.startsWith('/result?')) return send(200, fake.result(new URL(req.url, 'http://x').searchParams.get('id')));
      if (req.url === '/ask') {
        const r = fake.ask(body);
        // Like the real daemon, remember saved chats in sessions.json.
        if (r.ok && body.session && r.url) {
          const store = path.join(home, 'sessions.json');
          const s = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : {};
          s[body.session] = { url: r.url, turns: 1 }; fs.writeFileSync(store, JSON.stringify(s));
        }
        return send(r.ok ? 200 : 500, r);
      }
      if (req.url === '/shutdown') { const r = fake.shutdown(body); return send(r.ok ? 200 : 409, r); }
      if (req.url === '/end') return send(200, { ok: true });
      send(404, { ok: false });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  reset();
  home = fs.mkdtempSync(path.join(tmp, 'home-'));
  fs.mkdirSync(path.join(home, 'profile'));
});

function run(args, { claude = 'abcdef1234567890', daemon = true, stdin = '' } = {}) {
  const env = { ...process.env, NEON_BRIDGE_HOME: home, NEON_API_PORT: String(daemon ? port : 1), NEON_CDP_PORT: '1' };
  delete env.CLAUDE_CODE_SESSION_ID;
  if (claude) env.CLAUDE_CODE_SESSION_ID = claude;
  return new Promise(resolve => {
    const p = execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (e, stdout, stderr) => resolve({ code: e ? (e.code ?? 1) : 0, stdout, stderr }));
    p.stdin.end(stdin);
  });
}
const asks = () => fake.calls.filter(c => c.url === '/ask').map(c => c.body);

test('inside Claude Code, requests continue one Gemini chat per Claude session', async () => {
  const r = await run(['ask', 'hello']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'pong');
  assert.strictEqual(asks()[0].session, 'claude-abcdef12');
  assert.match(asks()[0].requestId, /^\d{12}-[a-z0-9]+$/);
  assert.match(r.stderr, new RegExp(`request ${asks()[0].requestId}`));
});

test('--fresh, -s NAME and no Claude session choose the chat accordingly', async () => {
  await run(['ask', '--fresh', 'q']);
  await run(['ask', '-s', 'design', 'q']);
  await run(['ask', 'q'], { claude: null });
  assert.deepStrictEqual(asks().map(b => b.session ?? null), [null, 'design', null]);
});

test('a busy session chat falls back to a fresh chat', async () => {
  fake.sessions = [{ name: 'claude-abcdef12', busy: true }];
  const r = await run(['ask', 'q']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(asks()[0].session, undefined);
  assert.match(r.stderr, /busy with another request; using a fresh chat/);
});

test('--with-chat shares the conversation once, then only new turns', async () => {
  const t = path.join(home, 'conv.jsonl');
  const line = (ts, type, content) => JSON.stringify({ type, timestamp: ts, message: { role: type, content } }) + '\n';
  fs.writeFileSync(t, line('2026-01-01T00:00:01Z', 'user', 'I like mangoes') + line('2026-01-01T00:00:02Z', 'assistant', [{ type: 'text', text: 'Noted.' }]));
  let r = await run(['ask', '--chat-file', t, 'first']);
  assert.strictEqual(r.code, 0, r.stderr);
  let b = asks()[0];
  assert.strictEqual(path.basename(b.attach[0]), 'conversation.md');
  assert.match(b.prompt, /^For context, the attached file conversation\.md/);
  assert.match(fs.readFileSync(b.attach[0], 'utf8'), /I like mangoes/);

  fs.appendFileSync(t, line('2026-01-01T00:05:01Z', 'user', 'Picnic on Sunday'));
  r = await run(['ask', '--chat-file', t, 'second']);
  b = asks()[1];
  assert.strictEqual(path.basename(b.attach[0]), 'conversation-update.md');
  assert.match(b.prompt, /^The attached file conversation-update\.md continues/);
  const upd = fs.readFileSync(b.attach[0], 'utf8');
  assert.match(upd, /Picnic on Sunday/);
  assert.ok(!upd.includes('mangoes'), 'already-shared turns are not sent again');

  r = await run(['ask', '--chat-file', t, 'third']);
  assert.match(r.stderr, /nothing new since the last share/);
  assert.deepStrictEqual(asks()[2].attach, []);

  await run(['ask', '--chat-file', t, '--full-chat', 'fourth']);
  assert.match(fs.readFileSync(asks()[3].attach[0], 'utf8'), /mangoes[\s\S]*Picnic/);

  await run(['ask', '--chat-file', t, '--fresh', 'fifth']);
  assert.strictEqual(path.basename(asks()[4].attach[0]), 'conversation.md', 'a fresh chat gets the full conversation');
});

test('--chat-preview prints the brief and sends nothing', async () => {
  const t = path.join(home, 'conv.jsonl');
  fs.writeFileSync(t, JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'preview me' } }) + '\n');
  const r = await run(['ask', '--chat-file', t, '--chat-preview', 'x']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /preview me/);
  assert.strictEqual(asks().length, 0);
});

test('result waits for a running request, then prints its answer', async () => {
  let polls = 0;
  fake.result = id => (++polls < 2 ? { id, status: 'running', startedAt: Date.now() - 5000 } : { id, status: 'done', result: { ok: true, answer: 'late answer', model: 'Neon', ms: 9000 } });
  const r = await run(['result', 'abc-1']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'late answer');
  assert.match(r.stderr, /waiting for Neon/);
  assert.ok(fake.calls.some(c => c.url === '/result?id=abc-1'));
});

test('result reports lost and unknown requests', async () => {
  fake.result = id => ({ id, status: 'lost' });
  let r = await run(['result', 'x']);
  assert.strictEqual(r.code, 1); assert.match(r.stderr, /interrupted before Neon answered/);
  fake.result = id => ({ id, status: 'unknown' });
  r = await run(['result', 'x']);
  assert.strictEqual(r.code, 1); assert.match(r.stderr, /no request "x" found/);
});

test('result reads a finished answer from disk when the daemon is down', async () => {
  fs.mkdirSync(path.join(home, 'results'));
  fs.writeFileSync(path.join(home, 'results', 'old-1.json'), JSON.stringify({ id: 'old-1', status: 'done', result: { ok: true, answer: 'from disk', model: 'Neon', ms: 1 } }));
  const r = await run(['result', 'old-1'], { daemon: false });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'from disk');
});

test('stop refuses while requests run, and --force asks for a forced stop', async () => {
  fake.shutdown = body => (body.force ? { ok: true } : { ok: false, code: 'BUSY', running: 2 });
  let r = await run(['stop']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /not stopped: 2 request\(s\) still running/);
  r = await run(['stop', '--force']);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(fake.calls.filter(c => c.url === '/shutdown').map(c => c.body.force), [false, true]);
});

test('errors map to exit codes', async () => {
  fake.ask = () => ({ ok: false, code: 'SIGNED_OUT', error: 'Not signed in' });
  let r = await run(['ask', 'q']);
  assert.strictEqual(r.code, 2); assert.match(r.stderr, /SIGNED_OUT/);
  fake.ask = () => ({ ok: false, code: 'NO_MODEL', error: 'nope' });
  assert.strictEqual((await run(['ask', 'q'])).code, 3);
  fake.ask = b => ({ ok: true, answer: 'half', model: 'Neon', ms: 1, session: b.session, partial: true, warnings: ['timed out'] });
  r = await run(['ask', 'q']);
  assert.strictEqual(r.code, 4); assert.match(r.stderr, /warning: timed out/);
  r = await run(['ask', '-a', path.join(home, 'missing.txt'), 'q']);
  assert.strictEqual(r.code, 1); assert.match(r.stderr, /attachment not found/);
  r = await run(['ask', '--patch', 'q']);
  assert.strictEqual(r.code, 1); assert.match(r.stderr, /need --agent/);
});

test('generated media are listed after the answer', async () => {
  fake.ask = b => ({ ok: true, answer: '', model: 'Neon', ms: 1, session: b.session, media: [{ type: 'image', file: '/tmp/a.png', bytes: 2048 }] });
  const r = await run(['ask', '--out', path.join(home, 'out'), 'draw']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /\*\*Generated files:\*\*\n- image: \/tmp\/a\.png/);
  assert.strictEqual(asks()[0].mediaDir, path.join(home, 'out'));
});

test('options reach the daemon', async () => {
  await run(['ask', '--model', 'Hydrogen', '--timeout', '120', '--stall', '0', '--temp', 'q']);
  const b = asks()[0];
  assert.strictEqual(b.model, 'Hydrogen');
  assert.strictEqual(b.timeoutSec, 120);
  assert.strictEqual(b.stallSec, 0);
  assert.strictEqual(b.temp, true);
});

test('the prompt can come from stdin', async () => {
  await run(['ask'], { stdin: 'from stdin' });
  assert.strictEqual(asks()[0].prompt, 'from stdin');
});
