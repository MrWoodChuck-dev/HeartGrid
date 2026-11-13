// Heart Grid - card engine (server side).
// Pure game rules, no sockets. server.js builds an "arena" and calls use() / monsterStrike().
// Costs, ranges and targeting live in public/js/card-data.js so the browser shows exactly what the server enforces.
//
// arena = { training: bool, cols, rows, players: [player...], monsters: [monster...], hex: Set(mageId) }
// HP cells: 0 = empty, 1 = healthy, 2 = Over-heal. idx = y * n + x.
// marks: per cell, guard = id of the Tank that guards it | ret = Retaliate | curse = Curse.

"use strict";
const HG = require("./public/js/card-data.js");
const { CARDS } = HG;

let rng = Math.random;
const setRng = fn => { rng = fn || Math.random; };            // tests use a fixed sequence
const pick = list => list[Math.floor(rng() * list.length)];
const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));

/* ---------- entities ---------- */

const newMarks = n => ({ guard: Array(n * n).fill(null), ret: Array(n * n).fill(0), curse: Array(n * n).fill(0), armor: Array(n * n).fill(0) });
const copyMarks = m => ({ guard: [...m.guard], ret: [...m.ret], curse: [...m.curse], armor: [...(m.armor || [])] });
const snap = e => ({ cells: [...e.hp], marks: copyMarks(e.marks) });
const nonEmpty = e => { const out = []; e.hp.forEach((v, i) => { if (v > 0) out.push(i); }); return out; };
const emptyCells = e => { const out = []; e.hp.forEach((v, i) => { if (v === 0) out.push(i); }); return out; };
// Armor is not a second layer of HP: it only blocks damage that is not aimed by a pattern, and punishes the pattern that hits it.
const softCells = e => { const out = []; e.hp.forEach((v, i) => { if (v > 0 && !e.marks.armor[i]) out.push(i); }); return out; };
const armoredCells = e => { const out = []; e.hp.forEach((v, i) => { if (v > 0 && e.marks.armor[i]) out.push(i); }); return out; };
const isShielded = p => !!p.turns && p.turns.shield > 0;

function initPlayer(p, n) {
  p.kind = "player";
  p.n = n;
  p.hp = Array(n * n).fill(1);
  p.marks = newMarks(n);
  p.charges = { taunt: 0, lifesteal: 0, poison: 0, penetrate: 0, spellvamp: 0 };
  p.poisonMax = 0;
  p.turns = { counter: 0, shield: 0, shieldBreak: 0, presence: 0 };    // turn-based effects, counted down once per round
  p.shieldMax = 0;
  p.shieldBy = null;
}

// A new round of the turn order: every turn-based effect loses 1 turn. A Shield that ends turns into Shield Break (its length + 3).
function tickRound(players) {
  for (const p of players) {
    if (!p.turns) continue;
    if (p.turns.counter > 0) p.turns.counter--;
    if (p.turns.presence > 0) p.turns.presence--;
    if (p.turns.shield > 0) {
      p.turns.shield--;
      if (p.turns.shield === 0) { p.turns.shieldBreak = p.shieldMax + 3; p.shieldBy = null; }
    } else if (p.turns.shieldBreak > 0) p.turns.shieldBreak--;
  }
}

function makeMonster({ id, name, sprite, x, y, w = 1, h = 1, n, range = 99 }) {
  return { kind: "monster", id, name, sprite, x, y, w, h, n, range, hp: Array(n * n).fill(1), marks: newMarks(n) };
}

function resetGrid(e) { e.hp.fill(1); e.marks = newMarks(e.n); }

/* ---------- fx steps (what the animation engine plays) ---------- */

// A Wall is animated like a Monster (the fx engine only knows players and monsters).
const describe = e => ({ kind: e.kind === "wall" ? "monster" : e.kind, id: e.id, name: e.username || e.name, n: e.n, className: e.className, sprite: e.sprite || (e.kind === "wall" ? "/assets/missing.png" : undefined) });
const beginStep = (e, anim, extra) => ({ anim, target: describe(e), before: snap(e), after: null, changes: [], ...extra });
const endStep = (e, st) => { st.after = snap(e); return st; };

/* ---------- damage ---------- */

function damage(e, idx, st, wave = 0) {
  if (e.hp[idx] <= 0) return false;
  const from = e.hp[idx]--;
  st.changes.push({ idx, from, to: e.hp[idx], wave });
  if (e.hp[idx] === 0) { e.marks.guard[idx] = null; e.marks.ret[idx] = 0; e.marks.armor[idx] = 0; }     // an empty cell can't hold a mark (Armor goes too)
  return true;
}

