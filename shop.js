// Heart Grid - Shop engine (server side), the counterpart of cards.js / structures.js.
// Names, sizes, materials and item checks live in public/js/shop-data.js so the browser shows what the server enforces.
//
// room.shop        = 8 slots (4x2), each null or an item { id, kind, key, amount, cost: [{ mat, n }], positions? }. Items stay for sale until the Host discards them.
// player.inventory = 50 slots (5x10), each null or { kind: "material" | "structure", key, amount }. Materials (what requirements are paid with) are
//                    items in those slots, 10 per slot, like Minecraft. There is no separate material counter.
"use strict";
const HGShop = require("./public/js/shop-data.js");

const newShop = () => Array(HGShop.SHOP_SLOTS).fill(null);
const newInventory = () => Array(HGShop.INV_SLOTS).fill(null);
const materialsOf = p => HGShop.materialTotals(p.inventory);          // read-only totals (what the player can pay with)
const validSlot = i => Number.isInteger(i) && i >= 0 && i < HGShop.SHOP_SLOTS;

// Host: put (or replace) an item in a slot. Returns an error text or "".
function setSlot(room, slot, raw) {
  if (!validSlot(slot)) return "That Shop cell does not exist.";
  const { item, error } = HGShop.clean(raw);
  if (error) return error;
  room.shop[slot] = { id: ++room.shopSeq, ...item };
  return "";
}
function clearSlot(room, slot) {
  if (!validSlot(slot) || !room.shop[slot]) return "That Shop cell is already empty.";
  room.shop[slot] = null;
  return "";
}

// Host: give a player some of a material (it goes into their Inventory slots, 10 per slot). Returns an error text or "".
function giveMaterial(p, mat, amount) {
  if (!HGShop.MATERIALS[mat]) return "Unknown material.";
  if (!Number.isInteger(amount) || amount < 1 || amount > HGShop.MAX_COST) return `Amount must be a whole number from 1 to ${HGShop.MAX_COST}.`;
  const room = HGShop.inventoryRoom(p.inventory, "material", mat);
  if (room < amount) return `${p.username}'s Inventory only has room for ${room} more ${HGShop.MATERIALS[mat].name}.`;
  HGShop.inventoryAdd(p.inventory, "material", mat, amount);
  return "";
}

// Player: buy what is in a slot. Nothing is taken unless the whole purchase works. Returns { error } or { message }.
// deps = { maxCards, newId() }  (a bought Card arrives as an Issue Card assignment: the player builds it in Preparation)
function buy(room, p, slot, deps) {
  const item = validSlot(slot) ? room.shop[slot] : null;
  if (!item) return { error: "That item is no longer for sale." };
  const inv = p.inventory.map(s => s && { ...s });                       // work on a copy: the cost leaves the Inventory first, which frees slots
  for (const c of item.cost) {
    const have = HGShop.materialCount(inv, c.mat);
    if (have < c.n) return { error: `You need ${c.n} ${HGShop.MATERIALS[c.mat].name} (you have ${have}).` };
  }
  for (const c of item.cost) HGShop.inventoryTake(inv, c.mat, c.n);
  if ((item.kind === "structure" || item.kind === "material") && HGShop.inventoryRoom(inv, item.kind, item.key) < item.amount) return { error: "Your Inventory is full." };
  if (item.kind === "card") {
    if (!HGShop.canUseCard(p.className, item.key)) return { error: `A ${p.className} can't use that card.` };
    const pending = p.assignments.filter(a => a.kind === "card").length;
    if (p.cards.length + pending >= deps.maxCards) return { error: `You have no free card slot (max ${deps.maxCards}).` };
  }
  if (item.kind === "structure" || item.kind === "material") HGShop.inventoryAdd(inv, item.kind, item.key, item.amount);
  else p.assignments.push({ id: deps.newId(), kind: "card", cardType: item.key, positions: item.positions });
  inv.forEach((s, i) => { p.inventory[i] = s; });
  const what = item.kind === "card" ? `${HGShop.itemLabel(item)}. Build it in Preparation` : HGShop.itemLabel(item);
  return { message: `Bought ${what}.`, card: item.kind === "card" };
}

module.exports = { HGShop, newShop, newInventory, materialsOf, setSlot, clearSlot, giveMaterial, buy };
