// KALAK 3PATTI — tournament server
//
// Holds the tournament table SERVER-SIDE (seat passwords, observer password, table settings, kicked seats,
// match start date/time) so none of it ever ships in the page source. Jobs:
//   1. Let the admin create / kill the table, kick a player and change the match start (all password-gated).
//   2. Let a player's password be checked against the table without ever exposing the password list itself.
// Live game-state sync is owned by MatchManager and the authenticated WebSocket layer.
// The table config remains server-side; match snapshots are persisted separately for restart recovery.
//
// WHERE THE TABLE IS SAVED
//   • If UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set (Render → Environment) the table is saved in
//     an Upstash Redis database. That survives Render restarts, sleep and redeploys — the table stays until the
//     admin presses KILL THE TABLE.
//   • If they are NOT set it falls back to a local file. Fine on your own computer, but on Render's free plan the
//     disk is wiped on every restart / redeploy / 15-minute sleep, so the table would disappear.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { RealtimeServer } = require('./realtime');
const { MatchManager } = require('./match-manager');

const app = express();
app.use(express.json({ limit: '32kb', strict: true }));
// Render (and most PaaS hosts) sit behind a reverse proxy, so the raw socket address Express sees is the proxy's.
// `trust proxy` makes Express read the real client IP from X-Forwarded-For, which the rate limit below relies on.
app.set('trust proxy', 1);

// Only /public is served over HTTP — server.js, package.json and the config file all stay outside the web root.
app.use(express.static(path.join(__dirname, 'public')));
// The game keeps its existing filename, so the root URL is pointed at it explicitly.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'KALAK_3PATTI.html')));

const PORT = process.env.PORT || 3000;
// Render sets these automatically at build+run time — no setup needed. Locally (no Render) they are blank.
const DEPLOY_COMMIT = process.env.RENDER_GIT_COMMIT || '';
const DEPLOY_BRANCH = process.env.RENDER_GIT_BRANCH || '';
const DEPLOY_SHORT = DEPLOY_COMMIT ? DEPLOY_COMMIT.slice(0, 7) : 'local (not on Render)';
const CONFIG_FILE = path.join(__dirname, 'tournament-config.json');
const REDIS_KEY = 'kalak3patti:table';
const MATCH_KEY = 'kalak3patti:match';
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);
const startedAt = Date.now();
const apiHits = new Map();
const auditEvents = [];
function audit(event, details = {}) {
  const safe = { at: new Date().toISOString(), event, ...details };
  auditEvents.push(safe);
  if (auditEvents.length > 200) auditEvents.shift();
  console.log(JSON.stringify({ scope: 'audit', ...safe }));
}
function apiRateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const rec = apiHits.get(ip);
  if (!rec || now > rec.reset) apiHits.set(ip, { count: 1, reset: now + 60000 });
  else if (++rec.count > 120) return res.status(429).json({ error: 'Too many requests — try again later.' });
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, rec] of apiHits) if (now > rec.reset) apiHits.delete(ip); }, 60000).unref();

// ── admin password: from an environment variable so it's never committed to source control. If none is set
// a random one is generated and printed once (there is never a guessable default in the code). Set
// ADMIN_PASSWORD in Render's Environment tab so it stays the same across restarts. ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
if (!process.env.ADMIN_PASSWORD) {
  console.log(`\nNo ADMIN_PASSWORD environment variable set — generated one for this run:\n\n  ${ADMIN_PASSWORD}\n\nSet ADMIN_PASSWORD as an env var (in Render: Environment tab) so it stays the same across restarts.\n`);
}
console.log(USE_REDIS
  ? 'Table storage: Upstash Redis (survives restarts).'
  : 'Table storage: local file — on Render\'s free plan this is wiped on restart. Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN to keep the table saved.');
console.log(`Deployed commit: ${DEPLOY_SHORT}${DEPLOY_BRANCH ? ' (branch ' + DEPLOY_BRANCH + ')' : ''}`);

// ── storage ──────────────────────────────────────────────────────────────────────────────────────────────
// One tiny call to Upstash's REST API: POST a JSON array like ["SET","key","value"]. Uses Node's built-in
// http/https modules so it works on any Node version and needs no extra dependency.
function redisCmd(cmd) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTASH_URL);
    const lib = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(cmd);
    const req = lib.request({
      hostname: url.hostname, port: url.port || undefined, path: url.pathname || '/', method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 8000
    }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* handled below */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json && !json.error) return resolve(json.result);
        reject(new Error('Upstash error ' + res.statusCode + ': ' + ((json && json.error) || data.slice(0, 120))));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Upstash request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
