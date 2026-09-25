'use strict';

const DEFAULTS = Object.freeze({
  seats: 8,
  startingChips: 5000,
  startingBoot: 10,
  maxBoot: 640,
  bootIncreaseMinutes: 5,
});

function cardKey(card) { return `${card.r}:${card.s}`; }

function makeDeck() {
  const deck = [];
  for (let s = 0; s < 4; s += 1) {
    for (let r = 2; r <= 14; r += 1) deck.push({ r, s });
  }
  return deck;
}

function shuffledDeck(random = Math.random) {
  const deck = makeDeck();
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function sequenceHigh(ranks) {
  if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) return 15;
  if (ranks[0] === ranks[1] + 1 && ranks[1] === ranks[2] + 1) return ranks[0];
  return 0;
}

function evaluateHand(hand) {
  if (!Array.isArray(hand) || hand.length !== 3) throw new Error('A hand must contain exactly three cards');
  const ranks = hand.map(c => c.r).sort((a, b) => b - a);
  const sameSuit = hand.every(c => c.s === hand[0].s);
  const straightHigh = sequenceHigh(ranks);
  if (ranks[0] === ranks[1] && ranks[1] === ranks[2]) return { type: 6, label: 'TRAIL', values: ranks };
  if (sameSuit && straightHigh) return { type: 5, label: 'PURE SEQUENCE', values: [straightHigh] };
  if (straightHigh) return { type: 4, label: 'SEQUENCE', values: [straightHigh] };
  if (sameSuit) return { type: 3, label: 'COLOR', values: ranks };
  if (ranks[0] === ranks[1]) return { type: 2, label: 'PAIR', values: [ranks[0], ranks[2]] };
  if (ranks[1] === ranks[2]) return { type: 2, label: 'PAIR', values: [ranks[1], ranks[0]] };
  return { type: 1, label: 'HIGH CARD', values: ranks };
}

function compareHands(a, b) {
  const left = a.type == null ? evaluateHand(a) : a;
  const right = b.type == null ? evaluateHand(b) : b;
  if (left.type !== right.type) return left.type - right.type;
  const length = Math.max(left.values.length, right.values.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (left.values[i] || 0) - (right.values[i] || 0);
    if (difference) return difference;
  }
  return 0;
}

function nextSeat(index, seats) { return (index + 1) % seats; }
function previousSeat(index, seats) { return (index - 1 + seats) % seats; }

