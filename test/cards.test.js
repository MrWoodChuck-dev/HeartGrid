const assert = require("assert");
const C = require("../cards.js");
const { HG } = C;

let seq = 0;
C.setRng(() => { seq = (seq * 7 + 3) % 10; return seq / 10; });

function player(className, n, x, y, cards, extra = {}) {
  const p = { id: className, username: className, className, x, y, energy: 10, cap: 10, inEncounter: true, dead: false, cards, ...extra };
  C.initPlayer(p, n);
  return p;
}
const card = (type, pattern, name) => ({ type, name: name || type, pattern });
const arena = (players, monsters, training = false) => ({ training, cols: 20, rows: 12, players, monsters, hex: new Set() });
const dummy = (x, y) => C.makeMonster({ id: "d", name: "Dummy", x, y, n: 7 });
const empties = e => e.hp.filter(v => v === 0).length;

// --- range: 2 positions = 1 cell outward
{
  const w = player("Warrior", 5, 5, 5, [card("attack", [4, 5])]);
  const d = dummy(3, 5);                       // 2 cells away
  const a = arena([w], [d]);
  assert.strictEqual(HG.rangeOf("attack", 2), 1);
  assert.strictEqual(HG.rangeOf("blast", 2), 6);
  assert.strictEqual(C.use(a, w, 0, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }] }).ok, false);   // too far
  w.x = 4;                                      // beside it
  const r = C.use(a, w, 0, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }] });
  assert.ok(r.ok, r.error);
  assert.strictEqual(empties(d), 2);
  assert.strictEqual(w.energy, 8);              // 2 positions = 2 energy
  console.log("range + attack ok");
}

// --- attack on overheal, pattern must stay inside the grid
{
  const w = player("Warrior", 5, 4, 5, [card("attack", [4, 5])]);
  const d = dummy(3, 5); d.hp[24] = 2;          // cell (3,3) -> overheal
  const a = arena([w], [d]);
  assert.strictEqual(C.use(a, w, 0, { targets: [{ id: "d", cursor: { x: 6, y: 6 } }] }).ok, false);  // pattern goes off the grid
  const r = C.use(a, w, 0, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }] });  // cells (3,3) and (4,3)
  assert.ok(r.ok);
  assert.strictEqual(d.hp[3 * 7 + 3], 1);       // overheal -> healthy
  assert.strictEqual(d.hp[3 * 7 + 4], 0);       // healthy -> empty
  console.log("overheal ok");
}

// --- heal: empty -> healthy -> overheal, no stacking
{
  const s = player("Support", 4, 5, 5, [card("heal", [4, 5])]);
  const t = player("Tank", 6, 5, 4, []);
  t.hp[0] = 0;
  const a = arena([s, t], []);
  const aim = { targets: [{ id: "Tank", cursor: { x: 1, y: 1 } }] };   // cells (1,1),(2,1)
  t.hp[7] = 0;                                  // (1,1) empty
  assert.ok(C.use(a, s, 0, aim).ok);
  assert.strictEqual(t.hp[7], 1); assert.strictEqual(t.hp[8], 2);
  assert.ok(C.use(a, s, 0, aim).ok);
  assert.strictEqual(t.hp[7], 2); assert.strictEqual(t.hp[8], 2);   // can't stack
  console.log("heal ok");
}

// --- guard: redirect to the Tank, overheal absorbs first, mark consumed
{
  const t = player("Tank", 6, 5, 5, [card("guard", [4, 5])]);
  const s = player("Support", 4, 5, 6, []);
  const d = dummy(0, 5);
  const a = arena([t, s], [d]);
  assert.ok(C.use(a, t, 0, { targets: [{ id: "Support", cursor: { x: 1, y: 1 } }] }).ok);
  assert.strictEqual(s.marks.guard.filter(Boolean).length, 2);
  s.hp.forEach((_, i) => { if (i !== 5 && i !== 6) s.hp[i] = 0; });         // the only cells left are the guarded ones (1,1),(2,1)
  s.hp[5] = 2;                                  // one of them is overheal
  // overheal first: hits drain the overheal, no redirect
  C.setRng(() => 0);                            // always picks the first non-empty cell = idx 5
  let r = C.monsterStrike(a, d, s);
  assert.strictEqual(s.hp[5], 1); assert.strictEqual(empties(t), 0);
  assert.ok(s.marks.guard[5]);                  // mark stays
  r = C.monsterStrike(a, d, s);                 // now healthy + guard: Tank takes it
  assert.strictEqual(s.hp[5], 1);
  assert.strictEqual(empties(t), 1);
  assert.strictEqual(s.marks.guard[5], null);   // consumed
  console.log("guard ok");
}

