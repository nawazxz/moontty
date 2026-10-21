const panes = new Map(); // id -> { info, term, fit, el, crew, lastSize }
const nodes = new Map(); // `${pane}:${agent}` -> crew node element
let ws;
let landed = false;
let current = null;
let zTop = 10;
const seen = new Map(); // `${pane}:${agent}` -> { status, steps }

const $ = (s) => document.querySelector(s);
// Inside Moontty.app the page can talk to the native shell (notifications, dock badge).
const native = (msg) => window.webkit?.messageHandlers?.deck?.postMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LABEL = { working: 'active', waiting: 'needs you', idle: 'standby', exited: 'offline' };
const MOON = 'M15.5 3.2A9 9 0 1 0 20.8 17 7.2 7.2 0 0 1 15.5 3.2Z';

const THEME = {
  background: '#232323', foreground: '#d4d4d4', cursor: '#e3a23a', cursorAccent: '#0b0700', selectionBackground: '#e3a23a40',
  black: '#2e2e2e', red: '#e0606c', green: '#9cc463', yellow: '#e3a23a', blue: '#6eaee0', magenta: '#b398dc', cyan: '#5cc5d6', white: '#bdbdbd',
  brightBlack: '#6e6e6e', brightRed: '#ec8590', brightGreen: '#b5d88a', brightYellow: '#ecc06e', brightBlue: '#94c4ea', brightMagenta: '#c9b3e6', brightCyan: '#8fd8e3', brightWhite: '#e8e8e8',
};

function fmtDur(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '');

// ---------- socket ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  // A restarted server re-attaches shells at their saved size; send ours again so they match what we draw.
  ws.onopen = () => { setConn(true); watchKey = null; for (const p of panes.values()) p.lastSize = ''; };
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'hello') {
      // first contact pins the build; a different one after a reconnect means the server was updated
      if (window.BUILD && window.BUILD !== m.build) return location.reload();
      window.BUILD = m.build;
    } else if (m.t === 'sessions') {
      syncSessions(m.list);
      for (const p of panes.values()) if (!p.lastSize) refit(p);
      // Opening Moontty with nothing running lands you in a shell, once per window.
      if (!landed && !m.list.length) quickShell();
      landed = true;
    }
    else if (m.t === 'out') panes.get(m.id)?.term.write(m.data);
    else if (m.t === 'replay') { const p = panes.get(m.id); if (p) { p.replaying = true; p.term.reset(); p.term.write(m.data, () => { p.replaying = false; }); } }
    else if (m.t === 'status') onStatus(m);
    else if (m.t === 'crew') onCrew(m);
    else if (m.t === 'created') { setTimeout(() => focusMission(m.id), 80); if (m.note) setTimeout(() => panes.get(m.id) && toast(panes.get(m.id), m.note, 'idle'), 400); }
    else if (m.t === 'git') onGit(m);
    else if (m.t === 'history') onHistory(m);
    else if (m.t === 'pr') { const p = panes.get(m.id); if (p) { p.info.pr = m.pr; scheduleRender(m.id); } }
    else if (m.t === 'preview') onPreview(m);
    else if (m.t === 'diff') onDiff(m);
    else if (m.t === 'merged') { const p = panes.get(m.id); if (p) toast(p, m.msg, m.ok ? 'done' : 'waiting'); send({ t: 'diff', id: m.id }); }
  };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));
// Moontty.app drops: native side hands over shell-escaped paths and the drop point.
window.dropPaths = (text, x, y) => {
  const hit = [...panes.entries()].find(([, p]) => p.el.contains(document.elementFromPoint(x, y)));
  const id = hit ? hit[0] : current;
  const p = panes.get(id);
  if (!p) return;
  select(id);
  p.term.paste(text);
};
function setConn(ok) { const c = $('#conn'); c.textContent = ok ? 'LINK OK' : 'NO LINK'; c.className = ok ? 'ok' : ''; }

// ---------- canvas: camera + saved layout ----------
// World units are CSS pixels at zoom 1. screen = world * z + (x, y).
const canvas = $('#canvas');
const world = $('#world');
const saved = (() => { try { return JSON.parse(localStorage.getItem('ns.canvas')) || {}; } catch { return {}; } })();
const W = saved.win || {}; // pane id -> { x, y, w, h }
const C = saved.crew || {}; // `${pane}:${agent}` -> { dx, dy } offset from its mission window
let cam = saved.cam || null;
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { try { localStorage.setItem('ns.canvas', JSON.stringify({ win: W, crew: C, cam })); } catch {} }, 250);
}

function applyCam() {
  if (!cam) return;
  // Whole pixels at 100% keep the terminal text sharp.
  if (cam.z === 1) { cam.x = Math.round(cam.x); cam.y = Math.round(cam.y); }
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  world.style.setProperty('--z', cam.z);
  const g = 24 * cam.z;
  canvas.style.backgroundSize = `${g}px ${g}px`;
  canvas.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
  document.body.classList.toggle('far', cam.z < 0.55);
  $('#zoom').textContent = `${Math.round(cam.z * 100)}%`;
  renderBeacons();
  syncWatch();
  save();
}

// Only terminals you can read get output: on screen and zoomed in far enough to show text.
// The server holds the rest back and replays its buffer when one comes into view.
let watchKey = null;
function syncWatch() {
  if (!cam || ws?.readyState !== 1) return;
  const vw = innerWidth, vh = innerHeight;
  const ids = [];
  if (!document.hidden && cam.z >= 0.55) {
    for (const [id] of panes) {
      const r = W[id];
      if (!r) continue;
      const x0 = r.x * cam.z + cam.x, y0 = r.y * cam.z + cam.y;
      if (x0 + r.w * cam.z > 0 && x0 < vw && y0 + r.h * cam.z > 0 && y0 < vh) ids.push(id);
    }
  }
  const key = ids.join(',');
  if (key === watchKey) return;
  watchKey = key;
  send({ t: 'watch', ids });
}
document.addEventListener('visibilitychange', syncWatch);
const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });

