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
assert.equal(packedEngine.currentGroupIndex, 1);
assert.equal(packedEngine.players.every(player => player.packed), true);

console.log('Deuce engine tests passed');
