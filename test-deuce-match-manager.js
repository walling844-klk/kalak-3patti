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

  // ── Stand Up, timeout notice, shared avatars, random first dealer ──
  {
    let cfg = {
      numPlayers: 4,
      players: [
        { seat: 1, name: 'Ann', type: 'human', password: 'a', kicked: false },
        { seat: 2, name: 'Bob', type: 'human', password: 'b', kicked: false },
        { seat: 3, name: 'Cid', type: 'human', password: 'c', kicked: false },
        { seat: 4, name: 'Dee', type: 'computer', password: 'd', kicked: false },
      ],
      observerPassword: 'w', status: 'waiting', matchStartDate: '', matchStartTime: '',
    };
    let snap = null; const msgs = [];
    const rt = { clients: new Set(), sessions: new Map(), send(client, message) { msgs.push({ client, message }); } };
    const make = () => new DeuceMatchManager({ getConfig: () => cfg, saveConfig: next => { cfg = next; }, loadSnapshot: () => snap, saveSnapshot: next => { snap = JSON.parse(JSON.stringify(next)); }, deleteSnapshot: () => { snap = null; }, realtime: rt });
    const m = make();
    const ann = { authenticated: true, role: 'player', seat: 1 }, bob = { authenticated: true, role: 'player', seat: 2 }, cid = { authenticated: true, role: 'player', seat: 3 };
    for (const c of [ann, bob, cid]) { rt.clients.add(c); rt.sessions.set(c.seat, c); m.register(c); }
    const realRandom = Math.random; Math.random = () => 0.8;          // floor(0.8 * 4) = seat 4
    assert.equal(await m.startNow(), true);
    Math.random = realRandom;
    assert.equal(m.engine.dealer, 3, 'the first dealer comes from a random draw');
    assert.equal(m.engine.actor, 0, 'the seat after the dealer plays first');
    const states = who => msgs.filter(x => x.client === who && x.message.t === 'deuceState').at(-1).message;

    // a human who runs out of time: the table is told what was played for them
    m.turnDeadline = Date.now() - 1; msgs.length = 0;
    await m.timeoutTurn();
    const timeoutNotice = msgs.find(x => x.message.t === 'deuceNotice');
    assert.ok(timeoutNotice && /Ann timed out — Group \d played/.test(timeoutNotice.message.text), timeoutNotice && timeoutNotice.message.text);
    assert.equal(msgs.filter(x => x.message.t === 'deuceNotice').length, 3, 'everybody connected got the notice');

    // avatars
    msgs.length = 0;
    await m.handleMessage({ t: 'deuceAction', action: 'avatar', index: 7 }, bob);
    assert.equal(states(cid).players[1].avatar, 7, 'other players see the avatar Bob picked');
    assert.equal(states(cid).players[0].avatar, null, 'seats that never picked one have none');
    msgs.length = 0;
    await m.handleMessage({ t: 'deuceAction', action: 'avatar', index: 500 }, bob);
    assert.equal(msgs.some(x => x.message.t === 'error'), true, 'an impossible avatar is refused');
    assert.equal(m.avatars.get(1), 7);
    assert.deepEqual(snap.avatars, [[1, 7]], 'avatars are saved with the match');

    // Stand Up
    msgs.length = 0;
    assert.equal(await m.handleMessage({ t: 'deuceAction', action: 'standUp' }, ann), true);
    assert.equal(m.engine.removedSeats.has(0), true, 'Ann is out of the game');
    assert.equal(states(bob).players[0].removed, true);
    assert.notEqual(m.engine.actor, 0);
    const toasts = msgs.filter(x => x.message.t === 'deuceNotice');
    assert.equal(toasts.length >= 2 && toasts.every(x => x.client !== ann) && /Ann stood up/.test(toasts[0].message.text), true, 'the others are told, Ann is not (she gets her own message)');
    m.unregister(ann);
    assert.equal(m.absences.has(0), false, 'a seat that stood up never becomes an absent player / bot');
    msgs.length = 0;
    await m.handleMessage({ t: 'deuceAction', action: 'standUp' }, ann);
    assert.equal(msgs.some(x => x.client === ann && x.message.t === 'error' && /already watching/.test(x.message.error)), true, 'standing up twice is refused');
    // three left (Bob, Cid, Dee): one more may stand up, then two must stay
    assert.equal(await m.handleMessage({ t: 'deuceAction', action: 'standUp' }, bob), true);
    assert.equal(m.engine.removedSeats.has(1), true);
    msgs.length = 0;
    await m.handleMessage({ t: 'deuceAction', action: 'standUp' }, cid);
    assert.equal(msgs.some(x => x.client === cid && x.message.t === 'error' && /At least two players/.test(x.message.error)), true, 'two players must always stay');
    assert.equal(m.engine.removedSeats.has(2), false);
    assert.equal(m.engine.gameOver, false);

    // saved + restored (server restart): the seats that stood up stay out and the avatar stays
    const back = make();
    assert.equal(await back.restoreIfPresent(), true);
    assert.equal(back.engine.removedSeats.has(0) && back.engine.removedSeats.has(1), true);
    assert.equal(back.avatars.get(1), 7);
    back.close();

    // next match: the same people keep their avatars; a table reset (kill) forgets them
    await m.resetForNextMatch();
    assert.equal(m.avatars.get(1), 7);
    await m.reset();
    assert.equal(m.avatars.size, 0);
    m.close();
  }
  await restored.reset(); restored.close();
  await manager.reset(); manager.close();
  console.log('Deuce match manager tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
