"use strict";
const assert = require("assert");
const HGS = require("../public/js/structure-data.js");
const S = require("../structures.js");
const COLS = 20, ROWS = 12, ZONE_START = 14;
const mk = () => ({ props: [], propSeq: 0, groupSeq: 0, structures: [], players: new Map(), monsters: [], encNo: 0, strSeq: 0 });
const occupied = (r, x, y, a, b) => [...r.players.values()].some(p => p.id !== a && p.x === x && p.y === y) || r.structures.some(s => s.x === x && s.y === y) || S.propAt(r, x, y, a, b);
const B = S.create({ COLS, ROWS, ZONE_START, occupied, reservedCells: () => new Set(), newWall: (r, x, y) => r.structures.push({ x, y }) });

// shapes, names, pictures
assert.deepStrictEqual(HGS.shapeCells("wall_gen", 5, 5, 1), [{ x: 5, y: 5 }, { x: 5, y: 6 }]);
assert.strictEqual(HGS.shapeCells("crafting", 5, 5, 0).length, 3);
assert.strictEqual(HGS.cellName(10, 0), "11A");
assert.strictEqual(HGS.iconOf({ type: "wall_gen", piece: 1 }), "wall_output.png");
assert.strictEqual(HGS.labelOf({ type: "wall_gen", piece: 1 }), "Wall Generator · Output");

// every room starts with the Shop: 4 pieces in the Dropship Area, working while connected in ANY arrangement
const r = mk();
B.spawnShop(r);
assert.strictEqual(r.props.length, 4);
assert.ok(S.groupInfo(r, r.props[0].group).ok);
const g = r.props[0].group;
r.props[3].x = 16; r.props[3].y = 8;                                        // one piece wandered off
assert.ok(!S.groupInfo(r, g).ok);
assert.strictEqual(S.groupInfo(r, g).linked, 3);
r.props.forEach((p, i) => { p.x = 14 + i; p.y = 3; });                      // a 1x4 line is fine too
assert.ok(S.groupInfo(r, g).ok);
r.props.splice(0, r.props.length);

// the Host places a structure only inside the Dropship Area (all pieces)
assert.ok(B.place(r, "wall_gen", 17, 10, 0));                                 // 17 is outside
assert.ok(B.place(r, "wall_gen", 19, 10, 0));                                 // 2nd piece would leave the 2x2
assert.strictEqual(B.place(r, "wall_gen", 18, 10, 0), "");
assert.strictEqual(r.props.length, 2);
assert.ok(B.place(r, "quest", 18, 10, 0));                                    // occupied
assert.ok(B.place(r, "shop", 18, 10, 0));                                     // the Shop can't be added
const gen = r.props.filter(p => p.type === "wall_gen");

// players: Class Area, not on the Dropship Area, within 2 cells; pieces carry along
const me = { id: "a", x: 16, y: 8, className: "Tank" };
r.players.set("a", me);
const piece = { ...gen[0] };
assert.ok(B.spotError(r, { ...piece, x: 19, y: 11 }, "player", me, true));    // Dropship Area
assert.strictEqual(B.spotError(r, { ...piece, x: 17, y: 7 }, "player", me, true), null);
assert.ok(B.spotError(r, { ...piece, x: 12, y: 8 }, "player", me, true));      // not the Class Area
assert.ok(B.spotError(r, { ...piece, x: 19, y: 8 }, "player", me, true));      // farther than 2 cells
assert.ok(HGS.touches({ x: 17, y: 8 }, 16, 8) && !HGS.touches({ x: 17, y: 9 }, 16, 8));
me.holding = { id: gen[0].id, dx: 2, dy: 2 }; gen[0].heldBy = "a";
assert.ok(B.carryFits(r, gen[0], me, { x: 16, y: 8 }));
assert.ok(!B.carryFits(r, gen[0], me, { x: 18, y: 10 }));                      // would be off the board
B.release(r, me); assert.strictEqual(gen[0].heldBy, null); assert.strictEqual(me.holding, null);

// Wall Generator: Generator + Output connected, 1 Wall per encounter on the Output, never on top of another Wall
assert.strictEqual(B.generateWall(r, gen[0]), "");
assert.deepStrictEqual(r.structures, [{ x: gen[1].x, y: gen[1].y }]);
assert.ok(B.generateWall(r, gen[0]));                                          // already made this encounter
r.encNo = 1;
assert.ok(B.generateWall(r, gen[0]));                                          // the old Wall is still on the Output
r.structures.length = 0;
gen[1].x = 19; gen[1].y = 8;                                                    // Output pulled away: not connected -> not working
assert.ok(/isn't working/.test(B.generateWall(r, gen[0])));
gen[1].x = gen[0].x + 1; gen[1].y = gen[0].y;
assert.strictEqual(B.generateWall(r, gen[0]), "");
console.log("structures ok");
