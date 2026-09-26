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
  'function syncServerTurnCountdown',
  'function serverSend',
  "serverSend({t:'action',action:type})",
  "serverSend({t:'sideshowResponse',accept:!!accept})",
  "serverSend({t:'standUp'})",
  "new WebSocket(matchSocketUrl())",
]) assert.ok(html.includes(marker), `missing Phase 3 marker: ${marker}`);
assert.equal(html.includes('joinPollTimer'), false, 'waiting screen must not use the old polling timer');
assert.equal(html.includes('pollJoinInfo'), false, 'waiting screen must not use the old polling function');
assert.match(script, /G\.players= mapped|G\.players=mapped/, 'server state must populate the UI player model');
const tickBody = script.match(/function tickJoinCountdown\(\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(tickBody, 'lobby countdown tick function must exist');
assert.doesNotMatch(tickBody, /stopJoinCountdown\(\)|closeMatchSocket\(\)/,
  'hiding the lobby overlay after match start must not close the live gameplay socket');
assert.match(tickBody, /clearInterval\(joinCountdownTimer\)/,
  'hidden lobby should stop its display countdown timer');
const stopBody = script.match(/function stopJoinCountdown\(\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(stopBody && /closeMatchSocket\(\)/.test(stopBody),
  'explicit leave/cleanup must continue to close the WebSocket');
assert.match(script, /syncServerTurnCountdown\(state\.turnRemainingMs\)/,
  'browser must sync its turn countdown from server-computed remaining time');
const timerBody = script.match(/function syncServerTurnCountdown\(remainingMs\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(timerBody && /Date\.now\(\)\+Math\.min\(TURN_SECS\*1000,remaining\)/.test(timerBody) && /setInterval\(paint,250\)/.test(timerBody),
  'server turn countdown must repaint continuously on connected devices');
console.log('Phase 3 browser integration tests passed: server state adapter, actions, reconnect, polling removal, lobby socket retention, and server-synchronized turn countdown.');
