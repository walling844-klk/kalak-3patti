/* Online Deuce tournament client. Loaded inline by the Deuce page. */
(function () {
  'use strict';
  // Only run the Deuce tournament code on the Deuce of Spades page (the only page that defines window.DEUCE_UI).
  // The Kalak 3PATTI page also loads this file: there it changes nothing about Kalak's own JOIN / ADMIN buttons and keys.
  // Its only job on that page is to send the DEUCE OF SPADES folder over to the separate Deuce page at /deuce.
  if (!window.DEUCE_UI) { window.openDeuceFolder = () => { location.href = '/deuce'; }; return; }
  // On the Deuce page: the TEENPATTI folder goes back to the Kalak page at /, and the page opens straight on the Deuce menu.
  window.openTeenpattiFolder = () => { location.href = '/'; };
  if (typeof window.openDeuceFolder === 'function') window.openDeuceFolder();
  const R = { password: null, seat: null, role: null, socket: null, reconnect: null, state: null, selected: new Set(), adminPassword: null, adminConfig: null };
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cardLabel = card => card?.id === '2S-J1' || card?.id === '2S-J2' ? '🃏' : `${card?.rank || ''}${card?.suit || ''}`;
  const cardHTML = (card, selected) => `<button type="button" class="deuce-card ${card?.red ? 'red' : 'black'} ${card?.joker ? 'joker' : ''} ${selected ? 'selected' : ''}" data-online-card="${esc(card?.id)}"><span class="dc-rank">${esc(card?.id === '2S-J1' || card?.id === '2S-J2' ? '🃏' : card?.rank)}</span><span class="dc-suit">${esc(card?.id === '2S-J1' || card?.id === '2S-J2' ? '' : card?.suit)}</span></button>`;
  async function api(path, body) {
    try { const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const data = await res.json().catch(() => ({})); return { ok: res.ok, status: res.status, data }; }
    catch (_) { return { ok: false, status: 0, data: { error: 'Could not reach the server — try again.' } }; }
  }
  function formatDateInput(el) { const d = el.value.replace(/\D/g, '').slice(0, 8); el.value = d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d; }
  function isoToDmy(value) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || ''); return m ? `${m[3]}/${m[2]}/${m[1]}` : (value || ''); }
  function normalizeDate(value) { const raw = String(value || '').trim(); if (!raw) return ''; if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw; const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw); return match ? `${match[3]}-${match[2]}-${match[1]}` : raw; }
  function notice(text, error) { const node = $('deuce-message') || $('dct-status'); if (!node) return; node.textContent = text; node.classList.toggle('error', !!error); node.classList.add('show'); clearTimeout(notice.timer); notice.timer = setTimeout(() => node.classList.remove('show', 'error'), 4200); }
  function websocketUrl() { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/deuce-ws`; }
  function sessionId() { const key = 'deuce-online-session'; let sid = localStorage.getItem(key); if (!sid) { sid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`; localStorage.setItem(key, sid); } return sid; }
  function closeSocket() { if (R.reconnect) { clearTimeout(R.reconnect); R.reconnect = null; } if (R.socket) { R.socket.onclose = null; R.socket.close(); R.socket = null; } }
  function connectSocket() {
    if (!R.password || R.socket?.readyState === WebSocket.OPEN || R.socket?.readyState === WebSocket.CONNECTING) return;
    closeSocket();
    R.socket = new WebSocket(websocketUrl());
    R.socket.onopen = () => R.socket.send(JSON.stringify({ t: 'auth', password: R.password, sid: sessionId() }));
    R.socket.onmessage = event => { try { onMessage(JSON.parse(event.data)); } catch (_) {} };
    R.socket.onclose = () => { if (R.password) R.reconnect = setTimeout(connectSocket, 2500); };
  }
  function send(action, payload) {
    if (!R.socket || R.socket.readyState !== WebSocket.OPEN) return notice('Reconnecting to the Deuce table…', true);
    R.socket.send(JSON.stringify({ t: 'deuceAction', action, ...(payload || {}) }));
  }
  // ── Tournament table = the Play-vs-Computer table ──
  // The server owns the game; this client only feeds each server state into the SAME table code Play vs Computer
  // uses (seats, hand, GROUP / PLAY / PACK, turn ring, popups, deal animation) via window.DEUCE_UI.
  const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const LAYOUT = { 2: [0, 3], 3: [0, 2, 4], 4: [0, 2, 3, 4], 5: [0, 1, 2, 4, 5], 6: [0, 1, 2, 3, 4, 5] };
  const UI = () => window.DEUCE_UI;
  const norm = card => card ? { ...card, suit: SYM[card.suit] || card.suit, red: card.suit === 'H' || card.suit === 'D' || card.suit === '♥' || card.suit === '♦' } : card;
  const normGroups = groups => (groups || [null, null, null]).map(group => group ? group.map(norm) : null);
  const NET = {
    group(ids) {
      if (!ids || !ids.length) return UI().showMsg('Select cards first', 1200);
      send('group', { cardIds: ids.slice() }); UI().D.selectedCards = [];
      UI().showMsg(`<strong>GROUPED</strong> ${ids.length} card${ids.length === 1 ? '' : 's'} in press order`, 1200);
    },
    play(index) { send('play', { groupIndex: index }); },
    pack() { send('pack'); },
    arrange(groups) { send('group', { cardIds: groups.flat().filter(Boolean).map(card => card.id) }); },
  };
  function clearTimers() {
    clearInterval(R.tick); R.tick = null; clearTimeout(R.dealT); clearTimeout(R.popupT); clearInterval(R.popupI);
    R.dealing = false;
  }
  function leaveOnline() { R.leaving = true; clearTimers(); closeSocket(); R.password = null; location.reload(); }
  // EXIT TABLE while playing in the tournament: tell the server (so the seat is locked for the rest of this match, exactly like
  // Kalak), then drop the connection and return to a fresh Deuce menu. Observers just disconnect - they hold no seat.
  function exitOnline() {
    R.leaving = true; clearTimers();
    const socket = R.socket, isSeat = R.role === 'seat';
    R.password = null;                                // no automatic reconnect from here on
    let finished = false;
    const finish = () => { if (finished) return; finished = true; closeSocket(); location.reload(); };
    if (isSeat && socket && socket.readyState === WebSocket.OPEN) {
      socket.onmessage = event => { try { if (JSON.parse(event.data).t === 'left') finish(); } catch (_) {} };
      socket.onclose = finish;
      try { socket.send(JSON.stringify({ t: 'leave' })); } catch (_) { return finish(); }
      setTimeout(finish, 1500);                       // never get stuck if the server does not answer
    } else finish();
  }
  // ── Waiting screen: before the admin's start time a player sees the SAME "YOU'RE SEATED" holding screen (table details +
  // live countdown) that the Kalak 3PATTI tournament shows - not an empty card table. The game table opens by itself when the
  // server starts the match. The screen re-appears if the admin resets the table for a second match. ──
  const IST_MS = 5.5 * 3600 * 1000;
  function startMs(info) {
    if (!info || (!info.matchStartDate && !info.matchStartTime)) return null;
    const date = info.matchStartDate || new Date(Date.now() + IST_MS).toISOString().slice(0, 10);   // date left empty = today (IST)
    let time = info.matchStartTime || '00:00'; if (time.length === 5) time += ':00';
    const t = Date.parse(`${date}T${time}+05:30`); return isNaN(t) ? null : t;
  }
  function clock12(hhmm) { const [h, m] = String(hhmm).split(':').map(Number); const d = new Date(); d.setHours(h, m || 0, 0, 0); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function startText(info) { return [isoToDmy(info.matchStartDate), info.matchStartTime ? `${clock12(info.matchStartTime)} IST` : ''].filter(Boolean).join(', '); }
  function countdownText(ms) {
    const total = Math.max(0, Math.floor(ms / 1000)), two = n => String(n).padStart(2, '0');
    const d = Math.floor(total / 86400), h = Math.floor(total % 86400 / 3600), m = Math.floor(total % 3600 / 60), sec = total % 60;
    return `${d > 0 ? `${d}d ` : ''}${two(h)}:${two(m)}:${two(sec)}`;
  }
  function tickWaiting() {
    const box = $('join-wait'); if (!box || !R.waiting) return;
    const start = startMs(R.tableInfo), left = start === null ? 0 : start - Date.now();
    box.innerHTML = left > 0 ? `<div class="join-waiting-note">Waiting for the match to start in</div><div id="join-countdown">${countdownText(left)}</div>` : '<div class="join-waiting-note">Waiting for the match to start…</div>';
  }
  function renderWaiting() {
    const info = R.tableInfo || {};
    $('join-seated-title').textContent = R.role === 'seat' ? "YOU'RE SEATED" : 'OBSERVING';
    $('join-seated-sub').textContent = R.role === 'seat' ? `Seat ${R.seat + 1} — ${R.name || ''}` : 'Watching only — no seat assigned';
    const rows = [`<div><b>Game:</b> Deuce of Spades · first to 9 points</div>`, `<div><b>Table:</b> ${esc(info.numPlayers)} seats</div>`];
    if (info.matchStartDate || info.matchStartTime) rows.push(`<div><b>Starts:</b> ${esc(startText(info))}</div>`);
    rows.push('<div id="join-wait"></div>');
    $('join-seated-details').innerHTML = rows.join('');
    tickWaiting();
  }
  function showWaiting() {
    R.waiting = true;
    $('btn-join-seated-leave').onclick = leaveWaiting;                                  // replace the Kalak page's own handlers
    $('join-seated-overlay').onclick = event => { if (event.target === $('join-seated-overlay')) leaveWaiting(); };
    renderWaiting();
    $('join-seated-overlay').classList.add('show');
    clearInterval(R.waitT); R.waitT = setInterval(tickWaiting, 1000);
  }
  function hideWaiting() { R.waiting = false; clearInterval(R.waitT); R.waitT = null; $('join-seated-overlay').classList.remove('show'); }
  // LEAVE on this screen just dismisses it (no seat is used up yet), exactly like Kalak.
  function leaveWaiting() { R.leaving = true; hideWaiting(); clearTimers(); closeSocket(); R.password = null; location.reload(); }
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && R.waiting) { event.stopImmediatePropagation(); leaveWaiting(); } }, true);
  // The admin readied the table for ANOTHER match: drop the finished one and wait for the next start, like the first time.
  function backToWaiting() {
    clearTimeout(R.dealT); clearTimeout(R.popupT); clearInterval(R.popupI); R.dealing = false;      // (the clock keeps running)
    const winner = $('deuce-winner-popup'); if (winner) winner.classList.remove('show');
    R.prev = null; R.seenSeq = null; R.state = null;
    showWaiting();
  }
  function startRemote(result) {
    R.seat = result.kind === 'seat' ? Number(result.seat) - 1 : null;
    R.role = result.kind; R.name = result.name;
    R.password = result.password;
    R.tableInfo = result.tableInfo || {};
    R.prev = null; R.seenSeq = null; R.inGame = false;
    window.DEUCE_NET = NET; window.finishDeuceMatch = leaveOnline;
    if (!result.status || result.status === 'waiting') showWaiting(); else enterGame();     // joined a match that is already running -> straight to the table
    connectSocket();
  }
  function enterGame() {
    if (R.inGame) return;
    R.inGame = true; hideWaiting();
    const ui = UI(), D = ui.D;
    $('deuce-overlay').style.display = 'none';
    $('deuce-game-layer').classList.add('online-deuce');
    Object.assign(D, { online: true, active: true, viewer: R.seat == null ? 0 : R.seat, dealt: false, roundDone: false, selectedCards: [], currentGroups: [], groupCyclePlayed: [], dealVisible: 0 });
    document.body.classList.add('deuce-active');
    ui.swapDeuceBrand();
    const sub = document.querySelector('.deuce-watermark .dw-sub'); if (sub) sub.textContent = 'TOURNAMENT';
    const room = $('deuce-room-info'); if (room && room.firstElementChild) room.firstElementChild.innerHTML = 'Room: <b>Tournament</b>';
    const swap = $('deuce-seat-switch'); if (swap) swap.style.display = 'none';
    ui.setStatus('Waiting for the tournament to start…');
    clearInterval(R.tick);
    R.tick = setInterval(() => { const seconds = Math.min(120, Math.max(0, Math.ceil((R.deadline - Date.now()) / 1000))); D.seconds = seconds; ui.updateClock(); }, 250);
  }
  function openJoin() { $('join-pass-input').value = ''; $('join-pass-error').style.display = 'none'; $('btn-join-pass-submit').onclick = submitJoin; $('join-pass-overlay').classList.add('show'); setTimeout(() => $('join-pass-input').focus(), 50); }
  async function submitJoin() {
    const value = $('join-pass-input').value.trim(); if (!value) return;
    const btn = $('btn-join-pass-submit'); if (btn.disabled) return; btn.disabled = true;
    const result = await api('/api/deuce/join', { password: value }); btn.disabled = false;
    if (!result.ok) { if (result.status === 404) { $('join-pass-overlay').classList.remove('show'); notice(result.data.error || 'No Deuce tournament is online.', true); return; } $('join-pass-error').textContent = result.data.error || 'Incorrect password'; $('join-pass-error').style.display = 'block'; return; }
    $('join-pass-overlay').classList.remove('show'); startRemote({ ...result.data, password: value });
  }
  function nameOf(i) { const p = UI().D.players[i]; return p ? p.name : `Player ${i + 1}`; }
  function showGroupPopup(state, done) {
    const ui = UI(), r = state.lastGroupResult, popup = $('deuce-group-popup');
    if (!popup || !r) return done();
    $('dgmp-title').textContent = `ROUND ${r.round} GROUP ${r.groupNo} MATCH COMPLETE`;
    $('dgmp-sub').textContent = r.matchOver ? `${nameOf(r.winner)} REACHED 9 POINTS` : r.winner == null ? 'DRAW — NO POINTS' : `${nameOf(r.winner)} WINS THIS GROUP MATCH • +1 POINT • DEALS NEXT`;
    const rows = $('deuce-group-results'); rows.innerHTML = '';
    r.entries.map(e => ({ ...e, group: e.group.map(norm) })).map(e => ({ ...e, eval: ui.evaluate(e.group) }))
      .sort((a, b) => Number(a.invalid) - Number(b.invalid) || ui.compareEval(b.eval, a.eval)).forEach((x, rank) => {
        const cards = ui.sortDisplayGroup(x.group, x.eval).map(({ source: c }) => `<span class="dr-result-card ${c.red ? 'red' : 'black'}${ui.isJokerCard(c) ? ' joker' : ''}">${ui.esc(ui.isExtraJoker(c) ? '🃏' : `${c.rank}${c.suit}`)}</span>`).join('');
        const row = document.createElement('div'); row.className = 'dr-result';
        row.innerHTML = `<div class="dr-result-head"><span>${rank + 1}. ${ui.esc(nameOf(x.seat))}${x.invalid ? ' — CARD INVALID' : ''}</span><b>${x.invalid ? 'CARD INVALID' : ui.esc(x.eval.name)}</b></div><div class="dr-result-cards">${cards}</div>`;
        rows.appendChild(row);
      });
    popup.classList.add('show');
    let seconds = 10; const cd = $('dgmp-countdown'); if (cd) cd.textContent = seconds;
    clearTimeout(R.popupT); clearInterval(R.popupI);
    const close = () => { clearTimeout(R.popupT); clearInterval(R.popupI); R.popupT = R.popupI = null; popup.classList.remove('show'); done(); };
    R.popupI = setInterval(() => { seconds--; if (cd) cd.textContent = Math.max(0, seconds); }, 1000);
    R.popupT = setTimeout(close, 10000);
    window.closeDeuceGroupPopup = close;
  }
  function showWinner(state) {
    const ui = UI(); ui.stopMatchTimer();
    $('dwp-winner').textContent = `${nameOf(state.winner)} WINS THE MATCH!`;
    $('deuce-winner-popup').classList.add('show');
  }
  function notifyTurn(state) {
    const ui = UI();
    if (R.seat == null) ui.showMsg(`<strong>${ui.esc(nameOf(state.actor)).toUpperCase()}'S TURN</strong>`, 1300);
    else ui.notifyDeuceTurn(state.actor);
  }
  function runDeal(delay, state) {
    const ui = UI(), D = ui.D;
    R.dealing = true; D.dealt = false; D.dealVisible = 0;
    const wrap = $('deuce-human-hand'), controls = $('deuce-human-controls'); if (wrap) wrap.innerHTML = ''; if (controls) controls.innerHTML = '';
    ui.setStatus(`Dealing — ${nameOf(state.dealer)} is dealer…`);
    let n = 5;
    const finish = () => {
      const box = $('deuce-message'); if (box) box.classList.remove('show', 'match-countdown');
      ui.animateDealDeuceCards(() => { R.dealing = false; D.dealt = true; D.dealVisible = 9; paint(R.state); notifyTurn(R.state); ui.toast(`Dealer: ${nameOf(R.state.dealer)}`); });
    };
    const tick = () => {
      if (n <= 0) return finish();
      ui.showMsg(`<strong>ROUND ${state.round} STARTS IN</strong><br><span style="font-size:2.1rem">${n}</span>`, 1100);
      n--; R.dealT = setTimeout(tick, 900);
    };
    clearTimeout(R.dealT); R.dealT = setTimeout(tick, delay);
  }
  // Server state → the same D fields Play vs Computer keeps locally, then the same render functions.
  function paint(state) {
    const ui = UI(), D = ui.D, count = state.players.length;
    D.players = Array.from({ length: 6 }, (_, i) => {
      const sp = state.players[i];
      if (!sp) return { name: `Player ${i + 1}`, score: 0, hand: [], groups: [null, null, null], played: [], packed: false, standing: true, avatarIdx: 0 };
      const mine = i === R.seat, name = mine ? 'YOU' : (sp.name || `Player ${i + 1}`);
      return { name, score: sp.score || 0, hand: [], groups: mine ? normGroups(sp.groups) : [null, null, null], played: [false, false, false],
        group2Invalid: !!sp.group2Invalid, group3Blocked: !!sp.group3Blocked, packed: !!sp.packed, standing: !!sp.removed, bot: !mine,
        avatarIdx: (D.avatarChoice && D.avatarChoice[i] != null) ? D.avatarChoice[i] : ui.avatarIdx(i, sp.name || `Player ${i + 1}`) };
    });
    D.hand = state.hand || 1; D.round = state.round || 1; D.actor = state.actor;
    D.dealer = state.dealer; for (let hop = 0; hop < count && state.players[D.dealer]?.removed; hop++) D.dealer = (D.dealer + 1) % count;   // a kicked seat can't wear the DEALER badge
     D.currentGroupIndex = state.currentGroupIndex;
    D.currentGroups = []; D.groupCyclePlayed = [];
    state.players.forEach((sp, i) => {
      if (sp.current?.group?.length) { const group = sp.current.group.map(norm); D.currentGroups[i] = { group, eval: ui.evaluate(group), invalid: !!sp.current.invalid, gi: sp.current.groupIndex }; D.groupCyclePlayed.push(i); }
      else if (sp.packed) D.groupCyclePlayed.push(i);
    });
    D.roundDone = !!state.gameOver;
    if (!R.dealing) { D.dealt = true; D.dealVisible = 9; }
    ui.renderSeats();
    const layout = LAYOUT[count] || LAYOUT[6];
    for (let i = 0; i < 6; i++) {
      const seat = $(`deuce-seat-${i}`); if (!seat) continue;
      if (i >= count) { seat.style.display = 'none'; continue; }
      seat.style.display = ''; seat.dataset.pos = String(layout[(i - D.viewer + count) % count]);
    }
    const room = $('deuce-room-info'); if (room) room.querySelector('.players-count').textContent = `👥 ${state.players.filter(p => !p.removed).length}/${count}`;
    $('deuce-round-no').textContent = D.round; $('deuce-hand-no').textContent = D.hand;
    ui.updateDeuceRoomInfo(); ui.renderRanking();
    if (R.seat == null) { $('deuce-human-hand').innerHTML = '<div class="online-observer-note" style="color:#ead9b8;text-align:center;letter-spacing:1px">You are observing this Deuce tournament.</div>'; $('deuce-human-controls').innerHTML = ''; }
    else ui.renderHuman();
    if (!R.dealing) ui.setStatus(state.gameOver ? `Match complete — ${nameOf(state.winner)} wins.` : state.actor === R.seat ? 'Your turn — choose one 3-card group.' : `${nameOf(state.actor)}'s turn…`);
    ui.updateClock();
  }
  function renderRemote(state) {
    const ui = UI(), D = ui.D;
    if (!state.players || !state.players.length) { ui.setStatus('Waiting for the tournament to start…'); return; }
    const prev = R.prev, seq = state.lastGroupResult ? state.lastGroupResult.seq : 0, pause = state.pauseRemainingMs || 0;
    const newResult = R.seenSeq != null && seq > R.seenSeq;
    const dealNow = prev ? state.round !== prev.round : pause > 0 && !seq;
    R.seenSeq = seq; R.state = state;
    R.deadline = Date.now() + pause + (state.turnRemainingMs == null ? 120000 : state.turnRemainingMs);
    if (state.matchStartedAt) ui.syncMatchTimer(state.matchStartedAt + 12000);
    if (prev && !dealNow) state.players.forEach((sp, i) => { if (sp.packed && !sp.removed && !prev.packed[i] && !newResult) ui.showMsg(i === R.seat ? '<strong>YOU PACKED</strong> — sitting out this round' : `<strong>${ui.esc(sp.name || 'PLAYER').toUpperCase()} PACKED</strong>`, 1500); });
    const turnChanged = !prev || prev.actor !== state.actor || dealNow;
    R.prev = { round: state.round, actor: state.actor, packed: state.players.map(p => !!p.packed) };
    if (dealNow) R.dealing = true;
    paint(state);
    let delay = 0;
    if (newResult) { delay = 10000; showGroupPopup(state, () => { if (state.gameOver) showWinner(state); else if (!dealNow && turnChanged && !state.gameOver) notifyTurn(R.state); }); }
    if (dealNow && !state.gameOver) runDeal(delay, state);
    else if (!newResult && turnChanged && prev && !state.gameOver) notifyTurn(state);
  }
  function onMessage(message) {
    if (message.t === 'deuceState') {
      const started = !!(message.players && message.players.length);
      if (started) { if (!R.inGame) enterGame(); else if (R.waiting) hideWaiting(); }       // the match began: the waiting screen gives way to the table
      else if (R.inGame && !R.waiting && !R.leaving) backToWaiting();                       // table was reset for another match: wait for it like Kalak does
      renderRemote(message);
    }
    else if (message.t === 'lobby') {
      if (message.tableInfo) R.tableInfo = message.tableInfo;
      if (R.inGame && !R.waiting && !R.leaving && message.status === 'waiting') backToWaiting();   // table reset for the next match
      else if (R.waiting) renderWaiting();                                                          // admin changed the start time
    }
    else if (message.t === 'error') notice(message.error || 'Action rejected.', true);
    else if (message.t === 'denied') {
      const wasWaiting = R.waiting, text = message.error || 'You no longer have access to this table.';
      closeSocket();
      if (wasWaiting) { hideWaiting(); R.password = null; if (typeof window.showComingSoon === 'function') window.showComingSoon('JOIN TOURNAMENT', text); else notice(text, true); }   // table killed / seat removed while waiting
      else notice(text, true);
    }
  }

  function populateAdmin(config) {
    if (!config) return;
    R.adminConfig = config;
    $('dct-num-players').value = config.numPlayers || 6;
    for (let i = 1; i <= 6; i++) { const p = config.players?.find(x => x.seat === i); $(`dct-name-${i}`).value = p?.name || `Player${i}`; $(`dct-pw-${i}`).value = p?.password || String(i); $(`dct-type-${i}`).value = p?.type || 'human'; }
    $('dct-observer-pw').value = config.observerPassword || 'abc'; $('dct-start-date').value = isoToDmy(config.matchStartDate); $('dct-start-time').value = config.matchStartTime || '';
    updateAdminSeats();
  }
  function updateAdminSeats() { const n = Number($('dct-num-players').value || 6); document.querySelectorAll('#dadmin-create-table-view .dct-seat').forEach(node => node.style.display = Number(node.dataset.seat) <= n ? '' : 'none'); }
  async function loadAdmin() { const result = await api('/api/deuce/admin/table/get', { adminPassword: R.adminPassword }); if (result.ok) { populateAdmin(result.data.config); refreshAdmin(result.data.config); } }
  function refreshAdmin(config) { const online = !!config; $('dct-form-wrap').classList.toggle('dct-locked', online); $('dct-form-wrap').inert = online; $('dct-actions').style.display = online ? 'none' : ''; $('dct-online').style.display = online ? 'block' : 'none'; if (online) { $('dct-online-info').textContent = `${config.numPlayers} seats · ${config.status || 'waiting'}`; $('btn-dct-start-now').style.display = config.status === 'live' ? 'none' : ''; renderAdminKick(config); } }
  function renderAdminKick(config) { const list = $('dct-kick-list'); if (!list) return; list.innerHTML = ''; (config.players || []).forEach(p => { const row = document.createElement('div'); row.className = 'dct-kick-row'; row.innerHTML = `<span class="dct-kick-name">${esc(p.name)}</span><span class="dct-kick-tag">${p.kicked ? 'KICKED' : p.type === 'computer' ? 'COMPUTER' : ''}</span>${!p.kicked && p.type !== 'computer' ? `<button type="button" class="dct-kick-btn" data-kick-seat="${p.seat}">KICK</button>` : ''}`; list.appendChild(row); }); list.querySelectorAll('[data-kick-seat]').forEach(b => b.addEventListener('click', async () => { if (!confirm(`Kick ${b.dataset.kickSeat}?`)) return; const r = await api('/api/deuce/admin/table/kick', { adminPassword: R.adminPassword, seat: Number(b.dataset.kickSeat) }); if (r.ok) { populateAdmin(r.data.config); refreshAdmin(r.data.config); } else notice(r.data.error, true); })); }
  function openAdmin() { $('dadmin-pass-input').value = ''; $('dadmin-pass-error').style.display = 'none'; $('dadmin-pass-overlay').classList.add('show'); setTimeout(() => $('dadmin-pass-input').focus(), 50); }
  async function submitAdmin() { const password = $('dadmin-pass-input').value; const result = await api('/api/admin/login', { password }); if (!result.ok) { $('dadmin-pass-error').textContent = result.data.error || 'Incorrect password'; $('dadmin-pass-error').style.display = 'block'; return; } R.adminPassword = password; $('dadmin-pass-overlay').classList.remove('show'); $('dadmin-panel-overlay').classList.add('show'); showAdminView('menu'); }
  function showAdminView(view) { const menu = view === 'menu'; $('dadmin-menu-view').style.display = menu ? '' : 'none'; $('dadmin-create-table-view').style.display = menu ? 'none' : ''; $('dadmin-panel-title').textContent = menu ? 'ADMIN PANEL' : 'CREATE TABLE'; if (!menu) loadAdmin(); }
  async function confirmTable() { const n = Number($('dct-num-players').value); const players = []; for (let seat = 1; seat <= n; seat++) players.push({ seat, name: $(`dct-name-${seat}`).value.trim() || `Player${seat}`, password: $(`dct-pw-${seat}`).value.trim() || String(seat), type: $(`dct-type-${seat}`).value === 'computer' ? 'computer' : 'human' }); const body = { adminPassword: R.adminPassword, config: { numPlayers: n, players, observerPassword: $('dct-observer-pw').value.trim() || 'abc', matchStartDate: normalizeDate($('dct-start-date').value), matchStartTime: $('dct-start-time').value || '' } }; const result = await api('/api/deuce/admin/table', body); if (!result.ok) return notice(result.data.error || 'Could not create table.', true); populateAdmin(result.data.config); refreshAdmin(result.data.config); $('dct-online').scrollIntoView?.({ block: 'end' }); notice('Deuce tournament table is online.'); }   // scroll down so TABLE IS ONLINE + the Kill button are on screen, like Kalak
  async function updateStart() { const result = await api('/api/deuce/admin/table/start', { adminPassword: R.adminPassword, matchStartDate: normalizeDate($('dct-edit-date').value), matchStartTime: $('dct-edit-time').value || '' }); if (!result.ok) return notice(result.data.error, true); populateAdmin(result.data.config); refreshAdmin(result.data.config); }
  async function startNow() { const result = await api('/api/deuce/admin/table/start-now', { adminPassword: R.adminPassword }); if (!result.ok) return notice(result.data.error, true); populateAdmin(result.data.config); refreshAdmin(result.data.config); }
  function askKill() { $('btn-dct-kill').style.display = 'none'; $('dct-kill-confirm').style.display = 'block'; $('dct-kill-confirm').scrollIntoView?.({ block: 'end' }); }
  function cancelKill() { $('dct-kill-confirm').style.display = 'none'; $('btn-dct-kill').style.display = ''; $('btn-dct-kill-yes').disabled = false; }
  async function killTable() { const yes = $('btn-dct-kill-yes'); yes.disabled = true; const result = await api('/api/deuce/admin/table/kill', { adminPassword: R.adminPassword }); if (!result.ok) { yes.disabled = false; return notice(result.data.error || 'Could not kill the table.', true); } R.adminConfig = null; cancelKill(); refreshAdmin(null); $('dadmin-panel-overlay').classList.remove('show'); notice('Deuce table killed.'); }

  window.openDeuceJoinTournament = openJoin;
  window.submitDeuceJoinPass = submitJoin;
  window.openDeuceAdminPanel = openAdmin;
  window.submitDeuceAdminPass = submitAdmin;
  window.showDeuceAdminView = showAdminView;
  window.dctUpdateSeats = updateAdminSeats;
  window.dctFormatDateInput = formatDateInput;
  window.dctConfirm = confirmTable;
  window.dctUpdateStart = updateStart;
  window.dctStartNow = startNow;
  window.dctAskKill = askKill;
  window.dctCancelKill = cancelKill;
  window.dctKill = killTable;
  window.dctReset = () => { document.querySelectorAll('#dadmin-create-table-view input').forEach(input => input.value = ''); updateAdminSeats(); };
  window.closeDeuceAdminPass = () => $('dadmin-pass-overlay').classList.remove('show');
  window.closeDeuceAdminPanelView = () => $('dadmin-panel-overlay').classList.remove('show');
  // The Deuce page still carries a copy of Kalak's join box and its Enter-key handler (which calls /api/join, Kalak's table).
  // Catch Enter first, at document level, so only the Deuce join runs and nothing is ever sent to Kalak's table.
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target || event.target.id !== 'join-pass-input') return;
    event.stopImmediatePropagation(); event.preventDefault();
    if (!event.repeat) submitJoin();
  }, true);
  window.submitJoinPass = submitJoin;             // on this page the join box always means the Deuce tournament
  const baseExitTable = window.exitTable;         // the Deuce page's own Exit Table, still used for PLAY VS COMPUTER
  window.exitTable = function () {
    if (UI().D.online && R.role) return exitOnline();
    return typeof baseExitTable === 'function' ? baseExitTable.apply(this, arguments) : undefined;
  };
  $('dadmin-pass-input')?.addEventListener('keydown', event => { if (event.key === 'Enter') submitAdmin(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.password && (!R.socket || R.socket.readyState !== WebSocket.OPEN)) connectSocket(); });
})();