// --- retaliate (also through guard)
{
  const t = player("Tank", 6, 5, 5, [card("retaliate", [4, 5])]);
  const s = player("Support", 4, 5, 6, []);
  const d = dummy(0, 5);
  const a = arena([t, s], [d]);
  t.cards.push(card("guard", [4, 5]));
  assert.ok(C.use(a, t, 0, { targets: [{ cursor: { x: 0 + 1, y: 1 } }] }).ok);   // marks (0,1),(1,1)
  assert.strictEqual(t.marks.ret.filter(Boolean).length, 2);
  C.setRng(() => 0);
  t.hp.forEach((_, i) => { if (i !== 7) t.hp[i] = 0; });                         // only (1,1) idx 7 left, retaliate-marked
  C.monsterStrike(a, d, t);
  assert.strictEqual(empties(d), 1);            // 1 damage came back
  assert.strictEqual(t.marks.ret[7], 0);
  console.log("retaliate ok");
}

// --- curse chain: one go, damages above/below/beside, chains through cursed neighbors
{
  const m = player("Mage", 3, 4, 5, [card("curse", [4, 5])]);
  const d = dummy(3, 5);
  const a = arena([m], [d]);
  d.marks.curse[24] = 1;                        // (3,3)
  assert.ok(C.use(a, m, 0, { targets: [{ id: "d", cursor: { x: 4, y: 2 } }] }).ok);   // (4,2),(5,2): cells 18,19... wait y=2,x=3..4
  console.log("curse marked cells:", d.marks.curse.map((v, i) => v ? i : null).filter(v => v !== null));
  const w = player("Warrior", 5, 4, 5, [card("attack", [4, 5])]);
  const a2 = arena([w], [d]);
  d.marks.curse.fill(0); d.marks.curse[24] = 1; d.marks.curse[25] = 1;   // (3,3) & (4,3) cursed, neighbors
  const r = C.use(a2, w, 0, { targets: [{ id: "d", cursor: { x: 3, y: 1 } }] });    // attack hits (2,1),(3,1)... no curse
  assert.strictEqual(d.marks.curse[24], 1);
  const r2 = C.use(a2, w, 0, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }] });   // attack hits (2,3),(3,3)? cursor center -> (2,3),(3,3)
  const st = r2.fx.steps[0];
  assert.ok(st.changes.some(c => c.wave >= 1), "explosion waves recorded");
  assert.strictEqual(d.marks.curse[24], 0); assert.strictEqual(d.marks.curse[25], 0);   // chain consumed both
  console.log("curse chain ok, waves:", Math.max(...st.changes.map(c => c.wave || 0)));
}

// --- taunt: 1 damage = 1 charge, forces the Tank
{
  const t = player("Tank", 6, 5, 5, [card("taunt", [4, 5, 3])]);
  const s = player("Support", 4, 5, 6, []);
  const d = dummy(0, 5);
  const a = arena([t, s], [d]);
  assert.ok(C.use(a, t, 0, {}).ok);
  assert.strictEqual(t.charges.taunt, 3);
  C.monsterStrike(a, d, s);
  assert.strictEqual(empties(s), 0); assert.strictEqual(empties(t), 1); assert.strictEqual(t.charges.taunt, 2);
  d.range = 2;                                  // Tank at distance 4: the monster can't see him
  C.monsterStrike(a, d, s);
  assert.strictEqual(empties(s), 1); assert.strictEqual(t.charges.taunt, 2);
  console.log("taunt ok");
}