let flight = 0;
function flyTo(target, ms = 280) {
  const from = { ...cam };
  const t0 = performance.now();
  const id = ++flight;
  const step = (now) => {
    if (id !== flight) return;
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    cam = k === 1 ? { ...target } : { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
    applyCam();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function zoomTo(sx, sy, z) {
  flight++;
  z = Math.max(0.12, Math.min(1.6, z));
  const w = toWorld(sx, sy);
  cam = { z, x: sx - w.x * z, y: sy - w.y * z };
  applyCam();
}
// Camera that fits a world rect on screen, never zooming past maxZ.
function frame(b, maxZ = 1) {
  const pad = 56, vw = innerWidth, vh = innerHeight - 40;
  const z = Math.max(0.12, Math.min(maxZ, (vw - pad * 2) / b.w, (vh - pad * 2) / b.h));
  return { z, x: (vw - b.w * z) / 2 - b.x * z, y: 40 + (vh - b.h * z) / 2 - b.y * z };
}
function bounds(ids, withCrew = true) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, w, h) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h); };
  for (const id of ids) {
    const r = W[id];
    if (!r) continue;
    add(r.x, r.y, r.w, r.h);
    const pp = panes.get(Number(id));
    if (pp?.prevEl) add(r.x, r.y - PREV_H - DIFF_GAP, r.w, PREV_H);
    if (pp?.diffEl) add(r.x, r.y + r.h + DIFF_GAP, r.w, 440);
    if (withCrew) for (const [k, n] of nodes) if (k.startsWith(`${id}:`)) { const q = nodePos(k); add(q.x, q.y, n.offsetWidth, n.offsetHeight); }
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Fly to a mission at 100% (sharp, clickable terminal), with its crew if they fit.
function focusMission(id) {
  if (!panes.has(id)) return;
  select(id);
  let f = frame(bounds([id]), 1);
  if (f.z < 1) {
    // Crew don't fit at 100%: pin the window to the left edge so as much crew as possible shows.
    const r = W[id];
    f = frame(r, 1);
    if (f.z === 1 && nodes.size) f.x = 56 - r.x;
  }
  flyTo(f);
}
function overview() { const b = bounds([...panes.keys()]); if (b) flyTo(frame(b, 1)); }

// xterm finds the cell under the mouse from screen pixels but divides by unzoomed cell sizes,
// so on a zoomed canvas clicks and selections land rows away. Re-aim mouse events over a
// terminal as if the canvas were at 100%: swallow the real event, send a corrected copy.
const aimed = new WeakSet();
let aimTerm = null; // the terminal a press started in, which keeps getting moves while dragging out of it
for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
  window.addEventListener(type, (e) => {
    if (aimed.has(e) || !cam) return;
    const xt = (type === 'mousedown' ? null : aimTerm) || e.target.closest?.('.win .xterm');
    if (type === 'mousedown') aimTerm = xt;
    if (type === 'mouseup') aimTerm = null;
    if (!xt || cam.z === 1) return;
    const r = xt.querySelector('.xterm-screen').getBoundingClientRect();
    const ev = new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window, detail: e.detail,
      clientX: r.left + (e.clientX - r.left) / cam.z, clientY: r.top + (e.clientY - r.top) / cam.z,
      screenX: e.screenX, screenY: e.screenY, button: e.button, buttons: e.buttons, relatedTarget: e.relatedTarget,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
    });
    aimed.add(ev);
    e.stopImmediatePropagation();
    if (type === 'contextmenu') e.preventDefault();
    e.target.dispatchEvent(ev);
  }, true);
}

// pan: drag the empty canvas, two-finger scroll outside a terminal, sideways scroll or ⌘-scroll anywhere
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || (e.target !== canvas && e.target !== world)) return;
  flight++;
  const sx = e.clientX - cam.x, sy = e.clientY - cam.y;
  canvas.classList.add('panning');
  document.body.classList.add('dragging');
  const mv = (ev) => { cam.x = ev.clientX - sx; cam.y = ev.clientY - sy; applyCam(); };
  const up = () => { canvas.classList.remove('panning'); document.body.classList.remove('dragging'); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
});
canvas.addEventListener('dblclick', (e) => { if (e.target === canvas || e.target === world) overview(); });
// Capture phase: xterm cancels wheel events it sees, so the canvas has to decide first.
// Over a terminal, up/down scrolls its history and a sideways swipe pans; ⌘ makes any scroll pan.
canvas.addEventListener('wheel', (e) => {
  if (!cam) return;
  if (e.ctrlKey) { e.preventDefault(); e.stopPropagation(); zoomTo(e.clientX, e.clientY, cam.z * Math.exp(-e.deltaY * 0.01)); return; }
  const inner = e.target.closest('.term, .node.open .log, .diffp .dx, .diffp .files, .prevp');
  const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY) && !inner?.matches('.diffp .dx'); // long diff lines scroll sideways
  if (inner && !e.metaKey && !sideways && !(cam.z < 0.55 && inner.matches('.term'))) return;
  e.preventDefault();
  e.stopPropagation();
  flight++;
  cam.x -= e.deltaX;
  cam.y -= e.deltaY;
  applyCam();
}, { passive: false, capture: true });
// Safari/WKWebView pinch arrives as gesture events rather than ctrl+wheel.
let pinchZ = 1;
canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); pinchZ = cam.z; });
canvas.addEventListener('gesturechange', (e) => { e.preventDefault(); zoomTo(e.clientX, e.clientY, pinchZ * e.scale); });

// Drag helper in world units; under 4 screen px counts as a click.
function drag(e, move, end) {
  e.preventDefault();
  flight++;
  const sx = e.clientX, sy = e.clientY;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return;
    moved = true;
    move((ev.clientX - sx) / cam.z, (ev.clientY - sy) / cam.z);
  };
  document.body.classList.add('dragging'); // iframes would swallow the pointer otherwise
  const up = () => { document.body.classList.remove('dragging'); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); end?.(moved); };
  addEventListener('pointermove', mv);
  addEventListener('pointerup', up);
}

// ---------- missions (floating terminals) ----------
function syncSessions(infos) {
  const ids = new Set(infos.map((i) => i.id));
  for (const [id, p] of panes) if (!ids.has(id)) { p.term.dispose(); p.el.remove(); p.diffEl?.remove(); p.prevEl?.remove(); panes.delete(id); }
  for (const k of Object.keys(W)) if (!ids.has(Number(k))) delete W[k];
  for (const k of Object.keys(C)) if (!ids.has(Number(k.split(':')[0]))) delete C[k];
  for (const [k, n] of nodes) if (!ids.has(Number(k.split(':')[0]))) { n.remove(); nodes.delete(k); }
  for (const info of infos) {
    const p = panes.get(info.id);
    if (p) p.info = { ...p.info, ...info };
    else addPane(info);
  }
  if (!panes.has(current)) current = panes.keys().next().value ?? null;
  if (!cam) {
    const b = bounds([...panes.keys()]);
    cam = b ? frame(b, 1) : { x: innerWidth / 2, y: innerHeight / 2, z: 1 };
  }
  applyCam();
  render();
  drawWires();
}

function placeNew(info) {
  // a companion shell docks to the left of its mission
  const pr = info?.parent && W[info.parent];
  if (pr) {
    const sibs = [...panes.values()].filter((q) => q.info.parent === info.parent && q.info.id !== info.id).length;
    return { x: pr.x - 600 - sibs * 24, y: pr.y + sibs * 24, w: 560, h: pr.h };
  }
  const rs = Object.values(W);
  if (!rs.length) return { x: 0, y: 0, w: 920, h: 580 };
  // to the right of everything, leaving room for the crew column
  return { x: Math.max(...rs.map((r) => r.x + r.w)) + 440, y: Math.min(...rs.map((r) => r.y)), w: 920, h: 580 };
}