function neighbors(idx, n) {
  const x = idx % n, y = Math.floor(idx / n), out = [];
  if (y > 0) out.push(idx - n);
  if (y < n - 1) out.push(idx + n);
  if (x > 0) out.push(idx - 1);
  if (x < n - 1) out.push(idx + 1);
  return out;
}

// Curse: the cells above, below and beside it are damaged too; a curse that gets hit chains, all in one go.
function explode(e, idx, st) {
  let wave = [idx], w = 0;
  while (wave.length) {
    w++;
    const next = [];
    for (const c of wave) for (const nb of neighbors(c, e.n)) {
      if (e.marks.armor[nb]) continue;                 // an explosion is not aimed by a pattern: Armor denies it
      if (!damage(e, nb, st, w)) continue;
      if (e.marks.curse[nb]) { e.marks.curse[nb] = 0; st.changes.push({ idx: nb, mark: "curse", on: false, wave: w }); next.push(nb); }
    }
    wave = next;
  }
}

// The one door every damage goes through (attack, poison, retaliate, explosions...).
function hit(e, idx, st) {
  if (!damage(e, idx, st, 0)) return false;
  if (e.marks.curse[idx]) {
    e.marks.curse[idx] = 0;
    st.changes.push({ idx, mark: "curse", on: false, wave: 0 });
    explode(e, idx, st);
  }
  return true;
}

/* ---------- Hex ---------- */

function hexed(arena, e) {
  for (const m of arena.players) {
    if (m.className === "Mage" && arena.hex.has(m.id) && HG.alivePlayer(m) && HG.cheb(m.x, m.y, e.x, e.y) <= 1) return true;
  }
  return false;
}
// The Mage is always affected (he stands in his own 3x3), except for Hex cards.
const costFor = (arena, actor, type, positions) =>
  type !== "hex" && hexed(arena, actor) ? HG.discountedCost(type, positions) : HG.baseCost(type, positions);

/* ---------- Vision: Presence and Smoke decide who a Monster can see and target ---------- */

const PRESENCE_RANGE = 1;          // a Monster's Range becomes a 3x3 while Presence is up
const PRESENCE_CLASS_RANGE = 3;    // the Tank's Class Range becomes 7x7
const presenceTank = arena => arena.players.find(p => p.className === "Tank" && HG.alivePlayer(p) && p.turns && p.turns.presence > 0) || null;
const monsterRange = (arena, m) => presenceTank(arena) ? PRESENCE_RANGE : (m.range ?? 99);

// Smoke: a player standing in smoke is hidden from Monsters, unless a Monster stands in the same smoke area (cells touching, diagonals too).
// The Tank is never hidden.
function smokeHidden(arena, m, p) {
  if (p.className === "Tank" || !arena.smoke || !arena.smoke.length) return false;
  const cells = new Set(arena.smoke.map(s => s.x + "," + s.y));
  if (!cells.has(p.x + "," + p.y)) return false;
  const seen = new Set([p.x + "," + p.y]), queue = [[p.x, p.y]];
  const w = m.w || 1, h = m.h || 1;
  while (queue.length) {
    const [x, y] = queue.pop();
    if (x >= m.x && x < m.x + w && y >= m.y && y < m.y + h) return false;           // the Monster is inside this smoke: everyone in it is revealed
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const k = (x + dx) + "," + (y + dy);
      if ((dx || dy) && cells.has(k) && !seen.has(k)) { seen.add(k); queue.push([x + dx, y + dy]); }
    }
  }
  return true;
}

// Can this Monster see (and so target) this player right now?
// Presence: the Tank is always seen, and so is anyone inside the Tank's 7x7. Smoke hides everyone but the Tank, Presence or not. Shield = untargetable.
function visible(arena, m, p) {
  if (!HG.alivePlayer(p) || isShielded(p) || smokeHidden(arena, m, p)) return false;
  const tank = presenceTank(arena);
  if (tank && (p === tank || HG.cheb(p.x, p.y, tank.x, tank.y) <= PRESENCE_CLASS_RANGE)) return true;
  return HG.distTo(p, m) <= monsterRange(arena, m);
}

/* ---------- Monster strikes (Guard, Retaliate, Taunt) ---------- */

function landOn(arena, monster, victim, idx, steps) {
  const ret = victim.marks.ret[idx];
  const st = beginStep(victim, "pop");
  const ok = hit(victim, idx, st);
  if (ok && ret) { victim.marks.ret[idx] = 0; st.changes.push({ idx, mark: "ret", on: false }); }
  steps.push(endStep(victim, st));
  if (ok && ret) {                                    // landmine: 1 damage back to the one who hit
    const cells = softCells(monster);
    if (cells.length) {
      const back = beginStep(monster, "retaliate-hit");
      hit(monster, pick(cells), back);
      steps.push(endStep(monster, back));
    }
  }
}

