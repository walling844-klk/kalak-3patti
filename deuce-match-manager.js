'use strict';

const { DeuceEngine, evaluate, compareEval } = require('./deuce-engine');

const TURN_TIMEOUT_MS = 120_000;
const DISCONNECT_GRACE_MS = 30_000;
const LIFECYCLE_TICK_MS = 1_000;
const BOT_TURN_DELAY_MS = 500;
const GROUP_POPUP_MS = 10_000;   // group-match result popup, same as Play vs Computer
const ROUND_START_MS = 12_000;   // 5-4-3-2-1 countdown + card deal before a round first turn

function istDateString(now = Date.now()) {
  return new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function scheduledStartMs(config) {
  if (!config || (!config.matchStartDate && !config.matchStartTime)) return null;
  const date = config.matchStartDate || istDateString();
  let time = config.matchStartTime || '00:00';
  if (time.length === 5) time += ':00';
  const parsed = Date.parse(`${date}T${time}+05:30`);
  return Number.isFinite(parsed) ? parsed : NaN;
}

class DeuceMatchManager {
  constructor({ getConfig, saveConfig, loadSnapshot, saveSnapshot, deleteSnapshot, realtime, audit = () => {} }) {
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.loadSnapshot = loadSnapshot;
    this.saveSnapshot = saveSnapshot;
    this.deleteSnapshot = deleteSnapshot;
    this.realtime = realtime;
    this.audit = audit;
    this.engine = null;
    this.started = false;
    this.starting = false;
    this.restoring = false;
    this.matchStartedAt = 0;
    this.turnDeadline = null;
    this.turnTimer = null;
    this.botTimer = null;
    this.connectedSeats = new Set();
    this.absences = new Map();
    this.exitedSeats = new Set();                 // seats whose player pressed Exit Table: locked out of this match for good
    this.metrics = { actions: 0, timeouts: 0, botActions: 0, reconnects: 0 };
    this.lifecycleTimer = setInterval(() => this.lifecycleTick().catch(error => console.error('Deuce lifecycle failed:', error.message)), LIFECYCLE_TICK_MS);
    this.lifecycleTimer.unref();
  }

  async lifecycleTick() {
    await this.expireAbsences();
    if (!this.started && !this.starting && !this.restoring) await this.maybeStart();
    if (this.started && this.engine && !this.engine.gameOver) {
      if (this.turnDeadline && Date.now() >= this.turnDeadline) await this.timeoutTurn();
      else this.maybeBotTurn();
    }
  }

  humanSeats(config) { return (config?.players || []).filter(player => player.type === 'human' && !player.kicked).map(player => player.seat - 1); }
  playableSeats(config) { return (config?.players || []).filter(player => !player.kicked).map(player => player.seat - 1); }

  async allRequiredPlayersReady() {
    const config = await this.getConfig();
    return this.playableSeats(config).length >= 2;
  }

  async startTimeReached() {
    const start = scheduledStartMs(await this.getConfig());
    if (start === null) return true;
    return Number.isFinite(start) && Date.now() >= start;
  }

  async maybeStart() { return this.startMatch(false); }
  async startNow() { return this.startMatch(true); }

  async startMatch(force) {
    if (this.started || this.starting || this.restoring) return false;
    if (!(await this.allRequiredPlayersReady()) || (!force && !(await this.startTimeReached()))) return false;
    const config = await this.getConfig();
    if (!config) return false;
    this.starting = true;
    const playable = this.playableSeats(config);
    const names = Array.from({ length: config.numPlayers }, (_, index) => config.players[index]?.name || `Player${index + 1}`);
    const computerSeats = (config.players || []).filter(player => player.type === 'computer' && !player.kicked).map(player => player.seat - 1);
    this.engine = new DeuceEngine({ seats: config.numPlayers, names, computerSeats });
    for (const player of config.players || []) if (player.kicked) this.engine.removeSeat(player.seat - 1);
    this.engine.startMatch();
    this.started = true;
    this.starting = false;
    this.matchStartedAt = Date.now();
    this.connectedSeats = new Set([...this.connectedSeats].filter(seat => playable.includes(seat)));
    const now = Date.now();
    for (const seat of this.humanSeats(config)) {
      if (!this.connectedSeats.has(seat)) this.absences.set(seat, { seat, disconnectedAt: now, botEligibleAt: now + DISCONNECT_GRACE_MS, botControlled: false, connected: false });
    }
    await this.setStatus('live');
    await this.persist();
    this.pauseUntil = Date.now() + ROUND_START_MS;
    this.armTurnTimer();
    this.broadcastState();
    this.maybeBotTurn();
    this.audit('deuce_match_started', { seats: config.numPlayers, computerSeats });
    return true;
  }

  async restoreIfPresent() {
    this.restoring = true;
    const [snapshot, config] = await Promise.all([this.loadSnapshot(), this.getConfig()]);
    if (!snapshot || !config || config.status === 'ended') { this.restoring = false; return false; }
    this.engine = DeuceEngine.restore(snapshot.engine || snapshot);
    this.matchStartedAt = Number(snapshot.matchStartedAt) || 0;
    this.exitedSeats = new Set(Array.isArray(snapshot.exitedSeats) ? snapshot.exitedSeats.map(Number).filter(Number.isInteger) : []);
    this.started = true;
    const now = Date.now();
    for (const seat of this.humanSeats(config)) this.absences.set(seat, { seat, disconnectedAt: now, botEligibleAt: now + DISCONNECT_GRACE_MS, botControlled: false, connected: false });
    this.restoring = false;
    this.armTurnTimer();
    this.broadcastState();
    this.maybeBotTurn();
    return true;
  }

  register(client) {
    if (client.role !== 'player' || client.seat == null) return;
    const seat = client.seat - 1;
    if (this.exitedSeats.has(seat)) return;
    this.connectedSeats.add(seat);
    const absence = this.absences.get(seat);
    if (absence) { this.metrics.reconnects += 1; this.absences.delete(seat); this.audit('deuce_player_returned', { seat: client.seat }); }
    if (!this.started) this.maybeStart().catch(error => console.error('Deuce start failed:', error.message));
    else this.sendState(client);
  }

  unregister(client) {
    if (client.role !== 'player' || client.seat == null) return;
    const seat = client.seat - 1;
    if (this.realtime?.sessions?.get(client.seat) && this.realtime.sessions.get(client.seat) !== client) return;
    this.connectedSeats.delete(seat);
    if (this.engine?.removedSeats?.has(seat)) return;             // kicked by the admin: no absence timer, no bot
    if (this.started && this.engine && !this.engine.gameOver) {
      const now = Date.now();
      const current = this.absences.get(seat) || { seat, disconnectedAt: now, botEligibleAt: now + DISCONNECT_GRACE_MS, botControlled: false };
      current.connected = false;
      current.disconnectedAt = current.disconnectedAt || now;
      current.botEligibleAt = current.botEligibleAt || now + DISCONNECT_GRACE_MS;
      this.absences.set(seat, current);
      this.broadcastState();
    }
  }

  async expireAbsences() {
    if (!this.started || !this.engine || this.engine.gameOver) return;
    const now = Date.now();
    for (const absence of this.absences.values()) {
      if (!absence.connected && !absence.botControlled && now >= absence.botEligibleAt) {
        absence.botControlled = true;
        this.audit('deuce_bot_takeover', { seat: absence.seat + 1 });
        this.broadcastState();
      }
    }
  }

  async setStatus(status, result) {
    const config = await this.getConfig();
    if (!config) return;
    const next = { ...config, status };
    if (result) next.result = result;
    await this.saveConfig(next);
  }

  stateFor(client) {
    if (!this.engine) return { t: 'deuceState', status: 'waiting', players: [] };
    const ownSeat = client?.role === 'player' ? client.seat - 1 : null;
    const state = this.engine.state(ownSeat);
    state.t = 'deuceState';
    state.status = this.engine.gameOver ? 'ended' : 'live';
    state.matchStartedAt = this.matchStartedAt || null;
    state.turnDeadline = this.turnDeadline;
    state.turnRemainingMs = this.turnDeadline == null ? null : Math.max(0, Math.min(TURN_TIMEOUT_MS, this.turnDeadline - Date.now()));
    state.pauseRemainingMs = Math.max(0, (this.pauseUntil || 0) - Date.now());
    state.lastGroupResult = this.lastGroupResult || null;
    state.players = state.players.map(player => ({
      ...player,
      connected: this.connectedSeats.has(player.seat),
      absent: this.absences.has(player.seat),
      botControlled: this.isBotControlled(player.seat),
    }));
    return state;
  }

  isBotControlled(seat) {
    const config = this.getConfigSync;
    return Boolean(this.engine?.computerSeats.has(seat) || this.absences.get(seat)?.botControlled);
  }

  sendState(client) { if (client) this.realtime.send(client, this.stateFor(client)); }
  broadcastState() { for (const client of this.realtime?.clients || []) if (client.authenticated) this.sendState(client); }

  armTurnTimer() {
    clearTimeout(this.turnTimer);
    if (!this.engine || this.engine.gameOver || this.engine.actor < 0) { this.turnDeadline = null; return; }
    const wait = Math.max(0, (this.pauseUntil || 0) - Date.now());
    this.turnDeadline = Date.now() + wait + TURN_TIMEOUT_MS;
    this.turnTimer = setTimeout(() => this.timeoutTurn().catch(error => console.error('Deuce timeout failed:', error.message)), wait + TURN_TIMEOUT_MS + 20);
  }

  async timeoutTurn() {
    if (!this.engine || this.engine.gameOver || this.engine.actor < 0 || !this.turnDeadline || Date.now() < this.turnDeadline) return;
    const seat = this.engine.actor;
    try {
      this.metrics.timeouts += 1;
      await this.applyEngineAction(seat, 'timeout', null, true);
    } catch (error) { this.audit('deuce_timeout_error', { seat: seat + 1, error: error.message }); }
  }

  maybeBotTurn() {
    if (!this.engine || this.engine.gameOver || this.engine.actor < 0) return;
    const seat = this.engine.actor;
    if (!this.isBotControlled(seat) || this.botTimer) return;
    const botWait = BOT_TURN_DELAY_MS + Math.max(0, (this.pauseUntil || 0) - Date.now());
    this.botTimer = setTimeout(async () => {
      this.botTimer = null;
      try {
        const player = this.engine.players[seat];
        const groups = this.engine.availableGroupIndices(player);
        if (groups.length) {
          const best = groups.reduce((choice, index) => !choice || compareEval(evaluate(player.groups[index]), choice.eval) > 0 ? { index, eval: evaluate(player.groups[index]) } : choice, null);
          await this.applyEngineAction(seat, 'play', best.index, true);
        } else await this.applyEngineAction(seat, 'pack', null, true);
        this.metrics.botActions += 1;
      } catch (error) { this.audit('deuce_bot_error', { seat: seat + 1, error: error.message }); }
    }, botWait);
  }

  async applyEngineAction(seat, action, value, internal = false) {
    if (!this.engine) throw new Error('The Deuce match has not started.');
    let result;
    const roundBefore = this.engine.round;
    if (action === 'group') result = this.engine.group(seat, value);
    else if (action === 'play') result = this.engine.play(seat, value);
    else if (action === 'pack') result = this.engine.pack(seat);
    else if (action === 'timeout') result = this.engine.timeout(seat);
    else throw new Error('Unknown Deuce action.');
    this.metrics.actions += 1;
    await this.settle(result, roundBefore);
    return result;
  }

  // Everything that follows a change to the engine: group result popup, save, end of match, next turn timer, broadcast.
  async settle(result, roundBefore) {
    const groupResult = result && result.groupResult;
    if (groupResult) {
      this.groupResultSeq = (this.groupResultSeq || 0) + 1;
      this.lastGroupResult = { seq: this.groupResultSeq, round: roundBefore, groupNo: groupResult.groupIndex + 1, winner: groupResult.winner, scores: groupResult.scores, entries: groupResult.entries, matchOver: !!result.gameOver, roundComplete: !!result.roundComplete };
      this.pauseUntil = Date.now() + GROUP_POPUP_MS + (result.roundComplete ? ROUND_START_MS : 0);
    }
    this.turnDeadline = null;
    clearTimeout(this.turnTimer); this.turnTimer = null;
    await this.persist();
    if (this.engine.gameOver) {
      const champion = this.engine.players[this.engine.winner];
      await this.setStatus('ended', champion ? { winner: this.engine.winner + 1, name: champion.name, score: champion.score } : { winner: null, name: '', score: 0 });
      this.broadcastState();
      return;
    }
    this.armTurnTimer();
    this.broadcastState();
    this.maybeBotTurn();
  }


  async handleMessage(message, client) {
    if (!client || client.role !== 'player' || client.seat == null) return false;
    if (message.t === 'resume') { this.sendState(client); return true; }
    if (message.t !== 'deuceAction') return false;
    try {
      if (Date.now() < (this.pauseUntil || 0)) throw new Error('Wait for the next turn to start.');
      const seat = client.seat - 1;
      if (message.action === 'group') {
        if (!Array.isArray(message.cardIds) || message.cardIds.length > 9) throw new Error('Invalid group selection.');
        await this.applyEngineAction(seat, 'group', message.cardIds);
      } else if (message.action === 'play') {
        const groupIndex = Number(message.groupIndex);
        if (!Number.isInteger(groupIndex) || groupIndex < 0 || groupIndex > 2) throw new Error('Invalid group.');
        await this.applyEngineAction(seat, 'play', groupIndex);
      } else if (message.action === 'pack') await this.applyEngineAction(seat, 'pack');
      else throw new Error('Invalid Deuce action.');
      return true;
    } catch (error) {
      this.realtime.send(client, { t: 'error', code: 'deuce_action', error: error.message });
      return true;
    }
  }

  async persist() {
    if (!this.engine) return;
    await this.saveSnapshot({ engine: this.engine.snapshot(), matchStartedAt: this.matchStartedAt, exitedSeats: [...this.exitedSeats] });
  }

  async adminState() {
    const config = await this.getConfig();
    return {
      status: config?.status || 'waiting', started: this.started, round: this.engine?.round || 0,
      hand: this.engine?.hand || 1, actor: this.engine ? this.engine.actor + 1 : null,
      players: (config?.players || []).map(player => ({ seat: player.seat, name: player.name, type: player.type, kicked: !!player.kicked, connected: this.connectedSeats.has(player.seat - 1) })),
    };
  }

  // Admin kick: same result as Kalak - the player is removed from the game (no bot is left in the seat, the seat is skipped
  // for the rest of the match). If only one seat is left at the table the match ends and that seat wins.
  async adminKick(seat) {
    const index = Number(seat) - 1;
    this.absences.delete(index);
    this.connectedSeats.delete(index);
    if (!this.engine || !this.engine.players[index] || this.engine.removedSeats.has(index)) return false;
    const roundBefore = this.engine.round;
    let result;
    try { result = this.engine.removeSeat(index); } catch (error) { this.audit('deuce_kick_error', { seat: Number(seat), error: error.message }); return false; }
    this.audit('deuce_admin_kick', { seat: Number(seat) });
    clearTimeout(this.botTimer); this.botTimer = null;
    await this.settle(result, roundBefore);
    return true;
  }

  async reset() {
    clearTimeout(this.turnTimer); clearTimeout(this.botTimer); this.turnTimer = null; this.botTimer = null;
    this.engine = null; this.started = false; this.starting = false; this.restoring = false;
    this.matchStartedAt = 0; this.turnDeadline = null; this.connectedSeats.clear(); this.absences.clear(); this.exitedSeats.clear(); this.pauseUntil = 0; this.lastGroupResult = null; this.groupResultSeq = 0;
  }

  async resetForNextMatch() {
    const connectedPlayers = [...(this.realtime?.clients || [])].filter(client => client.authenticated && client.role === 'player' && client.seat != null);
    await this.reset();
    for (const client of connectedPlayers) this.connectedSeats.add(client.seat - 1);
  }
  async deleteStoredSnapshot() { await this.deleteSnapshot(); }
  // A player pressed Exit Table (the client sent 'leave'): their seat is locked for the rest of this match, same as Kalak.
  markExited(client) {
    if (client?.role !== 'player' || client.seat == null) return;
    const seat = Number(client.seat) - 1;
    this.exitedSeats.add(seat);
    this.connectedSeats.delete(seat);
    this.audit('deuce_player_exited', { seat: seat + 1 });
    if (this.engine) this.persist().catch(error => console.error('Deuce exit lock persistence failed:', error.message));
  }
  isSeatExited(seat) { return this.exitedSeats.has(Number(seat) - 1); }
  getMetrics() { return { ...this.metrics, started: this.started, round: this.engine?.round || 0, actor: this.engine?.actor == null ? null : this.engine.actor + 1 }; }

  close() { clearInterval(this.lifecycleTimer); this.reset(); }
}

module.exports = { DeuceMatchManager, DEUCE_TURN_TIMEOUT_MS: TURN_TIMEOUT_MS, DEUCE_DISCONNECT_GRACE_MS: DISCONNECT_GRACE_MS };
