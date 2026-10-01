'use strict';

const assert = require('node:assert/strict');
const {
  makeDeck, evaluate, compareEval, bestPartition, DeuceEngine,
} = require('./deuce-engine');

function card(id, rank, suit, joker = false) { return { id, rank, suit, joker }; }

const trail = evaluate([card('AS', 'A', 'S'), card('AH', 'A', 'H'), card('AD', 'A', 'D')]);
const pure = evaluate([card('10S', '10', 'S'), card('JS', 'J', 'S'), card('QS', 'Q', 'S')]);
const high = evaluate([card('AS', 'A', 'S'), card('KH', 'K', 'H'), card('9D', '9', 'D')]);
assert.equal(trail.name, 'Trail');
assert.equal(pure.name, 'Pure Sequence');
assert.equal(compareEval(trail, pure) > 0, true);
assert.equal(compareEval(pure, high) > 0, true);

const jokerSequence = evaluate([
  card('2S', '2', 'S', true), card('9H', '9', 'H'), card('10D', '10', 'D'),
]);
assert.equal(jokerSequence.jokerUsed, true);
assert.equal(jokerSequence.name, 'Sequence');

const naturalTwoTrail = evaluate([
  card('2S', '2', 'S', true), card('2H', '2', 'H'), card('2D', '2', 'D'),
]);
assert.equal(naturalTwoTrail.name, 'Trail');

const hand = makeDeck(() => 0).slice(0, 9);
const partition = bestPartition(hand);
assert.equal(partition.length, 3);
assert.equal(partition.every(group => group.length === 3), true);
assert.equal(new Set(partition.flat().map(c => c.id)).size, 9);

const engine = new DeuceEngine({
  seats: 2,
  names: ['Alice', 'Bob'],
  deckFactory: () => makeDeck(() => 0),
});
const initial = engine.startMatch();
assert.equal(initial.round, 1);
assert.equal(initial.players.length, 2);
assert.equal(initial.players[0].hand, null);
assert.equal(engine.state(0).players[0].hand.length, 9);
assert.equal(engine.state(0).players[1].hand, null);

