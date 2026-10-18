// crew.js: watches a Claude Code session's transcript files and turns them into
// a live "crew" (the subagents that session spawned, plus what the main agent is doing).
const fs = require('fs');
const path = require('path');
const os = require('os');

const { cost } = require('./pricing');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const MAX_STEPS = 80;
const MAX_TICKS = 600;

// Call signs. The lead (the Claude you talk to) is always ZERO.
const CALLSIGNS = [
  'GHOST', 'VIPER', 'RAVEN', 'CIPHER', 'NOMAD', 'WRAITH', 'ONYX', 'TALON', 'ROOK', 'SPECTER', 'HAVOC', 'JINX',
  'VESPER', 'RONIN', 'NYX', 'ECHO', 'BLITZ', 'KESTREL', 'MOTH', 'LYNX', 'VANDAL', 'HEX', 'SABLE', 'FALCON',
];

// Tool -> category, used for timeline colours.
function category(name) {
  if (/^(Read|Grep|Glob|LSP|NotebookRead)$/.test(name)) return 'read';
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name)) return 'write';
  if (/^(Bash|Monitor)$/.test(name)) return 'run';
  if (/^(WebFetch|WebSearch)$/.test(name) || name.startsWith('mcp__')) return 'web';
  if (/^(Agent|Task|SendMessage)$/.test(name)) return 'spawn';
  return 'other';
}
const STALE_MS = 15 * 60 * 1000;

const projectDir = (cwd) => path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));

function mtime(f) {
  try { return fs.statSync(f).mtimeMs; } catch { return 0; }
}

// Read only the bytes appended since last time; return complete JSON lines.
function tail(state, file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  if (size < state.offset) { state.offset = 0; state.rest = ''; }
  if (size === state.offset) return [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - state.offset);
  fs.readSync(fd, buf, 0, buf.length, state.offset);
  fs.closeSync(fd);
  state.offset = size;
  const text = state.rest + buf.toString('utf8');
  const lines = text.split('\n');
  state.rest = lines.pop();
  const out = [];
  for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

function short(s, n = 110) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash': return short(input.description || input.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return base(input.file_path || input.notebook_path);
    case 'Grep': return short(`/${input.pattern}/ ${input.path ? base(input.path) : ''}`);
    case 'Glob': return short(input.pattern);
    case 'WebFetch': return short(input.url);
    case 'WebSearch': return short(input.query);
    case 'Agent': case 'Task': return short(input.description || input.prompt);
    case 'SubagentHandback': return 'handing back report';
    case 'TodoWrite': return 'updating plan';
    default: {
      const v = Object.values(input).find((x) => typeof x === 'string');
      return short(v || '');
    }
  }
}

function prettyTool(name) {
  return name.startsWith('mcp__') ? name.split('__').slice(-1)[0] : name;
}

// Fold transcript records into an agent summary (mutates `a`).
function ingest(a, records) {
  for (const r of records) {
    // Claude Code can move a conversation into a new session file and leave this pointer behind.
    if (r.type === 'continued-in' && r.continuedInSessionId) { a.next = r.continuedInSessionId; continue; }
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!a.startedAt) a.startedAt = t;
      a.lastAt = t;
    }
    const m = r.message;
    if (!m || typeof m !== 'object') continue;
    if (r.type === 'user') {
      if (!a.prompt && typeof m.content === 'string') a.prompt = short(m.content, 700);
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result' && b.is_error) {
            const step = a.steps.findLast?.((s) => s.toolId === b.tool_use_id);
            if (step) step.err = true;
            a.errors++;
          }
          if (!a.prompt && b.type === 'text') a.prompt = short(b.text, 700);
        }
      }
      a.lastKind = 'user';
    } else if (r.type === 'assistant') {
      let usedTool = false;
      // Context size the agent is working with right now (output counts in the
      // transcript are streaming placeholders, so they are not shown).
      if (m.usage) {
        const ctx = (m.usage.input_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
        if (ctx) a.ctx = ctx;
        // One API message is logged as several lines (one per content block); keep the last per id.
        if (m.id) a.usage.set(m.id, { model: m.model, in: m.usage.input_tokens || 0, out: m.usage.output_tokens || 0, cw: m.usage.cache_creation_input_tokens || 0, cr: m.usage.cache_read_input_tokens || 0 });
      }
      if (m.model && !m.model.startsWith('<')) a.model = m.model;
      for (const b of m.content || []) {
        if (b.type === 'tool_use') {
          usedTool = true;
          a.tools++;
          a.ticks.push({ t: a.lastAt, c: category(b.name) });
          if (a.ticks.length > MAX_TICKS) a.ticks.shift();
          const step = { k: 'tool', name: prettyTool(b.name), d: describeTool(b.name, b.input), t: a.lastAt, toolId: b.id };
          a.steps.push(step);
          if (b.name === 'SubagentHandback') { a.done = true; a.report = short(b.input?.message, 4000); }
        } else if (b.type === 'text' && b.text?.trim()) {
          a.steps.push({ k: 'say', d: short(b.text, 300), t: a.lastAt });
          a.lastText = short(b.text, 4000);
        }
      }
      if (a.steps.length > MAX_STEPS) a.steps.splice(0, a.steps.length - MAX_STEPS);
      if (!usedTool && m.stop_reason === 'end_turn' && a.sub) { a.done = true; a.report ||= a.lastText; }
      a.lastKind = 'assistant';
    }
  }
}

