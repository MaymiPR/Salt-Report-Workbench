// SPDX-License-Identifier: AGPL-3.0-only

// The page's pure logic (SaltCore) for the Node tests, put together the way
// the build puts it in the page: every src/core/*.js part, in name order,
// joined with newlines, then run as one CommonJS module. This is the same
// rule as core_source() in scripts/build.py; change one and change the other
// (tests/test_build.py checks they agree).
//
//   const core = require('./load-core.js');
//   node tests/js/load-core.js     prints the joined source

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const CORE_DIR = path.join(__dirname, '..', '..', 'src', 'core');

// The parts' text, in name order, joined with newlines.
const coreSource = (dir = CORE_DIR) => fs.readdirSync(dir)
    .filter(name => name.endsWith('.js') && fs.statSync(path.join(dir, name)).isFile())
    .sort()
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');

// Compile the joined source as a module of its own. The filename is only a
// label for stack traces: line numbers count through the joined source.
const loadCore = () => {
    const filename = path.join(CORE_DIR, '(joined).js');
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(CORE_DIR);
    mod._compile(coreSource(), filename);
    return mod.exports;
};

if (require.main === module) process.stdout.write(coreSource());
else module.exports = loadCore();
