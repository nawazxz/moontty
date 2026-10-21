// Moontty server: a tiny tmux-like session server with a browser GUI.
// PTYs live here, so closing the window is a "detach"; reopening re-attaches.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { Terminal: Headless } = require('@xterm/headless');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const { CrewWatcher } = require('./crew');
const git = require('./git');
const history = require('./history');

const PORT = Number(process.env.DECK_PORT || 7681);
const STATE_DIR = process.env.DECK_STATE || path.join(os.homedir(), '.agent-deck');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const SCROLLBACK = 400 * 1024; // bytes of raw output kept per session for replay
const SHELL = process.env.SHELL || '/bin/zsh';

// Each pane's shell runs under dtach, so it outlives the server: a restart re-attaches instead of
// killing the agents. Socket paths must stay short (macOS caps them near 104 bytes).
const SOCK_DIR = process.env.DECK_SOCK || path.join(STATE_DIR, 'sock');
const BUF_DIR = path.join(STATE_DIR, 'buf');
// The packaged app carries its own dtach in bin/, used when the system has none.
const DTACH = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/usr/bin/dtach', path.join(__dirname, 'bin', 'dtach')].find((f) => fs.existsSync(f));

fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(SOCK_DIR, { recursive: true });
fs.mkdirSync(BUF_DIR, { recursive: true });

const sessions = new Map(); // id -> session
const clients = new Set();
let nextId = 1;

// ---------- status detection ----------
// Each session also feeds a headless terminal, so we read what is on screen
// *now* (TUIs like Claude Code redraw in place, so raw output keeps stale text).
const WAITING = [
  /do you want to/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /❯\s*1\.\s*yes/i,
  /enter to confirm/i,
  /trust this folder/i,
  /press enter to/i,
  /waiting for (your )?input/i,
];

function screenText(s) {
  const buf = s.screen.buffer.active;
  const lines = [];
  for (let y = buf.viewportY; y < buf.viewportY + s.screen.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) || '');
  return lines.join('\n');
}

// Panes running claude report exact state through hooks (hook.sh -> POST /hook).
// Esc-interrupts send no hook, so "working" falls back to idle once the spinner
// stops drawing. Panes that never sent a hook use the screen heuristic below.
const HOOK_SILENCE = 8000;
function computeStatus(s) {
  if (s.exited) return 'exited';
  if (s.hook) {
    if (s.hook === 'working' && Date.now() - s.lastOutput > HOOK_SILENCE) s.hook = 'idle';
    return s.hook;
  }
  if (Date.now() - s.lastOutput < 1500) return 'working';
  if (s.screenStale) { s.screenStale = false; s.screen.reset(); s.screen.write(s.buffer.slice(-64 * 1024)); }
  if (WAITING.some((re) => re.test(screenText(s)))) return 'waiting';
  return 'idle';
}