function addPane(info) {
  const el = document.createElement('div');
  el.className = 'win';
  el.innerHTML = `
    <div class="bar"><span class="lights"><button data-a="kill" class="tl r" title="End mission (⌥-click restarts it)"></button><button data-a="min" class="tl y" title="Fold down to the title bar"></button><button data-a="max" class="tl g" title="Fill the screen"></button></span><span class="led"></span><b class="nm"></b>
      <span class="who"><svg class="moon" viewBox="0 0 24 24"><path d="${MOON}"/></svg>ZERO</span>
      <span class="meta"></span><span class="gitb"></span><span class="ports"></span><span class="now"></span>
      <span class="acts"><button data-a="shell" title="Open a plain shell beside this mission">+ shell</button><button data-a="preview" title="Browser preview beside this mission">preview</button><button data-a="diff">changes</button><button data-a="rename">rename</button><button data-a="pr" hidden>open pr</button><button data-a="merge" hidden>merge</button><button data-a="restart" hidden>restart</button></span></div>
    <div class="term"></div>
    <div class="big"><span class="led"></span><b></b><span class="bn"></span></div>
    <i class="grip"></i>`;
  world.appendChild(el);
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace', fontSize: 12.5, lineHeight: 1.2,
    cursorBlink: true, allowTransparency: false, smoothScrollDuration: 0, fastScrollSensitivity: 5, allowProposedApi: true, scrollback: 10000, theme: THEME, macOptionIsMeta: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const search = window.SearchAddon ? new SearchAddon.SearchAddon() : null;
  if (search) term.loadAddon(search);
  // ⌘-click opens a link, like Terminal.app (plain clicks stay text selection)
  if (window.WebLinksAddon) term.loadAddon(new WebLinksAddon.WebLinksAddon((e, url) => { if (e.metaKey) send({ t: 'open', url }); }));
  term.open(el.querySelector('.term'));
  loadGpu(term);
  // A replay re-runs old output, and xterm would answer its old queries (focus, device id) into the agent as keystrokes.
  term.onData((data) => { if (!panes.get(info.id)?.replaying) send({ t: 'input', id: info.id, data }); });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyK') { term.clear(); return false; }
    const seq = MAC_KEYS[`${e.metaKey ? 'cmd+' : ''}${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.key}`];
    if (!seq) return true;
    e.preventDefault();
    send({ t: 'input', id: info.id, data: seq });
    return false;
  });
  const p = { info, term, fit, el, search, crew: null, lastSize: '' };
  panes.set(info.id, p);
  if (!W[info.id]) { W[info.id] = placeNew(info); save(); }
  if (info.parent) el.classList.add('aux');
  place(p);

  const id = info.id;
  const bar = el.querySelector('.bar');
  bar.addEventListener('pointerdown', (e) => {
    if (e.button || e.target.closest('button') || e.target.isContentEditable) return;
    select(id);
    const r = W[id], ox = r.x, oy = r.y;
    drag(e, (dx, dy) => { r.x = Math.round(ox + dx); r.y = Math.round(oy + dy); place(p); }, save);
  });
  bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button, .nm')) focusMission(id); });
  const nm = bar.querySelector('.nm');
  nm.title = 'Double-click to rename';
  nm.addEventListener('dblclick', (e) => { e.stopPropagation(); rename(p); });
  bar.onclick = (e) => {
    let a = e.target.closest('.acts button, .lights button')?.dataset.a;
    if (a === 'kill' && e.altKey) a = 'restart';
    if (a === 'rename') rename(p);
    if (a === 'restart') send({ t: 'restart', id });
    if (a === 'min') fold(p);
    if (a === 'max') maximize(p);
    if (a === 'diff') toggleDiff(p);
    if (a === 'shell') send({ t: 'create', name: `${p.info.name} shell`, cwd: p.info.cwd, cmd: '', parent: id });
    if (a === 'preview') togglePreview(p);
    if (a === 'pr') {
      const wt = p.info.worktree;
      if (confirm(`Push ${wt.branch} to origin and open a pull request into ${wt.base}?\n\nTitle and body come from the commits (gh pr create --fill).`)) send({ t: 'pr', id });
    }
    if (a === 'merge') {
      const wt = p.info.worktree;
      if (confirm(`Merge ${wt.branch} into ${wt.base}?\n\nThis runs in ${wt.root}. Conflicts are never auto-resolved: the merge is undone and you get a message.`)) send({ t: 'merge', id });
    }
    const kids = [...panes.values()].filter((q) => q.info.parent === id);
    if (a === 'kill' && confirm(`End mission ${p.info.name}? ZERO and its crew will be stood down.${kids.length ? `\n\nIts ${kids.length} docked shell(s) end too.` : ''}`)) {
      for (const k of kids) send({ t: 'kill', id: k.info.id });
      const wt = p.info.worktree;
      const dropBranch = !!wt && confirm(`Also delete branch ${wt.branch} and its folder?\n\n${wt.top}\n\nUnmerged work on it is lost. Cancel keeps both.`);
      send({ t: 'kill', id, dropBranch });
    }
  };
  // port: preview it beside the mission (⌘-click opens your browser instead)
  bar.querySelector('.ports').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const port = Number(b.dataset.port);
    const host = panes.get(p.info.parent) || p;
    if (e.metaKey) send({ t: 'open', port });
    else openPreview(host, `http://localhost:${port}/`);
  };
  bar.querySelector('.gitb').onclick = (e) => { const a = e.target.closest('[data-url]'); if (a) send({ t: 'open', url: a.dataset.url }); };
  el.querySelector('.grip').addEventListener('pointerdown', (e) => {
    const r = W[id], ow = r.w, oh = r.h;
    drag(e, (dx, dy) => { r.w = Math.max(420, Math.round(ow + dx)); r.h = Math.max(240, Math.round(oh + dy)); place(p); }, save);
  });
  el.querySelector('.big').onclick = () => focusMission(id);
  el.addEventListener('pointerdown', () => { if (current !== id) select(id, false); }, true);
  new ResizeObserver(() => refit(p)).observe(el.querySelector('.term'));
}

// Rename in place on the title bar: Enter or clicking away saves, Esc cancels.
function rename(p) {
  const nm = p.el.querySelector('.nm');
  if (nm.isContentEditable) return;
  select(p.info.id, false);
  nm.contentEditable = 'true';
  nm.spellcheck = false;
  nm.focus();
  getSelection().selectAllChildren(nm);
  const done = (keep) => {
    nm.removeEventListener('keydown', key);
    nm.removeEventListener('blur', blur);
    nm.contentEditable = 'false';
    const v = nm.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (keep && v && v !== p.info.name) { p.info.name = v; send({ t: 'rename', id: p.info.id, name: v }); }
    nm.textContent = p.info.name;
    scheduleRender(p.info.id);
  };
  const key = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); done(true); p.term.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); p.term.focus(); }
  };
  const blur = () => done(true);
  nm.addEventListener('keydown', key);
  nm.addEventListener('blur', blur);
}

// Keys as a native Mac terminal sends them, so Claude Code's shortcuts work as in iTerm or Ghostty:
// ⇧↵ is a new line, ⌘←/→ jump to line start/end, ⌘⌫ clears the line, ⌥←/→/⌫ move and delete by word.
const MAC_KEYS = {
  'shift+Enter': '\x1b\r',
  'cmd+ArrowLeft': '\x01', 'cmd+ArrowRight': '\x05', 'cmd+Backspace': '\x15',
  'alt+ArrowLeft': '\x1bb', 'alt+ArrowRight': '\x1bf', 'alt+Backspace': '\x1b\x7f',
};

