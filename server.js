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

// ── Veri yapıları ──
const rooms       = {};  // mid -> { uid: playerObj }
const musicState  = {};  // mid -> musicData
const bottleState = {};  // mid -> src
const chatHistory = {};  // mid -> [msgs]
const turnState   = {};  // mid -> turnObj

// ── Yardımcı ──
function getRoom(mid) {
  if (!rooms[mid]) rooms[mid] = {};
  return rooms[mid];
}
function roomPlayers(mid) {
  return Object.values(getRoom(mid));
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Masa sayımı (popup için) ──
function masaCounts() {
  const c = {};
  Object.keys(rooms).forEach(mid => {
    const pl = roomPlayers(mid);
    const isF = g => ['f','female','qiz','qadin','kadin','k'].includes((g||'').toLowerCase().trim());
    c[mid] = {
      total: pl.length,
      f: pl.filter(p => isF(p.gender)).length,
      m: pl.filter(p => !isF(p.gender)).length,
    };
  });
  return c;
}
function broadcastCounts() {
  io.emit('masa_counts', { counts: masaCounts() });
}

// ── Sıra yönetimi ──
function getTurn(mid) {
  if (!turnState[mid]) {
    turnState[mid] = {
      spinQueue:   [],   // kimin sırası gelecek
      targetQueue: [],   // kime döneceği
      current:     null, // şu an sırası olan uid
      timer:       null, // auto-spin timer
      pending:     null, // next_turn debounce timer
    };
  }
  return turnState[mid];
}

function nextTurn(mid) {
  const ts = getTurn(mid);
  const pl = roomPlayers(mid);

  // Timer temizle
  if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }

  // En az 2 kişi lazım
  if (pl.length < 2) {
    ts.current = null;
    return;
  }

  const ids = pl.map(p => String(p.db_id));
  const inRoom = new Set(ids);

  // Spin queue: odada olmayan uid'leri çıkar, boşsa yeniden doldur (shuffle)
  ts.spinQueue = ts.spinQueue.filter(id => inRoom.has(id));
  if (ts.spinQueue.length === 0) ts.spinQueue = shuffle(ids);

  const spinnerId = ts.spinQueue.shift();
  ts.current = spinnerId;

  // Target queue: spinner hariç diğerleri
  const others = ids.filter(id => id !== spinnerId);
  ts.targetQueue = ts.targetQueue.filter(id => others.includes(id));
  if (ts.targetQueue.length === 0) ts.targetQueue = shuffle(others);
  const targetId = ts.targetQueue.shift();

  // your_turn gönder
  io.to(mid).emit('your_turn', {
    userId:   parseInt(spinnerId),
    targetId: 'pu' + targetId,
    masaId:   mid,
  });

  // 10 sn içinde spin gelmezse otomatik çevir
  ts.timer = setTimeout(() => {
    if (getTurn(mid).current !== spinnerId) return;
    io.to(mid).emit('auto_spin', { userId: parseInt(spinnerId), masaId: mid });
    // auto_spin'den sonra 5 sn bekle, sonra sırayı geç
    setTimeout(() => {
      if (getTurn(mid).current === spinnerId) {
        getTurn(mid).current = null;
        nextTurn(mid);
      }
    }, 5000);
  }, 10000);
}

function startIfReady(mid) {
  const ts = getTurn(mid);
  if (!ts.current && roomPlayers(mid).length >= 2) {
    setTimeout(() => nextTurn(mid), 800);
  }
}

