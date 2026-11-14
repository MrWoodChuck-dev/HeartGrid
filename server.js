// Heart Grid - server
// Only what the Main Menu needs for now: a Host creates a room, Players join it.

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const Shop = require("./shop.js");        // Shop rules (items, prices, buying; names and sizes live in public/js/shop-data.js)
const Cards = require("./cards.js");        // card rules + engine (costs/ranges live in public/js/card-data.js)
const { HG } = Cards;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const CLASSES = ["Tank", "Warrior", "Support", "Mage", "Rogue"];
// Energy capacity per class (same numbers as the class infographic on the client).
const ENERGY_CAP = { Tank: 9, Warrior: 12, Support: 15, Mage: 20, Rogue: 15 };

// HP Grid side length per class (Tank 6x6 ... Rogue 3x3) and the cards each class can be issued.
const HP_GRID = { Tank: 6, Warrior: 5, Support: 4, Mage: 3, Rogue: 3 };
const CLASS_CARDS = HG.CLASS_CARDS;
const MAX_CARDS = 4;                 // cards a player can hold
const MIN_POS = 2, MAX_POS = 6;      // positions on an issued card
const CARD_NAME_OK = /^[^\u0000-\u001f<>]{1,16}$/;

// Battlefield size: change ONLY these two numbers. Everything else (spawns, the right third, the client grid) follows.
const COLS = 20, ROWS = 12;

// x = column (0 = far left), y = row (0 = top). Monsters come from the left, players start on the right, everyone faces left.
// The right third of the board is where players start; Tank stands on the last column just outside it.
const ZONE_START = COLS - Math.ceil(COLS / 3);   // first column of the right third
const ACTIVE_START = Math.floor(ZONE_START / 2);   // thirds: Fog Area (left, monsters) | Active Area (middle) | Class Area (right, players)
const FOG_COST = 4;                                // Energy to enter the Fog Area
// The Active Area (7 columns) is 3 columns toward the Fog Area | the middle column | 3 columns toward the Class Area.
// In the Setup Phase the middle column blocks the view of the far side, and players stay on their own 3 columns.
const MID_COL = ACTIVE_START + 3;
const SETUP_X0 = MID_COL + 1;
const SETUP_X1 = ZONE_START - 1;
const MAX_WALLS = 20;                              // structures on the whole battlefield
const WALK_STEP_MS = 140;                          // click-to-walk: one cell per step, everyone sees the icon slide
const MID = Math.floor(ROWS / 2);
const SPAWN = {
  Tank:    { x: ZONE_START - 1, y: MID },
  Warrior: { x: ZONE_START + 1, y: MID - 1 },   // 2 behind Tank, on Tank's right (top of the screen)
  Support: { x: ZONE_START + 2, y: MID + 1 },   // 1 behind Warrior, 2 cells over on the left (bottom)
  Rogue:   { x: ZONE_START + 3, y: MID - 1 },   // directly behind Warrior
  Mage:    { x: ZONE_START + 3, y: MID + 1 }    // directly behind Support
};
// Monsters: what the Host can build in the Monsters tab. Only the Devil is open for now.
const MAX_MONSTERS = 9;                       // on the whole battlefield at once
const MAX_FOG = 7;                            // ... of which at most 7 in the Fog Area
const MAX_ACTIVE = 4;                         // ... and at most 4 in the Active Area (so 4 + 7 is not allowed: 9 in total)
// Class Range: a square centered on the player. Any monster inside it is revealed to everyone (its HP Grid shows on the left).
const CLASS_RANGE_N = { Tank: 5, Warrior: 3, Rogue: 7, Mage: 7, Support: 5 };
const classRange = cls => (CLASS_RANGE_N[cls] - 1) / 2;
const NEAR_EDGE = 2;                          // "near the left edge" of the Active Area = its first 3 columns
const MAX_BENCH = 12;                         // saved monsters
const SPECIES = { devil: { name: "Devil", sprite: "/assets/monsters/devil.png", dice: { attack: 10, move: 2 } } };
const HP_SIZES = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
const RANGE_SIZES = [3, 5, 7, 9, 11];         // Range Grid 3x3 = 1 cell around the monster ... 11x11 = 5 cells
const REGEN = { Tank: 3, Warrior: 4, Support: 5, Mage: 5, Rogue: 6 };   // Energy back at the start of your turn
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const hpAlive = e => e.hp.some(v => v > 0);

// Training sandbox (Activities tab): 5x5 battlefield, the dummy on the left edge, you on the right edge.
// The Training Dummy has a 5x5 HP Grid and only two dice: Attack (D5) and Heal (D5). Dice can roll 0.
const TRAIN = { cols: 5, rows: 5, dummyN: 5, die: 5, range: 2 };     // range 2 = a 5x5 Range Grid around the dummy
function freshTrainee(p) {
  const t = {
    id: p.id, username: p.username, className: p.className, x: TRAIN.cols - 1, y: Math.floor(TRAIN.rows / 2),
    energy: Infinity, cap: p.cap, inEncounter: true, dead: false, cards: p.cards
  };
  Cards.initPlayer(t, HP_GRID[p.className]);
  return t;
}

const STARTER_LABEL = { Tank: "Guard", Warrior: "Attack", Support: "Heal", Mage: "Blast", Rogue: "Attack" };
const STARTER_CARD = { Tank: "guard", Warrior: "attack", Support: "heal", Mage: "blast", Rogue: "attack" };

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map(); // roomID -> { roomID, host: socketId, players: Map(socketId -> player) }

/* ---------- helpers ---------- */

function newRoomID() {
  let id;
  do { id = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(id));
  return id;
}

// Movement pattern: up to 8 cells on a 9x9 grid (index = y*9 + x, center = 40),
// never the center, and every cell must touch the center through other chosen cells.
function validMovement(pattern) {
  if (!Array.isArray(pattern) || pattern.length < 1 || pattern.length > 8) return false;
  if (pattern.some(i => !Number.isInteger(i) || i < 0 || i > 80 || i === 40)) return false;
  if (new Set(pattern).size !== pattern.length) return false;

  const chosen = new Set(pattern);
  const seen = new Set([40]);
  const queue = [40];
  while (queue.length) {
    const cur = queue.shift();
    const x = cur % 9, y = Math.floor(cur / 9);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx > 8 || ny < 0 || ny > 8) continue;
        const next = ny * 9 + nx;
        if (chosen.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
  }
  return pattern.every(i => seen.has(i));
}

// Anything standing on the battlefield. Monsters will be added here later.
function occupied(room, x, y, exceptId, exceptProp) {
  for (const p of room.players.values()) if (p.inEncounter && p.id !== exceptId && p.x === x && p.y === y) return true;
  for (const m of room.monsters) if (m.id !== exceptId && x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) return true;
  for (const s of room.structures) if (s.x === x && s.y === y) return true;
  return propAt(room, x, y, exceptId, exceptProp);
}

/* ---------- Base: the Dropship Area and the structures (rules in structures.js) ---------- */
const HGS = require("./public/js/structure-data.js");
const Structures = require("./structures.js");
const { propAt, propView } = Structures;
let Base;                                            // created once reservedCells exists
const DROP = HGS.dropship(COLS, ROWS);
const inDrop = (x, y) => HGS.inDrop(DROP, x, y);
Base = Structures.create({
  COLS, ROWS, ZONE_START,
  occupied: (room, x, y, a, b) => occupied(room, x, y, a, b),
  reservedCells: (room, exceptId) => reservedCells(room, exceptId),
  newWall: (room, x, y) => room.structures.push({ id: `w${++room.strSeq}`, kind: "wall", x, y, n: 2, hp: [1, 1, 1, 1], marks: Cards.newMarks(2), w: 1, h: 1, name: "Wall", carriedBy: null, owner: "generator" })
});

/* ---------- Walking (Prepare + Setup Phase): click a cell, the icon slides there ---------- */
const key = (x, y) => y * COLS + x;
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Where players may walk right now (null = nowhere: use your movement pattern instead).
function walkRegion(room) {
  if (room.enc.phase === "prepare") return { x0: ZONE_START, x1: COLS - 1 };
  if (room.enc.phase === "setup") return { x0: SETUP_X0, x1: COLS - 1 };      // your half of the Active Area + the Class Area (nobody is teleported)
  return null;
}
const inRegion = (r, x, y) => !!r && x >= r.x0 && x <= r.x1 && y >= 0 && y < ROWS;

// Cells nobody may build on / drop a wall on: where players stand, where they are heading, and where a carried wall is heading.
function reservedCells(room, exceptId) {
  const set = new Set();
  for (const p of room.players.values()) {
    if (!p.inEncounter || p.id === exceptId) continue;
    set.add(key(p.x, p.y));
    if (p.walk) {
      set.add(key(p.walk.dest.x, p.walk.dest.y));
      if (p.carry) set.add(key(p.walk.dest.x + p.carry.dx, p.walk.dest.y + p.carry.dy));
      const held = p.holding && room.props.find(q => q.id === p.holding.id);
      if (held) for (const c of HGS.cellsOf({ ...held, x: p.walk.dest.x + p.holding.dx, y: p.walk.dest.y + p.holding.dy })) set.add(key(c.x, c.y));
    }
  }
  return set;
}

function bfs(start, maxDepth, ok) {
  const prev = new Map([[key(start.x, start.y), null]]), dist = new Map([[key(start.x, start.y), 0]]);
  const q = [start];
  while (q.length) {
    const c = q.shift(), d = dist.get(key(c.x, c.y));
    if (d >= maxDepth) continue;
    for (const [dx, dy] of DIRS4) {
      const n = { x: c.x + dx, y: c.y + dy }, k = key(n.x, n.y);
      if (prev.has(k) || !ok(n)) continue;
      prev.set(k, c); dist.set(k, d + 1); q.push(n);
    }
  }
  return { prev, dist };
}
function pathFrom(prev, start, end) {
  const out = [];
  for (let c = end; c && !(c.x === start.x && c.y === start.y); c = prev.get(key(c.x, c.y))) out.push(c);
  return out.reverse();
}
// The target if it can be reached, otherwise the reachable cell closest to it (the walker stops midway).
function bestEnd(dist, target) {
  let best = null;
  for (const [k, d] of dist) {
    const x = k % COLS, y = Math.floor(k / COLS);
    const score = Math.max(Math.abs(x - target.x), Math.abs(y - target.y)) * 10000 + (Math.abs(x - target.x) + Math.abs(y - target.y)) * 100 + d;
    if (!best || score < best.score) best = { x, y, score };
  }
  return best;
}

function stopWalk(p) { if (p.walk) { clearInterval(p.walk.timer); p.walk = null; } }
function stopAllWalks(room) { for (const p of room.players.values()) stopWalk(p); }