function strikeCell(arena, monster, victim, idx, steps) {
  const guardId = victim.marks.guard[idx];
  // Guard only redirects a plain healthy cell. Over-heal on a guarded cell absorbs the hit first and the mark stays.
  if (guardId && victim.hp[idx] === 1) {
    const tank = arena.players.find(p => p.id === guardId);
    const free = tank && HG.alivePlayer(tank) ? nonEmpty(tank) : [];
    const st = beginStep(victim, "guard-break");
    victim.marks.guard[idx] = null;
    st.changes.push({ idx, mark: "guard", on: false });
    steps.push(endStep(victim, st));
    if (free.length) return landOn(arena, monster, tank, pick(free), steps);   // the Tank takes it
  }
  landOn(arena, monster, victim, idx, steps);
}

// One damage from `monster` on `victim`. Taunt forces it onto the Tank (1 damage = 1 charge) if the Tank is within reach.
// `idx` (optional) = the cell the attacker chose. A Taunt redirect ignores it: the Tank's cell is random.
function monsterStrike(arena, monster, victim, idx) {
  const steps = [];
  const tank = arena.players.find(p => p.className === "Tank" && p.charges.taunt > 0 && visible(arena, monster, p));
  const original = victim;
  let note = "";
  if (tank) {
    const before = tank.charges.taunt;
    tank.charges.taunt--;
    victim = tank;
    note = `Taunt ${before} \u2192 ${tank.charges.taunt}`;
  }
  const cells = nonEmpty(victim);
  if (!cells.length) return { steps, note: "Nothing left to hit.", victim };
  const redirected = tank && tank !== original;        // Taunt moved the hit to another player: the Tank's cell is random
  const chosen = !redirected && Number.isInteger(idx) && victim.hp[idx] > 0 ? idx : pick(cells);
  strikeCell(arena, monster, victim, chosen, steps);
  if (note && steps.length) steps[0].caption = note;
  return { steps, note, victim };
}

// Monster Heal: up to `count` random empty cells come back as healthy cells (never Over-heal).
function monsterHeal(monster, count) {
  const st = beginStep(monster, "heal");
  for (let i = 0; i < count; i++) {
    const empties = emptyCells(monster);
    if (!empties.length) break;
    const idx = pick(empties);
    monster.hp[idx] = 1;
    st.changes.push({ idx, from: 0, to: 1, wave: 0 });
  }
  return { steps: [endStep(monster, st)], healed: st.changes.length };
}

/* ---------- Battlefield-Grid cards (Smoke, Trail, Force, Gravity) and Clone + Move: you click cells of the battlefield ---------- */

const fogSideOf = (arena, x) => x < arena.activeStart;
const battleFx = (card, def, actor, positions) => ({
  mode: "battlefield", ctx: "combat", type: card.type, name: card.name, icon: def.icon, positions,
  actor: { id: actor.id, name: actor.username, className: actor.className, x: actor.x, y: actor.y }, steps: []
});
const cellOk = (arena, c) => c && Number.isInteger(c.x) && Number.isInteger(c.y) && c.x >= 0 && c.y >= 0 && c.x < arena.cols && c.y < arena.rows;
// The pattern's cells around a clicked cell (cells off the board are dropped)
function patternCells(arena, card, c, sameSideAs) {
  const out = [];
  for (const i of card.pattern) {
    const x = c.x + (i % 3) - 1, y = c.y + Math.floor(i / 3) - 1;
    if (x < 0 || y < 0 || x >= arena.cols || y >= arena.rows) continue;
    if (sameSideAs != null && fogSideOf(arena, x) !== fogSideOf(arena, sameSideAs)) continue;     // never across the Fog border
    out.push([x, y]);
  }
  return out;
}

