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
    const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase());
    c[mid] = { total: pl.length, m: pl.filter(p=>!isF(p.gender)).length, f: pl.filter(p=>isF(p.gender)).length };
  });
  return c;
}
function broadcastCounts() { io.emit('masa_counts', { counts: masaCounts() }); }

/* ══ TURN MANAGEMENT ══ */
function getTurn(mid) {
  if (!turnState[mid]) turnState[mid] = {
    spinQueue: [], targetQueue: [], current: null,
    timer: null, nextPendingTimer: null
  };
  return turnState[mid];
}

function hasBothGenders(mid) {
  // Cinsiyyət fərqi artıq tələb deyil — ən az 2 oyuncu varsa oyun başlayır
  return roomPlayers(mid).length >= 2;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function nextTurn(mid) {
  const ts = getTurn(mid);
  const pl = roomPlayers(mid);

  if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }

  if (pl.length < 2) {
    ts.current = null;
    return;
  }

  const inRoom = new Set(pl.map(p => String(p.db_id)));

  // Spin kuyruğunu temizle / doldur
  ts.spinQueue = ts.spinQueue.filter(id => inRoom.has(id));
  if (!ts.spinQueue.length) ts.spinQueue = shuffle(pl.map(p => String(p.db_id)));

  const spinnerId = ts.spinQueue.shift();
  ts.current = spinnerId;

  // Hedef kuyruğu (spinner hariç)
  const others = pl.map(p => String(p.db_id)).filter(id => id !== spinnerId);
  ts.targetQueue = ts.targetQueue.filter(id => others.includes(id));
  if (!ts.targetQueue.length) ts.targetQueue = shuffle(others);

  const targetId = ts.targetQueue.shift();

  // 8 sn içinde spin gelmezse auto_spin
  ts.timer = setTimeout(() => {
    if (getTurn(mid).current === spinnerId) {
      io.to(mid).emit('auto_spin', { userId: parseInt(spinnerId), masaId: mid });
      setTimeout(() => nextTurn(mid), 4000);
    }
  }, 8000);

  io.to(mid).emit('your_turn', {
    userId:   parseInt(spinnerId),
    targetId: 'pu' + targetId,
    masaId:   mid,
  });
}

function startIfReady(mid) {
  const ts = getTurn(mid);
  if (!ts.current && roomPlayers(mid).length >= 2) {
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
      db_id:      parseInt(data.userId),
      name:       data.name       || '',
      avatar:     data.avatar     || null,
      gender:     data.gender     || 'm',
      is_vip:     data.isVip      || 0,
      is_premium: 0,
      hearts:     data.hearts     || 0,
      cercveSrc:  data.cercveSrc  || '',
      socketId:   socket.id,
    };

    if (bottleState[_mid]) socket.emit('bottle_change', { src: bottleState[_mid] });

    if (musicState[_mid]) {
      const ms = musicState[_mid];
      socket.emit('music_play', {
        ...ms,
        elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000),
      });
    }

    const hist = chatHistory[_mid] || [];
    if (hist.length) socket.emit('chat_history', { messages: hist });

    const pl = roomPlayers(_mid);
    io.to(_mid).emit('players', { data: pl });
    socket.to(_mid).emit('player_join', {
      userId:    parseInt(data.userId),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      isVip:     data.isVip     || 0,
      cercveSrc: data.cercveSrc || '',
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
    // Spinner kim olursa olsun timer'ı durdur
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    socket.to(mid).emit('spin', data);
  });

  socket.on('kiss', (data) => {
    if (data.masaId) socket.to(String(data.masaId)).emit('kiss', data);
  });

  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);

    // Çoxlu next_turn_ready gəlsə — yalnız birincisini işlə, qalanlarını udu
    if (ts.nextPendingTimer) return;
    ts.nextPendingTimer = setTimeout(() => {
      ts.nextPendingTimer = null;
      ts.current = null;
      nextTurn(mid);
    }, 500);

    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
  });

  socket.on('your_turn',  ()  => {}); // server yönetir
  socket.on('auto_spin',  (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('auto_spin', d); });
  socket.on('gift',       (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('gift', d); });

  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    if (data.src) bottleState[mid] = data.src;
    socket.to(mid).emit('bottle_change', data);
  });

  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const room = getRoom(String(data.masaId));
    const uid  = String(data.userId);
    if (room[uid]) room[uid].cercveSrc = data.src || '';
    socket.to(String(data.masaId)).emit('cercve_change', data);
  });

  socket.on('music_play', (data) => {
    if (!data.masaId) return;
    musicState[String(data.masaId)] = { ...data, startedAt: data.startedAt || Date.now() };
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
    ts.spinQueue   = ts.spinQueue.filter(id => id !== _uid);
    ts.targetQueue = ts.targetQueue.filter(id => id !== _uid);

    const pl = roomPlayers(_mid);
    socket.to(_mid).emit('player_leave', { userId: parseInt(_uid) });
    io.to(_mid).emit('players', { data: pl });
    io.to(_mid).emit('online_sayi', { value: pl.length });

    if (pl.length === 0) {
      delete rooms[_mid];
      delete musicState[_mid];
      delete turnState[_mid];
    } else if (pl.length < 2) {
      // 1 oyuncu qaldı — sıranı dayandır ama room-u silmə
      const ts2 = getTurn(_mid);
      if (ts2.timer) { clearTimeout(ts2.timer); ts2.timer = null; }
      if (ts2.nextPendingTimer) { clearTimeout(ts2.nextPendingTimer); ts2.nextPendingTimer = null; }
      ts2.current = null;
      ts2.spinQueue = [];
      ts2.targetQueue = [];
    }
    broadcastCounts();
  });
});

httpServer.listen(PORT, () => console.log(`Socket.IO server on port ${PORT}`));
