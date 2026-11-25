// Tests for the daemon's answer store and shutdown guard. No browser needed.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJobs, shutdownCheck } = require('../bridge/jobs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-jobs-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const freshDir = () => path.join(base, String(n++));

test('a request is running until finished, then keeps its result', () => {
  const jobs = createJobs(freshDir());
  jobs.start('r1', { session: 'claude-abc', prompt: 'hello' });
  assert.strictEqual(jobs.get('r1').status, 'running');
  assert.strictEqual(jobs.get('r1').session, 'claude-abc');
  jobs.finish('r1', { ok: true, answer: 'hi' });
  const j = jobs.get('r1');
  assert.strictEqual(j.status, 'done');
  assert.deepStrictEqual(j.result, { ok: true, answer: 'hi' });
});

test('results survive a daemon restart; unfinished ones show as lost', () => {
  const dir = freshDir();
  const a = createJobs(dir);
  a.start('done1', { prompt: 'x' }); a.finish('done1', { ok: true, answer: 'kept' });
  a.start('cut1', { prompt: 'y' }); // daemon "dies" before finishing
  const b = createJobs(dir);
  assert.strictEqual(b.get('done1').status, 'done');
  assert.strictEqual(b.get('done1').result.answer, 'kept');
  assert.strictEqual(b.get('cut1').status, 'lost');
});

test('unknown ids and empty ids', () => {
  const jobs = createJobs(freshDir());
  assert.strictEqual(jobs.get('nope').status, 'unknown');
  assert.strictEqual(jobs.get('').status, 'unknown');
});

test('an agent run id finds its newest round', () => {
  let t = 1000;
  const jobs = createJobs(freshDir(), { now: () => t });
  jobs.start('run9', {}); jobs.finish('run9', { ok: true, answer: 'round 1' });
  t = 2000; jobs.start('run9.2', {}); jobs.finish('run9.2', { ok: true, answer: 'round 2' });
  t = 3000; jobs.start('run9.3', {});
  assert.strictEqual(jobs.get('run9').id, 'run9.3');
  assert.strictEqual(jobs.get('run9').status, 'running');
  jobs.finish('run9.3', { ok: true, answer: 'final' });
  assert.strictEqual(jobs.get('run9').result.answer, 'final');
  assert.strictEqual(jobs.get('run90').status, 'unknown', 'prefix must end at a dot');
});

test('list shows newest first with status and ok', () => {
  let t = 1;
  const jobs = createJobs(freshDir(), { now: () => t++ });
  jobs.start('a', { prompt: 'first' }); jobs.finish('a', { ok: false, code: 'TIMEOUT' });
  jobs.start('b', { prompt: 'second' });
  const l = jobs.list();
  assert.deepStrictEqual(l.map(j => [j.id, j.status, j.ok]), [['b', 'running', null], ['a', 'done', false]]);
});

test('old results are cleaned up', () => {
  const dir = freshDir();
  createJobs(dir).start('old', {});
  const later = Date.now() + 49 * 3600e3;
  const jobs = createJobs(dir, { now: () => later });
  assert.strictEqual(jobs.get('old').status, 'unknown');
});

test('ids cannot escape the results folder', () => {
  const dir = freshDir();
  const jobs = createJobs(dir);
  jobs.start('../../evil', {});
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'evil.json')));
  assert.ok(fs.readdirSync(dir).length === 1);
});

test('shutdown is refused while requests run, unless forced', () => {
  const idle = [{ busy: false }, { busy: false }], busy = [{ busy: true }, { busy: false }, { busy: true }];
  assert.deepStrictEqual(shutdownCheck(idle, false), { ok: true, running: 0 });
  const r = shutdownCheck(busy, false);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'BUSY'); assert.strictEqual(r.running, 2);
  assert.strictEqual(shutdownCheck(busy, true).ok, true);
  assert.strictEqual(shutdownCheck(new Map([['x', { busy: true }]]).values(), undefined).ok, false);
});
