// history.js: past Claude Code conversations for a folder, newest first, for "resume".
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const HEAD_BYTES = 256 * 1024;

function firstPrompt(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(HEAD_BYTES);
  const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
  fs.closeSync(fd);
  for (const line of buf.toString('utf8', 0, n).split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isMeta) continue;
    let c = d.message?.content;
    if (Array.isArray(c)) c = c.find((p) => p.type === 'text')?.text;
    if (typeof c !== 'string') continue;
    c = c.replace(/\s+/g, ' ').trim();
    if (c && !c.startsWith('<')) return c.slice(0, 140);
  }
  return '';
}

function list(cwd, limit = 8) {
  const dir = path.join(PROJECTS, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  return files
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit * 3)
    .map(({ f, t }) => ({ id: f.slice(0, -6), t, prompt: firstPrompt(path.join(dir, f)) }))
    .filter((h) => h.prompt)
    .slice(0, limit);
}

module.exports = { list };
