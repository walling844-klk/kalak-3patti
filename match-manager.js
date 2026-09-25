'use strict';

const { TeenPattiEngine } = require('./game-engine');

const TURN_TIMEOUT_MS = 30_000;
const NEXT_ROUND_DELAY_MS = 1_500;
const LIFECYCLE_TICK_MS = 1_000;
const BOT_TURN_DELAY_MS = 450;
const RETURN_WINDOW_MS = 10 * 60 * 1000;
const BOT_TAKEOVER_ROUNDS = 3;

function scheduledStartMs(config) {
  if (!config || (!config.matchStartDate && !config.matchStartTime)) return null;
  const date = config.matchStartDate || new Date().toISOString().slice(0, 10);
  let time = config.matchStartTime || '00:00';
  if (time.length === 5) time += ':00';
  const parsed = Date.parse(`${date}T${time}+05:30`);
  return Number.isFinite(parsed) ? parsed : null;
}

class MatchManager {
  constructor({ getConfig, saveConfig, loadSnapshot, saveSnapshot, deleteSnapshot, realtime }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.loadSnapshot = loadSnapshot;
    this.saveSnapshot = saveSnapshot;
    this.deleteSnapshot = deleteSnapshot;
    this.realtime = realtime;
    this.engine = null;
    this.started = false;
    this.starting = false;
    this.restoring = false;
    this.connectedSeats = new Set();
    this.computerSeats = new Set();
    this.absences = new Map();
    this.turnTimer = null;
    this.nextRoundTimer = null;
    this.botTimer = null;
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
    this.absences = new Map(Array.isArray(snapshot.absences) ? snapshot.absences.map(item => [item.seat, item]) : []);
    this.computerSeats = new Set((config.players || []).filter(p => p.type === 'computer' && !p.kicked).map(p => p.seat - 1));
    this.started = true;
    this.restoring = false;
    await this.setStatus('live');
    this.broadcastState();
    this.armTurnTimer();
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
    const absence = this.absences.get(seat);
    if (absence) {
      absence.returnedAt = Date.now();
      absence.connected = true;
      absence.botControlled = false;
      this.absences.delete(seat);
      this.computerSeats.delete(seat);
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
      const absence = existing || { seat, disconnectedAt: Date.now(), deadline: Date.now() + RETURN_WINDOW_MS, missedRounds: 0, botControlled: true };
      absence.disconnectedAt = absence.disconnectedAt || Date.now();
      absence.deadline = absence.deadline || Date.now() + RETURN_WINDOW_MS;
      absence.connected = false;
      absence.botControlled = true;
      this.absences.set(seat, absence);
      this.computerSeats.add(seat);
      this.broadcastState();
      this.maybeBotTurn();
    }
  }

  async expireAbsences() {
    if (!this.started || !this.engine || this.engine.gameOver) return;
    const now = Date.now();
    for (const [seat, absence] of this.absences) {
      if (absence.connected || now < absence.deadline) continue;
      await this.kickAbsentSeat(seat, absence);
    }
  }

  async kickAbsentSeat(seat, absence) {
    if (!this.engine || !this.absences.has(seat)) return;
    const player = this.engine.players[seat];
    if (!player || player.standing) { this.absences.delete(seat); return; }
    if (this.engine.currentSeat === seat && !this.engine.roundOver) this.engine.timeout(seat);
    const share = player.chips;
    const recipients = this.engine.players.filter(p => p.seat !== seat && !p.standing && !p.folded);
    if (share > 0 && recipients.length) {
      const each = Math.floor(share / recipients.length);
      let remainder = share - each * recipients.length;
      for (const recipient of recipients) { recipient.chips += each + (remainder-- > 0 ? 1 : 0); }
      player.chips = 0;
    }
    player.standing = true;
    player.folded = true;
    this.absences.delete(seat);
    this.computerSeats.delete(seat);
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
    const humans = this.humanSeats(config);
    const playable = this.playableSeats(config);
    if (playable.length < 2) return false;
    return humans.every(seat => this.connectedSeats.has(seat));
  }