function place(p) {
  const r = W[p.info.id];
  p.el.classList.toggle('min', !!r.min);
  Object.assign(p.el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: r.min ? '' : `${r.h}px` });
  if (p.diffEl) Object.assign(p.diffEl.style, { left: `${r.x}px`, top: `${r.y + r.h + DIFF_GAP}px`, width: `${r.w}px` });
  if (p.prevEl) Object.assign(p.prevEl.style, { left: `${r.x}px`, top: `${r.y - PREV_H - DIFF_GAP}px`, width: `${r.w}px`, height: `${PREV_H}px` });
  for (const q of panes.values()) if (q.info.parent === p.info.id) drawWires();
  placeCrew(p.info.id);
  renderBeacons();
  syncWatch();
}

// Yellow light: fold the window down to its title bar (the shell keeps running at its size).
function fold(p) {
  const r = W[p.info.id];
  r.min = !r.min;
  place(p);
  save();
  if (!r.min) select(p.info.id);
}
// Green light: grow the window to fill the screen at 100%; again puts it back.
function maximize(p) {
  const r = W[p.info.id];
  r.min = false;
  if (r.prev) { Object.assign(r, r.prev); delete r.prev; place(p); save(); return focusMission(p.info.id); }
  r.prev = { x: r.x, y: r.y, w: r.w, h: r.h };
  r.w = Math.max(420, innerWidth - 48);
  r.h = Math.max(240, innerHeight - 64 - 24);
  place(p);
  save();
  select(p.info.id);
  flyTo({ z: 1, x: 24 - r.x, y: 64 - r.y });
}

// Draw on the GPU like a native terminal; fall back to the DOM renderer if WebGL dies.
function loadGpu(term) {
  if (!window.WebglAddon || location.search.includes('nogl')) return;
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => { gl.dispose(); setTimeout(() => loadGpu(term), 500); });
    term.loadAddon(gl);
  } catch (e) { console.warn('webgl off', e); }
}

function refit(p) {
  if (W[p.info.id]?.min) return; // folded: keep the shell at its last real size
  try { p.fit.fit(); } catch { return; }
  const size = `${p.term.cols}x${p.term.rows}`;
  if (size !== p.lastSize) { p.lastSize = size; send({ t: 'resize', id: p.info.id, cols: p.term.cols, rows: p.term.rows }); }
}

function select(id, focusTerm = true) {
  const p = panes.get(id);
  if (!p) return;
  current = id;
  p.el.style.zIndex = ++zTop;
  scheduleRender();
  if (focusTerm) requestAnimationFrame(() => p.term.focus());
}

// ---------- rendering ----------
// Writes only when the markup changed, so a quiet pane costs no DOM work.
function setHTML(el, html) { if (el._h !== html) { el._h = html; el.innerHTML = html; } }

function render(only) {
  $('#empty').hidden = panes.size > 0;
  for (const [id, p] of panes) {
    if (only && !only.has(id)) continue;
    const st = p.info.status || 'idle';
    const main = p.crew?.main;
    const crew = p.crew?.crew || [];
    const run = crew.filter((a) => a.status === 'running').length;
    const now = st === 'working' && main?.now ? main.now : LABEL[st];
    p.el.classList.toggle('on', id === current);
    p.el.classList.toggle('waiting', st === 'waiting');
    p.el.querySelectorAll('.led').forEach((l) => (l.className = `led ${st}`));
    if (!p.el.querySelector('.nm').isContentEditable) p.el.querySelector('.nm').textContent = p.info.name;
    p.el.querySelector('.big b').textContent = p.info.name;
    p.el.querySelector('.who').style.display = main ? '' : 'none';
    p.el.querySelector('.meta').textContent = main
      ? `${fmtModel(main.model)} · ${main.tools} ops · ctx ${fmtK(main.ctx)}${crew.length ? ` · crew ${run}/${crew.length}` : ''}${spendText(p)}`
      : p.info.cmd || 'shell';
    p.el.querySelector('.meta').title = main ? spendTitle(p) : '';
    const g = p.info.git;
    const wt = p.info.worktree;
    setHTML(p.el.querySelector('.gitb'), g
      ? `<span class="br${wt ? ' own' : ''}">${esc(g.branch || 'detached')}</span>${g.dirty ? `<span class="dt">${g.dirty} changed</span>` : ''}${g.ahead ? `<span class="ah">${g.ahead} ahead</span>` : ''}${prChip(p.info.pr)}`
      : '');
    p.el.querySelector('[data-a=pr]').hidden = !(wt && g?.ahead && !p.info.pr);
    p.el.querySelector('[data-a=shell]').hidden = !!p.info.parent;
    p.el.querySelector('[data-a=preview]').hidden = !!p.info.parent;
    p.el.querySelector('[data-a=preview]').classList.toggle('on', !!p.prevEl);
    setHTML(p.el.querySelector('.ports'), (p.info.ports || []).map((n) => `<button data-port="${n}" title="Open localhost:${n}">:${n}</button>`).join(''));
    p.el.querySelector('[data-a=merge]').hidden = !wt;
    p.el.querySelector('[data-a=restart]').hidden = st !== 'exited';
    p.el.querySelector('[data-a=diff]').hidden = !g;
    p.el.querySelector('[data-a=diff]').classList.toggle('on', !!p.diffEl);
    p.el.querySelector('.now').textContent = st === 'waiting' && p.waitMsg ? p.waitMsg : now;
    p.el.querySelector('.now').title = p.info.cwd;
    p.el.querySelector('.big .bn').textContent = now;
    renderCrew(p);
  }
  drawWires();
  renderStats();
  renderBeacons();
}

function renderStats() {
  let working = 0, waiting = 0, crewRun = 0;
  for (const p of panes.values()) {
    if (p.info.status === 'working') working++;
    if (p.info.status === 'waiting') waiting++;
    crewRun += (p.crew?.crew || []).filter((a) => a.status === 'running').length;
  }
  setHTML($('#stats'), panes.size ? `
    ${waiting ? `<span class="w"><b>${waiting}</b> need you</span>` : ''}
    <span><b>${working}</b>/${panes.size} on shift</span>
    <span><b>${crewRun}</b> crew out</span>` : '');
  document.title = waiting ? `(${waiting}) MOONTTY` : 'MOONTTY';
  native({ kind: 'badge', count: waiting });
}

// Missions that are off screen get a marker on the nearest edge, pointing at them.
function renderBeacons() {
  if (!cam) return;
  const vw = innerWidth, vh = innerHeight;
  let out = '';
  for (const [id, p] of panes) {
    const r = W[id];
    if (!r) continue;
    const x0 = r.x * cam.z + cam.x, y0 = r.y * cam.z + cam.y, x1 = x0 + r.w * cam.z, y1 = y0 + r.h * cam.z;
    if (x1 > 30 && x0 < vw - 30 && y1 > 50 && y0 < vh - 30) continue;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const bx = Math.max(90, Math.min(vw - 90, cx)), by = Math.max(56, Math.min(vh - 24, cy));
    const ang = Math.atan2(cy - vh / 2, cx - vw / 2);
    const arr = '→↘↓↙←↖↑↗'[(Math.round(ang / (Math.PI / 4)) + 8) % 8];
    const st = p.info.status || 'idle';
    out += `<button class="beacon ${st}" data-id="${id}" style="left:${bx}px;top:${by}px"><span class="led ${st}"></span>${esc(p.info.name)}<span class="arr">${arr}</span></button>`;
  }
  setHTML($('#beacons'), out);
}
$('#beacons').onclick = (e) => { const b = e.target.closest('.beacon'); if (b) focusMission(Number(b.dataset.id)); };

