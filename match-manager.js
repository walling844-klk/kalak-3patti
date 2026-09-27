'use strict';

const { TeenPattiEngine, evaluateHand, compareHands, makeDeck } = require('./game-engine');

const TURN_TIMEOUT_MS = 30_000;
const NEXT_ROUND_DELAY_MS = 7_500;
const SIDESHOW_RESPONSE_MS = 15_000;
const SIDESHOW_REVEAL_MS = 7_000;
const LIFECYCLE_TICK_MS = 1_000;
const BOT_TURN_DELAY_MS = 450;
const RETURN_WINDOW_MS = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS = 30_000;
const BOT_TAKEOVER_ROUNDS = 3;

function istDateString(now = Date.now()) {
  // Use the IST calendar date for time-only schedules. UTC can still be on
  // the previous day while the owner is already on the next IST day.
  return new Date(now + (5.5 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function scheduledStartMs(config) {
  if (!config || (!config.matchStartDate && !config.matchStartTime)) return null;
  const date = config.matchStartDate || istDateString();
  let time = config.matchStartTime || '00:00';
  if (time.length === 5) time += ':00';
  const parsed = Date.parse(`${date}T${time}+05:30`);
  // null means “no schedule configured”; malformed saved schedules must not
  // be treated as an immediate start by the caller.
  return Number.isFinite(parsed) ? parsed : NaN;
}

class MatchManager {
  constructor({ getConfig, saveConfig, loadSnapshot, saveSnapshot, deleteSnapshot, realtime, audit = () => {} }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.loadSnapshot = loadSnapshot;
    this.saveSnapshot = saveSnapshot;
    this.deleteSnapshot = deleteSnapshot;
    this.realtime = realtime;
    this.audit = audit;
    this.metrics = { actions: 0, timeouts: 0, botActions: 0, reconnects: 0, automaticKicks: 0, invariantFailures: 0 };
    this.totalChips = null;
    this.carryPot = 0;
    this.engine = null;
    this.started = false;
    this.starting = false;
    this.restoring = false;
    this.roundStartedAt = 0;
    this.connectedSeats = new Set();
    this.computerSeats = new Set();
    this.restrictedBotSeats = new Set();
    this.botPeekTimers = new Map();
    this.absences = new Map();
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnSeat = null;
    this.nextRoundTimer = null;
    this.botTimer = null;
    this.sideshowTimer = null;
    this.sideshowDeadline = null;
    this.sideshowPhase = null;
    this.nextRoundDeadline = null;
    this.lifecycleTimer = setInterval(() => this.lifecycleTick().catch(error => console.error('Match lifecycle failed:', error.message)), LIFECYCLE_TICK_MS);
    this.lifecycleTimer.unref();
    this.persisting = Promise.resolve();
  }

  async lifecycleTick() {
    await this.expireAbsences();
    if (this.started || this.starting || this.restoring) return;
    await this.maybeStart();
  }

  async restoreIfPresent() {
    this.restoring = true;
    const snapshot = await this.loadSnapshot();
    const config = await this.getConfig();
    if (!snapshot || !config || config.status === 'ended') {
      this.restoring = false;
      return false;
    }
    this.engine = TeenPattiEngine.restore(snapshot);
    this.roundStartedAt = 0;
    this.carryPot = Number(snapshot.carryPot) || 0;
    this.totalChips = snapshot.totalChips ?? this.engine.players.reduce((sum, player) => sum + player.chips, 0) + this.engine.pot + this.carryPot;
    this.absences = new Map(Array.isArray(snapshot.absences) ? snapshot.absences.map(item => [item.seat, { ...item, connected: false }]) : []);
    const restartNow = Date.now();
    for (const seat of this.humanSeats(config)) {
      if (!this.absences.has(seat)) this.absences.set(seat, { seat, disconnectedAt: restartNow, botEligibleAt: restartNow + DISCONNECT_GRACE_MS, deadline: null, missedRounds: 0, timeoutStreak: 0, timedOutThisRound: false, restricted: false, botControlled: false, connected: false });
    }
    this.computerSeats = new Set((config.players || []).filter(p => p.type === 'computer' && !p.kicked).map(p => p.seat - 1));
    this.restrictedBotSeats = new Set((this.absences.size ? [...this.absences.values()] : []).filter(item => item.restricted).map(item => item.seat));
    this.started = true;
    this.restoring = false;
    await this.setStatus('live');
    this.syncSideshowTimer();
    this.armTurnTimer();
    this.broadcastState();
    this.maybeBotTurn();
    return true;
  }

  humanSeats(config) {
    return (config?.players || []).filter(p => p.type === 'human' && !p.kicked).map(p => p.seat - 1);
  }

  playableSeats(config) {
    return (config?.players || []).filter(p => !p.kicked).map(p => p.seat - 1);
  }

  register(client) {
    if (client.role !== 'player' || client.seat == null) return;
    const seat = client.seat - 1;
    this.connectedSeats.add(seat);
    if (this.started) this.metrics.reconnects += this.absences.has(seat) ? 1 : 0;
    const absence = this.absences.get(seat);
    if (absence) {
      clearTimeout(this.botTimer);
      absence.returnedAt = Date.now();
      absence.connected = true;
      absence.botControlled = false;
      this.absences.delete(seat);
      this.computerSeats.delete(seat);
      this.audit('player_returned', { seat: seat + 1 });
    }
    if (!this.started) this.maybeStart().catch(error => console.error('Match start failed:', error.message));
    else this.sendState(client);
  }

  unregister(client) {
    if (client.role !== 'player' || client.seat == null) return;
    const seat = client.seat - 1;
    if (this.realtime?.sessions?.get(client.seat) && this.realtime.sessions.get(client.seat) !== client) return;
    this.connectedSeats.delete(seat);
    if (this.started && this.engine && !this.engine.gameOver) {
      const existing = this.absences.get(seat);
      const now = Date.now();
      const absence = existing || { seat, disconnectedAt: now, botEligibleAt: now + DISCONNECT_GRACE_MS, deadline: null, missedRounds: 0, timeoutStreak: 0, timedOutThisRound: false, restricted: false, botControlled: false };
      absence.disconnectedAt = absence.disconnectedAt || now;
      absence.botEligibleAt = absence.botEligibleAt || now + DISCONNECT_GRACE_MS;
      absence.connected = false;
      this.absences.set(seat, absence);
      this.audit('player_absent', { seat: seat + 1, botEligibleAt: absence.botEligibleAt });
      this.broadcastState();
    }
  }

  async expireAbsences() {
    if (!this.started || !this.engine || this.engine.gameOver) return;
    const now = Date.now();
    for (const [seat, absence] of this.absences) {
      if (absence.connected) continue;
      if (!absence.botControlled && absence.botEligibleAt && now >= absence.botEligibleAt) {
        absence.botControlled = true;
        absence.restricted = true;
        absence.deadline = now + RETURN_WINDOW_MS;
        this.computerSeats.add(seat);
        this.restrictedBotSeats.add(seat);
        this.audit('restricted_bot_started', { seat: seat + 1, deadline: absence.deadline });
        this.broadcastState();
        this.maybeBotTurn();
      }
      if (absence.botControlled && absence.deadline && now >= absence.deadline) await this.kickAbsentSeat(seat, absence);
    }
  }

  async kickAbsentSeat(seat, absence) {
    if (!this.engine || !this.absences.has(seat)) return;
    const player = this.engine.players[seat];
    if (!player || player.standing) { this.absences.delete(seat); return; }
    if (this.engine.currentSeat === seat && !this.engine.roundOver) this.engine.timeout(seat);
    const share = player.chips;
    const recipients = this.engine.players.filter(p => p.seat !== seat && !p.standing && !p.folded && p.chips >= this.engine.currentBoot);
    let each = 0;
    let remainder = share;
    if (share > 0 && recipients.length) {
      each = Math.floor((share / recipients.length) / 10) * 10;
      remainder = share - each * recipients.length;
      for (const recipient of recipients) recipient.chips += each;
      if (this.engine.roundOver) this.carryPot += remainder;
      else this.engine.pot += remainder;
      player.chips = 0;
    } else if (share > 0) {
      if (this.engine.roundOver) this.carryPot += share;
      else this.engine.pot += share;
      player.chips = 0;
    }
    player.standing = true;
    player.folded = true;
    this.absences.delete(seat);
    this.computerSeats.delete(seat);
    this.metrics.automaticKicks += 1;
    this.audit('automatic_kick', { seat: seat + 1, sharedChips: share, recipients: recipients.map(p => p.seat + 1), shareEach: each, remainder });
    if (this.realtime?.clients) {
      const message = { t: 'chipShare', seat: seat + 1, amount: share, recipients: recipients.map(p => p.seat + 1), each, remainder };
      for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
    }
    const config = await this.getConfig();
    if (config) {
      const next = { ...config, players: config.players.map(p => p.seat === seat + 1 ? { ...p, kicked: true } : p) };
      await this.saveConfig(next);
      if (this.realtime?.broadcastLobby) this.realtime.broadcastLobby(next);
    }
    await this.afterAction();
  }

  async allRequiredPlayersReady() {
    const config = await this.getConfig();
    const playable = this.playableSeats(config);
    return playable.length >= 2;
  }

  async startTimeReached() {
    const config = await this.getConfig();
    const start = scheduledStartMs(config);
    if (start === null) return true;
    if (!Number.isFinite(start)) return false;
    return Date.now() >= start;
  }

  async maybeStart() {
    return this.startMatch(false);
  }

  async startNow() {
    return this.startMatch(true);
  }

  async startMatch(force) {
    if (this.started || this.starting || this.restoring) return false;
    if (!(await this.allRequiredPlayersReady()) || (!force && !(await this.startTimeReached()))) return false;
    this.starting = true;
    const config = await this.getConfig();
    if (!config) { this.starting = false; return false; }
    this.computerSeats = new Set((config.players || []).filter(p => p.type === 'computer' && !p.kicked).map(p => p.seat - 1));
    const startNow = Date.now();
    for (const seat of this.humanSeats(config)) {
      if (!this.connectedSeats.has(seat)) {
        const absence = { seat, disconnectedAt: startNow, botEligibleAt: startNow, deadline: startNow + RETURN_WINDOW_MS, missedRounds: 0, timeoutStreak: 0, timedOutThisRound: false, restricted: true, botControlled: true };
        this.absences.set(seat, absence);
        this.computerSeats.add(seat);
        this.restrictedBotSeats.add(seat);
      }
    }
    const names = Array.from({ length: config.numPlayers }, (_, i) => config.players[i]?.name || `Player${i + 1}`);
    const chips = Array.from({ length: config.numPlayers }, (_, i) => config.chipsPerPlayer ?? 5000);
    const maxBlindCall = /^\d+$/.test(String(config.maxBlindCall || '').trim()) ? Number(config.maxBlindCall) : null;
    this.engine = new TeenPattiEngine({ seats: config.numPlayers, names, chips,
      startingBoot: config.startingBoot, startingBlind: config.startingBlind,
      maxBlindCall, bootIncreaseMinutes: config.bootIncreaseMinutes });
    this.started = true;
    this.starting = false;
    this.engine.startRound();
    this.roundStartedAt = Date.now();
    this.totalChips = this.engine.players.reduce((sum, player) => sum + player.chips, 0) + this.engine.pot;
    this.audit('match_started', { seats: config.numPlayers, computerSeats: [...this.computerSeats] });
    await this.persist();
    await this.setStatus('live');
    this.armTurnTimer();
    this.broadcastState();
    this.maybeBotTurn();
    return true;
  }

  async setStatus(status, result) {
    const config = await this.getConfig();
    if (!config) return;
    const next = { ...config, status };
    if (result) next.result = result;
    await this.saveConfig(next);
  }

  stateFor(client) {
    if (!this.engine) return null;
    const raw = this.engine.state();
    const ownSeat = client.role === 'player' ? client.seat - 1 : -1;
    return {
      t: 'matchState', status: this.engine.gameOver ? 'ended' : 'live', round: raw.round,
      dealer: raw.dealer, currentSeat: raw.currentSeat, lastWinner: raw.lastWinner,
      roundStartedAt: this.roundStartedAt,
      roundAgeMs: this.roundStartedAt ? Math.max(0, Date.now() - this.roundStartedAt) : null,
      turnDeadline: this.turnDeadline,
      turnRemainingMs: this.turnDeadline == null ? null : Math.max(0, this.turnDeadline - Date.now()),
      currentBoot: raw.currentBoot, currentBet: raw.currentBet, pot: raw.pot,
      roundOver: raw.roundOver, gameOver: raw.gameOver, king: raw.king,
      pendingSideshow: raw.pendingSideshow ? {
        asker: raw.pendingSideshow.asker + 1, target: raw.pendingSideshow.target + 1,
        phase: raw.pendingSideshow.phase || 'ask',
        winner: raw.pendingSideshow.winner == null ? null : raw.pendingSideshow.winner + 1,
        loser: raw.pendingSideshow.loser == null ? null : raw.pendingSideshow.loser + 1,
      } : null,
      sideshowDeadline: this.sideshowDeadline,
      sideshowRemainingMs: this.sideshowDeadline == null ? null : Math.max(0, this.sideshowDeadline - Date.now()),
      nextRoundDeadline: this.nextRoundDeadline,
      nextRoundRemainingMs: this.nextRoundDeadline == null ? null : Math.max(0, this.nextRoundDeadline - Date.now()),
      lastRoundResult: raw.lastRoundResult ? {
        round: raw.lastRoundResult.round, winner: raw.lastRoundResult.winner + 1,
        amount: raw.lastRoundResult.amount, showdown: raw.lastRoundResult.showdown,
      } : null,
      sideshowAskedSeat: raw.sideshowAskedSeat >= 0 ? raw.sideshowAskedSeat + 1 : null,
      players: raw.players.map(player => ({
        seat: player.seat + 1, name: player.name, chips: player.chips, folded: player.folded,
        standing: player.standing, seen: player.seen, bet: player.bet,
        handCount: player.hand.length,
        hand: player.seat === ownSeat ? player.hand : null,
        actions: client.role === 'player' && player.seat === ownSeat ? this.engine.actionsFor(player.seat) : undefined,
        absent: this.absences.has(player.seat) ? true : undefined,
        botControlled: this.absences.get(player.seat)?.botControlled || this.computerSeats.has(player.seat) || undefined,
        returnDeadline: this.absences.get(player.seat)?.deadline || undefined,
        connected: this.connectedSeats.has(player.seat) || undefined,
        timeoutStreak: this.absences.get(player.seat)?.timeoutStreak || 0,
      })),
    };
  }

  sendState(client, replayReveals = true) {
    if (!this.realtime || !client) return;
    this.realtime.send(client, this.stateFor(client));
    if (!replayReveals) return;
    const result = this.engine?.lastRoundResult;
    if (result?.showdown) {
      const hands = this.engine.players.filter(player => !player.folded || player.seat === result.winner).map(player => ({
        seat: player.seat + 1, hand: player.hand, score: evaluateHand(player.hand),
      }));
      this.realtime.send(client, { t: 'showdownReveal', winner: result.winner + 1, amount: result.amount, hands });
    }
    const pending = this.engine?.pendingSideshow;
    if (pending?.phase === 'reveal' && client.role === 'player' && [pending.asker, pending.target].includes(client.seat - 1)) {
      this.realtime.send(client, {
        t: 'sideshowReveal', asker: pending.asker + 1, target: pending.target + 1,
        winner: pending.winner + 1, loser: pending.loser + 1,
        hands: [pending.asker, pending.target].map(seat => ({ seat: seat + 1, hand: this.engine.players[seat].hand })),
      });
    }
  }

  broadcastState() {
    if (!this.realtime) return;
    for (const client of this.realtime.clients) if (client.authenticated) this.sendState(client, false);
  }

  async persist() {
    if (!this.engine) return;
    const snapshot = this.engine.snapshot();
    snapshot.totalChips = this.totalChips;
    snapshot.absences = [...this.absences.values()];
    snapshot.carryPot = this.carryPot;
    this.persisting = this.persisting.then(() => this.saveSnapshot(snapshot));
    await this.persisting;
  }

  assertInvariants(context = 'unknown') {
    if (!this.engine) return;
    const players = this.engine.players;
    const cards = players.flatMap(player => player.hand || []);
    const uniqueCards = new Set(cards.map(card => `${card.r}:${card.s}`));
    const chips = players.reduce((sum, player) => sum + player.chips, 0) + this.engine.pot + this.carryPot;
    const valid = this.engine.pot >= 0 && players.every(player => Number.isSafeInteger(player.chips) && player.chips >= 0) && uniqueCards.size === cards.length && (this.totalChips == null || chips === this.totalChips);
    if (!valid) {
      this.metrics.invariantFailures += 1;
      this.audit('invariant_failure', { context, pot: this.engine.pot, cards: cards.length, uniqueCards: uniqueCards.size, totalChips: chips });
      throw new Error('Server match state invariant failed');
    }
  }

  getMetrics() { return { ...this.metrics, started: this.started, round: this.engine?.round || 0, clients: this.realtime?.clients?.size || 0 }; }

  async adminState() {
    const config = this.getConfig ? await this.getConfig() : null;
    const players = config?.players || [];
    return {
      status: this.engine?.gameOver ? 'ended' : (this.started ? 'live' : 'waiting'),
      round: this.engine?.round || 0,
      currentSeat: this.engine?.currentSeat == null ? null : this.engine.currentSeat + 1,
      connectedSeats: [...this.connectedSeats].map(seat => seat + 1),
      seats: players.map(player => {
        const absence = this.absences.get(player.seat - 1);
        return { seat: player.seat, name: player.name, type: player.type, kicked: !!player.kicked,
          connected: this.connectedSeats.has(player.seat - 1), botControlled: !!absence?.botControlled || player.type === 'computer',
          timeoutStreak: absence?.timeoutStreak || 0, returnDeadline: absence?.deadline || null };
      })
    };
  }


  armTurnTimer() {
    const keepDeadline = this.turnSeat === this.engine?.currentSeat && this.turnDeadline != null && this.turnDeadline > Date.now();
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    if (!this.engine || this.engine.roundOver || this.engine.gameOver || this.engine.currentSeat < 0) {
      this.turnDeadline = null;
      this.turnSeat = null;
      return;
    }
    const seat = this.engine.currentSeat;
    this.turnSeat = seat;
    if (!keepDeadline) this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    const remaining = Math.max(0, this.turnDeadline - Date.now());
    this.turnTimer = setTimeout(() => {
      if (!this.engine || this.engine.currentSeat !== seat || this.engine.roundOver) return;
      this.applyAction(seat + 1, 'timeout').catch(error => this.sendErrorToSeat(seat + 1, error.message));
    }, remaining);
  }

  maybeBotTurn() {
    if (!this.engine || this.engine.roundOver || this.engine.gameOver || this.engine.pendingSideshow || !this.computerSeats.has(this.engine.currentSeat)) return;
    clearTimeout(this.botTimer);
    const seat = this.engine.currentSeat;
    this.botTimer = setTimeout(async () => {
      if (!this.engine || this.engine.currentSeat !== seat || this.engine.roundOver || !this.computerSeats.has(seat)) return;
      try {
        const actions = this.engine.actionsFor(seat);
        this.metrics.botActions += 1;
        const absence = this.absences.get(seat);
        if (this.restrictedBotSeats.has(seat) && absence) {
          absence.turnsThisRound = absence.turnsThisRound || 0;
          if (absence.turnsThisRound === 0 && actions.blind) { absence.turnsThisRound += 1; await this.applyAction(seat + 1, 'blind'); }
          else if (actions.pack) { absence.turnsThisRound += 1; await this.applyAction(seat + 1, 'pack'); }
          else if (actions.blind) await this.applyAction(seat + 1, 'blind');
        } else await this.applyAction(seat + 1, this.chooseBotAction(seat));
      } catch (error) { this.sendErrorToSeat(seat + 1, error.message); }
    }, BOT_TURN_DELAY_MS + Math.floor(Math.random() * 900));
  }

  botEquity(seat, opponentCount) {
    const hand = this.engine.players[seat].hand;
    const own = evaluateHand(hand);
    const used = new Set(hand.map(card => `${card.r}:${card.s}`));
    const deck = makeDeck().filter(card => !used.has(`${card.r}:${card.s}`));
    if (opponentCount <= 0) return 1;
    if (opponentCount === 1) {
      let wins = 0, total = 0;
      for (let a = 0; a < deck.length; a += 1) for (let b = a + 1; b < deck.length; b += 1) for (let c = b + 1; c < deck.length; c += 1) {
        if (compareHands(own, [deck[a], deck[b], deck[c]]) >= 0) wins += 1;
        total += 1;
      }
      return total ? wins / total : 1;
    }
    let wins = 0;
    const trials = Math.max(120, Math.floor(900 / opponentCount));
    for (let trial = 0; trial < trials; trial += 1) {
      const pool = deck.slice();
      for (let i = pool.length - 1; i >= pool.length - opponentCount * 3; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      let best = true;
      for (let opponent = 0; opponent < opponentCount; opponent += 1) {
        const end = pool.length - 1 - opponent * 3;
        if (compareHands([pool[end], pool[end - 1], pool[end - 2]], own) > 0) { best = false; break; }
      }
      if (best) wins += 1;
    }
    return wins / trials;
  }

  chooseBotAction(seat) {
    const engine = this.engine, player = engine.players[seat], actions = engine.actionsFor(seat);
    const persona = [
      { aggr: .40, bluff: .25, tight: .45, seenBias: .50 }, { aggr: .55, bluff: .35, tight: .35, seenBias: .60 },
      { aggr: .25, bluff: .10, tight: .70, seenBias: .30 }, { aggr: .40, bluff: .45, tight: .30, seenBias: .70 },
      { aggr: .45, bluff: .20, tight: .50, seenBias: .50 }, { aggr: .65, bluff: .30, tight: .25, seenBias: .55 },
      { aggr: .35, bluff: .15, tight: .60, seenBias: .40 }, { aggr: .50, bluff: .40, tight: .35, seenBias: .65 },
    ][seat] || { aggr: .4, bluff: .25, tight: .45, seenBias: .5 };
    const opponents = engine.activeSeats().length - 1;
    if (!player.seen) {
      const stakeBite = Math.min(1, engine.currentBet / Math.max(player.chips, 1));
      const seenChance = .10 + persona.seenBias * .4 + (engine.round > 1 ? .15 : 0) + stakeBite * .5;
      if (player.chips >= engine.currentBet && Math.random() < seenChance) engine.action(seat, 'see');
    }
    const currentActions = engine.actionsFor(seat);
    const cost = engine.moveCost(player);
    const stackRatio = cost / Math.max(player.chips, 1);
    const potOdds = cost / Math.max(engine.pot + cost, 1);
    const winProb = player.seen ? this.botEquity(seat, opponents) : 1 / (opponents + 1);
    const edge = winProb - potOdds;
    if (currentActions.show) {
      player.botShowCount = (player.botShowCount || 0) + 1;
      const showChance = player.seen ? Math.min(.97, (edge > 0 ? .55 : .06) + winProb * .4 + player.botShowCount * .05 + persona.aggr * .1) : Math.min(.5, player.botShowCount * .06);
      if (player.botShowCount >= 9 || Math.random() < showChance) return 'show';
    }
    const tolerance = Math.max(.01, .05 + persona.bluff * .12 - persona.tight * .08);
    const bluffOn = Math.random() < (persona.bluff * .30 / (opponents + 1) + .02);
    let action;
    if (player.seen && edge < -tolerance && !bluffOn && opponents >= 1) action = 'pack';
    else if (player.seen && edge > .18 && Math.random() < (.35 + persona.aggr * .55) && currentActions.raise) action = 'raise';
    else if (player.seen && bluffOn && edge < 0 && opponents <= 2 && currentActions.raise) action = 'raise';
    else if (!player.seen && currentActions.raise && Math.random() < persona.aggr * .06) action = 'raise';
    else if (!player.seen && engine.round > 2 && stackRatio > .35 && Math.random() < persona.tight * .18 && opponents >= 1) action = 'pack';
    else action = player.seen ? 'chaal' : 'blind';
    if (action !== 'pack' && currentActions.sideshow) {
      const ssWinProb = player.seen ? this.botEquity(seat, 1) : .5;
      const ssChance = action === 'raise' ? .08 + persona.aggr * .10 : Math.min(.9, .30 + Math.max(0, ssWinProb - .4) * .9 + persona.tight * .15);
      if (Math.random() < ssChance) return 'sideshow';
    }
    return currentActions[action] ? action : (currentActions.pack ? 'pack' : (currentActions.blind ? 'blind' : 'chaal'));
  }

  scheduleBotPeeks() {
    if (!this.engine || this.engine.roundOver || this.engine.gameOver) return;
    const round = this.engine.round;
    const personas = [.50, .60, .30, .70, .50, .55, .40, .65];
    for (const seat of this.computerSeats) {
      const player = this.engine.players[seat];
      if (!player || player.folded || player.seen || seat === this.engine.currentSeat || this.restrictedBotSeats.has(seat) || this.botPeekTimers.has(seat)) continue;
      if (Math.random() > (personas[seat] || .5) * .22) continue;
      const timer = setTimeout(async () => {
        this.botPeekTimers.delete(seat);
        const current = this.engine?.players[seat];
        if (!this.engine || this.engine.round !== round || this.engine.roundOver || !current || current.folded || current.seen || current.chips < this.engine.currentBet) return;
        try { this.engine.action(seat, 'see'); await this.afterAction(); }
        catch (_) { /* a round transition or fold made the scheduled peek stale */ }
      }, 400 + Math.floor(Math.random() * 1_401));
      this.botPeekTimers.set(seat, timer);
    }
  }

  scheduleNextRound() {
    clearTimeout(this.nextRoundTimer);
    this.nextRoundDeadline = null;
    if (!this.engine || this.engine.gameOver) return;
    const delay = this.engine.lastRoundResult?.showdown ? NEXT_ROUND_DELAY_MS + 950 : NEXT_ROUND_DELAY_MS;
    this.nextRoundDeadline = Date.now() + delay;
    this.nextRoundTimer = setTimeout(() => {
      if (!this.engine || !this.engine.roundOver || this.engine.gameOver) return;
      try {
        this.nextRoundDeadline = null;
        this.engine.startRound();
        this.roundStartedAt = Date.now();
        if (this.carryPot > 0) { this.engine.pot += this.carryPot; this.carryPot = 0; }
        this.assertInvariants('next_round');
        this.persist().then(() => { this.armTurnTimer(); this.broadcastState(); this.maybeBotTurn(); }).catch(() => {});
      } catch (_) { /* match may have ended between scheduling and execution */ }
    }, delay);
  }

  sendErrorToSeat(seat, error) {
    if (!this.realtime) return;
    const client = this.realtime.sessions.get(seat);
    if (client) this.realtime.send(client, { t: 'error', code: 'action', error });
  }

  syncSideshowTimer() {
    const pending = this.engine?.pendingSideshow;
    const phase = pending?.phase || (pending ? 'ask' : null);
    if (!phase) {
      clearTimeout(this.sideshowTimer);
      this.sideshowTimer = null;
      this.sideshowDeadline = null;
      this.sideshowPhase = null;
      return;
    }
    if (phase === this.sideshowPhase && this.sideshowTimer) return;
    clearTimeout(this.sideshowTimer);
    this.sideshowPhase = phase;
    const delay = phase === 'ask' ? SIDESHOW_RESPONSE_MS : SIDESHOW_REVEAL_MS;
    this.sideshowDeadline = Date.now() + delay;
    const asker = pending.asker;
    this.sideshowTimer = setTimeout(() => {
      if (!this.engine?.pendingSideshow || this.engine.pendingSideshow.phase !== phase) return;
      if (phase === 'ask') this.engine.respondSideshow(false);
      else this.engine.completeSideshow();
      this.afterAction().catch(error => this.sendErrorToSeat(asker + 1, error.message));
    }, delay);
    if (phase === 'ask' && this.computerSeats.has(pending.target)) this.scheduleBotSideshowResponse(pending.target, pending.asker);
  }

  scheduleBotSideshowResponse(target, asker) {
    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => {
      const pending = this.engine?.pendingSideshow;
      if (!pending || pending.phase === 'reveal' || pending.target !== target || pending.asker !== asker) return;
      const persona = [
        { aggr: .40, tight: .45 }, { aggr: .55, tight: .35 }, { aggr: .25, tight: .70 }, { aggr: .40, tight: .30 },
        { aggr: .45, tight: .50 }, { aggr: .65, tight: .25 }, { aggr: .35, tight: .60 }, { aggr: .50, tight: .35 },
      ][target] || { aggr: .4, tight: .45 };
      const winProb = this.botEquity(target, 1);
      const chance = Math.max(.05, Math.min(.95, .5 + (winProb - .5) * 1.3 + persona.aggr * .08 - persona.tight * .05));
      this.respondSideshow(target + 1, Math.random() < chance).catch(error => this.sendErrorToSeat(target + 1, error.message));
    }, 1_200 + Math.floor(Math.random() * 1_801));
  }

  async applyAction(seat, type) {
    if (!this.engine) throw new Error('The match has not started yet.');
    const index = Number(seat) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.engine.seats) throw new Error('Invalid seat.');
    this.assertInvariants('before_action');
    this.metrics.actions += 1;
    const absence = this.absences.get(index);
    if (type === 'timeout') {
      this.metrics.timeouts += 1;
      const state = absence || this.ensureSeatAvailability(index);
      state.timedOutThisRound = true;
      state.timeoutStreak = (state.timeoutStreak || 0) + 1;

      if (this.engine.currentSeat !== index) throw new Error('It is not your turn.');
      this.engine.timeout(index);
    } else {
      if (absence) { absence.timeoutStreak = 0; absence.timedOutThisRound = false; }
      this.engine.action(index, type);
    }
    this.assertInvariants('after_action');
    await this.afterAction();
  }

  ensureSeatAvailability(seat) {
    let state = this.absences.get(seat);
    if (!state) {
      state = { seat, disconnectedAt: null, botEligibleAt: null, deadline: null, missedRounds: 0, timeoutStreak: 0, timedOutThisRound: false, restricted: false, botControlled: false, connected: true };
      this.absences.set(seat, state);
    }
    return state;
  }

  async respondSideshow(seat, accept) {
    if (!this.engine?.pendingSideshow) throw new Error('No sideshow request is pending.');
    if (this.engine.pendingSideshow.phase === 'reveal') throw new Error('The sideshow response window has closed.');
    const target = this.engine.pendingSideshow.target;
    const asker = this.engine.pendingSideshow.asker;
    if (seat - 1 !== target && seat - 1 !== asker) throw new Error('You are not part of this sideshow.');
    if (seat - 1 !== target) throw new Error('Only the asked player can answer.');
    this.metrics.actions += 1;
    this.assertInvariants('before_sideshow');
    this.engine.respondSideshow(Boolean(accept));
    this.assertInvariants('after_sideshow');
    await this.afterAction();
  }

  async continueSideshow(seat) {
    const pending = this.engine?.pendingSideshow;
    if (!pending || pending.phase !== 'reveal') throw new Error('No sideshow reveal is pending.');
    if (![pending.asker, pending.target].includes(Number(seat) - 1)) throw new Error('Only the two players in the sideshow can continue.');
    this.engine.completeSideshow();
    await this.afterAction();
  }

  async standUp(seat) {
    if (!this.engine) throw new Error('The match has not started yet.');
    this.assertInvariants('before_stand_up');
    const index = Number(seat) - 1;
    const player = this.engine.players[index];
    if (!player) throw new Error('Unknown seat.');
    const surrendered = player.chips;
    this.engine.standUp(index);
    // A stand-up removes the uncommitted stack from play permanently. The conservation
    // invariant therefore covers stacks + pot + carryPot after accounting for forfeiture.
    if (this.totalChips != null) this.totalChips = Math.max(0, this.totalChips - surrendered);
    this.assertInvariants('after_stand_up');
    await this.afterAction();
  }

  async afterAction() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    const events = this.engine?.drainEvents?.() || [];
    this.syncSideshowTimer();
    await this.persist();
    if (this.engine.gameOver) {
      clearTimeout(this.nextRoundTimer);
      this.nextRoundTimer = null;
      this.nextRoundDeadline = null;
      clearTimeout(this.sideshowTimer);
      this.sideshowTimer = null;
      this.sideshowDeadline = null;
      this.sideshowPhase = null;
      const winner = this.engine.players[this.engine.king];
      const result = { winner: winner?.name || null, winnerSeat: this.engine.king + 1, finalStack: winner?.chips || 0, endedAt: Date.now() };
      await this.setStatus('ended', result);
      await this.deleteSnapshot();
    } else if (this.engine.roundOver) {
      for (const absence of this.absences.values()) {
        if (absence.timedOutThisRound) absence.missedRounds = (absence.missedRounds || 0) + 1;
        absence.timedOutThisRound = false;
        absence.turnsThisRound = 0;
        if (absence.missedRounds >= BOT_TAKEOVER_ROUNDS && !absence.botControlled) {
          absence.botControlled = true;
          absence.restricted = true;
          absence.deadline = Date.now() + RETURN_WINDOW_MS;
          this.computerSeats.add(absence.seat);
          this.restrictedBotSeats.add(absence.seat);
          this.audit('restricted_bot_started', { seat: absence.seat + 1, deadline: absence.deadline });
        }
      }
      this.scheduleNextRound();
    }
    this.armTurnTimer();
    this.broadcastState();
    this.broadcastEngineEvents(events);
    this.maybeBotTurn();
    this.scheduleBotPeeks();
  }

  broadcastEngineEvents(events) {
    if (!this.realtime || !this.engine) return;
    for (const event of events || []) {
      if (event.type === 'roundEnded' && event.showdown && Array.isArray(event.hands)) {
        const message = {
          t: 'showdownReveal', winner: event.winner + 1, amount: event.amount,
          hands: event.hands.map(item => ({ seat: item.seat + 1, hand: item.hand, score: item.score }))
        };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'roundEnded') {
        const result = { t: 'roundResult', round: this.engine.round, winner: event.winner + 1, amount: event.amount, showdown: !!event.showdown };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, result);
      } else if (event.type === 'sideshowResolved') {
        const seats = [event.asker, event.target];
        const message = {
          t: 'sideshowReveal', asker: event.asker + 1, target: event.target + 1,
          winner: event.winner + 1, loser: event.loser + 1,
          hands: seats.map(seat => ({ seat: seat + 1, hand: this.engine.players[seat].hand }))
        };
        for (const client of this.realtime.clients) {
          if (!client.authenticated || client.role !== 'player' || !seats.includes(client.seat - 1)) continue;
          this.realtime.send(client, message);
        }
        const result = { t: 'sideshowResult', asker: event.asker + 1, target: event.target + 1, winner: event.winner + 1, loser: event.loser + 1 };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, result);
      } else if (event.type === 'actionPerformed') {
        const message = { t: 'actionFeedback', seat: event.seat + 1, action: event.action, cost: event.cost, currentBet: event.currentBet, target: event.target == null ? null : event.target + 1, seen: event.seen };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'sideshowRequested') {
        const message = { t: 'sideshowRequested', asker: event.asker + 1, target: event.target + 1, deadline: this.sideshowDeadline };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'sideshowDenied') {
        const message = { t: 'sideshowDenied', asker: event.asker + 1, target: event.target + 1 };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'sideshowCancelled') {
        const message = { t: 'sideshowCancelled', asker: event.asker + 1, target: event.target + 1, reason: event.reason };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'stoodUp') {
        const message = { t: 'stoodUp', seat: event.seat + 1, surrendered: event.surrendered };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      } else if (event.type === 'folded') {
        const message = { t: 'folded', seat: event.seat + 1, reason: event.reason };
        for (const client of this.realtime.clients) if (client.authenticated) this.realtime.send(client, message);
      }
    }
  }

  async adminKick(seat) {
    const index = Number(seat) - 1;
    if (!this.engine || !Number.isInteger(index) || !this.engine.players[index]) return false;
    const client = this.realtime?.sessions?.get(Number(seat));
    if (client) { this.realtime.send(client, { t: 'kicked', error: 'You were removed from the table by the admin.' }); client.socket.close(1008, 'admin kicked'); }
    this.absences.delete(index);
    this.computerSeats.delete(index);
    this.restrictedBotSeats.delete(index);
    if (!this.engine.players[index].standing) {
      const surrendered = this.engine.players[index].chips;
      this.engine.standUp(index);
      if (this.totalChips != null) this.totalChips = Math.max(0, this.totalChips - surrendered);
    }
    this.audit('admin_kick', { seat });
    await this.afterAction();
    return true;
  }

  async handleMessage(message, client) {
    if (!client || client.role !== 'player' || client.seat == null) return false;
    if (message.t === 'resume') { this.sendState(client); return true; }
    try {
      if (message.t === 'action') {
        if (typeof message.action !== 'string' || message.action.length > 20) throw new Error('Invalid action.');
        this.audit('player_action', { seat: client.seat, action: message.action });
        await this.applyAction(client.seat, message.action);
      } else if (message.t === 'sideshowResponse') {
        if (typeof message.accept !== 'boolean') throw new Error('Invalid sideshow response.');
        await this.respondSideshow(client.seat, message.accept);
      } else if (message.t === 'sideshowContinue') {
        await this.continueSideshow(client.seat);
      }
      else if (message.t === 'standUp') await this.standUp(client.seat);
      else return false;
      return true;
    } catch (error) { this.realtime.send(client, { t: 'error', code: 'action', error: error.message }); return true; }
  }

  close() {
    this.reset();
    clearInterval(this.lifecycleTimer);
  }

  reset() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextRoundTimer);
    clearTimeout(this.botTimer);
    clearTimeout(this.sideshowTimer);
    this.engine = null;
    this.started = false;
    this.starting = false;
    this.restoring = false;
    this.roundStartedAt = 0;
    this.connectedSeats.clear();
    this.computerSeats.clear();
    this.restrictedBotSeats.clear();
    for (const timer of this.botPeekTimers.values()) clearTimeout(timer);
    this.botPeekTimers.clear();
    this.absences.clear();
    this.carryPot = 0;
    this.turnTimer = null;
    this.turnDeadline = null;
    this.turnSeat = null;
    this.nextRoundTimer = null;
    this.nextRoundDeadline = null;
    this.botTimer = null;
    this.sideshowTimer = null;
    this.sideshowDeadline = null;
    this.sideshowPhase = null;
  }
}

module.exports = { MatchManager, TURN_TIMEOUT_MS, DISCONNECT_GRACE_MS, RETURN_WINDOW_MS, BOT_TAKEOVER_ROUNDS, scheduledStartMs };
