// Tests for agent-mode workspaces: several folders, what is visible, and credential redaction.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createWorkspace, parseAgentArg, redactSecrets } = require('../bridge/workspace');
const agent = require('../bridge/agent');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-ws-'));
const api = path.join(tmp, 'portal-api'), web = path.join(tmp, 'frontend'), outside = path.join(tmp, 'outside');
const write = (root, f, s) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), s); };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
let ws;
const run = (line, opts) => agent.runTool(ws, line, opts);

before(() => {
  // A git repo with tracked code, tracked data files, a tracked secret file and a note holding a password hint.
  write(api, 'app/PriceModel.php', '<?php\nclass PriceModel {\n  function rebate($x) { return $x * 0.9; }\n}\n');
  write(api, 'config/db.php', "<?php\n$dsn = 'mysql://app:hunter22pw@erp.local/db';\n$password = $_ENV['DB_PASS'];\n$api_key = 'sk-live-abcdefghijklmnop1234';\n");
  write(api, 'db_profile.txt', "Connecting as report_user\n  password: 16 chars, starts 'Qm' ends 'vt'\nConnected.\n");
  write(api, 'data/prices.csv', 'part,price\nA1,9.99\n');
  write(api, 'uploads/customer-list.txt', 'Customer names\n');
  write(api, '.env', 'DB_PASS=topsecret\n');
  git(api, 'init', '-q'); git(api, 'add', '-A'); git(api, 'commit', '-qm', 'init');
  write(api, 'scratch-notes.txt', 'ignored local notes\n'); // ignored by git
  write(api, '.gitignore', 'scratch-notes.txt\n');
  write(api, 'app/NewFeature.php', '<?php // new, not committed yet\n'); // untracked but not ignored
  // A plain folder (not a git repo).
  write(web, 'src/tenders.ts', 'export function loadTenders() { return []; }\n');
  write(outside, 'private.txt', 'outside the workspace\n');
  ws = createWorkspace([{ name: 'api', dir: api }, { name: 'web', dir: web }]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('parseAgentArg understands NAME=DIR and plain paths, including Windows drive letters', () => {
  assert.deepStrictEqual(parseAgentArg('api=../portal'), { name: 'api', dir: '../portal' });
  assert.deepStrictEqual(parseAgentArg('../portal'), { dir: '../portal' });
  assert.deepStrictEqual(parseAgentArg('C:/work/repo'), { dir: 'C:/work/repo' });
  assert.deepStrictEqual(parseAgentArg('D:\\work\\repo'), { dir: 'D:\\work\\repo' });
});

test('folder names default to the folder name and stay unique', () => {
  const w = createWorkspace([{ dir: api }, { dir: path.join(api, 'app') }, { dir: api }], { trackedOnly: false });
  assert.deepStrictEqual(w.roots.map(r => r.name), ['portal-api', 'app', 'portal-api-2']);
  assert.throws(() => createWorkspace([{ dir: path.join(tmp, 'missing') }]), /not found/);
});

test('LIST . shows every folder, without data, git-ignored or secret files', async () => {
  const out = await run('LIST . depth=3');
  assert.match(out, /^api\//m);
  assert.match(out, /^web\//m);
  assert.match(out, /PriceModel\.php/);
  assert.match(out, /tenders\.ts/);
  for (const hidden of ['prices.csv', 'customer-list', 'scratch-notes', '.env']) assert.ok(!out.includes(hidden), hidden);
});

test('READ works across folders and explains what is hidden', async () => {
  assert.match(await run('READ api/app/PriceModel.php'), /class PriceModel/);
  assert.match(await run('READ web/src/tenders.ts'), /loadTenders/);
  assert.match(await run('READ api/data/prices.csv'), /hidden \(data file/);
  assert.match(await run('READ api/uploads/customer-list.txt'), /hidden \(data file/);
  assert.match(await run('READ api/scratch-notes.txt'), /hidden \(ignored by git\)/);
  assert.match(await run('READ api/app/NewFeature.php'), /new, not committed yet/, 'new files that git does not ignore are visible');
  assert.match(await run('READ api/.env'), /denied/);
  assert.match(await run('READ nope/x.txt'), /unknown folder "nope"/);
  assert.match(await run('READ api/../outside/private.txt'), /outside the allowed folder/);
});

test('credentials are redacted in READ and GREP, and normal code stays readable', async () => {
  const cfg = await run('READ api/config/db.php');
  assert.ok(!cfg.includes('hunter22pw'), 'password in a URL');
  assert.ok(!cfg.includes('sk-live-abcdefghijklmnop1234'), 'API key');
  assert.match(cfg, /\$password = \$_ENV\['DB_PASS'\];/, 'reading a variable is not a secret');
  assert.match(cfg, /value\(s\) that looked like credentials were redacted/);
  const note = await run('READ api/db_profile.txt');
  assert.ok(!/Qm|vt'/.test(note), 'password hints in notes are redacted');
  assert.match(note, /password: \[REDACTED\]/);
  const grep = await run('GREP /password|dsn/i api');
  assert.ok(!grep.includes('hunter22pw') && !grep.includes("'Qm'"));
  assert.match(grep, /redacted/);
});

test('GREP, FIND and DEFS search every folder; GIT and RUN take the folder name', async () => {
  const g = await run('GREP /function/ .');
  assert.match(g, /api\/app\/PriceModel\.php:3:/);
  assert.match(g, /web\/src\/tenders\.ts:1:/);
  assert.match(await run('FIND tenders'), /web\/src\/tenders\.ts/);
  assert.match(await run('DEFS rebate'), /api\/app\/PriceModel\.php:3:/);
  assert.match(await run('DEFS loadTenders web'), /web\/src\/tenders\.ts:1:/);
  assert.match(await run('GIT api log --oneline'), /init/);
  assert.match(await run('GIT log --oneline'), /name the folder first/);
  assert.match(await run('RUN web node --version', { allowRun: ['node --version'] }), /^\(exit 0/);
});

test('--include-data and --all-files widen what is visible', async () => {
  const w = createWorkspace([{ dir: api }], { includeData: true, trackedOnly: false });
  assert.match(await agent.runTool(w, 'READ data/prices.csv'), /A1,9\.99/);
  assert.match(await agent.runTool(w, 'READ scratch-notes.txt'), /ignored local notes/);
  assert.match(await agent.runTool(w, 'READ .env'), /denied/, 'secret files stay blocked');
});

test('a symlink pointing outside the workspace is refused', async t => {
  try { fs.symlinkSync(outside, path.join(web, 'escape'), 'junction'); } catch { return t.skip('cannot create links here'); }
  assert.match(await run('READ web/escape/private.txt'), /outside the allowed folder \(symlink\)/);
  assert.ok(!(await run('LIST web depth=3')).includes('private.txt'), 'links are not followed when listing');
});

test('patches across folders are checked per folder', () => {
  const patch = [
    'diff --git a/api/app/PriceModel.php b/api/app/PriceModel.php',
    '--- a/api/app/PriceModel.php',
    '+++ b/api/app/PriceModel.php',
    '@@ -2,3 +2,3 @@',
    ' class PriceModel {',
    '-  function rebate($x) { return $x * 0.9; }',
    '+  function rebate($x) { return round($x * 0.9, 2); }',
    ' }',
    '',
  ].join('\n');
  const file = path.join(tmp, 'p.diff');
  const ok = agent.checkPatch(ws, patch, file);
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(ok.parts.length, 1);
  assert.strictEqual(ok.parts[0].root, 'api');
  assert.strictEqual(ok.parts[0].strip, 2);
  assert.ok(fs.existsSync(ok.parts[0].file));
  assert.match(fs.readFileSync(path.join(api, 'app/PriceModel.php'), 'utf8'), /\* 0\.9; \}/, 'never applied');
  assert.match(agent.checkPatch(ws, patch.replace(/api\/app/g, 'nope/app'), file).error, /unknown folder/);
});

test('the instructions name the folders when there are several', () => {
  const p = agent.agentPreamble(ws);
  assert.match(p, /`api\/`, `web\/`/);
  assert.match(p, /GIT api log/);
  assert.match(p, /\[REDACTED\]/);
  assert.match(agent.agentPreamble(api), /root = /);
});

test('redactSecrets leaves placeholders and env lookups alone', () => {
  const keep = [
    ['config.py', 'jwt_secret: str = os.environ.get("APP_JWT_SECRET", "")'],
    ['app.js', 'const token = process.env.TOKEN;'],
    ['README.md', 'Set api_key to your own key.'],
    ['example.yaml', 'password: <your-password>'],
    ['urls.txt', 'https://example.com/path?x=1'],
  ];
  for (const [f, t] of keep) assert.strictEqual(redactSecrets(t, f).count, 0, `${f}: ${t}`);
  const hide = [
    ['settings.yaml', 'db:\n  password: s3cretpw', 's3cretpw'],
    ['deploy.log', 'connecting to postgres://admin:Pa55word@db:5432/app', 'Pa55word'],
    ['client.ts', "const apiKey = 'AIzaSyA1234567890abcdefghijklmnopqrstu';", 'AIzaSyA1234567890'],
    ['notes.md', 'GitHub token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abc'],
  ];
  for (const [f, t, secret] of hide) assert.ok(!redactSecrets(t, f).text.includes(secret), `${f}: ${t}`);
});
