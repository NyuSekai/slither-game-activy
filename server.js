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
const SEND_RATE = 15;           // network updates per second
const MAX_FOOD = 600;
const FOOD_VALUE = 4;
const BASE_SPEED = 12;
const BOOST_SPEED = 24;
const BOOST_DRAIN = 0.4;
const SEGMENT_SPACING = 12;
const START_LENGTH = 10;
const MAX_PLAYERS = 20;
const MAX_LIVES = 2;
const GAME_DURATION = 15 * 60; // 15 minutes in seconds
const VIEW_RANGE = 1100;        // how far each player can "see"
const SEG_SKIP = 3;             // send every Nth segment for other snakes

// ── State ───────────────────────────────────────────────────
const players = {};
let food = [];
let leaderboard = [];
let tickCount = 0;
let gameActive = true;
let gameStartTime = null;

// Track best scores across the entire game (even after death)
const allTimeScores = {}; // id -> { name, score, hue }

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
    alive: true,
    lives: MAX_LIVES,
    spectating: false
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
    for (let i = 5; i < other.segments.length; i++) {
      const seg = other.segments[i];
      const dx = p.x - seg.x;
      const dy = p.y - seg.y;
      const dist = dx * dx + dy * dy; // skip sqrt, compare squared
      const minDist = headR * 0.5 + otherR * 0.5;
      if (dist < minDist * minDist) {
        return other;
      }
    }
  }
  return null;
}

// ── Per-player viewport culling ─────────────────────────────
// Round coords to integers to save bytes in JSON
function R(v) { return Math.round(v); }

function getVisibleFood(cx, cy) {
  const r = VIEW_RANGE;
  const result = [];
  for (let i = 0; i < food.length; i++) {
    const f = food[i];
    const dx = f.x - cx;
    const dy = f.y - cy;
    if (dx > -r && dx < r && dy > -r && dy < r) {
      // Short keys: x,y,c(color),v(value)
      result.push({ x: R(f.x), y: R(f.y), c: f.color, v: f.value });
    }
  }
  return result;
}

function getVisiblePlayers(cx, cy, viewerId) {
  const r = VIEW_RANGE + 500;
  const result = {};
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const inRange = (dx > -r && dx < r && dy > -r && dy < r);

    if (!inRange) {
      let anyVisible = false;
      for (let i = 0; i < p.segments.length; i += 10) {
        const sdx = p.segments[i].x - cx;
        const sdy = p.segments[i].y - cy;
        if (sdx > -r && sdx < r && sdy > -r && sdy < r) {
          anyVisible = true;
          break;
        }
      }
      if (!anyVisible) continue;
    }

    // Downsample + round segments
    let segs;
    if (p.id === viewerId) {
      // Own snake: send every 2nd segment (still very smooth)
      segs = [];
      for (let i = 0; i < p.segments.length; i++) {
        if (i === 0 || i === p.segments.length - 1 || i % 2 === 0) {
          segs.push([R(p.segments[i].x), R(p.segments[i].y)]); // array instead of object
        }
      }
    } else {
      // Other snakes: every SEG_SKIP-th segment
      segs = [];
      for (let i = 0; i < p.segments.length; i++) {
        if (i === 0 || i === p.segments.length - 1 || i % SEG_SKIP === 0) {
          segs.push([R(p.segments[i].x), R(p.segments[i].y)]);
        }
      }
    }

    // Short keys: n(name), s(segments), sc(score), h(hue), b(boosting), l(lives)
    result[p.id] = {
      id: p.id,
      n: p.name,
      s: segs,
      sc: Math.floor(p.score),
      h: p.hue,
      b: p.boosting,
      l: p.lives
    };
  }
  return result;
}

// ── End game ────────────────────────────────────────────────
function endGame() {
  if (!gameActive) return;
  gameActive = false;

  // Update all-time scores one final time for alive players
  for (const p of Object.values(players)) {
    if (p.alive) {
      const existing = allTimeScores[p.id];
      if (!existing || p.score > existing.score) {
        allTimeScores[p.id] = { n: p.name, sc: Math.floor(p.score), h: p.hue };
      }
    }
  }

  // Get top 3 from all-time best scores
  const top3 = Object.values(allTimeScores)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 3);

  io.emit('gameOver', { top3 });
  console.log('Game Over! Top 3:', top3.map(p => `${p.n}: ${p.sc}`).join(', '));
}