function newAgent(id, sub) {
  return { id, sub, steps: [], ticks: [], usage: new Map(), ctx: 0, model: '', tools: 0, errors: 0, done: false, startedAt: 0, lastAt: 0, prompt: '', report: '', lastText: '' };
}

function publicAgent(a, file, call, unit) {
  const now = Date.now();
  const status = a.done ? 'done' : now - mtime(file) > STALE_MS ? 'stopped' : 'running';
  const last = a.steps[a.steps.length - 1];
  const spent = { in: 0, out: 0, cw: 0, cr: 0, usd: 0 };
  for (const u of a.usage.values()) {
    spent.in += u.in; spent.out += u.out; spent.cw += u.cw; spent.cr += u.cr;
    spent.usd += cost(u.model, u);
  }
  return {
    spent,
    id: a.id, name: a.name || a.id, type: a.type, status, call, unit, parent: a.parent || null, depth: a.depth || 1,
    ctx: a.ctx, model: a.model, ticks: a.ticks,
    startedAt: a.startedAt, lastAt: a.lastAt, tools: a.tools, errors: a.errors,
    now: last ? (last.k === 'tool' ? `${last.name} · ${last.d}` : last.d) : 'starting…',
    prompt: a.prompt, report: a.report, steps: a.steps.map(({ toolId, ...s }) => s),
  };
}

// One watcher per pane: follows whichever session file that pane's claude is writing.
class CrewWatcher {
  constructor(session) {
    this.s = session;
    this.sid = null;
    this.reset();
  }

  reset() {
    this.main = newAgent('main', false);
    this.mainState = { offset: 0, rest: '' };
    this.subs = new Map(); // agentId -> { a, state, file }
    this.lastJson = '';
  }

  // Pick the transcript this pane owns: its injected --session-id if that is
  // still the live one, otherwise the newest file touched since the pane started
  // (covers /clear, --continue and --resume) that no other pane has claimed.
  resolve(claimed) {
    // claude launched by the pane, or started by hand in it (hooks then report its session id)
    if (!/^claude(\s|$)/.test((this.s.cmd || '').trim()) && !this.s.claudeSid) return null;
    const dir = projectDir(require('./paths').expand(this.s.cwd));
    let files;
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
    const since = (this.s.startedAt || 0) - 2000;
    const cands = files
      .map((f) => ({ sid: f.slice(0, -6), m: mtime(path.join(dir, f)) }))
      .filter((c) => c.m >= since && (!claimed.has(c.sid) || c.sid === this.sid))
      .sort((x, y) => y.m - x.m);
    // Hooks report the exact session id; trust it over the newest-file guess.
    const pinned = this.s.claudeSid && files.includes(this.s.claudeSid + '.jsonl') ? this.s.claudeSid : null;
    const pick = pinned || cands[0]?.sid || null;
    if (pick && pick !== this.sid) { this.sid = pick; this.reset(); }
    this.dir = dir;
    return this.sid;
  }

  poll() {
    if (!this.sid) return null;
    ingest(this.main, tail(this.mainState, path.join(this.dir, this.sid + '.jsonl')));
    // Follow the conversation into its new session file (and keep hooks pointed at it).
    for (let hops = 0; this.main.next && hops < 8; hops++) {
      const next = this.main.next;
      if (!fs.existsSync(path.join(this.dir, next + '.jsonl'))) break;
      this.sid = next;
      this.s.claudeSid = next;
      this.reset();
      ingest(this.main, tail(this.mainState, path.join(this.dir, this.sid + '.jsonl')));
    }
    const subDir = path.join(this.dir, this.sid, 'subagents');
    let names = [];
    try { names = fs.readdirSync(subDir).filter((f) => f.endsWith('.jsonl')); } catch {}
    for (const f of names) {
      const id = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let e = this.subs.get(id);
      if (!e) {
        e = { a: newAgent(id, true), state: { offset: 0, rest: '' }, file: path.join(subDir, f) };
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
          e.a.name = meta.description; e.a.type = meta.agentType; e.a.depth = meta.spawnDepth;
          e.a.parent = meta.parentAgentId || null; e.a.spawnTool = meta.toolUseId || null;
        } catch {}
        this.subs.set(id, e);
      }
      ingest(e.a, tail(e.state, e.file));
    }
    // Stable call signs: by spawn order, offset per session so missions differ.
    const off = [...this.sid].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % CALLSIGNS.length;
    const crew = [...this.subs.values()]
      .sort((x, y) => x.a.startedAt - y.a.startedAt)
      .map((e, i) => publicAgent(e.a, e.file, CALLSIGNS[(off + i) % CALLSIGNS.length], i + 1));
    // Who spawned whom: meta names the parent agent; older transcripts only give the spawning
    // tool call, so find which agent's log holds it. No parent means the lead (ZERO) sent it.
    const byTool = new Map();
    for (const [id, e] of this.subs) for (const st of e.a.steps) if (st.toolId) byTool.set(st.toolId, id);
    const known = new Set(crew.map((a) => a.id));
    for (const a of crew) {
      const e = this.subs.get(a.id);
      if (!a.parent && e.a.spawnTool && byTool.has(e.a.spawnTool)) a.parent = byTool.get(e.a.spawnTool);
      if (a.parent && !known.has(a.parent)) a.parent = null;
    }
    const mainFile = path.join(this.dir, this.sid + '.jsonl');
    const payload = { sessionId: this.sid, main: publicAgent(this.main, mainFile, 'ZERO', 0), crew };
    const json = JSON.stringify(payload);
    if (json === this.lastJson) return null;
    this.lastJson = json;
    return payload;
  }
}

module.exports = { CrewWatcher };