async function readStored() {
  if (USE_REDIS) {
    const raw = await redisCmd(['GET', REDIS_KEY]);
    return raw ? JSON.parse(raw) : null;
  }
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) { return null; }
}
async function writeStored(cfg) {                    // cfg === null deletes the table
  if (USE_REDIS) {
    if (cfg === null) await redisCmd(['DEL', REDIS_KEY]);
    else await redisCmd(['SET', REDIS_KEY, JSON.stringify(cfg)]);
    return;
  }
  if (cfg === null) { try { fs.unlinkSync(CONFIG_FILE); } catch (e) { /* already gone */ } }
  else fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
async function readMatchSnapshot() {
  if (USE_REDIS) {
    const raw = await redisCmd(['GET', MATCH_KEY]);
    return raw ? JSON.parse(raw) : null;
  }
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'match-state.json'), 'utf8')); } catch (e) { return null; }
}
async function writeMatchSnapshot(snapshot) {
  if (USE_REDIS) {
    if (snapshot === null) await redisCmd(['DEL', MATCH_KEY]);
    else await redisCmd(['SET', MATCH_KEY, JSON.stringify(snapshot)]);
    return;
  }
  const file = path.join(__dirname, 'match-state.json');
  if (snapshot === null) { try { fs.unlinkSync(file); } catch (e) { /* already gone */ } }
  else fs.writeFileSync(file, JSON.stringify(snapshot));
}

// The table lives in memory (fast) and is written through to storage on every change. It is loaded once at
// startup; if storage can't be reached the API answers 503 instead of pretending "no table exists" — that way a
// hiccup can never look like a killed table (or let someone overwrite the saved one).
let TOURNAMENT_CONFIG = null;
let loaded = false;
let realtime = null;
let matchManager = null;
async function ensureLoaded() {
  if (loaded) return;
  TOURNAMENT_CONFIG = await readStored();
  loaded = true;
}
async function commit(newCfg) {                      // save first, only then change what's in memory
  await writeStored(newCfg);
  TOURNAMENT_CONFIG = newCfg;
}
app.use('/api', apiRateLimit, async (req, res, next) => {
  try { await ensureLoaded(); next(); }
  catch (e) {
    console.error('Storage load failed:', e.message);
    res.status(503).json({ error: 'Saved table temporarily unavailable — try again in a moment.' });
  }
});

// Public operational endpoints contain no passwords, cards, or player secrets.
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000), storage: USE_REDIS ? 'upstash' : 'local' }));
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.floor((Date.now() - startedAt) / 1000), storage: USE_REDIS ? 'upstash' : 'local', table: Boolean(TOURNAMENT_CONFIG), status: TOURNAMENT_CONFIG?.status || 'waiting' }));
app.get('/api/metrics', (req, res) => res.json({ uptime: Math.floor((Date.now() - startedAt) / 1000), storage: USE_REDIS ? 'upstash' : 'local', table: Boolean(TOURNAMENT_CONFIG), status: TOURNAMENT_CONFIG?.status || 'waiting', match: matchManager?.getMetrics?.() || null, auditEvents: auditEvents.slice(-20) }));

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
// constant-time compare so a wrong-password response can't be timed to leak how many characters matched
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// In-memory brute-force guard: 10 WRONG passwords per IP per rolling minute (on any password endpoint), then
// that IP is told to wait. Only failures count, so a whole class joining from one Wi-Fi isn't locked out.
const failures = new Map();
function blocked(ip) {
  const rec = failures.get(ip);
  return !!rec && Date.now() <= rec.reset && rec.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  let rec = failures.get(ip);
  if (!rec || now > rec.reset) rec = { count: 0, reset: now + 60000 };
  rec.count++;
  failures.set(ip, rec);
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of failures) if (now > r.reset) failures.delete(ip); }, 60000).unref();

// Gate for every admin write/read: checks the password (and the brute-force guard) and answers the request itself if it fails.
function requireAdmin(req, res) {
  if (blocked(req.ip)) { res.status(429).json({ error: 'Too many attempts — wait a minute.' }); return false; }
  const { adminPassword } = req.body || {};
  if (typeof adminPassword === 'string' && safeEqual(adminPassword, ADMIN_PASSWORD)) return true;
  recordFailure(req.ip);
  res.status(401).json({ error: 'Incorrect password' });
  return false;
}
const wrap = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error('Request failed:', e.message);
  res.status(500).json({ error: 'Could not save — try again.' });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
