// Daemon bookkeeping that doesn't need a browser, kept separate so it can be tested on its own.
const fs = require('fs');
const path = require('path');

// Request results, kept on disk (48h by default) so a client that was interrupted mid-request
// can still collect its answer with "result ID".
function createJobs(dir, { log = () => {}, maxAgeMs = 48 * 3600e3, now = () => Date.now() } = {}) {
  const running = new Set();
  const file = id => path.join(dir, String(id).replace(/[^\w.-]/g, '_') + '.json');
  const write = (id, data) => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(id), JSON.stringify(data)); } catch (e) { log('result write failed', e.message); } };
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const status = j => (j.status === 'running' && !running.has(j.id) ? 'lost' : j.status); // the daemon restarted mid-request
  try { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true }); } } catch {}
  return {
    start(id, body = {}) {
      running.add(id);
      write(id, { id, status: 'running', startedAt: now(), session: body.session || null, prompt: String(body.prompt || '').slice(0, 200) });
    },
    finish(id, result) {
      running.delete(id);
      const j = read(file(id)) || { id };
      write(id, { ...j, status: 'done', finishedAt: now(), result });
    },
    // Look up by exact id or id prefix (an agent run's later rounds are "<id>.<n>"); the newest wins.
    get(id) {
      if (!id) return { status: 'unknown', error: 'no id given' };
      let hits = [];
      try { hits = fs.readdirSync(dir).filter(f => f === `${id}.json` || f.startsWith(`${id}.`)).map(f => read(path.join(dir, f))).filter(Boolean); } catch {}
      if (!hits.length) return { id, status: 'unknown' };
      const j = hits.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0) || String(b.id).length - String(a.id).length)[0];
      return { ...j, status: status(j) };
    },
    list(limit = 30) {
      let out = [];
      try { out = fs.readdirSync(dir).map(f => read(path.join(dir, f))).filter(Boolean); } catch {}
      return out.map(j => ({ id: j.id, status: status(j), ok: j.result ? j.result.ok : null, session: j.session, startedAt: j.startedAt, prompt: (j.prompt || '').slice(0, 80) }))
        .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
    },
  };
}

// The daemon is shared by every client on the machine, so shutting it down while requests are
// running would kill other sessions' work. Refuse unless forced.
function shutdownCheck(sessions, force) {
  const running = [...sessions].filter(s => s && s.busy).length;
  return running && !force
    ? { ok: false, code: 'BUSY', running, error: `${running} request(s) still running` }
    : { ok: true, running };
}

module.exports = { createJobs, shutdownCheck };