  async startTimeReached() {
    const config = await this.getConfig();
    const start = scheduledStartMs(config);
    return start === null || Date.now() >= start;
  }

  async maybeStart() {
    if (this.started || this.starting || this.restoring) return false;
    if (!(await this.allRequiredPlayersReady()) || !(await this.startTimeReached())) return false;
    this.starting = true;
    const config = await this.getConfig();
    if (!config) { this.starting = false; return false; }
    this.computerSeats = new Set((config.players || []).filter(p => p.type === 'computer' && !p.kicked).map(p => p.seat - 1));
    const names = Array.from({ length: config.numPlayers }, (_, i) => config.players[i]?.name || `Player${i + 1}`);
    const chips = Array.from({ length: config.numPlayers }, (_, i) => config.chipsPerPlayer ?? 5000);
    this.engine = new TeenPattiEngine({ seats: config.numPlayers, names, chips, startingBoot: config.startingBoot, bootIncreaseMinutes: config.bootIncreaseMinutes });
    this.started = true;
    this.starting = false;
    this.engine.startRound();
    await this.persist();
    await this.setStatus('live');
    this.broadcastState();
    this.armTurnTimer();
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
      currentBoot: raw.currentBoot, currentBet: raw.currentBet, pot: raw.pot,
      roundOver: raw.roundOver, gameOver: raw.gameOver, king: raw.king,
      pendingSideshow: raw.pendingSideshow ? { asker: raw.pendingSideshow.asker + 1, target: raw.pendingSideshow.target + 1 } : null,
      sideshowAskedSeat: raw.sideshowAskedSeat >= 0 ? raw.sideshowAskedSeat + 1 : null,
      players: raw.players.map(player => ({
        seat: player.seat + 1, name: player.name, chips: player.chips, folded: player.folded,
        standing: player.standing, seen: player.seen, bet: player.bet,
        hand: player.seat === ownSeat ? player.hand : null,
        actions: client.role === 'player' && player.seat === ownSeat ? this.engine.actionsFor(player.seat) : undefined,
        absent: this.absences.has(player.seat) ? true : undefined,
        botControlled: this.absences.get(player.seat)?.botControlled || this.computerSeats.has(player.seat) || undefined,
        returnDeadline: this.absences.get(player.seat)?.deadline || undefined,
      })),
    };
  }

  sendState(client) { if (this.realtime && client) this.realtime.send(client, this.stateFor(client)); }

  broadcastState() {
    if (!this.realtime) return;
    for (const client of this.realtime.clients) if (client.authenticated) this.sendState(client);
  }

  async persist() {
    if (!this.engine) return;
    const snapshot = this.engine.snapshot();
    snapshot.absences = [...this.absences.values()];
    this.persisting = this.persisting.then(() => this.saveSnapshot(snapshot));
    await this.persisting;
  }

  armTurnTimer() {
    clearTimeout(this.turnTimer);
    if (!this.engine || this.engine.roundOver || this.engine.gameOver || this.engine.currentSeat < 0 || this.computerSeats.has(this.engine.currentSeat)) return;
    const seat = this.engine.currentSeat;
    this.turnTimer = setTimeout(() => {
      if (!this.engine || this.engine.currentSeat !== seat || this.engine.roundOver) return;
      this.applyAction(seat + 1, 'timeout').catch(error => this.sendErrorToSeat(seat + 1, error.message));
    }, TURN_TIMEOUT_MS);
  }

  maybeBotTurn() {
    clearTimeout(this.botTimer);
    if (!this.engine || this.engine.roundOver || this.engine.gameOver || !this.computerSeats.has(this.engine.currentSeat)) return;
    const seat = this.engine.currentSeat;
    this.botTimer = setTimeout(async () => {
      if (!this.engine || this.engine.currentSeat !== seat || this.engine.roundOver || !this.computerSeats.has(seat)) return;
      try {
        const actions = this.engine.actionsFor(seat);
        if (actions.see) await this.applyAction(seat + 1, 'see');
        else if (actions.show) await this.applyAction(seat + 1, 'show');
        else if (actions.chaal) await this.applyAction(seat + 1, 'chaal');
        else if (actions.blind) await this.applyAction(seat + 1, 'blind');
        else if (actions.pack) await this.applyAction(seat + 1, 'pack');
      } catch (error) { this.sendErrorToSeat(seat + 1, error.message); }
    }, BOT_TURN_DELAY_MS);
  }

  scheduleNextRound() {
    clearTimeout(this.nextRoundTimer);
    if (!this.engine || this.engine.gameOver) return;
    this.nextRoundTimer = setTimeout(() => {
      if (!this.engine || !this.engine.roundOver || this.engine.gameOver) return;
      try {
        this.engine.startRound();
        this.persist().then(() => { this.broadcastState(); this.armTurnTimer(); this.maybeBotTurn(); }).catch(() => {});
      } catch (_) { /* match may have ended between scheduling and execution */ }
    }, NEXT_ROUND_DELAY_MS);
  }

  sendErrorToSeat(seat, error) {
    if (!this.realtime) return;
    const client = this.realtime.sessions.get(seat);
    if (client) this.realtime.send(client, { t: 'error', code: 'action', error });
  }

  async applyAction(seat, type) {
    if (!this.engine) throw new Error('The match has not started yet.');
    const index = Number(seat) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.engine.seats) throw new Error('Invalid seat.');
    if (type === 'timeout') {
      if (this.engine.currentSeat !== index) throw new Error('It is not your turn.');
      this.engine.timeout(index);
    } else this.engine.action(index, type);
    await this.afterAction();
  }

  async respondSideshow(seat, accept) {
    if (!this.engine?.pendingSideshow) throw new Error('No sideshow request is pending.');
    const target = this.engine.pendingSideshow.target;
    const asker = this.engine.pendingSideshow.asker;
    if (seat - 1 !== target && seat - 1 !== asker) throw new Error('You are not part of this sideshow.');
    if (seat - 1 !== target) throw new Error('Only the asked player can answer.');
    this.engine.respondSideshow(Boolean(accept));
    await this.afterAction();
  }

  async standUp(seat) {
    if (!this.engine) throw new Error('The match has not started yet.');
    this.engine.standUp(Number(seat) - 1);
    await this.afterAction();
  }

  async afterAction() {
    clearTimeout(this.turnTimer);
    clearTimeout(this.botTimer);
    await this.persist();
    if (this.engine.gameOver) {
      const winner = this.engine.players[this.engine.king];
      const result = { winner: winner?.name || null, winnerSeat: this.engine.king + 1, finalStack: winner?.chips || 0, endedAt: Date.now() };
      await this.setStatus('ended', result);
      await this.deleteSnapshot();
    } else if (this.engine.roundOver) {
      for (const absence of this.absences.values()) {
        absence.missedRounds += 1;
        if (absence.missedRounds >= BOT_TAKEOVER_ROUNDS) absence.botControlled = true;
      }
      this.scheduleNextRound();
    }
    this.broadcastState();
    this.armTurnTimer();
    this.maybeBotTurn();
  }

  async handleMessage(message, client) {
    if (!client || client.role !== 'player' || client.seat == null) return false;
    if (message.t === 'resume') { this.sendState(client); return true; }
    try {
      if (message.t === 'action') await this.applyAction(client.seat, message.action);
      else if (message.t === 'sideshowResponse') await this.respondSideshow(client.seat, message.accept);
      else if (message.t === 'standUp') await this.standUp(client.seat);
      else return false;
      return true;
    } catch (error) { this.realtime.send(client, { t: 'error', code: 'action', error: error.message }); return true; }
  }

  close() {
    clearInterval(this.lifecycleTimer);
    clearTimeout(this.turnTimer);
    clearTimeout(this.nextRoundTimer);
    clearTimeout(this.botTimer);
  }
}

module.exports = { MatchManager, TURN_TIMEOUT_MS, RETURN_WINDOW_MS, BOT_TAKEOVER_ROUNDS, scheduledStartMs };
