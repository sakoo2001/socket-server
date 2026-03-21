const { createServer } = require('http');
const { Server }       = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 10000,
});

const rooms      = {};
const musicState = {};
const bottleState= {};
const chatHistory= {};
const turnState  = {};

function getRoom(masaId) {
  if (!rooms[masaId]) rooms[masaId] = {};
  return rooms[masaId];
}
function roomPlayers(masaId) { return Object.values(getRoom(masaId)); }
function masaCounts() {
  const c = {};
  Object.keys(rooms).forEach(mid => {
    const pl = roomPlayers(mid);
    c[mid] = { total: pl.length, m: pl.filter(p => p.gender !== 'f').length, f: pl.filter(p => p.gender === 'f').length };
  });
  return c;
}
function broadcastCounts() { io.emit('masa_counts', { counts: masaCounts() }); }

function getTurn(masaId) {
  if (!turnState[masaId]) turnState[masaId] = { queue: [], current: null, timer: null };
  return turnState[masaId];
}
function hasBothGenders(masaId) {
  const pl = roomPlayers(masaId);
  const hasF = pl.some(p => ['f','female','qiz','qadin','kadin','k'].includes((p.gender||'').toLowerCase()));
  const hasM = pl.some(p => ['m','male','oglan','erkek','e'].includes((p.gender||'').toLowerCase()));
  return hasF && hasM;
}
function nextTurn(masaId) {
  const ts = getTurn(masaId);
  const pl = roomPlayers(masaId);
  if (pl.length < 2 || !hasBothGenders(masaId)) { ts.current = null; return; }
  if (!ts.queue.length) {
    ts.queue = pl.map(p => String(p.db_id)).sort(() => Math.random() - 0.5);
  }
  const inRoom = new Set(pl.map(p => String(p.db_id)));
  ts.queue = ts.queue.filter(id => inRoom.has(id));
  if (!ts.queue.length) { ts.current = null; return; }
  const nextUserId = ts.queue.shift();
  ts.current = nextUserId;
  if (ts.timer) clearTimeout(ts.timer);
  ts.timer = setTimeout(() => {
    if (getTurn(masaId).current === nextUserId) {
      io.to(masaId).emit('auto_spin', { userId: nextUserId, masaId });
      setTimeout(() => nextTurn(masaId), 3000);
    }
  }, 7000);
  io.to(masaId).emit('your_turn', { userId: nextUserId, masaId });
}
function startTurnIfNeeded(masaId) {
  const ts = getTurn(masaId);
  if (!ts.current && hasBothGenders(masaId) && roomPlayers(masaId).length >= 2) {
    setTimeout(() => nextTurn(masaId), 800);
  }
}

io.on('connection', (socket) => {
  let _userId = null;
  let _masaId = null;

  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    _userId = String(data.userId);
    _masaId = String(data.masaId);
    socket.join(_masaId);
    const room = getRoom(_masaId);
    room[_userId] = {
      db_id: parseInt(data.userId), name: data.name||'', avatar: data.avatar||null,
      gender: data.gender||'m', is_vip: data.isVip||0, is_premium: 0,
      hearts: data.hearts||0, cercveSrc: data.cercveSrc||'', socketId: socket.id,
    };
    if (bottleState[_masaId]) socket.emit('bottle_change', { src: bottleState[_masaId] });
    if (musicState[_masaId]) {
      const ms = musicState[_masaId];
      socket.emit('music_play', { ...ms, elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000) });
    }
    const hist = chatHistory[_masaId] || [];
    if (hist.length) socket.emit('chat_history', { messages: hist });
    const pl = roomPlayers(_masaId);
    io.to(_masaId).emit('players', { data: pl });
    socket.to(_masaId).emit('player_join', {
      userId: parseInt(data.userId), name: data.name||'', avatar: data.avatar||null,
      gender: data.gender||'m', isVip: data.isVip||0, cercveSrc: data.cercveSrc||'',
    });
    io.to(_masaId).emit('online_sayi', { value: pl.length });
    broadcastCounts();
    startTurnIfNeeded(_masaId);
  });

  socket.on('online', (userId) => { _userId = String(userId); });

  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    socket.to(mid).emit('chat', data);
    if (!chatHistory[mid]) chatHistory[mid] = [];
    chatHistory[mid].push(data);
    if (chatHistory[mid].length > 60) chatHistory[mid].shift();
  });

  socket.on('spin', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts = getTurn(mid);
    if (ts.current === String(data.by) && ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    socket.to(mid).emit('spin', data);
  });

  socket.on('kiss',   (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('kiss', data); });

  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts = getTurn(mid);
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    ts.current = null;
    setTimeout(() => nextTurn(mid), 400);
  });

  socket.on('your_turn', () => {});
  socket.on('auto_spin', (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('auto_spin', data); });
  socket.on('gift',      (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('gift', data); });

  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    if (data.src) bottleState[mid] = data.src;
    socket.to(mid).emit('bottle_change', data);
  });

  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const room = getRoom(String(data.masaId));
    const uid = String(data.userId);
    if (room[uid]) room[uid].cercveSrc = data.src||'';
    socket.to(String(data.masaId)).emit('cercve_change', data);
  });

  socket.on('music_play', (data) => {
    if (!data.masaId) return;
    musicState[String(data.masaId)] = { ...data, startedAt: data.startedAt||Date.now() };
    socket.to(String(data.masaId)).emit('music_play', data);
  });

  socket.on('music_stop', (data) => {
    if (!data.masaId) return;
    delete musicState[String(data.masaId)];
    socket.to(String(data.masaId)).emit('music_stop', data);
  });

  socket.on('profile_like',   (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('profile_like',   data); });
  socket.on('profile_unlike', (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('profile_unlike', data); });
  socket.on('bildiris',       (data) => { if (data.masaId) io.to(String(data.masaId)).emit('bildiris', data); });
  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', () => {
    if (!_userId || !_masaId) return;
    const room = getRoom(_masaId);
    delete room[_userId];
    const ts = getTurn(_masaId);
    if (ts.current === _userId) {
      if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
      ts.current = null;
      setTimeout(() => nextTurn(_masaId), 500);
    }
    ts.queue = ts.queue.filter(id => id !== _userId);
    const pl = roomPlayers(_masaId);
    socket.to(_masaId).emit('player_leave', { userId: parseInt(_userId) });
    io.to(_masaId).emit('players', { data: pl });
    io.to(_masaId).emit('online_sayi', { value: pl.length });
    if (pl.length === 0) { delete rooms[_masaId]; delete musicState[_masaId]; delete turnState[_masaId]; }
    broadcastCounts();
  });
});

httpServer.listen(PORT, () => console.log(`Socket.IO server on port ${PORT}`));
