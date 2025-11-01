import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.static('../frontend')); // Adjust path if needed

let users = [];
let idCounter = 1;

function broadcastUsers() {
  const userList = users.map(u => ({ id: u.id, name: u.name }));
  for (const user of users) {
    if (user.ws.readyState === user.ws.OPEN) {
      user.ws.send(JSON.stringify({ type: 'users', users: userList }));
    }
  }
}

wss.on('connection', ws => {
  console.log("🟢 New WebSocket connection established.");

  const id = `${idCounter++}`;
  const name = `Device-${Math.floor(Math.random() * 900 + 100)}`;
  users.push({ id, name, ws });

  ws.send(JSON.stringify({ type: 'init', id, name }));
  broadcastUsers();

  ws.on('message', message => {
    const msg = JSON.parse(message);
    const target = users.find(u => u.id === msg.to);
    if (target) {
      target.ws.send(JSON.stringify({ ...msg, from: id }));
    }
  });

  ws.on('close', () => {
    users = users.filter(u => u.id !== id);
    broadcastUsers();
  });
});

server.listen(4000, () => console.log('✅ Server running on http://localhost:4000'));
