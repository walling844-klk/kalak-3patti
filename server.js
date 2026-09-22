// KALAK 3PATTI — tournament server
//
// Holds the tournament config (seat passwords, observer password, table settings) SERVER-SIDE so none of it
// ever ships in the page source anymore. Two jobs for now:
//   1. Let the admin create/update the table (password-gated).
//   2. Let a player's password be checked against it without ever exposing the password list itself.
// Live game-state sync (actually starting/running a networked match) isn't wired in yet — this is just the
// password/config layer that has to exist first. See KALAK_3PATTI.html's ADMIN PANEL / JOIN TOURNAMENT code
// for the client side of this.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
// Render (and most PaaS hosts) put your app behind a reverse proxy, so the raw socket address Express sees
// is the proxy's, not the visitor's. `trust proxy` tells Express to read the real client IP from the
// X-Forwarded-For header the proxy sets — without this, rateLimited() below would bucket every visitor
// together under one shared "IP" and the 10-attempts-per-minute limit would apply to everyone combined.
app.set('trust proxy', 1);

// Only /public is served over HTTP — server.js, package.json and the config file itself all stay outside
// the web root, so there's no way to request tournament-config.json (or this file) straight over HTTP.
app.use(express.static(path.join(__dirname, 'public')));
// express.static only auto-serves a file literally named index.html — the game keeps its existing filename,
// so the root URL is pointed at it explicitly instead of renaming it.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'KALAK_3PATTI.html')));

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'tournament-config.json');

// ── admin password: taken from an environment variable so it's never committed to source control. If none
// is set (e.g. running locally for the first time) a random one is generated and printed once — that way
// there's never a guessable default sitting in the code. Set ADMIN_PASSWORD in Render's dashboard for a
// real deployment so it doesn't change every time the server restarts. ──
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
if (!process.env.ADMIN_PASSWORD) {
  console.log(`\nNo ADMIN_PASSWORD environment variable set — generated one for this run:\n\n  ${ADMIN_PASSWORD}\n\nSet ADMIN_PASSWORD as an env var (in Render: Environment tab) so it stays the same across restarts.\n`);
}

// ── tiny persistence: a local JSON file so the table survives a Render free-tier sleep/wake cycle (a real
// redeploy still wipes the disk — fine for now; swapping in a real database is a later upgrade). ──
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return null; }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
let TOURNAMENT_CONFIG = loadConfig();

// ── constant-time compare so a wrong-password response can't be timed to leak how many characters matched ──
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── crude in-memory rate limit on the two password endpoints: 10 attempts per IP per rolling minute. Good
// enough to blunt casual brute-forcing of short seat passwords without adding a dependency. ──
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, reset: now + 60000 };
  if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count > 10;
}

// ── ADMIN: just the login gate for the UI. The real check happens again on every write below too, so this
// alone is never trusted to authorize anything. ──
app.post('/api/admin/login', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  const { password } = req.body || {};
  if (typeof password === 'string' && safeEqual(password, ADMIN_PASSWORD)) return res.json({ ok: true });
  res.status(401).json({ error: 'Incorrect password' });
});

// ── ADMIN: fetch the current config to pre-fill the Create Table form. Only the admin (who set these
// passwords in the first place) can see them come back. ──
app.post('/api/admin/table/get', (req, res) => {
  const { adminPassword } = req.body || {};
  if (!safeEqual(adminPassword || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ config: TOURNAMENT_CONFIG });
});

// ── ADMIN: create/update the table ──
app.post('/api/admin/table', (req, res) => {
  const { adminPassword, config } = req.body || {};
  if (!safeEqual(adminPassword || '', ADMIN_PASSWORD)) return res.status(401).json({ error: 'Incorrect password' });
  if (!config || !Array.isArray(config.players)) return res.status(400).json({ error: 'Malformed table config' });
  TOURNAMENT_CONFIG = config;
  saveConfig(TOURNAMENT_CONFIG);
  res.json({ ok: true });
});

// ── PLAYER: find a seat (or the observer slot) by password. Only ever returns THIS caller's own seat info
// plus general table settings — never the seat list or anyone else's password. ──
app.post('/api/join', (req, res) => {
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait a minute.' });
  if (!TOURNAMENT_CONFIG) return res.status(404).json({ error: 'No tournament has been created yet.' });

  const cfg = TOURNAMENT_CONFIG;
  const { password } = req.body || {};
  const tableInfo = {
    numPlayers: cfg.numPlayers,
    chipsPerPlayer: cfg.chipsPerPlayer,
    startingBoot: cfg.startingBoot,
    startingBlind: cfg.startingBlind,
    matchStartTime: cfg.matchStartTime
  };

  if (typeof password === 'string' && password) {
    // Computer seats are excluded on purpose — those auto-fill with a bot at match start and were never
    // meant to be joined by a password.
    const seatMatch = (cfg.players || []).find(p => p.type === 'human' && safeEqual(p.password, password));
    if (seatMatch) return res.json({ kind: 'seat', seat: seatMatch.seat, name: seatMatch.name, tableInfo });
    if (cfg.observerPassword && safeEqual(cfg.observerPassword, password)) return res.json({ kind: 'observer', tableInfo });
  }
  res.status(401).json({ error: 'Incorrect password' });
});

app.listen(PORT, () => console.log(`KALAK 3PATTI server listening on :${PORT}`));