// ---------- persistence ----------
function save() {
  const list = [...sessions.values()].map(({ id, name, cwd, cmd, worktree, claudeSid, parent, cols, rows }) => ({ id, name, cwd, cmd, worktree, claudeSid, parent, cols, rows }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(list, null, 2));
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// ---------- sessions ----------
const { expand } = require('./paths');

// Strip vars inherited from whatever launched the server: Apple Terminal's
// session-restore hooks print junk in our panes, and CLAUDECODE makes claude
// think it is nested inside another Claude Code session.
function paneEnv(s) {
  const env = { ...process.env };
  const INHERITED = /^(TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_.*|MESSAGING_.*))$/;
  for (const k of Object.keys(env)) if (INHERITED.test(k)) delete env[k];
  // Apps opened from Finder get no locale, and pbcopy/pbpaste then read UTF-8 as MacRoman (❯ became ‚ùØ¬†). Terminal.app sets one too.
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = 'en_US.UTF-8';
  // zsh: a Moontty .zshenv loads your own config, then adds grey history hints (→ accepts).
  if (path.basename(SHELL) === 'zsh') {
    if (env.ZDOTDIR) env.MOONTTY_ZDOTDIR = env.ZDOTDIR;
    env.ZDOTDIR = path.join(__dirname, 'shell', 'zsh');
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'agent-deck', SHELL_SESSIONS_DISABLE: '1', PROMPT_EOL_MARK: '', AGENT_DECK_ID: String(s.id), AGENT_DECK_PORT: String(PORT), PATH: `${path.join(__dirname, 'bin')}:${env.PATH || ''}` };
}

const sockOf = (s) => path.join(SOCK_DIR, `${s.id}.sock`);
const bufOf = (s) => path.join(BUF_DIR, `${s.id}.log`);

// Is a dtach session still holding this pane's shell?
function alive(sock) {
  if (!DTACH || !fs.existsSync(sock)) return false;
  try { execFileSync(DTACH, ['-p', sock], { input: '', stdio: ['pipe', 'ignore', 'ignore'], timeout: 1500 }); return true; } catch { return false; }
}

// fresh: start a new shell (and the agent command). Otherwise re-attach when the old one is still running.
function spawn(s, fresh) {
  const cwd = fs.existsSync(expand(s.cwd)) ? expand(s.cwd) : os.homedir();
  const sock = sockOf(s);
  const reattach = !fresh && alive(sock);
  if (!reattach) try { fs.unlinkSync(sock); } catch {}
  const args = DTACH ? [DTACH, ['-A', sock, '-E', '-z', '-r', 'winch', SHELL, '-l', '-i']] : [SHELL, ['-l', '-i']];
  const p = pty.spawn(args[0], args[1], {
    name: 'xterm-256color',
    cols: s.cols || 120,
    rows: s.rows || 32,
    cwd,
    env: paneEnv(s),
  });
  s.pty = p;
  s.screen?.dispose();
  s.screen = new Headless({ cols: s.cols || 120, rows: s.rows || 32, scrollback: 0, allowProposedApi: true });
  s.exited = false;
  s.hook = null;
  s.startedAt = Date.now();
  s.lastOutput = Date.now();
  if (reattach) {
    // Bring back what was on screen before the restart; dtach's WINCH makes TUIs redraw on top.
    try { s.buffer = fs.readFileSync(bufOf(s), 'utf8'); } catch { s.buffer = ''; }
    s.screen.write(s.buffer);
  } else s.buffer = '';
  s.bufDirty = false;
  // Handlers check s.pty so a restarted pane's old PTY can't flip the new one to exited.
  p.onData((d) => {
    if (s.pty !== p) return;
    s.buffer += d;
    // Trim with some slack: slicing a full buffer on every chunk copies 400 KB each time.
    if (s.buffer.length > SCROLLBACK * 1.25) s.buffer = s.buffer.slice(-SCROLLBACK);
    s.bufDirty = true;
    s.lastOutput = Date.now();
    // The on-screen heuristic only runs for panes that never sent a hook, so hooked panes skip the parse.
    if (!s.hook) s.screen.write(d);
    else s.screenStale = true;
    broadcastOut(s.id, d);
  });
  p.onExit(({ exitCode }) => {
    if (s.pty !== p) return;
    s.exited = true;
    s.exitCode = exitCode;
    pushStatus(s, true);
  });
  s.crewData = null;
  if (reattach) { s.crew = new CrewWatcher(s); return; }
  // Run the agent command inside an interactive shell, so when it quits you
  // land at a prompt in the same pane (like a tmux window).
  // Pin a session id on fresh claude launches so we know which transcript
  // (and which subagents) belong to this pane.
  let cmd = (s.cmd || '').trim();
  if (/^claude(\s|$)/.test(cmd) && !/(^|\s)(-c|--continue|-r|--resume|--session-id|-p|--print)(\s|=|$)/.test(cmd)) {
    s.claudeSid = crypto.randomUUID();
    cmd += ` --session-id ${s.claudeSid}`;
  } else s.claudeSid = null;
  s.crew = new CrewWatcher(s);
  if (cmd) setTimeout(() => s.pty === p && p.write(cmd + '\r'), 300);
}

// Every process in a pane: the dtach processes for its socket (the master is detached after a
// server restart, a child of our attach client before that) and everything under them.
function paneTree(s) {
  const sock = sockOf(s);
  const rows = String(execFileSync('ps', ['-Ao', 'pid=,ppid=,args='])).split('\n').map((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] };
  }).filter(Boolean);
  const pids = rows.filter((r) => /dtach/.test(r.args) && r.args.includes(sock)).map((r) => r.pid);
  for (let i = 0; i < pids.length; i++) for (const r of rows) if (r.ppid === pids[i] && !pids.includes(r.pid)) pids.push(r.pid);
  return { pids };
}