// ---------- identity: call signs, roles, insignia ----------
const ROLE = { 'general-purpose': 'operator', Explore: 'recon', Plan: 'strategist', 'claude-code-guide': 'intel', 'statusline-setup': 'tech' };
const CODENAMES = ['Blackout', 'Nightfall', 'Redline', 'Afterhours', 'Static', 'Lowlight', 'Graveyard', 'Overdrive', 'Midnight', 'Neon', 'Undertow', 'Eclipse', 'Deadlight', 'Lights Out', 'Insomnia', 'Moonrise'];
const hash = (s) => [...String(s)].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381);
const role = (a) => ROLE[a.type] || a.type || 'operator';
const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n || 0));
const fmtModel = (m) => (m || 'claude').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-(\d+)$/, ' $1').toUpperCase();
const unitNo = (n) => `U-${String(n).padStart(2, '0')}`;

// Unit insignia: a mirrored 5x5 pixel patch drawn from the call sign.
function insignia(call, size = 36) {
  let h = hash(call + 'ns');
  const cells = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      h = (h * 1103515245 + 12345) >>> 0;
      if ((h >> 16) % 100 < 52) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  }
  const px = cells.map(([x, y]) => `<rect x="${3 + x * 6}" y="${3 + y * 6}" width="6" height="6"/>`).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 36 36">
    <rect x=".5" y=".5" width="35" height="35" fill="#232323" stroke="#484848"/><g fill="#c4c4c4">${px}</g></svg>`;
}

// ---------- crew nodes ----------
const NODE_W = 290, NODE_H = 136, OPEN_H = 440, GAP = 14, COL = NODE_W + 70;
// Default spots surround the mission: ZERO's team is split between its left and right sides
// (balanced by how tall each member's subtree is), each side centred on the mission, and every
// member's own subagents grow outward beside it. Heights are real, so an expanded node pushes
// its subtree down. Dragged nodes keep their spot.
const treeCache = new Map(); // pid -> Map(key -> { dx, dy })
function crewTree(pid) {
  if (treeCache.has(pid)) return treeCache.get(pid);
  const r = W[pid];
  const out = new Map();
  const list = panes.get(Number(pid))?.crew?.crew || [];
  const kids = new Map();
  for (const a of list) {
    const k = a.parent || '';
    if (!kids.has(k)) kids.set(k, []);
    kids.get(k).push(a);
  }
  const h = (a) => nodes.get(`${pid}:${a.id}`)?.offsetHeight || NODE_H;
  const span = (a) => {
    const c = kids.get(a.id) || [];
    const cs = c.reduce((t, b) => t + span(b), 0) + GAP * Math.max(0, c.length - 1);
    return Math.max(h(a), cs);
  };
  const lay = (a, x, y, dir) => {
    out.set(`${pid}:${a.id}`, { dx: x, dy: y });
    let cy = y;
    for (const b of kids.get(a.id) || []) { lay(b, x + dir * COL, cy, dir); cy += span(b) + GAP; }
  };
  // split the team, keeping spawn order on each side
  const sides = { 1: [], '-1': [] }, tall = { 1: 0, '-1': 0 };
  for (const a of kids.get('') || []) {
    const d = tall[1] <= tall[-1] ? 1 : -1;
    sides[d].push(a);
    tall[d] += span(a) + GAP;
  }
  // the left side clears any shells docked there
  const docked = [...panes.values()].filter((q) => q.info.parent === Number(pid) && W[q.info.id]).map((q) => W[q.info.id].x - r.x);
  const leftEdge = Math.min(0, ...docked);
  for (const d of [1, -1]) {
    let y = r.h / 2 - (tall[d] - GAP) / 2;
    const x = d === 1 ? r.w + 120 : leftEdge - 120 - NODE_W;
    for (const a of sides[d]) { lay(a, x, y, d); y += span(a) + GAP; }
  }
  treeCache.set(pid, out);
  return out;
}
function nodePos(key) {
  const pid = key.split(':')[0];
  const r = W[pid];
  const o = C[key] || crewTree(pid).get(key) || { dx: r.w + 120, dy: 0 };
  return { x: r.x + o.dx, y: r.y + o.dy };
}

function renderCrew(p) {
  const id = p.info.id;
  const live = new Set();
  const calls = new Map((p.crew?.crew || []).map((a) => [a.id, a.call]));
  for (const a of p.crew?.crew || []) a.parentCall = a.parent ? calls.get(a.parent) : '';
  (p.crew?.crew || []).forEach((a, i) => {
    const key = `${id}:${a.id}`;
    live.add(key);
    let n = nodes.get(key);
    if (!n) { n = makeNode(key, id); nodes.set(key, n); }
    n.dataset.i = i;
    n.className = `node ${a.status}${n.classList.contains('open') ? ' open' : ''}`;
    fill(n, a);
  });
  for (const [k, n] of nodes) if (k.startsWith(`${id}:`) && !live.has(k)) { n.remove(); nodes.delete(k); }
  placeCrew(id, false);
}

function makeNode(key, pid) {
  const n = document.createElement('div');
  n.innerHTML = `<div class="hd"><span class="ins"></span><b class="cs"></b><span class="rl"></span><span class="t"></span><span class="led"></span></div><div class="tk"></div><div class="log"></div>
    <form class="say"><textarea spellcheck="false" rows="2"></textarea><button title="Send (Enter). Shift-Enter for a new line">send</button></form>`;
  n._sent = [];
  world.appendChild(n);
  // a closed card opens on any click; the header toggles it (and drags it)
  n.addEventListener('click', (e) => {
    if (n.classList.contains('open') || e.target.closest('.hd') || getSelection().toString()) return;
    toggleNode(n, pid);
  });
  const say = n.querySelector('.say'), box = say.querySelector('textarea');
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); say.requestSubmit(); }
    if (e.key === 'Escape') { box.blur(); toggleNode(n, pid); }
  });
  say.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text || !n._a) return;
    brief(pid, n._a, text);
    n._sent.push({ t: Date.now(), d: text });
    box.value = '';
    n._key = '';
    fill(n, n._a);
    const log = n.querySelector('.log');
    log.scrollTop = log.scrollHeight;
  });
  n.querySelector('.hd').addEventListener('pointerdown', (e) => {
    if (e.button) return;
    n.style.zIndex = ++zTop;
    const o = { ...(C[key] || crewTree(pid).get(key) || { dx: 0, dy: 0 }) };
    drag(e, (dx, dy) => { C[key] = { dx: Math.round(o.dx + dx), dy: Math.round(o.dy + dy) }; placeCrew(pid); }, (moved) => {
      if (moved) return save();
      toggleNode(n, pid);
    });
  });
  return n;
}

// Open: the full orders, every step, the report, and a box to brief the agent.
function toggleNode(n, pid) {
  n.classList.toggle('open');
  n.style.zIndex = ++zTop;
  fill(n, n._a);
  placeCrew(pid);
  if (n.classList.contains('open')) {
    const box = n.querySelector('.say textarea');
    box.placeholder = n._a?.status === 'running' ? `Tell ${n._a.call} what to do next…` : `Send ${n._a?.call || 'it'} back out with a new task…`;
    requestAnimationFrame(() => box.focus({ preventScroll: true }));
  }
}

// Subagents have no keyboard of their own; only their lead can reach them (SendMessage).
// So the note is typed into the lead's prompt, addressed by agent id. A busy lead queues it.
function brief(pid, a, text) {
  const msg = `[Moontty] Message from me for your subagent ${a.call} ("${a.name}", agentId ${a.id}). `
    + `Pass it on with SendMessage${a.status === 'running' ? '' : ' (it has finished, so this resumes it)'}, word for word:\n\n${text}`;
  send({ t: 'input', id: Number(pid), data: `\x1b[200~${msg}\x1b[201~` });
  setTimeout(() => send({ t: 'input', id: Number(pid), data: '\r' }), 120);
}

function fill(n, a) {
  n._a = a;
  const open = n.classList.contains('open');
  const key = `${a.call}|${a.status}|${a.steps.length}|${a.lastAt}|${a.report.length}|${a.parentCall}|${a.name}|${open}|${n._sent.length}`;
  if (n._key === key) return;
  n._key = key;
  const hd = n.querySelector('.hd');
  if (n.dataset.call !== a.call) {
    n.dataset.call = a.call;
    hd.querySelector('.ins').innerHTML = insignia(a.call, 20);
    hd.querySelector('.cs').textContent = a.call;
  }
  hd.querySelector('.rl').textContent = `${unitNo(a.unit)} · ${role(a)}${a.parentCall ? ` · from ${a.parentCall}` : ''}`;
  const t = hd.querySelector('.t');
  t.dataset.since = a.status === 'running' ? a.startedAt : '';
  t.textContent = `T+${fmtDur((a.status === 'running' ? Date.now() : a.lastAt) - a.startedAt)}`;
  hd.querySelector('.led').className = `led ${a.status}`;
  const tk = n.querySelector('.tk');
  tk.textContent = a.name;
  tk.title = a.prompt || a.name;
  const log = n.querySelector('.log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
  const steps = open ? a.steps : a.steps.slice(-6);
  log.innerHTML = (open && a.prompt ? `<div class="ln orders">${esc(a.prompt)}</div>` : '')
    + steps.map((s) => `<div class="ln ${s.k}${s.err ? ' err' : ''}"><span class="tm">${fmtTime(s.t)}</span>${s.k === 'tool' ? `<span class="tn">${esc(s.name)}</span>` : ''}${esc(s.d)}</div>`).join('')
    + (a.report ? `<div class="ln report">${esc(open ? a.report : a.report.split('\n')[0])}</div>` : '')
    + (open ? n._sent.map((s) => `<div class="ln you"><span class="tm">${fmtTime(s.t)}</span>you → ${esc(s.d)}</div>`).join('') : '');
  if (open && atBottom && a.status === 'running') log.scrollTop = log.scrollHeight;
}

function placeCrew(pid, wires = true) {
  if (!W[pid]) return;
  treeCache.delete(String(pid));
  for (const [k, n] of nodes) {
    if (!k.startsWith(`${pid}:`)) continue;
    const q = nodePos(k);
    n.style.left = `${q.x}px`;
    n.style.top = `${q.y}px`;
  }
  if (wires) drawWires();
}

// Wires fan out from a port on the mission's title bar to each crew node's header.
function drawWires() {
  let out = '';
  const ports = new Set();
  for (const [k, n] of nodes) {
    const pid = k.split(':')[0];
    const r = W[pid];
    if (!r) continue;
    const q = nodePos(k);
    const st0 = n._a?.status || '';
    const par = n._a?.parent && nodes.get(`${pid}:${n._a.parent}`);
    if (par) {
      // subagent of a crew member: wire from its parent's header
      const pq = nodePos(`${pid}:${n._a.parent}`);
      const out_ = q.x >= pq.x ? 1 : -1; // children grow away from the mission
      const x1 = out_ === 1 ? pq.x + par.offsetWidth : pq.x, y1 = pq.y + 16, x2 = out_ === 1 ? q.x : q.x + n.offsetWidth, y2 = q.y + 16;
      const c = Math.max(30, Math.abs(x2 - x1) * 0.5) * out_;
      out += `<path class="wire ${st0}" d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}"/><circle class="port src" cx="${x1}" cy="${y1}" r="3"/><circle class="port ${st0}" cx="${x2}" cy="${y2}" r="3"/>`;
      continue;
    }
    const right = q.x + n.offsetWidth / 2 >= r.x + r.w / 2;
    const x1 = right ? r.x + r.w : r.x, y1 = r.y + 15;
    const x2 = right ? q.x : q.x + n.offsetWidth, y2 = q.y + 16;
    const c = Math.max(50, Math.abs(x2 - x1) * 0.5) * (right ? 1 : -1);
    const st = n._a?.status || '';
    out += `<path class="wire ${st}" d="M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}"/><circle class="port ${st}" cx="${x2}" cy="${y2}" r="3"/>`;
    ports.add(`${x1},${y1}`);
  }
  for (const pt of ports) { const [x, y] = pt.split(','); out += `<circle class="port src" cx="${x}" cy="${y}" r="4"/>`; }
  // docked shells hang off the mission's left edge; the preview sits on top
  for (const [id, p] of panes) {
    const r = W[id], pr = W[p.info.parent];
    if (r && pr) {
      const x1 = pr.x, y1 = pr.y + 15, x2 = r.x + r.w, y2 = r.y + 15, c = Math.max(30, (x1 - x2) * 0.5);
      out += `<path class="wire" d="M${x1},${y1} C${x1 - c},${y1} ${x2 + c},${y2} ${x2},${y2}"/><circle class="port src" cx="${x1}" cy="${y1}" r="3"/><circle class="port" cx="${x2}" cy="${y2}" r="3"/>`;
    }
    if (r && p.prevEl) {
      const x = r.x + 40, y1 = r.y, y2 = r.y - DIFF_GAP;
      out += `<path class="wire" d="M${x},${y1} L${x},${y2}"/><circle class="port src" cx="${x}" cy="${y1}" r="3"/><circle class="port" cx="${x}" cy="${y2}" r="3"/>`;
    }
  }
  // changes panel hangs straight below its mission
  for (const [id, p] of panes) {
    const r = W[id];
    if (!p.diffEl || !r) continue;
    const x = r.x + 40, y1 = r.y + r.h, y2 = y1 + DIFF_GAP;
    out += `<path class="wire" d="M${x},${y1} L${x},${y2}"/><circle class="port src" cx="${x}" cy="${y1}" r="3"/><circle class="port" cx="${x}" cy="${y2}" r="3"/>`;
  }
  setHTML($('#wires'), out);
}