// ── Game loop ───────────────────────────────────────────────
function tick() {
  if (!gameActive) return;
  tickCount++;

  // Start timer when first player joins
  if (!gameStartTime && Object.keys(players).length > 0) {
    const alivePlayers = Object.values(players).filter(p => p.alive);
    if (alivePlayers.length > 0) gameStartTime = Date.now();
  }

  // Check time limit
  if (gameStartTime && (Date.now() - gameStartTime) >= GAME_DURATION * 1000) {
    endGame();
    return;
  }

  // Check if only 1 player alive and others have been eliminated (2+ players joined)
  const totalPlayers = Object.keys(players).length;
  const alivePlayers = Object.values(players).filter(p => p.alive);
  const eliminatedPlayers = Object.values(players).filter(p => p.spectating);
  if (totalPlayers >= 2 && alivePlayers.length <= 1 && eliminatedPlayers.length >= 1) {
    // Last snake standing — end the game after a brief delay
    setTimeout(() => endGame(), 2000);
  }

  // Broadcast time remaining
  if (gameStartTime && tickCount % TICK_RATE === 0) {
    const elapsed = (Date.now() - gameStartTime) / 1000;
    const remaining = Math.max(0, Math.floor(GAME_DURATION - elapsed));
    io.emit('timeLeft', remaining);
  }

  // update each player
  for (const p of Object.values(players)) {
    if (!p.alive) continue;

    let da = p.targetAngle - p.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    p.angle += da * 0.12;

    const speed = p.boosting ? BOOST_SPEED : BASE_SPEED;
    if (p.boosting) {
      p.score -= BOOST_DRAIN;
      if (p.score < START_LENGTH) {
        p.boosting = false;
        p.score = START_LENGTH;
      }
    }

    p.x += Math.cos(p.angle) * speed;
    p.y += Math.sin(p.angle) * speed;

    if (p.x < 0) p.x += WORLD_W;
    if (p.x > WORLD_W) p.x -= WORLD_W;
    if (p.y < 0) p.y += WORLD_H;
    if (p.y > WORLD_H) p.y -= WORLD_H;

    p.segments.unshift({ x: p.x, y: p.y });

    const targetLen = Math.floor(p.score);
    while (p.segments.length > targetLen) p.segments.pop();

    // eat food
    const headR = getRadius(p.score);
    const headR2 = headR * headR;
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      if (dx * dx + dy * dy < headR2) {
        p.score += f.value;
        food.splice(i, 1);
        food.push(spawnFood());
      }
    }

    // Track best score for this player
    const existing = allTimeScores[p.id];
    if (!existing || p.score > existing.score) {
      allTimeScores[p.id] = { n: p.name, sc: Math.floor(p.score), h: p.hue };
    }

    const killer = checkHeadToBody(p);
    if (killer) {
      p.alive = false;
      p.lives -= 1;
      killer.score += Math.floor(p.score * 0.3);
      const orbs = spawnOrbs(p.segments, p.score);
      food.push(...orbs);
      if (p.lives <= 0) {
        p.spectating = true;
        io.to(p.id).emit('dead', { killer: killer.name, livesLeft: 0, eliminated: true });
      } else {
        io.to(p.id).emit('dead', { killer: killer.name, livesLeft: p.lives, eliminated: false });
      }
    }
  }

  // leaderboard
  leaderboard = Object.values(players)
    .filter(p => p.alive)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(p => ({ n: p.name, sc: Math.floor(p.score) }));

  // Send each player only what they can see
  for (const socket of io.sockets.sockets.values()) {
    const p = players[socket.id];
    if (!p) continue;

    let cx, cy;
    if (p.alive) {
      cx = p.x;
      cy = p.y;
    } else if (p.spectating) {
      // spectators see the leader
      const leader = Object.values(players).filter(pl => pl.alive).sort((a, b) => b.score - a.score)[0];
      if (leader) { cx = leader.x; cy = leader.y; }
      else continue;
    } else {
      continue;
    }

    const visibleFood = getVisibleFood(cx, cy);
    const visiblePlayers = getVisiblePlayers(cx, cy, socket.id);

    socket.emit('state', {
      players: visiblePlayers,
      food: visibleFood,
      leaderboard,
      worldW: WORLD_W,
      worldH: WORLD_H
    });
  }
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
    const old = players[socket.id];
    if (old && old.spectating) {
      socket.emit('eliminated');
      return;
    }
    const livesLeft = old ? old.lives : MAX_LIVES;
    const name = (data.name || 'Player').slice(0, 16);
    players[socket.id] = createPlayer(socket.id, name);
    players[socket.id].lives = livesLeft;
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
