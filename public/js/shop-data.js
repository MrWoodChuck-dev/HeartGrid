// Heart Grid - Shop + Inventory data shared by the server (require) and the browser (<script>).
// ONE place for: the materials, the size of the Shop grid (4x2) and the Inventory grid (5x10), what an item is, how it is named / priced / drawn.
// To add a material: add an entry to MATERIALS (its picture goes in public/assets/material/, a missing file shows the "missing asset" picture).
// An item = { kind: "material" | "structure" | "card", key, amount, cost: [{ mat, n }], positions? }
//   material  key = a MATERIALS key         (goes to the player's Inventory slots, 10 per slot)
//   structure key = a structure type        (goes to the player's Inventory grid)
//   card      key = a card type, positions  (the Host's Issue Card: the player builds it in Preparation)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./card-data.js"), require("./structure-data.js"));
  else root.HGShop = factory(root.HGCards, root.HGStructures);
})(typeof self !== "undefined" ? self : this, function (HGC, HGS) {
  "use strict";

  const MATERIALS = {
    scrap:        { name: "Scrap",                 icon: "scrap.png" },
    mana:         { name: "Wood",                  icon: "wood.png" },
    construction: { name: "Construction Material", icon: "construction_material.png" },
    gold:         { name: "Gold",                  icon: "gold.png" }
  };
  const MAT_KEYS = Object.keys(MATERIALS);
  const MAT_DIR = "/assets/material/";
  const SHOP_COLS = 4, SHOP_ROWS = 2, SHOP_SLOTS = SHOP_COLS * SHOP_ROWS;       // the Host's Shop grid
  const INV_COLS = 5, INV_ROWS = 10, INV_SLOTS = INV_COLS * INV_ROWS;           // a player's Inventory grid
  const MAX_AMOUNT = 99;           // most you can put in one item / one Inventory slot
  const MAX_COST = 999;            // most of one material a requirement can ask for
  const MAT_STACK = 10;            // materials live in the Inventory slots like in Minecraft: at most 10 of one material per slot
  const MIN_POS = 2, MAX_POS = 6;  // positions on a Card item (same as Issue Card)
  const KINDS = ["material", "structure", "card"];
  const KIND_LABEL = { material: "Material", structure: "Structure", card: "Card" };
  const stackable = kind => kind === "material" || kind === "structure";        // cards are built one by one, they never stack

  const structureKeys = () => Object.keys(HGS.STRUCTURES).filter(k => !HGS.STRUCTURES[k].auto);   // the Shop itself can't be sold
  const classesOf = key => Object.keys(HGC.CLASS_CARDS).filter(c => HGC.CLASS_CARDS[c].includes(key));
  const cardKeys = () => [...new Set(Object.values(HGC.CLASS_CARDS).flat())].filter(k => HGC.CARDS[k] && HGC.CARDS[k].kind !== "stub");
  const canUseCard = (className, key) => !!HGC.CLASS_CARDS[className] && HGC.CLASS_CARDS[className].includes(key);

  // Checks (and cleans) an item the Host made. Returns { item } or { error }.
  function clean(raw) {
    if (!raw || typeof raw !== "object") return { error: "That item is not valid." };
    const kind = raw.kind, key = String(raw.key || "");
    if (!KINDS.includes(kind)) return { error: "Pick Material, Structure or Card." };
    if (kind === "material" && !MATERIALS[key]) return { error: "Unknown material." };
    if (kind === "structure" && !structureKeys().includes(key)) return { error: "Unknown structure." };
    if (kind === "card" && !cardKeys().includes(key)) return { error: "Unknown card." };
    const item = { kind, key, amount: 1, cost: [] };
    if (stackable(kind)) {
      if (!Number.isInteger(raw.amount) || raw.amount < 1 || raw.amount > MAX_AMOUNT) return { error: `Amount must be a whole number from 1 to ${MAX_AMOUNT}.` };
      item.amount = raw.amount;
    }
    if (kind === "card") {
      if (!Number.isInteger(raw.positions) || raw.positions < MIN_POS || raw.positions > MAX_POS) return { error: `A card has ${MIN_POS} to ${MAX_POS} positions.` };
      item.positions = raw.positions;
    }
    const seen = new Set();
    for (const c of Array.isArray(raw.cost) ? raw.cost : []) {
      if (!c || !MATERIALS[c.mat]) return { error: "A requirement uses an unknown material." };
      if (seen.has(c.mat)) return { error: `${MATERIALS[c.mat].name} is listed twice in the requirements.` };
      if (!Number.isInteger(c.n) || c.n < 1 || c.n > MAX_COST) return { error: `A requirement must be a whole number from 1 to ${MAX_COST}.` };
      seen.add(c.mat);
      item.cost.push({ mat: c.mat, n: c.n });
    }
    return { item };
  }

  const costText = cost => (cost && cost.length) ? cost.map(c => `${c.n} ${MATERIALS[c.mat].name}`).join(" + ") : "Free";
  const itemName = item => item.kind === "material" ? MATERIALS[item.key].name
    : item.kind === "structure" ? HGS.STRUCTURES[item.key].name
    : `${HGC.CARDS[item.key].name} Card`;
  const itemLabel = item => item.amount > 1 ? `${itemName(item)} ×${item.amount}` : itemName(item);
  const itemInfo = item => {
    if (item.kind === "material") return "A building block. On its own it does nothing, it is used to buy and build things.";
    if (item.kind === "structure") return `${HGS.STRUCTURES[item.key].note} Goes to your Inventory.`;
    const who = classesOf(item.key).join(", ");
    return `${HGC.GROUP_LABEL[HGC.CARDS[item.key].group] || "Card"} with ${item.positions} positions. Usable by: ${who}. You build its pattern in Preparation.`;
  };
  // Pictures to try, in order (the browser falls back to the "missing asset" picture after the last one).
  function iconChain(item) {
    if (item.kind === "material") return [MAT_DIR + MATERIALS[item.key].icon];
    if (item.kind === "structure") {
      const def = HGS.STRUCTURES[item.key];
      return [HGS.iconUrl(def.pieces[0].icon), `/assets/${item.key === "wall_gen" ? "wall_generator" : item.key === "crafting" ? "crafting_table" : item.key}.png`];
    }
    return HGC.iconChain(HGC.CARDS[item.key].icon);
  }
  const matIcon = mat => MAT_DIR + MATERIALS[mat].icon;

  // Inventory helpers. The grid holds materials (10 per slot) and structures (up to MAX_AMOUNT per slot).
  const stackMax = kind => kind === "material" ? MAT_STACK : MAX_AMOUNT;
  const inventoryRoom = (inv, kind, key) => { const m = stackMax(kind); return inv.reduce((n, s) => n + (!s ? m : (s.kind === kind && s.key === key ? Math.max(0, m - s.amount) : 0)), 0); };
  function inventoryAdd(inv, kind, key, amount) {
    const m = stackMax(kind);
    let left = amount;
    for (const s of inv) if (left && s && s.kind === kind && s.key === key && s.amount < m) { const t = Math.min(left, m - s.amount); s.amount += t; left -= t; }
    for (let i = 0; i < inv.length && left; i++) if (!inv[i]) { const t = Math.min(left, m); inv[i] = { kind, key, amount: t }; left -= t; }
    return left === 0;
  }
  // How much of a material the Inventory holds (every stack added up), and taking some out (emptied slots become free).
  const materialCount = (inv, mat) => inv.reduce((n, s) => n + (s && s.kind === "material" && s.key === mat ? s.amount : 0), 0);
  const materialTotals = inv => Object.fromEntries(MAT_KEYS.map(k => [k, materialCount(inv, k)]));
  function inventoryTake(inv, mat, amount) {
    let left = amount;
    for (let i = inv.length - 1; i >= 0 && left > 0; i--) {
      const s = inv[i];
      if (!s || s.kind !== "material" || s.key !== mat) continue;
      const t = Math.min(left, s.amount);
      s.amount -= t; left -= t;
      if (!s.amount) inv[i] = null;
    }
    return left === 0;
  }

  return { MATERIALS, MAT_KEYS, MAT_DIR, SHOP_COLS, SHOP_ROWS, SHOP_SLOTS, INV_COLS, INV_ROWS, INV_SLOTS, MAX_AMOUNT, MAX_COST, MAT_STACK, MIN_POS, MAX_POS,
    KINDS, KIND_LABEL, stackable, structureKeys, cardKeys, classesOf, canUseCard, clean, costText, itemName, itemLabel, itemInfo, iconChain, matIcon, stackMax, inventoryRoom, inventoryAdd, materialCount, materialTotals, inventoryTake };
});
