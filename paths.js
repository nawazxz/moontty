// paths.js: expands ~ in the folders missions run in.
const os = require('os');
const path = require('path');

const expand = (p) => (!p ? os.homedir() : p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

module.exports = { expand };