// End a pane for real: the attach client, the dtach master and everything running in it.
function endPane(s) {
  try { s.pty.kill(); } catch {}
  try {
    const { pids } = paneTree(s);
    for (const pid of pids.reverse()) try { process.kill(pid, 'SIGHUP'); } catch {}
    setTimeout(() => { for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch {} }, 1500);
  } catch (e) { console.error('end pane', s.id, e.message); }
  try { fs.unlinkSync(sockOf(s)); } catch {}
}

// Screen contents survive a server restart too.
function flushBuffers() {
  for (const s of sessions.values()) {
    if (!s.bufDirty) continue;
    s.bufDirty = false;
    try { fs.writeFileSync(bufOf(s), s.buffer); } catch {}
  }
}
setInterval(flushBuffers, 2000);

function createSession({ name, cwd, cmd, id, worktree, ownBranch, claudeSid, parent }, fresh = true) {
  const s = {
    id: id || nextId++,
    name: name || `agent-${nextId}`,
    cwd: cwd || '~',
    cmd: cmd ?? 'claude',
    worktree: worktree || null,
    claudeSid: claudeSid || null,
    parent: parent || null, // companion shell docked to this mission
    buffer: '',
    status: 'idle',
  };
  // "Own branch": the mission works in a fresh git worktree, so parallel agents never touch each other's files.
  if (ownBranch && !worktree) {
    try {
      s.worktree = git.addWorktree(expand(s.cwd), s.name);
      s.cwd = s.worktree.path;
    } catch (e) { s.note = `no branch: ${e.message}`; }
  }
  nextId = Math.max(nextId, s.id + 1);
  sessions.set(s.id, s);
  spawn(s, fresh);
  return s;
}

function publicInfo(s) {
  return { id: s.id, name: s.name, cwd: s.cwd, cmd: s.cmd, status: s.status, startedAt: s.startedAt, exitCode: s.exitCode, worktree: s.worktree, git: s.git, ports: s.ports, pr: s.pr, parent: s.parent || null };
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(str);
}

// Output only goes to windows that are showing that pane; the rest catch up from the buffer on return.
function broadcastOut(id, data) {
  const str = JSON.stringify({ t: 'out', id, data });
  for (const c of clients) if (c.readyState === 1 && (!c.watch || c.watch.has(id))) c.send(str);
}

function pushList() {
  broadcast({ t: 'sessions', list: [...sessions.values()].map(publicInfo) });
}

function pushStatus(s, force) {
  const st = computeStatus(s);
  if (st !== s.status || force) {
    const prev = s.status;
    s.status = st;
    broadcast({ t: 'status', id: s.id, status: st, prev, workedMs: Date.now() - (s.workStart || Date.now()), msg: st === 'waiting' ? s.waitMsg || '' : '' });
    if (st === 'working') s.workStart = Date.now();
  }
}

setInterval(() => sessions.forEach((s) => pushStatus(s)), 500);

// Crew polling: claim injected ids first so panes sharing a folder don't swap transcripts.
setInterval(() => {
  const claimed = new Set();
  const order = [...sessions.values()].sort((a, b) => (b.claudeSid ? 1 : 0) - (a.claudeSid ? 1 : 0));
  for (const s of order) {
    const sid = s.crew.resolve(claimed);
    if (sid) claimed.add(sid);
  }
  for (const s of sessions.values()) {
    try {
      const data = s.crew.poll();
      if (data) { s.crewData = data; broadcast({ t: 'crew', id: s.id, ...data }); }
      if (s.claudeSid && s.claudeSid !== s.savedSid) { s.savedSid = s.claudeSid; save(); } // follows /resume, /clear, handoffs
    } catch (e) { console.error('crew', s.id, e.message); }
  }
}, 1500);