// ---------- live events ----------
function onStatus(m) {
  const p = panes.get(m.id);
  if (!p) return;
  p.info.status = m.status;
  p.waitMsg = m.msg || '';
  scheduleRender(m.id);
  if (m.status === 'waiting') toast(p, m.msg || 'needs your input', 'waiting');
  else if (m.status === 'idle' && m.prev === 'working' && m.workedMs > 8000) { toast(p, 'is done', 'idle'); chime(); }
}

function onCrew(m) {
  const p = panes.get(m.id);
  if (!p) return;
  p.crew = m;
  for (const a of m.crew) {
    const key = `${m.id}:${a.id}`;
    const prev = seen.get(key);
    if (prev && prev.status === 'running' && a.status === 'done') toast(p, `${a.call} returned · ${a.name}`, 'done', a.call);
    seen.set(key, { status: a.status, steps: a.steps.length });
  }
  scheduleRender(m.id);
}

// ---------- spend: tokens and an API-rate cost estimate for the lead + its crew ----------
function spend(p) {
  const t = { in: 0, out: 0, cw: 0, cr: 0, usd: 0 };
  for (const a of [p.crew?.main, ...(p.crew?.crew || [])]) if (a?.spent) for (const k in t) t[k] += a.spent[k];
  return t;
}
const fmtUsd = (n) => (n < 0.01 ? '<$0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
function spendText(p) { const t = spend(p); return t.usd ? ` · ≈${fmtUsd(t.usd)}` : ''; }
function spendTitle(p) {
  const t = spend(p);
  return `Tokens (lead + crew)\ninput ${fmtK(t.in)} · output ${fmtK(t.out)}\ncache write ${fmtK(t.cw)} · cache read ${fmtK(t.cr)}\n≈${fmtUsd(t.usd)} at API rates (a subscription isn't billed per token)`;
}

function prChip(pr) {
  if (!pr) return '';
  const mark = { pass: '✓', fail: '✗', pending: '•', none: '' }[pr.checks];
  const rv = pr.review === 'APPROVED' ? ' approved' : pr.review === 'CHANGES_REQUESTED' ? ' changes asked' : '';
  return `<span class="pr ${pr.state.toLowerCase()} ${pr.checks}" data-url="${esc(pr.url)}" title="Open PR #${pr.number} on GitHub">#${pr.number} ${pr.state.toLowerCase()}${mark ? ` ${mark}` : ''}${rv}</span>`;
}

// ---------- preview: a browser pane above the mission (agents drive it with mt-preview) ----------
const PREV_H = 560;
function openPreview(p, url) {
  if (!p.prevEl) {
    const el = document.createElement('div');
    el.className = 'prevp';
    el.innerHTML = `<div class="hd"><b>PREVIEW</b><input spellcheck="false" autocomplete="off"><button data-a="go">go</button><button data-a="re">reload</button><button data-a="ext" title="Open in your browser">open ↗</button><button data-a="x">close</button></div><iframe></iframe><div class="shield"></div>`;
    world.appendChild(el);
    p.prevEl = el;
    const inp = el.querySelector('input');
    const go = () => { let u = inp.value.trim(); if (/^\d+$/.test(u)) u = `http://localhost:${u}/`; else if (!/^https?:\/\//.test(u)) u = `http://${u}`; load(p, u); };
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') go(); });
    el.querySelector('.hd').onclick = (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'go') go();
      if (a === 're') load(p, p.prevUrl);
      if (a === 'ext' && p.prevUrl) send({ t: 'open', url: p.prevUrl });
      if (a === 'x') togglePreview(p);
    };
    el.addEventListener('pointerdown', () => select(p.info.id, false), true);
    place(p);
    scheduleRender();
  }
  if (url) load(p, url);
}
function load(p, url) {
  if (!url || !p.prevEl) return;
  p.prevUrl = url;
  p.prevEl.querySelector('input').value = url;
  const f = p.prevEl.querySelector('iframe');
  f.src = 'about:blank';
  requestAnimationFrame(() => (f.src = url));
}
function togglePreview(p) {
  if (p.prevEl) { p.prevEl.remove(); p.prevEl = null; drawWires(); scheduleRender(); return; }
  const port = (p.info.ports || [])[0] || [...panes.values()].find((q) => q.info.parent === p.info.id && q.info.ports?.length)?.info.ports[0];
  openPreview(p, port ? `http://localhost:${port}/` : '');
  if (!port) p.prevEl.querySelector('input').focus();
}
function onPreview(m) {
  const p = panes.get(m.id);
  if (!p) return;
  if (m.action === 'close') { if (p.prevEl) togglePreview(p); return; }
  if (m.action === 'reload') { if (p.prevEl) load(p, p.prevUrl); return; }
  openPreview(p, m.url);
}

// ---------- git: branch, ports, changes panel ----------
function onGit(m) {
  const p = panes.get(m.id);
  if (!p) return;
  p.info.git = m.git;
  p.info.ports = m.ports;
  if (p.diffEl) send({ t: 'diff', id: m.id }); // keep an open panel live
  scheduleRender(m.id);
}

const DIFF_GAP = 34;
function toggleDiff(p) {
  if (p.diffEl) { p.diffEl.remove(); p.diffEl = null; scheduleRender(); return; }
  const el = document.createElement('div');
  el.className = 'diffp';
  el.innerHTML = `<div class="hd"><b>CHANGES</b><span class="sum">reading…</span><button data-a="x" title="Close">close</button></div><div class="bd"><div class="files"></div><pre class="dx"></pre></div>`;
  world.appendChild(el);
  p.diffEl = el;
  el.querySelector('[data-a=x]').onclick = () => toggleDiff(p);
  el.querySelector('.files').onclick = (e) => {
    const f = e.target.closest('[data-i]');
    const h = f && el.querySelector(`.dx [data-f="${f.dataset.i}"]`);
    if (h) el.querySelector('.dx').scrollTop = h.offsetTop - 4;
  };
  el.addEventListener('pointerdown', () => select(p.info.id, false), true);
  place(p);
  send({ t: 'diff', id: p.info.id });
  scheduleRender();
}

function onDiff(m) {
  const p = panes.get(m.id);
  const el = p?.diffEl;
  if (!el) return;
  if (m.error) { el.querySelector('.sum').textContent = m.error; return; }
  const key = m.text + JSON.stringify(m.files);
  if (el._key === key) return; // unchanged: keep scroll position
  el._key = key;
  const dx = el.querySelector('.dx');
  const top = dx.scrollTop;
  const ST = { M: 'mod', A: 'add', D: 'del', R: 'ren', C: 'com', '??': 'new' };
  el.querySelector('.sum').textContent = m.files.length
    ? `${m.files.length} file${m.files.length > 1 ? 's' : ''} vs ${m.against}${m.truncated ? ' · truncated' : ''}`
    : `clean vs ${m.against}`;
  const order = [];
  let html = '';
  for (const ln of m.text.split('\n')) {
    const fm = /^diff --git a\/.+ b\/(.+)$/.exec(ln);
    if (fm) { order.push(fm[1]); html += `<div class="fh" data-f="${order.length - 1}">${esc(fm[1])}</div>`; continue; }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename )/.test(ln)) continue;
    const c = ln.startsWith('@@') ? 'hk' : ln[0] === '+' ? 'ad' : ln[0] === '-' ? 'rm' : '';
    html += `<div class="${c}">${esc(ln) || ' '}</div>`;
  }
  dx.innerHTML = html || '<div class="hk">nothing changed yet</div>';
  dx.scrollTop = top;
  el.querySelector('.files').innerHTML = m.files.map((f) => {
    const i = order.indexOf(f.path);
    return `<div class="f"${i >= 0 ? ` data-i="${i}"` : ''} title="${esc(f.path)}"><span class="s ${ST[f.st] || 'mod'}">${esc(f.st === '??' ? 'NEW' : f.st)}</span>${esc(f.path)}</div>`;
  }).join('');
}

