// git.js: per-mission branches (git worktrees), status for the title bar, and diffs.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MAX_DIFF = 600 * 1024;
const MAX_UNTRACKED = 25;

// Resolves { out, err, code } and never rejects: git uses exit 1 for "differences found".
// --no-optional-locks: our polling must never take index.lock while the agent commits.
const git = (dir, args) => new Promise((res) => execFile('git', ['--no-optional-locks', '-C', dir, ...args], { maxBuffer: 16 << 20 }, (e, out, err) => res({ out: String(out), err: String(err).trim(), code: e ? e.code ?? 1 : 0 })));
const gitSync = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mission';

// New worktree next to the repo (<repo>-<slug>) on branch nc/<slug>, started from the current HEAD.
function addWorktree(dir, name) {
  let root;
  try { root = gitSync(dir, ['rev-parse', '--show-toplevel']); } catch { throw new Error('folder is not a git repo'); }
  const base = gitSync(root, ['branch', '--show-current']) || gitSync(root, ['rev-parse', 'HEAD']);
  const sub = path.relative(root, fs.realpathSync(dir));
  const slug = slugify(name);
  let branch, wpath;
  for (let i = 1; ; i++) {
    const tag = i === 1 ? slug : `${slug}-${i}`;
    branch = `nc/${tag}`;
    wpath = path.join(path.dirname(root), `${path.basename(root)}-${tag}`);
    let taken = fs.existsSync(wpath);
    try { gitSync(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); taken = true; } catch {}
    if (!taken) break;
  }
  gitSync(root, ['worktree', 'add', '-b', branch, wpath, 'HEAD']);
  // Untracked local config (.env and friends) doesn't come with a checkout; copy it over.
  for (const f of fs.readdirSync(root)) {
    if (/^\.env(\..+)?$/.test(f) && fs.statSync(path.join(root, f)).isFile() && !fs.existsSync(path.join(wpath, f))) fs.copyFileSync(path.join(root, f), path.join(wpath, f));
  }
  return { root, path: sub ? path.join(wpath, sub) : wpath, top: wpath, branch, base };
}

// { branch, dirty, ahead } for the title bar, or null outside a repo.
async function info(dir, wt) {
  if (!fs.existsSync(dir)) return null;
  const st = await git(dir, ['status', '--porcelain=v1', '-b']);
  if (st.code) return null;
  const lines = st.out.split('\n').filter(Boolean);
  const head = (lines.shift() || '').replace(/^## /, '');
  const branch = head.startsWith('No commits yet on ') ? head.slice(18) : head.split('...')[0].replace(/ \[.*$/, '');
  const r = { branch, dirty: lines.length };
  if (wt) {
    const a = await git(dir, ['rev-list', '--count', `${wt.base}..HEAD`]);
    r.ahead = Number(a.out.trim()) || 0;
  }
  return r;
}

// Everything the mission changed: against the branch point for worktrees, else against HEAD.
async function diff(sub, wt) {
  if (!fs.existsSync(sub)) return { error: 'folder is gone' };
  // Work from the top of the checkout so status and diff paths line up for subfolder missions.
  const dir = (await git(sub, ['rev-parse', '--show-toplevel'])).out.trim() || sub;
  const st = await git(dir, ['status', '--porcelain=v1', '-uall']);
  if (st.code) return { error: 'not a git repo' };
  let ref = 'HEAD', against = 'last commit';
  if (wt) {
    const mb = await git(dir, ['merge-base', wt.base, 'HEAD']);
    if (!mb.code) { ref = mb.out.trim(); against = wt.base; }
  }
  const hasHead = !(await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code;
  const tracked = hasHead ? (await git(dir, ['diff', '--no-color', '--no-ext-diff', ref])).out : '';
  const files = st.out.split('\n').filter(Boolean).map((l) => ({ st: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  let text = tracked;
  // Committed files that are now clean don't show in status; list them from the diff too.
  const seen = new Set(files.map((f) => f.path));
  for (const m of tracked.matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) if (!seen.has(m[1])) { seen.add(m[1]); files.push({ st: 'C', path: m[1] }); }
  const untracked = files.filter((f) => f.st === '??').slice(0, MAX_UNTRACKED);
  for (const f of untracked) {
    if (text.length > MAX_DIFF) break;
    text += (await git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path])).out;
  }
  const truncated = text.length > MAX_DIFF;
  return { files, text: truncated ? text.slice(0, MAX_DIFF) : text, truncated, against };
}

// Merge the mission branch into the branch it started from, in the main checkout. Never resolves conflicts.
async function merge(wt) {
  const cur = (await git(wt.root, ['branch', '--show-current'])).out.trim();
  if (cur !== wt.base) return { ok: false, msg: `main checkout is on ${cur || 'a detached HEAD'}, not ${wt.base}` };
  const dirty = (await git(wt.top, ['status', '--porcelain'])).out.trim();
  if (dirty) return { ok: false, msg: `${dirty.split('\n').length} uncommitted file(s) on ${wt.branch}; commit them first` };
  const ahead = Number((await git(wt.root, ['rev-list', '--count', `${wt.base}..${wt.branch}`])).out.trim()) || 0;
  if (!ahead) return { ok: false, msg: `nothing to merge, ${wt.branch} has no new commits` };
  const r = await git(wt.root, ['merge', '--no-ff', '--no-edit', wt.branch]);
  if (r.code) {
    await git(wt.root, ['merge', '--abort']);
    const why = (r.err + '\n' + r.out).split('\n').map((l) => l.trim()).find(Boolean) || 'git refused';
    return { ok: false, msg: `merge stopped and was undone: ${why}` };
  }
  return { ok: true, msg: `merged ${ahead} commit(s) from ${wt.branch} into ${wt.base}` };
}

async function removeWorktree(wt) {
  const a = await git(wt.root, ['worktree', 'remove', '--force', wt.top]);
  if (a.code) throw new Error(a.err);
  await git(wt.root, ['branch', '-D', wt.branch]);
}

module.exports = { addWorktree, info, diff, merge, removeWorktree };
