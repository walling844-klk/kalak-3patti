/* Online Deuce tournament client. Loaded inline by the Deuce page. */
(function () {
  'use strict';
  const R = { password: null, seat: null, role: null, socket: null, reconnect: null, state: null, selected: new Set(), adminPassword: null, adminConfig: null };
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cardLabel = card => card?.id === '2S-J1' || card?.id === '2S-J2' ? '🃏' : `${card?.rank || ''}${card?.suit || ''}`;
  const cardHTML = (card, selected) => `<button type="button" class="deuce-card ${card?.red ? 'red' : 'black'} ${card?.joker ? 'joker' : ''} ${selected ? 'selected' : ''}" data-online-card="${esc(card?.id)}"><span class="dc-rank">${esc(card?.id === '2S-J1' || card?.id === '2S-J2' ? '🃏' : card?.rank)}</span><span class="dc-suit">${esc(card?.id === '2S-J1' || card?.id === '2S-J2' ? '' : card?.suit)}</span></button>`;
  async function api(path, body) {
    try { const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); const data = await res.json().catch(() => ({})); return { ok: res.ok, status: res.status, data }; }
    catch (_) { return { ok: false, status: 0, data: { error: 'Could not reach the server — try again.' } }; }
  }
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
  function startRemote(result) {
    R.seat = result.kind === 'seat' ? Number(result.seat) - 1 : null;
    R.role = result.kind;
    R.password = result.password;
    $('deuce-overlay').style.display = 'none';
    $('deuce-game-layer').classList.add('online-deuce');
    document.body.classList.add('deuce-active');
    if (window.DEUCE) { window.DEUCE.online = true; window.DEUCE.viewer = R.seat == null ? 0 : R.seat; }
    const brand = $('brand-logo'); if (brand) brand.innerHTML = '<span class="brand-crown">♛</span>DEUCE <em>OF SPADES</em>';
    connectSocket();
  }
  function openJoin() { $('join-pass-input').value = ''; $('join-pass-error').style.display = 'none'; $('join-pass-overlay').classList.add('show'); setTimeout(() => $('join-pass-input').focus(), 50); }
  async function submitJoin() {
    const value = $('join-pass-input').value.trim(); if (!value) return;
    const btn = $('btn-join-pass-submit'); btn.disabled = true;
    const result = await api('/api/deuce/join', { password: value }); btn.disabled = false;
    if (!result.ok) { if (result.status === 404) { $('join-pass-overlay').classList.remove('show'); notice(result.data.error || 'No Deuce tournament is online.', true); return; } $('join-pass-error').textContent = result.data.error || 'Incorrect password'; $('join-pass-error').style.display = 'block'; return; }
    $('join-pass-overlay').classList.remove('show'); startRemote({ ...result.data, password: value });
  }
  function cardFromId(id) { return R.state?.players?.[R.seat]?.hand?.find(card => card.id === id); }
  function renderRemote(state) {
    R.state = state;
    const players = state.players || [], count = players.length;
    for (let i = 0; i < 6; i++) {
      const player = players[i]; const seat = $(`deuce-seat-${i}`); if (!seat) continue;
      seat.style.display = player ? '' : 'none';
      if (!player) continue;
      $(`ds-name-${i}`).textContent = player.name || `Player ${i + 1}`;
      $(`ds-score-${i}`).textContent = `${player.score || 0} pts`;
      $(`ds-dealer-${i}`).style.display = i === state.dealer ? 'inline-block' : 'none';
      const groups = $(`ds-groups-${i}`); groups.innerHTML = '';
      if (player.current?.group?.length) player.current.group.forEach(card => { const mini = document.createElement('span'); mini.className = `ds-mini-card ${card.red ? 'red' : 'black'}${card.joker ? ' joker' : ''}`; mini.textContent = cardLabel(card); groups.appendChild(mini); });
      else if (player.packed) groups.innerHTML = '<div class="ds-packed">PACKED</div>';
      else if (i !== R.seat) groups.innerHTML = '<div class="ds-back"></div><div class="ds-back"></div><div class="ds-back"></div>';
      seat.classList.toggle('active', i === state.actor && !state.gameOver); seat.classList.toggle('packed', !!player.packed); seat.classList.toggle('me', i === R.seat);
    }
    const room = $('deuce-room-info'); if (room) room.querySelector('.players-count').textContent = `👥 ${count}/${count}`;
    $('deuce-room-round').textContent = state.round || 1; $('deuce-round-no').textContent = state.round || 1; $('deuce-hand-no').textContent = state.currentGroupIndex + 1;
    const clock = $('deuce-time'); if (clock) clock.textContent = Math.ceil((state.turnRemainingMs || 0) / 1000);
    const mine = R.seat == null ? null : players[R.seat];
    renderHand(mine, state);
    const actorName = players[state.actor]?.name || 'PLAYER';
    $('deuce-status').textContent = state.gameOver ? `Match complete — ${players[state.winner]?.name || 'winner'} wins.` : state.actor === R.seat ? 'Your turn — select a group, arrange cards, or pack.' : `${actorName}'s turn…`;
    if (state.gameOver) notice(`Congratulations ${players[state.winner]?.name || 'winner'} — you reached 9 points.`);
  }
  function renderHand(player, state) {
    const hand = $('deuce-human-hand'), controls = $('deuce-human-controls'); if (!hand || !controls) return;
    if (!player || R.seat == null) { hand.innerHTML = '<div class="online-observer-note">You are observing this Deuce tournament.</div>'; controls.innerHTML = ''; return; }
    const groups = player.groups || [];
    hand.innerHTML = `<div class="online-hand-title">YOUR CARDS — choose a group to play</div><div class="online-groups">${groups.map((group, index) => `<div class="online-group"><div class="online-group-title">GROUP ${index + 1}${player.group3Blocked && index === 2 ? ' — FORFEITED' : ''}</div><div class="online-group-cards">${(group || []).map(card => cardHTML(card, R.selected.has(card.id))).join('')}</div><button type="button" class="deuce-play-btn primary online-play-group" data-group-index="${index}" ${state.actor !== R.seat || !group || player.group3Blocked && index === 2 ? 'disabled' : ''}>PLAY GROUP ${index + 1}</button></div>`).join('')}</div>`;
    controls.innerHTML = `<button type="button" class="deuce-play-btn" id="online-group-selected" ${R.selected.size ? '' : 'disabled'}>GROUP SELECTED CARDS</button><button type="button" class="deuce-play-btn danger" id="online-pack" ${state.actor === R.seat && !player.packed ? '' : 'disabled'}>PACK</button>`;
    hand.querySelectorAll('[data-online-card]').forEach(node => node.addEventListener('click', () => { const id = node.dataset.onlineCard; R.selected.has(id) ? R.selected.delete(id) : R.selected.add(id); renderHand(R.state.players[R.seat], R.state); }));
    hand.querySelectorAll('.online-play-group').forEach(node => node.addEventListener('click', () => { R.selected.clear(); send('play', { groupIndex: Number(node.dataset.groupIndex) }); }));
    $('online-group-selected')?.addEventListener('click', () => { if (R.selected.size) { send('group', { cardIds: [...R.selected] }); R.selected.clear(); } });
    $('online-pack')?.addEventListener('click', () => { R.selected.clear(); send('pack'); });
  }
  function onMessage(message) { if (message.t === 'deuceState') renderRemote(message); else if (message.t === 'error') notice(message.error || 'Action rejected.', true); else if (message.t === 'denied') { closeSocket(); notice(message.error || 'You no longer have access to this table.', true); } }

  function populateAdmin(config) {
    if (!config) return;
    R.adminConfig = config;
    $('dct-num-players').value = config.numPlayers || 6;
    for (let i = 1; i <= 6; i++) { const p = config.players?.find(x => x.seat === i); $(`dct-name-${i}`).value = p?.name || `Player${i}`; $(`dct-pw-${i}`).value = p?.password || String(i); $(`dct-type-${i}`).value = p?.type || 'human'; }
    $('dct-observer-pw').value = config.observerPassword || 'abc'; $('dct-start-date').value = config.matchStartDate || ''; $('dct-start-time').value = config.matchStartTime || '';
    updateAdminSeats();
  }
  function updateAdminSeats() { const n = Number($('dct-num-players').value || 6); document.querySelectorAll('#dadmin-create-table-view .dct-seat').forEach(node => node.style.display = Number(node.dataset.seat) <= n ? '' : 'none'); }
  async function loadAdmin() { const result = await api('/api/deuce/admin/table/get', { adminPassword: R.adminPassword }); if (result.ok) { populateAdmin(result.data.config); refreshAdmin(result.data.config); } }
  function refreshAdmin(config) { const online = !!config; $('dct-form-wrap').classList.toggle('dct-locked', online); $('dct-form-wrap').inert = online; $('dct-actions').style.display = online ? 'none' : ''; $('dct-online').style.display = online ? 'block' : 'none'; if (online) { $('dct-online-info').textContent = `${config.numPlayers} seats · ${config.status || 'waiting'}`; $('btn-dct-start-now').style.display = config.status === 'live' ? 'none' : ''; renderAdminKick(config); } }
  function renderAdminKick(config) { const list = $('dct-kick-list'); if (!list) return; list.innerHTML = ''; (config.players || []).forEach(p => { const row = document.createElement('div'); row.className = 'dct-kick-row'; row.innerHTML = `<span class="dct-kick-name">${esc(p.name)}</span><span class="dct-kick-tag">${p.kicked ? 'KICKED' : p.type === 'computer' ? 'COMPUTER' : ''}</span>${!p.kicked && p.type !== 'computer' ? `<button type="button" class="dct-kick-btn" data-kick-seat="${p.seat}">KICK</button>` : ''}`; list.appendChild(row); }); list.querySelectorAll('[data-kick-seat]').forEach(b => b.addEventListener('click', async () => { if (!confirm(`Kick ${b.dataset.kickSeat}?`)) return; const r = await api('/api/deuce/admin/table/kick', { adminPassword: R.adminPassword, seat: Number(b.dataset.kickSeat) }); if (r.ok) { populateAdmin(r.data.config); refreshAdmin(r.data.config); } else notice(r.data.error, true); })); }
  function openAdmin() { $('dadmin-pass-input').value = ''; $('dadmin-pass-error').style.display = 'none'; $('dadmin-pass-overlay').classList.add('show'); setTimeout(() => $('dadmin-pass-input').focus(), 50); }
  async function submitAdmin() { const password = $('dadmin-pass-input').value; const result = await api('/api/admin/login', { password }); if (!result.ok) { $('dadmin-pass-error').textContent = result.data.error || 'Incorrect password'; $('dadmin-pass-error').style.display = 'block'; return; } R.adminPassword = password; $('dadmin-pass-overlay').classList.remove('show'); $('dadmin-panel-overlay').classList.add('show'); showAdminView('menu'); }
  function showAdminView(view) { const menu = view === 'menu'; $('dadmin-menu-view').style.display = menu ? '' : 'none'; $('dadmin-create-table-view').style.display = menu ? 'none' : ''; $('dadmin-panel-title').textContent = menu ? 'ADMIN PANEL' : 'CREATE TABLE'; if (!menu) loadAdmin(); }
  async function confirmTable() { const n = Number($('dct-num-players').value); const players = []; for (let seat = 1; seat <= n; seat++) players.push({ seat, name: $(`dct-name-${seat}`).value.trim() || `Player${seat}`, password: $(`dct-pw-${seat}`).value.trim() || String(seat), type: $(`dct-type-${seat}`).value === 'computer' ? 'computer' : 'human' }); const body = { adminPassword: R.adminPassword, config: { numPlayers: n, players, observerPassword: $('dct-observer-pw').value.trim() || 'abc', matchStartDate: normalizeDate($('dct-start-date').value), matchStartTime: $('dct-start-time').value || '' } }; const result = await api('/api/deuce/admin/table', body); if (!result.ok) return notice(result.data.error || 'Could not create table.', true); populateAdmin(result.data.config); refreshAdmin(result.data.config); notice('Deuce tournament table is online.'); }
  async function updateStart() { const result = await api('/api/deuce/admin/table/start', { adminPassword: R.adminPassword, matchStartDate: normalizeDate($('dct-edit-date').value), matchStartTime: $('dct-edit-time').value || '' }); if (!result.ok) return notice(result.data.error, true); populateAdmin(result.data.config); refreshAdmin(result.data.config); }
  async function startNow() { const result = await api('/api/deuce/admin/table/start-now', { adminPassword: R.adminPassword }); if (!result.ok) return notice(result.data.error, true); populateAdmin(result.data.config); refreshAdmin(result.data.config); }
  async function killTable() { if (!confirm('Kill the Deuce tournament table?')) return; const result = await api('/api/deuce/admin/table/kill', { adminPassword: R.adminPassword }); if (!result.ok) return notice(result.data.error, true); R.adminConfig = null; $('dadmin-panel-overlay').classList.remove('show'); notice('Deuce table killed.'); }

  window.openDeuceJoinTournament = openJoin;
  window.submitJoinPass = submitJoin;
  window.openDeuceAdminPanel = openAdmin;
  window.submitDeuceAdminPass = submitAdmin;
  window.showDeuceAdminView = showAdminView;
  window.dctUpdateSeats = updateAdminSeats;
  window.dctConfirm = confirmTable;
  window.dctUpdateStart = updateStart;
  window.dctStartNow = startNow;
  window.dctKill = killTable;
  window.dctReset = () => { document.querySelectorAll('#dadmin-create-table-view input').forEach(input => input.value = ''); updateAdminSeats(); };
  window.closeDeuceAdminPass = () => $('dadmin-pass-overlay').classList.remove('show');
  window.closeDeuceAdminPanelView = () => $('dadmin-panel-overlay').classList.remove('show');
  $('join-pass-input')?.addEventListener('keydown', event => { if (event.key === 'Enter') submitJoin(); });
  $('dadmin-pass-input')?.addEventListener('keydown', event => { if (event.key === 'Enter') submitAdmin(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && R.password && (!R.socket || R.socket.readyState !== WebSocket.OPEN)) connectSocket(); });
})();
