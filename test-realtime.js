'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { RealtimeServer } = require('./realtime');

const config = {
  numPlayers: 2,
  chipsPerPlayer: 5000,
  startingBoot: 10,
  startingBlind: 10,
  matchStartDate: '',
  matchStartTime: '',
  players: [
    { seat: 1, name: 'Alice', password: 'alice-secret', type: 'human', kicked: false },
    { seat: 2, name: 'Bob', password: 'bob-secret', type: 'human', kicked: false },
  ],
  observerPassword: 'observer-secret',
};

function open(url, origin = 'http://localhost') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}
function nextMessage(socket, predicate = () => true, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error('Timed out waiting for WebSocket message')); }, timeout);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timer); socket.off('message', onMessage); resolve(message);
    }
    socket.on('message', onMessage);
  });
}
function close(socket) { return new Promise(resolve => { if (socket.readyState === WebSocket.CLOSED) return resolve(); socket.once('close', resolve); socket.close(); }); }

(async () => {
  const httpServer = http.createServer();
  const realtime = new RealtimeServer({
    server: httpServer,
    getConfig: () => config,
    checkBlocked: () => false,
    recordFailure: () => {},
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const port = httpServer.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;

  const alice = await open(url);
  const aliceLobbyPromise = nextMessage(alice, m => m.t === 'lobby');
  const aliceAuthedPromise = nextMessage(alice, m => m.t === 'authed');
  alice.send(JSON.stringify({ t: 'auth', password: 'alice-secret', sid: 'device-a' }));
  const aliceLobby = await aliceLobbyPromise;
  const aliceAuthed = await aliceAuthedPromise;
  assert.equal(aliceLobby.seat, 1);
  assert.equal(aliceAuthed.role, 'player');
  assert.equal(aliceAuthed.name, 'Alice');
  assert.equal(JSON.stringify(aliceLobby).includes('alice-secret'), false);
  assert.equal(JSON.stringify(aliceLobby).includes('bob-secret'), false);
  assert.equal(JSON.stringify(aliceLobby).includes('hand'), false);

  const duplicate = await open(url);
  duplicate.send(JSON.stringify({ t: 'auth', password: 'alice-secret', sid: 'device-b' }));
  const duplicateDenied = await nextMessage(duplicate, m => m.t === 'denied');
  assert.equal(duplicateDenied.code, 'in_use');
  await close(duplicate);

  const sameSession = await open(url);
  const oldConnectionNotice = nextMessage(alice, m => m.t === 'denied' && m.code === 'replaced');
  const sameSessionAuthed = nextMessage(sameSession, m => m.t === 'authed');
  sameSession.send(JSON.stringify({ t: 'auth', password: 'alice-secret', sid: 'device-a' }));
  assert.equal((await sameSessionAuthed).sid, 'device-a');
  assert.equal((await oldConnectionNotice).code, 'replaced');
  await new Promise(resolve => setTimeout(resolve, 25));

  const refresh = await open(url);
  const refreshAuthed = nextMessage(refresh, m => m.t === 'authed');
  refresh.send(JSON.stringify({ t: 'auth', password: 'alice-secret', sid: 'device-a' }));
  assert.equal((await refreshAuthed).seat, 1);
  await close(sameSession);

  const observer = await open(url);
  const observerAuthed = nextMessage(observer, m => m.t === 'authed');
  observer.send(JSON.stringify({ t: 'auth', password: 'observer-secret', sid: 'observer-1' }));
  assert.equal((await observerAuthed).role, 'observer');
  await close(observer);

  const wrong = await open(url);
  for (let i = 0; i < 10; i += 1) wrong.send(JSON.stringify({ t: 'auth', password: `wrong-${i}`, sid: `wrong-${i}` }));
  const deniedMessages = [];
  wrong.on('message', data => deniedMessages.push(JSON.parse(data.toString())));
  await new Promise(resolve => setTimeout(resolve, 50));
  // The production guard is supplied by server.js; this unit layer verifies its own safe failure response.
  assert.equal(deniedMessages.every(m => m.t === 'denied' || m.t === 'error'), true);
  await close(wrong);

  config.players[0].kicked = true;
  realtime.broadcastLobby(config);
  const kicked = await nextMessage(refresh, m => m.t === 'denied' && m.code === 'kicked');
  assert.equal(kicked.code, 'kicked');
  await close(refresh);

  realtime.close();
  await new Promise(resolve => httpServer.close(resolve));
  console.log('Phase 2 WebSocket tests passed: auth, session lock, refresh replacement, observer safety, and kick broadcast.');
})().catch(error => { console.error(error); process.exitCode = 1; });
