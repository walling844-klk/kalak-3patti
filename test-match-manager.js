'use strict';

const assert = require('node:assert/strict');
const { MatchManager } = require('./match-manager');

const config = {
  numPlayers: 2, chipsPerPlayer: 100, startingBoot: 10, startingBlind: 10,
  bootIncreaseMinutes: 5,
  players: [
    { seat: 1, name: 'Alice', password: 'a', type: 'human', kicked: false },
    { seat: 2, name: 'Bob', password: 'b', type: 'human', kicked: false },
  ],
};
const sent = new Map();
const realtime = {
  clients: new Set(), sessions: new Map(),
  send(client, message) { if (!sent.has(client)) sent.set(client, []); sent.get(client).push(message); },
};
const clients = [
  { authenticated: true, role: 'player', seat: 1, name: 'Alice' },
  { authenticated: true, role: 'player', seat: 2, name: 'Bob' },
];
let snapshot = null;
let savedConfig = config;
const manager = new MatchManager({
  getConfig: () => savedConfig,
  saveConfig: cfg => { savedConfig = cfg; },
  loadSnapshot: () => snapshot,
  saveSnapshot: value => { snapshot = value; },
  deleteSnapshot: () => { snapshot = null; },
  realtime,
});

(async () => {
  manager.register(clients[0]);
  assert.equal(manager.started, false);
  manager.register(clients[1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.started, true);
  assert.equal(savedConfig.status, 'live');
  assert.ok(snapshot, 'live match must be persisted');

  const aliceState = manager.stateFor(clients[0]);
  const bobState = manager.stateFor(clients[1]);
  assert.ok(aliceState.players[0].hand?.length === 3);
  assert.ok(bobState.players[1].hand?.length === 3);
  assert.equal(aliceState.players[1].hand, null);
  assert.equal(bobState.players[0].hand, null);
  assert.equal(JSON.stringify(aliceState).includes('password'), false);

  const current = manager.engine.currentSeat + 1;
  await manager.applyAction(current, manager.engine.actionsFor(current - 1).blind ? 'blind' : 'see');
  assert.ok(snapshot, 'action must remain persisted');

  const restored = new MatchManager({
    getConfig: () => savedConfig,
    saveConfig: cfg => { savedConfig = cfg; },
    loadSnapshot: () => snapshot,
    saveSnapshot: value => { snapshot = value; },
    deleteSnapshot: () => { snapshot = null; },
    realtime,
  });
  assert.equal(await restored.restoreIfPresent(), true);
  assert.deepEqual(restored.engine.state(), manager.engine.state());
  manager.close(); restored.close();
  console.log('Match manager tests passed: start, persistence, privacy, actions, and restore.');
})().catch(error => { console.error(error); process.exitCode = 1; });
