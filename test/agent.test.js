// Tests for the agent-mode tools. They run against a throwaway git repo and need no browser.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const agent = require('../bridge/agent');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-agent-'));
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const write = (f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const run = (line, opts) => agent.runTool(root, line, opts);

before(() => {
  write('src/app.js', [
    'const helper = (x) => x + 1;',
    'function handleRequest(req) {',
    '  return helper(req.n);',
    '}',
    'class Server {',
    '  start(port) {',
    '    return port;',
    '  }',
    '}',
    'module.exports = { handleRequest, Server };',
  ].join('\n') + '\n');
  write('src/util.py', 'def parse_args(argv):\n    return argv\n');
  write('.env', 'SECRET=hunter2\n');
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'initial');
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('tokenize honors quotes', async () => {
  assert.deepStrictEqual(agent.tokenize(`npm test -- -t "my test" 'a b'`), ['npm', 'test', '--', '-t', 'my test', 'a b']);
  assert.throws(() => agent.tokenize('echo "oops'));
});

test('extractTools accepts the new commands', async () => {
  const t = agent.extractTools('```neon-tools\nDEFS handleRequest\nGIT log -n 3\nRUN npm test\n```');
  assert.deepStrictEqual(t, ['DEFS handleRequest', 'GIT log -n 3', 'RUN npm test']);
  assert.deepStrictEqual(agent.extractTools('```code snippet\nGIT status\nREAD a.js\n```'), ['GIT status', 'READ a.js']);
});

test('DEFS finds functions, arrow functions, methods and classes', async () => {
  assert.match(await run('DEFS handleRequest'), /src[\\/]app\.js:2:/);
  assert.match(await run('DEFS helper'), /src[\\/]app\.js:1:/);
  assert.doesNotMatch(await run('DEFS helper'), /app\.js:3:/); // a call, not a definition
  assert.match(await run('DEFS start'), /src[\\/]app\.js:6:/);
  assert.match(await run('DEFS Server'), /src[\\/]app\.js:5:/);
  assert.match(await run('DEFS parse_args'), /src[\\/]util\.py:1:/);
  assert.match(await run('DEFS nothingHere'), /no definition/);
});

test('GREP context shows surrounding lines', async () => {
  const out = await run('GREP /return helper/ src context=1');
  assert.match(out, /app\.js:2- function handleRequest/);
  assert.match(out, /app\.js:3: {3}return helper/);
  assert.match(out, /app\.js:4- \}/);
});

test('GREP never reads secret files', async () => {
  assert.strictEqual(await run('GREP hunter2'), '(no matches)');
});

test('GIT read-only subcommands work', async () => {
  assert.match(await run('GIT log --oneline'), /initial/);
  assert.match(await run('GIT blame -L 2,3 src/app.js'), /handleRequest/);
  assert.match(await run('GIT show --stat HEAD'), /src\/app\.js/);
  assert.match(await run('GIT branch --show-current'), /\S/);
});

test('GIT refuses writes, outside access and secrets', async () => {
  assert.match(await run('GIT commit -m x'), /supports only/);
  assert.match(await run('GIT diff --no-index /etc/passwd x'), /not allowed/);
  assert.match(await run('GIT log --output=out.txt'), /not allowed/);
  assert.match(await run('GIT branch -D master'), /can only list/);
  assert.match(await run('GIT tag v1'), /can only list/);
  assert.match(await run('GIT show HEAD:.env'), /denied/);
  assert.doesNotMatch(await run('GIT show HEAD'), /hunter2/); // .env section is filtered from the diff
});

test('RUN is off unless allowed, and only for allowed prefixes', async () => {
  assert.match(await run('RUN node --version'), /not enabled/);
  const opts = { allowRun: ['node --version', 'git status'] };
  assert.match(await run('RUN node --version', opts), /^\(exit 0, [\d.]+s\)\nv\d+/);
  assert.match(await run('RUN git status --short', opts), /^\(exit 0/);
  assert.match(await run('RUN node -e process.exit(3)', opts), /not an allowed command/);
  assert.match(await run('RUN git', opts), /not an allowed command/);
});

test('RUN reports exit codes and timeouts', async () => {
  assert.match(await run('RUN node missing-file.js', { allowRun: ['node'] }), /^\(exit 1,/);
  const t0 = Date.now();
  assert.match(await run('RUN node -e setTimeout(Date.now,4000)', { allowRun: ['node'], runTimeoutSec: 1 }), /timed out/);
  assert.ok(Date.now() - t0 < 3500, 'RUN should return soon after its timeout');
});

test('RUN on Windows refuses shell metacharacters', { skip: process.platform !== 'win32' }, async () => {
  assert.match(await run('RUN node --version & calc', { allowRun: ['node --version'] }), /may not contain/);
  assert.match(await run('RUN node --version %PATH%', { allowRun: ['node --version'] }), /may not contain/);
});

const goodPatch = [
  'diff --git a/src/util.py b/src/util.py',
  '--- a/src/util.py',
  '+++ b/src/util.py',
  '@@ -1,2 +1,3 @@',
  ' def parse_args(argv):',
  '+    argv = list(argv)',
  '     return argv',
].join('\n');

test('extractPatch prefers neon-patch blocks and falls back to diff fences', async () => {
  assert.strictEqual(agent.extractPatch('Fix:\n```neon-patch\n' + goodPatch + '\n```\n'), goodPatch + '\n');
  assert.strictEqual(agent.extractPatch('```diff\n' + goodPatch + '\n```'), goodPatch + '\n');
  assert.strictEqual(agent.extractPatch('```js\nconst a = 1;\n```'), null);
});

test('checkPatch validates without applying', async () => {
  const file = path.join(os.tmpdir(), `neon-test-${Date.now()}.diff`);
  const before = fs.readFileSync(path.join(root, 'src/util.py'), 'utf8');
  const ok = agent.checkPatch(root, goodPatch + '\n', file);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.strip, 1);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src/util.py'), 'utf8'), before);
  assert.ok(fs.existsSync(file));

  // Wrong hunk counts are tolerated (--recount); wrong context is not.
  assert.strictEqual(agent.checkPatch(root, goodPatch.replace('@@ -1,2 +1,3 @@', '@@ -1,9 +1,9 @@') + '\n', file).ok, true);
  const bad = agent.checkPatch(root, goodPatch.replace(' def parse_args', ' def nope') + '\n', file);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error);

  assert.match(agent.checkPatch(root, goodPatch.replace(/src\/util\.py/g, '../evil.py') + '\n', file).error, /outside/);
  assert.match(agent.checkPatch(root, goodPatch.replace(/src\/util\.py/g, '.env') + '\n', file).error, /denied/);
  fs.rmSync(file, { force: true });
});

test('preamble only mentions RUN and patches when enabled', async () => {
  const plain = agent.agentPreamble(root);
  assert.doesNotMatch(plain, /RUN </);
  assert.doesNotMatch(plain, /neon-patch/);
  const full = agent.agentPreamble(root, { allowRun: ['npm test'], patch: true });
  assert.match(full, /RUN <command>/);
  assert.match(full, /`npm test`/);
  assert.match(full, /neon-patch/);
});
