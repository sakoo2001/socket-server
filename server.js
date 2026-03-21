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

const rooms       = {};
const musicState  = {};
const bottleState = {};
const chatHistory = {};
const turnState   = {};

function getRoom(mid) {
  if (!rooms[mid]) rooms[mid] = {};
  return rooms[mid];
}
function roomPlayers(mid) { return Object.values(getRoom(mid)); }

function masaCounts() {
  const c = {};
  Object.keys(rooms).forEach(mid => {
    const pl = roomPlayers(mid);
    c[mid] = {
      total: pl.length,
      m: pl.filter(p => !['f','female','qiz','qadin','kadin','k'].includes((p.gender||'').toLowerCase())).length,
      f: pl.filter(p =>  ['f','female','qiz','qadin','kadin','k'].includes((p.gender||'').toLowerCase())).length,
    };
  });
  return c;
}
function broadcastCounts() { io.emit('masa_counts', { counts: masaCounts() }); }

/* ══ TURN MANAGEMENT ══ */
function getTurn(mid) {
  if (!turnState[mid]) turnState[mid] = { spinQueue: [], targetQueue: [], current: null, timer: null };
  return turnState[mid];
}

function hasBothGenders(mid) {
  const pl = roomPlayers(mid);
  const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase());
  const isM = g => ['m','male','oglan','erkek','e'].includes((g||'').toLowerCase());
  return pl.some(p => isF(p.gender)) && pl.some(p => isM(p.gender));
}

/* Tüm oyuncuları karıştır — sıra kuyruğu */
function rebuildQueue(mid) {
  const pl = roomPlayers(mid);
  const ids = pl.map(p => String(p.db_id));
  // Fisher-Yates shuffle
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

function nextTurn(mid) {
  const ts = getTurn(mid);
  const pl = roomPlayers(mid);

  if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }

  if (pl.length < 2 || !hasBothGenders(mid)) {
    ts.current = null;
    return;
  }

  // Spin queue boşsa yeniden doldur
  if (!ts.spinQueue.length) {
    ts.spinQueue = rebuildQueue(mid);
  }

  // Odada olmayan oyuncuları temizle
  const inRoom = new Set(pl.map(p => String(p.db_id)));
  ts.spinQueue  = ts.spinQueue.filter(id => inRoom.has(id));

  if (!ts.spinQueue.length) { ts.current = null; return; }

  const spinnerId = ts.spinQueue.shift();
  ts.current = spinnerId;

  // Hedef: şişeyi çeviren HARİÇ tüm oyunculardan sırayla seç
  const otherIds = pl.map(p => String(p.db_id)).filter(id => id !== spinnerId);
  if (!ts.targetQueue.length || !ts.targetQueue.some(id => otherIds.includes(id))) {
    // targetQueue'yu yeniden oluştur (karıştır)
    ts.targetQueue = otherIds.slice().sort(() => Math.random() - 0.5);
  }
  // Odada olmayan hedefleri temizle
  ts.targetQueue = ts.targetQueue.filter(id => otherIds.includes(id));

  const targetId = ts.targetQueue.length ? ts.targetQueue.shift() : otherIds[0];

  // 7 saniye içinde spin gelmezse auto_spin
  ts.timer = setTimeout(() => {
    if (getTurn(mid).current === spinnerId) {
      io.to(mid).emit('auto_spin', { userId: parseInt(spinnerId), masaId: mid });
      setTimeout(() => nextTurn(mid), 3500);
    }
  }, 7000);

  // your_turn + targetId birlikte gönder
  io.to(mid).emit('your_turn', {
    userId:   parseInt(spinnerId),
    targetId: 'pu' + targetId,   // client 'pu'+id formatını bekliyor
    masaId:   mid,
  });
}

function startIfReady(mid) {
  const ts = getTurn(mid);
  if (!ts.current && hasBothGenders(mid) && roomPlayers(mid).length >= 2) {
    setTimeout(() => nextTurn(mid), 600);
  }
}

/* ══ CONNECTION ══ */
io.on('connection', (socket) => {
  let _uid = null;
  let _mid = null;

  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    _uid = String(data.userId);
    _mid = String(data.masaId);
    socket.join(_mid);

    getRoom(_mid)[_uid] = {
      db_id: parseInt(data.userId), name: data.name||'', avatar: data.avatar||null,
      gender: data.gender||'m', is_vip: data.isVip||0, is_premium: 0,
      hearts: data.hearts||0, cercveSrc: data.cercveSrc||'', socketId: socket.id,
    };

    if (bottleState[_mid]) socket.emit('bottle_change', { src: bottleState[_mid] });
    if (musicState[_mid]) {
      const ms = musicState[_mid];
      socket.emit('music_play', { ...ms, elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000) });
    }
    const hist = chatHistory[_mid] || [];
    if (hist.length) socket.emit('chat_history', { messages: hist });

    const pl = roomPlayers(_mid);
    io.to(_mid).emit('players', { data: pl });
    socket.to(_mid).emit('player_join', {
      userId: parseInt(data.userId), name: data.name||'', avatar: data.avatar||null,
      gender: data.gender||'m', isVip: data.isVip||0, cercveSrc: data.cercveSrc||'',
    });
    io.to(_mid).emit('online_sayi', { value: pl.length });
    broadcastCounts();
    startIfReady(_mid);
  });

  socket.on('online', (uid) => { _uid = String(uid); });

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
    const ts  = getTurn(mid);
    // Spinner timer'ı durdur
    if (String(data.by) === ts.current && ts.timer) {
      clearTimeout(ts.timer); ts.timer = null;
    }
    socket.to(mid).emit('spin', data);
  });

  socket.on('kiss',   (data) => { if (data.masaId) socket.to(String(data.masaId)).emit('kiss', data); });

  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    ts.current = null;
    setTimeout(() => nextTurn(mid), 350);
  });

  // Client'tan your_turn gelmez — server yönetir
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
    if (room[String(data.userId)]) room[String(data.userId)].cercveSrc = data.src||'';
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

  socket.on('profile_like',   (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_like',   d); });
  socket.on('profile_unlike', (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_unlike', d); });
  socket.on('bildiris',       (d) => { if (d.masaId) io.to(String(d.masaId)).emit('bildiris', d); });
  socket.on('ping', () => socket.emit('pong'));

  socket.on('disconnect', () => {
    if (!_uid || !_mid) return;
    delete getRoom(_mid)[_uid];

    const ts = getTurn(_mid);
    if (ts.current === _uid) {
      if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
      ts.current = null;
      setTimeout(() => nextTurn(_mid), 400);
    }
    ts.spinQueue  = ts.spinQueue.filter(id => id !== _uid);
    ts.targetQueue= ts.targetQueue.filter(id => id !== _uid);

    const pl = roomPlayers(_mid);
    socket.to(_mid).emit('player_leave', { userId: parseInt(_uid) });
    io.to(_mid).emit('players', { data: pl });
    io.to(_mid).emit('online_sayi', { value: pl.length });

    if (pl.length === 0) {
      delete rooms[_mid];
      delete musicState[_mid];
      delete turnState[_mid];
    }
    broadcastCounts();
  });
});

httpServer.listen(PORT, () => console.log(`Socket.IO server on port ${PORT}`));
