const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 2000,
  pingTimeout: 5000
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Game constants ──────────────────────────────────────────
const WORLD_W = 4000;
const WORLD_H = 4000;
const TICK_RATE = 20;           // server ticks per second
const MAX_FOOD = 600;
const FOOD_VALUE = 1;
const BASE_SPEED = 4;
const BOOST_SPEED = 8;
const BOOST_DRAIN = 0.4;       // score lost per tick while boosting
const SEGMENT_SPACING = 12;
const START_LENGTH = 10;
const MAX_PLAYERS = 20;

// ── State ───────────────────────────────────────────────────
const players = {};   // id -> player object
let food = [];        // { x, y, color, value }
let leaderboard = []; // sorted top 10

// ── Helpers ─────────────────────────────────────────────────
function rand(min, max) { return Math.random() * (max - min) + min; }

const FOOD_COLORS = [
  '#ff4757', '#ff6b81', '#ffa502', '#ffdd57',
  '#2ed573', '#1e90ff', '#5352ed', '#ff6348',
  '#a55eea', '#26de81', '#fd79a8', '#00cec9'
];

function spawnFood() {
  return {
    x: rand(50, WORLD_W - 50),
    y: rand(50, WORLD_H - 50),
    color: FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)],
    value: FOOD_VALUE
  };
}

function initFood() {
  food = [];
  for (let i = 0; i < MAX_FOOD; i++) food.push(spawnFood());
}

function spawnOrbs(segments, score) {
  // when a snake dies, drop some food along its body
  const orbs = [];
  const count = Math.min(segments.length, Math.floor(score / 2) + 5);
  for (let i = 0; i < count; i++) {
    const seg = segments[Math.floor(i * segments.length / count)];
    orbs.push({
      x: seg.x + rand(-10, 10),
      y: seg.y + rand(-10, 10),
      color: FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)],
      value: 2
    });
  }
  return orbs;
}

function createPlayer(id, name) {
  const x = rand(200, WORLD_W - 200);
  const y = rand(200, WORLD_H - 200);
  const angle = rand(0, Math.PI * 2);
  const hue = Math.floor(rand(0, 360));
  const segments = [];
  for (let i = 0; i < START_LENGTH; i++) {
    segments.push({
      x: x - Math.cos(angle) * i * SEGMENT_SPACING,
      y: y - Math.sin(angle) * i * SEGMENT_SPACING
    });
  }
  return {
    id,
    name: name || 'Player',
    x, y,
    angle,
    targetAngle: angle,
    segments,
    score: START_LENGTH,
    hue,
    boosting: false,
    alive: true
  };
}

function getRadius(score) {
  return 10 + Math.sqrt(score) * 1.2;
}

// ── Collision ───────────────────────────────────────────────
function checkHeadToBody(p) {
  const headR = getRadius(p.score);
  for (const oid of Object.keys(players)) {
    if (oid === p.id) continue;
    const other = players[oid];
    if (!other.alive) continue;
    const otherR = getRadius(other.score);
    // check head against other's segments (skip first 5 to avoid false positives)
    for (let i = 5; i < other.segments.length; i++) {
      const seg = other.segments[i];
      const dx = p.x - seg.x;
      const dy = p.y - seg.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < headR * 0.5 + otherR * 0.5) {
        return other; // p collided with other
      }
    }
  }
  return null;
}

// ── Game loop ───────────────────────────────────────────────
function tick() {
  // update each player
  for (const p of Object.values(players)) {
    if (!p.alive) continue;

    // smooth angle interpolation
    let da = p.targetAngle - p.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    p.angle += da * 0.15;

    // speed
    const speed = p.boosting ? BOOST_SPEED : BASE_SPEED;
    if (p.boosting) {
      p.score -= BOOST_DRAIN;
      if (p.score < START_LENGTH) {
        p.boosting = false;
        p.score = START_LENGTH;
      }
    }

    // move head
    p.x += Math.cos(p.angle) * speed;
    p.y += Math.sin(p.angle) * speed;

    // world bounds wrap
    if (p.x < 0) p.x += WORLD_W;
    if (p.x > WORLD_W) p.x -= WORLD_W;
    if (p.y < 0) p.y += WORLD_H;
    if (p.y > WORLD_H) p.y -= WORLD_H;

    // insert new head position
    p.segments.unshift({ x: p.x, y: p.y });

    // trim tail to match score
    const targetLen = Math.floor(p.score);
    while (p.segments.length > targetLen) p.segments.pop();

    // eat food
    const headR = getRadius(p.score);
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      if (dx * dx + dy * dy < headR * headR) {
        p.score += f.value;
        food.splice(i, 1);
        food.push(spawnFood());
      }
    }

    // collision with other snakes
    const killer = checkHeadToBody(p);
    if (killer) {
      p.alive = false;
      killer.score += Math.floor(p.score * 0.3);
      const orbs = spawnOrbs(p.segments, p.score);
      food.push(...orbs);
      io.to(p.id).emit('dead', { killer: killer.name });
    }
  }

  // leaderboard
  leaderboard = Object.values(players)
    .filter(p => p.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ name: p.name, score: Math.floor(p.score) }));

  // broadcast state
  const alivePlayers = {};
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    alivePlayers[p.id] = {
      id: p.id,
      name: p.name,
      segments: p.segments,
      score: Math.floor(p.score),
      hue: p.hue,
      boosting: p.boosting
    };
  }

  io.emit('state', {
    players: alivePlayers,
    food,
    leaderboard,
    worldW: WORLD_W,
    worldH: WORLD_H
  });
}

// ── Socket handling ─────────────────────────────────────────
io.on('connection', (socket) => {
  const count = Object.values(players).filter(p => p.alive).length;
  if (count >= MAX_PLAYERS) {
    socket.emit('full');
    socket.disconnect();
    return;
  }

  console.log(`Player connected: ${socket.id}`);

  socket.on('join', (data) => {
    const name = (data.name || 'Player').slice(0, 16);
    players[socket.id] = createPlayer(socket.id, name);
    socket.emit('joined', { id: socket.id, worldW: WORLD_W, worldH: WORLD_H });
    console.log(`${name} joined (${Object.keys(players).length} players)`);
  });

  socket.on('input', (data) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    if (typeof data.angle === 'number') p.targetAngle = data.angle;
    if (typeof data.boosting === 'boolean') p.boosting = data.boosting;
  });

  socket.on('respawn', (data) => {
    const name = (data.name || 'Player').slice(0, 16);
    players[socket.id] = createPlayer(socket.id, name);
    socket.emit('joined', { id: socket.id, worldW: WORLD_W, worldH: WORLD_H });
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p && p.alive) {
      const orbs = spawnOrbs(p.segments, p.score);
      food.push(...orbs);
    }
    delete players[socket.id];
    console.log(`Player disconnected: ${socket.id}`);
  });
});

// ── Start ───────────────────────────────────────────────────
initFood();
setInterval(tick, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Slither server running on port ${PORT}`);
});