function validDate(s) {                               // '' (not set) or a real calendar date YYYY-MM-DD
  if (s === '') return true;
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function validTime(s) { return s === '' || (typeof s === 'string' && TIME_RE.test(s) && +s.slice(0, 2) < 24 && +s.slice(3, 5) < 60); }
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const int = (v, def, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
function blindCap(v) {
  const value = str(v, 20);
  if (!value || /^unlimited$/i.test(value)) return 'Unlimited';
  return /^\d+$/.test(value) && Number(value) > 0 ? String(Math.min(Number(value), 100000000)) : null;
}

// Turn whatever the client sent into a clean table config. `kicked` and `result` are owned by the server:
// anything the client sends for them is ignored.
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.players)) return { error: 'Malformed table config' };
  const n = int(raw.numPlayers, 0, 2, 8);
  if (n < 2) return { error: 'A table needs 2 to 8 seats.' };
  const players = [];
  for (let i = 1; i <= n; i++) {
    const p = raw.players.find(x => x && x.seat === i);
    if (!p) return { error: 'Seat ' + i + ' is missing.' };
    players.push({
      seat: i,
      name: str(p.name, 24) || 'Player' + i,
      password: str(p.password, 40) || String(i),
      type: p.type === 'computer' ? 'computer' : 'human',
      kicked: false
    });
  }
  const observerPassword = str(raw.observerPassword, 40) || 'abc';
  const humanPws = players.filter(p => p.type === 'human').map(p => p.password);
  if (new Set(humanPws).size !== humanPws.length) return { error: 'Two players have the same password — every player needs their own.' };
  if (humanPws.includes(observerPassword)) return { error: 'The observer password matches a player password — make it different.' };
  if (!validDate(raw.matchStartDate == null ? '' : raw.matchStartDate)) return { error: 'Match start date must be a real date.' };
  if (!validTime(raw.matchStartTime == null ? '' : raw.matchStartTime)) return { error: 'Match start time is not valid.' };
  const maxBlindCall = blindCap(raw.maxBlindCall);
  if (maxBlindCall === null) return { error: 'Max Blind / Call must be Unlimited or a positive number.' };
  return {
    config: {
      numPlayers: n,
      players,
      observerPassword,
      chipsPerPlayer: int(raw.chipsPerPlayer, 5000, 1, 100000000),
      startingBoot: int(raw.startingBoot, 10, 1, 100000000),
      startingBlind: int(raw.startingBlind, 10, 1, 100000000),
      maxBlindCall,
      bootIncreaseMinutes: int(raw.bootIncreaseMinutes, 5, 1, 1440),
      matchStartDate: raw.matchStartDate || '',
      matchStartTime: raw.matchStartTime || ''
    }
  };
}

// ── ADMIN: login gate for the UI. Every write below checks the password again, so this alone authorizes nothing. ──
app.post('/api/admin/login', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  const { password } = req.body || {};
  if (typeof password === 'string' && safeEqual(password, ADMIN_PASSWORD)) return res.json({ ok: true });
  recordFailure(req.ip);
  res.status(401).json({ error: 'Incorrect password' });
});

// ── ADMIN: read the current table (including passwords — only the admin who set them can see them again) ──
app.post('/api/admin/table/get', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ config: TOURNAMENT_CONFIG, matchStatus: matchManager ? await matchManager.adminState() : null });
}));

// ── ADMIN: create the table. Refuses if one is already online — kill it first. ──
app.post('/api/admin/table', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (TOURNAMENT_CONFIG) return res.status(409).json({ error: 'A table is already online. Kill it first to create a new one.' });
  const { config, error } = sanitizeConfig((req.body || {}).config);
  if (error) return res.status(400).json({ error });
  await commit(config);
  if (realtime) realtime.broadcastLobby(TOURNAMENT_CONFIG);
  res.json({ ok: true, config });
}));

// ── ADMIN: kill the table. Join Tournament finds nothing afterwards. ──
app.post('/api/admin/table/kill', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  await commit(null);
  if (matchManager) { matchManager.reset(); await matchManager.deleteSnapshot(); }
  if (realtime) realtime.broadcastLobby(null);
  res.json({ ok: true });
}));

// ── ADMIN: kick a player — their password stops working for JOIN TOURNAMENT ──
app.post('/api/admin/table/kick', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!TOURNAMENT_CONFIG) return res.status(404).json({ error: 'No table is online.' });
  const seat = parseInt((req.body || {}).seat, 10);
  const target = TOURNAMENT_CONFIG.players.find(p => p.seat === seat);
  if (!target) return res.status(400).json({ error: 'No such seat.' });
  if (target.type !== 'human') return res.status(400).json({ error: 'Computer seats can\'t be kicked.' });
  if (!target.kicked) {
    const next = { ...TOURNAMENT_CONFIG, players: TOURNAMENT_CONFIG.players.map(p => p.seat === seat ? { ...p, kicked: true } : p) };
    await commit(next);
    if (matchManager) await matchManager.adminKick(seat);
    if (realtime) realtime.broadcastLobby(TOURNAMENT_CONFIG);
  }
  res.json({ ok: true, config: TOURNAMENT_CONFIG });
}));

