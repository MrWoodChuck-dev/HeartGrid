// Heart Grid - structure engine (server side), the counterpart of cards.js for the Shop / Base.
// Names, shapes and the Dropship Area live in public/js/structure-data.js so the browser shows what the server enforces.
//
// A structure is built from PIECES. Every piece is a prop { id, type, group, piece, x, y, heldBy, gen } on ONE cell; the pieces of one structure share a
// group. A structure only works while all its pieces are connected side by side. While a player carries a piece,
// player.holding = { id, dx, dy } and the piece follows the player (it keeps the offset dx, dy).
"use strict";
const HGS = require("./public/js/structure-data.js");

const MAX_STRUCTURES = 6;                              // structures the Host can have placed (the Shop doesn't count)
const propAt = (room, x, y, ...except) => room.props.some(p => !except.includes(p.id) && p.x === x && p.y === y);

// { total, linked (biggest connected chunk), ok } for one structure (group).
function groupInfo(room, group) {
  const parts = room.props.filter(p => p.group === group);
  if (!parts.length) return { total: 0, linked: 0, ok: false };
  const seen = new Set();
  let linked = 0;
  for (const start of parts) {
    if (seen.has(start.id)) continue;
    let size = 0;
    const stack = [start];
    seen.add(start.id);
    while (stack.length) {
      const a = stack.pop();
      size++;
      for (const b of parts) if (!seen.has(b.id) && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) { seen.add(b.id); stack.push(b); }
    }
    linked = Math.max(linked, size);
  }
  const total = HGS.STRUCTURES[parts[0].type].pieces.length;
  return { total, linked, ok: parts.length === total && linked === total };
}
const propView = (room, p) => {
  const holder = p.heldBy ? room.players.get(p.heldBy) : null;
  const lead = room.props.find(q => q.group === p.group && q.piece === 0);
  return { id: p.id, type: p.type, group: p.group, piece: p.piece, x: p.x, y: p.y, gen: !!lead && lead.gen === room.encNo,
    heldBy: holder ? holder.id : null, heldClass: holder ? holder.className : null, ...groupInfo(room, p.group) };
};

// deps = { COLS, ROWS, ZONE_START, occupied(room, x, y, exceptPlayerOrProp, exceptProp), reservedCells(room, exceptId), newWall(room, x, y) }
function create(deps) {
  const { COLS, ROWS, ZONE_START } = deps;
  const DROP = HGS.dropship(COLS, ROWS);
  const inDrop = (x, y) => HGS.inDrop(DROP, x, y);

  // Why can't this piece (with its x, y) stand here? null = it can.
  // who: "host" = only inside the Dropship Area. "player" = Class Area; holder gives the reach limit; putDown = it is being set down (no Dropship Area).
  function spotError(room, prop, who, holder, putDown) {
    const reserved = deps.reservedCells(room, holder ? holder.id : null);
    const c = { x: prop.x, y: prop.y };
    if (c.x < 0 || c.x >= COLS || c.y < 0 || c.y >= ROWS) return "That is off the battlefield.";
    if (who === "host" && !inDrop(c.x, c.y)) return "The Host can only place structures inside the Dropship Area.";
    if (who === "player" && c.x < ZONE_START) return "Structures can only stand in the Class Area.";
    if (who === "player" && putDown && inDrop(c.x, c.y)) return "You can't put a structure piece down on the Dropship Area.";
    if (holder && HGS.cheb(holder.x, holder.y, c.x, c.y) > HGS.REACH) return `You can only put it down up to ${HGS.REACH} cells from you.`;
    if (deps.occupied(room, c.x, c.y, prop.id)) return "Something is in the way.";
    if (reserved.has(c.y * COLS + c.x)) return "A player is standing or heading there.";
    return null;
  }

  // Host: place a whole structure (all its pieces, in its starting shape) inside the Dropship Area. Returns an error text or "".
  function place(room, type, x, y, rot) {
    const def = HGS.STRUCTURES[type];
    if (!def || def.auto) return "That structure can't be placed.";
    if (new Set(room.props.filter(p => !HGS.STRUCTURES[p.type].auto && p.piece === 0).map(p => p.group)).size >= MAX_STRUCTURES) return `At most ${MAX_STRUCTURES} structures.`;
    const cells = HGS.shapeCells(type, x, y, rot);
    for (const c of cells) { const err = spotError(room, { id: "new", x: c.x, y: c.y }, "host", null, false); if (err) return err; }
    const group = `g${++room.groupSeq}`;
    cells.forEach((c, i) => room.props.push({ id: `pr${++room.propSeq}`, type, group, piece: i, x: c.x, y: c.y, gen: -1, heldBy: null }));
    return "";
  }

  // Every room starts with the Shop: 4 pieces filling the Dropship Area.
  function spawnShop(room) {
    const group = `g${++room.groupSeq}`;
    HGS.STRUCTURES.shop.shape.forEach(([ox, oy], i) =>
      room.props.push({ id: `pr${++room.propSeq}`, type: "shop", group, piece: i, x: DROP.x0 + ox, y: DROP.y0 + oy, gen: -1, heldBy: null }));
  }

  // The Wall Generator: its Generator piece (1) and Output piece (2) must be connected. The new Wall appears on the Output piece.
  // 1 free Wall per encounter, and none while a Wall (or anything) is still there. Returns "" on success, otherwise why not.
  function generateWall(room, anyPiece) {
    if (HGS.STRUCTURES[anyPiece.type].use !== "generate") return "";
    const info = groupInfo(room, anyPiece.group);
    if (!info.ok) return `The Wall Generator isn't working: its pieces must be connected side by side (${info.linked}/${info.total} are).`;
    const lead = room.props.find(p => p.group === anyPiece.group && p.piece === 0);
    const out = room.props.find(p => p.group === anyPiece.group && p.piece === 1);
    if (lead.gen === room.encNo) return "The Wall Generator already made its Wall this encounter.";
    if (room.structures.some(s => s.x === out.x && s.y === out.y)) return "A Wall is still on the Output piece.";
    if (deps.occupied(room, out.x, out.y, out.id)) return "Something is standing on the Output piece.";
    deps.newWall(room, out.x, out.y);
    lead.gen = room.encNo;
    return "";
  }
  const generateAll = room => { for (const p of room.props) if (p.piece === 0) generateWall(room, p); };

  // The carrier is let go (the piece stays where it is). Safe to call any time.
  function release(room, player) {
    if (!player.holding) return;
    const prop = room.props.find(p => p.id === player.holding.id);
    if (prop) prop.heldBy = null;
    player.holding = null;
  }

  // Can this player (standing at pos) carry the piece along? Used for every step of a walk.
  function carryFits(room, prop, player, pos) {
    const c = { x: pos.x + player.holding.dx, y: pos.y + player.holding.dy };
    if (c.x < ZONE_START || c.x >= COLS || c.y < 0 || c.y >= ROWS) return false;
    if (c.x === pos.x && c.y === pos.y) return false;
    if (deps.occupied(room, c.x, c.y, player.id, prop.id)) return false;
    return !deps.reservedCells(room, player.id).has(c.y * COLS + c.x);
  }

  return { spawnShop, place, DROP, inDrop, spotError, generateWall, generateAll, release, carryFits, MAX_STRUCTURES };
}

module.exports = { create, propAt, propView, groupInfo, MAX_STRUCTURES };