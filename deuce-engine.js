'use strict';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['S', 'H', 'D', 'C'];
const SEATS = 6;
const GROUPS_PER_HAND = 3;
const CARDS_PER_PLAYER = 9;
const WINNING_SCORE = 9;

function cloneCard(card) { return { ...card }; }
function rankValue(rank) { return RANKS.indexOf(rank) + 2; }
function isExtraJoker(card) { return card?.id === '2S-J1' || card?.id === '2S-J2'; }
function isJoker(card) { return !!card && (card.joker === true || card.id === '2S' || isExtraJoker(card)); }

function makeDeck(random = Math.random) {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) {
    deck.push({ id: rank + suit, rank, suit, joker: rank === '2' && suit === 'S' });
  }
  deck.push({ id: '2S-J1', rank: '2', suit: 'S', joker: true });
  deck.push({ id: '2S-J2', rank: '2', suit: 'S', joker: true });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function naturalCard(rank, suit) {
  return { id: rank + suit, rank, suit, joker: false };
}

function straightHigh(cards) {
  const values = cards.map(card => rankValue(card.rank)).sort((a, b) => a - b);
  if (new Set(values).size !== 3) return null;
  if (values[0] === 2 && values[1] === 3 && values[2] === 14) return 15; // A23
  if (values[0] + 1 === values[1] && values[1] + 1 === values[2]) return values[2];
  return null;
}

function evaluateNatural(cards) {
  const values = cards.map(card => rankValue(card.rank)).sort((a, b) => b - a);
  const counts = {};
  cards.forEach(card => { counts[card.rank] = (counts[card.rank] || 0) + 1; });
  const unique = Object.keys(counts);
  if (unique.length === 1) return { cat: 6, name: 'Trail', tie: [values[0]], natural: true, jokerUsed: false };
  const straight = straightHigh(cards);
  const sameSuit = cards.every(card => card.suit === cards[0].suit);
  if (straight !== null && sameSuit) return { cat: 5, name: 'Pure Sequence', tie: [straight], natural: true, jokerUsed: false };
  if (straight !== null) return { cat: 4, name: 'Sequence', tie: [straight], natural: true, jokerUsed: false };
  if (sameSuit) return { cat: 3, name: 'Colour', tie: values, natural: true, jokerUsed: false };
  if (unique.length === 2) {
    const pairRank = rankValue(unique.find(rank => counts[rank] === 2));
    const kick = values.find(value => value !== pairRank);
    return { cat: 2, name: 'Pair', tie: [pairRank, kick], natural: true, jokerUsed: false };
  }
  return { cat: 1, name: 'High Card', tie: values, natural: true, jokerUsed: false };
}

function compareEval(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const length = Math.max(a.tie.length, b.tie.length);
  for (let i = 0; i < length; i++) {
    const diff = (a.tie[i] || 0) - (b.tie[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) throw new Error('A Deuce group must contain exactly three cards.');
  const jokerCount = cards.filter(isJoker).length;
  if (!jokerCount) return evaluateNatural(cards);
  const fixed = cards.filter(card => !isJoker(card));
  const specialTwoTrail = jokerCount === 1 && cards.some(card => card.id === '2S') && fixed.length === 2 && fixed.every(card => card.rank === '2');
  if (specialTwoTrail) return { cat: 6, name: 'Trail', tie: [2], natural: false, jokerUsed: true, cards: cards.map(cloneCard) };
  const candidates = [];
  const all = [];
  for (const suit of SUITS) for (const rank of RANKS) all.push(naturalCard(rank, suit));
  function chooseJokers(index, chosen) {
    if (index === jokerCount) {
      const used = new Set(fixed.map(card => card.id));
      if (chosen.some(card => used.has(card.id))) return;
      const full = fixed.concat(chosen);
      const result = evaluateNatural(full);
      if (result.cat === 6) return;
      candidates.push({ ...result, natural: false, jokerUsed: true, cards: full });
      return;
    }
    for (const card of all) {
      if (chosen.some(existing => existing.id === card.id) || fixed.some(existing => existing.id === card.id)) continue;
      chooseJokers(index + 1, chosen.concat(card));
    }
  }
  chooseJokers(0, []);
  if (!candidates.length) return { cat: 1, name: 'High Card', tie: [0, 0, 0], natural: false, jokerUsed: true };
  return candidates.reduce((best, result) => !best || compareEval(result, best) > 0 ? result : best, null);
}

function partitionCompare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || [], y = b[i] || [];
    for (let j = 0; j < Math.max(x.length, y.length); j++) {
      const diff = (x[j] || 0) - (y[j] || 0);
      if (diff) return diff;
    }
  }
  return 0;
}