// Smoke and Trail: marked cells that stay until you remove them. Upkeep is paid by the server each turn.
function useField(arena, actor, card, def, req, removing) {
  const fail = error => ({ ok: false, error });
  const list = arena[def.marks];
  if (!list) return fail(`${def.name} isn't available in Training.`);
  const positions = card.pattern.length;
  const fx = battleFx(card, def, actor, positions);
  if (removing) {
    const gone = [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].by === actor.id) { gone.push([list[i].x, list[i].y]); list.splice(i, 1); }
    fx.bf = { kind: def.marks + "-off", cells: gone };
    return { ok: true, cost: 0, gained: 0, punished: 0, fx };
  }
  const cost = costFor(arena, actor, card.type, positions);
  if (actor.energy < cost) return fail(`Not enough Energy: ${card.name} costs ${cost}.`);
  const c = req.cursor;
  if (!cellOk(arena, c)) return fail("Click a cell of the battlefield.");
  if (HG.cheb(actor.x, actor.y, c.x, c.y) > HG.rangeOf(card.type, positions)) return fail("That cell is out of range.");
  const cells = patternCells(arena, card, c, actor.x).filter(([x, y]) => !list.some(s => s.x === x && s.y === y));
  if (!cells.length) return fail(`There is no room for ${def.name} there.`);
  for (const [x, y] of cells) list.push({ x, y, by: actor.id });
  actor.energy -= cost;
  fx.bf = { kind: def.marks, cells, from: { x: actor.x, y: actor.y } };
  return { ok: true, cost, gained: 0, punished: 0, fx };
}

// Force pushes, Gravity pulls: every Monster touching the pattern moves 1 cell, unless something is in the way.
function useDisplace(arena, actor, card, def, req) {
  const fail = error => ({ ok: false, error });
  if (!arena.blocked) return fail(`${def.name} isn't available in Training.`);
  const positions = card.pattern.length;
  const cost = costFor(arena, actor, card.type, positions);
  if (actor.energy < cost) return fail(`Not enough Energy: ${card.name} costs ${cost}.`);
  const c = req.cursor;
  if (!cellOk(arena, c)) return fail("Click a cell of the battlefield.");
  if (HG.cheb(actor.x, actor.y, c.x, c.y) > HG.rangeOf(card.type, positions)) return fail("That cell is out of range.");
  const cells = patternCells(arena, card, c, null);
  if (!cells.length) return fail("The pattern is off the battlefield.");
  const sign = n => (n > 0) - (n < 0);
  const touched = arena.monsters.filter(m => HG.aliveMonster(m) && cells.some(([x, y]) => x >= m.x && x < m.x + (m.w || 1) && y >= m.y && y < m.y + (m.h || 1)));
  if (!touched.length) return fail("No Monster is touching the pattern.");
  const mid = m => ({ x: m.x + Math.floor((m.w || 1) / 2), y: m.y + Math.floor((m.h || 1) / 2) });
  const away = (a, b) => HG.cheb(a.x, a.y, b.x, b.y);
  // push: the outermost Monster first, so the ones behind it can follow. pull: the closest first.
  touched.sort((a, b) => def.dir === "push" ? away(mid(b), c) - away(mid(a), c) : away(mid(a), c) - away(mid(b), c));
  const moves = [];
  for (const m of touched) {
    const p = mid(m);
    let dx, dy;
    if (def.dir === "pull") { dx = sign(c.x - p.x); dy = sign(c.y - p.y); }
    else { dx = sign(p.x - c.x); dy = sign(p.y - c.y); if (!dx && !dy) { dx = sign(p.x - actor.x); dy = sign(p.y - actor.y); } }
    if (!dx && !dy) continue;
    const w = m.w || 1, h = m.h || 1, nx = m.x + dx, ny = m.y + dy;
    if (nx < 0 || ny < 0 || nx + w > arena.cols || ny + h > arena.rows) continue;                    // the edge
    if (fogSideOf(arena, nx) !== fogSideOf(arena, m.x) || fogSideOf(arena, nx + w - 1) !== fogSideOf(arena, m.x)) continue;     // the Fog border
    let free = true;
    for (let yy = ny; yy < ny + h && free; yy++) for (let xx = nx; xx < nx + w; xx++) if (arena.blocked(xx, yy, m.id)) { free = false; break; }
    if (!free) continue;                                                                             // an obstruction
    moves.push({ id: m.id, name: m.name, from: { x: m.x, y: m.y }, to: { x: nx, y: ny }, w, h });
    m.x = nx; m.y = ny;
  }
  if (!moves.length) return fail("Nothing moved: every Monster was blocked by an obstruction or the edge.");
  actor.energy -= cost;
  const fx = battleFx(card, def, actor, positions);
  fx.bf = { kind: "displace", dir: def.dir, cells, center: { x: c.x, y: c.y }, moves };
  return { ok: true, cost, gained: 0, punished: 0, fx };
}