const actor = engine.actor;
const other = (actor + 1) % 2;
assert.throws(() => engine.play(other, 0), /not this player's turn/);
engine.group(actor, engine.players[actor].groups[0].slice(0, 2).map(c => c.id));
engine.play(actor, 0);
assert.equal(engine.groupCyclePlayed.has(actor), true);
engine.play(other, 0);
assert.equal(engine.currentGroupIndex, 1);
assert.equal(engine.players.some(player => player.score === 1), true);
assert.equal(engine.actor, engine.dealer === 0 ? 1 : 0);

const packedEngine = new DeuceEngine({ seats: 2, deckFactory: () => makeDeck(() => 0) });
packedEngine.startMatch();
const packedActor = packedEngine.actor;
const packedOther = (packedActor + 1) % 2;
packedEngine.pack(packedActor);
packedEngine.pack(packedOther);
// Everybody packed: nothing is left to play in this round, so it is over at once and a fresh round is dealt (it used to freeze here).
assert.equal(packedEngine.round, 2);
assert.equal(packedEngine.currentGroupIndex, 0);
assert.equal(packedEngine.actor >= 0, true);
assert.equal(packedEngine.players.every(player => !player.packed && player.hand.length === 9), true);
assert.equal(packedEngine.players.every(player => player.score === 0), true);

// Plays like the server's computer players: strongest playable group first (that never makes a group invalid).
function best(e, seat) {
  const list = e.availableGroupIndices(e.players[seat]);
  return list.reduce((pick, index) => pick == null || compareEval(evaluate(e.players[seat].groups[index]), evaluate(e.players[seat].groups[pick])) > 0 ? index : pick, null);
}
// ── Admin kick: removeSeat() ─────────────────────────────────────────────────────────────────────────────────────────
{
  // 3 seats, the seat whose turn it is gets removed: the turn passes on, nobody is dealt cards for the removed seat later.
  const e = new DeuceEngine({ seats: 3, computerSeats: [0, 1, 2], deckFactory: () => makeDeck(() => 0) });
  e.startMatch();
  const turn = e.actor;
  e.removeSeat(turn);
  assert.equal(e.removedSeats.has(turn), true);
  assert.notEqual(e.actor, turn, 'turn must move to another seat');
  assert.equal(e.players[turn].removed, true);
  assert.equal(e.players[turn].hand.length, 0);
  assert.equal(e.state().players[turn].removed, true);
  const a = e.actor, b = [0, 1, 2].find(x => x !== turn && x !== a);
  e.play(a, best(e, a));
  assert.equal(e.actor, b, 'removed seat is skipped in the turn order');
  const res = e.play(b, best(e, b));
  assert.ok(res.groupResult, 'group resolves once every remaining player has played');
  assert.equal(res.groupResult.entries.some(entry => entry.seat === turn), false, 'removed seat takes no part in the result');
  // next rounds: removed seat is never dealt cards and never gets the turn
  for (let i = 0; i < 12 && !e.gameOver; i++) {
    assert.notEqual(e.actor, turn);
    assert.equal(e.players[turn].hand.length, 0);
    assert.equal(e.players[turn].packed, true);
    const seat = e.actor;
    const avail = e.availableGroupIndices(e.players[seat]);
    if (avail.length) e.play(seat, best(e, seat)); else e.pack(seat);
  }
  // snapshot / restore keeps the removed seat
  const back = DeuceEngine.restore(JSON.parse(JSON.stringify(e.snapshot())));
  assert.equal(back.removedSeats.has(turn), true);
}
{
  // removing a seat that has NOT played yet while another player is up: their turn is not taken away
  const e = new DeuceEngine({ seats: 3, computerSeats: [0, 1, 2], deckFactory: () => makeDeck(() => 0) });
  e.startMatch();
  const actor = e.actor, other = [0, 1, 2].find(x => x !== actor && x !== (actor + 1) % 3);
  e.removeSeat(other);
  assert.equal(e.actor, actor);
  assert.equal(e.groupCyclePlayed.has(other), true);
}
{
  // removing the seat that was the LAST one to play-out this group resolves the group at once
  const e = new DeuceEngine({ seats: 3, computerSeats: [0, 1, 2], deckFactory: () => makeDeck(() => 0) });
  e.startMatch();
  const first = e.actor;
  e.play(first, best(e, first));
  const second = e.actor;
  e.play(second, best(e, second));
  const last = e.actor;
  const out = e.removeSeat(last);
  assert.ok(out.groupResult, 'group is resolved by the removal');
  assert.equal(e.currentGroupIndex, 1);
}
{
  // two seats: kicking one ends the match and the other seat wins
  const e = new DeuceEngine({ seats: 2, computerSeats: [0, 1], deckFactory: () => makeDeck(() => 0) });
  e.startMatch();
  const out = e.removeSeat(0);
  assert.equal(e.gameOver, true);
  assert.equal(e.winner, 1);
  assert.equal(out.gameOver, true);
}
{
  // removed BEFORE the match starts: never dealt in, match runs with the remaining seats
  const e = new DeuceEngine({ seats: 4, computerSeats: [0, 1, 2, 3], deckFactory: () => makeDeck(() => 0) });
  e.removeSeat(2);
  e.startMatch();
  assert.equal(e.players[2].hand.length, 0);
  assert.equal([0, 1, 3].every(seat => e.players[seat].hand.length === 9), true);
  assert.notEqual(e.actor, 2);
}
{
  // random games with random kicks never crash and never give the turn to a removed seat
  for (let game = 0; game < 300; game++) {
    const seats = 3 + (game % 4);
    const e = new DeuceEngine({ seats, deckFactory: () => makeDeck(Math.random) });   // (no computer seats: their hand search is slow)
    e.startMatch();
    let steps = 0;
    while (!e.gameOver && steps++ < 400) {
      if (Math.random() < 0.05 && e.activeSeats().length > 1) e.removeSeat(e.activeSeats()[Math.floor(Math.random() * e.activeSeats().length)]);
      if (e.gameOver) break;
      assert.equal(e.removedSeats.has(e.actor), false, 'removed seat got the turn');
      const seat = e.actor;
      const avail = e.availableGroupIndices(e.players[seat]);
      if (avail.length) e.play(seat, best(e, seat)); else e.pack(seat);
    }
    assert.equal(e.gameOver, true, 'game must finish');
    assert.equal(e.removedSeats.has(e.winner), false, 'a removed seat cannot win');
  }
}

// ── The group 2 > group 1 rule, and rounds that must never freeze ────────────────────────────────────────────────────
{
  const c = (rank, suit, n = '') => card(`${rank}${suit}${n}`, rank, suit);
  const setGroups = (e, seat, groups) => { e.players[seat].groups = groups; e.players[seat].hand = groups.flat(); };
  // Plays one whole group match: every seat that can play, in turn order, each with the slot chosen for it. Returns the result of the last play.
  function playMatch(e, slotOf) {
    let out = null;
    const startIndex = e.currentGroupIndex, startRound = e.round;
    for (let guard = 0; guard < 12 && e.currentGroupIndex === startIndex && e.round === startRound && !e.gameOver; guard++) {
      const seat = e.actor;
      assert.equal(seat >= 0, true, 'a seat must always be waiting to act');
      out = e.play(seat, slotOf[seat]);
    }
    return out;
  }
  const fresh = () => new DeuceEngine({ seats: 3, deckFactory: () => makeDeck(() => 0) });

  // Seat 0's group 2 is a trail (beats its group 1) -> group 2 INVALID, group 3 FORFEITED, and it does not get the point:
  // the point goes to the player with the next strongest group.
  {
    const e = fresh(); e.startMatch();
    setGroups(e, 0, [[c('A', 'S'), c('K', 'H'), c('9', 'D')], [c('Q', 'S'), c('Q', 'H'), c('Q', 'D')], [c('7', 'S'), c('4', 'H'), c('3', 'D')]]);
    setGroups(e, 1, [[c('K', 'S'), c('K', 'C'), c('4', 'D')], [c('J', 'S'), c('J', 'H'), c('6', 'D')], [c('8', 'S'), c('7', 'H'), c('3', 'C')]]);
    setGroups(e, 2, [[c('9', 'S'), c('9', 'H'), c('3', 'S')], [c('A', 'C'), c('8', 'D'), c('5', 'H')], [c('10', 'C'), c('4', 'C'), c('6', 'C')]]);
    e.actor = 0; e.dealer = 2; e.groupCyclePlayed = e.freshCycle();
    const m1 = playMatch(e, [0, 0, 0]);
    assert.equal(m1.groupResult.winner, 1, 'group 1: seat 1 (pair of kings) wins');
    assert.equal(e.players[1].score, 1);
    const m2 = playMatch(e, [1, 1, 1]);
    assert.equal(e.players[0].group2Invalid, true, 'group 2 beat group 1 -> invalid');
    assert.equal(e.players[0].group3Blocked, true, 'group 2 beat group 1 -> group 3 forfeited');
    const invalidEntry = m2.groupResult.entries.find(entry => entry.seat === 0);
    assert.equal(invalidEntry.invalid, true);
    assert.equal(m2.groupResult.winner, 1, 'the trail is invalid: the point goes to the next strongest group (seat 1, pair of jacks)');
    assert.equal(e.players[0].score, 0, 'the invalid group 2 adds nothing to its owner');
    assert.equal(e.players[1].score, 2);
    // group 3: seat 0 cannot play; the match is decided as soon as seats 1 and 2 have played (this is the case that froze)
    const roundBefore = e.round;
    const m3 = playMatch(e, [2, 2, 2]);
    assert.equal(m3.groupResult.entries.some(entry => entry.seat === 0), false, 'a forfeited group 3 takes no part');
    assert.equal(m3.groupResult.winner, 2, 'colour beats high card');
    assert.equal(e.players[2].score, 1);
    assert.equal(e.round, roundBefore + 1, 'the round is over and the next one is dealt');
    assert.equal(e.actor >= 0, true);
    assert.equal(e.players.every(player => !player.group3Blocked && !player.group2Invalid && player.hand.length === 9), true, 'the rule starts fresh every round');
  }

  // Everybody's group 2 beats their group 1: group 2 has no valid winner, group 3 has nobody who can play -> next round at once.
  {
    const e = fresh(); e.startMatch();
    for (let seat = 0; seat < 3; seat++) setGroups(e, seat, [[c('A', 'S', seat), c('K', 'H', seat), c('9', 'D', seat)], [c('Q', 'S', seat), c('Q', 'H', seat), c('Q', 'D', seat)], [c('7', 'S', seat), c('4', 'H', seat), c('3', 'D', seat)]]);
    e.actor = 0; e.dealer = 2; e.groupCyclePlayed = e.freshCycle();
    playMatch(e, [0, 0, 0]);
    const scoresAfter1 = e.players.map(player => player.score);
    const m2 = playMatch(e, [1, 1, 1]);
    assert.equal(m2.groupResult.winner, null, 'no valid group 2 -> nobody scores');
    assert.deepEqual(e.players.map(player => player.score), scoresAfter1);
    assert.equal(e.round, 2, 'group 3 has nobody who can play, so the round ends straight away');
    assert.equal(e.actor >= 0, true);
  }

  // A packed seat no longer freezes the later group matches of the round.
  {
    const e = fresh(); e.startMatch();
    const first = e.actor;
    e.pack(first);
    let guard = 0;
    while (e.round === 1 && !e.gameOver && guard++ < 20) { const seat = e.actor; assert.equal(seat >= 0, true); const list = e.availableGroupIndices(e.players[seat]); e.play(seat, list[0]); }
    assert.equal(e.round, 2, 'the round finished even though one seat packed');
    assert.equal(e.players[first].score, 0);
  }

  // 600 random games (random group order, packs, timeouts): a seat is always waiting to act, no error is ever thrown, every game ends.
  {
    let finished = 0;
    for (let game = 0; game < 600; game++) {
      const seats = 2 + (game % 5);
      const e = new DeuceEngine({ seats, deckFactory: () => makeDeck(Math.random) });
      e.startMatch();
      let steps = 0;
      while (!e.gameOver && steps++ < 4000) {
        assert.equal(e.actor >= 0 && e.actor < seats, true, 'no seat is waiting to act');
        const seat = e.actor;
        const list = e.availableGroupIndices(e.players[seat]);
        const roll = Math.random();
        if (!list.length || roll < 0.06) e.pack(seat);
        else if (roll < 0.30) e.timeout(seat);
        else e.play(seat, list[Math.floor(Math.random() * list.length)]);
      }
      assert.equal(e.gameOver, true, 'game did not finish');
      finished++;
    }
    assert.equal(finished, 600);
  }
}

// ── First dealer ──────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const e = new DeuceEngine({ seats: 4, firstDealer: 2, computerSeats: [0, 1, 2, 3], deckFactory: () => makeDeck(() => 0) });
  e.startMatch();
  assert.equal(e.dealer, 2, 'the chosen first dealer deals');
  assert.equal(e.actor, 3, 'the seat after the dealer plays first');
  const defaults = new DeuceEngine({ seats: 3, computerSeats: [0, 1, 2], deckFactory: () => makeDeck(() => 0) });
  defaults.startMatch();
  assert.equal(defaults.dealer, 0, 'engine default stays seat 1 (the server picks a random one)');
  const gone = new DeuceEngine({ seats: 4, firstDealer: 1, computerSeats: [0, 1, 2, 3], deckFactory: () => makeDeck(() => 0) });
  gone.removeSeat(1); gone.startMatch();
  assert.notEqual(gone.dealer, 1, 'a seat that already left cannot be the first dealer');
  assert.equal(gone.removedSeats.has(gone.actor), false);
  const bad = new DeuceEngine({ seats: 3, firstDealer: 9 });
  assert.equal(bad.firstDealer, 0, 'an impossible dealer falls back to seat 1');
}

console.log('Deuce engine tests passed');