// Git + listening ports per mission, shown on the title bar. Async so a slow repo never stalls the PTYs.
let gitBusy = false;
setInterval(async () => {
  if (gitBusy || !sessions.size) return;
  gitBusy = true;
  try {
    const ports = await listeningPorts([...sessions.values()].filter((s) => !s.exited));
    for (const s of sessions.values()) {
      const info = await git.info(expand(s.cwd), s.worktree);
      const p = ports.get(s.id) || [];
      const key = JSON.stringify([info, p]);
      if (key !== s.gitKey) {
        s.gitKey = key; s.git = info; s.ports = p;
        broadcast({ t: 'git', id: s.id, git: info, ports: p });
        if (info?.branch && prSeen.get(s.id) !== info.branch) pollPrs(s.id).catch(() => {});
      }
    }
  } catch (e) { console.error('git poll', e.message); }
  gitBusy = false;
}, 4000);

// Pull request per mission branch, via gh. Slow and rate-limited, so once a minute,
// and right away when a mission's branch changes.
const prSeen = new Map(); // id -> branch last checked
async function pollPrs(only) {
  for (const s of sessions.values()) {
    if (only && s.id !== only) continue;
    const branch = s.git?.branch;
    if (!branch) continue;
    prSeen.set(s.id, branch);
    const info = await git.pr(expand(s.cwd), branch);
    const key = JSON.stringify(info);
    if (key !== s.prKey) { s.prKey = key; s.pr = info; broadcast({ t: 'pr', id: s.id, pr: info }); }
  }
}
setInterval(() => pollPrs().catch((e) => console.error('pr poll', e.message)), 60000);

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 8 << 20 }, (err, out) => res(err && !out ? '' : String(out))));

// pane id -> sorted TCP ports that any process in the pane is listening on. Under dtach the
// shell hangs off the detached master (found by its socket path), not off our PTY.
async function listeningPorts(list) {
  const out = new Map();
  if (!list.length) return out;
  const [ps, lsof] = await Promise.all([run('ps', ['-Ao', 'pid=,ppid=,args=']), run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'])]);
  const parent = new Map();
  const roots = new Map(); // root pid -> pane id
  for (const s of list) roots.set(s.pty.pid, s.id);
  for (const l of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const pid = Number(m[1]), ppid = Number(m[2]);
    parent.set(pid, ppid);
    if (ppid === 1 && /dtach/.test(m[3])) for (const s of list) if (m[3].includes(sockOf(s))) roots.set(pid, s.id);
  }
  const paneOf = (pid) => { for (let i = 0; pid && i < 64; i++) { if (roots.has(pid)) return roots.get(pid); pid = parent.get(pid); } return null; };
  let cur = null;
  for (const l of lsof.split('\n')) {
    if (l[0] === 'p') cur = paneOf(Number(l.slice(1)));
    else if (l[0] === 'n' && cur != null) {
      const port = Number(l.split(':').pop());
      if (!port) continue;
      const set = out.get(cur) || new Set();
      set.add(port);
      out.set(cur, set);
    }
  }
  for (const [k, v] of out) out.set(k, [...v].sort((a, b) => a - b));
  return out;
}

// ---------- hooks ----------
// Claude Code event -> pane status. idle_prompt fires after 60s of quiet and is not "needs you".
const NEEDS_YOU = /^(permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input)$/;
function onHook(s, ev) {
  const name = ev.hook_event_name;
  // Subagents share the parent's session and keep calling tools while the lead waits on you;
  // crew.js already tracks them, so they never drive the pane status.
  if (ev.agent_id) return;
  if (ev.session_id && ev.session_id !== s.claudeSid) {
    // A different session is either the pane's claude starting fresh (or /clear), or a nested
    // `claude -p` run from inside it, which must not hijack the pane.
    // (/clear, /resume and compaction also start a new session id inside the same claude)
    const fresh = name === 'SessionStart' && (s.hook === null || /^(clear|resume|compact)$/.test(ev.source || ''));
    if (s.claudeSid && !fresh) return;
    s.claudeSid = ev.session_id;
  }
  if (name === 'SessionEnd') { s.hook = null; return pushStatus(s); }
  if (/^(UserPromptSubmit|PostToolUse|PostToolUseFailure|PermissionDenied)$/.test(name)) s.hook = 'working';
  else if (name === 'PreToolUse') s.hook = ev.tool_name === 'AskUserQuestion' ? 'waiting' : 'working';
  else if (name === 'PermissionRequest') s.hook = 'waiting';
  else if (name === 'Notification') {
    if (NEEDS_YOU.test(ev.notification_type)) s.hook = 'waiting';
    else if (ev.notification_type === 'idle_prompt') s.hook = 'idle';
    else return;
  } else if (name === 'Stop' || name === 'StopFailure') s.hook = 'idle';
  else if (name === 'SessionStart') s.hook = s.hook || 'idle';
  else return;
  if (s.hook === 'waiting') s.waitMsg = ev.message || askText(ev);
  s.lastOutput = Date.now();
  pushStatus(s);
}

// "wants to run: npm test" reads better than a bare tool name.
function askText(ev) {
  const i = ev.tool_input || {};
  if (ev.tool_name === 'AskUserQuestion') return `asks: ${i.questions?.[0]?.question || 'a question'}`;
  const what = i.command || i.file_path || i.url || i.pattern || '';
  if (!ev.tool_name) return '';
  return what ? `wants to ${ev.tool_name === 'Bash' ? 'run' : `use ${ev.tool_name} on`}: ${String(what).replace(/\s+/g, ' ').slice(0, 120)}` : `wants to use ${ev.tool_name}`;
}

function readBody(req, max = 1 << 20) {
  return new Promise((res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > max) req.destroy(); });
    req.on('end', () => res(body));
  });
}

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ROUTES = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
  '/vendor/addon-search.js': 'node_modules/@xterm/addon-search/lib/addon-search.js',
  '/vendor/addon-web-links.js': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js',
};

