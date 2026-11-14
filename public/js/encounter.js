// Heart Grid - encounters (client).
// Host: Monsters tab (build + save to the Bench), Combat tab (battlefield, Bench, Dice, turn order, Pause).
// Everyone: the turn-order strip, the Initiative roll, and the monster attack picker (also used by the Training Dummy).
// Needs window.HGApp from main.js. All rules are enforced by server.js; this file only shows them and sends the Host's choices.
(() => {
  const A = window.HGApp;
  if (!A) return;
  const { socket, $, say, toast, ask, setImage, classIcon, createField, renderField } = A;
  const HGC = window.HGCards, HGS = window.HGStructures, HGFx = window.HGFx;

  const HP_SIZES = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
  const RANGE_SIZES = [3, 5, 7, 9, 11];
  const MONSTERS = [
    { key: "devil",  name: "Devil",  sprite: "/assets/monsters/devil.png",  open: true,  dice: "D10 Attack · D2 Movement" },
    { key: "scale",  name: "Scale",  sprite: "/assets/monsters/scale.png",  open: false, dice: "" },
    { key: "spirit", name: "Spirit", sprite: "/assets/monsters/spirit.png", open: false, dice: "" }
  ];
  const monsterInfo = key => MONSTERS.find(m => m.key === key) || MONSTERS[0];

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const gridLabel = n => `${n}×${n}`;

  let battle = null;          // latest battle-state
  let bench = [];             // the Host's saved monsters
  let selMon = null;          // monster selected on the Host battlefield

  /* ================= Host tabs ================= */

  document.querySelectorAll(".host-tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".host-tab").forEach(b => b.classList.toggle("active", b === t));
    document.querySelectorAll(".host-pane").forEach(p => p.classList.toggle("active", p.id === "host-pane-" + t.dataset.hostpane));
    if (t.dataset.hostpane === "combat") renderHostCombat();
  }));

  /* ================= Management tabs (Players / Shop) =================
     The Shop itself (4x2 grid, items, requirements) lives in js/shop-ui.js. */
  document.querySelectorAll(".manage-tab").forEach(t => t.addEventListener("click", () => {
    document.querySelectorAll(".manage-tab").forEach(b => b.classList.toggle("active", b === t));
    document.querySelectorAll(".mpane").forEach(p => p.classList.toggle("active", p.id === "mpane-" + t.dataset.mpane));
  }));
  let activeBt = "bench";
  document.querySelectorAll(".bt-tab").forEach(t => t.addEventListener("click", () => {
    activeBt = t.dataset.bt;
    document.querySelectorAll(".bt-tab").forEach(b => b.classList.toggle("active", b === t));
    document.querySelectorAll(".bt-pane").forEach(p => p.classList.toggle("active", p.id === "bt-" + t.dataset.bt));
  }));

  /* ================= Monsters tab ================= */

  // A slider that wraps around: the track slides, the arrows go both ways.
  function slider(track, prev, next, count, onChange) {
    let i = 0;
    const go = n => { i = (n + count) % count; track.style.transform = `translateX(${-i * 100}%)`; onChange(i); };
    prev.addEventListener("click", () => go(i - 1));
    next.addEventListener("click", () => go(i + 1));
    go(0);
    return { get index() { return i; } };
  }

  let monIdx = 0;
  function showMonster() {
    const m = MONSTERS[monIdx];
    setImage($("mon-img"), m.sprite);
    say("mon-name", m.name);
    say("mon-dice", m.open ? m.dice : "");
    $("mon-locked").hidden = m.open;
    $("mon-card").classList.toggle("locked", !m.open);
    $("mon-save").disabled = !m.open;
  }
  $("mon-prev").addEventListener("click", () => { monIdx = (monIdx - 1 + MONSTERS.length) % MONSTERS.length; showMonster(); });
  $("mon-next").addEventListener("click", () => { monIdx = (monIdx + 1) % MONSTERS.length; showMonster(); });
  showMonster();

  let custom = null;                   // the Host's HP Grid edit { cells, armor } for the chosen size, or null = plain (all healthy)
  const hpTrack = $("hpg-track"), rngTrack = $("rng-track");
  HP_SIZES.forEach(n => {
    const slide = el("div", "pick-slide"), g = el("div", "hp-grid pick-grid");
    HGFx.buildGrid(g, n);
    const cap = el("span", "pick-cap", gridLabel(n));
    slide.append(g, cap);
    hpTrack.append(slide);
  });
  RANGE_SIZES.forEach(n => {
    const slide = el("div", "pick-slide"), g = el("div", "hp-grid pick-grid range-grid");
    HGFx.buildGrid(g, n);
    g.children[(n * n - 1) / 2].classList.add("mon");
    const cap = el("span", "pick-cap", `${gridLabel(n)} · ${(n - 1) / 2} cell${n === 3 ? "" : "s"} around it`);
    slide.append(g, cap);
    rngTrack.append(slide);
  });
  const hpPick = slider(hpTrack, $("hpg-prev"), $("hpg-next"), HP_SIZES.length, i => { say("hpg-label", gridLabel(HP_SIZES[i])); custom = null; });
  const rngPick = slider(rngTrack, $("rng-prev"), $("rng-next"), RANGE_SIZES.length, i => say("rng-label", gridLabel(RANGE_SIZES[i])));

  /* ---- HP Grid editor: paint Armor and Over-heal onto the monster's cells ---- */
  let ed = null, tool = "armor";

  const counts = c => ({ armor: c.armor.filter(Boolean).length, over: c.cells.filter(v => v === 2).length });
  function editSummary() {
    if (!custom) return "Plain: every cell healthy.";
    const k = counts(custom);
    return `${k.armor} Armored cell${k.armor === 1 ? "" : "s"} · ${k.over} Over-heal cell${k.over === 1 ? "" : "s"}`;
  }
  function paintEditor() {
    const grid = $("hp-edit-grid");
    HGFx.applyCells(grid, ed.cells, { armor: ed.armor });
    const k = counts(ed);
    say("hp-edit-sum", `${k.armor} Armored · ${k.over} Over-heal · ${ed.cells.length} cells`);
  }
  function openEditor() {
    const n = HP_SIZES[hpPick.index];
    ed = custom ? { cells: [...custom.cells], armor: [...custom.armor] } : { cells: Array(n * n).fill(1), armor: Array(n * n).fill(0) };
    const grid = $("hp-edit-grid");
    HGFx.buildGrid(grid, n);
    paintEditor();
    $("hp-editor").hidden = false;
  }
  let painting = null;                 // the value being painted while the mouse is down
  function paintCell(i) {
    if (painting === null) return;
    if (tool === "armor") ed.armor[i] = painting;
    else if (tool === "over") ed.cells[i] = painting;
    else { ed.armor[i] = 0; ed.cells[i] = 1; }
    paintEditor();
  }
  const cellIdx = e => { const s = e.target.closest("#hp-edit-grid > span"); return s ? [...$("hp-edit-grid").children].indexOf(s) : -1; };
  $("hp-edit-grid").addEventListener("pointerdown", e => {
    const i = cellIdx(e);
    if (i < 0) return;
    e.preventDefault();
    painting = tool === "armor" ? (ed.armor[i] ? 0 : 1) : tool === "over" ? (ed.cells[i] === 2 ? 1 : 2) : 1;
    paintCell(i);
  });
  $("hp-edit-grid").addEventListener("pointerover", e => { if (e.buttons === 1) { const i = cellIdx(e); if (i >= 0) paintCell(i); } });
  document.addEventListener("pointerup", () => { painting = null; });
  document.querySelectorAll("#hp-tools .tool").forEach(b => b.addEventListener("click", () => {
    tool = b.dataset.tool;
    document.querySelectorAll("#hp-tools .tool").forEach(x => x.classList.toggle("active", x === b));
  }));
  $("hp-edit-reset").addEventListener("click", () => { ed.cells.fill(1); ed.armor.fill(0); paintEditor(); });
  $("hp-edit-done").addEventListener("click", () => {
    const k = counts(ed);
    custom = k.armor || k.over ? { cells: [...ed.cells], armor: [...ed.armor] } : null;
    say("monster-edit-sum", editSummary());
    $("hp-editor").hidden = true;
  });
  $("monster-edit").addEventListener("click", openEditor);

  // Name it, then save it to the Bench
  $("mon-save").addEventListener("click", () => {
    const m = MONSTERS[monIdx];
    if (!m.open) return;
    say("monster-edit-sum", editSummary());
    say("monster-dialog-sub", `${m.name} · HP Grid ${gridLabel(HP_SIZES[hpPick.index])} · Range Grid ${gridLabel(RANGE_SIZES[rngPick.index])}`);
    $("monster-name-input").value = m.name;
    $("monster-dialog").hidden = false;
    $("monster-name-input").focus();
    $("monster-name-input").select();
  });
  const closeMonsterDialog = () => { $("monster-dialog").hidden = true; };
  $("monster-cancel").addEventListener("click", closeMonsterDialog);
  $("monster-dialog").addEventListener("click", e => { if (e.target === $("monster-dialog")) closeMonsterDialog(); });
  $("monster-name-input").addEventListener("keydown", e => { if (e.key === "Enter") $("monster-ok").click(); });
  $("monster-ok").addEventListener("click", () => {
    const name = $("monster-name-input").value.trim();
    if (!name || name.length > 16) return toast("Monster names are 1-16 characters.");
    socket.emit("host-save-monster", {
      species: MONSTERS[monIdx].key, name, hpN: HP_SIZES[hpPick.index], rangeN: RANGE_SIZES[rngPick.index],
      ...(custom ? { cells: custom.cells, armor: custom.armor } : {})
    });
    closeMonsterDialog();
  });

  // Saved monsters: discarding asks first
  function renderSaved() {
    const list = $("mon-saved");
    list.replaceChildren();
    if (!bench.length) { list.append(el("p", "host-empty", "Nothing saved yet.")); return; }
    for (const b of bench) {
      const card = el("article", "saved-card");
      const img = el("img");
      img.alt = "";
      setImage(img, monsterInfo(b.species).sprite);
      const text = el("div");
      text.append(el("strong", "", b.name), el("span", "", `HP ${gridLabel(b.hpN)} · Range ${gridLabel(b.rangeN)}`));
      if (b.cells) { const k = counts(b); text.append(el("span", "", `${k.armor} Armored · ${k.over} Over-heal`)); }
      const x = el("button", "saved-x", "×");
      x.type = "button";
      x.title = "Discard from the Bench";
      x.addEventListener("click", () => ask(`Discard "${b.name}" from the Bench? Monsters already on the battlefield stay.`, () => socket.emit("host-discard-monster", { id: b.id })));
      card.append(img, text, x);
      list.append(card);
    }
  }

  /* ================= Bench (Combat tab) ================= */

  let benchIdx = 0;
  let dragBench = null;
  function renderBench() {
    const slot = $("bench-slot");
    slot.replaceChildren();
    if (benchIdx >= bench.length) benchIdx = 0;
    $("bench-prev").disabled = $("bench-next").disabled = bench.length < 2;
    if (!bench.length) { slot.append(el("p", "host-empty", "The Bench is empty. Build a monster in the Monsters tab.")); return; }
    const b = bench[benchIdx];
    const card = el("article", "bench-card");
    card.draggable = true;
    card.title = "Drag onto the battlefield (not on the players' third)";
    const img = el("img");
    img.alt = "";
    img.draggable = false;
    setImage(img, monsterInfo(b.species).sprite);
    const text = el("div");
    text.append(el("strong", "", b.name), el("span", "", `HP ${gridLabel(b.hpN)} · Range ${gridLabel(b.rangeN)}`));
    if (b.cells) { const k = counts(b); text.append(el("span", "", `${k.armor} Armored · ${k.over} Over-heal`)); }
    text.append(el("small", "", `${benchIdx + 1} / ${bench.length}`));
    card.append(img, text);
    card.addEventListener("dragstart", e => {
      if (battle?.enc?.phase === "running") { e.preventDefault(); return toast("Pause the encounter first. Then you can add monsters."); }
      dragBench = b.id;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", b.id);
      hostField.el.classList.add("drag-spawn");
    });
    card.addEventListener("dragend", () => { dragBench = null; hostField.el.classList.remove("drag-spawn"); });
    slot.append(card);
  }
  $("bench-prev").addEventListener("click", () => { benchIdx = (benchIdx - 1 + bench.length) % bench.length; renderBench(); });
  $("bench-next").addEventListener("click", () => { benchIdx = (benchIdx + 1) % bench.length; renderBench(); });

  socket.on("room-created", () => { bench = []; selMon = null; renderBench(); renderSaved(); });
  socket.on("bench-state", s => { bench = s.bench || []; renderBench(); renderSaved(); });

  /* ================= Host battlefield ================= */

  const hostField = createField($("host-battlefield"));
  const monsterAt = (b, x, y) => b.monsters.find(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  const actingMonster = b => b?.enc?.phase === "running" && b.enc.turn?.kind === "monster" ? b.monsters.find(m => m.id === b.enc.turn.id) : null;

  hostField.el.addEventListener("dragover", e => {
    if (!dragBench) return;
    const c = e.target.closest(".bf-cell");
    if (c && +c.dataset.x !== battle?.midCol && !c.classList.contains("zone") && !c.classList.contains("monster") && !c.classList.contains("other") && !c.classList.contains("has-wall")) e.preventDefault();
  });
  hostField.el.addEventListener("drop", e => {
    if (!dragBench) return;
    e.preventDefault();
    const c = e.target.closest(".bf-cell");
    const id = dragBench;
    dragBench = null;
    hostField.el.classList.remove("drag-spawn");
    if (c) socket.emit("host-place", { benchId: id, x: +c.dataset.x, y: +c.dataset.y });
  });
  hostField.el.addEventListener("click", e => {
    const c = e.target.closest(".bf-cell");
    if (!c || !battle) return;
    const x = +c.dataset.x, y = +c.dataset.y;
    if (activeBt === "battle") {                       // Battlefield editor: click an empty cell to place a Wall, click a Wall to remove it
      const wall = (battle.structures || []).find(s => s.x === x && s.y === y);
      if (!wall && x === battle.midCol) return toast("Structures cannot be placed on the middle column of the Active Area.");
      return wall ? socket.emit("host-wall-remove", { id: wall.id }) : socket.emit("host-wall-place", { x, y });
    }
    const acting = actingMonster(battle);
    if (c.classList.contains("reach") && acting) return socket.emit("host-move", { monsterId: acting.id, x, y });
    const m = monsterAt(battle, x, y);
    selMon = m ? m.id : null;
    renderHostCombat();
  });
  $("bench-remove").addEventListener("click", () => { if (selMon) socket.emit("host-remove-monster", { id: selMon }); selMon = null; });

  function renderHostCombat() {
    if (!battle || !A.isHost()) return;
    renderField(hostField, { ...battle, me: null, training: false });
    if (selMon && !battle.monsters.some(m => m.id === selMon)) selMon = null;
    const acting = actingMonster(battle);
    const shown = battle.monsters.find(m => m.id === selMon) || acting;

    for (const m of battle.monsters) for (const [x, y] of A.cellsOf(m)) if (m.id === selMon) hostField.cell(x, y)?.classList.add("sel");
    // the shown monster's Range Grid
    if (shown) for (const c of hostField.cells) {
      const d = HGC.cheb(shown.x, shown.y, +c.dataset.x, +c.dataset.y);
      if (d > 0 && d <= shown.range) c.classList.add("mon-range");
    }
    // move: the cells touching the acting monster (never its own cell)
    if (acting && acting.turn.move.left > 0 && !(acting.hold > 0)) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const c = hostField.cell(acting.x + dx, acting.y + dy);
        if (!c || c.classList.contains("monster") || c.classList.contains("other") || c.classList.contains("mine")) continue;
        c.classList.add("reach");
        const lab = el("span", "cost", "·");
        c.append(lab);
      }
    }

    const enc = battle.enc || { phase: "prepare" };
    const alive = battle.players.filter(p => p.inEncounter && !p.dead), ready = alive.filter(p => p.ready).length;
    $("enc-area-ready").hidden = enc.phase !== "prepare";
    $("enc-start").hidden = enc.phase === "running" || enc.phase === "prepare";
    $("enc-start").textContent = enc.phase === "paused" ? "Resume (new initiative)" : `Start Encounter (${ready}/${alive.length} ready)`;
    $("enc-start").disabled = enc.phase === "setup" && (!alive.length || ready < alive.length);
    $("enc-pause").hidden = enc.phase !== "running";
    $("enc-endturn").hidden = enc.phase !== "running";
    $("enc-end").hidden = !(enc.phase === "running" || enc.phase === "paused");
    say("wall-count", `${(battle.structures || []).length} / ${battle.maxWalls || 20}`);
    $("bench-remove").hidden = !(selMon && enc.phase !== "running");
    renderDice(acting, shown);
  }

  $("enc-area-ready").addEventListener("click", () => socket.emit("host-area-ready"));
  $("enc-start").addEventListener("click", () => socket.emit("host-start-encounter"));
  $("enc-pause").addEventListener("click", () => socket.emit("host-pause"));
  $("enc-endturn").addEventListener("click", () => socket.emit("host-end-turn"));
  // Ending an encounter: the Host says how much Energy everyone is blessed with ("Prepare for your next battle...").
  let endMode = "end";
  function openEnd(mode) {
    endMode = mode;
    $("end-cancel").hidden = mode === "bless";
    say("end-dialog-title", mode === "bless" ? "Encounter cleared!" : "End the encounter");
    say("end-dialog-text", mode === "bless" ? "Every Monster is beaten. How much Energy does everyone get for the next battle?" : "The turn order is cleared and anyone in the Fog Area is brought out. How much Energy does everyone get for the next battle?");
    $("end-ok").textContent = mode === "bless" ? "Bless the party" : "End Encounter";
    $("end-dialog").hidden = false;
    $("end-energy").focus();
    $("end-energy").select();
  }
  $("enc-end").addEventListener("click", () => openEnd("end"));
  $("end-cancel").addEventListener("click", () => { $("end-dialog").hidden = true; });
  $("end-ok").addEventListener("click", () => {
    const energy = Math.max(0, Math.min(99, Math.round((parseFloat($("end-energy").value) || 0) * 2) / 2));
    socket.emit(endMode === "bless" ? "host-bless" : "host-end-encounter", { energy });
    $("end-dialog").hidden = true;
  });
  $("end-energy").addEventListener("keydown", e => { if (e.key === "Enter") $("end-ok").click(); });
  socket.on("bless-prompt", () => openEnd("bless"));

  /* ================= Dice (Host) ================= */

  const seenRolls = {};
  function renderDice(acting, shown) {
    const who = $("dice-who");
    who.textContent = !shown ? "No monster selected." : acting && acting.id === shown.id ? `${shown.name}'s turn` : `${shown.name} · dice work on its own turn`;
    const live = acting && shown && acting.id === shown.id ? acting : null;
    for (const die of ["attack", "move"]) {
      const b = $("mdie-" + die);
      const d = (shown || {}).turn?.[die];
      const roll = d ? d.roll : null;
      b.querySelector(".mdie-roll").textContent = roll === null || roll === undefined ? "-" : roll;
      b.disabled = !live || roll !== null;
      const key = shown ? shown.id + die : "";
      if (roll !== null && roll !== undefined && seenRolls[key] === null) { b.classList.remove("spin"); void b.offsetWidth; b.classList.add("spin"); }
      seenRolls[key] = roll ?? null;
    }
    $("mdie-open-attack").hidden = !(live && live.turn.attack.left > 0);
    const move = live ? live.turn.move : null;
    say("dice-hint", !live ? "Start the encounter. On a monster's turn you roll its dice here." :
      [
        live.turn.attack.roll === null ? "" : `Attack: ${live.turn.attack.left} left.`,
        move && move.roll !== null ? `Move: ${move.left} step${move.left === 1 ? "" : "s"} left (click a highlighted cell).` : "",
        "Each die once per turn. A roll can be 0."
      ].filter(Boolean).join(" "));
  }
  document.querySelectorAll("#bt-dice .mdie").forEach(b => b.addEventListener("click", () => {
    const m = actingMonster(battle);
    if (!m || b.disabled) return;
    socket.emit("host-roll", { monsterId: m.id, die: b.dataset.die });
  }));
  $("mdie-open-attack").addEventListener("click", () => { const m = actingMonster(battle); if (m) openHostAttack(m.id); });

  socket.on("host-roll-result", r => {
    if (r.die === "attack") {
      if (r.weakened) toast(`Weakened: the Attack lost ${r.weakened} (now ${r.roll}).`);
      if (r.roll === 0) toast("Attack rolled 0: nothing happens.");
      else if (!r.inRange) toast(`Attack rolled ${r.roll}, but nobody is in range. Move closer, then press Choose targets.`);
      else openHostAttack(r.monsterId);
    } else {
      toast(r.roll === 0 ? "Move rolled 0: it can't move this turn." : `Move rolled ${r.roll}: click a highlighted cell next to the monster.`);
    }
  });

  // Players the monster can hit from where it stands. Taunt forces the Tank.
  function targetsFor(m) {
    if (Array.isArray(m.targets)) {                                      // the server knows what this Monster can see (Presence, Smoke, Shield)
      const all = [...battle.players, ...(battle.structures || [])];
      return m.targets.map(id => all.find(x => x.id === id)).filter(Boolean);
    }
    const inR = battle.players.filter(p => p.inEncounter && !p.dead && !(p.turns?.shield > 0) && p.hp.some(v => v > 0) && HGC.distTo(p, m) <= m.range);   // Shield: untargetable
    const taunter = inR.find(p => p.className === "Tank" && (p.charges?.taunt || 0) > 0);
    if (taunter) return [taunter];
    const walls = (battle.structures || []).filter(s => s.hp.some(v => v > 0) && HGC.distTo(s, m) <= m.range);     // Walls can be attacked too
    return [...inR, ...walls];
  }
  function openHostAttack(monsterId) {
    const m = battle?.monsters.find(x => x.id === monsterId);
    if (!m || !(m.turn.attack.left > 0)) return;
    const targets = targetsFor(m);
    if (!targets.length) return toast("Nobody is in range. Move closer first.");
    openAttack({
      title: `${m.name} attacks`, icon: m.sprite, total: m.turn.attack.left, targets,
      note: targets.length === 1 && targets[0].className === "Tank" && (targets[0].charges?.taunt || 0) > 0 ? "Taunt is active: you must attack the Tank." : "",
      submit: picks => socket.emit("host-attack", { monsterId, picks })
    });
  }

  /* ================= Attack picker (Host, and the Training Dummy) ================= */
  // Covers the screen with the HP Grids of everyone in range. Spread the roll over any cells; switching player keeps your picks.
  // You may use fewer cells than rolled. Submit asks to confirm, then the attack animation plays.

  let atk = null;
  const used = () => [...atk.sel.values()].reduce((n, s) => n + s.size, 0);

  function openAttack(opts) {
    atk = { ...opts, sel: new Map(opts.targets.map(t => [t.id, new Set()])), cur: opts.targets[0].id };
    $("attack-overlay").hidden = false;
    renderAttack();
  }
  function closeAttack() {
    atk = null;
    $("attack-overlay").hidden = true;
    $("attack-overlay").replaceChildren();
  }

  function renderAttack() {
    const root = $("attack-overlay");
    root.replaceChildren();
    const t = atk.targets.find(x => x.id === atk.cur);
    const panel = el("div", "atk-panel");

    const head = el("header", "atk-head");
    const icon = el("img");
    icon.alt = "";
    setImage(icon, atk.icon);
    const title = el("div");
    title.append(el("h2", "", atk.title), el("p", "", `Pick up to ${atk.total} cell${atk.total === 1 ? "" : "s"} · ${used()} / ${atk.total} chosen. You don't have to use them all.`));
    if (atk.note) title.append(el("p", "atk-note", atk.note));
    head.append(icon, title);

    const chips = el("div", "atk-chips");
    if (atk.targets.length > 1) for (const x of atk.targets) {
      const b = el("button", "chip" + (x.id === atk.cur ? " active" : ""));
      b.type = "button";
      if (x.kind === "wall") {
        b.append(el("i", "chip-wall"), document.createTextNode(`Wall (${x.x + 1}, ${x.y + 1})`));
      } else {
        const img = el("img");
        img.alt = "";
        setImage(img, classIcon(x.className));
        b.append(img, document.createTextNode(`${x.username} · ${x.className}`));
      }
      const n = atk.sel.get(x.id).size;
      if (n) b.append(el("i", "chip-count", String(n)));
      b.addEventListener("click", () => { atk.cur = x.id; renderAttack(); });
      chips.append(b);
    }

    const body = el("div", "atk-body");
    body.append(el("span", "atk-owner", t.kind === "wall" ? "The Wall's HP Grid" : `${t.username || t.name}'s HP Grid`));
    const grid = el("div", "hp-grid atk-grid");
    HGFx.buildGrid(grid, t.n);
    HGFx.applyCells(grid, t.hp, t.marks || {});
    const mine = atk.sel.get(t.id);
    [...grid.children].forEach((s, i) => {
      if (t.hp[i] > 0) s.classList.add("pickable");
      if (mine.has(i)) s.classList.add("picked");
    });
    grid.addEventListener("click", e => {
      const s = e.target.closest("span");
      if (!s) return;
      const i = [...grid.children].indexOf(s);
      if (t.hp[i] <= 0) return;
      if (mine.has(i)) mine.delete(i);
      else if (used() >= atk.total) return toast(`You only rolled ${atk.total}. Unselect a cell first.`);
      else mine.add(i);
      renderAttack();
    });
    body.append(grid);

    const foot = el("footer", "atk-foot");
    const cancel = el("button", "button quiet", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", closeAttack);
    const submit = el("button", "button primary", "Submit");
    submit.type = "button";
    submit.disabled = used() === 0;
    submit.addEventListener("click", () => {
      const picks = [];
      for (const [playerId, set] of atk.sel) for (const idx of set) picks.push({ playerId, idx });
      const who = atk.targets.filter(x => atk.sel.get(x.id).size).map(x => x.kind === "wall" ? `Wall (${x.x + 1}, ${x.y + 1})` : (x.username || x.name)).join(", ");
      ask(`Submit this attack? ${picks.length} damage on ${who}.`, () => { const go = atk.submit; closeAttack(); go(picks); });
    });
    foot.append(el("span", "atk-keep", "Cancel keeps your roll."), cancel, submit);

    panel.append(head, chips, body, foot);
    root.append(panel);
  }
  document.addEventListener("keydown", e => { if (e.key === "Escape" && atk) closeAttack(); });

  /* ================= Turn order strip (everyone) ================= */

  function renderStrip(root, b) {
    root.replaceChildren();
    const enc = b.enc;
    if (!enc || enc.phase === "prepare") { root.append(el("span", "strip-note", "Prepare Phase")); return; }
    if (enc.phase === "setup") {
      const alive = b.players.filter(p => p.inEncounter && !p.dead);
      root.append(el("span", "strip-note", `Setup Phase · ${alive.filter(p => p.ready).length}/${alive.length} ready`));
      return;
    }
    root.append(el("span", "strip-note", enc.phase === "paused" ? "Paused" : "Turn order"));
    for (const a of enc.order) {
      const ent = a.kind === "player" ? b.players.find(p => p.id === a.id) : b.monsters.find(m => m.id === a.id);
      if (!ent) continue;
      const out = a.kind === "player" ? (!ent.inEncounter || ent.dead) : !ent.hp.some(v => v > 0);
      const chip = el("div", "strip-chip" + (enc.turn && enc.turn.id === a.id ? " current" : "") + (out ? " out" : ""));
      chip.title = `${ent.username || ent.name}`;
      const img = el("img");
      img.alt = "";
      setImage(img, a.kind === "player" ? classIcon(ent.className) : ent.sprite);
      chip.append(img, el("b", "", String(a.num)), el("small", "", ent.username || ent.name));
      root.append(chip);
    }
  }

  socket.on("battle-state", b => {
    battle = b;
    renderStrip($("turn-strip"), b);
    renderStrip($("host-turn-strip"), b);
    const mine = b.enc && b.enc.phase === "running" && b.enc.turn && b.enc.turn.kind === "player" && b.enc.turn.id === socket.id;
    $("end-turn").hidden = !mine;
    if (A.isHost()) renderHostCombat();
  });
  $("end-turn").addEventListener("click", () => socket.emit("end-turn"));

  /* ================= Initiative (everyone sees the roll) ================= */

  let initTimer = null, initClose = null;
  function hideInit() {
    clearInterval(initTimer);
    clearTimeout(initClose);
    $("init-overlay").hidden = true;
  }
  $("init-overlay").addEventListener("click", hideInit);

  socket.on("initiative", data => {
    hideInit();
    const die = $("init-die"), list = $("init-list");
    list.replaceChildren();
    list.classList.remove("show");
    die.classList.add("rolling");
    die.dataset.sides = `D${data.sides}`;
    $("init-overlay").hidden = false;
    const num = die.querySelector("b");
    let ticks = 0;
    initTimer = setInterval(() => {
      num.textContent = 1 + Math.floor(Math.random() * data.sides);
      if (++ticks < 16) return;
      clearInterval(initTimer);
      die.classList.remove("rolling");
      num.textContent = data.sides;                       // the highest number goes first
      data.order.forEach((a, i) => {
        const li = el("li", "init-row");
        li.style.animationDelay = `${i * 0.12}s`;
        const img = el("img");
        img.alt = "";
        setImage(img, a.kind === "player" ? classIcon(a.className) : a.sprite);
        li.append(el("b", "init-num", String(a.num)), img, el("span", "", a.name), el("small", "", a.kind === "player" ? a.className : "Monster"));
        list.append(li);
      });
      list.classList.add("show");
      initClose = setTimeout(hideInit, 6000);
    }, 90);
  });

  window.HGHost = { openAttack, closeAttack };
  renderBench();
  renderSaved();
})();