function bestPartition(cards) {
  if (!Array.isArray(cards) || cards.length !== CARDS_PER_PLAYER) throw new Error('A Deuce hand must contain nine cards.');
  const indices = [...Array(cards.length).keys()];
  const groupsA = [];
  function choose(start, count, prefix, output) {
    if (count === 0) { output.push(prefix.slice()); return; }
    for (let i = start; i <= indices.length - count; i++) {
      prefix.push(i); choose(i + 1, count - 1, prefix, output); prefix.pop();
    }
  }
  choose(0, 3, [], groupsA);
  let best = null;
  for (const groupA of groupsA) {
    const remaining = indices.filter(index => !groupA.includes(index));
    for (let bi = 0; bi < remaining.length - 2; bi++) for (let bj = bi + 1; bj < remaining.length - 1; bj++) for (let bk = bj + 1; bk < remaining.length; bk++) {
      const groupB = [remaining[bi], remaining[bj], remaining[bk]];
      const groupC = remaining.filter(index => !groupB.includes(index));
      if (groupA[0] !== Math.min(...groupA) || groupB[0] !== Math.min(...groupB)) continue;
      const groups = [groupA, groupB, groupC].map(group => group.map(index => cards[index]));
      const score = groups.map(group => evaluate(group)).sort((a, b) => compareEval(b, a)).map(result => [result.cat, ...result.tie]);
      if (!best || partitionCompare(score, best.score) > 0) best = { groups, score };
    }
  }
  return best?.groups || [cards.slice(0, 3), cards.slice(3, 6), cards.slice(6, 9)];
}

function scrubEval(result) {
  return result ? { cat: result.cat, name: result.name, tie: result.tie.slice(), natural: !!result.natural, jokerUsed: !!result.jokerUsed } : null;
}

class DeuceEngine {
  constructor({ seats = SEATS, names = [], computerSeats = [], deckFactory = makeDeck, deck = null, firstDealer = 0 } = {}) {
    if (!Number.isInteger(seats) || seats < 2 || seats > SEATS) throw new Error('Deuce supports 2 to 6 seats.');
    this.seats = seats;
    this.names = Array.from({ length: seats }, (_, i) => String(names[i] || `Player${i + 1}`));
    this.computerSeats = new Set(computerSeats.map(Number));
    this.removedSeats = new Set();                // seats that left the game (admin kick or Stand Up): they sit out for the rest of the match
    this.firstDealer = Number.isInteger(firstDealer) && firstDealer >= 0 && firstDealer < seats ? firstDealer : 0;
    this.deckFactory = deckFactory;
    this.fixedDeck = deck;
    this.round = 0;
    this.hand = 1;
    this.dealer = 0;
    this.actor = -1;
    this.currentGroupIndex = 0;
    this.gameOver = false;
    this.winner = null;
    this.players = Array.from({ length: seats }, (_, seat) => this.newPlayer(seat));
    this.currentGroups = Array.from({ length: seats }, () => null);
    this.groupCyclePlayed = new Set();
  }

  newPlayer(seat) {
    return { seat, name: this.names[seat], score: 0, hand: [], groups: [], played: [], current: null, packed: false, group2Invalid: false, group3Blocked: false, removed: false };
  }