// ── ADMIN: change the match start date and/or time of the live table ──
app.post('/api/admin/table/start', wrap(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!TOURNAMENT_CONFIG) return res.status(404).json({ error: 'No table is online.' });
  const b = req.body || {};
  const matchStartDate = b.matchStartDate == null ? '' : b.matchStartDate;
  const matchStartTime = b.matchStartTime == null ? '' : b.matchStartTime;
  if (!validDate(matchStartDate)) return res.status(400).json({ error: 'Match start date must be a real date.' });
  if (!validTime(matchStartTime)) return res.status(400).json({ error: 'Match start time is not valid.' });
  await commit({ ...TOURNAMENT_CONFIG, matchStartDate, matchStartTime });
  if (realtime) realtime.broadcastLobby(TOURNAMENT_CONFIG);
  res.json({ ok: true, config: TOURNAMENT_CONFIG });
}));

// ── PLAYER: find a seat (or the observer slot) by password. Only ever returns THIS caller's own seat info plus
// general table settings — never the seat list or anyone else's password. ──
app.post('/api/join', (req, res) => {
  if (blocked(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  if (!TOURNAMENT_CONFIG) return res.status(404).json({ error: 'No tournament has been created yet.' });

  const cfg = TOURNAMENT_CONFIG;
  const { password } = req.body || {};
  const tableInfo = {
    numPlayers: cfg.numPlayers,
    chipsPerPlayer: cfg.chipsPerPlayer,
    startingBoot: cfg.startingBoot,
    startingBlind: cfg.startingBlind,
    maxBlindCall: cfg.maxBlindCall,
    bootIncreaseMinutes: cfg.bootIncreaseMinutes,
    matchStartDate: cfg.matchStartDate || '',
    matchStartTime: cfg.matchStartTime || ''
  };
  // Once a match has finished (cfg.result, set when the live match is wired in) a joiner only sees who won.
  const ended = cfg.result ? { ended: true, winner: cfg.result.winner } : {};

  if (typeof password === 'string' && password) {
    // Computer seats are excluded on purpose — those auto-fill with a bot at match start and were never meant to be joined by a password.
    const seatMatch = (cfg.players || []).find(p => p.type === 'human' && safeEqual(p.password, password));
    if (seatMatch) {
      if (seatMatch.kicked) return res.status(403).json({ error: 'You have been removed from this table by the admin.', kicked: true });
      return res.json({ kind: 'seat', seat: seatMatch.seat, name: seatMatch.name, tableInfo, ...ended });
    }
    if (cfg.observerPassword && safeEqual(cfg.observerPassword, password)) return res.json({ kind: 'observer', tableInfo, ...ended });
  }
  recordFailure(req.ip);
  res.status(401).json({ error: 'Incorrect password' });
});

// Public on purpose — a commit hash is not a secret, and the admin panel needs it without being logged in yet.
app.post('/api/version', (req, res) => res.json({ commit: DEPLOY_SHORT, branch: DEPLOY_BRANCH }));

const httpServer = http.createServer(app);
realtime = new RealtimeServer({
  server: httpServer,
  getConfig: async () => { if (!loaded) await ensureLoaded(); return TOURNAMENT_CONFIG; },
  checkBlocked: ip => blocked(ip),
  recordFailure: ip => recordFailure(ip),
  onAuthenticated: client => { if (matchManager) matchManager.register(client); },
  onClose: client => { if (matchManager) matchManager.unregister(client); },
  onMessage: (message, client) => matchManager ? matchManager.handleMessage(message, client) : false,
});
matchManager = new MatchManager({
  getConfig: async () => { if (!loaded) await ensureLoaded(); return TOURNAMENT_CONFIG; },
  saveConfig: commit,
  loadSnapshot: readMatchSnapshot,
  saveSnapshot: writeMatchSnapshot,
  deleteSnapshot: () => writeMatchSnapshot(null),
  realtime,
  audit,
});
matchManager.restoreIfPresent().catch(error => console.error('Match restore failed:', error.message));
httpServer.listen(PORT, () => console.log(`KALAK 3PATTI server listening on :${PORT}`));