// ── Socket bağlantıları ──
io.on('connection', (socket) => {
  let _uid = null;
  let _mid = null;

  // Odaya katıl
  socket.on('join', (data) => {
    if (!data.userId || !data.masaId) return;
    _uid = String(data.userId);
    _mid = String(data.masaId);
    socket.join(_mid);

    // Oyuncu kaydı
    getRoom(_mid)[_uid] = {
      db_id:     parseInt(data.userId),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      is_vip:    data.isVip     || 0,
      hearts:    data.hearts    || 0,
      cercveSrc: data.cercveSrc || '',
      socketId:  socket.id,
    };

    // Şişe durumunu gönder
    if (bottleState[_mid]) {
      socket.emit('bottle_change', { src: bottleState[_mid] });
    }

    // Müzik durumunu gönder
    if (musicState[_mid]) {
      const ms = musicState[_mid];
      socket.emit('music_play', {
        ...ms,
        elapsedOnJoin: Math.floor((Date.now() - ms.startedAt) / 1000),
      });
    }

    // Chat geçmişini gönder
    const hist = chatHistory[_mid] || [];
    if (hist.length) socket.emit('chat_history', { messages: hist });

    // Odadaki oyuncu listesini herkese gönder
    const pl = roomPlayers(_mid);
    io.to(_mid).emit('players', { data: pl });

    // Diğerlerine player_join bildirimi
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

  // Chat
  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    socket.to(mid).emit('chat', data);
    if (!chatHistory[mid]) chatHistory[mid] = [];
    chatHistory[mid].push(data);
    if (chatHistory[mid].length > 60) chatHistory[mid].shift();
  });

  // Şişe çevrildi — diğerlerine ilet, timer'ı durdur
  socket.on('spin', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);
    if (ts.timer) { clearTimeout(ts.timer); ts.timer = null; }
    socket.to(mid).emit('spin', data);
  });

  // Öpücük seçimi
  socket.on('kiss', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss', data);
  });

  // Kiss popup kapandı — sıradaki tura geç
  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    const ts  = getTurn(mid);

    if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }

    // Aynı anda birden fazla next_turn_ready gelirse sadece bir kez işle
    if (ts.pending) return;
    ts.pending = setTimeout(() => {
      ts.pending = null;
      ts.current = null;
      nextTurn(mid);
    }, 600);
  });

  // Hediye
  socket.on('gift', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('gift', data);
  });

  // Şişe değişimi
  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const mid = String(data.masaId);
    if (data.src) bottleState[mid] = data.src;
    socket.to(mid).emit('bottle_change', data);
  });

  // Çerçeve değişimi
  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const mid  = String(data.masaId);
    const room = getRoom(mid);
    const uid  = String(data.userId);
    if (room[uid]) room[uid].cercveSrc = data.src || '';
    socket.to(mid).emit('cercve_change', data);
  });

  // Müzik
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

  // Profil
  socket.on('profile_like',   (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_like',   d); });
  socket.on('profile_unlike', (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('profile_unlike', d); });
  socket.on('bildiris',       (d) => { if (d.masaId) io.to(String(d.masaId)).emit('bildiris', d); });
  socket.on('ping', () => socket.emit('pong'));
  socket.on('your_turn', () => {}); // server yönetir, client'dan geleni yoksay
  socket.on('auto_spin',  (d) => { if (d.masaId) socket.to(String(d.masaId)).emit('auto_spin', d); });

  // Bağlantı kesildi
  socket.on('disconnect', () => {
    if (!_uid || !_mid) return;
    delete getRoom(_mid)[_uid];

    const ts = getTurn(_mid);

    // Sırası olan kişi çıktıysa sırayı geç
    if (ts.current === _uid) {
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current = null;
      setTimeout(() => nextTurn(_mid), 500);
    }

    // Kuyruklardan temizle
    ts.spinQueue   = ts.spinQueue.filter(id => id !== _uid);
    ts.targetQueue = ts.targetQueue.filter(id => id !== _uid);

    const pl = roomPlayers(_mid);
    socket.to(_mid).emit('player_leave', { userId: parseInt(_uid) });
    io.to(_mid).emit('players', { data: pl });
    io.to(_mid).emit('online_sayi', { value: pl.length });

    if (pl.length === 0) {
      // Oda boşaldı — temizle
      delete rooms[_mid];
      delete musicState[_mid];
      delete turnState[_mid];
      delete bottleState[_mid];
    } else if (pl.length === 1) {
      // Tek kişi kaldı — sırayı dondur
      if (ts.timer)   { clearTimeout(ts.timer);   ts.timer   = null; }
      if (ts.pending) { clearTimeout(ts.pending); ts.pending = null; }
      ts.current     = null;
      ts.spinQueue   = [];
      ts.targetQueue = [];
    }

    broadcastCounts();
  });
});

httpServer.listen(PORT, () => console.log(`Socket.IO listening on port ${PORT}`));
