// Heart Grid - card data shared by the server (require) and the browser (<script>).
// ONE place for: which cards exist, what they cost, how far they reach, how they are aimed, and every card text.
// Change a number here and the server rules, the drag range preview, the hand costs and the card texts all follow.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HGCards = factory();
})(typeof self !== "undefined" ? self : this, function () {

  const A = "/assets/cards/";
  const ARMOR_ICON = "/assets/classes/general/armor.png";
  const ARMOR_PUNISH = 1.5;          // Energy a player loses for every Armored cell their pattern damages
  const FOLDER = { "hp-grid": "hp-grid/", "charge-based": "charge-based/", "unique-type": "unique-type/", "turn-based": "turn-based/", "battlefield-grid": "battlefield-grid/" };

  /*
    group     asset folder + the label shown on the card ("HP-Grid", "Charge", "Unique", "Turn-based")
    kind      grid    = aim the card's pattern at an HP Grid
              random  = pick a target, cells are chosen randomly (no aiming)
              pick    = pick a teammate
              charge  = adds charges to yourself
              aura    = Hex
              stub    = not playable yet (the png is in the game, the rules come later)
    side      who it can be used on: enemy (Monsters + Walls) | monster (Monsters only) | structure (Walls only) | ally | self | (none)
    costPer   Energy per position (0.5 steps are fine)
    rangePer  undefined = positions - 1 cells outward;  a number = positions x that number;  noRange = never needs range
    allowSelf an ally card that may also be used on yourself (Heal)
    multi     most targets at once (Blast = 2)
  */
  const CARDS = {
    attack:    { name: "Attack",    group: "hp-grid",      kind: "grid",   side: "enemy", costPer: 1 },
    blast:     { name: "Blast",     group: "hp-grid",      kind: "grid",   side: "enemy", costPer: 1.5, rangePer: 3, multi: 2 },
    curse:     { name: "Curse",     group: "hp-grid",      kind: "grid",   side: "enemy", costPer: 1.5 },
    execute:   { name: "Execute",   group: "unique-type",  kind: "random", side: "enemy", costPer: 1.5 },
    heal:      { name: "Heal",      group: "hp-grid",      kind: "grid",   side: "ally",  costPer: 1, allowSelf: true },
    guard:     { name: "Guard",     group: "hp-grid",      kind: "grid",   side: "ally",  costPer: 1 },
    buff:      { name: "Buff",      group: "unique-type",  kind: "pick",   side: "ally",  costPer: 1, give: 1.5 },
    retaliate: { name: "Retaliate", group: "hp-grid",      kind: "grid",   side: "self",  costPer: 1, noRange: true },
    rage:      { name: "Rage",      group: "hp-grid",      kind: "grid",   side: "self",  costPer: 0, noRange: true, perCell: 2 },
    taunt:     { name: "Taunt",     group: "charge-based", kind: "charge", side: "self",  costPer: 1, noRange: true },
    lifesteal: { name: "Lifesteal", group: "charge-based", kind: "charge", side: "self",  costPer: 1, noRange: true },
    poison:    { name: "Poison",    group: "charge-based", kind: "charge", side: "self",  costPer: 0.5, noRange: true },
    hex:       { name: "Hex",       group: "unique-type",  kind: "aura",   side: "self",  costPer: 1, noRange: true, discount: 2 },
    // Placeholders until encounters, initiative and dice exist: only the png is in the game.
    counter:   { name: "Counter",   group: "turn-based",   kind: "turn",   side: "self",  costPer: 1, noRange: true },
    weaken:    { name: "Weaken",    group: "charge-based", kind: "stub" },
    shield:    { name: "Shield",    group: "turn-based",   kind: "pick",   side: "ally",  costPer: 2.5, rangeFixed: 1, turns: true },
    penetrate: { name: "Penetrate", group: "charge-based", kind: "charge", side: "self",  costPer: 1, noRange: true },
    spellvamp: { name: "Spellvamp", group: "hp-grid",      kind: "grid",   side: "enemy", costPer: 1.5 },
    // ---- Tank
    presence:  { name: "Presence",  group: "turn-based",   kind: "turn",   side: "self",  costPer: 1, noRange: true },
    hold:      { name: "Hold",      group: "turn-based",   kind: "pick",   side: "monster", costPer: 1, turns: true, fixedTurns: 2 },
    // ---- Warrior
    trail:     { name: "Trail",     group: "battlefield-grid", kind: "field", side: "self", costPer: 1, rangePer: 2, maintenance: 1, marks: "trail" },
    breach:    { name: "Breach",    group: "hp-grid",      kind: "grid",   side: "enemy", costPer: 1.5, breach: true },
    // ---- Support
    repair:    { name: "Repair",    group: "hp-grid",      kind: "grid",   side: "structure", costPer: 1 },
    move:      { name: "Move",      group: "unique-type",  kind: "move",   side: "ally",  costPer: 1 },
    // ---- Rogue
    smoke:     { name: "Smoke",     group: "battlefield-grid", kind: "field", side: "self", costPer: 1, rangePer: 2, maintenance: 1, marks: "smoke" },
    clone:     { name: "Clone",     group: "unique-type",  kind: "clone",  side: "self",  costPer: 1, rangePer: 2 },
    // ---- Mage
    force:     { name: "Force",     group: "battlefield-grid", kind: "displace", side: "self", costPer: 1, rangePer: 2, dir: "push" },
    gravity:   { name: "Gravity",   group: "battlefield-grid", kind: "displace", side: "self", costPer: 1, rangePer: 2, dir: "pull", noCenter: true }
  };

  const GROUP_LABEL = { "hp-grid": "HP-Grid card", "charge-based": "Charge-based card", "unique-type": "Unique card", "turn-based": "Turn-based card", "battlefield-grid": "Battlefield-Grid card" };

  // Which cards each class can be issued.
  const CLASS_CARDS = {
    Tank:    ["attack", "guard", "retaliate", "taunt", "presence", "hold"],
    Warrior: ["attack", "rage", "counter", "execute", "trail", "breach"],
    Support: ["heal", "buff", "weaken", "shield", "repair", "move"],
    Mage:    ["blast", "spellvamp", "curse", "hex", "force", "gravity"],
    Rogue:   ["attack", "poison", "lifesteal", "penetrate", "smoke", "clone"]
  };

  // Hover text = the simple version. Detail = the long version in the card dialog.
  const TEXT = {
    attack:    { tip: "Damages the HP-Grid cells of a Monster in your pattern.", detail: "Aim your pattern on a Monster's HP Grid. Every healthy cell it covers becomes empty, and every Over-heal cell becomes a plain healthy cell. An Armored cell can be hit, but it punishes you: you lose 1.5 Energy for every Armored cell your pattern damages." },
    blast:     { tip: "A long-range Attack that hits up to two Monsters at once.", detail: "Works like Attack, but you can aim it at two Monsters in one go. With only one Monster in range it hits that one Monster once. Costs more per position, but reaches three cells per position." },
    curse:     { tip: "Marks Monster cells. When a marked cell is damaged it explodes onto its neighbors.", detail: "Does nothing by itself. When any damage touches a cursed cell, it explodes and damages the cells above, below and beside it. A curse that hits another curse chains the explosion. Armored cells are not damaged by the explosion." },
    execute:   { tip: "Damages random healthy cells of a Monster, no aiming.", detail: "Pick a Monster. The card removes one randomly chosen healthy or Over-heal cell per position, wherever they are on its HP Grid. Armored cells are skipped." },
    heal:      { tip: "Empty cells become healthy, healthy cells become Over-heal.", detail: "Aim your pattern on a teammate's HP Grid. An empty cell comes back as a healthy cell. A healthy cell becomes an Over-heal cell (a deep blue square). Over-heal cannot stack." },
    guard:     { tip: "Marks teammates' cells. A hit on a marked cell hurts the Tank instead.", detail: "Aim your pattern on a teammate's HP Grid. The Host cannot see Guard marks. When a Monster hits a guarded cell the teammate is spared and a random healthy or Over-heal cell of the Tank takes the hit. Over-heal on the marked cell absorbs the hit first." },
    buff:      { tip: "Gives a teammate more Energy than it costs you.", detail: "Pick a teammate in range. They gain 1.5 Energy for every position, and you pay 1 Energy per position." },
    retaliate: { tip: "Marks your own cells. Each marked cell that is hit hits the attacker back.", detail: "Aim your pattern on your own HP Grid. Every marked cell that a Monster damages deals 1 damage back to that Monster, like a landmine. Hits redirected by Guard count too." },
    rage:      { tip: "Sacrifice your own cells for Energy.", detail: "Aim your pattern on your own HP Grid. Every healthy or Over-heal cell it covers is sacrificed and gives you 2 Energy. Rage costs nothing and has no range. More positions only means more cells at once." },
    taunt:     { tip: "Forces Monsters that can reach you to target you.", detail: "Gives you Taunt charges (one per position). While you have charges, a Monster that can reach you must target you with whatever it does. Each damage it deals to you uses up 1 charge. A Monster that cannot reach you cannot see you." },
    lifesteal: { tip: "Successful hits heal your empty cells.", detail: "Gives you Lifesteal charges (one per position). Every cell your Attack damages uses 1 charge and heals one of your empty cells. It never creates Over-heal." },
    poison:    { tip: "Your Attacks also eat a random cell with acid.", detail: "Gives you Poison charges (one per position). Every Attack you use spends 1 charge and damages a random healthy or Over-heal cell of the Monster for a random 1 up to the card's positions. Poison cannot damage Armored cells by itself. It hits healthy cells first, and only when nothing else is left do your Penetrate charges strip an Armored cell for it (1 charge = 1 damage)." },
    hex:       { tip: "Anyone standing in a 3x3 around you pays 2 less Energy per card.", detail: "Creates an aura on a 3x3 centered on the Mage. Anyone inside pays 2 less Energy for their cards (never below 0.5). The Mage is always affected, except for Hex cards." },
    counter:   { tip: "Hit back: a bonus action after a Monster damages you.", detail: "A self card. Every position is 1 round of Counter. While it lasts, if a Monster damages you even once, you get a bonus action right after that Monster's turn, and you gain +6 Energy for it. It doesn't matter how far the Monster is." },
    weaken:    { tip: "Reduce the Monster's next damage. (Coming soon)", detail: "Coming soon. Weaken needs the dice system first." },
    shield:    { tip: "Makes a teammate untargetable for a few rounds.", detail: "Pick one teammate in the 3x3 around you. Every position is 1 round of Shield: the Host cannot select that player to attack or debuff. When it ends they enter Shield Break, which lasts 3 rounds longer than the Shield did (a 3 round Shield means 6 rounds of Break) and stops you from shielding them again. You can only shield 1 player at a time." },
    penetrate: { tip: "Your Attacks are not punished by Armor, and they strip it.", detail: "Gives you Penetrate charges (one per position). When your Attack damages an Armored cell, 1 charge keeps Armor from punishing you. After your Attack, every charge you have left removes the Armor of a random Armored cell, however far it is. With Poison, the charges let it hit Armored cells when it has nothing else to hit." },
    spellvamp: { tip: "Strips Armor and Over-heal from Monster cells and charges you.", detail: "Aim your pattern on a Monster's HP Grid. Every Armored cell and every Over-heal cell it touches gives you 1 Spellvamp charge (a cell with both gives 2) and loses that layer. It deals no damage, and Armor can't punish it. Your Blast spends a charge per damaged cell to heal you: an empty cell becomes healthy, or a healthy cell becomes Over-heal." }
  };

  Object.assign(TEXT, {
    presence: { tip: "Shrinks every Monster's Range to a 3x3 and makes the Tank impossible to miss.", detail: "Turn-based: every position is 1 round. While it lasts, every Monster's Range becomes a 3x3 with the Monster in the center, and the Tank gets a 7x7 Class Range. Any other player who steps into that 7x7 can be seen and targeted by Monsters, so the party has to keep away from the Tank or risk getting harmed. However far away the Tank is, Monsters can always see him. A Shielded Tank is untargetable, but the vision part of Presence stays active. Smoke still hides everyone but the Tank." },
    hold:     { tip: "Pins a Monster to the ground: it can't move for 2 rounds, but it can still attack.", detail: "Pick one Monster in range (Walls can't be held). For 2 rounds it can't move on its own, but it can still attack. Displacement cards and effects still move it." },
    trail:    { tip: "Marks cells where you and your Support move for free. Only you two can see it.", detail: "Click a cell of the battlefield in range: your pattern is placed around it as Trail. Only the Warrior and the Support can see the Trail, never the Host or the other classes. Moving onto a Trail cell is free (the Support's too, and when he uses Move on a teammate, the Trail cells count). Deploying costs 1 Energy per position and the upkeep is 1 Energy at the start of each of your turns. Using the card again removes the Trail for free. At 0 Energy the Trail stays and you go below 0: no cards and no moving until you remove it." },
    breach:   { tip: "A multi-hit Attack that only really hurts Walls and other structures.", detail: "Aim your pattern on a Wall: every cell it covers is damaged. Against a Monster it only hits once, however many cells the pattern covers. Walls count the same whether the Host or a player built them, because structures are neutral. Structures in the Class Area are immune, to avoid trolling. Armored Monster cells still punish you like they do for Attack." },
    repair:   { tip: "Heal for Walls and other structures.", detail: "Aim your pattern on a Wall's HP Grid. An empty cell comes back as a healthy cell, and a healthy cell becomes Over-heal. It works on structures only: never on Monsters or teammates." },
    move:     { tip: "Forces a teammate to move to a cell of THEIR movement pattern. You pay for everything.", detail: "Pick a teammate in range, then a cell from their own movement pattern. You pay the card's cost first and then the movement's Energy (Trail cells are free). All of the Energy comes from the Support. They can't jump over anything, and can't cross the Fog border." },
    smoke:    { tip: "Fills part of the battlefield with smoke that hides players from Monsters.", detail: "Click a cell of the battlefield within range: your pattern is placed around it as smoke. The Host can't see the smoke, only the players can. A player standing in smoke can't be seen or targeted: even if a Monster's Range touches them, it finds no players in range. When a Monster steps into that smoke, everyone inside it is revealed, and they hide again when it leaves. The Tank is never hidden by smoke, but it still works for the others (great with Presence). Deploying costs 1 Energy per position and the smoke costs 1 Energy at the start of each of your turns. Using the card again removes your smoke for free. If your Energy goes below 0 the smoke stays, but you can't use any card or move until you remove it." },
    clone:    { tip: "A fake Rogue: gives you vision and fakes attacks. Monsters and the Host can't see it.", detail: "Click a cell in range to place your Clone (1 at a time). It gives you its own Class Range vision, which reveals Monsters to the party. Once per turn the Clone can move with your movement pattern (free), and once per turn it can fake an attack: the players see the animation, the Host and the Monsters see an empty cell and nothing happens. It never takes a turn of its own and it can't be targeted. It disappears when you die or when you use the card again (free)." },
    force:    { tip: "Pushes Monsters 1 cell away from the center of your pattern.", detail: "Click a cell in range: every Monster touching your pattern is pushed 1 cell directly away from that center (a Monster on the center is pushed away from you). If something is in the way (a Monster, player or Wall) or the Monster is at the edge or the Fog border, that Monster doesn't move. Held Monsters are still pushed." },
    gravity:  { tip: "Pulls Monsters 1 cell toward the center of your pattern.", detail: "The only card that doesn't allow the center cell of its pattern. Click a cell in range: every Monster touching your pattern is pulled 1 cell toward that center. Great with traps: a trap meant for 1 Monster can now catch every Monster pulled onto it. If something is in the way, that Monster doesn't move. Held Monsters are still pulled." },
  });

  // A card picture is looked for in its own folder first, then in every other card folder (battlefield-grid first), then directly in /assets/cards/.
  // Returns the list of places to try, in order. Anything that isn't a card picture comes back as is.
  function iconChain(src) {
    const m = /^\/assets\/cards\/(?:([^/]+)\/)?([^/]+\.png)$/.exec(src || "");
    if (!m) return [src];
    const own = m[1], file = m[2];
    const folders = ["battlefield-grid", ...Object.values(FOLDER).map(f => f.replace("/", ""))].filter((f, i, a) => a.indexOf(f) === i && f !== own);
    return [src, ...folders.map(f => A + f + "/" + file), A + file].filter((s, i, a) => a.indexOf(s) === i);
  }

  const SHIELD_BREAK_ICON = A + "turn-based/shield_break.png";
  for (const [type, c] of Object.entries(CARDS)) {
    c.type = type;
    c.icon = A + FOLDER[c.group] + type + ".png";
    c.tip = TEXT[type].tip;
    c.detail = TEXT[type].detail;
    c.text = c.tip;
    c.playable = c.kind !== "stub";
    c.aim = c.kind === "field" || c.kind === "displace" || c.kind === "clone" ? "field" : c.kind === "move" ? "move" : c.kind === "grid" ? "pattern" : c.kind === "random" ? "random" : c.kind === "pick" ? "pick" : "none";
    c.turnBased = c.group === "turn-based";
  }

  /* ---------- numbers ---------- */

  const baseCost = (type, positions) => (CARDS[type].costPer || 0) * positions;

  // Hex: -2 Energy, never below 0.5. Free cards (Rage) stay free.
  function discountedCost(type, positions) {
    const base = baseCost(type, positions);
    if (base <= 0) return 0;
    return Math.max(0.5, base - (CARDS.hex.discount || 2));
  }

  // Cells outward from you. null = the card doesn't need range (self cards, charge cards, Hex).
  function rangeOf(type, positions) {
    const c = CARDS[type];
    if (!c || c.noRange || c.kind === "stub") return null;
    if (c.rangeFixed) return c.rangeFixed;
    return c.rangePer ? positions * c.rangePer : positions - 1;
  }

  /* ---------- geometry ---------- */

  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

  // Distance (in cells) from a player to a player or to the nearest cell of a monster's body.
  function distTo(from, e) {
    const w = e.w || 1, h = e.h || 1;
    const dx = Math.max(e.x - from.x, 0, from.x - (e.x + w - 1));
    const dy = Math.max(e.y - from.y, 0, from.y - (e.y + h - 1));
    return Math.max(dx, dy);
  }

  // Moving never jumps: there has to be a path of single steps (up, down, sideways or diagonal), as many steps as the distance,
  // that touches no blocked cell on the way. The destination itself is not checked here. blocked(x, y) -> true if something stands there.
  function pathClear(from, to, blocked) {
    const bad = new Set();
    const go = (x, y) => {
      const d = cheb(x, y, to.x, to.y);
      if (d <= 1) return true;
      const k = x + "," + y;
      if (bad.has(k)) return false;
      for (let sx = -1; sx <= 1; sx++) for (let sy = -1; sy <= 1; sy++) {
        if (!sx && !sy) continue;
        const nx = x + sx, ny = y + sy;
        if (cheb(nx, ny, to.x, to.y) !== d - 1 || blocked(nx, ny)) continue;
        if (go(nx, ny)) return true;
      }
      bad.add(k);
      return false;
    };
    return go(from.x, from.y);
  }

  const alivePlayer = p => p.inEncounter && !p.dead;
  const aliveMonster = m => m.hp.some(v => v > 0);

  // arena = { players: [], monsters: [], training: bool }
  // Everything the card could be used on from where you stand right now.
  function candidates(arena, actor, type, positions) {
    const c = CARDS[type];
    if (!c || c.kind === "stub") return [];
    if (c.side === "self" || !c.side) return [actor];
    const range = rangeOf(type, positions);
    let list;
    const walls = (arena.structures || []).filter(aliveMonster);
    if (c.side === "enemy") list = arena.monsters.filter(aliveMonster).concat(c.breach && arena.zoneStart != null ? walls.filter(s => s.x < arena.zoneStart) : walls);   // Walls are targets too (Breach: never the Class Area's)
    else if (c.side === "monster") list = arena.monsters.filter(aliveMonster);
    else if (c.side === "structure") list = walls.filter(s => arena.zoneStart == null || s.x < arena.zoneStart);
    else list = arena.players.filter(p => alivePlayer(p) && (p.id !== actor.id || arena.training || c.allowSelf));
    return list.filter(e => distTo(actor, e) <= range);
  }

  // Pattern cells (indices 0-8 of the 3x3 card) placed on an n x n grid with the card's center on `cursor`.
  // Returns the grid indices, or null if any cell would be off the grid.
  // clip = true (Walls, whose 2x2 grid is smaller than most patterns): cells that fall off the grid are ignored, and at least one must land on it.
  function aimCells(pattern, cursor, n, clip) {
    if (!cursor || !Number.isInteger(cursor.x) || !Number.isInteger(cursor.y)) return null;
    const out = [];
    for (const i of pattern) {
      const x = cursor.x + (i % 3) - 1, y = cursor.y + Math.floor(i / 3) - 1;
      if (x < 0 || y < 0 || x >= n || y >= n) { if (clip) continue; return null; }
      out.push(y * n + x);
    }
    return out.length ? out : null;
  }

  // Keep the whole pattern inside the grid: move the cursor to the nearest spot where it fits.
  function clampCursor(pattern, cursor, n, clip) {
    if (clip) return { x: Math.max(0, Math.min(n - 1, cursor.x)), y: Math.max(0, Math.min(n - 1, cursor.y)) };
    let minX = 0, maxX = 0, minY = 0, maxY = 0;
    for (const i of pattern) {
      const ox = (i % 3) - 1, oy = Math.floor(i / 3) - 1;
      minX = Math.min(minX, ox); maxX = Math.max(maxX, ox); minY = Math.min(minY, oy); maxY = Math.max(maxY, oy);
    }
    return {
      x: Math.max(-minX, Math.min(n - 1 - maxX, cursor.x)),
      y: Math.max(-minY, Math.min(n - 1 - maxY, cursor.y))
    };
  }

  return { iconChain, CARDS, CLASS_CARDS, GROUP_LABEL, ARMOR_ICON, ARMOR_PUNISH, SHIELD_BREAK_ICON, baseCost, discountedCost, rangeOf, cheb, distTo, alivePlayer, aliveMonster, candidates, aimCells, clampCursor, pathClear };
});