  activeSeats() { return this.players.filter(player => !this.removedSeats.has(player.seat)).map(player => player.seat); }
  canPlay(seat) { const player = this.players[seat]; return !!player && !this.removedSeats.has(seat) && !player.packed && this.availableGroupIndices(player).length > 0; }
  // A group match starts with every seat that cannot play in it already counted as done: removed seats, packed seats and
  // seats whose group 3 was forfeited (their group 2 beat their group 1). The group is decided once everyone else has played.
  freshCycle() { return new Set(this.players.map(player => player.seat).filter(seat => !this.canPlay(seat))); }
  nextActiveAfter(from) {
    for (let offset = 1; offset <= this.seats; offset++) { const seat = (from + offset) % this.seats; if (!this.removedSeats.has(seat)) return seat; }
    return -1;
  }

  startRound() {
    if (this.gameOver) throw new Error('The match is already over.');
    this.round += 1;
    this.currentGroupIndex = 0;
    this.currentGroups = Array.from({ length: this.seats }, () => null);
    this.groupCyclePlayed = new Set();
    const active = this.activeSeats();
    const deck = this.fixedDeck ? this.fixedDeck.map(cloneCard) : this.deckFactory();
    if (deck.length < active.length * CARDS_PER_PLAYER) throw new Error('Not enough cards to deal.');
    this.players.forEach(player => {
      player.hand = [];
      player.groups = [];
      player.played = [];
      player.current = null;
      player.packed = false;
      player.group2Invalid = false;
      player.group3Blocked = false;
    });
    for (let cardIndex = 0; cardIndex < CARDS_PER_PLAYER; cardIndex++) {
      active.forEach((seat, position) => this.players[seat].hand.push(deck[cardIndex * active.length + position]));
    }
    for (const seat of this.removedSeats) { const gone = this.players[seat]; gone.packed = true; gone.groups = [null, null, null]; }
    for (const player of this.players) {
      if (this.removedSeats.has(player.seat)) continue;
      player.groups = this.computerSeats.has(player.seat) ? bestPartition(player.hand) : [player.hand.slice(0, 3), player.hand.slice(3, 6), player.hand.slice(6, 9)];
    }
    this.groupCyclePlayed = this.freshCycle();
    if (this.removedSeats.has(this.dealer)) this.dealer = this.nextActiveAfter(this.dealer);
    this.actor = this.nextActiveAfter(this.dealer);
    return this.state();
  }

  startMatch() {
    this.round = 0;
    this.hand = 1;
    this.gameOver = false;
    this.winner = null;
    this.dealer = this.firstDealer;
    this.players.forEach(player => { player.score = 0; });
    return this.startRound();
  }

