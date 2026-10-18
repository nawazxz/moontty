// agent-deck: a tiny tmux-like session server with a browser GUI.
// PTYs live here, so closing the window is a "detach"; reopening re-attaches.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { Terminal: Headless } = require('@xterm/headless');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { CrewWatcher } = require('./crew');

const PORT = Number(process.env.DECK_PORT || 7681);
const STATE_DIR = process.env.DECK_STATE || path.join(os.homedir(), '.agent-deck');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const SCROLLBACK = 400 * 1024; // bytes of raw output kept per session for replay
const SHELL = process.env.SHELL || '/bin/zsh';

fs.mkdirSync(STATE_DIR, { recursive: true });

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

function computeStatus(s) {
  if (s.exited) return 'exited';
  if (Date.now() - s.lastOutput < 1500) return 'working';
  if (WAITING.some((re) => re.test(screenText(s)))) return 'waiting';
  return 'idle';
}

// ---------- persistence ----------
function save() {
  const list = [...sessions.values()].map(({ id, name, cwd, cmd }) => ({ id, name, cwd, cmd }));
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
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'agent-deck', SHELL_SESSIONS_DISABLE: '1', PROMPT_EOL_MARK: '', AGENT_DECK_ID: String(s.id) };
}

function spawn(s) {
  const cwd = fs.existsSync(expand(s.cwd)) ? expand(s.cwd) : os.homedir();
  s.pty = pty.spawn(SHELL, ['-l', '-i'], {
    name: 'xterm-256color',
    cols: s.cols || 120,
    rows: s.rows || 32,
    cwd,
    env: paneEnv(s),
  });
  s.screen?.dispose();
  s.screen = new Headless({ cols: s.cols || 120, rows: s.rows || 32, scrollback: 0, allowProposedApi: true });
  s.exited = false;
  s.startedAt = Date.now();
  s.lastOutput = Date.now();
  s.pty.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > SCROLLBACK) s.buffer = s.buffer.slice(-SCROLLBACK);
    s.lastOutput = Date.now();
    s.screen.write(d);
    broadcast({ t: 'out', id: s.id, data: d });
  });
  s.pty.onExit(({ exitCode }) => {
    s.exited = true;
    s.exitCode = exitCode;
    pushStatus(s, true);
  });
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
  s.crewData = null;
  if (cmd) setTimeout(() => s.pty.write(cmd + '\r'), 300);
}

function createSession({ name, cwd, cmd, id }) {
  const s = {
    id: id || nextId++,
    name: name || `agent-${nextId}`,
    cwd: cwd || '~',
    cmd: cmd ?? 'claude',
    buffer: '',
    status: 'idle',
  };
  nextId = Math.max(nextId, s.id + 1);
  sessions.set(s.id, s);
  spawn(s);
  return s;
}

function publicInfo(s) {
  return { id: s.id, name: s.name, cwd: s.cwd, cmd: s.cmd, status: s.status, startedAt: s.startedAt, exitCode: s.exitCode };
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(str);
}

function pushList() {
  broadcast({ t: 'sessions', list: [...sessions.values()].map(publicInfo) });
}

function pushStatus(s, force) {
  const st = computeStatus(s);
  if (st !== s.status || force) {
    const prev = s.status;
    s.status = st;
    broadcast({ t: 'status', id: s.id, status: st, prev, workedMs: Date.now() - (s.workStart || Date.now()) });
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
    } catch (e) { console.error('crew', s.id, e.message); }
  }
}, 1500);

// ---------- http ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const ROUTES = {
  '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  '/vendor/addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const rel = ROUTES[url] || path.join('public', url === '/' ? 'index.html' : url);
  const file = path.join(__dirname, rel);
  if (!file.startsWith(__dirname)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end('not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  // Local-only tool: refuse cross-site pages trying to drive your shells.
  const origin = req.headers.origin || '';
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return ws.close();
  clients.add(ws);
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
        const ns = createSession(m);
        save();
        pushList();
        ws.send(JSON.stringify({ t: 'created', id: ns.id }));
        break;
      }
      case 'input':
        if (s && !s.exited) s.pty.write(m.data);
        break;
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
          if (!s.exited) try { s.pty.kill(); } catch {}
          s.buffer = '\x1b[2J\x1b[H';
          broadcast({ t: 'replay', id: s.id, data: s.buffer });
          spawn(s);
          pushList();
        }
        break;
      case 'kill':
        if (s) {
          if (!s.exited) try { s.pty.kill(); } catch {}
          s.screen.dispose();
          sessions.delete(s.id);
          save();
          pushList();
        }
        break;
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// ---------- boot ----------
for (const def of load()) createSession(def);
server.listen(PORT, '127.0.0.1', () => console.log(`agent-deck on http://localhost:${PORT}`));

function shutdown() {
  for (const s of sessions.values()) if (!s.exited) try { s.pty.kill(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