// Move (Support): puts a teammate on a cell of THEIR movement pattern. The Support pays the card and the movement.
function useMove(arena, actor, card, def, req) {
  const fail = error => ({ ok: false, error });
  if (!arena.blocked) return fail("Move isn't available in Training.");
  const positions = card.pattern.length;
  const target = arena.players.find(p => p.id === req.targetId);
  if (!target || target.id === actor.id || !HG.alivePlayer(target) || !target.inEncounter) return fail("Pick a teammate.");
  if (HG.distTo(actor, target) > HG.rangeOf(card.type, positions)) return fail("That teammate is out of range.");
  const to = req.to;
  if (!cellOk(arena, to)) return fail("Pick a cell.");
  const dx = to.x - target.x, dy = to.y - target.y;
  if (dx < -4 || dx > 4 || dy < -4 || dy > 4 || (!dx && !dy) || !target.movementPattern.includes((dy + 4) * 9 + (dx + 4))) return fail("That cell is not in their movement pattern.");
  if (fogSideOf(arena, to.x) !== fogSideOf(arena, target.x)) return fail("They can't cross the Fog border like that.");
  if (arena.blocked(to.x, to.y, target.id)) return fail("Something is already standing there.");
  if (!HG.pathClear(target, to, (x, y) => arena.blocked(x, y, target.id))) return fail("Something is in the way. Nobody can jump over monsters, players or Walls.");
  const cardCost = costFor(arena, actor, card.type, positions);
  const trail = (arena.trail || []).some(t => t.x === to.x && t.y === to.y);                // Trail cells are free
  const moveCost = trail ? 0 : Math.max(Math.abs(dx), Math.abs(dy));
  if (actor.energy < cardCost + moveCost) return fail(`Not enough Energy: the card costs ${cardCost} and the move ${moveCost}.`);
  actor.energy -= cardCost + moveCost;
  const from = { x: target.x, y: target.y };
  target.x = to.x; target.y = to.y;
  const fx = battleFx(card, def, actor, positions);
  fx.bf = { kind: "move", id: target.id, name: target.username, from, to: { x: to.x, y: to.y }, moveCost };
  return { ok: true, cost: cardCost + moveCost, gained: 0, punished: 0, fx };
}

// Clone (Rogue): a fake Rogue. Using the card again takes it back (free).
function useClone(arena, actor, card, def, req, removing) {
  const fail = error => ({ ok: false, error });
  if (!arena.clones) return fail("Clone isn't available in Training.");
  const positions = card.pattern.length;
  const fx = battleFx(card, def, actor, positions);
  if (removing) {
    const i = arena.clones.findIndex(c => c.by === actor.id);
    const [gone] = arena.clones.splice(i, 1);
    fx.bf = { kind: "clone-off", x: gone.x, y: gone.y };
    return { ok: true, cost: 0, gained: 0, punished: 0, fx };
  }
  const cost = costFor(arena, actor, card.type, positions);
  if (actor.energy < cost) return fail(`Not enough Energy: ${card.name} costs ${cost}.`);
  const c = req.cursor;
  if (!cellOk(arena, c)) return fail("Click a cell of the battlefield.");
  if (HG.cheb(actor.x, actor.y, c.x, c.y) > HG.rangeOf(card.type, positions)) return fail("That cell is out of range.");
  if (fogSideOf(arena, c.x) !== fogSideOf(arena, actor.x)) return fail("The Clone can't be across the Fog border.");
  if (arena.blocked(c.x, c.y, actor.id)) return fail("Something is already standing there.");
  arena.clones.push({ id: "cl" + actor.id, by: actor.id, x: c.x, y: c.y, moved: false, acted: false });
  actor.energy -= cost;
  fx.bf = { kind: "clone", x: c.x, y: c.y, from: { x: actor.x, y: actor.y } };
  return { ok: true, cost, gained: 0, punished: 0, fx };
}

/* ---------- Using a card ---------- */

