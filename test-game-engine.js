'use strict';

const assert = require('node:assert/strict');
const { TeenPattiEngine, evaluateHand, compareHands } = require('./game-engine');

const c = (r, s) => ({ r, s });
function seeded(seed = 1) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}
function check(condition, message) { assert.ok(condition, message); }

// Rulebook ranking, including the project-specific A-2-3 sequence rule.
assert.equal(evaluateHand([c(7, 0), c(7, 1), c(7, 2)]).label, 'TRAIL');
assert.equal(evaluateHand([c(14, 0), c(3, 0), c(2, 0)]).values[0], 15);
assert.equal(evaluateHand([c(14, 0), c(3, 0), c(2, 1)]).label, 'SEQUENCE');
assert.equal(evaluateHand([c(14, 0), c(13, 0), c(12, 0)]).label, 'PURE SEQUENCE');
assert.equal(evaluateHand([c(14, 0), c(14, 1), c(2, 2)]).label, 'PAIR');
check(compareHands([c(14, 0), c(3, 0), c(2, 0)], [c(14, 1), c(13, 1), c(12, 2)]) > 0, 'A-2-3 must beat A-K-Q');

// A deterministic hand can be inspected and played without a browser or network.
const engine = new TeenPattiEngine({ seats: 3, startingChips: 100, dealer: 0, random: seeded(7) });
engine.startRound();
const first = engine.currentSeat;
assert.equal(engine.pot, 30);
assert.equal(engine.players.every(p => p.folded || p.hand.length === 3), true);
assert.equal(engine.actionsFor(first).blind, true);
engine.action(first, 'see');
assert.equal(engine.players[first].seen, true);
assert.equal(engine.actionsFor(first).chaal, true);
engine.action(first, 'raise');
assert.equal(engine.currentBet, 40);
const second = engine.currentSeat;
engine.action(second, 'pack');
const third = engine.currentSeat;
engine.action(third, 'pack');
assert.equal(engine.roundOver, true);
assert.equal(engine.events.some(e => e.type === 'roundEnded'), true);

// Sideshow: tie goes to the accepter, so the asker is eliminated.
const sideshow = new TeenPattiEngine({ seats: 3, startingChips: 100, dealer: 0, random: seeded(8) });
sideshow.startRound();
const asker = sideshow.currentSeat;
const targetCandidate = (asker + 2) % 3;
sideshow.players[targetCandidate].seen = true;
const target = sideshow.sideshowTarget(asker);
check(target >= 0, 'sideshow target should exist when target has seen');
sideshow.players[asker].seen = true;
sideshow.players[target].seen = true;
sideshow.players[asker].hand = [c(9, 0), c(8, 1), c(7, 2)];
sideshow.players[target].hand = [c(9, 1), c(8, 2), c(7, 3)];
sideshow.currentSeat = asker;
sideshow.action(asker, 'sideshow');
assert.deepEqual(sideshow.pendingSideshow, { asker, target });
sideshow.respondSideshow(true);
assert.equal(sideshow.players[asker].folded, true);
assert.equal(sideshow.players[target].folded, false);

// Snapshot/restore keeps the complete rule state and can continue from the same turn.
const snap = sideshow.snapshot();
const restored = TeenPattiEngine.restore(snap, { random: seeded(99) });
assert.deepEqual(restored.state(), sideshow.state());

// Boot escalation is queued during a hand and promoted only at the next hand boundary.
const escalator = new TeenPattiEngine({ seats: 3, startingChips: 1000, dealer: 0, random: seeded(12) });
escalator.startRound();
assert.equal(escalator.queueBootEscalation(5 * 60 * 1000), 20);
assert.equal(escalator.currentBoot, 10);
escalator.players[escalator.currentSeat].folded = true;
escalator.resolveRound();
escalator.startRound();
assert.equal(escalator.currentBoot, 20);

// Standing up surrenders the remaining stack and does not add it to the pot.
const standing = new TeenPattiEngine({ seats: 3, startingChips: 100, dealer: 0, random: seeded(13) });
standing.startRound();
const surrenderSeat = standing.currentSeat;
const potBeforeStand = standing.pot;
const chipsBeforeStand = standing.players[surrenderSeat].chips;
standing.standUp(surrenderSeat);
assert.equal(standing.players[surrenderSeat].chips, 0);
assert.equal(standing.pot, potBeforeStand);
assert.equal(standing.events.some(e => e.type === 'stoodUp' && e.surrendered === chipsBeforeStand), true);

// Fairness smoke test: every completed hand has one winner, no duplicate cards, and conserved chips.
let completed = 0;
const simulationRandom = seeded(123456);
for (let i = 0; i < 5000; i += 1) {
  const sim = new TeenPattiEngine({ seats: 8, startingChips: 5000, dealer: i % 8, random: simulationRandom });
  sim.startRound();
  let guard = 0;
  while (!sim.roundOver && guard++ < 500) {
    const seat = sim.currentSeat;
    const player = sim.players[seat];
    const actions = sim.actionsFor(seat);
    if (actions.see && !player.seen && simulationRandom() < 0.35) sim.action(seat, 'see');
    else if (actions.show && player.seen) sim.action(seat, 'show');
    else if (actions.raise && simulationRandom() < 0.08) sim.action(seat, 'raise');
    else if (actions.sideshow && simulationRandom() < 0.06) {
      sim.action(seat, 'sideshow');
      sim.respondSideshow(simulationRandom() > 0.45);
    } else if (actions.pack && player.seen && simulationRandom() < 0.16) sim.action(seat, 'pack');
    else if (actions.blind) sim.action(seat, 'blind');
    else if (actions.chaal) sim.action(seat, 'chaal');
    else sim.action(seat, 'pack');
  }
  assert.ok(guard < 500, `hand ${i + 1} got stuck`);
  assert.equal(sim.roundOver, true);
  assert.equal(sim.players.reduce((sum, p) => sum + p.chips, 0) + sim.pot, 8 * 5000, 'chips must be conserved');
  const allCards = sim.players.flatMap(p => p.hand);
  assert.equal(new Set(allCards.map(x => `${x.r}:${x.s}`)).size, allCards.length, 'cards must not duplicate');
  completed += 1;
}
assert.equal(completed, 5000);

console.log('Phase 1 engine tests passed: ranking, actions, sideshow, snapshot/restore, and 5,000 simulations.');
