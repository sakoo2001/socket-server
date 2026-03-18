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
// masaId -> active music data (null if no music)
const activeMuzik = new Map();
// masaId -> spin turn queue { queue: [userId,...], currentIdx, timer }
const spinTurns = new Map();

function getSpinState(masaId) {
  if (!spinTurns.has(masaId)) spinTurns.set(masaId, { queue: [], currentIdx: 0 });
  return spinTurns.get(masaId);
}
function nextSpinTurn(masaId) {
  const st = getSpinState(masaId);
  const room = getMasaRoom(masaId);
  if (!st.queue.length) return;
  st.currentIdx = (st.currentIdx + 1) % st.queue.length;
  const nextUserId = st.queue[st.currentIdx];
  io.to(room).emit('your_turn', { type: 'your_turn', userId: nextUserId, masaId });
  console.log('[turn] next userId='+nextUserId+' masa='+masaId);
  clearTimeout(st.autoTimer);
  st.autoTimer = setTimeout(() => {
    const cur = spinTurns.get(masaId);
    if (!cur || cur.queue[cur.currentIdx] != nextUserId) return;
    io.to(room).emit('auto_spin', { type: 'auto_spin', userId: nextUserId, masaId });
    console.log('[auto_spin] userId='+nextUserId);
  }, 5000);
}

const chatHistory = new Map();
function getChatHistory(masaId) {
  if (!chatHistory.has(masaId)) chatHistory.set(masaId, []);
  return chatHistory.get(masaId);
}
function addChatHistory(masaId, msg) {
  const hist = getChatHistory(masaId);
  hist.push(msg);
  if (hist.length > 50) hist.shift();
}

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

function findSocketsByUserId(userId) {
  const result = [];
  for (const [sid, u] of users) {
    if (String(u.userId) === String(userId)) result.push(sid);
  }
  return result;
}

function emitBalanceUpdate(userId, hearts, dg) {
  const sids = findSocketsByUserId(userId);
  sids.forEach(sid => {
    io.to(sid).emit('balance_update', {
      type:   'balance_update',
      userId: String(userId),
      hearts: hearts,
      dg:     dg,
    });
  });
}

