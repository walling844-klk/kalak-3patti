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
  // Exit Table: the seat is locked for the rest of the match, survives a server restart, and is cleared by reset.
  assert.equal(manager.isSeatExited(1), false);
  manager.markExited({ role: 'observer', seat: null });
  manager.markExited({ role: 'player', seat: 1 });
  assert.equal(manager.isSeatExited(1), true);
  assert.equal(manager.connectedSeats.has(0), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(snapshot.exitedSeats, [0], 'exit lock must be saved with the match');
  const restoredAfterExit = new DeuceMatchManager({
    getConfig: () => config, saveConfig: next => { config = next; }, loadSnapshot: () => snapshot,
    saveSnapshot: next => { snapshot = next; }, deleteSnapshot: () => { snapshot = null; }, realtime,
  });
  assert.equal(await restoredAfterExit.restoreIfPresent(), true);
  assert.equal(restoredAfterExit.isSeatExited(1), true, 'exit lock must survive a restart');
  await restoredAfterExit.reset(); restoredAfterExit.close();
  const locked = { authenticated: true, role: 'player', seat: 1 };
  manager.register(locked);
  assert.equal(manager.connectedSeats.has(0), false, 'an exited seat must not register again');
  await manager.reset();
  assert.equal(manager.isSeatExited(1), false, 'reset must clear exit locks');

  // ── Admin kick: the seat is removed from the game (no bot in its place); a 2-seat table ends and the other seat wins ──
  {
    let cfg = {
      numPlayers: 3,
      players: [
        { seat: 1, name: 'Ann', type: 'human', password: 'a', kicked: false },
        { seat: 2, name: 'Bob', type: 'human', password: 'b', kicked: false },
        { seat: 3, name: 'Cid', type: 'computer', password: 'c', kicked: false },
      ],
      observerPassword: 'w', status: 'waiting', matchStartDate: '', matchStartTime: '',
    };
    let snap = null; const msgs = [];
    const rt = { clients: new Set(), sessions: new Map(), send(client, message) { msgs.push({ client, message }); } };
    const m = new DeuceMatchManager({ getConfig: () => cfg, saveConfig: next => { cfg = next; }, loadSnapshot: () => snap, saveSnapshot: next => { snap = next; }, deleteSnapshot: () => { snap = null; }, realtime: rt });
    const ann = { authenticated: true, role: 'player', seat: 1 }, bob = { authenticated: true, role: 'player', seat: 2 };
    for (const c of [ann, bob]) { rt.clients.add(c); rt.sessions.set(c.seat, c); m.register(c); }
    assert.equal(await m.startNow(), true);
    cfg = { ...cfg, players: cfg.players.map(p => p.seat === 1 ? { ...p, kicked: true } : p) };   // what the kick route does first
    assert.equal(await m.adminKick(1), true);
    assert.equal(m.engine.removedSeats.has(0), true);
    m.unregister(ann);                                                // its socket closes right after the kick
    assert.equal(m.absences.has(0), false, 'a kicked seat must not become an absent player / bot');
    assert.equal(m.isBotControlled(0), false);
    assert.notEqual(m.engine.actor, 0, 'the kicked seat never gets the turn');
    const last = msgs.filter(x => x.client === bob).at(-1).message;
    assert.equal(last.players[0].removed, true);
    assert.equal(cfg.status, 'live', 'two seats are still at the table');
    assert.equal(await m.adminKick(1), false, 'kicking the same seat twice does nothing');
    assert.ok(snap.engine.removedSeats.includes(0), 'the removal is saved with the match');
    // kick the second human: only the computer seat is left, so the match ends and the computer wins
    cfg = { ...cfg, players: cfg.players.map(p => p.seat === 2 ? { ...p, kicked: true } : p) };
    assert.equal(await m.adminKick(2), true);
    assert.equal(m.engine.gameOver, true);
    assert.equal(cfg.status, 'ended');
    assert.equal(cfg.result.winner, 3);

    // ── Second match: reset keeps the players that are still connected, forgets the old match ──
    const { result: _r, status: _s, ...rest } = cfg;
    cfg = rest;
    bob.role = 'player';
    await m.resetForNextMatch();
    assert.equal(m.started, false);
    assert.equal(m.engine, null);
    assert.equal(m.connectedSeats.has(1), true, 'players who are still connected stay connected');
    assert.equal(m.exitedSeats.size, 0);
    // Kicked players stay kicked (same as Kalak). For the next match Bob is let back in by the admin; Ann stays kicked.
    cfg = { ...cfg, players: cfg.players.map(p => p.seat === 2 ? { ...p, kicked: false } : p) };
    assert.equal(await m.startNow(), true);
    assert.equal(m.engine.removedSeats.has(0), true, 'a seat kicked before the match is not dealt in');
    assert.equal(m.engine.players[0].hand.length, 0);
    assert.equal(m.engine.players[1].hand.length, 9);
    await m.reset(); m.close();
  }
  await restored.reset(); restored.close();
  await manager.reset(); manager.close();
  console.log('Deuce match manager tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
