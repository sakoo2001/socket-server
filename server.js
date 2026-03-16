const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// Online istifadəçiləri saxla
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('Bağlandı:', socket.id);

  // İstifadəçi online oldu
  socket.on('online', (user_id) => {
    onlineUsers.set(String(user_id), socket.id);
    io.emit('online_sayi', onlineUsers.size);
  });

  // Chat mesajı
  socket.on('mesaj', (data) => {
    io.emit('mesaj', data);
  });

  // Ayrıldı
  socket.on('disconnect', () => {
    onlineUsers.forEach((sid, uid) => {
      if (sid === socket.id) onlineUsers.delete(uid);
    });
    io.emit('online_sayi', onlineUsers.size);
  });
});

// PHP-dən bildiriş göndərmək üçün endpoint
app.post('/bildiris', (req, res) => {
  const { user_id, text } = req.body;
  const socketId = onlineUsers.get(String(user_id));
  if (socketId) {
    io.to(socketId).emit('bildiris', { text });
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server işləyir:', PORT));
