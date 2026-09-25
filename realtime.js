'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');

const CLOSE_REPLACED = 4001;
const CLOSE_IN_USE = 4003;
const CLOSE_NOT_ALLOWED = 4008;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class RealtimeServer {
  constructor({ server, getConfig, checkBlocked, recordFailure, allowedOrigins = [], onMessage, onAuthenticated, onClose } = {}) {
    if (!server || !getConfig) throw new Error('RealtimeServer requires an HTTP server and getConfig callback');
    this.getConfig = getConfig;
    this.checkBlocked = checkBlocked || (() => false);
    this.recordFailure = recordFailure || (() => {});
    this.allowedOrigins = new Set(allowedOrigins.filter(Boolean));
    this.onMessage = onMessage || (() => false);
    this.onAuthenticated = onAuthenticated || (() => {});
    this.onClose = onClose || (() => {});
    this.sessions = new Map();
    this.clients = new Set();
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.heartbeat = setInterval(() => this.runHeartbeat(), 10000);
    this.heartbeat.unref();
  }

  originAllowed(origin, request) {
    if (!origin) return true; // non-browser clients have no Origin; authenticated data is still protected
    if (this.allowedOrigins.has(origin)) return true;
    const host = request.headers.host;
    return origin === `https://${host}` || origin === `http://${host}` || /^https?:\/\/localhost(?::\d+)?$/.test(origin);
  }

  handleConnection(socket, request) {
    const client = {
      socket,
      ip: request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown',
      authenticated: false,
      role: null,
      seat: null,
      sid: null,
      name: null,
      messageTimes: [],
      alive: true,
    };
    if (!this.originAllowed(request.headers.origin, request)) {
      this.send(client, { t: 'error', code: 'origin', error: 'Origin is not allowed.' });
      socket.close(CLOSE_NOT_ALLOWED, 'origin not allowed');
      return;
    }
    this.clients.add(client);
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', data => this.handleMessage(client, data));
    socket.on('close', () => this.release(client));
    socket.on('error', () => this.release(client));
  }

  runHeartbeat() {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  rateAllowed(client) {
    const now = Date.now();
    client.messageTimes = client.messageTimes.filter(time => now - time < 10000);
    if (client.messageTimes.length >= 30) return false;
    client.messageTimes.push(now);
    return true;
  }

  parse(data) {
    let message;
    try { message = JSON.parse(data.toString('utf8')); } catch { return null; }
    return message && typeof message === 'object' && !Array.isArray(message) ? message : null;
  }

  handleMessage(client, data) {
    if (data.length > 8192 || !this.rateAllowed(client)) {
      this.send(client, { t: 'error', code: 'rate', error: 'Too many or oversized messages.' });
      client.socket.close(CLOSE_NOT_ALLOWED, 'message limit');
      return;
    }
    const message = this.parse(data);
    if (!message || typeof message.t !== 'string' || message.t.length > 32 || Object.keys(message).length > 8) {
      this.send(client, { t: 'error', code: 'bad_message', error: 'Invalid message.' });
      return;
    }
    if (!client.authenticated) {
      if (message.t !== 'auth') {
        this.send(client, { t: 'error', code: 'auth_required', error: 'Authenticate first.' });
        return;
      }
      this.authenticate(client, message).catch(() => {
        this.send(client, { t: 'error', code: 'storage', error: 'Saved table temporarily unavailable.' });
      });
      return;
    }
    if (message.t === 'leave') {
      this.send(client, { t: 'left' });
      client.socket.close(1000, 'left');
      return;
    }
    if (message.t === 'ping') {
      this.send(client, { t: 'pong', at: Date.now() });
      return;
    }
    const handled = this.onMessage(message, client, this);
    if (!handled) this.send(client, { t: 'error', code: 'not_live', error: 'Live gameplay is waiting for the scheduled match start or required players.' });
  }

  async authenticate(client, message) {
    if (this.checkBlocked(client.ip)) {
      this.send(client, { t: 'denied', code: 'rate', error: 'Too many attempts — wait a minute.' });
      client.socket.close(CLOSE_NOT_ALLOWED, 'authentication rate limit');
      return;
    }
    const password = typeof message.password === 'string' && message.password.length <= 128 ? message.password : '';
    if (typeof message.password !== 'string' || message.password.length > 128) { this.send(client, { t: 'denied', code: 'bad_auth', error: 'Invalid authentication payload.' }); return; }
    const sid = typeof message.sid === 'string' ? message.sid.trim() : '';
    if (!sid || sid.length > 128) {
      this.send(client, { t: 'denied', code: 'bad_sid', error: 'A valid session id is required.' });
      return;
    }
    const config = await Promise.resolve(this.getConfig());
    if (!config) {
      this.send(client, { t: 'denied', code: 'no_table', error: 'No tournament has been created yet.' });
      return;
    }
    let role = null;
    let seat = null;
    let name = null;
    const player = (config.players || []).find(p => p.type === 'human' && safeEqual(p.password, password));
    if (player && player.kicked) {
      this.recordFailure(client.ip);
      this.send(client, { t: 'denied', code: 'kicked', error: 'You have been removed from this table.' });
      return;
    }
    if (player) {
      role = 'player';
      seat = player.seat;
      name = player.name;
    } else if (config.observerPassword && safeEqual(config.observerPassword, password)) {
      role = 'observer';
      name = 'Observer';
    } else {
      this.recordFailure(client.ip);
      this.send(client, { t: 'denied', code: 'bad_password', error: 'Incorrect password.' });
      return;
    }
    if (role === 'player') {
      const previous = this.sessions.get(seat);
      if (previous && previous.socket !== client.socket) {
        if (previous.sid === sid) {
          this.send(previous, { t: 'denied', code: 'replaced', error: 'This session moved to another connection.' });
          previous.socket.close(CLOSE_REPLACED, 'session replaced');
        } else {
          this.send(client, { t: 'denied', code: 'in_use', error: 'This seat is already in use.' });
          client.socket.close(CLOSE_IN_USE, 'seat already in use');
          return;
        }
      }
      this.sessions.set(seat, client);
    }
    client.authenticated = true;
    client.role = role;
    client.seat = seat;
    client.sid = sid;
    client.name = name;
    this.sendLobby(client, config);
    this.send(client, { t: 'authed', role, seat, name, sid });
    this.onAuthenticated(client);
  }

  safeTableInfo(config) {
    return {
      numPlayers: config.numPlayers,
      chipsPerPlayer: config.chipsPerPlayer,
      startingBoot: config.startingBoot,
      startingBlind: config.startingBlind,
      matchStartDate: config.matchStartDate || '',
      matchStartTime: config.matchStartTime || '',
    };
  }

  lobbyMessage(client, config) {
    return {
      t: 'lobby',
      status: config.status || 'waiting',
      tableInfo: this.safeTableInfo(config),
      seat: client.role === 'player' ? client.seat : null,
      name: client.name,
      inMatch: Boolean(config.status === 'live'),
      ended: Boolean(config.result),
      winner: config.result?.winner || null,
    };
  }

  sendLobby(client, config = this.getConfig()) {
    if (!config) {
      this.send(client, { t: 'denied', code: 'table_killed', error: 'The table has been killed.' });
      client.socket.close(1000, 'table killed');
      return;
    }
    this.send(client, this.lobbyMessage(client, config));
  }

  broadcastLobby(config = this.getConfig()) {
    for (const client of this.clients) {
      if (!client.authenticated) continue;
      if (!config) {
        this.send(client, { t: 'denied', code: 'table_killed', error: 'The table has been killed.' });
        client.socket.close(1000, 'table killed');
      } else {
        const player = client.role === 'player' && config.players?.find(p => p.seat === client.seat);
        if (player?.kicked) {
          this.send(client, { t: 'denied', code: 'kicked', error: 'You have been removed from this table.' });
          client.socket.close(1000, 'kicked');
        } else this.sendLobby(client, config);
      }
    }
  }

  sendToSeat(seat, message) {
    const client = this.sessions.get(seat);
    if (client) this.send(client, message);
  }

  send(client, message) {
    if (client.socket.readyState === 1) client.socket.send(JSON.stringify(message));
  }

  release(client) {
    this.clients.delete(client);
    this.onClose(client);
    if (client.seat != null && this.sessions.get(client.seat) === client) this.sessions.delete(client.seat);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.socket.close(1000, 'server closing');
    this.wss.close();
  }
}

module.exports = { RealtimeServer };
2
