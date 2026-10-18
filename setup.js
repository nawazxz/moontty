// setup.js: `moontty setup`. Checks what Moontty needs and installs its Claude Code hook.
// Safe to run again: it never adds the hook twice and backs up settings.json before writing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK = path.join(__dirname, 'hook.sh');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

const has = (cmd) => { try { execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const ok = (m) => console.log(`  ok    ${m}`);
const warn = (m) => console.log(`  note  ${m}`);
const fail = (m) => { console.log(`  FAIL  ${m}`); process.exitCode = 1; };

console.log('Moontty setup\n');

// 1. tools
has('claude') ? ok('claude (Claude Code) found') : warn('claude not found. Moontty runs any shell command, but the crew view, exact status and cost need Claude Code.');
const dtach = ['/opt/homebrew/bin/dtach', '/usr/local/bin/dtach', '/usr/bin/dtach'].find((f) => fs.existsSync(f));
dtach ? ok(`dtach found (${dtach}): agents survive server restarts`) : warn('dtach not found. Without it, stopping the server ends every agent. Install: brew install dtach');
has('gh') ? ok('gh found: pull request status on missions') : warn('gh not found. PR chips and "open pr" are off. Install: brew install gh && gh auth login');
has('git') ? ok('git found') : fail('git not found');

// 2. node-pty's prebuilt helper loses its exec bit on some installs ("posix_spawnp failed")
const helpers = path.join(__dirname, 'node_modules', 'node-pty', 'prebuilds');
if (!fs.existsSync(helpers)) fail('node_modules missing. Run: npm install');
else {
  for (const d of fs.readdirSync(helpers)) {
    const f = path.join(helpers, d, 'spawn-helper');
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
  ok('node-pty spawn-helper is executable');
}

// 3. the hook: one script for every event, a no-op outside Moontty panes
fs.chmodSync(HOOK, 0o755);
let settings = {};
if (fs.existsSync(SETTINGS)) {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { fail(`${SETTINGS} is not valid JSON (${e.message}); not touching it`); process.exit(); }
}
const hooks = (settings.hooks ||= {});
const added = [];
for (const ev of EVENTS) {
  const list = (hooks[ev] ||= []);
  if (list.some((g) => (g.hooks || []).some((h) => h.command === HOOK))) continue;
  const group = { hooks: [{ type: 'command', command: HOOK, timeout: 3 }] };
  if (TOOL_EVENTS.has(ev)) group.matcher = '*';
  list.push(group);
  added.push(ev);
}
if (added.length) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (fs.existsSync(SETTINGS)) fs.copyFileSync(SETTINGS, `${SETTINGS}.bak-moontty`);
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  ok(`hook added to ${SETTINGS} for: ${added.join(', ')}`);
  console.log(`        command: ${HOOK}`);
  console.log(`        backup:  ${SETTINGS}.bak-moontty`);
} else ok('hook already installed');

console.log('\nStart it with: moontty   (or ./deck from this folder)');
