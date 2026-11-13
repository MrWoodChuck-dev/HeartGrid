// Heart Grid - structure ("Shop" / Base) data shared by the server (require) and the browser (<script>).
// ONE place for: which structures exist, what pieces they are built from, the Dropship Area, who glows which colour while moving a piece.
// Every structure is built from separate 1x1 PIECES that players move one at a time. A structure only works while ALL its pieces are
// connected (side by side, any arrangement). To add a structure: add an entry to STRUCTURES. Server rules live in structures.js (like cards.js does for cards).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HGStructures = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // shape = where the pieces start when the Host places the structure (offsets; every 90 degree turn maps (x, y) -> (-y, x)).
  // pieces[i] = { name, icon }: icon is the picture of that piece in public/assets/structure/ (a missing file shows the "missing asset" picture).
  // use: "generate" = makes a Wall, "soon" = Coming Soon. auto = every room starts with one (the Host can't add or remove it).
  const STRUCTURES = {
    shop: {
      name: "Shop", auto: true, use: "soon", shape: [[0, 0], [1, 0], [0, 1], [1, 1]],
      pieces: [1, 2, 3, 4].map(n => ({ name: `Piece ${n}`, icon: `shop_${n}.png` })),
      note: "Works while all 4 pieces are connected."
    },
    wall_gen: {
      name: "Wall Generator", use: "generate", shape: [[0, 0], [1, 0]],
      pieces: [{ name: "Generator", icon: "wall_generator_1.png" }, { name: "Output", icon: "wall_generator_2.png" }],
      note: "Works while both pieces are connected. Makes 1 free Wall per encounter on its Output piece, unless a Wall is still there."
    },
    crafting: {
      name: "Crafting Table", use: "soon", shape: [[0, 0], [1, 0], [0, 1]],
      pieces: [1, 2, 3].map(n => ({ name: `Piece ${n}`, icon: `crafting_table_${n}.png` })),
      note: "Works while all 3 pieces are connected. Coming Soon."
    },
    quest: {
      name: "Quest Board", use: "soon", shape: [[0, 0], [1, 0]],
      pieces: [1, 2].map(n => ({ name: `Piece ${n}`, icon: `quest_board_${n}.png` })),
      note: "Works while both pieces are connected. Coming Soon."
    }
  };

  const ASSET_DIR = "/assets/structure/";
  const WALL_ICON = "wall.png";
  const iconUrl = file => ASSET_DIR + file;
  const REACH = 2;                                    // a carried piece can be put down up to this many cells from its carrier
  const GLOW = { Tank: "#4ade80", Warrior: "#f87171", Rogue: "#60a5fa", Mage: "#c084fc", Support: "#facc15" };   // green, red, blue, purple, yellow

  // A piece is one cell. (Kept as a list so callers can treat every prop the same way.)
  const cellsOf = p => [{ x: p.x, y: p.y }];
  // Where a whole structure's pieces start when placed at (x, y) with rotation rot.
  function shapeCells(type, x, y, rot) {
    const r = (((rot || 0) % 4) + 4) % 4;
    return STRUCTURES[type].shape.map(([ox, oy]) => {
      let a = ox, b = oy;
      for (let i = 0; i < r; i++) { const t = a; a = -b; b = t; }
      return { x: x + a, y: y + b };
    });
  }
  const iconOf = p => STRUCTURES[p.type].pieces[p.piece || 0].icon;
  const labelOf = p => `${STRUCTURES[p.type].name} · ${STRUCTURES[p.type].pieces[p.piece || 0].name}`;
  const cellName = (x, y) => `${x + 1}${String.fromCharCode(65 + y)}`;       // chess style, number first: 11A
  const dropship = (cols, rows) => ({ x0: cols - 2, y0: rows - 2, w: 2, h: 2 });   // bottom-right 2x2 of the Class Area
  const inDrop = (D, x, y) => x >= D.x0 && x < D.x0 + D.w && y >= D.y0 && y < D.y0 + D.h;
  const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  const touches = (p, x, y) => Math.abs(p.x - x) + Math.abs(p.y - y) === 1;   // standing right next to it (not diagonally)

  return { STRUCTURES, ASSET_DIR, WALL_ICON, iconUrl, REACH, GLOW, cellsOf, shapeCells, iconOf, labelOf, cellName, dropship, inDrop, cheb, touches };
});
