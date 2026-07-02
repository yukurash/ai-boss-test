#!/usr/bin/env node
/* Regenerates data/embedded.js from data/*.json.
 * embedded.js is the file:// fallback for the dashboard: browsers block fetch()
 * on file: origins, so index.html loads this script tag instead when opened
 * directly from disk. Run after updating any of the three JSON logs:
 *   node scripts/build-embedded.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const files = ['run-fable5.json', 'run-opus48.json', 'planning-meeting.json'];
const out = {};
for (const f of files) {
  const p = path.join(dataDir, f);
  if (!fs.existsSync(p)) {
    console.warn('skip (missing):', f);
    continue;
  }
  out[f] = JSON.parse(fs.readFileSync(p, 'utf8'));
}
const dest = path.join(dataDir, 'embedded.js');
fs.writeFileSync(dest,
  '/* auto-generated from data/*.json for file:// viewing (fetch is blocked on file: origins). ' +
  'Regenerate with scripts/build-embedded.js after updating the JSON. */\n' +
  'window.__ARENA_DATA__=' + JSON.stringify(out) + ';\n');
console.log('wrote', dest, fs.statSync(dest).size, 'bytes');