// Plan usage (5-hour and weekly limits, Pro/Max) arrives with Claude Code's status line call,
// the only place it is published. It is account-wide, so the newest report from any pane wins.
const USAGE_FILE = path.join(STATE_DIR, 'usage.json');
let usage = (() => { try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return null; } })();
function onUsage(rl) {
  const pick = (w) => (w && typeof w.used_percentage === 'number' ? { pct: w.used_percentage, resetsAt: (w.resets_at || 0) * 1000 } : null);
  const next = { five: pick(rl.five_hour), week: pick(rl.seven_day), at: Date.now() };
  if (!next.five && !next.week) return;
  const same = usage && JSON.stringify({ ...usage, at: 0 }) === JSON.stringify({ ...next, at: 0 });
  usage = next;
  if (same) return;
  broadcast({ t: 'usage', usage });
  fs.writeFile(USAGE_FILE, JSON.stringify(usage), () => {});
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (req.method === 'POST' && url === '/hook') {
    const s = sessions.get(Number(req.headers['x-deck-id']));
    let ev = {};
    try { ev = JSON.parse(await readBody(req)); } catch {}
    if (ev.rate_limits) onUsage(ev.rate_limits); // the status line call: plan usage, not an event
    else if (s && !s.exited) onHook(s, ev);
    return res.writeHead(204).end();
  }
  // mt-preview from inside a pane: drive that mission's preview pane.
  if (req.method === 'POST' && url === '/preview') {
    const s = sessions.get(Number(req.headers['x-deck-id']));
    let m = {};
    try { m = JSON.parse(await readBody(req, 8192)); } catch {}
    const target = s && (s.parent && sessions.has(s.parent) ? s.parent : s.id);
    if (!target) return res.writeHead(404).end();
    if (m.url && !/^https?:\/\/[^\s]+$/.test(m.url)) return res.writeHead(400).end();
    broadcast({ t: 'preview', id: target, url: m.url || null, action: m.action || null });
    return res.writeHead(204).end();
  }
  const rel = ROUTES[url] || path.join('public', url === '/' ? 'index.html' : url);
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// Fingerprint of the page code. An open window that reconnects to a newer server reloads itself
// instead of running stale JavaScript against the new protocol.
const BUILD = crypto.createHash('sha1').update(['index.html', 'app.js', 'style.css'].map((f) => fs.readFileSync(path.join(__dirname, 'public', f))).join('')).digest('hex').slice(0, 10);

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  // Local-only tool: refuse cross-site pages trying to drive your shells.
  const origin = req.headers.origin || '';
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return ws.close();
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'hello', build: BUILD }));
  if (usage) ws.send(JSON.stringify({ t: 'usage', usage }));
  ws.send(JSON.stringify({ t: 'sessions', list: [...sessions.values()].map(publicInfo) }));
  for (const s of sessions.values()) {
    ws.send(JSON.stringify({ t: 'replay', id: s.id, data: s.buffer }));
    if (s.crewData) ws.send(JSON.stringify({ t: 'crew', id: s.id, ...s.crewData }));
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const s = sessions.get(m.id);
    switch (m.t) {
      case 'create': {
        const parent = sessions.has(m.parent) ? m.parent : null;
        const ns = createSession({ name: m.name, cwd: m.cwd, cmd: m.cmd, ownBranch: !parent && !!m.ownBranch, parent });
        save();
        pushList();
        ws.send(JSON.stringify({ t: 'created', id: ns.id, note: ns.note }));
        break;
      }
      case 'input':
        if (s && !s.exited) {
          s.pty.write(m.data);
          // Answering a prompt (Enter, Esc, or a numbered choice) lets claude carry on; arrow keys
          // only move the selection, so they must not clear "needs you".
          if (s.hook === 'waiting' && /^(\r|\x1b|[1-9])$/.test(m.data)) { s.hook = 'working'; s.lastOutput = Date.now(); }
        }
        break;
      case 'diff':
        if (s) git.diff(expand(s.cwd), s.worktree).then((d) => ws.readyState === 1 && ws.send(JSON.stringify({ t: 'diff', id: s.id, ...d })));
        break;
      case 'pr':
        if (s?.worktree) git.openPr(s.worktree).then((r) => { ws.send(JSON.stringify({ t: 'merged', id: s.id, ...r })); prSeen.delete(s.id); pollPrs(s.id); });
        break;
      case 'merge':
        if (s?.worktree) git.merge(s.worktree).then((r) => ws.send(JSON.stringify({ t: 'merged', id: s.id, ...r })));
        break;
      case 'open':
        if (Number.isInteger(m.port) && m.port > 0 && m.port < 65536) execFile('open', [`http://localhost:${m.port}`]);
        else if (/^https?:\/\/[^\s]+$/.test(m.url || '')) execFile('open', [m.url]);
        break;
      case 'history': {
        let dir = expand(String(m.cwd || '~'));
        try { dir = fs.realpathSync(dir); } catch {}
        ws.send(JSON.stringify({ t: 'history', cwd: m.cwd, list: history.list(dir) }));
        break;
      }
      case 'watch': {
        const next = new Set((Array.isArray(m.ids) ? m.ids : []).filter((id) => sessions.has(id)));
        for (const id of next) if (ws.watch && !ws.watch.has(id)) ws.send(JSON.stringify({ t: 'replay', id, data: sessions.get(id).buffer }));
        ws.watch = next;
        break;
      }
      case 'resize':
        if (s && !s.exited && m.cols > 0 && m.rows > 0) {
          s.cols = m.cols; s.rows = m.rows;
          try { s.pty.resize(m.cols, m.rows); s.screen.resize(m.cols, m.rows); } catch {}
        }
        break;
      case 'rename':
        if (s) { s.name = String(m.name).slice(0, 60); save(); pushList(); }
        break;
      case 'restart':
        if (s) {
          endPane(s);
          broadcast({ t: 'replay', id: s.id, data: '\x1b[2J\x1b[H' });
          // give the old master a moment to let go of the socket
          setTimeout(() => { spawn(s, true); save(); pushList(); }, 300);
        }
        break;
      case 'kill':
        if (s) {
          endPane(s);
          s.screen.dispose();
          sessions.delete(s.id);
          try { fs.unlinkSync(bufOf(s)); } catch {}
          if (s.worktree && m.dropBranch) git.removeWorktree(s.worktree).catch((e) => console.error('worktree', e.message));
          save();
          pushList();
        }
        break;
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// ---------- boot ----------
// Re-attach to every pane that is still running; only dead ones start over.
for (const def of load()) createSession(def, false);
save();
server.listen(PORT, '127.0.0.1', () => console.log(`moontty on http://localhost:${PORT}`));

// Stopping the server only detaches: the agents keep running in dtach and come back on next start.
// Without dtach the shells die with us, as before.
function shutdown() {
  flushBuffers();
  for (const s of sessions.values()) try { s.pty.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