io.on('connection', (socket) => {
  console.log('Bağlandı:', socket.id);

  socket.on('join', (data) => {
    const masaId = String(data.masaId || 1);
    const room   = getMasaRoom(masaId);

    const prev = users.get(socket.id);
    if (prev && prev.masaId) {
      socket.leave(getMasaRoom(prev.masaId));
      masaCikar(prev.masaId, socket.id);
      socket.to(getMasaRoom(prev.masaId)).emit('player_leave', {
        type: 'player_leave', userId: prev.userId, name: prev.name
      });
      sendPlayerList(prev.masaId);
    }

    socket.join(room);
    masaEkle(masaId, socket.id);
    users.set(socket.id, {
      userId: String(data.userId),
      name:   data.name   || '',
      avatar: data.avatar || '',
      masaId: masaId,
      isVip:  data.isVip  || false,
      gender: data.gender || '',
      hearts: parseInt(data.hearts) || 0,
      dg:     parseInt(data.dg)     || 0,
    });

    socket.to(room).emit('player_join', {
      type: 'player_join', userId: data.userId, name: data.name, avatar: data.avatar
    });
    sendPlayerList(masaId);

    const count = masalar.get(masaId) ? masalar.get(masaId).size : 0;
    io.to(room).emit('online_sayi', count);

    const st = getSpinState(masaId);
    if (!st.queue.includes(String(data.userId))) {
      st.queue.push(String(data.userId));
      if (st.queue.length === 1) {
        io.to(room).emit('your_turn', { type: 'your_turn', userId: data.userId, masaId });
        st.currentIdx = 0;
      }
    }
    if (st.queue.length > 0) {
      const curUserId = st.queue[st.currentIdx];
      socket.emit('your_turn', { type: 'your_turn', userId: curUserId, masaId });
    }

    const hist = getChatHistory(masaId);
    if (hist.length > 0) {
      socket.emit('chat_history', { type: 'chat_history', messages: hist });
    }
    const muzik = activeMuzik.get(masaId);
    if (muzik) {
      const elapsed = Math.max(0, Math.floor((Date.now() - muzik.startedAt) / 1000));
      const dur = muzik.durSec || 240;
      if (elapsed < dur - 3) {
        socket.emit('music_play', { ...muzik, type: 'music_play', elapsedOnJoin: elapsed });
      } else {
        activeMuzik.delete(masaId);
      }
    }

    emitBalanceUpdate(data.userId, parseInt(data.hearts)||0, parseInt(data.dg)||0);
    console.log(`[join] ${data.name} -> masa ${masaId} (${count} nəfər)`);
  });

  socket.on('chat', (data) => {
    const masaId = String(data.masaId || 1);
    const msg = {
      type:   'chat',
      userId: data.userId,
      name:   data.name   || '',
      avatar: data.avatar || '',
      text:   data.text   || '',
      isVip:  data.isVip  || false,
      gender: data.gender || '',
      ts:     Date.now(),
    };
    addChatHistory(masaId, msg);
    socket.to(getMasaRoom(masaId)).emit('chat', msg);
  });

  socket.on('spin', (data) => {
    const masaId = String(data.masaId || 1);
    const spinData = {
      type:     'spin',
      angle:    parseFloat(data.angle)    || 0,
      duration: parseFloat(data.duration) || 3,
      winner:   data.winner  || '',
      pair:     data.pair    || '',
      by:       data.by      || '',
      masaId:   masaId,
    };
    socket.to(getMasaRoom(masaId)).emit('spin', spinData);
    const st3 = getSpinState(masaId);
    clearTimeout(st3.autoTimer);
    const spinDur = spinData.duration * 1000 + 600;
    setTimeout(() => nextSpinTurn(masaId), spinDur);
    console.log('[spin] by='+data.by+' winner='+data.winner);
  });

  socket.on('kiss', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('kiss', data);
  });

  socket.on('music_play', (data) => {
    const masaId = String(data.masaId || 1);
    let durSec = 240;
    if (data.duration) {
      const p = String(data.duration).split(':').map(Number);
      durSec = p.length === 3 ? p[0]*3600+p[1]*60+p[2] : p[0]*60+(p[1]||0);
    }
    const payload = {
      type:       'music_play',
      videoId:    data.videoId    || '',
      title:      data.title      || '',
      channel:    data.channel    || '',
      duration:   data.duration   || '',
      durSec:     durSec,
      playType:   data.playType   || 'music',
      userId:     data.userId     || '',
      startedBy:  data.startedBy  || '',
      avatar:     data.avatar     || '',
      startedAt:  data.startedAt  || Date.now(),
      masaId:     masaId,
    };
    activeMuzik.set(masaId, payload);
    socket.to(getMasaRoom(masaId)).emit('music_play', payload);
    console.log(`[music] ${data.title} by=${data.startedBy}`);
  });

  socket.on('music_stop', (data) => {
    const masaId = String(data.masaId || 1);
    activeMuzik.delete(masaId);
    socket.to(getMasaRoom(masaId)).emit('music_stop', {
      type: 'music_stop', userId: data.userId
    });
  });

  socket.on('gift', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('gift', data);
  });

  // ── Şüşə dəyişdirildi ──
  socket.on('bottle_change', (data) => {
    const masaId = String(data.masaId || 1);
    socket.to(getMasaRoom(masaId)).emit('bottle_change', {
      type:   'bottle_change',
      src:    data.src || '',
      userId: data.userId || '',
      masaId: masaId,
    });
    console.log(`[bottle_change] userId=${data.userId} src=${data.src}`);
  });

  socket.on('buy_hearts', (data) => {
    const u = users.get(socket.id);
    if (!u) return;
    const price  = parseInt(data.price)  || 0;
    const hearts = parseInt(data.hearts) || 0;
    if (u.dg < price) {
      emitBalanceUpdate(u.userId, u.hearts, u.dg);
      console.log('[buy_hearts] REJECT: dg='+u.dg+' price='+price);
      return;
    }
    u.dg     -= price;
    u.hearts += hearts;
    emitBalanceUpdate(u.userId, u.hearts, u.dg);
    console.log(`[buy_hearts] userId=${u.userId} hearts+${hearts} dg-${price}`);
  });

  socket.on('music_cost', (data) => {
    const u = users.get(socket.id);
    if (!u) return;
    const cost = parseInt(data.cost) || 0;
    if (u.hearts < cost) {
      emitBalanceUpdate(u.userId, u.hearts, u.dg);
      console.log('[music_cost] REJECT: hearts='+u.hearts+' cost='+cost);
      return;
    }
    u.hearts -= cost;
    emitBalanceUpdate(u.userId, u.hearts, u.dg);
    console.log(`[music_cost] userId=${u.userId} hearts-${cost}`);
  });

  socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));

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
      const st2 = getSpinState(u.masaId);
      const idx = st2.queue.indexOf(String(u.userId));
      if (idx !== -1) {
        st2.queue.splice(idx, 1);
        if (st2.currentIdx >= st2.queue.length) st2.currentIdx = 0;
        if (st2.queue.length > 0) nextSpinTurn(u.masaId);
      }
    }
    users.delete(socket.id);
    console.log('Ayrıldı:', socket.id);
  });
});

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

app.post('/balance', (req, res) => {
  const { user_id, hearts, dg } = req.body;
  if (!user_id) return res.json({ ok: false, error: 'user_id lazımdır' });
  for (const [sid, u] of users) {
    if (String(u.userId) === String(user_id)) {
      if (hearts !== undefined) u.hearts = parseInt(hearts);
      if (dg     !== undefined) u.dg     = parseInt(dg);
    }
  }
  emitBalanceUpdate(user_id,
    hearts !== undefined ? parseInt(hearts) : null,
    dg     !== undefined ? parseInt(dg)     : null
  );
  res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status: 'ok', users: users.size }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Butulka server işləyir:', PORT));