  assertSeat(seat) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.seats) throw new Error('Invalid seat.');
    return this.players[seat];
  }

  assertTurn(seat) {
    if (this.gameOver) throw new Error('The match is over.');
    if (seat !== this.actor || this.groupCyclePlayed.has(seat)) throw new Error('It is not this player\'s turn.');
    const player = this.assertSeat(seat);
    if (player.packed) throw new Error('This player has packed.');
    return player;
  }

  group(seat, cardIds) {
    const player = this.assertSeat(seat);
    if (player.packed) throw new Error('This player has packed.');
    if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 9 || new Set(cardIds).size !== cardIds.length) throw new Error('Invalid grouping selection.');
    const all = player.groups.flat().filter(Boolean);
    const byId = new Map(all.map(card => [card.id, card]));
    const selected = cardIds.map(id => byId.get(id));
    if (selected.some(card => !card)) throw new Error('A selected card is not available.');
    const selectedIds = new Set(cardIds);
    const remaining = all.filter(card => !selectedIds.has(card.id));
    const ordered = selected.concat(remaining);
    player.groups = [ordered.slice(0, 3), ordered.slice(3, 6), ordered.slice(6, 9)];
    return this.state(seat);
  }

  availableGroupIndices(player) {
    return player.groups.map((group, index) => group && group.length === 3 && !(index === 2 && player.group3Blocked) ? index : -1).filter(index => index >= 0);
  }

  play(seat, groupIndex) {
    const player = this.assertTurn(seat);
    if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex >= GROUPS_PER_HAND) throw new Error('Invalid group.');
    const group = player.groups[groupIndex];
    if (!group || group.length !== 3 || (groupIndex === 2 && player.group3Blocked)) throw new Error('That group is not playable.');
    const result = evaluate(group);
    player.groups[groupIndex] = null;
    player.played.push({ group: group.map(cloneCard), eval: result, groupIndex });
    player.current = { group: group.map(cloneCard), eval: result, groupIndex, invalid: false };
    this.currentGroups[seat] = player.current;
    if (groupIndex === 1) {
      const first = player.played.find(item => item.groupIndex === 0);
      if (first && compareEval(result, first.eval) > 0) {
        player.group2Invalid = true;
        player.group3Blocked = true;
        player.current.invalid = true;
        player.groups[2] = null;
      }
    }
    this.groupCyclePlayed.add(seat);
    return this.finishTurn();
  }

  pack(seat) {
    const player = this.assertTurn(seat);
    player.packed = true;
    player.groups = [null, null, null];
    player.played = [{ group: [], eval: null, groupIndex: 0 }, { group: [], eval: null, groupIndex: 1 }, { group: [], eval: null, groupIndex: 2 }];
    this.groupCyclePlayed.add(seat);
    return this.finishTurn();
  }

  timeout(seat) {
    const player = this.assertTurn(seat);
    const available = this.availableGroupIndices(player);
    if (!available.length) return this.pack(seat);
    return this.play(seat, available[0]);
  }

  // The admin kicked this seat: it leaves the game for good (its cards are gone, it is skipped in every turn and deal).
  // If that leaves fewer than two seats at the table, the match ends and the seat that is left wins.
  removeSeat(seat) {
    const player = this.assertSeat(seat);
    if (this.removedSeats.has(seat)) return this.state();
    this.removedSeats.add(seat);
    player.removed = true; player.packed = true; player.hand = []; player.groups = [null, null, null]; player.played = []; player.current = null;
    this.currentGroups[seat] = null;
    if (this.gameOver) return this.state();
    const active = this.activeSeats();
    if (active.length <= 1) {
      this.gameOver = true; this.winner = active.length ? active[0] : null; this.actor = -1;
      return { ...this.state(), gameOver: true, winner: this.winner };
    }
    this.groupCyclePlayed.add(seat);
    if (this.actor < 0) return this.state();                       // not dealt yet - nothing else to do
    if (this.actor === seat || this.groupCyclePlayed.size >= this.seats) return this.finishTurn();   // it was their turn, or everyone else had already played
    return this.state();
  }

  nextToAct() {
    for (let offset = 1; offset <= this.seats; offset++) {
      const next = (this.actor + offset) % this.seats;
      if (!this.groupCyclePlayed.has(next) && this.canPlay(next)) return next;
    }
    return -1;
  }

  // Called after a seat has played or packed. The group match is decided as soon as every seat that CAN play it has played;
  // it never waits for a seat that has nothing left to play (a forfeited group 3, a packed or removed seat).
  finishTurn() {
    if (this.groupCyclePlayed.size >= this.seats) return this.resolveGroupMatch();
    const next = this.nextToAct();
    if (next < 0) return this.resolveGroupMatch();
    this.actor = next;
    return this.state();
  }

  resolveGroupMatch() {
    const entries = this.currentGroups.map((current, seat) => current?.group?.length ? { seat, ...current } : null).filter(Boolean);
    const valid = entries.filter(entry => !entry.invalid);
    let winner = null;
    if (valid.length) {
      valid.sort((a, b) => compareEval(b.eval, a.eval));
      if (valid.length === 1 || compareEval(valid[0].eval, valid[1].eval) !== 0) winner = valid[0].seat;
    }
    if (winner != null) this.players[winner].score += 1;
    const result = { groupIndex: this.currentGroupIndex, entries: entries.map(entry => ({ seat: entry.seat, group: entry.group.map(cloneCard), eval: scrubEval(entry.eval), invalid: !!entry.invalid })), winner, scores: this.players.map(player => player.score) };
    if (winner != null && this.players[winner].score >= WINNING_SCORE) {
      this.gameOver = true;
      this.winner = winner;
      return { ...this.state(), groupResult: result, gameOver: true, winner };
    }
    this.dealer = winner == null ? this.dealer : winner;
    if (this.currentGroupIndex >= GROUPS_PER_HAND - 1) {
      const next = this.startRound();
      return { ...next, groupResult: result, roundComplete: true };
    }
    this.currentGroupIndex += 1;
    this.currentGroups = Array.from({ length: this.seats }, () => null);
    this.groupCyclePlayed = this.freshCycle();
    if (this.groupCyclePlayed.size >= this.seats) {                 // nobody can play this group (all forfeited / packed): nothing to decide
      const onward = this.resolveGroupMatch();
      return { ...onward, groupResult: result };                    // players keep seeing the last real group result
    }
    this.actor = this.nextPlayableSeat(this.dealer);
    return { ...this.state(), groupResult: result };
  }

  nextPlayableSeat(from) {
    for (let offset = 1; offset <= this.seats; offset++) {
      const seat = (from + offset) % this.seats;
      if (!this.players[seat].packed && this.availableGroupIndices(this.players[seat]).length) return seat;
    }
    return -1;
  }

  state(viewSeat = null) {
    return {
      round: this.round, hand: this.hand, dealer: this.dealer, actor: this.actor, currentGroupIndex: this.currentGroupIndex,
      gameOver: this.gameOver, winner: this.winner,
      players: this.players.map(player => ({
        seat: player.seat, name: player.name, score: player.score, packed: player.packed, removed: !!player.removed, group2Invalid: player.group2Invalid, group3Blocked: player.group3Blocked,
        current: this.currentGroups[player.seat] ? { group: this.currentGroups[player.seat].group.map(cloneCard), eval: scrubEval(this.currentGroups[player.seat].eval), groupIndex: this.currentGroups[player.seat].groupIndex, invalid: !!this.currentGroups[player.seat].invalid } : null,
        hand: viewSeat === player.seat ? player.hand.map(cloneCard) : null,
        groups: viewSeat === player.seat ? player.groups.map(group => group ? group.map(cloneCard) : null) : null,
        actions: viewSeat === player.seat && !this.gameOver && !player.packed && player.seat === this.actor ? { group: true, play: this.availableGroupIndices(player), pack: true } : undefined,
      })),
    };
  }

  snapshot() {
    return {
      seats: this.seats, names: this.names.slice(), computerSeats: [...this.computerSeats], round: this.round, hand: this.hand,
      dealer: this.dealer, actor: this.actor, currentGroupIndex: this.currentGroupIndex, gameOver: this.gameOver, winner: this.winner,
      groupCyclePlayed: [...this.groupCyclePlayed], removedSeats: [...this.removedSeats], currentGroups: this.currentGroups,
      players: this.players,
    };
  }

  static restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.players)) throw new Error('Invalid Deuce snapshot.');
    const engine = new DeuceEngine({ seats: snapshot.seats, names: snapshot.names, computerSeats: snapshot.computerSeats });
    for (const key of ['round', 'hand', 'dealer', 'actor', 'currentGroupIndex', 'gameOver', 'winner']) {
      if (snapshot[key] !== undefined) engine[key] = snapshot[key];
    }
    engine.groupCyclePlayed = new Set(snapshot.groupCyclePlayed || []);
    engine.currentGroups = snapshot.currentGroups || Array.from({ length: engine.seats }, () => null);
    engine.players = snapshot.players;
    engine.removedSeats = new Set(Array.isArray(snapshot.removedSeats) ? snapshot.removedSeats.map(Number) : snapshot.players.filter(player => player.removed).map(player => player.seat));
    return engine;
  }
}

module.exports = {
  RANKS, SUITS, SEATS, GROUPS_PER_HAND, CARDS_PER_PLAYER, WINNING_SCORE,
  makeDeck, isJoker, evaluate, compareEval, bestPartition, DeuceEngine,
};
