'use strict';

const assert = require('node:assert/strict');
const { MatchManager, scheduledStartMs } = require('./match-manager');
const { TeenPattiEngine } = require('./game-engine');

const config = {
  numPlayers: 2, chipsPerPlayer: 100, startingBoot: 10, startingBlind: 10,
  bootIncreaseMinutes: 5, matchStartDate: '', matchStartTime: '',
  players: [
    { seat: 1, name: 'Alice', password: 'a', type: 'human', kicked: false },
    { seat: 2, name: 'Bob', password: 'b', type: 'human', kicked: false },
  ],
};
const sent = new Map();
const realtime = { clients: new Set(), sessions: new Map(), send(client, message) { if (!sent.has(client)) sent.set(client, []); sent.get(client).push(message); } };
const clients = [
  { authenticated: true, role: 'player', seat: 1, name: 'Alice' },
  { authenticated: true, role: 'player', seat: 2, name: 'Bob' },
];
let snapshot = null;
let savedConfig = { ...config };
const manager = new MatchManager({
  getConfig: () => savedConfig,
  saveConfig: cfg => { savedConfig = cfg; },
  loadSnapshot: () => snapshot,
  saveSnapshot: value => { snapshot = value; },
  deleteSnapshot: () => { snapshot = null; },
  realtime,
});

(async () => {
  assert.ok(scheduledStartMs({ matchStartDate: '2099-01-01', matchStartTime: '12:00' }) > Date.now());
  assert.ok(scheduledStartMs({ matchStartDate: '2000-01-01', matchStartTime: '12:00' }) < Date.now());

  const configuredEngine = new TeenPattiEngine({ seats: 2, chips: [100, 100], startingBoot: 10, startingBlind: 30, maxBlindCall: 40, random: () => 0.1 });
  configuredEngine.startRound();
  assert.equal(configuredEngine.currentBet, 30, 'starting blind must control the initial call');
  assert.equal(configuredEngine.actionsFor(configuredEngine.currentSeat).raise, true);
  configuredEngine.action(configuredEngine.currentSeat, 'raise');
  assert.equal(configuredEngine.currentBet, 40, 'max blind/call must cap raises');
  assert.equal(configuredEngine.actionsFor(configuredEngine.currentSeat).raise, false);

  const futureConfig = { ...config, matchStartDate: '2099-01-01', matchStartTime: '12:00' };
  let futureSaved = { ...futureConfig };
  const futureManager = new MatchManager({
    getConfig: () => futureSaved,
    saveConfig: value => { futureSaved = value; },
    loadSnapshot: () => null,
    saveSnapshot: () => {},
    deleteSnapshot: () => {},
    realtime,
  });
  futureManager.register({ authenticated: true, role: 'player', seat: 1, name: 'Alice' });
  futureManager.register({ authenticated: true, role: 'player', seat: 2, name: 'Bob' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(futureManager.started, false, 'future scheduled match must not start early');
  futureManager.close();

  const malformedManager = new MatchManager({
    getConfig: () => ({ ...config, matchStartDate: 'not-a-date', matchStartTime: '12:00' }),
    saveConfig: () => {},
    loadSnapshot: () => null,
    saveSnapshot: () => {},
    deleteSnapshot: () => {},
    realtime,
  });
  assert.equal(await malformedManager.startTimeReached(), false, 'malformed schedule must block automatic start');
  malformedManager.close();

  manager.register(clients[0]);
  assert.equal(manager.started, false);
  manager.register(clients[1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.started, true);
  assert.equal(savedConfig.status, 'live');
  assert.ok(snapshot, 'live match must be persisted');

  const aliceState = manager.stateFor(clients[0]);
  const bobState = manager.stateFor(clients[1]);
  assert.equal(aliceState.players[0].name, 'Alice');
  assert.equal(aliceState.players[1].name, 'Bob');
  assert.equal(bobState.players[0].name, 'Alice');
  assert.equal(bobState.players[1].name, 'Bob');
  const revealEvents = [];
  manager.realtime.clients = new Set(clients);
  manager.realtime.send = (client, message) => { if (message.t === 'showdownReveal' || message.t === 'sideshowReveal') revealEvents.push({ client, message }); };
  manager.engine.players[0].seen = true;
  manager.engine.players[1].seen = true;
  manager.engine.currentSeat = 0;
  await manager.applyAction(1, 'show');
  assert.equal(revealEvents.filter(item => item.message.t === 'showdownReveal').length, 2, 'SHOW reveal must be public');
  assert.equal(aliceState.players[0].hand?.length, 3);
  assert.equal(bobState.players[1].hand?.length, 3);
  assert.equal(aliceState.players[1].hand, null);
  assert.equal(bobState.players[0].hand, null);
  assert.equal(JSON.stringify(aliceState).includes('password'), false);

  assert.ok(snapshot, 'action must remain persisted');

  const restored = new MatchManager({ getConfig: () => savedConfig, saveConfig: cfg => { savedConfig = cfg; }, loadSnapshot: () => snapshot, saveSnapshot: value => { snapshot = value; }, deleteSnapshot: () => { snapshot = null; }, realtime });
  assert.equal(await restored.restoreIfPresent(), true);
  assert.deepEqual(restored.engine.state(), manager.engine.state());
  assert.equal(restored.absences.has(0), true, 'restart must track the first human seat as disconnected');
  assert.equal(restored.absences.has(1), true, 'restart must track the second human seat as disconnected');
  manager.close(); restored.close();

  let manualConfig = { ...config, matchStartDate: '2099-01-01', matchStartTime: '12:00' };
  const manualManager = new MatchManager({ getConfig: () => manualConfig, saveConfig: cfg => { manualConfig = cfg; }, loadSnapshot: () => null, saveSnapshot: () => {}, deleteSnapshot: () => {}, realtime });
  manualManager.register(clients[0]);
  manualManager.register(clients[1]);
  assert.equal(await manualManager.startNow(), true, 'manual start must bypass a future schedule');
  manualManager.close();

  let botConfig = { ...config, players: [
    { seat: 1, name: 'Human', password: 'h', type: 'human', kicked: false },
    { seat: 2, name: 'Computer', password: 'c', type: 'computer', kicked: false },
  ] };
  let botSnapshot = null;
  const botManager = new MatchManager({ getConfig: () => botConfig, saveConfig: cfg => { botConfig = cfg; }, loadSnapshot: () => botSnapshot, saveSnapshot: value => { botSnapshot = value; }, deleteSnapshot: () => { botSnapshot = null; }, realtime });
  botManager.register({ authenticated: true, role: 'player', seat: 1, name: 'Human' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(botManager.started, true, 'one human plus one computer starts when the schedule is open');
  assert.deepEqual([...botManager.computerSeats], [1]);
  botManager.close();

  console.log('Phase 4 lifecycle tests passed: schedule gate, computer seats, persistence, privacy, and restore.');
})().catch(error => { console.error(error); process.exitCode = 1; });
