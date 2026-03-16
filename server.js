const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 20000,
  pingInterval: 10000,
});

// socketId -> userData
const users = new Map();
// masaId -> Set<socketId>
const masalar = new Map();

function getMasaRoom(masaId) { return 'masa_' + masaId; }

function masaEkle(masaId, socketId) {
  if (!masalar.has(masaId)) masalar.set(masaId, new Set());
  masalar.get(masaId).add(socketId);
}
function masaCikar(masaId, socketId) {
  if (!masalar.has(masaId)) return;
  masalar.get(masaId).delete(socketId);
  if (masalar.get(masaId).size === 0) masalar.delete(masaId);
}

// Masadakı bütün oyuncuları göndər
function sendPlayerList(masaId) {
  const room = getMasaRoom(masaId);
  const sids = masalar.get(masaId);
  if (!sids) return;
  const list = [];
  sids.forEach(sid => {
    const u = users.get(sid);
    if (u) list.push({
      db_id:  u.userId,
      name:   u.name,
      avatar: u.avatar || null,
      gender: u.gender || '',
      is_vip: u.isVip  || false,
      slot:   0,
      border: u.isVip ? 'border-chain' : '',
      badge:  '',
      isMe:   false,
    });
  });
  io.to(room).emit('players', { type: 'players', data: list });
}

io.on('connection', (socket) => {
  console.log('Bağlandı:', socket.id);

  // ── Odaya qatıl ──
  socket.on('join', (data) => {
    const masaId = String(data.masaId || 1);
    const room   = getMasaRoom(masaId);

    // Əvvəlki otaqdan çıx
    const prev = users.get(socket.id);
    if (prev && prev.masaId) {
      socket.leave(getMasaRoom(prev.masaId));
      masaCikar(prev.masaId, socket.id);
      socket.to(getMasaRoom(prev.masaId)).emit('player_leave', {
        type: 'player_leave', userId: prev.userId, name: prev.name
      });
      sendPlayerList(prev.masaId);
    }

    // Yeni otağa qatıl
    socket.join(room);
    masaEkle(masaId, socket.id);
    users.set(socket.id, {
      userId: String(data.userId),
      name:   data.name   || '',
      avatar: data.avatar || '',
      masaId: masaId,
      isVip:  data.isVip  || false,
      gender: data.gender || '',
      hearts: data.hearts || 0,
    });

    // Hamıya yeni oyuncu siyahısı göndər
    socket.to(room).emit('player_join', {
      type: 'player_join', userId: data.userId, name: data.name, avatar: data.avatar
    });
    sendPlayerList(masaId);

    // Online sayı
    const count = masalar.get(masaId) ? masalar.get(masaId).size : 0;
    io.to(room).emit('online_sayi', count);

    console.log(`[join] ${data.name} -> masa ${masaId} (${count} nəfər)`);
  });

  // ── Chat mesajı ──
  socket.on('chat', (data) => {
    const masaId = String(data.masaId || 1);
    // Göndərənə də daxil olmaqla hamıya göndər (özü artıq göstərib, başqalarına)
    socket.to(getMasaRoom(masaId)).emit('chat', {
      type:   'chat',
      userId: data.userId,
      name:   data.name   || '',
      avatar: data.avatar || '',
      text:   data.text   || '',
      ts:     Date.now(),
    });
  });

  // ── Şişə çevir ──
  socket.on('spin', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('spin', {
      type:     'spin',
      angle:    parseFloat(data.angle)    || 0,
      duration: parseFloat(data.duration) || 3,
      winner:   data.winner  || '',
      pair:     data.pair    || '',
      by:       data.by      || '',
      masaId:   masaId,
    });
    console.log(`[spin] by=${data.by} winner=${data.winner}`);
  });

  // ── Öpüşmə seçimi ──
  socket.on('kiss', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('kiss', data);
  });

  // ── Musiqi başladı ──
  socket.on('music_play', (data) => {
    const masaId = String(data.masaId || 1);
    const payload = {
      type:       'music_play',
      videoId:    data.videoId    || '',
      title:      data.title      || '',
      channel:    data.channel    || '',
      duration:   data.duration   || '',
      playType:   data.playType   || 'music',
      userId:     data.userId     || '',
      startedBy:  data.startedBy  || '',
      avatar:     data.avatar     || '',
      startedAt:  data.startedAt  || Date.now(),
      masaId:     masaId,
    };
    socket.to(getMasaRoom(masaId)).emit('music_play', payload);
    console.log(`[music] ${data.title} by=${data.startedBy}`);
  });

  // ── Musiqi dayandı ──
  socket.on('music_stop', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('music_stop', {
      type: 'music_stop', userId: data.userId
    });
  });

  // ── Hədiyyə ──
  socket.on('gift', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('gift', data);
  });

  // ── Ping ──
  socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));

  // ── Ayrıldı ──
  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (u && u.masaId) {
      masaCikar(u.masaId, socket.id);
      socket.to(getMasaRoom(u.masaId)).emit('player_leave', {
        type: 'player_leave', userId: u.userId, name: u.name
      });
      sendPlayerList(u.masaId);
      const count = masalar.get(u.masaId) ? masalar.get(u.masaId).size : 0;
      io.to(getMasaRoom(u.masaId)).emit('online_sayi', count);
    }
    users.delete(socket.id);
    console.log('Ayrıldı:', socket.id);
  });
});

// ── PHP-dən bildiriş ──
app.post('/bildiris', (req, res) => {
  const { user_id, text } = req.body;
  for (const [sid, u] of users) {
    if (String(u.userId) === String(user_id)) {
      io.to(sid).emit('bildiris', { text });
      break;
    }
  }
  res.json({ ok: true });
});

// ── Sağlamlıq ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', online: users.size, masalar: masalar.size });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server işləyir:', PORT));