function dropCarry(room, p) {
  if (p.holding) Base.release(room, p);
  if (!p.carry) return;
  const wall = room.structures.find(s => s.id === p.carry.wallId);
  if (wall) wall.carriedBy = null;
  p.carry = null;
}
function dropAllCarries(room) { for (const p of room.players.values()) dropCarry(room, p); }

function startWalk(room, p, path, dest) {
  stopWalk(p);
  if (!path.length) return;
  p.walk = { path, i: 0, dest, timer: null };
  p.walk.timer = setInterval(() => stepWalk(room, p), WALK_STEP_MS);
}

// One step. Structures are phased through (one may have been placed on the way); players and monsters are not.
function stepWalk(room, p) {
  const w = p.walk;
  if (!w) return;
  if (!walkRegion(room)) return stopWalk(p);
  const c = w.path[w.i];
  const held = p.holding ? room.props.find(q => q.id === p.holding.id) : null;
  if (held && !Base.carryFits(room, held, p, c)) {
    stopWalk(p);
    io.to(p.id).emit("move-error", { message: "The structure is in the way: you stopped." });
    return sendBattleState(room);
  }
  const wall = p.carry ? room.structures.find(s => s.id === p.carry.wallId) : null;
  const wc = wall ? { x: c.x + p.carry.dx, y: c.y + p.carry.dy } : null;
  const actorAt = (x, y) =>
    [...room.players.values()].some(o => o.inEncounter && o.id !== p.id && o.x === x && o.y === y) ||
    room.monsters.some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || propAt(room, x, y, null);
  if (actorAt(c.x, c.y) || (wc && actorAt(wc.x, wc.y))) {
    stopWalk(p);
    io.to(p.id).emit("move-error", { message: "Something is in the way: you stopped." });
    return sendBattleState(room);
  }
  p.x = c.x; p.y = c.y;
  if (held) { held.x = c.x + p.holding.dx; held.y = c.y + p.holding.dy; }
  if (wall) { wall.x = wc.x; wall.y = wc.y; }
  w.i++;
  if (w.i >= w.path.length) stopWalk(p);
  sendBattleState(room);
}

// Nearest free cell to (prefX, y) inside columns x0..x1.
function dropInto(room, p, x0, x1, prefX, y) {
  let best = null;
  for (let x = x0; x <= x1; x++) for (let yy = 0; yy < ROWS; yy++) {
    if (occupied(room, x, yy, p.id)) continue;
    const score = Math.max(Math.abs(x - prefX), Math.abs(yy - y)) * 100 + Math.abs(x - prefX) + Math.abs(yy - y);
    if (!best || score < best.score) best = { x, y: yy, score };
  }
  if (!best) return false;
  p.x = best.x; p.y = best.y;
  return true;
}

// The encounter ended: everyone goes to the Class Area for the Prepare Phase. Structures in the Active Area are removed;
// Fog Area and Class Area structures stay. Returns true if anyone was moved (they get the black fade).
function prepareField(room) {
  stopAllWalks(room);
  dropAllCarries(room);
  room.structures = room.structures.filter(s => !(s.x >= ACTIVE_START && s.x < ZONE_START));
  let moved = false;
  for (const p of room.players.values()) {
    p.ready = false;
    p.inEncounter = true;                          // late joiners are part of the next encounter
    if (p.x >= ZONE_START) continue;
    if (dropInto(room, p, ZONE_START, COLS - 1, ZONE_START, p.y)) { io.to(p.id).emit("fog-transition", { to: "class" }); moved = true; }
  }
  return moved;
}

// Moving costs 1 Energy for the closest ring of the 9x9 pattern up to 4 for the farthest.
const moveCost = (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy));

const arenaOf = room => ({ training: false, cols: COLS, rows: ROWS, players: [...room.players.values()], monsters: room.monsters, structures: room.structures, zoneStart: ZONE_START, activeStart: ACTIVE_START, smoke: room.smoke, trail: room.trail, clones: room.clones, blocked: (x, y, exceptId) => occupied(room, x, y, exceptId), hex: room.hex });

// What a client is allowed to know about a player. The Host never sees Guard marks.
function playerView(arena, p, forHost) {
  const marks = Cards.copyMarks(p.marks);
  if (forHost) marks.guard = marks.guard.map(() => null);
  return {
    id: p.id, username: p.username, className: p.className, x: p.x, y: p.y,
    energy: p.energy === Infinity ? null : p.energy, cap: p.cap,
    hp: p.hp, n: p.n, marks, charges: p.charges, dead: p.dead, inEncounter: p.inEncounter,
    hexed: Cards.hexed(arena, p),
    movementPattern: p.movementPattern || [],      // Move (Support) uses a teammate's
    turns: p.turns, shieldMax: p.shieldMax,        // Counter / Shield / Shield Break rounds left
    ready: !!p.ready, walking: !!p.walk, carry: p.carry ? { wallId: p.carry.wallId } : null, holding: p.holding ? { id: p.holding.id } : null,
    cards: forHost ? [] : p.cards                  // teammates can see each other's cards and Energy
  };
}
const monsterView = (m, arena, targets) => ({
  id: m.id, name: m.name, sprite: m.sprite, x: m.x, y: m.y, w: m.w, h: m.h, n: m.n, hp: m.hp,
  species: m.species, range: Cards.monsterRange(arena, m), rangeN: m.rangeN, turn: m.turn, hold: m.hold || 0, weaken: m.weaken || 0,
  ...(targets ? { targets } : {}),                 // Host only: who this Monster can see and target right now
  marks: { guard: [], ret: [], curse: m.marks.curse, armor: m.marks.armor }
});
const hexAura = arena => arena.players
  .filter(m => m.className === "Mage" && arena.hex.has(m.id) && HG.alivePlayer(m))
  .map(m => ({ id: m.id, x: m.x, y: m.y }));

function battleState(room, forHost) {
  const arena = arenaOf(room);
  return {
    cols: COLS, rows: ROWS, zoneStart: ZONE_START, activeStart: ACTIVE_START, nearEdge: NEAR_EDGE,
    fogCost: fogCostNow(room), freeMove: movementFree(room), guide: guideOf(room),
    classRangeN: CLASS_RANGE_N, revealed: revealedIds(room),
    midCol: MID_COL, setupX0: SETUP_X0, maxWalls: MAX_WALLS,
    dropship: DROP, props: room.props.map(p => propView(room, p)),
    structures: room.structures.map(s => ({ id: s.id, kind: s.kind, name: "Wall", x: s.x, y: s.y, n: s.n, hp: s.hp, marks: { guard: [], ret: [], curse: s.marks.curse, armor: s.marks.armor }, carriedBy: s.carriedBy })),
    players: arena.players.map(p => playerView(arena, p, forHost)),
    monsters: room.monsters.map(m => monsterView(m, arena, forHost ? targetsInRange(room, m).map(t => t.id) : null)),
    smoke: forHost ? [] : room.smoke.map(s => ({ x: s.x, y: s.y, by: s.by })),          // only the players can see the smoke
    trail: forHost ? [] : room.trail.map(s => ({ x: s.x, y: s.y, by: s.by })),          // ...and only the Warrior and the Support the Trail (see sendBattleState)
    clones: forHost ? [] : room.clones.map(c => ({ id: c.id, by: c.by, x: c.x, y: c.y, moved: c.moved, acted: c.acted })),   // the Host never sees the Clone
    hexAura: hexAura(arena),
    enc: { phase: room.enc.phase, order: room.enc.order.map(({ kind, id, num }) => ({ kind, id, num })), turn: room.enc.turn },
    maxMonsters: MAX_MONSTERS, maxFog: MAX_FOG, maxActive: MAX_ACTIVE
  };
}

// Smoke, Trail and the Clone only last while their owner is alive and fighting.
function pruneField(room) {
  const fighting = room.enc.phase === "running" || room.enc.phase === "paused";
  for (const list of [room.smoke, room.trail, room.clones]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = room.players.get(list[i].by);
      if (!fighting || !p || !HG.alivePlayer(p) || !p.inEncounter) list.splice(i, 1);
    }
  }
}
const seesTrail = p => p.className === "Warrior" || p.className === "Support";      // only they can see the Trail

function sendBattleState(room) {
  pruneField(room);
  const full = battleState(room, false), noTrail = { ...full, trail: [] };
  for (const p of room.players.values()) io.to(p.id).emit("battle-state", seesTrail(p) ? full : noTrail);
  io.to(room.host).emit("battle-state", battleState(room, true));
}

// Card animations are shown to everyone in the room. The Host gets a version without Guard.
function sendFx(room, fx) {
  fx.id = ++room.fxSeq;
  const hidden = Cards.hostView(fx);
  for (const p of room.players.values()) {
    const trailFx = fx.bf && /^trail/.test(fx.bf.kind);
    io.to(p.id).emit("fx", trailFx && !seesTrail(p) ? hidden : fx);        // Trail: only the Warrior and the Support see it
  }
  io.to(room.host).emit("fx", hidden);
}

// Private to one player: their cards and the Host's pending assignments.
function sendMine(p) {
  io.to(p.id).emit("my-state", { cards: p.cards, assignments: p.assignments, inventory: p.inventory, materials: p.materials });
}

// The Shop is the same for everyone in the room (the Host edits it, players buy from it).
const sendShop = (room, to) => io.to(to || room.roomID).emit("shop-state", { slots: room.shop });

// Drop a player on their spawn cell, or the closest free cell around it.
function placeAtSpawn(room, p) {
  const s = SPAWN[p.className];
  if (room.enc.phase === "prepare") return void dropInto(room, p, ZONE_START, COLS - 1, Math.max(s.x, ZONE_START), s.y);
  if (room.enc.phase === "setup") return void dropInto(room, p, ZONE_START, COLS - 1, Math.max(s.x, ZONE_START), s.y);
  for (let r = 0; r < Math.max(COLS, ROWS); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = s.x + dx, y = s.y + dy;
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS || occupied(room, x, y, p.id)) continue;
      p.x = x; p.y = y;
      return;
    }
  }
}

function takenClasses(room) {
  return [...room.players.values()].map(p => p.className);
}

function sendRoomState(room) {
  io.to(room.host).emit("room-state", {
    players: [...room.players.values()].map(p => ({
      id: p.id, username: p.username, className: p.className,
      energy: p.energy, cap: p.cap, dead: p.dead, inEncounter: p.inEncounter, pending: p.assignments.length
    }))
  });
}

function detach(socket) {
  socket.data.roomID = null;
  socket.data.role = null;
}

function closeRoom(room) {
  io.to(room.roomID).except(room.host).emit("room-closed");
  for (const id of [room.host, ...room.players.keys()]) {
    const s = io.sockets.sockets.get(id);
    if (s) { s.leave(room.roomID); detach(s); }
  }
  rooms.delete(room.roomID);
}

function removePlayer(socket) {
  const room = rooms.get(socket.data.roomID);
  if (!room || socket.data.role !== "player") return;
  const leaving = room.players.get(socket.id);
  if (leaving) { stopWalk(leaving); dropCarry(room, leaving); }
  room.players.delete(socket.id);
  room.hex.delete(socket.id);
  socket.leave(room.roomID);
  detach(socket);
  ensureTurnValid(room);
  sendRoomState(room);
  sendBattleState(room);
}

