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
  assert.ok(manager.matchStartedAt > 0, 'live match must have an authoritative start timestamp');
  assert.ok(snapshot, 'live match must be persisted');
  assert.equal(snapshot.matchStartedAt, manager.matchStartedAt, 'match start timestamp must be persisted');
  assert.ok(manager.turnDeadline > Date.now() && manager.turnDeadline <= Date.now() + 30_000,
    'live human turn must have a server deadline within the 30-second timeout');

  const aliceState = manager.stateFor(clients[0]);
  const bobState = manager.stateFor(clients[1]);
  assert.equal(aliceState.turnDeadline, manager.turnDeadline, 'player 1 must receive the live turn deadline');
  assert.equal(bobState.turnDeadline, manager.turnDeadline, 'player 2 must receive the same live turn deadline');
  assert.ok(aliceState.turnRemainingMs > 0 && aliceState.turnRemainingMs <= 30_000,
    'clients must receive server-computed remaining milliseconds');
  assert.ok(Math.abs(aliceState.turnRemainingMs - bobState.turnRemainingMs) < 100,
    'clients should receive nearly identical remaining time');
  assert.equal(aliceState.players[0].name, 'Alice');
  assert.equal(aliceState.players[1].name, 'Bob');
  assert.equal(bobState.players[0].name, 'Alice');
  assert.equal(bobState.players[1].name, 'Bob');
  assert.equal(aliceState.players[0].handCount, 3, 'seat 1 must receive public hand count for dealing animation');
  assert.equal(aliceState.players[1].handCount, 3, 'opponent hand count may be public without revealing cards');
  assert.ok(aliceState.roundAgeMs >= 0 && aliceState.roundAgeMs < 10_000, 'new live state must include round age for late-join effect suppression');
  const revealEvents = [];
  manager.realtime.clients = new Set(clients);
  manager.realtime.send = (client, message) => { if (message.t === 'showdownReveal' || message.t === 'sideshowReveal') revealEvents.push({ client, message }); };
  manager.engine.players[0].seen = true;
  manager.engine.players[1].seen = true;
  manager.engine.currentSeat = 0;
  await manager.applyAction(1, 'show');
  assert.equal(manager.turnDeadline, null, 'round-over state must clear the human turn deadline');
  assert.equal(manager.stateFor(clients[0]).turnRemainingMs, null, 'round-over clients must not receive a stale timer');
  assert.equal(revealEvents.filter(item => item.message.t === 'showdownReveal').length, 2, 'SHOW reveal must be public');
  assert.equal(aliceState.players[0].hand?.length, 3);
  assert.equal(bobState.players[1].hand?.length, 3);
  assert.equal(aliceState.players[1].hand, null);
  assert.equal(bobState.players[0].hand, null);
  assert.equal(JSON.stringify(aliceState).includes('password'), false);

  assert.ok(snapshot, 'action must remain persisted');

  const restored = new MatchManager({ getConfig: () => savedConfig, saveConfig: cfg => { savedConfig = cfg; }, loadSnapshot: () => snapshot, saveSnapshot: value => { snapshot = value; }, deleteSnapshot: () => { snapshot = null; }, realtime });
  assert.equal(await restored.restoreIfPresent(), true);
  assert.equal(restored.matchStartedAt, manager.matchStartedAt, 'restored match must retain its original start timestamp');
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

  let restartConfig = { ...config };
  const restartRealtime = { clients: new Set(), sessions: new Map(), send() {} };
  const restartManager = new MatchManager({
    getConfig: () => restartConfig,
    saveConfig: value => { restartConfig = value; },
    loadSnapshot: () => null,
    saveSnapshot: () => {},
    deleteSnapshot: () => {},
    realtime: restartRealtime,
  });
  const restartClients = [
    { authenticated: true, role: 'player', seat: 1, name: 'Alice' },
    { authenticated: true, role: 'player', seat: 2, name: 'Bob' },
  ];
  for (const client of restartClients) { restartRealtime.clients.add(client); restartManager.register(client); }
  await new Promise(resolve => setImmediate(resolve));
  restartManager.engine.gameOver = true;
  restartManager.resetForNextMatch();
  assert.equal(restartManager.started, false, 'ended match reset must make the manager startable again');
  assert.equal(restartManager.engine, null, 'ended match reset must discard the previous game engine');
  assert.deepEqual([...restartManager.connectedSeats].sort(), [0, 1], 'connected players must remain eligible for the next match');
  restartManager.close();

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

  const sideshowConfig = { ...config, numPlayers: 3, players: [
    { seat: 1, name: 'One', password: 'one', type: 'human', kicked: false },
    { seat: 2, name: 'Two', password: 'two', type: 'human', kicked: false },
    { seat: 3, name: 'Three', password: 'three', type: 'human', kicked: false },
  ] };
  const sideMessages = [];
  const sideRealtime = { clients: new Set(), sessions: new Map(), send(client, message) { sideMessages.push({ client, message }); } };
  let sideSnapshot = null;
  const sideManager = new MatchManager({ getConfig: () => sideshowConfig, saveConfig: () => {}, loadSnapshot: () => sideSnapshot, saveSnapshot: value => { sideSnapshot = value; }, deleteSnapshot: () => { sideSnapshot = null; }, realtime: sideRealtime });
  const sideClients = sideshowConfig.players.map(player => ({ authenticated: true, role: 'player', seat: player.seat, name: player.name }));
  for (const client of sideClients) { sideRealtime.clients.add(client); sideManager.register(client); }
  await new Promise(resolve => setImmediate(resolve));
  const asker = sideManager.engine.currentSeat;
  const target = (asker - 1 + 3) % 3;
  sideManager.engine.players[asker].seen = true;
  sideManager.engine.players[target].seen = true;
  const originalTurnDeadline = sideManager.turnDeadline;
  await sideManager.applyAction(asker + 1, 'sideshow');
  assert.ok(sideManager.sideshowDeadline > Date.now() && sideManager.sideshowDeadline <= Date.now() + 15_000, 'server must own a 15-second sideshow response deadline');
  const sideshowState = sideManager.stateFor(sideClients[2]);
  assert.equal(sideshowState.pendingSideshow.phase, 'ask');
  assert.ok(sideshowState.sideshowRemainingMs > 0 && sideshowState.sideshowRemainingMs <= 15_000, 'each client state must carry server-computed remaining sideshow time');
  assert.equal(sideManager.turnDeadline, originalTurnDeadline, 'asking must not restart the current player’s turn clock');
  assert.equal(sideManager.stateFor(sideClients.find(c => c.seat === target + 1)).players[target].hand.length, 3);
  await sideManager.respondSideshow(target + 1, true);
  assert.equal(sideManager.engine.pendingSideshow.phase, 'reveal');
  assert.ok(sideManager.sideshowDeadline > Date.now() && sideManager.sideshowDeadline <= Date.now() + 7_000, 'accepted sideshow reveal must end within the same seven-second local auto-continue window');
  const secretRevealRecipients = sideMessages.filter(item => item.message.t === 'sideshowReveal').map(item => item.client.seat);
  assert.deepEqual(secretRevealRecipients.sort(), [asker + 1, target + 1].sort(), 'only the two sideshow participants may receive either hand');
  assert.equal(sideManager.stateFor(sideClients.find(c => c.seat !== asker + 1 && c.seat !== target + 1)).players[asker].hand, null, 'unrelated seat must not receive another player’s cards');
  await assert.rejects(() => sideManager.continueSideshow(4 - asker - target), /Only the two players/);
  await sideManager.continueSideshow(asker + 1);
  assert.equal(sideManager.engine.pendingSideshow, null);
  sideManager.close();

  const standConfig = { ...config, numPlayers: 4, players: Array.from({ length: 4 }, (_, i) => ({ seat: i + 1, name: `Stand${i + 1}`, password: `stand${i + 1}`, type: 'human', kicked: false })) };
  const standMessages = [];
  const standRealtime = { clients: new Set(), sessions: new Map(), send(client, message) { standMessages.push({ client, message }); } };
  let standSnapshot = null;
  const standManager = new MatchManager({ getConfig: () => standConfig, saveConfig: () => {}, loadSnapshot: () => standSnapshot, saveSnapshot: value => { standSnapshot = value; }, deleteSnapshot: () => { standSnapshot = null; }, realtime: standRealtime });
  const standClients = standConfig.players.map(player => ({ authenticated: true, role: 'player', seat: player.seat, name: player.name }));
  for (const client of standClients) { standRealtime.clients.add(client); standRealtime.sessions.set(client.seat, client); standManager.register(client); }
  await new Promise(resolve => setImmediate(resolve));
  const initialStandChips = standConfig.numPlayers * standConfig.chipsPerPlayer;
  const currentBeforeStand = standManager.engine.currentSeat;
  const nonCurrent = (currentBeforeStand + 1) % 4;
  const nonCurrentStack = standManager.engine.players[nonCurrent].chips;
  await standManager.handleMessage({ t: 'standUp' }, standClients[nonCurrent]);
  assert.equal(standManager.engine.players[nonCurrent].standing, true, 'non-current seat must stand up immediately');
  assert.equal(standManager.engine.currentSeat, currentBeforeStand, 'standing a non-current seat must not disturb the active player');
  assert.equal(standManager.totalChips, initialStandChips - nonCurrentStack, 'surrendered stack must be removed from the in-play conservation baseline');
  const currentStack = standManager.engine.players[currentBeforeStand].chips;
  await standManager.handleMessage({ t: 'standUp' }, standClients[currentBeforeStand]);
  assert.equal(standManager.engine.players[currentBeforeStand].standing, true, 'current player must be allowed to stand up mid-hand');
  assert.notEqual(standManager.engine.currentSeat, currentBeforeStand, 'turn must advance away from the standing player');
  assert.equal(standManager.engine.roundOver, false, 'remaining live seats must keep the hand open');
  assert.equal(standManager.totalChips, initialStandChips - nonCurrentStack - currentStack, 'both surrendered stacks must be accounted for');
  assert.ok(standManager.turnDeadline > Date.now(), 'the next active seat must receive a fresh server turn deadline');
  const nextSeat = standManager.engine.currentSeat;
  assert.ok(standMessages.some(item => item.client.seat === nextSeat + 1 && item.message.t === 'matchState' && item.message.currentSeat === nextSeat), 'the next player must receive the new turn state');
  const legal = standManager.engine.actionsFor(nextSeat);
  await standManager.handleMessage({ t: 'action', action: legal.blind ? 'blind' : 'chaal' }, standClients[nextSeat]);
  assert.ok(standManager.engine.currentSeat !== nextSeat || standManager.engine.roundOver, 'the hand must continue normally after Stand Up');
  standManager.close();

  console.log('Phase 4 lifecycle tests passed: schedule gate, computer seats, persistence, privacy, and restore.');
})().catch(error => { console.error(error); process.exitCode = 1; });