// Two soft notes when a mission finishes (skipped when muted with ?quiet).
let actx;
function chime() {
  if (location.search.includes('quiet')) return;
  try {
    actx = actx || new AudioContext();
    [[660, 0], [880, 0.12]].forEach(([f, d]) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + d;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      o.connect(g).connect(actx.destination);
      o.start(t); o.stop(t + 0.4);
    });
  } catch {}
}

// ---------- find in mission (⌘F) ----------
const find = $('#find'), findIn = find.querySelector('input');
const FIND_OPTS = { decorations: { matchBackground: '#e3a23a33', activeMatchBackground: '#e3a23a', matchOverviewRuler: '#e3a23a', activeMatchColorOverviewRuler: '#e3a23a' } };
function openFind() {
  if (!panes.get(current)?.search) return;
  find.hidden = false;
  findIn.select();
  findIn.focus();
}
function closeFind() {
  find.hidden = true;
  const p = panes.get(current);
  p?.search?.clearDecorations();
  p?.term.focus();
}
function runFind(back) {
  const p = panes.get(current);
  if (!p?.search || !findIn.value) return (find.querySelector('em').textContent = '');
  const ok = back ? p.search.findPrevious(findIn.value, FIND_OPTS) : p.search.findNext(findIn.value, { ...FIND_OPTS, incremental: !back && find._typing });
  find.querySelector('em').textContent = ok ? '' : 'no match';
}
findIn.addEventListener('input', () => { find._typing = true; runFind(); find._typing = false; });
findIn.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter') { e.preventDefault(); runFind(e.shiftKey); }
  e.stopPropagation();
});
window.addEventListener('keydown', (e) => {
  if (e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyF' && !dlg.open) { e.preventDefault(); e.stopPropagation(); openFind(); }
}, true);

// Pass a pane id to redraw just that pane; no id redraws all of them.
let renderQueued = false, renderAll = false;
const renderIds = new Set();
function scheduleRender(id) {
  if (id == null) renderAll = true;
  else renderIds.add(id);
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    const only = renderAll ? null : new Set(renderIds);
    renderQueued = false; renderAll = false; renderIds.clear();
    render(only);
  });
}