/* ---------- Encounter: initiative, turns, pause ---------- */
// phase: idle (set up: place monsters, join players) -> running (turn order) -> paused (Host may add monsters / players) -> running again
// (Resume rolls a NEW initiative). Initiative = a die with as many sides as there are players + monsters on the battlefield:
// everyone gets a different number, the highest goes first and the lowest goes last.

// phase: prepare (Class Area only, walk anywhere) -> setup (Active Area, Ready) -> running <-> paused -> (End Encounter) prepare
const newEnc = () => ({ phase: "prepare", order: [], turnIdx: 0, turn: null, round: 1, bonus: [] });
const preEncounter = room => room.enc.phase === "prepare" || room.enc.phase === "setup";

function participants(room) {
  const list = [];
  for (const p of room.players.values()) if (HG.alivePlayer(p)) list.push({ kind: "player", id: p.id });
  for (const m of room.monsters) if (hpAlive(m)) list.push({ kind: "monster", id: m.id });
  return list;
}
function actorValid(room, a) {
  if (!a) return false;
  if (a.kind === "player") { const p = room.players.get(a.id); return !!p && HG.alivePlayer(p); }
  const m = room.monsters.find(x => x.id === a.id);
  return !!m && hpAlive(m);
}
const freshTurn = sp => ({ attack: { sides: sp.dice.attack, roll: null, left: 0 }, move: { sides: sp.dice.move, roll: null, left: 0 } });

function endEncounter(room, message, cleared = false, ask = false) {
  room.enc = newEnc();
  room.encNo++;
  room.smoke.length = 0; room.trail.length = 0; room.clones.length = 0;
  for (const p of room.players.values()) if (p.turns) p.turns.presence = 0;
  for (const m of room.monsters) { m.hold = 0; m.weaken = 0; }
  room.enc.cleared = false;                        // the Prepare Phase replaces the old "walk back" prompt
  for (const m of room.monsters) { m.turn = freshTurn(SPECIES[m.species]); m.counterBy = new Set(); }
  io.to(room.roomID).emit("notice", { message });
  room.fade = prepareField(room);                  // everyone is teleported into the Class Area (with the black fade)
  room.blessPending = ask;
  if (ask) io.to(room.host).emit("bless-prompt", { cleared });
}

// "Prepare for your next battle, you have all been blessed with X energy." The Host picks X when the encounter ends.
function blessParty(room, amount) {
  const x = Math.max(0, Math.min(99, Math.round((Number(amount) || 0) * 2) / 2));
  room.blessPending = false;
  for (const p of room.players.values()) {
    p.energy += x;
    io.to(p.id).emit("blessing", { amount: x, wait: room.fade ? 1700 : 300 });
    sendMine(p);
  }
  room.fade = false;
  sendBattleState(room);
  sendRoomState(room);
}

/* ---------- Fog Area rules ---------- */
const isFog = x => x < ACTIVE_START;

function monsterCounts(room) {
  const c = { fog: 0, active: 0, aliveFog: 0, aliveActive: 0 };
  for (const m of room.monsters) {
    const f = isFog(m.x), live = hpAlive(m);
    if (f) { c.fog++; if (live) c.aliveFog++; } else { c.active++; if (live) c.aliveActive++; }
  }
  return c;
}

// What the party is being asked to do:
//   normal  - monsters in the Active Area: Entering the Fog Area costs Energy.
//   advance - the Active Area is empty but the Fog Area is not: movement is free, everyone walks to the Active Area's left edge,
//             then the whole party is teleported into the Fog Area.
//   retreat - no monsters left at all: movement is free, everyone walks back to the Class Area.
function guideOf(room) {
  const c = monsterCounts(room);
  if (room.enc.phase === "running") return c.aliveActive > 0 ? "normal" : c.aliveFog > 0 ? "advance" : "retreat";
  return room.enc.cleared ? "retreat" : "idle";
}
const movementFree = room => { const g = guideOf(room); return g === "advance" || g === "retreat"; };
const fogCostNow = room => monsterCounts(room).aliveActive === 0 ? 0 : FOG_COST;       // nobody left in the Active Area: free

// Monsters touched by any living player's Class Range are visible to the whole party (just their HP Grid, never their dice).
function revealedIds(room) {
  const out = [];
  if (preEncounter(room)) return out;              // Prepare / Setup Phase: the Class Range cannot see outside
  for (const m of room.monsters) {
    for (const p of room.players.values()) {
      const r = p.className === "Tank" && p.turns?.presence > 0 ? Cards.PRESENCE_CLASS_RANGE : classRange(p.className);     // Presence: the Tank's Class Range is 7x7
      if (HG.alivePlayer(p) && HG.distTo(p, m) <= r) { out.push(m.id); break; }
    }
    if (out.includes(m.id)) continue;
    for (const c of room.clones) {                                   // the Clone gives the Rogue a second pair of eyes
      const owner = room.players.get(c.by);
      if (owner && HG.alivePlayer(owner) && HG.distTo(c, m) <= classRange("Rogue")) { out.push(m.id); break; }
    }
  }
  return out;
}

// Closest free cell to (tx, y) on one side of the Fog border: the column next to the border first, then further in.
function placeNear(room, p, tx, y) {
  const fog = isFog(tx), dir = fog ? -1 : 1;
  for (let k = 0; k < COLS; k++) {
    const x = tx + dir * k;
    if (x < 0 || x >= COLS || isFog(x) !== fog) break;
    for (let d = 0; d < ROWS; d++) {
      for (const yy of d === 0 ? [y] : [y + d, y - d]) {
        if (yy >= 0 && yy < ROWS && !occupied(room, x, yy, p.id)) { p.x = x; p.y = yy; return true; }
      }
    }
  }
  return false;
}

function teleport(room, p, toFog) {
  if (!placeNear(room, p, toFog ? ACTIVE_START - 1 : ACTIVE_START, p.y)) return;
  io.to(p.id).emit("fog-transition", { to: toFog ? "fog" : "open" });
}

// The encounter is over: anyone still in the Fog Area is brought back out. Returns how many were moved.
function evacuateFog(room) {
  let n = 0;
  for (const p of room.players.values()) if (HG.alivePlayer(p) && isFog(p.x)) { teleport(room, p, false); n++; }
  return n;
}

// Active Area empty, Fog Area not: once every living player is near the Active Area's left edge (or already inside), everyone goes in together.
function checkAdvance(room) {
  if (guideOf(room) !== "advance") return;
  const ps = [...room.players.values()].filter(HG.alivePlayer);
  if (!ps.length || !ps.every(p => isFog(p.x) || p.x <= ACTIVE_START + NEAR_EDGE)) return;
  for (const p of ps.filter(p => !isFog(p.x))) teleport(room, p, true);
}

function startTurn(room) {
  const enc = room.enc;
  const sides = participants(room);
  if (!sides.some(a => a.kind === "player") || !sides.some(a => a.kind === "monster")) {
    const won = !sides.some(a => a.kind === "monster");
    return endEncounter(room, "The encounter is over: one side has no one left.", won, won);
  }
  for (let i = 0; i < enc.order.length; i++) {
    const a = enc.order[enc.turnIdx];
    if (actorValid(room, a)) {
      enc.turn = { kind: a.kind, id: a.id };
      if (a.kind === "player") {
        const p = room.players.get(a.id);
        if (p.energy < p.cap) p.energy = Math.min(p.cap, p.energy + (REGEN[p.className] || 0));
        const upkeep = (room.smoke.some(s => s.by === p.id) ? 1 : 0) + (room.trail.some(s => s.by === p.id) ? 1 : 0);    // 1 Energy a round each, and it can drag you below 0
        if (upkeep) {
          p.energy -= upkeep;
          io.to(p.id).emit("notice", { message: p.energy < 0 ? `Upkeep: -${upkeep} Energy. You're below 0: no cards, no moving. Use your Smoke / Trail again to remove it.` : `Upkeep: -${upkeep} Energy.` });
        }
        for (const c of room.clones) if (c.by === p.id) { c.moved = false; c.acted = false; }
        io.to(p.id).emit("notice", { message: "It's your turn." });
        sendMine(p);
      } else {
        const m = room.monsters.find(x => x.id === a.id);
        m.turn = freshTurn(SPECIES[m.species]);
        m.counterBy = new Set();
      }
      return;
    }
    advanceIdx(room);
  }
  endEncounter(room, "The encounter is over.");
}

// Next place in the turn order. Every time it wraps around a new round starts and turn-based effects (Counter, Shield) lose 1 turn.
function advanceIdx(room) {
  const enc = room.enc;
  enc.turnIdx = (enc.turnIdx + 1) % enc.order.length;
  if (enc.turnIdx === 0) {
    enc.round++;
    Cards.tickRound([...room.players.values()]);
    for (const m of room.monsters) if (m.hold > 0) m.hold--;          // Hold: rounds left
  }
}

// Counter: a Monster damaged a Warrior who had Counter up, so the Warrior acts again right after that Monster's turn, with +6 Energy.
function grantBonus(room, p) {
  room.enc.turn = { kind: "player", id: p.id, bonus: true };
  p.energy += 6;
  io.to(p.id).emit("notice", { message: "Counter! Bonus action: +6 Energy." });
  sendMine(p);
}

function endTurn(room) {
  const enc = room.enc;
  if (enc.phase !== "running") return;
  const prev = enc.turn;
  if (prev && prev.kind === "monster") {
    const m = room.monsters.find(x => x.id === prev.id);
    if (m && m.counterBy) { for (const id of m.counterBy) enc.bonus.push(id); m.counterBy = new Set(); }
  }
  while (enc.bonus.length) {
    const p = room.players.get(enc.bonus.shift());
    if (p && HG.alivePlayer(p)) return grantBonus(room, p);
  }
  advanceIdx(room);
  startTurn(room);
}

// Someone died / left / was removed: make sure the turn is never stuck on them, and end the fight when a side is gone.
function ensureTurnValid(room) {
  if (room.enc.phase !== "running") return;
  const sides = participants(room);
  if (!sides.some(a => a.kind === "player") || !sides.some(a => a.kind === "monster")) {
    const won = !sides.some(a => a.kind === "monster");
    return endEncounter(room, "The encounter is over: one side has no one left.", won, won);
  }
  if (!actorValid(room, room.enc.turn)) { advanceIdx(room); startTurn(room); }
  checkAdvance(room);
}

