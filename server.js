const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Online istifadəçiləri saxla: socketId -> userData
const onlineUsers = new Map();   // socketId -> { user_id, name, masaId, ... }
const masaUsers   = new Map();   // masaId   -> Set<socketId>

function getMasaRoom(masaId) { return 'masa_' + masaId; }

function addToMasa(masaId, socketId) {
  if (!masaUsers.has(masaId)) masaUsers.set(masaId, new Set());
  masaUsers.get(masaId).add(socketId);
}
function removeFromMasa(masaId, socketId) {
  if (masaUsers.has(masaId)) {
    masaUsers.get(masaId).delete(socketId);
    if (masaUsers.get(masaId).size === 0) masaUsers.delete(masaId);
  }
}

io.on('connection', (socket) => {
  console.log('Bağlandı:', socket.id);

  // ── Online (sadece user_id ile) ──
  socket.on('online', (user_id) => {
    const uid = String(user_id);
    const prev = onlineUsers.get(socket.id);
    onlineUsers.set(socket.id, { ...(prev||{}), user_id: uid });
    io.emit('online_sayi', onlineUsers.size);
  });

  // ── Odaya qatıl (join) ──
  socket.on('join', (data) => {
    const masaId = String(data.masaId || 1);
    const room   = getMasaRoom(masaId);

    // Əvvəlki otaqdan çıx
    const prev = onlineUsers.get(socket.id);
    if (prev && prev.masaId) {
      socket.leave(getMasaRoom(prev.masaId));
      removeFromMasa(prev.masaId, socket.id);
      socket.to(getMasaRoom(prev.masaId)).emit('player_leave', {
        userId: prev.user_id, name: prev.name
      });
    }

    // Yeni otağa qatıl
    socket.join(room);
    addToMasa(masaId, socket.id);
    onlineUsers.set(socket.id, {
      user_id: String(data.userId),
      name:    data.name    || '',
      avatar:  data.avatar  || '',
      masaId:  masaId,
      isVip:   data.isVip   || false,
      gender:  data.gender  || '',
      hearts:  data.hearts  || 0,
    });

    // Herkese bildir
    socket.to(room).emit('player_join', {
      userId: data.userId, name: data.name, avatar: data.avatar
    });

    // Online sayı (masa + global)
    io.to(room).emit('online_sayi', masaUsers.get(masaId) ? masaUsers.get(masaId).size : 0);
    console.log(`[join] ${data.name} -> masa ${masaId}`);
  });

  // ── Şişe çevir (spin) ──
  socket.on('spin', (data) => {
    const masaId = String(data.masaId || 1);
    const room   = getMasaRoom(masaId);

    // Spin edəni saxla
    const user = onlineUsers.get(socket.id) || {};
    const spinData = {
      type:     'spin',
      angle:    parseFloat(data.angle)    || 0,
      duration: parseFloat(data.duration) || 3,
      winner:   data.winner  || '',
      pair:     data.pair    || '',
      by:       data.by      || user.user_id || '',
      masaId:   masaId,
      ts:       Date.now(),
    };

    // Eyni otaqdakı başqalarına göndər (özünə yox)
    socket.to(room).emit('spin', spinData);
    console.log(`[spin] by=${spinData.by} winner=${spinData.winner} masa=${masaId}`);
  });

  // ── Öpüşmə seçimi (kiss) ──
  socket.on('kiss', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('kiss', data);
  });

  // ── Chat mesajı ──
  socket.on('chat', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('chat', data);
  });

  // ── Musiqi başladı ──
  socket.on('music_play', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('music_play', data);
    console.log(`[music] ${data.title} by=${data.startedBy} masa=${masaId}`);
  });

  // ── Musiqi dayandı ──
  socket.on('music_stop', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('music_stop', data);
  });

  // ── Hədiyyə ──
  socket.on('gift', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('gift', data);
  });

  // ── Ping ──
  socket.on('ping', () => {
    socket.emit('pong', { ts: Date.now() });
  });

  // ── Ayrıldı ──
  socket.on('disconnect', () => {
    const user = onlineUsers.get(socket.id);
    if (user) {
      const masaId = user.masaId;
      if (masaId) {
        removeFromMasa(masaId, socket.id);
        socket.to(getMasaRoom(masaId)).emit('player_leave', {
          userId: user.user_id, name: user.name
        });
        const count = masaUsers.get(masaId) ? masaUsers.get(masaId).size : 0;
        io.to(getMasaRoom(masaId)).emit('online_sayi', count);
      }
      onlineUsers.delete(socket.id);
    }
    console.log('Ayrıldı:', socket.id);
  });
});

// ── PHP-dən bildiriş göndər ──
app.post('/bildiris', (req, res) => {
  const { user_id, text } = req.body;
  // user_id-yə aid socket tap
  for (const [sid, u] of onlineUsers) {
    if (String(u.user_id) === String(user_id)) {
      io.to(sid).emit('bildiris', { text });
      break;
    }
  }
  res.json({ ok: true });
});

// ── Sağlamlıq yoxlaması ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    online: onlineUsers.size,
    masalar: masaUsers.size,
    ts: Date.now()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server işləyir:', PORT));
