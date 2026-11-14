// Heart Grid - Shop (client). Needs window.HGApp (main.js) and window.HGShop (shop-data.js). All rules are enforced by server.js / shop.js.
//   Host:   Management > Shop = giant "Shop" title with its icon, a 4x2 grid of separated 1x1 cells showing "+". "+" opens the item editor
//           (Material / Structure / Card, amount if it stacks, the materials it costs). Hover = big preview + cost. Click a saved item = Edit or Discard.
//   Player: click the Shop on the Battlefield > Use > the Shop screen (tabs Shop / Inventory). Also the Character > Inventories tab (5x10 grid + Materials).
(() => {
  const A = window.HGApp, S = window.HGShop;
  if (!A || !S) return;
  const { socket, $, toast, ask } = A;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  // A picture with a list of places to try, then the "missing asset" picture.
  function img(chain, cls, alt) {
    const i = el("img", cls); i.alt = alt || ""; i.draggable = false;
    let k = 0;
    i.onerror = () => { if (++k < chain.length) i.src = chain[k]; else { i.onerror = null; i.src = "/assets/missing.png"; } };
    i.src = chain[0];
    return i;
  }

  let slots = Array(S.SHOP_SLOTS).fill(null);      // what is for sale (same for everyone)
  let inventory = Array(S.INV_SLOTS).fill(null);   // this player's grid
  let materials = Object.fromEntries(S.MAT_KEYS.map(k => [k, 0]));

  const canAfford = item => item.cost.every(c => (materials[c.mat] || 0) >= c.n);

  /* ---------- Hover preview: the item much bigger, with its cost ---------- */
  const hover = $("shop-hover");
  function showHover(item, ev, withCost) {
    hover.replaceChildren(img(S.iconChain(item), "sh-art", S.itemName(item)));
    hover.append(el("h3", "sh-name", S.itemLabel(item)), el("span", "sh-kind", S.KIND_LABEL[item.kind]), el("p", "sh-info", S.itemInfo(item)));
    if (withCost) {
      hover.append(el("span", "sh-label", "Cost"));
      hover.append(costBlock(item.cost, "sh-cost"));
    }
    hover.hidden = false;
    placeHover(ev);
  }
  function placeHover(ev) {
    const w = hover.offsetWidth, h = hover.offsetHeight;
    let x = ev.clientX + 18, y = ev.clientY + 14;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - 18;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    hover.style.left = Math.max(8, x) + "px"; hover.style.top = Math.max(8, y) + "px";
  }
  const hideHover = () => { hover.hidden = true; };
  document.addEventListener("mousemove", ev => { if (!hover.hidden) placeHover(ev); });

  // "3 Scrap + 1 Gold" as little icon chips (or "Free").
  function costBlock(cost, cls) {
    const box = el("div", cls || "cost-chips");
    if (!cost.length) { box.append(el("span", "cost-free", "Free")); return box; }
    for (const c of cost) {
      const chip = el("span", "cost-chip");
      chip.append(img([S.matIcon(c.mat)], "cost-icon", ""), el("b", "", String(c.n)), el("span", "", S.MATERIALS[c.mat].name));
      box.append(chip);
    }
    return box;
  }

  /* ---------- The 4x2 grid (Host and Player Shop screen) ---------- */
  function renderGrid(host, mode) {
    host.replaceChildren();
    slots.forEach((item, i) => {
      const slot = el("div", "shop-slot");
      const cell = el("button", "shop-cell"); cell.type = "button"; cell.dataset.slot = i;
      if (!item) {
        cell.classList.add("empty");
        if (mode === "host") { cell.append(el("span", "plus", "+")); cell.setAttribute("aria-label", "Add an item to the Shop"); }
        else cell.disabled = true;
      } else {
        cell.append(img(S.iconChain(item), "shop-art", S.itemName(item)));
        if (item.amount > 1) cell.append(el("b", "shop-count", "×" + item.amount));
        cell.setAttribute("aria-label", S.itemLabel(item));
        if (mode === "player" && !canAfford(item)) cell.classList.add("short");
      }
      const cap = el("div", "shop-cost" + (item && mode === "player" && !canAfford(item) ? " short" : ""), item ? S.costText(item.cost) : "");
      slot.append(cell, cap);
      host.append(slot);
    });
  }
  function wireGrid(host, mode) {
    host.addEventListener("mouseover", ev => {
      const c = ev.target.closest(".shop-cell");
      const item = c && slots[+c.dataset.slot];
      if (item) showHover(item, ev, true); else hideHover();
    });
    host.addEventListener("mouseleave", hideHover);
    host.addEventListener("click", ev => {
      const c = ev.target.closest(".shop-cell");
      if (!c) return;
      const i = +c.dataset.slot, item = slots[i];
      hideHover();
      if (mode === "host") return item ? openPick(i) : openEditor(i, null);
      if (!item) return;
      ask(`Buy ${S.itemLabel(item)} for ${S.costText(item.cost)}?`, () => socket.emit("shop-buy", { slot: i }));
    });
  }
  wireGrid($("shop-grid"), "host");
  wireGrid($("so-grid"), "player");

  /* ---------- Inventory (5x10, materials and structures in the slots): used by Character > Inventories and the Shop's Inventory tab ---------- */
  function renderInventory(box) {
    box.replaceChildren();
    const layout = el("div", "inv-layout");
    const grid = el("div", "inv-grid");
    inventory.forEach((item, i) => {
      const cell = el("div", "inv-slot" + (item ? " filled" : "")); cell.dataset.i = i;
      if (item) {
        cell.append(img(S.iconChain(item), "inv-art", S.itemName(item)));
        if (item.amount > 1) cell.append(el("b", "shop-count", "×" + item.amount));
      }
      grid.append(cell);
    });
    grid.addEventListener("mouseover", ev => {
      const c = ev.target.closest(".inv-slot.filled");
      if (c) showHover(inventory[+c.dataset.i], ev, false); else hideHover();
    });
    grid.addEventListener("mouseleave", hideHover);
    layout.append(grid);                                       // materials are items in the slots now (10 per slot): no separate counter
    box.append(layout);
  }
  function renderMatStrip() {
    const strip = $("so-mats");
    strip.replaceChildren();
    for (const k of S.MAT_KEYS) {
      const chip = el("span", "mat-chip");
      chip.title = S.MATERIALS[k].name;
      chip.append(img([S.matIcon(k)], "mat-icon sm", ""), el("b", "", String(materials[k] || 0)));
      strip.append(chip);
    }
  }
  function renderPlayerSide() {
    renderInventory($("inv-view"));
    renderInventory($("so-inv"));
    renderMatStrip();
    renderGrid($("so-grid"), "player");
    $("so-empty").hidden = slots.some(Boolean);
  }
  const renderHostSide = () => renderGrid($("shop-grid"), "host");

  socket.on("shop-state", s => {
    slots = s.slots || Array(S.SHOP_SLOTS).fill(null);
    hideHover();
    if (A.isHost()) renderHostSide(); else renderPlayerSide();
  });
  socket.on("my-state", s => {
    inventory = s.inventory || Array(S.INV_SLOTS).fill(null);
    materials = s.materials || materials;
    renderPlayerSide();
  });
  socket.on("room-created", () => { slots = Array(S.SHOP_SLOTS).fill(null); renderHostSide(); });
  socket.on("room-joined", () => { closeShop(); renderPlayerSide(); });
  socket.on("room-closed", closeShop);
  $("leave-button").addEventListener("click", closeShop);
  renderHostSide();
  renderPlayerSide();

  /* ---------- Player: the Shop screen ---------- */
  function openShop() { $("shop-overlay").hidden = false; setSoTab("shop"); renderPlayerSide(); }
  function closeShop() { $("shop-overlay").hidden = true; hideHover(); }
  function setSoTab(tab) {
    document.querySelectorAll(".so-tab").forEach(t => t.classList.toggle("active", t.dataset.sotab === tab));
    document.querySelectorAll(".so-pane").forEach(p => p.classList.toggle("active", p.id === "so-pane-" + tab));
    hideHover();
  }
  document.querySelectorAll(".so-tab").forEach(t => t.addEventListener("click", () => setSoTab(t.dataset.sotab)));
  $("so-back").addEventListener("click", closeShop);
  socket.on("shop-open", openShop);
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape" && !$("shop-overlay").hidden && $("confirm-dialog").hidden) closeShop();
  });

  /* ---------- Host: click a saved item = Edit or Discard ---------- */
  function openPick(i) {
    const item = slots[i];
    if (!item) return;
    const box = $("sp-body");
    box.replaceChildren(img(S.iconChain(item), "sp-art", S.itemName(item)), el("h2", "", S.itemLabel(item)),
      el("span", "sh-kind", S.KIND_LABEL[item.kind]), el("p", "sh-info", S.itemInfo(item)), el("span", "sh-label", "Cost"), costBlock(item.cost, "sh-cost"));
    $("sp-edit").onclick = () => { $("shop-pick").hidden = true; openEditor(i, item); };
    $("sp-discard").onclick = () => {
      $("shop-pick").hidden = true;
      ask(`Discard ${S.itemLabel(item)} from the Shop?`, () => socket.emit("host-shop-clear", { slot: i }));
    };
    $("shop-pick").hidden = false;
  }
  $("sp-close").addEventListener("click", () => { $("shop-pick").hidden = true; });
  $("shop-pick").addEventListener("click", ev => { if (ev.target === $("shop-pick")) $("shop-pick").hidden = true; });

  /* ---------- Host: the item editor (+ or Edit) ---------- */
  let draft = null, draftSlot = 0;
  const firstKey = kind => kind === "material" ? S.MAT_KEYS[0] : kind === "structure" ? S.structureKeys()[0] : S.cardKeys()[0];

  function openEditor(slot, item) {
    draftSlot = slot;
    draft = item ? JSON.parse(JSON.stringify(item)) : { kind: "material", key: firstKey("material"), amount: 1, positions: S.MIN_POS, cost: [] };
    if (!draft.positions) draft.positions = S.MIN_POS;
    $("sd-title").textContent = item ? "Edit item" : "Add to the Shop";
    $("sd-ok").textContent = item ? "Save changes" : "Put on sale";
    buildEditor();
    $("shop-dialog").hidden = false;
  }
  const closeEditor = () => { $("shop-dialog").hidden = true; draft = null; };
  $("sd-cancel").addEventListener("click", closeEditor);
  $("shop-dialog").addEventListener("click", ev => { if (ev.target === $("shop-dialog")) closeEditor(); });

  function field(label, control) {
    const l = el("label", "field"); l.append(el("span", "", label), control);
    return l;
  }
  function select(options, value, onChange) {
    const s = document.createElement("select");
    for (const [v, label] of options) s.add(new Option(label, v));
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  function buildEditor() {
    const body = $("sd-body");
    body.replaceChildren();

    // preview of what is being made
    const prev = el("div", "sd-preview");
    const showPrev = () => {
      prev.replaceChildren(img(S.iconChain(draft), "sd-art", S.itemName(draft)));
      const t = el("div", "sd-prev-text");
      t.append(el("strong", "", S.itemLabel(draft)), el("small", "", S.costText(draft.cost)));
      prev.append(t);
    };
    showPrev();
    body.append(prev);

    // kind
    const kinds = el("div", "sd-kinds");
    for (const k of S.KINDS) {
      const b = el("button", "sd-kind" + (draft.kind === k ? " active" : ""), S.KIND_LABEL[k]); b.type = "button";
      b.addEventListener("click", () => {
        if (draft.kind === k) return;
        draft.kind = k; draft.key = firstKey(k);
        if (!S.stackable(k)) draft.amount = 1;
        buildEditor();
      });
      kinds.append(b);
    }
    body.append(field("What do you want to sell?", kinds));

    // which one
    const opts = draft.kind === "material" ? S.MAT_KEYS.map(k => [k, S.MATERIALS[k].name])
      : draft.kind === "structure" ? S.structureKeys().map(k => [k, window.HGStructures.STRUCTURES[k].name])
      : S.cardKeys().map(k => [k, `${window.HGCards.CARDS[k].name} · ${S.classesOf(k).join(" / ")}`]);
    body.append(field(S.KIND_LABEL[draft.kind], select(opts, draft.key, v => { draft.key = v; showPrev(); })));

    if (draft.kind === "card") {
      body.append(field(`Positions (${S.MIN_POS} to ${S.MAX_POS})`, select(
        Array.from({ length: S.MAX_POS - S.MIN_POS + 1 }, (_, n) => [String(n + S.MIN_POS), `${n + S.MIN_POS} positions`]), String(draft.positions),
        v => { draft.positions = Number(v); showPrev(); })));
      body.append(el("p", "sd-note", "The buyer builds the card's pattern in Preparation, like an Issue Card. Cards don't stack."));
    }
    if (S.stackable(draft.kind)) {
      const amount = document.createElement("input");
      amount.type = "number"; amount.min = 1; amount.max = S.MAX_AMOUNT; amount.value = draft.amount;
      amount.addEventListener("input", () => { draft.amount = Number(amount.value); showPrev(); });
      body.append(field(`Amount per purchase (1-${S.MAX_AMOUNT})`, amount));
    }

    // requirements
    const req = el("div", "sd-req");
    req.append(el("span", "sd-req-title", "Requirement to buy"));
    const rows = el("div", "sd-req-rows");
    draft.cost.forEach((c, idx) => {
      const row = el("div", "sd-req-row");
      const used = new Set(draft.cost.filter((_, j) => j !== idx).map(x => x.mat));
      const sel = select(S.MAT_KEYS.filter(k => !used.has(k)).map(k => [k, S.MATERIALS[k].name]), c.mat, v => { c.mat = v; showPrev(); });
      const n = document.createElement("input");
      n.type = "number"; n.min = 1; n.max = S.MAX_COST; n.value = c.n;
      n.addEventListener("input", () => { c.n = Number(n.value); showPrev(); });
      const del = el("button", "sd-del", "×"); del.type = "button"; del.title = "Remove this requirement"; del.setAttribute("aria-label", "Remove requirement");
      del.addEventListener("click", () => { draft.cost.splice(idx, 1); buildEditor(); });
      row.append(img([S.matIcon(c.mat)], "mat-icon sm", ""), sel, n, del);
      rows.append(row);
    });
    req.append(rows);
    const add = el("button", "button quiet sd-add", "+ Add requirement"); add.type = "button";
    add.disabled = draft.cost.length >= S.MAT_KEYS.length;
    add.addEventListener("click", () => {
      const free = S.MAT_KEYS.find(k => !draft.cost.some(c => c.mat === k));
      if (free) { draft.cost.push({ mat: free, n: 1 }); buildEditor(); }
    });
    req.append(add, el("p", "sd-note", draft.cost.length ? "The buyer must have all of these. They are spent on purchase." : "No requirement: the item is free."));
    body.append(req);
  }

  $("sd-ok").addEventListener("click", () => {
    if (!draft) return;
    const r = S.clean(draft);
    if (r.error) return toast(r.error);
    socket.emit("host-shop-set", { slot: draftSlot, item: r.item });
    closeEditor();
  });
})();