function rollInitiative(room) {
  const list = participants(room);
  if (!list.some(a => a.kind === "player") || !list.some(a => a.kind === "monster")) return "You need at least one player and one monster on the battlefield.";
  const nums = list.map((_, i) => i + 1);
  for (let i = nums.length - 1; i > 0; i--) { const j = randInt(0, i); [nums[i], nums[j]] = [nums[j], nums[i]]; }
  const order = list.map((a, i) => ({ ...a, num: nums[i] })).sort((a, b) => b.num - a.num);   // highest first, lowest last
  room.enc = { phase: "running", order, turnIdx: 0, turn: null, round: 1, bonus: [] };
  io.to(room.roomID).emit("initiative", {
    sides: list.length,
    order: order.map(a => {
      const e = a.kind === "player" ? room.players.get(a.id) : room.monsters.find(m => m.id === a.id);
      return { kind: a.kind, id: a.id, num: a.num, name: e.username || e.name, className: e.className, sprite: e.sprite };
    })
  });
  startTurn(room);
  return null;
}

// Why a player cannot act right now (null = they can).
function playerBlock(room, p) {
  const enc = room.enc;
  if (preEncounter(room)) return null;
  if (enc.phase === "paused") return "The encounter is paused.";
  return enc.turn && enc.turn.kind === "player" && enc.turn.id === p.id ? null : "It's not your turn.";
}

// Players a monster could hit from where it stands (Taunt forces the Tank).
function targetsInRange(room, m) {
  const arena = arenaOf(room);
  const inR = [...room.players.values()].filter(p => hpAlive(p) && Cards.visible(arena, m, p));   // Shield: untargetable. Smoke hides. Presence: the Tank and his 7x7 are always seen.
  const taunter = inR.find(p => p.className === "Tank" && p.charges.taunt > 0);
  if (taunter) return [taunter];                                  // Taunt: only the Tank, never a Wall
  const walls = room.structures.filter(s => hpAlive(s) && HG.distTo(s, m) <= Cards.monsterRange(arena, m));   // Walls can be attacked too
  return [...inR, ...walls];
}
// Walls with no HP left crumble away.
const clearDeadWalls = room => { room.structures = room.structures.filter(s => hpAlive(s)); };

/* ---------- sockets ---------- */

