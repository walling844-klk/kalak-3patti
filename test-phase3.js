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
  'function showTournamentRoundResult',
  'function syncServerSideshow',
  'function finishTournamentMatch',
  'function clearTournamentConnection',
  'function animateServerRoundStart(state)',
  'function playServerStateFeedback(state,previous)',
  'SERVER_ROUND_FX_MAX_AGE_MS=5000',
  'ensureAudio();\n  const btn=document.getElementById(\'btn-join-pass-submit\');',
  'function serverSend',
  "serverSend({t:'action',action:type})",
  "serverSend({t:'sideshowResponse',accept:!!accept})",
  "serverSend({t:'standUp'})",
  "serverSend({t:'sideshowContinue'})",
  "m.t==='roundResult'",
  "m.t==='error'",
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
assert.match(script, /playServerStateFeedback\(state,previousState\)/,
  'server state transitions must trigger tournament chip, peek, fold, and result feedback');
assert.match(script, /showTournamentRoundResult\(\{\.\.\.m\.lastRoundResult,remainingMs:m\.nextRoundRemainingMs\}\)/,
  'authoritative ordinary rounds and showdowns must display the local-style result popup');
assert.match(script, /finishTournamentMatch\(m\.players\.find\(/,
  'game-over state must close live tournament networking before showing the final winner screen');
assert.match(script, /if\(G\.tournamentMatch\)\{ clearTournamentConnection\(true\)/,
  'Exit Table must explicitly release the tournament socket and timers');
assert.match(script, /if\(G\.tournamentMatch\)\{ serverSend\(\{t:'sideshowContinue'\}\); return; \}/,
  'sideshow Continue must be server-authoritative in tournament mode');
assert.match(script, /animateCollectBoots\(\(\)=>\{[\s\S]*?animateDealCards\(/,
  'a fresh tournament hand must animate and sound boot collection before card dealing');
const timerBody = script.match(/function syncServerTurnCountdown\(remainingMs\)\{([\s\S]*?)\n\}/)?.[1];
assert.ok(timerBody && /Date\.now\(\)\+Math\.min\(TURN_SECS\*1000,remaining\)/.test(timerBody) && /setInterval\(paint,250\)/.test(timerBody),
  'server turn countdown must repaint continuously on connected devices');
console.log('Phase 3 browser integration tests passed: server state adapter, actions, reconnect, polling removal, lobby socket retention, synchronized turn countdown, and tournament audiovisual effects.');