function toast(p, what, cls, who) {
  const t = document.createElement('div');
  t.className = `toast ${cls}`;
  t.innerHTML = `${who ? insignia(who, 24) : `<span class="led ${cls}"></span>`}<span><b>${esc(p.info.name)}</b><br>${esc(what)}</span>`;
  t.onclick = () => { focusMission(p.info.id); t.remove(); };
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 7000);
  native({ kind: 'notify', title: `${p.info.name} ${what}`, body: p.info.cwd });
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(`${p.info.name} ${what}`, { body: p.info.cwd });
    n.onclick = () => { window.focus(); focusMission(p.info.id); };
  }
}

// ticking clock + running timers
setInterval(() => {
  $('#clock').textContent = fmtTime(Date.now());
  document.querySelectorAll('[data-since]').forEach((el) => {
    const t = Number(el.dataset.since);
    if (t) el.textContent = `T+${fmtDur(Date.now() - t)}`;
  });
}, 1000);

// ---------- new mission ----------
const dlg = $('#newDlg');
const form = $('#newForm');
function openNew() {
  const recent = JSON.parse(localStorage.getItem('deck.dirs') || '[]');
  $('#recentDirs').innerHTML = recent.map((d) => `<option value="${esc(d)}">`).join('');
  form.reset();
  const used = new Set([...panes.values()].map((p) => p.info.name));
  form.name.value = CODENAMES.find((v) => !used.has(v)) || `Op ${panes.size + 1}`;
  form.cwd.value = recent[0] || '~';
  loadHistory();
  dlg.showModal();
  form.cwd.select();
}
window.openNew = openNew;
// A new mission lands straight in a shell in your home folder; start claude (or anything) yourself.
// Shift-click or ⌘⇧N opens the full dialog: folder, command, own branch.
function quickShell() {
  const used = new Set([...panes.values()].map((p) => p.info.name));
  send({ t: 'create', name: CODENAMES.find((v) => !used.has(v)) || `Op ${panes.size + 1}`, cwd: '~', cmd: '' });
}
window.quickShell = quickShell;
$('#newBtn').onclick = (e) => (e.shiftKey ? openNew() : quickShell());
$('#wallBtn').onclick = overview;
form.querySelectorAll('.presets button').forEach((b) => (b.onclick = () => (form.cmd.value = b.dataset.cmd)));
// Past conversations in the chosen folder: click one to resume it.
let histT;
function loadHistory() { clearTimeout(histT); histT = setTimeout(() => send({ t: 'history', cwd: form.cwd.value.trim() || '~' }), 200); }
form.cwd.addEventListener('input', loadHistory);
function onHistory(m) {
  if (m.cwd !== (form.cwd.value.trim() || '~')) return;
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
  $('#history').innerHTML = m.list.length
    ? `<span class="lbl">Resume a past conversation</span>` + m.list.map((h) => `<button type="button" data-id="${esc(h.id)}"><em>${ago(h.t)}</em>${esc(h.prompt)}</button>`).join('')
    : '';
}
$('#history').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  form.cmd.value = `claude --resume ${b.dataset.id}`;
  form.ownBranch.checked = false; // the conversation lives with this folder, not a new worktree
  $('#history').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
};
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  const cwd = form.cwd.value.trim() || '~';
  const recent = [cwd, ...JSON.parse(localStorage.getItem('deck.dirs') || '[]').filter((d) => d !== cwd)].slice(0, 15);
  localStorage.setItem('deck.dirs', JSON.stringify(recent));
  send({ t: 'create', name: form.name.value.trim(), cwd, cmd: form.cmd.value.trim(), ownBranch: form.ownBranch.checked });
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});

// ---------- keys (capture phase so they win over the terminal) ----------
// Moontty's own shortcuts all use ⌘, like a Mac terminal's tabs, so every ⌥ and ctrl
// combination reaches Claude Code untouched (⌥P model, ⌥T thinking, ctrl+R history...).
window.addEventListener('keydown', (e) => {
  if (!e.metaKey || e.altKey || e.ctrlKey || dlg.open) return;
  const ids = [...panes.keys()];
  const i = ids.indexOf(current);
  let handled = true;
  if (/^Digit[1-9]$/.test(e.code) && !e.shiftKey) focusMission(ids[Number(e.code.slice(5)) - 1]);
  else if (e.code === 'Digit0' && !e.shiftKey) overview();
  else if (e.code === 'KeyN') e.shiftKey ? openNew() : quickShell();
  else if (e.code === 'BracketRight') focusMission(ids[(i + 1) % ids.length]);
  else if (e.code === 'BracketLeft') focusMission(ids[(i - 1 + ids.length) % ids.length]);
  else if (e.code === 'Equal') zoomTo(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
  else if (e.code === 'Minus') zoomTo(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
  else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}, true);
window.addEventListener('resize', () => { renderBeacons(); syncWatch(); });

// Wait for the mono font so xterm measures cells correctly (don't hang if offline).
Promise.race([document.fonts.load('12.5px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1500))]).then(connect);
