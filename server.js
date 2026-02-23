// ══════════════════════════════════════════════════════════
//  DEAD ZONE — Multiplayer WebSocket Server
// ══════════════════════════════════════════════════════════
//
//  DEPLOYMENT (free, 5 minutes):
//  1. Go to https://railway.app and sign up (free tier)
//  2. New Project → Deploy from GitHub repo
//     OR: use Railway CLI:  railway init && railway up
//  3. Add this file + package.json to your repo
//  4. Railway auto-detects Node.js and runs "node server.js"
//  5. Copy the public URL (e.g. wss://your-app.railway.app)
//  6. Paste it into WS_URL at the top of zombie_survival.js
//
//  package.json needed (create alongside this file):
//  {
//    "name": "deadzone-server",
//    "version": "1.0.0",
//    "main": "server.js",
//    "scripts": { "start": "node server.js" },
//    "dependencies": { "ws": "^8.0.0" }
//  }
// ══════════════════════════════════════════════════════════

const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });
const rooms = {};  // roomCode → room

// ── helpers ────────────────────────────────────────────────
function genCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code = '';
  for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? genCode() : code;
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, excludeId) {
  Object.entries(room.players).forEach(function(e) {
    if (e[0] !== excludeId) send(e[1].ws, msg);
  });
}

function broadcastAll(room, msg) { broadcast(room, msg, null); }

function playerList(room) {
  return Object.values(room.players).map(function(p) {
    return { id: p.id, nickname: p.nickname, ready: p.ready };
  });
}

function checkAutoStart(room) {
  var total = Object.keys(room.players).length;
  var ready = Object.values(room.players).filter(function(p) { return p.ready; }).length;
  if (total >= 1 && ready >= Math.ceil(total / 2) && !room.started) {
    room.started = true;
    broadcastAll(room, { type: 'game_start', settings: room.settings });
  }
}

// ── connection handler ─────────────────────────────────────
wss.on('connection', function(ws) {
  var playerId = null;
  var roomCode = null;

  ws.on('message', function(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    // ── CREATE ROOM ──────────────────────────────────────
    if (msg.type === 'create') {
      var code = genCode();
      playerId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      roomCode = code;
      rooms[code] = {
        code: code,
        host: playerId,
        settings: msg.settings || { mode: 'infinite', maxPlayers: 4 },
        players: {},
        started: false,
        zombieCounter: 0
      };
      rooms[code].players[playerId] = {
        id: playerId, nickname: msg.nickname || 'PLAYER',
        ready: false, ws: ws, x: 0, y: 1.75, z: 0, yaw: 0
      };
      send(ws, {
        type: 'created', roomCode: code, playerId: playerId,
        isHost: true, players: playerList(rooms[code]),
        settings: rooms[code].settings
      });
    }

    // ── JOIN ROOM ────────────────────────────────────────
    else if (msg.type === 'join') {
      var room = rooms[msg.roomCode];
      if (!room)   { send(ws, { type: 'error', msg: 'ROOM NOT FOUND' }); return; }
      if (room.started) { send(ws, { type: 'error', msg: 'GAME ALREADY STARTED' }); return; }
      if (Object.keys(room.players).length >= room.settings.maxPlayers)
        { send(ws, { type: 'error', msg: 'ROOM IS FULL' }); return; }

      playerId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      roomCode = msg.roomCode;
      room.players[playerId] = {
        id: playerId, nickname: msg.nickname || 'PLAYER',
        ready: false, ws: ws, x: 0, y: 1.75, z: 0, yaw: 0
      };
      send(ws, {
        type: 'joined', roomCode: msg.roomCode, playerId: playerId,
        isHost: false, players: playerList(room), settings: room.settings
      });
      broadcast(room, {
        type: 'player_joined',
        player: { id: playerId, nickname: msg.nickname || 'PLAYER', ready: false }
      }, playerId);
    }

    // ── READY TOGGLE ─────────────────────────────────────
    else if (msg.type === 'ready') {
      var room = rooms[roomCode];
      if (!room || !room.players[playerId]) return;
      room.players[playerId].ready = !room.players[playerId].ready;
      broadcastAll(room, { type: 'player_ready', playerId: playerId, ready: room.players[playerId].ready });
      checkAutoStart(room);
    }

    // ── POSITION BROADCAST ───────────────────────────────
    else if (msg.type === 'pos') {
      var room = rooms[roomCode];
      if (!room) return;
      var p = room.players[playerId];
      if (p) { p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw; }
      broadcast(room, { type: 'pos', id: playerId, x: msg.x, y: msg.y, z: msg.z, yaw: msg.yaw }, playerId);
    }

    // ── ZOMBIE STATE (host → all clients) ────────────────
    else if (msg.type === 'zombies') {
      var room = rooms[roomCode];
      if (!room || playerId !== room.host) return;
      broadcast(room, { type: 'zombies', data: msg.data }, playerId);
    }

    // ── ZOMBIE SPAWN (host notifies others) ──────────────
    else if (msg.type === 'spawn') {
      var room = rooms[roomCode];
      if (!room || playerId !== room.host) return;
      broadcast(room, { type: 'spawn', netId: msg.netId, ztype: msg.ztype, x: msg.x, z: msg.z }, playerId);
    }

    // ── ZOMBIE DEAD (host notifies all) ──────────────────
    else if (msg.type === 'zombie_dead') {
      var room = rooms[roomCode];
      if (!room || playerId !== room.host) return;
      broadcastAll(room, { type: 'zombie_dead', netId: msg.netId });
    }

    // ── BULLET HIT (non-host tells host) ─────────────────
    else if (msg.type === 'hit') {
      var room = rooms[roomCode];
      if (!room || playerId === room.host) return;
      var hostP = room.players[room.host];
      if (hostP) send(hostP.ws, { type: 'hit', netId: msg.netId, shooterId: playerId });
    }

    // ── BULLET VISUAL (relay to others for smoke/tracer) ─
    else if (msg.type === 'bullet') {
      var room = rooms[roomCode];
      if (!room) return;
      broadcast(room, {
        type: 'bullet', id: playerId,
        ox: msg.ox, oy: msg.oy, oz: msg.oz,
        dx: msg.dx, dy: msg.dy, dz: msg.dz
      }, playerId);
    }

    // ── WAVE STATE (host → all) ───────────────────────────
    else if (msg.type === 'wave') {
      var room = rooms[roomCode];
      if (!room || playerId !== room.host) return;
      broadcast(room, { type: 'wave', waveNum: msg.waveNum, wTotal: msg.wTotal, wKilled: msg.wKilled, waveState: msg.waveState }, playerId);
    }

    // ── PLAYER DEAD ───────────────────────────────────────
    else if (msg.type === 'player_dead') {
      var room = rooms[roomCode];
      if (!room) return;
      broadcastAll(room, { type: 'player_dead', id: playerId });
    }
  });

  // ── DISCONNECT ─────────────────────────────────────────
  ws.on('close', function() {
    if (!roomCode || !playerId) return;
    var room = rooms[roomCode];
    if (!room) return;
    delete room.players[playerId];
    broadcast(room, { type: 'player_left', id: playerId }, null);
    if (Object.keys(room.players).length === 0) {
      delete rooms[roomCode];
    } else if (room.host === playerId) {
      // Transfer host to first remaining player
      room.host = Object.keys(room.players)[0];
      broadcastAll(room, { type: 'new_host', id: room.host });
    }
  });
});

console.log('Dead Zone server running on port ' + PORT);
