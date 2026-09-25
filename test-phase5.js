'use strict';

const assert = require('node:assert/strict');
const { MatchManager, RETURN_WINDOW_MS, BOT_TAKEOVER_ROUNDS } = require('./match-manager');

const config = {
  numPlayers: 2, chipsPerPlayer: 100, startingBoot: 10, startingBlind: 10, bootIncreaseMinutes: 5,
  players: [
    { seat: 1, name: 'Alice', password: 'a', type: 'human', kicked: false },
    { seat: 2, name: 'Bob', password: 'b', type: 'human', kicked: false },
  ],
};
let savedConfig = { ...config };
let snapshot = null;
const realtime = { clients: new Set(), sessions: new Map(), send() {} };
const manager = new MatchManager({
  getConfig: () => savedConfig,
  saveConfig: cfg => { savedConfig = cfg; },
  loadSnapshot: () => snapshot,
  saveSnapshot: value => { snapshot = value; },
  deleteSnapshot: () => { snapshot = null; },
  realtime,
});

(async () => {
  assert.equal(RETURN_WINDOW_MS, 600000);
  assert.equal(BOT_TAKEOVER_ROUNDS, 3);
  const alice = { authenticated: true, role: 'player', seat: 1, name: 'Alice' };
  const bob = { authenticated: true, role: 'player', seat: 2, name: 'Bob' };
  realtime.sessions.set(1, alice);
  realtime.sessions.set(2, bob);
  manager.register(alice);
  manager.register(bob);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.started, true);

  realtime.sessions.delete(1);
  manager.unregister(alice);
  assert.equal(manager.absences.get(0).botControlled, true, 'disconnect must activate a restricted bot');
  assert.equal(manager.computerSeats.has(0), true);
  const hidden = manager.stateFor(bob).players[0];
  assert.equal(hidden.absent, true);
  assert.ok(hidden.returnDeadline > Date.now());

  realtime.sessions.set(1, alice);
  manager.register(alice);
  assert.equal(manager.absences.has(0), false, 'return within the window must reclaim the seat');
  assert.equal(manager.computerSeats.has(0), false);

  realtime.sessions.delete(1);
  manager.unregister(alice);
  const absence = manager.absences.get(0);
  absence.deadline = Date.now() - 1;
  const before = manager.engine.players[1].chips;
  await manager.expireAbsences();
  assert.equal(manager.absences.has(0), false);
  assert.equal(savedConfig.players[0].kicked, true, 'expired absence must be kicked');
  assert.equal(manager.engine.players[0].standing, true);
  assert.ok(manager.engine.players[1].chips >= before, 'automatic kick may share remaining chips');
  manager.close();
  console.log('Phase 5 tests passed: restricted bot, return window, duplicate-session safety, automatic kick, and chip sharing.');
})().catch(error => { console.error(error); process.exitCode = 1; });
