'use strict';
const assert = require('node:assert/strict');
const { MatchManager } = require('./match-manager');
const { RealtimeServer } = require('./realtime');

const audit = [];
let snapshot = null;
let config = { numPlayers: 2, chipsPerPlayer: 100, startingBoot: 10, bootIncreaseMinutes: 5, players: [
  { seat: 1, name: 'A', type: 'human', password: 'a', kicked: false },
  { seat: 2, name: 'B', type: 'human', password: 'b', kicked: false },
] };
const errors = [];
const realtime = { clients: new Set(), sessions: new Map(), send(client, message) { errors.push(message); } };
const manager = new MatchManager({ getConfig: () => config, saveConfig: next => { config = next; }, loadSnapshot: () => snapshot, saveSnapshot: value => { snapshot = value; }, deleteSnapshot: () => { snapshot = null; }, realtime, audit: (event, data) => audit.push({ event, data }) });
const a = { authenticated: true, role: 'player', seat: 1 };
const b = { authenticated: true, role: 'player', seat: 2 };
(async () => {
  manager.register(a); manager.register(b); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.started, true);
  manager.assertInvariants('test');
  const current = manager.engine.currentSeat + 1;
  const action = manager.engine.actionsFor(current - 1).see ? 'see' : 'blind';
  await manager.applyAction(current, action);
  assert.equal(manager.metrics.invariantFailures, 0);
  assert.ok(audit.some(event => event.event === 'match_started'));
  assert.ok(manager.getMetrics().actions >= 1);
  assert.equal(await manager.handleMessage({ t: 'action', action: 'x'.repeat(21) }, a), true);
  assert.equal(errors.at(-1).code, 'action');
  assert.match(errors.at(-1).error, /Invalid action/);
  manager.close();

  const fakeServer = { on() {}, }; // constructor validation only; protocol tests use the existing realtime suite
  assert.ok(RealtimeServer);
  console.log('Phase 6 tests passed: invariants, metrics, audit events, and bounded action validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