io.on("connection", socket => {
  // Host: create a room
  socket.on("create-room", () => {
    if (socket.data.roomID) return socket.emit("join-error", { message: "You are already in a room." });
    const roomID = newRoomID();
    const room = { roomID, host: socket.id, players: new Map(), monsters: [], assignSeq: 0, fxSeq: 0, hex: new Set(), bench: [], benchSeq: 0, monSeq: 0, structures: [], strSeq: 0, props: [], propSeq: 0, groupSeq: 0, encNo: 0, shop: Shop.newShop(), shopSeq: 0, smoke: [], trail: [], clones: [], enc: newEnc() };
    rooms.set(roomID, room);
    Base.spawnShop(room);                          // every room starts with the Shop in the Dropship Area
    socket.data.roomID = roomID;
    socket.data.role = "host";
    socket.join(roomID);
    socket.emit("room-created", { roomID });
    sendRoomState(room);
  });

  // Host: close the room (players are sent back to the menu)
  socket.on("close-room", () => {
    const room = rooms.get(socket.data.roomID);
    if (room && socket.data.role === "host") closeRoom(room);
  });

  // Player: does this room exist, and which classes are still open?
  socket.on("check-room", roomID => {
    const room = rooms.get(String(roomID || "").trim().toUpperCase());
    if (!room) return socket.emit("room-availability", { exists: false, availableClasses: [] });
    const taken = takenClasses(room);
    socket.emit("room-availability", {
      exists: true,
      availableClasses: CLASSES.filter(c => !taken.includes(c))
    });
  });

  // Player: finish setup and enter the lobby
  socket.on("join-room", data => {
    const fail = (message, refresh = false) => socket.emit("join-error", { message, refresh });
    if (socket.data.roomID) return fail("You are already in a room.");

    const roomID = String(data?.roomID || "").trim().toUpperCase();
    const username = String(data?.username || "").trim();
    const className = String(data?.className || "");
    const room = rooms.get(roomID);

    if (!room) return fail("Room does not exist.", true);
    if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(username)) return fail("Username must be 2-16 characters.");
    if (!CLASSES.includes(className)) return fail("Invalid class.");
    if (takenClasses(room).includes(className)) return fail(`${className} was just taken. Pick another class.`, true);
    if ([...room.players.values()].some(p => p.username.toLowerCase() === username.toLowerCase())) {
      return fail("That username is already in use.", true);
    }
    if (!validMovement(data?.movementPattern)) return fail("Invalid movement pattern.");

    const card = data?.firstCard;
    const okCard = card && card.type === STARTER_CARD[className] && Array.isArray(card.pattern) &&
      card.pattern.length === 2 && new Set(card.pattern).size === 2 &&
      card.pattern.every(i => Number.isInteger(i) && i >= 0 && i <= 8);
    if (!okCard) return fail("Choose exactly two cells for your first card.");
    const firstName = String(card.name ?? "").trim() || STARTER_LABEL[className];
    if (!CARD_NAME_OK.test(firstName)) return fail("Card names are 1-16 characters.");

    room.players.set(socket.id, {
      id: socket.id,
      username,
      className,
      movementPattern: [...data.movementPattern],
      cards: [{ type: card.type, name: firstName, pattern: [...card.pattern] }],
      assignments: [],
      inventory: Shop.newInventory(),               // 5x10 grid (structures)
      materials: Shop.newMaterials(),               // Scrap, Mana Stones, Construction Material, Gold
      hp: Array(HP_GRID[className] ** 2).fill(1),   // 1 = normal HP cell, 0 = empty
      dead: false,
      inEncounter: preEncounter(room),            // joining mid-encounter: the Host has to send a Join Encounter
      x: SPAWN[className].x,
      y: SPAWN[className].y,
      cap: ENERGY_CAP[className],
      energy: ENERGY_CAP[className]
    });
    socket.data.roomID = roomID;
    socket.data.role = "player";
    socket.join(roomID);

    const me = room.players.get(socket.id);
    Cards.initPlayer(me, HP_GRID[className]);       // HP cells, marks (Guard / Retaliate / Curse) and charges
    if (me.inEncounter) placeAtSpawn(room, me);     // Prepare Phase: the Class Area. Setup Phase: your 3 columns of the Active Area
    socket.emit("room-joined", {
      roomID,
      player: { username, className, movementPattern: me.movementPattern, cards: me.cards }
    });
    sendRoomState(room);
    sendBattleState(room);
    sendMine(me);
    sendShop(room, socket.id);
  });

  // Player: step to a cell of their movement pattern
  socket.on("move", data => {
    const room = rooms.get(socket.data.roomID);
    const me = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!me) return;
    const fail = message => { socket.emit("move-error", { message }); sendBattleState(room); };
    if (preEncounter(room)) return fail("Click a cell to walk there.");
    const block = movementFree(room) ? null : playerBlock(room, me);      // free movement (see guideOf) ignores turns
    if (block) return fail(block);
    if (me.energy < 0) return fail("Your Energy is below 0: you can't move. Remove your Smoke to get out.");

    const x = data?.x, y = data?.y;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) return fail("That cell is off the battlefield.");
    if ((x < ACTIVE_START) !== (me.x < ACTIVE_START)) return fail(me.x < ACTIVE_START ? "Use the Active Area button to leave the Fog Area." : "Stand on the edge of the Active Area and use Enter Fog Area.");
    const dx = x - me.x, dy = y - me.y;
    if (dx < -4 || dx > 4 || dy < -4 || dy > 4 || (!dx && !dy)) return fail("That cell is not in your movement pattern.");
    if (!me.movementPattern.includes((dy + 4) * 9 + (dx + 4))) return fail("That cell is not in your movement pattern.");
    if (occupied(room, x, y, me.id)) return fail("Something is already standing there.");
    if (!HG.pathClear(me, { x, y }, (cx, cy) => occupied(room, cx, cy, me.id))) return fail("Something is in the way. You can't jump over monsters, players or walls.");
    const onTrail = seesTrail(me) && room.trail.some(t => t.x === x && t.y === y);          // Trail cells are free for the Warrior and the Support
    const cost = movementFree(room) || onTrail ? 0 : moveCost(dx, dy);
    if (me.dead) return fail("You are dead and cannot move.");
    if (!me.inEncounter) return fail("You are not in the encounter.");
    if (me.energy < cost) return fail("Not enough Energy to move there.");

    me.x = x; me.y = y; me.energy -= cost;
    ensureTurnValid(room);                                       // may start the whole party's walk into the Fog Area
    sendBattleState(room);
    sendRoomState(room);
  });

  // Fog Area: the left third. Standing on the Active Area's left edge you can enter it for the Fog cost (4 Energy, free once the Active
  // Area has no monsters); from the Fog Area's right edge you can come back (free). You land on the cell across the border.
  function crossFog(toFog) {
    const room = rooms.get(socket.data.roomID);
    const me = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!me) return;
    const fail = message => { socket.emit("move-error", { message }); sendBattleState(room); };
    const block = movementFree(room) ? null : playerBlock(room, me);
    if (block) return fail(block);
    if (!me.inEncounter) return fail("You are not in the encounter.");
    if (me.dead) return fail("You are dead and cannot move.");
    const cost = toFog ? fogCostNow(room) : 0;
    if (toFog && room.enc.phase !== "running") return fail("You cannot enter the Fog Area when there is no encounter.");
    if (toFog) {
      if (me.x !== ACTIVE_START) return fail("Stand on the left edge of the Active Area to enter the Fog Area.");
      if (me.energy < cost) return fail(`Entering the Fog Area costs ${cost} Energy.`);
    } else if (me.x !== ACTIVE_START - 1) return fail("Stand on the right edge of the Fog Area to leave it.");
    const before = { x: me.x, y: me.y };
    if (!placeNear(room, me, toFog ? ACTIVE_START - 1 : ACTIVE_START, me.y)) { me.x = before.x; me.y = before.y; return fail("There is no free cell on the other side."); }
    me.energy -= cost;
    socket.emit("fog-transition", { to: toFog ? "fog" : "open" });       // the client fades to black while the new view swaps in
    ensureTurnValid(room);
    sendBattleState(room);
    sendRoomState(room);
  }
  socket.on("enter-fog", () => crossFog(true));
  socket.on("leave-fog", () => crossFog(false));

  /* ---------- Prepare + Setup Phase: click-to-walk, Ready, moving and destroying walls ---------- */

  const walker = () => {
    const room = rooms.get(socket.data.roomID);
    const me = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    return me ? { room, me } : null;
  };
  const walkFail = (room, message) => { socket.emit("move-error", { message }); sendBattleState(room); };
  // Is (x, y) taken by someone else? Structures count unless it is the wall being carried.
  const takenBy = (room, x, y, meId, wallId) =>
    [...room.players.values()].some(o => o.inEncounter && o.id !== meId && o.x === x && o.y === y) ||
    room.monsters.some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) ||
    room.structures.some(s => s.id !== wallId && s.x === x && s.y === y) || propAt(room, x, y, null);

  socket.on("walk-to", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    const region = walkRegion(room);
    if (!region) return walkFail(room, "Click-to-walk is only for the Prepare and Setup Phase.");
    if (!me.inEncounter || me.dead) return walkFail(room, "You cannot walk right now.");
    const tx = data?.x, ty = data?.y;
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || tx >= COLS || ty < 0 || ty >= ROWS) return;
    if (!inRegion(region, me.x, me.y)) return walkFail(room, "You are outside the area you can walk in.");
    stopWalk(me);
    if (tx === me.x && ty === me.y) return;
    const reserved = reservedCells(room, me.id);
    const start = { x: me.x, y: me.y }, target = { x: tx, y: ty };

    if (me.holding) {
      // Moving a structure: player + structure step together (it keeps its offset), around obstacles.
      const prop = room.props.find(q => q.id === me.holding.id);
      if (!prop) { me.holding = null; return walkFail(room, "The structure you were moving is gone."); }
      const okAt = n => inRegion(region, n.x, n.y) && !occupied(room, n.x, n.y, me.id, prop.id) && !reserved.has(key(n.x, n.y)) && Base.carryFits(room, prop, me, n);
      const { prev, dist } = bfs(start, COLS * ROWS, okAt);
      const reach = dist.has(key(tx, ty));
      const end = reach ? target : bestEnd(dist, target);
      if (end.x === start.x && end.y === start.y) return walkFail(room, "There is no room for you and the structure to go that way.");
      startWalk(room, me, pathFrom(prev, start, end), { x: end.x, y: end.y });
      if (!reach) socket.emit("notice", { message: "You and the structure go as far as you can." });
      return;
    }

    if (me.carry) {
      // Carrying a wall: player + wall are a two-cell unit that steps together, around obstacles. No step limit.
      const wall = room.structures.find(s => s.id === me.carry.wallId);
      if (!wall) { me.carry = null; return walkFail(room, "The wall you were carrying is gone."); }
      const { dx, dy } = me.carry;
      const cellOk = (x, y) => inRegion(region, x, y) && !takenBy(room, x, y, me.id, wall.id) && !reserved.has(key(x, y));
      const { prev, dist } = bfs(start, COLS * ROWS, n => cellOk(n.x, n.y) && cellOk(n.x + dx, n.y + dy) && !inDrop(n.x + dx, n.y + dy));   // walls can't be parked on the Dropship Area
      const reach = dist.has(key(tx, ty));
      const end = reach ? target : bestEnd(dist, target);
      if (end.x === start.x && end.y === start.y) return walkFail(room, "There is no room for you and the wall to go that way.");
      startWalk(room, me, pathFrom(prev, start, end), { x: end.x, y: end.y });
      if (!reach) socket.emit("notice", { message: "You and the wall go as far as you can." });
      return;
    }

    if (!inRegion(region, tx, ty)) return walkFail(room, room.enc.phase === "setup" ? "You can't go past the middle column." : "You can only walk inside the Class Area right now.");
    const free = n => inRegion(region, n.x, n.y) && !occupied(room, n.x, n.y, me.id) && !reserved.has(key(n.x, n.y));
    if (!free(target)) return walkFail(room, "Click an empty cell to walk there.");
    const { prev, dist } = bfs(start, COLS * ROWS, free);
    const reach = dist.has(key(tx, ty));
    const end = reach ? target : bestEnd(dist, target);
    if (end.x === start.x && end.y === start.y) return walkFail(room, "There is no way to get there.");
    startWalk(room, me, pathFrom(prev, start, end), { x: end.x, y: end.y });
    if (!reach) socket.emit("notice", { message: "There is no way to get there: you walk as close as you can." });
  });

  socket.on("set-ready", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    if (room.enc.phase !== "setup") return walkFail(room, "Ready is for the Setup Phase.");
    if (!me.inEncounter || me.dead) return;
    if (me.carry) return walkFail(room, "Drop the wall before you press Ready.");
    if (me.holding) return walkFail(room, "Put the structure down before you press Ready.");
    me.ready = !!data?.ready;
    sendBattleState(room);
    sendRoomState(room);
  });

  // Move Wall: stand right next to it (not diagonally); you and the wall then walk as a 1x2 / 2x1 unit. One wall at a time.
  socket.on("carry-start", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    if (room.enc.phase !== "setup") return walkFail(room, "Walls can only be moved in the Setup Phase.");
    if (!me.inEncounter || me.dead) return;
    if (me.carry) return walkFail(room, "You are already carrying a wall.");
    if (me.holding) return walkFail(room, "Put the structure down first.");
    const wall = room.structures.find(s => s.id === data?.wallId);
    if (!wall) return walkFail(room, "That wall is gone.");
    if (wall.carriedBy) return walkFail(room, "Someone is already carrying that wall.");
    if (wall.x < SETUP_X0) return walkFail(room, "That wall is out of reach: you can only move walls on your side of the middle column.");
    const dx = wall.x - me.x, dy = wall.y - me.y;
    if (Math.abs(dx) + Math.abs(dy) !== 1) return walkFail(room, "Stand right next to the wall (up, down, left or right) to move it.");
    stopWalk(me);
    wall.carriedBy = me.id;
    me.carry = { wallId: wall.id, dx, dy };
    socket.emit("notice", { message: `You pick up the wall. Click to walk with it, then Drop Wall.` });
    sendBattleState(room);
  });

  socket.on("carry-drop", () => {
    const w = walker();
    if (!w || !w.me.carry) return;
    stopWalk(w.me);
    dropCarry(w.room, w.me);
    sendBattleState(w.room);
  });

  // Structures in the Base. Stand right next to one, press Move Structure: it joins you. You walk with it, aim it up to 2 cells away, rotate it (R) and click to put it down.
  const holdPhase = room => room.enc.phase === "prepare" || room.enc.phase === "setup";
  socket.on("prop-grab", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    if (!holdPhase(room)) return walkFail(room, "Structures can only be moved in the Prepare and Setup Phase.");
    if (!me.inEncounter || me.dead) return;
    if (me.holding) return walkFail(room, "You are already moving a structure.");
    if (me.carry) return walkFail(room, "Drop the wall first.");
    const prop = room.props.find(p => p.id === data?.id);
    if (!prop) return walkFail(room, "That structure is gone.");
    if (prop.heldBy) return walkFail(room, "Someone is already moving that structure.");
    if (!HGS.touches(prop, me.x, me.y)) return walkFail(room, "Stand right next to the structure (up, down, left or right) to move it.");
    stopWalk(me);
    prop.heldBy = me.id;
    me.holding = { id: prop.id, dx: prop.x - me.x, dy: prop.y - me.y };
    socket.emit("notice", { message: `You are moving a ${HGS.labelOf(prop)} piece. Click within ${HGS.REACH} cells to put it down, Esc sets it down here.` });
    sendBattleState(room);
  });
  // Click: the structure goes to the clicked cell (it becomes its first cell) if it fits within reach, then it is let go. No x, y = set it down right here.
  socket.on("prop-place", data => {
    const w = walker();
    if (!w || !w.me.holding) return;
    const { room, me } = w;
    if (!holdPhase(room)) return walkFail(room, "Structures can only be moved in the Prepare and Setup Phase.");
    const prop = room.props.find(p => p.id === me.holding.id);
    if (!prop) { me.holding = null; return sendBattleState(room); }
    const here = !Number.isInteger(data?.x) || !Number.isInteger(data?.y);
    const next = { ...prop, x: here ? prop.x : data.x, y: here ? prop.y : data.y };
    stopWalk(me);
    const err = Base.spotError(room, next, "player", me, true);
    if (err) return walkFail(room, err);
    prop.x = next.x; prop.y = next.y;
    Base.release(room, me);
    sendBattleState(room);
  });
  socket.on("prop-use", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    const prop = room.props.find(p => p.id === data?.id);
    if (!prop || !me.inEncounter) return;
    const def = HGS.STRUCTURES[prop.type];
    const info = Structures.groupInfo(room, prop.group);
    if (!info.ok) return socket.emit("notice", { message: `The ${def.name} isn't working: all ${info.total} pieces must be connected side by side (${info.linked}/${info.total} are).` });
    if (def.use === "shop") {
      if (!holdPhase(room)) return socket.emit("notice", { message: "The Shop is closed while an encounter is running." });
      return socket.emit("shop-open");
    }
    if (def.use !== "generate") return socket.emit("notice", { message: `${def.name}: Coming Soon.` });
    if (!holdPhase(room)) return walkFail(room, "The Wall Generator only works in the Prepare and Setup Phase.");
    const err = Base.generateWall(room, prop);
    socket.emit("notice", { message: err || "The Wall Generator drops a free Wall." });
    sendBattleState(room);
  });
  socket.on("host-prop-place", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first.");
    const { x, y, rot } = data || {};
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(rot)) return;
    const err = Base.place(room, data.type, x, y, rot);
    if (err) return hostNote(err);
    sendBattleState(room);
  });
  // Removes the whole structure (every piece of it).
  socket.on("host-prop-remove", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first.");
    const gone = room.props.find(p => p.id === data?.id);
    if (!gone) return;
    if (HGS.STRUCTURES[gone.type].auto) return hostNote("The Shop can't be removed.");
    for (const p of room.props.filter(q => q.group === gone.group && q.heldBy)) { const h = room.players.get(p.heldBy); if (h) { stopWalk(h); h.holding = null; } }
    room.props = room.props.filter(p => p.group !== gone.group);
    sendBattleState(room);
  });

  socket.on("destroy-wall", data => {
    const w = walker();
    if (!w) return;
    const { room, me } = w;
    if (room.enc.phase !== "setup") return walkFail(room, "Walls can only be destroyed in the Setup Phase.");
    const wall = room.structures.find(s => s.id === data?.wallId);
    if (!wall) return walkFail(room, "That wall is gone.");
    if (wall.x < SETUP_X0) return walkFail(room, "That wall is out of reach: you can only destroy walls on your side of the middle column.");
    if (wall.carriedBy && wall.carriedBy !== me.id) return walkFail(room, "Someone is carrying that wall.");
    if (wall.carriedBy) { stopWalk(me); dropCarry(room, me); }
    room.structures = room.structures.filter(s => s.id !== wall.id);
    sendBattleState(room);
  });

  /* ---------- Shop: the Host fills the 8x2 grid, players buy ---------- */

  socket.on("host-shop-set", data => {
    const room = hostRoom();
    if (!room) return;
    const err = Shop.setSlot(room, data?.slot, data?.item);
    if (err) return hostNote(err);
    sendShop(room);
  });
  socket.on("host-shop-clear", data => {
    const room = hostRoom();
    if (!room) return;
    const err = Shop.clearSlot(room, data?.slot);
    if (err) return hostNote(err);
    sendShop(room);
  });
  socket.on("shop-buy", data => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!p) return;
    if (!holdPhase(room)) return socket.emit("notice", { message: "The Shop is closed while an encounter is running." });
    const shop = room.props.find(q => q.type === "shop");
    if (!shop || !Structures.groupInfo(room, shop.group).ok) return socket.emit("notice", { message: "The Shop isn't working: its 4 pieces must be connected." });
    const r = Shop.buy(room, p, data?.slot, { maxCards: MAX_CARDS, newId: () => ++room.assignSeq });
    socket.emit("notice", { message: r.error || r.message });
    if (r.error) return;
    sendMine(p);
    if (r.card) sendRoomState(room);
  });

  /* ---------- Host assignments ---------- */

  socket.on("host-assign", data => {
    const room = rooms.get(socket.data.roomID);
    if (!room || socket.data.role !== "host") return;
    const reply = (ok, message) => socket.emit("assign-result", { ok, message });
    const p = room.players.get(data?.playerId);
    if (!p) return reply(false, "That player is no longer in the room.");
    const give = item => { item.id = ++room.assignSeq; p.assignments.push(item); sendMine(p); io.to(p.id).emit("notice", { message: "You have a new assignment in Preparation." }); };

    switch (data.kind) {
      case "energy": {
        const amount = data.amount;
        if (!Number.isInteger(amount) || amount < 1 || amount > 99) return reply(false, "Energy must be a whole number from 1 to 99.");
        give({ kind: "energy", amount });
        return reply(true, `Sent ${amount} Energy to ${p.username}.`);
      }
      case "materials": {
        const err = Shop.giveMaterial(p, data.mat, data.amount);
        if (err) return reply(false, err);
        sendMine(p);
        io.to(p.id).emit("notice", { message: `The Host gave you ${data.amount} ${Shop.HGShop.MATERIALS[data.mat].name}.` });
        return reply(true, `Gave ${data.amount} ${Shop.HGShop.MATERIALS[data.mat].name} to ${p.username}.`);
      }
      case "card": {
        const positions = data.positions;
        if (!CLASS_CARDS[p.className].includes(data.cardType)) return reply(false, `${p.className} cannot be issued that card.`);
        if (!Number.isInteger(positions) || positions < MIN_POS || positions > MAX_POS) return reply(false, `A card has ${MIN_POS} to ${MAX_POS} positions.`);
        const pending = p.assignments.filter(a => a.kind === "card").length;
        if (p.cards.length + pending >= MAX_CARDS) return reply(false, `${p.username} has no free card slot (max ${MAX_CARDS}).`);
        give({ kind: "card", cardType: data.cardType, positions });
        return reply(true, `Issued a ${positions}-position card to ${p.username}.`);
      }
      case "join": {
        if (room.enc.phase === "running") return reply(false, "Pause the encounter first. Then you can send Join Encounter.");
        if (p.inEncounter) return reply(false, `${p.username} is already in the encounter.`);
        if (p.assignments.some(a => a.kind === "join")) return reply(false, `${p.username} already has a Join Encounter waiting.`);
        give({ kind: "join" });
        return reply(true, `Sent Join Encounter to ${p.username}.`);
      }
      case "leave": {
        if (!p.inEncounter) return reply(false, `${p.username} is not in the encounter.`);
        p.inEncounter = false;
        room.hex.delete(p.id);
        io.to(p.id).emit("notice", { message: "The Host removed you from the encounter." });
        reply(true, `${p.username} left the encounter.`);
        break;
      }
      case "kill": {
        if (p.dead) return reply(false, `${p.username} is already dead.`);
        p.dead = true;
        p.hp.fill(0);
        p.marks = Cards.newMarks(p.n);
        p.charges = { taunt: 0, lifesteal: 0, poison: 0 };
        room.hex.delete(p.id);
        io.to(p.id).emit("notice", { message: "The Host killed you." });
        reply(true, `${p.username} was killed.`);
        break;
      }
      case "revive": {
        // Revive a dead player, or simply reset a living player's HP.
        const wasDead = p.dead;
        p.dead = false;
        p.hp.fill(1);
        p.marks = Cards.newMarks(p.n);
        io.to(p.id).emit("notice", { message: wasDead ? "The Host revived you." : "The Host reset your HP." });
        reply(true, wasDead ? `${p.username} was revived.` : `${p.username}'s HP was reset.`);
        break;
      }
      default:
        return reply(false, "Unknown assignment.");
    }
    ensureTurnValid(room);
    sendBattleState(room);
    sendRoomState(room);
  });

  // Player: accept an Energy or Join Encounter assignment (Card assignments go through submit-card)
  socket.on("accept-assignment", id => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    const a = p?.assignments.find(a => a.id === id);
    if (!a) return;
    if (a.kind === "energy") p.energy += a.amount;       // can go over the cap on purpose
    else if (a.kind === "join") {
      if (room.enc.phase === "running") return socket.emit("notice", { message: "The encounter is running. Wait until the Host pauses it." });
      if (!p.inEncounter) { p.inEncounter = true; placeAtSpawn(room, p); }
    }
    else return;
    p.assignments = p.assignments.filter(x => x !== a);
    sendMine(p); sendBattleState(room); sendRoomState(room);
  });

  // Player: throw away one of their cards (Character tab)
  socket.on("discard-card", data => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!p) return;
    const i = data?.index;
    if (!Number.isInteger(i) || i < 0 || i >= p.cards.length) return;
    const [gone] = p.cards.splice(i, 1);
    socket.emit("notice", { message: `Discarded "${gone.name}".` });
    sendMine(p); sendRoomState(room);
  });

  // Player: end your turn
  socket.on("end-turn", () => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!p || room.enc.phase !== "running" || room.enc.turn?.kind !== "player" || room.enc.turn.id !== p.id) return;
    endTurn(room);
    sendBattleState(room); sendRoomState(room);
  });

  // Player: finish an issued card (cells + name)
  socket.on("submit-card", data => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!p) return;
    const fail = message => socket.emit("card-error", { message });
    const a = p.assignments.find(a => a.id === data?.assignmentId && a.kind === "card");
    if (!a) return fail("That assignment is no longer available.");
     // Cards that never use their pattern (CARDS[..].noPattern) have no editor: only the number of positions matters, so the cells are filled in here.
     const pattern = HG.CARDS[a.cardType]?.noPattern ? [...Array(a.positions).keys()] : data?.pattern;
    if (!Array.isArray(pattern) || pattern.length !== a.positions || new Set(pattern).size !== pattern.length ||
        !pattern.every(i => Number.isInteger(i) && i >= 0 && i <= 8)) return fail(`Choose exactly ${a.positions} cells.`);
    if (HG.CARDS[a.cardType]?.noCenter && pattern.includes(4)) return fail(`${HG.CARDS[a.cardType].name} can't use the center cell.`);
    const name = String(data?.name ?? "").trim();
    if (!CARD_NAME_OK.test(name)) return fail("Card names are 1-16 characters.");
    if (p.cards.length >= MAX_CARDS) return fail(`You can only hold ${MAX_CARDS} cards.`);

    p.cards.push({ type: a.cardType, name, pattern: [...pattern] });
    p.assignments = p.assignments.filter(x => x !== a);
    socket.emit("card-saved");
    sendMine(p); sendRoomState(room);
  });

  /* ---------- Using cards (Combat) ---------- */

  const validCardIndex = (p, i) => Number.isInteger(i) && i >= 0 && i < p.cards.length;

  // Clone (Rogue): once per turn it can move with your movement pattern (free) and once per turn it can fake an attack.
  const cloneActor = (socket, data, needsMove) => {
    const room = rooms.get(socket.data.roomID);
    const me = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!me) return null;
    const fail = message => { socket.emit("use-error", { message }); return null; };
    if (room.enc.phase !== "running") return fail("The Clone only works during an encounter.");
    const block = playerBlock(room, me);
    if (block) return fail(block);
    if (me.energy < 0) return fail("Your Energy is below 0: no cards, no moving.");
    const clone = room.clones.find(c => c.by === me.id);
    if (!clone) return fail("You don't have a Clone.");
    return { room, me, clone, fail };
  };

  socket.on("clone-move", data => {
    const a = cloneActor(socket, data);
    if (!a) return;
    const { room, me, clone, fail } = a;
    if (clone.moved) return fail("Your Clone already moved this turn.");
    const x = data?.x, y = data?.y;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) return fail("That cell is off the battlefield.");
    const dx = x - clone.x, dy = y - clone.y;
    if (dx < -4 || dx > 4 || dy < -4 || dy > 4 || (!dx && !dy) || !me.movementPattern.includes((dy + 4) * 9 + (dx + 4))) return fail("That cell is not in your movement pattern.");
    if ((x < ACTIVE_START) !== (clone.x < ACTIVE_START)) return fail("The Clone can't cross the Fog border.");
    if (occupied(room, x, y, null)) return fail("Something is already standing there.");
    if (!HG.pathClear(clone, { x, y }, (cx, cy) => occupied(room, cx, cy, null))) return fail("Something is in the way.");
    clone.x = x; clone.y = y; clone.moved = true;
    sendBattleState(room);
  });

  socket.on("clone-fake", data => {
    const a = cloneActor(socket, data);
    if (!a) return;
    const { room, me, clone, fail } = a;
    if (clone.acted) return fail("Your Clone already attacked this turn.");
    const m = room.monsters.find(x => x.id === data?.monsterId && hpAlive(x));
    if (!m) return fail("Pick a Monster.");
    if (HG.distTo(clone, m) > classRange("Rogue")) return fail("That Monster is out of your Clone's range.");
    clone.acted = true;
    const fx = {
      id: ++room.fxSeq, mode: "battlefield", ctx: "combat", type: "clone", name: "Clone attack", icon: HG.CARDS.clone.icon, positions: 0,
      actor: { id: me.id, name: me.username, className: me.className, x: clone.x, y: clone.y }, steps: [],
      bf: { kind: "fake", from: { x: clone.x, y: clone.y }, to: { x: m.x, y: m.y, w: m.w, h: m.h } }
    };
    for (const p of room.players.values()) io.to(p.id).emit("fx", fx);                // only the players: the Host and the Monsters see an empty cell
    sendBattleState(room);
  });

  socket.on("use-card", data => {
    const room = rooms.get(socket.data.roomID);
    const me = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!me) return;
    if (!validCardIndex(me, data?.cardIndex)) return socket.emit("use-error", { message: "You don't have that card." });
    const block = playerBlock(room, me);
    if (block) return socket.emit("use-error", { message: block });
    const useDef = HG.CARDS[me.cards[data.cardIndex].type];
    if (["field", "displace", "move", "clone"].includes(useDef?.kind) && room.enc.phase !== "running") {
      return socket.emit("use-error", { message: `${useDef.name} can only be used during an encounter.` });
    }
    const useSide = useDef?.side;
    if ((useSide === "enemy" || useSide === "monster") && room.enc.phase !== "running") {
      return socket.emit("use-error", { message: "You cannot use that on Monsters or Walls when there is no encounter." });
    }
    const res = Cards.use(arenaOf(room), me, data.cardIndex, data);
    if (!res.ok) return socket.emit("use-error", { message: res.error });
    clearDeadWalls(room);
    sendFx(room, res.fx);
    ensureTurnValid(room);
    sendBattleState(room);
    sendRoomState(room);
    sendMine(me);
  });

  /* ---------- Training (Activities): a private 5x5 sandbox with a Training Dummy ---------- */
  // Nothing here touches the real battle: your Energy, HP and cards' effects stay in the sandbox.
  // Energy is infinite in here; your real Energy is simply never touched.

  const trainer = () => {
    const room = rooms.get(socket.data.roomID);
    const p = room && socket.data.role === "player" ? room.players.get(socket.id) : null;
    if (!p) return null;
    if (!p.training) {
      p.training = {
        dummy: Cards.makeMonster({ id: "training-dummy", name: "Training Dummy", sprite: "/assets/monsters/training-dummy.png", x: 0, y: Math.floor(TRAIN.rows / 2), n: TRAIN.dummyN, range: TRAIN.range }),
        hex: new Set(),
        me: null,
        hitsLeft: 0,                       // Attack die result still waiting to be placed on your HP Grid
        rolls: { attack: null, heal: null }
      };
    }
    const t = p.training;
    if (!t.me) t.me = freshTrainee(p);
    t.me.cards = p.cards;
    const arena = { training: true, cols: TRAIN.cols, rows: TRAIN.rows, players: [t.me], monsters: [t.dummy], hex: t.hex };
    return { p, t, arena };
  };
  const sendTraining = ctx => io.to(ctx.p.id).emit("training-state", {
    cols: TRAIN.cols, rows: TRAIN.rows,
    player: playerView(ctx.arena, ctx.t.me, false),
    dummy: monsterView(ctx.t.dummy, ctx.arena),
    hexAura: hexAura(ctx.arena),
    dice: {
      sides: TRAIN.die, attack: ctx.t.rolls.attack, heal: ctx.t.rolls.heal, hitsLeft: ctx.t.hitsLeft,
      inRange: HG.distTo(ctx.t.me, ctx.t.dummy) <= ctx.t.dummy.range, range: ctx.t.dummy.range
    }
  });

  socket.on("training-enter", () => {            // every visit starts you fresh; the dummy keeps its damage
    const ctx = trainer();
    if (!ctx) return;
    ctx.t.me = freshTrainee(ctx.p);
    ctx.t.hex.clear();
    ctx.t.hitsLeft = 0;
    ctx.t.rolls = { attack: null, heal: null };
    ctx.arena.players = [ctx.t.me];
    sendTraining(ctx);
  });

  socket.on("training-move", data => {
    const ctx = trainer();
    if (!ctx) return;
    const me = ctx.t.me, x = data?.x, y = data?.y;
    const dummy = ctx.t.dummy;
    const dx = x - me.x, dy = y - me.y;
    const ok = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < TRAIN.cols && y >= 0 && y < TRAIN.rows &&
      dx >= -4 && dx <= 4 && dy >= -4 && dy <= 4 && (dx || dy) &&
      ctx.p.movementPattern.includes((dy + 4) * 9 + (dx + 4)) &&
      !(x >= dummy.x && x < dummy.x + dummy.w && y >= dummy.y && y < dummy.y + dummy.h) &&
      HG.pathClear(me, { x, y }, (cx, cy) => cx >= dummy.x && cx < dummy.x + dummy.w && cy >= dummy.y && cy < dummy.y + dummy.h);   // no jumping over the Dummy
    if (ok) { me.x = x; me.y = y; }
    else socket.emit("move-error", { message: "You can't move there." });
    sendTraining(ctx);
  });

  socket.on("training-use", data => {
    const ctx = trainer();
    if (!ctx) return;
    if (!validCardIndex(ctx.p, data?.cardIndex)) return socket.emit("use-error", { message: "You don't have that card." });
    const res = Cards.use(ctx.arena, ctx.t.me, data.cardIndex, data);
    if (!res.ok) return socket.emit("use-error", { message: res.error });
    socket.emit("fx", { ...res.fx, id: Date.now() });
    sendTraining(ctx);
  });

  socket.on("training-reset", () => {            // Reset HP: only the Training Dummy
    const ctx = trainer();
    if (!ctx) return;
    Cards.resetGrid(ctx.t.dummy);
    sendTraining(ctx);
  });

  socket.on("training-reset-me", () => {         // Reset HP: only your own sandbox HP Grid
    const ctx = trainer();
    if (!ctx) return;
    Cards.resetGrid(ctx.t.me);
    ctx.t.hitsLeft = 0;
    sendTraining(ctx);
  });

  // Dummy's turn: its two dice, once each per turn. Attack (D5) = how many cells of your HP Grid it may hit, but only if you stand in its
  // Range Grid (otherwise the roll waits). Heal (D5) = empty cells of its own grid that come back. The Dummy never moves.
  const rollDie = () => randInt(0, TRAIN.die);      // 0 to 5
  const dummyActor = ctx => ({ id: ctx.t.dummy.id, name: "Training Dummy", className: "Monster" });
  const dummyInRange = ctx => HG.distTo(ctx.t.me, ctx.t.dummy) <= ctx.t.dummy.range;

  socket.on("training-roll", data => {
    const ctx = trainer();
    if (!ctx) return;
    const die = data?.die;
    if (die !== "attack" && die !== "heal") return;
    if (ctx.t.rolls[die] !== null) return socket.emit("notice", { message: "That die was already rolled this turn." });
    let roll = rollDie(), cut = 0;
    if (die === "attack") ({ roll, cut } = Cards.weakenRoll(ctx.t.dummy, roll));   // Weaken lowers the Dummy's Attack roll too
    if (cut) socket.emit("notice", { message: `Weakened: the Dummy's Attack lost ${cut}.` });
    ctx.t.rolls[die] = roll;
    if (die === "attack") {
      ctx.t.hitsLeft = Math.min(roll, Cards.nonEmpty(ctx.t.me).length);
    } else {
      const res = Cards.monsterHeal(ctx.t.dummy, roll);
      if (res.healed) socket.emit("fx", {
        id: Date.now(), mode: "grid", ctx: "training", type: "dummy-heal", name: "Dummy Heal", icon: "/assets/cards/hp-grid/heal.png",
        actor: dummyActor(ctx), steps: res.steps
      });
    }
    sendTraining(ctx);
  });

  // The Attack roll, spent on the cells you picked on your own HP Grid (Guard, Retaliate and Taunt all apply). Using fewer cells is fine.
  socket.on("training-dummy-attack", data => {
    const ctx = trainer();
    if (!ctx || ctx.t.hitsLeft < 1) return;
    const me = ctx.t.me, picks = data?.picks;
    if (!dummyInRange(ctx)) return socket.emit("notice", { message: "Nobody is in the Dummy's range." });
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > ctx.t.hitsLeft || new Set(picks).size !== picks.length ||
        !picks.every(i => Number.isInteger(i) && i >= 0 && i < me.hp.length && me.hp[i] > 0)) {
      return socket.emit("notice", { message: `Pick 1 to ${ctx.t.hitsLeft} cells that still have HP.` });
    }
    const steps = [];
    for (const idx of picks) {
      if (me.hp[idx] <= 0) continue;
      steps.push(...Cards.monsterStrike(ctx.arena, ctx.t.dummy, me, idx).steps);
    }
    ctx.t.hitsLeft = 0;
    socket.emit("fx", {
      id: Date.now(), mode: "grid", ctx: "training", type: "strike", name: "Dummy Attack", icon: ctx.t.dummy.sprite,
      actor: dummyActor(ctx), steps
    });
    sendTraining(ctx);
  });

  socket.on("training-turn", data => {           // a new Dummy's Turn = fresh dice; leaving it drops any unused hits
    const ctx = trainer();
    if (!ctx) return;
    ctx.t.hitsLeft = 0;
    if (data?.turn === "dummy") ctx.t.rolls = { attack: null, heal: null };
    sendTraining(ctx);
  });

  /* ---------- Host: Monsters tab (build + save to the Bench) ---------- */

  const hostRoom = () => {
    const room = rooms.get(socket.data.roomID);
    return room && socket.data.role === "host" ? room : null;
  };
  const hostNote = message => socket.emit("notice", { message });
  const sendBench = room => io.to(room.host).emit("bench-state", { bench: room.bench });

  socket.on("host-save-monster", data => {
    const room = hostRoom();
    if (!room) return;
    const name = String(data?.name ?? "").trim();
    if (!SPECIES[data?.species]) return hostNote("That monster is not available yet.");
    if (!HP_SIZES.includes(data?.hpN)) return hostNote("Pick an HP Grid size.");
    if (!RANGE_SIZES.includes(data?.rangeN)) return hostNote("Pick a Range Grid size.");
    if (!CARD_NAME_OK.test(name)) return hostNote("Monster names are 1-16 characters.");
    if (room.bench.length >= MAX_BENCH) return hostNote(`The Bench is full (${MAX_BENCH}). Discard one first.`);
    const cells = Array.isArray(data.cells) ? data.cells : null, armor = Array.isArray(data.armor) ? data.armor : null;
    const total = data.hpN * data.hpN;
    if ((cells || armor) && !(cells && armor && cells.length === total && armor.length === total &&
        cells.every(v => v === 1 || v === 2) && armor.every(v => v === 0 || v === 1))) return hostNote("That HP Grid edit is not valid.");
    room.bench.push({ id: `b${++room.benchSeq}`, species: data.species, name, hpN: data.hpN, rangeN: data.rangeN, ...(cells ? { cells: [...cells], armor: [...armor] } : {}) });
    sendBench(room);
    hostNote(`${name} was saved to the Bench.`);
  });

  socket.on("host-discard-monster", data => {
    const room = hostRoom();
    if (!room) return;
    const before = room.bench.length;
    room.bench = room.bench.filter(b => b.id !== data?.id);
    if (room.bench.length !== before) sendBench(room);
  });

  // Bench -> Battlefield (never on the players' third) / back off the Battlefield. Only while idle or paused.
  socket.on("host-place", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first. Then you can add monsters.");
    if (room.enc.phase === "setup") return hostNote("The Setup Phase has started: monsters can't be placed anymore.");
    const t = room.bench.find(b => b.id === data?.benchId);
    const x = data?.x, y = data?.y;
    if (!t) return hostNote("That monster is not on the Bench.");
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) return hostNote("That cell is off the battlefield.");
    if (x >= ZONE_START) return hostNote("Monsters cannot start on the players' third of the battlefield.");
    if (x === MID_COL) return hostNote("Monsters cannot be placed on the middle column of the Active Area.");
    if (occupied(room, x, y, null)) return hostNote("Something is already standing there.");
    const cnt = monsterCounts(room);
    if (room.monsters.length >= MAX_MONSTERS) return hostNote(`At most ${MAX_MONSTERS} monsters on the whole battlefield.`);
    if (isFog(x) && cnt.fog >= MAX_FOG) return hostNote(`The Fog Area holds at most ${MAX_FOG} monsters.`);
    if (!isFog(x) && cnt.active >= MAX_ACTIVE) return hostNote(`The Active Area holds at most ${MAX_ACTIVE} monsters.`);
    const sp = SPECIES[t.species];
    const m = Cards.makeMonster({ id: `m${++room.monSeq}`, name: t.name, sprite: sp.sprite, x, y, n: t.hpN, range: (t.rangeN - 1) / 2 });
    if (t.cells) { m.hp = [...t.cells]; m.marks.armor = [...t.armor]; }        // the Host's HP Grid edit: Over-heal + Armor
    m.species = t.species; m.rangeN = t.rangeN; m.turn = freshTurn(sp); m.counterBy = new Set();
    room.monsters.push(m);
    room.enc.cleared = false;
    sendBattleState(room);
  });

  socket.on("host-remove-monster", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first.");
    if (room.enc.phase === "setup") return hostNote("The Setup Phase has started: monsters can't be removed anymore.");
    room.monsters = room.monsters.filter(m => m.id !== data?.id);
    sendBattleState(room);
  });

  /* ---------- Host: Combat tab (encounter + monster turns) ---------- */

  // The Prepare Phase is over for the Active Area: it slides in from the left and docks onto the Class Area (players stay where they are).
  socket.on("host-area-ready", () => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase !== "prepare") return hostNote("The Active Area can only be marked ready during the Prepare Phase.");
    if (!room.monsters.some(m => !isFog(m.x) && hpAlive(m))) return hostNote("Place at least 1 monster in the Active Area before you mark it ready.");
    stopAllWalks(room);
    dropAllCarries(room);
    room.enc.phase = "setup";
    Base.generateAll(room);                                    // Wall Generators drop their free Wall
    for (const p of room.players.values()) p.ready = false;
    io.to(room.roomID).emit("notice", { message: "Setup Phase: position yourselves, then press Ready." });
    sendBattleState(room);
    sendRoomState(room);
  });

  // Battlefield editor: the Host builds walls in the Fog and Active Areas (20 at most on the whole field).
  socket.on("host-wall-place", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first.");
    if (room.enc.phase === "setup") return hostNote("The Setup Phase has started: walls can't be placed anymore.");
    const x = data?.x, y = data?.y;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) return hostNote("That cell is off the battlefield.");
    if (x === MID_COL) return hostNote("Structures cannot be placed on the middle column of the Active Area.");
    if (x >= ZONE_START) return hostNote("Host walls go in the Fog Area and the Active Area. The Class Area is for the players.");
    if (occupied(room, x, y, null)) return hostNote("Something is already standing there.");
    if (reservedCells(room, null).has(key(x, y))) return hostNote("A player is heading to that cell.");
    if (room.structures.length >= MAX_WALLS) return hostNote(`At most ${MAX_WALLS} walls on the battlefield.`);
    room.structures.push({ id: `w${++room.strSeq}`, kind: "wall", x, y, n: 2, hp: [1, 1, 1, 1], marks: Cards.newMarks(2), w: 1, h: 1, name: "Wall", carriedBy: null, owner: "host" });
    sendBattleState(room);
  });
  socket.on("host-wall-remove", data => {
    const room = hostRoom();
    if (!room) return;
    if (room.enc.phase === "running") return hostNote("Pause the encounter first.");
    if (room.enc.phase === "setup") return hostNote("The Setup Phase has started: walls can't be removed anymore.");
    const wall = room.structures.find(s => s.id === data?.id);
    if (!wall) return;
    if (wall.carriedBy) { const c = room.players.get(wall.carriedBy); if (c) { stopWalk(c); dropCarry(room, c); } }
    room.structures = room.structures.filter(s => s.id !== wall.id);
    sendBattleState(room);
  });

  socket.on("host-start-encounter", () => {
    const room = hostRoom();
    if (!room || room.enc.phase === "running") return;
    if (room.enc.phase === "prepare") return hostNote("Click Active Area ready first. Then the players can set up and press Ready.");
    if (room.enc.phase === "setup") {
      const ps = [...room.players.values()].filter(HG.alivePlayer);
      if (!ps.length) return hostNote("Nobody is in the encounter.");
      if (!ps.every(p => p.ready)) return hostNote(`Not everyone is Ready yet (${ps.filter(p => p.ready).length}/${ps.length}).`);
    }
    stopAllWalks(room);
    dropAllCarries(room);
    const err = rollInitiative(room);
    if (err) return hostNote(err);
    sendBattleState(room); sendRoomState(room);
  });
  socket.on("host-pause", () => {
    const room = hostRoom();
    if (!room || room.enc.phase !== "running") return;
    room.enc.phase = "paused"; room.enc.turn = null;
    io.to(room.roomID).emit("notice", { message: "The Host paused the encounter." });
    sendBattleState(room);
  });
  socket.on("host-end-encounter", data => {
    const room = hostRoom();
    if (!room || preEncounter(room)) return;
    endEncounter(room, "The Host ended the encounter.");
    blessParty(room, data?.energy);
  });
  socket.on("host-bless", data => {              // after the monsters were all beaten: the Host says how much Energy everyone gets
    const room = hostRoom();
    if (!room || !room.blessPending) return;
    blessParty(room, data?.energy);
  });
  socket.on("host-end-turn", () => {            // ends a monster's turn, or skips a player's
    const room = hostRoom();
    if (!room || room.enc.phase !== "running") return;
    endTurn(room);
    sendBattleState(room); sendRoomState(room);
  });

  const monsterTurn = (room, id) => {
    const enc = room.enc;
    if (enc.phase !== "running" || enc.turn?.kind !== "monster" || enc.turn.id !== id) { hostNote("It's not that monster's turn."); return null; }
    return room.monsters.find(m => m.id === id) || null;
  };

  // A die can be rolled once per turn. It can roll 0. Attack: the roll waits until someone is in range.
  socket.on("host-roll", data => {
    const room = hostRoom();
    const m = room && monsterTurn(room, data?.monsterId);
    if (!m) return;
    const die = data?.die;
    if (die !== "attack" && die !== "move") return;
    const d = m.turn[die];
    if (d.roll !== null) return hostNote("That die was already rolled this turn.");
    let roll = randInt(0, d.sides), cut = 0;
    if (die === "attack") ({ roll, cut } = Cards.weakenRoll(m, roll));       // Weaken lowers the Attack roll
    d.roll = roll;
    d.left = d.roll;
    socket.emit("host-roll-result", { monsterId: m.id, die, roll: d.roll, weakened: cut, inRange: die === "attack" ? targetsInRange(room, m).length : 0 });
    sendBattleState(room);
  });

  // Move one step (the 3x3 around the monster, never the center), as long as the Move die has some left.
  socket.on("host-move", data => {
    const room = hostRoom();
    const m = room && monsterTurn(room, data?.monsterId);
    if (!m) return;
    const x = data?.x, y = data?.y;
    if (m.hold > 0) return hostNote(`${m.name} is held for ${m.hold} more round${m.hold === 1 ? "" : "s"}: it can't move.`);
    if (m.turn.move.left < 1) return hostNote("No movement left. Roll the Move die first.");
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLS || y < 0 || y >= ROWS) return hostNote("That cell is off the battlefield.");
    if (Math.max(Math.abs(x - m.x), Math.abs(y - m.y)) !== 1) return hostNote("A monster moves to the cells touching it.");
    if (occupied(room, x, y, null)) return hostNote("Something is already standing there.");
    if (isFog(m.x) && !isFog(x)) {                 // Fog -> Active: only while the Active Area still has monsters, and has room
      const cnt = monsterCounts(room);
      if (cnt.aliveActive === 0) return hostNote("Monsters in the Fog Area cannot enter the Active Area while it has no monsters.");
      if (cnt.active >= MAX_ACTIVE) return hostNote(`The Active Area already holds ${MAX_ACTIVE} monsters.`);
    }
    m.x = x; m.y = y;
    m.turn.move.left--;
    ensureTurnValid(room);                          // an emptied Active Area starts the party's walk into the Fog Area
    sendBattleState(room);
  });

  // The Attack roll: spread the damage over players in range, 1 cell = 1 damage, using fewer than rolled is fine.
  socket.on("host-attack", data => {
    const room = hostRoom();
    const m = room && monsterTurn(room, data?.monsterId);
    if (!m) return;
    const left = m.turn.attack.left, picks = data?.picks;
    if (left < 1) return hostNote("No attack left. Roll the Attack die first.");
    const targets = targetsInRange(room, m);
    if (!targets.length) return hostNote("Nobody is in range. Move closer.");
    if (!Array.isArray(picks) || picks.length < 1 || picks.length > left) return hostNote(`Pick 1 to ${left} cells.`);
    const seen = new Set();
    for (const pk of picks) {
      const p = targets.find(t => t.id === pk?.playerId);       // players and Walls; also enforces Taunt: only the Tank is a target then
      const key = `${pk?.playerId}:${pk?.idx}`;
      if (!p) return hostNote("That player cannot be attacked right now.");
      if (!Number.isInteger(pk.idx) || pk.idx < 0 || pk.idx >= p.hp.length || p.hp[pk.idx] <= 0 || seen.has(key)) return hostNote("Pick cells that still have HP.");
      seen.add(key);
    }
    const arena = arenaOf(room);
    const steps = [];
    const counters = [...room.players.values()].filter(p => p.className === "Warrior" && p.turns.counter > 0 && HG.alivePlayer(p));
    const sum = p => p.hp.reduce((a, b) => a + b, 0);
    const before = new Map(counters.map(w => [w.id, sum(w)]));
    for (const pk of picks) {
      const p = room.players.get(pk.playerId) || room.structures.find(s => s.id === pk.playerId);
      if (!p || p.hp[pk.idx] <= 0) continue;
      steps.push(...Cards.monsterStrike(arena, m, p, pk.idx).steps);
    }
    for (const w of counters) if (sum(w) < before.get(w.id)) m.counterBy.add(w.id);     // Counter: the Warrior acts after this turn
    m.turn.attack.left = 0;
    clearDeadWalls(room);
    sendFx(room, {
      mode: "grid", ctx: "combat", type: "strike", name: "Attack", icon: m.sprite,
      actor: { id: m.id, name: m.name, className: "Monster" }, steps
    });
    ensureTurnValid(room);
    sendBattleState(room); sendRoomState(room);
  });

  socket.on("leave-room", () => removePlayer(socket));

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomID);
    if (!room) return;
    if (socket.data.role === "host") closeRoom(room);
    else removePlayer(socket);
  });
});

server.listen(PORT, () => console.log(`Heart Grid running on http://localhost:${PORT}`));
