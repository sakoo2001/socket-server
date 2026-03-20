const { createServer } = require('http');
const { Server }       = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Socket.IO server running\n');
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

/* ══════════════════════════════════════════
   State
   ══════════════════════════════════════════ */

// masaId → { userId → playerInfo }
const rooms = {};

// masaId → { videoId, title, channel, duration, playType, userId, startedBy, avatar, startedAt }
const musicState = {};

// masaId → bottleSrc
const bottleState = {};

// userId → cercveSrc
const cercveState = {};

/* ── helper ── */
function getRoom(masaId) {
  if (!rooms[masaId]) rooms[masaId] = {};
  return rooms[masaId];
}

function roomPlayerList(masaId) {
  return Object.values(getRoom(masaId));
}

function masaCounts() {
  const counts = {};
  Object.keys(rooms).forEach(mid => {
    const players = roomPlayerList(mid);
    counts[mid] = {
      total: players.length,
      m: players.filter(p => p.gender !== 'f').length,
      f: players.filter(p => p.gender === 'f').length,
    };
  });
  return counts;
}

function broadcastMasaCounts() {
  io.emit('masa_counts', { counts: masaCounts() });
}

/* ══════════════════════════════════════════
   Connection
   ══════════════════════════════════════════ */

io.on('connection', (socket) => {

  let _userId  = null;
  let _masaId  = null;

  /* ── join ── */
  socket.on('join', (data) => {
    _userId  = String(data.userId);
    _masaId  = String(data.masaId);

    socket.join(_masaId);

    const room = getRoom(_masaId);
    room[_userId] = {
      db_id:     parseInt(data.userId),
      name:      data.name      || '',
      avatar:    data.avatar    || null,
      gender:    data.gender    || 'm',
      is_vip:    data.isVip     || 0,
      is_premium:0,
      hearts:    data.hearts    || 0,
      cercveSrc: data.cercveSrc || '',
      socketId:  socket.id,
    };

    // Çerçeveyi kaydet
    if (data.cercveSrc && data.cercveSrc !== 'none') {
      cercveState[_userId] = data.cercveSrc;
    }

    // Şüşəni gönder (varsa)
    if (bottleState[_masaId]) {
      socket.emit('bottle_change', { src: bottleState[_masaId], userId: null });
    }

    // Müziği gönder (varsa)
    if (musicState[_masaId]) {
      const ms = musicState[_masaId];
      const elapsed = Math.floor((Date.now() - ms.startedAt) / 1000);
      socket.emit('music_play', { ...ms, elapsedOnJoin: elapsed });
    }

    // Odadaki oyuncu listesini tüm odaya gönder
    const playerList = roomPlayerList(_masaId);
    io.to(_masaId).emit('players', { data: playerList });

    // Yeni katılanı diğerlerine bildir
    socket.to(_masaId).emit('player_join', {
      userId:    parseInt(data.userId),
      name:      data.name   || '',
      avatar:    data.avatar || null,
      gender:    data.gender || 'm',
      isVip:     data.isVip  || 0,
      cercveSrc: data.cercveSrc || '',
    });

    // Online sayısı
    io.to(_masaId).emit('online_sayi', { value: playerList.length });

    broadcastMasaCounts();
  });

  /* ── online (sadece userId bildirimi, join öncesi) ── */
  socket.on('online', (userId) => {
    _userId = String(userId);
  });

  /* ── chat ── */
  socket.on('chat', (data) => {
    if (!data.masaId) return;
    const masaId = String(data.masaId);
    // Göndericiye geri gönderme — sadece diğerlerine
    socket.to(masaId).emit('chat', data);
    // Chat history için sakla (son 50)
    if (!rooms['_chatHistory_' + masaId]) rooms['_chatHistory_' + masaId] = [];
    rooms['_chatHistory_' + masaId].push(data);
    if (rooms['_chatHistory_' + masaId].length > 50) {
      rooms['_chatHistory_' + masaId].shift();
    }
  });

  /* ── chat_history isteği (join sırasında otomatik gönderiliyor ama manuel de istenebilir) ── */
  socket.on('get_chat_history', (data) => {
    const masaId = String(data.masaId || _masaId);
    const history = rooms['_chatHistory_' + masaId] || [];
    socket.emit('chat_history', { messages: history });
  });

  /* ── spin ── */
  socket.on('spin', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('spin', data);
  });

  /* ── kiss ── */
  socket.on('kiss', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('kiss', data);
  });

  /* ── your_turn ── */
  socket.on('your_turn', (data) => {
    if (!data.masaId) return;
    io.to(String(data.masaId)).emit('your_turn', data);
  });

  /* ── auto_spin ── */
  socket.on('auto_spin', (data) => {
    if (!data.masaId) return;
    io.to(String(data.masaId)).emit('auto_spin', data);
  });

  /* ── next_turn_ready ── */
  socket.on('next_turn_ready', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('next_turn_ready', data);
  });

  /* ── gift ── */
  socket.on('gift', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('gift', data);
  });

  /* ── bottle_change ── */
  socket.on('bottle_change', (data) => {
    if (!data.masaId) return;
    const masaId = String(data.masaId);
    if (data.src) bottleState[masaId] = data.src;
    socket.to(masaId).emit('bottle_change', data);
  });

  /* ── cercve_change ── */
  socket.on('cercve_change', (data) => {
    if (!data.masaId) return;
    const masaId = String(data.masaId);
    const userId = String(data.userId);

    // State'i güncelle
    if (data.src && data.src !== 'none') {
      cercveState[userId] = data.src;
    } else {
      delete cercveState[userId];
    }

    // Room'daki player kaydını güncelle
    const room = getRoom(masaId);
    if (room[userId]) room[userId].cercveSrc = data.src || '';

    // Diğerlerine yayınla
    socket.to(masaId).emit('cercve_change', data);
  });

  /* ── music_play ── */
  socket.on('music_play', (data) => {
    if (!data.masaId) return;
    const masaId = String(data.masaId);
    musicState[masaId] = {
      videoId:   data.videoId,
      title:     data.title    || '',
      channel:   data.channel  || '',
      duration:  data.duration || '',
      playType:  data.playType || 'music',
      userId:    data.userId,
      startedBy: data.startedBy || '',
      avatar:    data.avatar   || '',
      startedAt: data.startedAt || Date.now(),
    };
    socket.to(masaId).emit('music_play', data);
  });

  /* ── music_stop ── */
  socket.on('music_stop', (data) => {
    if (!data.masaId) return;
    const masaId = String(data.masaId);
    delete musicState[masaId];
    socket.to(masaId).emit('music_stop', data);
  });

  /* ── profile_like ── */
  socket.on('profile_like', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('profile_like', data);
  });

  /* ── profile_unlike ── */
  socket.on('profile_unlike', (data) => {
    if (!data.masaId) return;
    socket.to(String(data.masaId)).emit('profile_unlike', data);
  });

  /* ── bildiris ── */
  socket.on('bildiris', (data) => {
    if (!data.masaId) return;
    io.to(String(data.masaId)).emit('bildiris', data);
  });

  /* ── ping ── */
  socket.on('ping', () => {
    socket.emit('pong');
  });

  /* ── disconnect ── */
  socket.on('disconnect', () => {
    if (!_userId || !_masaId) return;

    const room = getRoom(_masaId);
    delete room[_userId];

    // Odaya bildir
    socket.to(_masaId).emit('player_leave', { userId: parseInt(_userId) });

    // Oyuncu listesini güncelle
    const playerList = roomPlayerList(_masaId);
    io.to(_masaId).emit('players', { data: playerList });
    io.to(_masaId).emit('online_sayi', { value: playerList.length });

    // Boş oda temizliği
    if (playerList.length === 0) {
      delete rooms[_masaId];
      delete musicState[_masaId];
      // Şüşə state kalabilir (persistence)
    }

    broadcastMasaCounts();
  });

});

/* ── chat history: join sırasında otomatik gönder ── */
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const masaId = String(data.masaId);
    const history = rooms['_chatHistory_' + masaId] || [];
    if (history.length > 0) {
      socket.emit('chat_history', { messages: history });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Socket.IO server listening on port ${PORT}`);
});
