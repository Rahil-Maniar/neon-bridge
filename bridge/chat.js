// Turn a Claude Code conversation (its .jsonl transcript) into a short, readable brief for Neon:
// only what the user and Claude said, one line per tool Claude used (never the tool's output),
// secrets redacted, and the oldest turns dropped once it gets too long.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Find the transcript: an explicit path, or the current Claude Code session (CLAUDE_CODE_SESSION_ID).
function findTranscript(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error('conversation file not found: ' + explicit);
    return explicit;
  }
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new Error('no Claude Code session found (CLAUDE_CODE_SESSION_ID is not set); pass --chat-file PATH');
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()); } catch {}
  for (const d of dirs) {
    const f = path.join(projects, d.name, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`conversation file for session ${id} not found under ${projects}; pass --chat-file PATH`);
}

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,       // Anthropic, OpenAI, Stripe
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,          // GitHub
  /\bAKIA[0-9A-Z]{16}\b/g,                                                 // AWS access key
  /\bAIza[0-9A-Za-z_-]{30,}/g,                                             // Google API key
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                       // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,      // JWT
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{16,}/gi,
];
// key = value / key: value where the key name says it's a secret
const SECRET_ASSIGN = /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"',;]{6,})\3/gi;

function redact(text) {
  let n = 0;
  for (const re of SECRETS) text = text.replace(re, () => { n++; return '[REDACTED]'; });
  text = text.replace(SECRET_ASSIGN, (m, k, sep, q) => { n++; return `${k}${sep}${q}[REDACTED]${q}`; });
  return { text, count: n };
}

// Strip harness-injected blocks (reminders, notifications) from user text.
const stripInjected = s => s
  .replace(/<(system-reminder|task-notification|command-[a-z-]+|local-command-[a-z-]+|ide_[a-z_]+)[^>]*>[\s\S]*?<\/\1>/g, '')
  .replace(/<\/?pasted_content[^>]*>/g, '')
  .trim();

// Bookkeeping tools that say nothing about the work itself.
const QUIET_TOOLS = /^(mcp__ccd_|ToolSearch$|TodoWrite$|TaskCreate$|TaskUpdate$|TaskList$|TaskGet$)/;

function toolLine(b) {
  const inp = b.input || {};
  const what = inp.description || inp.title || inp.query || inp.pattern || (inp.file_path ? path.basename(inp.file_path) : '') || inp.url || '';
  const name = String(b.name || 'tool').replace(/^mcp__.+?__/, '');
  return name + (what ? ': ' + String(what).replace(/\s+/g, ' ').slice(0, 120) : '');
}

// Returns {text, turns, chars, redactions, omittedTurns}.
// since: an ISO timestamp; only entries after it are included (for a follow-up share in the same
// Gemini chat, so Neon gets just what's new). lastTs in the result is the newest entry's timestamp.
function buildBrief(file, { maxChars = 80000, tools = true, since = null } = {}) {
  let lastTs = since || '';
  const turns = []; // {who, parts[]}
  // parts are strings (text) or arrays (a run of tool uses, shown as one line)
  const push = (who, line, isTool = false) => {
    let last = turns[turns.length - 1];
    if (!last || last.who !== who) turns.push(last = { who, parts: [] });
    const prev = last.parts[last.parts.length - 1];
    if (isTool && Array.isArray(prev)) prev.push(line); else last.parts.push(isTool ? [line] : line);
  };
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let o; try { o = JSON.parse(raw); } catch { continue; }
    if (o.isSidechain || o.isMeta || !o.message) continue;
    if (o.timestamp && o.timestamp > lastTs) lastTs = o.timestamp;
    if (since && !(o.timestamp > since)) continue;
    const c = o.message.content;
    if (o.type === 'user') {
      if (o.isCompactSummary) { push('summary', stripInjected(typeof c === 'string' ? c : (c || []).filter(b => b.type === 'text').map(b => b.text).join('\n'))); continue; }
      const text = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
      const clean = stripInjected(text || '');
      if (clean) push('user', clean);
    } else if (o.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text' && b.text.trim()) push('claude', b.text.trim());
        else if (b.type === 'tool_use' && tools && !QUIET_TOOLS.test(b.name || '')) push('claude', toolLine(b), true);
      }
    }
  }
  const label = { user: '## User', claude: '## Claude', summary: '## Summary of earlier conversation' };
  const blocks = turns.map(t => `${label[t.who]}\n\n${t.parts.map(p => Array.isArray(p) ? `_[Tools used: ${p.join(' · ')}]_` : p).join('\n\n')}`);
  // Keep the newest turns that fit.
  let kept = [], size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (size + blocks[i].length > maxChars && kept.length) break;
    kept.unshift(blocks[i].length > maxChars ? '…' + blocks[i].slice(-maxChars) : blocks[i]);
    size += blocks[i].length + 2;
  }
  const omitted = blocks.length - kept.length;
  if (!kept.length) return { text: '', turns: 0, chars: 0, redactions: 0, omittedTurns: 0, lastTs, incremental: !!since };
  const body = (since ? '_(Continues the conversation shared earlier in this chat: only the turns since then are below.)_\n\n' : '') +
    (omitted ? `_(${omitted} earlier turns omitted for length)_\n\n` : '') + kept.join('\n\n');
  const { text, count } = redact(body);
  return { text, turns: kept.length, chars: text.length, redactions: count, omittedTurns: omitted, lastTs, incremental: !!since };
}

const chatPreamble = 'For context, the attached file conversation.md is the conversation so far between me (the user) and Claude, another AI assistant I am working with. Lines like _[Tools used: ...]_ list tools Claude ran; their output is not included. Use it as background; the request below is what I need from you now.\n\n';
const chatUpdatePreamble = 'The attached file conversation-update.md continues the conversation between me and Claude that I shared earlier in this chat: it has only what was said since then. Use it as background; the request below is what I need from you now.\n\n';

// Remembers, per bridge session, which Gemini chat got the conversation and up to when,
// so a later --with-chat in the same Gemini chat only sends what's new.
function shareLog(file) {
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  return {
    get: session => load()[session] || null,
    set(session, entry) { const all = load(); all[session] = entry; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 1)); } catch {} },
  };
}

module.exports = { findTranscript, buildBrief, redact, chatPreamble, chatUpdatePreamble, shareLog };
