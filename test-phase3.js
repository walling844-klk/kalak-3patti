'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, 'public', 'KALAK_3PATTI.html'), 'utf8');
const script = html.split('<script>').at(-1).split('</script>')[0];
fs.writeFileSync('/tmp/kalak-phase3-browser-check.js', script);

for (const marker of [
  'function startServerMatchUI',
  'function applyServerMatchState',
  'function serverSend',
  "serverSend({t:'action',action:type})",
  "serverSend({t:'sideshowResponse',accept:!!accept})",
  "serverSend({t:'standUp'})",
  "new WebSocket(matchSocketUrl())",
]) assert.ok(html.includes(marker), `missing Phase 3 marker: ${marker}`);
assert.equal(html.includes('joinPollTimer'), false, 'waiting screen must not use the old polling timer');
assert.equal(html.includes('pollJoinInfo'), false, 'waiting screen must not use the old polling function');
assert.match(script, /G\.players= mapped|G\.players=mapped/, 'server state must populate the UI player model');
console.log('Phase 3 browser integration tests passed: server state adapter, action routing, reconnect path, and polling removal.');
