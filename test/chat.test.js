// Tests for --with-chat: turning a Claude Code transcript into a brief. No browser needed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const chat = require('../bridge/chat');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-chat-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (...content) => ({ type: 'assistant', message: { role: 'assistant', content } });
const text = t => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', id: 'x', name, input });
function transcript(name, lines) {
  const f = path.join(dir, name + '.jsonl');
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n{not json\n');
  return f;
}

const sample = transcript('sample', [
  { type: 'queue-operation' },
  user('Why is the parser slow?\n<system-reminder>hidden harness note</system-reminder>'),
  assistant({ type: 'thinking', thinking: 'private reasoning' }, tool('Bash', { command: 'cat secret.txt', description: 'Read the parser' }), tool('mcp__ccd_turn__update_plan', { items: [] })),
  user([{ type: 'tool_result', tool_use_id: 'x', content: 'RAW TOOL OUTPUT' }]),
  assistant(tool('Grep', { pattern: 'parse\\(' }), text('It re-reads the file on every call.')),
  user('<task-notification>background done</task-notification>'),
  user('ok', { isMeta: true }),
  assistant(text('SUBAGENT CHATTER')), // marked as sidechain below
  user('Fix it. My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz and password: hunter2hunter2'),
  assistant(text('Done. Token was ghp_abcdefghijklmnopqrstuvwxyz0123456789.')),
].map((l, i) => i === 7 ? { ...l, isSidechain: true } : l));

test('keeps only what was said, plus one line per run of tools', () => {
  const b = chat.buildBrief(sample);
  assert.match(b.text, /## User\n\nWhy is the parser slow\?/);
  // Tool runs separated only by (hidden) tool output collapse into one line.
  assert.match(b.text, /## Claude\n\n_\[Tools used: Bash: Read the parser · Grep: parse\\\(\]_\n\nIt re-reads the file/);
  for (const hidden of ['hidden harness note', 'private reasoning', 'cat secret.txt', 'RAW TOOL OUTPUT', 'background done', 'SUBAGENT CHATTER', 'update_plan']) {
    assert.ok(!b.text.includes(hidden), 'should not include: ' + hidden);
  }
  assert.ok(!/## User\n\nok\b/.test(b.text), 'meta messages are skipped');
});

test('redacts secrets', () => {
  const b = chat.buildBrief(sample);
  assert.ok(!b.text.includes('abcdefghijklmnopqrstuvwxyz'), 'API keys and tokens are removed');
  assert.ok(!b.text.includes('hunter2hunter2'), 'password values are removed');
  assert.match(b.text, /password: \[REDACTED\]/);
  assert.strictEqual(b.redactions, 3);
});

test('redact handles common secret shapes and leaves normal text alone', () => {
  const r = chat.redact('AKIAABCDEFGHIJKLMNOP AIzaSyA1234567890abcdefghijklmnopqrstu Bearer abcdefghijklmnop1234 API_KEY="supersecretvalue" plain words and token counts');
  assert.strictEqual(r.count, 4);
  assert.match(r.text, /plain words and token counts$/);
  assert.match(r.text, /API_KEY="\[REDACTED\]"/);
  assert.strictEqual(chat.redact('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----').text, '[REDACTED]');
});

test('keeps the newest turns when over the size limit', () => {
  const lines = [];
  for (let i = 1; i <= 30; i++) { lines.push(user(`question ${i} ` + 'x'.repeat(200))); lines.push(assistant(text(`answer ${i}`))); }
  const b = chat.buildBrief(transcript('long', lines), { maxChars: 2000 });
  assert.ok(b.chars < 2300);
  assert.ok(b.omittedTurns > 0);
  assert.match(b.text, /^_\(\d+ earlier turns omitted for length\)_/);
  assert.match(b.text, /answer 30$/);
  assert.ok(!b.text.includes('question 1 '));
});

test('finds the current session transcript from the environment', () => {
  const cfgDir = path.join(dir, 'cfg');
  fs.mkdirSync(path.join(cfgDir, 'projects', 'some-project'), { recursive: true });
  const f = path.join(cfgDir, 'projects', 'some-project', 'abc-123.jsonl');
  fs.copyFileSync(sample, f);
  const saved = { id: process.env.CLAUDE_CODE_SESSION_ID, cfg: process.env.CLAUDE_CONFIG_DIR };
  try {
    process.env.CLAUDE_CONFIG_DIR = cfgDir;
    process.env.CLAUDE_CODE_SESSION_ID = 'abc-123';
    assert.strictEqual(chat.findTranscript(), f);
    process.env.CLAUDE_CODE_SESSION_ID = 'missing';
    assert.throws(() => chat.findTranscript(), /not found/);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.throws(() => chat.findTranscript(), /--chat-file/);
    assert.strictEqual(chat.findTranscript(sample), sample);
  } finally {
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.id], ['CLAUDE_CONFIG_DIR', saved.cfg]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('since: a follow-up share contains only newer turns', () => {
  const at = (n, l) => ({ ...l, timestamp: `2026-11-25T10:00:0${n}.000Z` });
  const f = transcript('incremental', [
    at(1, user('first question')), at(2, assistant(text('first answer'))),
    at(3, user('second question')), at(4, assistant(text('second answer'))),
  ]);
  const full = chat.buildBrief(f);
  assert.strictEqual(full.incremental, false);
  assert.strictEqual(full.lastTs, '2026-11-25T10:00:04.000Z');
  assert.match(full.text, /first question/);

  const upd = chat.buildBrief(f, { since: '2026-11-25T10:00:02.000Z' });
  assert.strictEqual(upd.incremental, true);
  assert.ok(!upd.text.includes('first'), 'already-shared turns are left out');
  assert.match(upd.text, /^_\(Continues the conversation shared earlier/);
  assert.match(upd.text, /second question[\s\S]*second answer/);
  assert.strictEqual(upd.lastTs, '2026-11-25T10:00:04.000Z');

  const none = chat.buildBrief(f, { since: '2026-11-25T10:00:04.000Z' });
  assert.strictEqual(none.turns, 0);
  assert.strictEqual(none.text, '');
});

test('shareLog remembers what was shared per session', () => {
  const log = chat.shareLog(path.join(dir, 'state', 'shares.json'));
  assert.strictEqual(log.get('claude-abc'), null);
  log.set('claude-abc', { transcript: 't.jsonl', lastTs: 'x', url: 'https://gemini.google.com/app/1' });
  log.set('other', { transcript: 'u.jsonl', lastTs: 'y', url: 'u' });
  assert.deepStrictEqual(log.get('claude-abc'), { transcript: 't.jsonl', lastTs: 'x', url: 'https://gemini.google.com/app/1' });
  assert.strictEqual(log.get('other').lastTs, 'y');
});