// --- poison + lifesteal on a Rogue attack
{
  C.setRng(() => 0.99);
  const r = player("Rogue", 3, 4, 5, [card("poison", [4, 5, 3]), card("lifesteal", [4, 5]), card("attack", [4, 5])]);
  const d = dummy(3, 5);
  const a = arena([r], [d]);
  r.energy = 20;
  assert.ok(C.use(a, r, 0, {}).ok);             // poison, 3 positions
  assert.strictEqual(r.energy, 20 - 1.5);       // 0.5 per position
  assert.ok(C.use(a, r, 1, {}).ok);
  r.hp[0] = 0; r.hp[1] = 0; r.hp[2] = 2;        // two empty cells, one overheal
  const res = C.use(a, r, 2, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }] });
  assert.ok(res.ok);
  assert.strictEqual(r.hp[0], 1); assert.strictEqual(r.hp[1], 1);        // healed both empties
  assert.strictEqual(r.hp[2], 2);                                        // never goes to overheal
  assert.strictEqual(r.charges.lifesteal, 0);
  assert.strictEqual(r.charges.poison, 2);
  assert.ok(res.fx.steps.some(s => s.anim === "poison") && res.fx.steps.some(s => s.anim === "lifesteal"));
  const poison = res.fx.steps.find(s => s.anim === "poison");
  assert.ok(poison.changes.length >= 1 && poison.changes.length <= 3);   // max damage = positions
  console.log("poison/lifesteal ok");
}

// --- hex: -2, min 0.5, mage always affected except Hex, rage stays free, aura is 3x3
{
  const m = player("Mage", 3, 10, 5, [card("hex", [4, 5]), card("blast", [4, 5, 3])]);
  const w = player("Warrior", 5, 11, 6, [card("attack", [4, 5, 6])]);
  const far = player("Tank", 6, 13, 5, [card("attack", [4, 5])]);
  const a = arena([m, w, far], []);
  assert.strictEqual(C.costFor(a, w, "attack", 3), 3);
  assert.ok(C.use(a, m, 0, {}).ok);
  assert.strictEqual(C.costFor(a, w, "attack", 3), 1);          // 3 - 2
  assert.strictEqual(C.costFor(a, w, "attack", 2), 0.5);        // min 0.5
  assert.strictEqual(C.costFor(a, far, "attack", 3), 3);        // outside the 3x3
  assert.strictEqual(C.costFor(a, m, "blast", 3), 2.5);         // 4.5 - 2, Mage affected
  assert.strictEqual(C.costFor(a, m, "hex", 2), 2);             // Hex cards are not discounted
  assert.strictEqual(C.costFor(a, w, "rage", 3), 0);
  assert.strictEqual(C.use(a, m, 0, {}).ok, false);             // already active
  console.log("hex ok");
}

// --- rage / buff / execute / blast energy
{
  const w = player("Warrior", 5, 4, 5, [card("rage", [0, 1, 4]), card("execute", [4, 5])]);
  const d = dummy(3, 5);
  const a = arena([w], [d]);
  w.energy = 0;
  assert.ok(C.use(a, w, 0, { targets: [{ cursor: { x: 1, y: 1 } }] }).ok);
  assert.strictEqual(w.energy, 6);              // 3 cells x 2
  assert.strictEqual(empties(w), 3);
  assert.ok(C.use(a, w, 1, { targets: [{ id: "d" }] }).ok);
  assert.strictEqual(empties(d), 2);            // 1 damage per position
  assert.strictEqual(w.energy, 6 - 3);          // 1.5 per position
  const m = player("Mage", 3, 6, 5, [card("blast", [4, 5])]);
  const d1 = dummy(1, 5), d2 = C.makeMonster({ id: "e", name: "E", x: 2, y: 6, n: 7 });
  const b = arena([m], [d1, d2]);
  const res = C.use(b, m, 0, { targets: [{ id: "d", cursor: { x: 3, y: 3 } }, { id: "e", cursor: { x: 3, y: 3 } }] });
  assert.ok(res.ok); assert.strictEqual(empties(d1), 2); assert.strictEqual(empties(d2), 2);
  assert.strictEqual(m.energy, 10 - 3);         // 1.5 x 2
  assert.strictEqual(C.use(b, m, 0, { targets: [{ id: "d" }, { id: "e" }, { id: "x" }] }).ok, false);
  console.log("rage/execute/blast ok");
}

// --- host never sees guard
{
  const t = player("Tank", 6, 5, 5, [card("guard", [4, 5])]);
  const a = arena([t], [dummy(0, 5)], true);
  const r = C.use(a, t, 0, { targets: [{ id: "Tank", cursor: { x: 1, y: 1 } }] });
  assert.ok(r.ok);
  assert.strictEqual(C.hostView(r.fx).steps.length, 0);
  assert.strictEqual(t.energy, 10);             // training never costs energy
  console.log("host view + training free ok");
}
console.log("ALL OK");