class TeenPattiEngine {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.seats = this.options.seats;
    this.random = options.random || Math.random;
    this.players = Array.from({ length: this.seats }, (_, seat) => ({
      seat,
      name: options.names?.[seat] || `Player${seat + 1}`,
      chips: options.chips?.[seat] ?? this.options.startingChips,
      standing: false,
      folded: false,
      seen: false,
      hand: [],
      bet: 0,
      lastBet: 0,
    }));
    this.round = 0;
    this.dealer = options.dealer ?? Math.floor(this.random() * this.seats);
    this.currentBoot = this.options.startingBoot;
    this.pendingBoot = null;
    this.currentBet = this.currentBoot * 2;
    this.pot = 0;
    this.deck = [];
    this.currentSeat = -1;
    this.lastWinner = null;
    this.roundOver = true;
    this.gameOver = false;
    this.king = null;
    this.pendingSideshow = null;
    this.sideshowAskedSeat = -1;
    this.events = [];
  }

  emit(type, data = {}) { this.events.push({ type, ...data }); }
  drainEvents() { const events = this.events; this.events = []; return events; }
  activeSeats() { return this.players.filter(p => !p.folded && !p.standing); }
  seatsInGame() { return this.players.filter(p => !p.standing && p.chips >= this.currentBoot).map(p => p.seat); }
  moveCost(player) { return player.seen ? this.currentBet : Math.floor(this.currentBet / 2); }
  scheduledBoot(elapsedMs) {
    const level = Math.floor(Math.max(0, elapsedMs) / (this.options.bootIncreaseMinutes * 60 * 1000));
    return Math.min(this.options.startingBoot * (2 ** level), this.options.maxBoot);
  }
  queueBootEscalation(elapsedMs) {
    const target = this.scheduledBoot(elapsedMs);
    if (target > this.currentBoot) this.pendingBoot = target;
    return this.pendingBoot;
  }

  startRound() {
    if (this.gameOver) throw new Error('The match is over');
    if (this.pendingBoot != null) {
      this.currentBoot = this.pendingBoot;
      this.pendingBoot = null;
      this.emit('bootEscalated', { boot: this.currentBoot });
    }
    this.round += 1;
    this.pot = 0;
    this.currentBet = this.currentBoot * 2;
    this.roundOver = false;
    this.pendingSideshow = null;
    this.sideshowAskedSeat = -1;
    this.deck = shuffledDeck(this.random);
    for (const player of this.players) {
      player.hand = [];
      player.seen = false;
      player.bet = 0;
      player.lastBet = 0;
      player.folded = player.standing || player.chips < this.currentBoot;
    }
    const paying = this.players.filter(p => !p.folded);
    if (paying.length < 2) {
      this.roundOver = true;
      this.gameOver = true;
      this.king = paying[0]?.seat ?? this.lastWinner;
      this.emit('matchEnded', { winner: this.king });
      return this.state();
    }
    for (const player of paying) {
      player.chips -= this.currentBoot;
      this.pot += this.currentBoot;
    }
    const order = [];
    let cursor = nextSeat(this.dealer, this.seats);
    for (let i = 0; i < this.seats; i += 1) {
      if (!this.players[cursor].folded) order.push(cursor);
      cursor = nextSeat(cursor, this.seats);
    }
    for (let n = 0; n < 3; n += 1) for (const seat of order) this.players[seat].hand.push(this.deck.pop());
    cursor = nextSeat(this.dealer, this.seats);
    while (this.players[cursor].folded) cursor = nextSeat(cursor, this.seats);
    this.currentSeat = cursor;
    this.emit('handStarted', { round: this.round, dealer: this.dealer, currentSeat: this.currentSeat, boot: this.currentBoot, pot: this.pot });
    return this.state();
  }

  actionsFor(seat) {
    const player = this.players[seat];
    const result = { pack: false, see: false, blind: false, chaal: false, raise: false, show: false, sideshow: false, sideshowTarget: -1 };
    if (!player || player.folded || this.roundOver || this.pendingSideshow) return result;
    result.see = !player.seen;
    if (seat !== this.currentSeat) return result;
    result.pack = true;
    result.blind = !player.seen;
    result.chaal = player.seen;
    result.raise = player.chips >= (player.seen ? this.currentBet * 2 : this.currentBet);
    const active = this.activeSeats();
    result.show = active.length === 2;
    result.sideshowTarget = this.sideshowTarget(seat);
    result.sideshow = player.seen && result.sideshowTarget >= 0 && this.sideshowAskedSeat !== seat && player.chips >= this.moveCost(player);
    return result;
  }

  sideshowTarget(seat) {
    if (this.activeSeats().length <= 2) return -1;
    let cursor = previousSeat(seat, this.seats);
    for (let i = 0; i < this.seats - 1; i += 1) {
      const player = this.players[cursor];
      if (!player.folded && !player.standing) return player.seen ? cursor : -1;
      cursor = previousSeat(cursor, this.seats);
    }
    return -1;
  }

  pay(seat, amount) {
    const player = this.players[seat];
    const paid = Math.max(0, Math.min(amount, player.chips));
    player.chips -= paid;
    player.bet += paid;
    player.lastBet = paid;
    this.pot += paid;
    return paid;
  }

  action(seat, type) {
    const player = this.players[seat];
    if (!player) throw new Error('Unknown seat');
    if (type === 'see') {
      if (player.folded || this.roundOver || player.seen) throw new Error('SEE is not available');
      player.seen = true;
      this.emit('seen', { seat });
      return this.state();
    }
    const available = this.actionsFor(seat);
    if (!available[type]) throw new Error(`Action ${type} is not available for seat ${seat}`);
    if (type === 'pack') {
      this.fold(seat, 'packed');
    } else if (type === 'blind') {
      this.pay(seat, Math.floor(this.currentBet / 2));
      this.advance();
    } else if (type === 'chaal') {
      this.pay(seat, this.currentBet);
      this.advance();
    } else if (type === 'raise') {
      this.currentBet *= 2;
      this.pay(seat, player.seen ? this.currentBet : Math.floor(this.currentBet / 2));
      this.advance();
    } else if (type === 'show') {
      this.pay(seat, this.moveCost(player));
      this.resolveRound(seat);
    } else if (type === 'sideshow') {
      this.sideshowAskedSeat = seat;
      this.pendingSideshow = { asker: seat, target: available.sideshowTarget };
      this.emit('sideshowRequested', { ...this.pendingSideshow });
    }
    return this.state();
  }

  respondSideshow(accept) {
    const request = this.pendingSideshow;
    if (!request) throw new Error('No sideshow request is pending');
    this.pendingSideshow = null;
    if (!accept) {
      this.emit('sideshowDenied', request);
      return this.state();
    }
    const asker = this.players[request.asker];
    const target = this.players[request.target];
    const comparison = compareHands(asker.hand, target.hand);
    const winner = comparison > 0 ? request.asker : request.target; // tie goes to accepter
    const loser = winner === request.asker ? request.target : request.asker;
    this.players[loser].folded = true;
    this.emit('sideshowResolved', { ...request, winner, loser, comparison });
    if (this.activeSeats().length <= 1) this.resolveRound();
    else if (winner === request.asker) this.emit('turnContinues', { seat: request.asker });
    else this.advance();
    return this.state();
  }

  fold(seat, reason = 'packed') {
    const player = this.players[seat];
    if (!player || player.folded) return;
    player.folded = true;
    this.emit('folded', { seat, reason });
    if (this.activeSeats().length <= 1) this.resolveRound();
    else if (seat === this.currentSeat) this.advance();
  }

  timeout(seat) { return this.fold(seat, 'timeout'); }

  advance() {
    if (this.roundOver) return;
    this.sideshowAskedSeat = -1;
    let cursor = this.currentSeat;
    for (let i = 0; i < this.seats; i += 1) {
      cursor = nextSeat(cursor, this.seats);
      if (!this.players[cursor].folded && !this.players[cursor].standing) {
        this.currentSeat = cursor;
        const player = this.players[cursor];
        if (player.chips < this.moveCost(player)) this.fold(cursor, 'cannot afford move');
        else this.emit('turn', { seat: cursor });
        return;
      }
    }
    this.resolveRound();
  }

  resolveRound(caller) {
    if (this.roundOver) return;
    this.roundOver = true;
    const active = this.activeSeats();
    if (!active.length) return;
    let winner = active[0];
    for (const candidate of active.slice(1)) {
      const comparison = compareHands(candidate.hand, winner.hand);
      if (comparison > 0 || (comparison === 0 && caller != null && winner.seat === caller)) winner = candidate;
    }
    const amount = this.pot;
    winner.chips += amount;
    this.pot = 0;
    this.lastWinner = winner.seat;
    this.dealer = winner.seat;
    this.currentSeat = -1;
    this.emit('roundEnded', { winner: winner.seat, amount, showdown: caller != null, hands: caller != null ? active.map(p => ({ seat: p.seat, hand: p.hand, score: evaluateHand(p.hand) })) : undefined });
    const remaining = this.seatsInGame();
    if (remaining.length <= 1) {
      this.gameOver = true;
      this.king = remaining[0] ?? winner.seat;
      this.emit('matchEnded', { winner: this.king });
    }
  }

  standUp(seat) {
    const player = this.players[seat];
    if (!player || player.standing || this.gameOver) throw new Error('Cannot stand up now');
    const surrendered = player.chips;
    player.chips = 0;
    player.standing = true;
    if (this.pendingSideshow && (this.pendingSideshow.asker === seat || this.pendingSideshow.target === seat)) {
      this.emit('sideshowCancelled', { ...this.pendingSideshow, reason: 'stood up' });
      this.pendingSideshow = null;
      this.sideshowAskedSeat = -1;
    }
    if (!this.roundOver && !player.folded) this.fold(seat, 'stood up');
    this.emit('stoodUp', { seat, surrendered });
    if (this.roundOver && this.seatsInGame().length <= 1) {
      this.gameOver = true;
      this.king = this.seatsInGame()[0] ?? this.lastWinner;
      this.emit('matchEnded', { winner: this.king });
    }
    return this.state();
  }

  state() {
    return {
      round: this.round, dealer: this.dealer, currentSeat: this.currentSeat,
      lastWinner: this.lastWinner,
      currentBoot: this.currentBoot, pendingBoot: this.pendingBoot, currentBet: this.currentBet,
      pot: this.pot, roundOver: this.roundOver, gameOver: this.gameOver, king: this.king,
      pendingSideshow: this.pendingSideshow ? { ...this.pendingSideshow } : null,
      sideshowAskedSeat: this.sideshowAskedSeat,
      players: this.players.map(p => ({ ...p, hand: p.hand.map(c => ({ ...c })) })),
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ options: this.options, seats: this.seats, ...this.state(), deck: this.deck }));
  }

  static restore(snapshot, options = {}) {
    const engine = new TeenPattiEngine({ ...snapshot.options, ...options, seats: snapshot.seats });
    Object.assign(engine, {
      round: snapshot.round, dealer: snapshot.dealer, currentSeat: snapshot.currentSeat,
      currentBoot: snapshot.currentBoot, pendingBoot: snapshot.pendingBoot, currentBet: snapshot.currentBet,
      pot: snapshot.pot, roundOver: snapshot.roundOver, gameOver: snapshot.gameOver, king: snapshot.king,
      pendingSideshow: snapshot.pendingSideshow, deck: snapshot.deck || [], lastWinner: snapshot.lastWinner ?? null,
      sideshowAskedSeat: snapshot.sideshowAskedSeat ?? -1,
    });
    engine.players = snapshot.players.map(p => ({ ...p, hand: p.hand.map(c => ({ ...c })) }));
    return engine;
  }
}

module.exports = { TeenPattiEngine, evaluateHand, compareHands, makeDeck, shuffledDeck, cardKey };