function use(arena, actor, cardIndex, req = {}) {
  const card = actor.cards[cardIndex];
  const fail = error => ({ ok: false, error });
  if (!card) return fail("You don't have that card.");
  if (!HG.alivePlayer(actor)) return fail(actor.dead ? "You are dead." : "You are not in the encounter.");
  const def = CARDS[card.type];
  if (!def || !def.playable) return fail(`${def ? def.name : "That card"} can't be used yet.`);
  // using Smoke / Trail / Clone again takes it away, free, whatever your Energy
  const removing = (def.kind === "field" && !!arena[def.marks] && arena[def.marks].some(s => s.by === actor.id)) ||
                   (def.kind === "clone" && !!arena.clones && arena.clones.some(c => c.by === actor.id));
  if (!arena.training && actor.energy < 0 && !removing) return fail("Your Energy is below 0: you can't use any card, not even a free one. Remove your Smoke, Trail or Clone to get out.");
  if (def.kind === "field") return useField(arena, actor, card, def, req, removing);
  if (def.kind === "displace") return useDisplace(arena, actor, card, def, req);
  if (def.kind === "move") return useMove(arena, actor, card, def, req);
  if (def.kind === "clone") return useClone(arena, actor, card, def, req, removing);

  const positions = card.pattern.length;
  const cost = costFor(arena, actor, card.type, positions);
  if (!arena.training && actor.energy < cost) return fail(`Not enough Energy: ${card.name} costs ${cost}.`);

  const cands = HG.candidates(arena, actor, card.type, positions);
  if (!cands.length) return fail(def.side === "enemy" ? "No Monster or Wall in range." : def.side === "monster" ? "No Monster in range." : def.side === "structure" ? "No Wall in range." : "No teammate in range.");

  // Who is it aimed at?
  const asked = Array.isArray(req.targets) ? req.targets : [];
  let chosen = [];
  if (def.side === "self" || !def.side) {
    chosen = [{ e: actor, cursor: asked[0]?.cursor }];
  } else {
    const max = def.multi || 1;
    if (asked.length < 1 || asked.length > max) return fail(max > 1 ? `Pick 1 to ${max} targets.` : "Pick a target.");
    const seen = new Set();
    for (const t of asked) {
      const e = cands.find(c => c.id === t?.id);
      if (!e || seen.has(e.id)) return fail("That target is out of range.");
      seen.add(e.id);
      chosen.push({ e, cursor: t.cursor });
    }
  }

  // Pattern cards: place the pattern, every cell must be on the grid.
  if (def.kind === "grid") {
    for (const t of chosen) {
      t.cells = HG.aimCells(card.pattern, t.cursor, t.e.n, t.e.kind === "wall");
      if (!t.cells) return fail(t.e.kind === "wall" ? "The pattern has to touch the Wall's HP Grid." : "The pattern has to stay inside the HP Grid.");
    }
  }

  if (card.type === "hex" && arena.hex.has(actor.id)) return fail("Hex is already active.");
  if (card.type === "shield") {
    const target = chosen[0].e;
    if (arena.players.some(p => p.turns && p.turns.shield > 0 && p.shieldBy === actor.id)) return fail("You can only shield 1 player at a time.");
    if (target.turns.shield > 0) return fail(`${target.username} is already shielded.`);
    if (target.turns.shieldBreak > 0) return fail(`${target.username} is in Shield Break for ${target.turns.shieldBreak} more round${target.turns.shieldBreak === 1 ? "" : "s"}.`);
  }

  const fx = {
    mode: def.kind === "charge" || def.kind === "turn" ? "charge" : (def.kind === "aura" || def.kind === "pick") ? "battlefield" : "grid",
    ctx: arena.training ? "training" : "combat",
    type: card.type, name: card.name, icon: def.icon, positions,
    actor: { id: actor.id, name: actor.username, className: actor.className, x: actor.x, y: actor.y },
    steps: []
  };
  let gained = 0, punished = 0;

  switch (card.type) {
    case "attack":
    case "breach":
    case "blast": {
      const anim = card.type === "blast" ? "blast" : "pop";
      let hits = 0;
      const acc = { armorHits: 0, penUsed: 0, punish: 0 };
      for (const t of chosen) {
        const st = beginStep(t.e, anim);
        const once = def.breach && t.e.kind !== "wall";           // Breach hits Walls with every cell, but a Monster only once
        let landed = 0;
        for (const idx of t.cells) {
          if (once && landed) break;
          const armored = t.e.hp[idx] > 0 && t.e.marks.armor[idx];
          if (!hit(t.e, idx, st)) continue;
          landed++;
          hits++;
          if (!armored) continue;                      // an Armored cell was damaged by the pattern: Armor punishes...
          acc.armorHits++;
          if (actor.charges.penetrate > 0) { actor.charges.penetrate--; acc.penUsed++; }     // ...unless a Penetrate charge pays for it
          else acc.punish += HG.ARMOR_PUNISH;
        }
        if (acc.armorHits && !st.caption) {
          st.caption = acc.punish ? `Armor punishes: -${acc.punish} Energy` : `Penetrate: no punishment (${acc.penUsed} charge${acc.penUsed === 1 ? "" : "s"})`;
        }
        fx.steps.push(endStep(t.e, st));
      }
      punished += acc.punish;
      // Lifesteal: every successful hit uses 1 charge and heals an empty cell (never Over-heal).
      if (hits && actor.charges.lifesteal > 0) {
        const from = actor.charges.lifesteal;
        const st = beginStep(actor, "lifesteal");
        for (let i = 0; i < hits && actor.charges.lifesteal > 0; i++) {
          const empties = emptyCells(actor);
          if (!empties.length) break;
          const idx = pick(empties);
          actor.hp[idx] = 1;
          actor.charges.lifesteal--;
          st.changes.push({ idx, from: 0, to: 1, wave: 0 });
        }
        if (st.changes.length) {
          st.charge = { type: "lifesteal", from, to: actor.charges.lifesteal };
          st.caption = `Lifesteal ${from} \u2192 ${actor.charges.lifesteal}`;
          fx.steps.push(endStep(actor, st));
        }
      }
      // Spellvamp (Mage): every damaged cell of a Blast uses 1 charge to heal: an empty cell, or else a healthy cell becomes Over-heal.
      if (hits && card.type === "blast" && actor.charges.spellvamp > 0) {
        const from = actor.charges.spellvamp;
        const st = beginStep(actor, "heal");
        for (let i = 0; i < hits && actor.charges.spellvamp > 0; i++) {
          const empties = emptyCells(actor);
          const healthy = actor.hp.map((v, k) => v === 1 ? k : -1).filter(k => k >= 0);
          if (!empties.length && !healthy.length) break;
          const idx = empties.length ? pick(empties) : pick(healthy);
          const was = actor.hp[idx];
          actor.hp[idx] = was + 1;
          actor.charges.spellvamp--;
          st.changes.push({ idx, from: was, to: was + 1, wave: 0 });
        }
        if (st.changes.length) {
          st.caption = `Spellvamp ${from} \u2192 ${actor.charges.spellvamp}`;
          fx.steps.push(endStep(actor, st));
        }
      }
      // Poison: every Attack spends 1 charge on a random 1..max damage to a random cell of the Monster.
      // Poison is not aimed by a pattern, so Armor denies it: it hits soft cells first. With none left, a Penetrate charge strips an Armored cell for it.
      if (card.type === "attack" && actor.charges.poison > 0) {
        const mon = chosen[0].e;
        if (softCells(mon).length || (actor.charges.penetrate > 0 && armoredCells(mon).length)) {
          const from = actor.charges.poison;
          actor.charges.poison--;
          const st = beginStep(mon, "poison");
          const dmg = randInt(1, Math.max(1, actor.poisonMax));
          for (let i = 0; i < dmg; i++) {
            let cells = softCells(mon);
            if (!cells.length) {
              const arm = armoredCells(mon);
              if (!(actor.charges.penetrate > 0 && arm.length)) break;
              const idx = pick(arm);
              mon.marks.armor[idx] = 0;
              st.changes.push({ idx, mark: "armor", on: false });
              actor.charges.penetrate--;
              cells = [idx];
            }
            hit(mon, pick(cells), st);
          }
          st.charge = { type: "poison", from, to: actor.charges.poison };
          st.caption = `Poison ${from} \u2192 ${actor.charges.poison}`;
          fx.steps.push(endStep(mon, st));
        }
      }
      // Penetrate: after the Attack, every charge left removes the Armor of a random Armored cell, however far away it is.
      if (card.type === "attack" && actor.charges.penetrate > 0) {
        const mon = chosen[0].e;
        if (armoredCells(mon).length) {
          const from = actor.charges.penetrate;
          const st = beginStep(mon, "penetrate");
          while (actor.charges.penetrate > 0 && armoredCells(mon).length) {
            const idx = pick(armoredCells(mon));
            mon.marks.armor[idx] = 0;
            st.changes.push({ idx, mark: "armor", on: false });
            actor.charges.penetrate--;
          }
          st.charge = { type: "penetrate", from, to: actor.charges.penetrate };
          st.caption = `Penetrate ${from} \u2192 ${actor.charges.penetrate}`;
          fx.steps.push(endStep(mon, st));
        }
      }
      break;
    }
    case "spellvamp": {
      const t = chosen[0];
      const st = beginStep(t.e, "spellvamp");
      let gain = 0;
      for (const idx of t.cells) {
        if (t.e.hp[idx] <= 0) continue;
        if (t.e.marks.armor[idx]) { t.e.marks.armor[idx] = 0; st.changes.push({ idx, mark: "armor", on: false }); gain++; }
        if (t.e.hp[idx] === 2) { t.e.hp[idx] = 1; st.changes.push({ idx, from: 2, to: 1, wave: 0 }); gain++; }
      }
      const from = actor.charges.spellvamp;
      actor.charges.spellvamp += gain;
      st.caption = gain ? `Spellvamp ${from} \u2192 ${actor.charges.spellvamp}` : "Nothing to strip here";
      fx.steps.push(endStep(t.e, st));
      break;
    }
    case "presence": {
      const from = actor.turns.presence;
      actor.turns.presence += positions;
      fx.charge = { type: "presence", from, to: actor.turns.presence };
      break;
    }
    case "counter": {
      const from = actor.turns.counter;
      actor.turns.counter += positions;
      fx.charge = { type: "counter", from, to: actor.turns.counter };
      break;
    }
    case "shield": {
      const target = chosen[0].e;
      target.turns.shield = positions;
      target.shieldMax = positions;
      target.shieldBy = actor.id;
      fx.bf = { kind: "shield", from: { x: actor.x, y: actor.y }, to: { x: target.x, y: target.y }, amount: positions, targetId: target.id };
      break;
    }
    case "execute": {
      const mon = chosen[0].e;
      const st = beginStep(mon, "execute");
      for (let i = 0; i < positions; i++) {
        const cells = softCells(mon);                  // random damage is not aimed by a pattern: Armored cells are skipped
        if (!cells.length) break;
        hit(mon, pick(cells), st);
      }
      fx.steps.push(endStep(mon, st));
      break;
    }
    case "heal":
    case "repair": {                                   // Repair = Heal for Walls
      const t = chosen[0];
      const st = beginStep(t.e, "heal");
      for (const idx of t.cells) {
        const v = t.e.hp[idx];
        if (v >= 2) continue;                          // Over-heal can't stack
        t.e.hp[idx] = v + 1;
        st.changes.push({ idx, from: v, to: v + 1, wave: 0 });
      }
      fx.steps.push(endStep(t.e, st));
      break;
    }
    case "hold": {
      const mon = chosen[0].e;
      if (mon.hold > 0) return fail("That Monster is already held.");
      mon.hold = def.fixedTurns;
      fx.bf = { kind: "hold", id: mon.id, x: mon.x, y: mon.y, w: mon.w || 1, h: mon.h || 1, amount: def.fixedTurns, targetId: mon.id };
      break;
    }
    case "guard":
    case "retaliate":
    case "curse": {
      const key = card.type === "guard" ? "guard" : card.type === "retaliate" ? "ret" : "curse";
      const t = chosen[0];
      const st = beginStep(t.e, card.type);
      for (const idx of t.cells) {
        if (t.e.hp[idx] <= 0) continue;                // marks only sit on healthy / Over-heal cells
        t.e.marks[key][idx] = key === "guard" ? actor.id : 1;
        st.changes.push({ idx, mark: key, on: true });
      }
      fx.steps.push(endStep(t.e, st));
      break;
    }
    case "rage": {
      const st = beginStep(actor, "rage");
      for (const idx of chosen[0].cells) if (damage(actor, idx, st)) gained += def.perCell;
      st.caption = `+${gained} Energy`;
      fx.steps.push(endStep(actor, st));
      break;
    }
    case "buff": {
      const target = chosen[0].e;
      const give = positions * def.give;
      if (!arena.training) target.energy += give;
      fx.bf = { kind: "buff", from: { x: actor.x, y: actor.y }, to: { x: target.x, y: target.y }, amount: give, targetId: target.id };
      break;
    }
    case "hex": {
      arena.hex.add(actor.id);
      fx.bf = { kind: "hex", id: actor.id, x: actor.x, y: actor.y };
      break;
    }
    case "taunt":
    case "lifesteal":
    case "penetrate":
    case "poison": {
      const from = actor.charges[card.type];
      actor.charges[card.type] += positions;
      if (card.type === "poison") actor.poisonMax = Math.max(from > 0 ? actor.poisonMax : 0, positions);   // Position = maximum damage
      fx.charge = { type: card.type, from, to: actor.charges[card.type] };
      break;
    }
    default:
      return fail("That card can't be used yet.");
  }

  if (!arena.training) actor.energy = Math.max(0, actor.energy - cost + gained - punished);
  return { ok: true, cost, gained, punished, fx };
}

/* ---------- What the Host is allowed to see ---------- */

const blankGuard = m => { m.guard = m.guard.map(() => null); };
function hostView(fx) {
  const c = JSON.parse(JSON.stringify(fx));
  if (c.bf && /^(smoke|trail|clone)/.test(c.bf.kind)) c.bf = { kind: c.bf.kind };        // the Host never sees the smoke, the Trail or the Clone
  c.steps = c.steps.filter(s => s.anim !== "guard" && s.anim !== "guard-break");   // Guard marks are hidden from the Host
  for (const s of c.steps) { blankGuard(s.before.marks); blankGuard(s.after.marks); }
  return c;
}

module.exports = {
  HG, initPlayer, tickRound, isShielded, softCells, armoredCells, makeMonster, resetGrid, newMarks, copyMarks, snap, nonEmpty, setRng,
  hexed, costFor, use, monsterStrike, presenceTank, monsterRange, visible, smokeHidden, PRESENCE_CLASS_RANGE, monsterHeal, hostView, hit, damage
};
