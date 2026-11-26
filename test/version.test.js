// Tests for finding the newest installed copy of the bridge.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { compare, newerCopy } = require('../bridge/version');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-ver-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const install = (base, v, withCli = true) => { fs.mkdirSync(path.join(base, v, 'bridge'), { recursive: true }); if (withCli) fs.writeFileSync(path.join(base, v, 'bridge', 'neon.js'), ''); };

test('compare orders versions numerically and treats missing versions as oldest', () => {
  assert.strictEqual(compare('0.10.0', '0.9.9'), 1);
  assert.strictEqual(compare('0.5.0', '0.5.0'), 0);
  assert.strictEqual(compare('1.0.0', '0.99.99'), 1);
  assert.strictEqual(compare(undefined, '0.1.0'), -1);
  assert.strictEqual(compare('garbage', '0.0.1'), -1);
});

test('newerCopy finds the newest installed version, ignoring broken or non-version folders', () => {
  const base = path.join(tmp, 'cache', 'm', 'p');
  for (const v of ['0.1.0', '0.5.0', '0.10.0']) install(base, v);
  install(base, '0.11.0', false); // incomplete: no CLI inside
  fs.mkdirSync(path.join(base, 'latest'), { recursive: true });
  assert.deepStrictEqual(newerCopy(path.join(base, '0.1.0', 'bridge'), '0.1.0'), { version: '0.10.0', file: path.join(base, '0.10.0', 'bridge', 'neon.js') });
  assert.strictEqual(newerCopy(path.join(base, '0.10.0', 'bridge'), '0.10.0'), null, 'already the newest');
});

test('newerCopy does nothing outside a versioned plugin folder (e.g. a git checkout)', () => {
  const repo = path.join(tmp, 'neon-bridge');
  fs.mkdirSync(path.join(repo, 'bridge'), { recursive: true });
  install(tmp, '9.9.9');
  assert.strictEqual(newerCopy(path.join(repo, 'bridge'), '0.1.0'), null);
});
