'use strict';

const assert = require('node:assert/strict');
const { DeuceMatchManager } = require('./deuce-match-manager');

let config = {
  numPlayers: 2,
  players: [
    { seat: 1, name: 'Alice', type: 'human', password: 'alice', kicked: false },
    { seat: 2, name: 'Bot', type: 'computer', password: 'bot', kicked: false },
  ],
  observerPassword: 'watch', status: 'waiting', matchStartDate: '', matchStartTime: '',
};
let snapshot = null;
const sent = [];
const realtime = { clients: new Set(), sessions: new Map(), send(client, message) { sent.push({ client, message }); } };
const manager = new DeuceMatchManager({
  getConfig: () => config,
  saveConfig: next => { config = next; },
  loadSnapshot: () => snapshot,
  saveSnapshot: next => { snapshot = next; },
  deleteSnapshot: () => { snapshot = null; },
  realtime,
});

(async () => {
  assert.equal(await manager.startNow(), true);
  assert.equal(manager.started, true);
  assert.equal(config.status, 'live');
  assert.equal(manager.engine.players.length, 2);

  const alice = { authenticated: true, role: 'player', seat: 1 };
  realtime.clients.add(alice); realtime.sessions.set(1, alice); manager.register(alice);
  const state = sent.at(-1).message;
  assert.equal(state.t, 'deuceState');
  assert.equal(state.players.find(player => player.seat === 0).hand.length, 9);
  assert.equal(state.players.find(player => player.seat === 1).hand, null);

  const actor = manager.engine.actor;
  if (actor === 0) {
    await manager.applyEngineAction(0, 'play', manager.engine.availableGroupIndices(manager.engine.players[0])[0]);
  }
  assert.ok(snapshot && snapshot.engine, 'live Deuce state must be persisted');

  const restored = new DeuceMatchManager({
    getConfig: () => config,
    saveConfig: next => { config = next; },
    loadSnapshot: () => snapshot,
    saveSnapshot: next => { snapshot = next; },
    deleteSnapshot: () => { snapshot = null; },
    realtime,
  });
  assert.equal(await restored.restoreIfPresent(), true);
  assert.equal(restored.engine.round, manager.engine.round);
  assert.equal(restored.engine.players[0].hand.length, manager.engine.players[0].hand.length);
  await restored.reset(); restored.close();
  await manager.reset(); manager.close();
  console.log('Deuce match manager tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
