(() => {
  // Phones aren't supported: the grid, the hover tips and the aiming all need a mouse and a bigger screen.
  const phone = /Android.+Mobile|iPhone|iPod|Windows Phone|webOS|BlackBerry|Opera Mini/i.test(navigator.userAgent) ||
    (window.matchMedia?.("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 600);
  if (phone) {
    document.body.replaceChildren();
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:#0f0f12;color:#e9e9ef;font:600 20px/1.5 system-ui,sans-serif;text-align:center";
    box.textContent = "Incompatible on this device. I'm sorry.";
    document.body.append(box);
    return;
  }
  const socket = io();
  const $ = id => document.getElementById(id);

  /* ---------- Game data (client display only) ---------- */

  const HGC = window.HGCards, HGS = window.HGStructures;
  const HGFx = window.HGFx;
  const HGFxField = window.HGFxField;

  const CLASSES = ["Tank", "Warrior", "Support", "Mage", "Rogue"];
  const CLASS_INFO = {
  Tank:    { grid: 6, cap: 9,  regen: 3, description: "The Defensive Anchor of the team, diverting monster aggression through his toolkit in expense of him taking damage.",    cards: HGC.CLASS_CARDS.Tank },
  Warrior: { grid: 5, cap: 12, regen: 4, description: "The Raging Burst Damage Dealer of the team, through his massive temper he sacrifices his own health for stronger offensive power. Bursting down opponents in one swoop.", cards: HGC.CLASS_CARDS.Warrior },
  Support: { grid: 4, cap: 15, regen: 5, description: "The Team-Player that blesses Sustainability & Defensive Utility, with her light that shines bright she enables her team to be more offensive by reducing the punishments the monster may inflict.", cards: HGC.CLASS_CARDS.Support },
  Mage:    { grid: 3, cap: 20, regen: 5, description: "The AOE Energy Demon of the team, through her many offensive utilities that allows her to attack multiple opponents or punish passive actions of the monsters.",    cards: HGC.CLASS_CARDS.Mage },
  Rogue:   { grid: 3, cap: 15, regen: 6, description: "The Consistent Damage Dealer of the team, his deceptive control of the battlefield and his high energy regen that allows him to consistently be active while staying hidden through out encounters.",   cards: HGC.CLASS_CARDS.Rogue }
};
  const STARTER_CARD = { Tank: "guard", Warrior: "attack", Support: "heal", Mage: "blast", Rogue: "attack" };

  // Names, costs, ranges, hover text (tip) and detail text for every card live in card-data.js (shared with the server).
  const CARDS = HGC.CARDS;

  const ENERGY_TIP = "Energy decides how many actions you can take. Every card costs Energy, so the more Energy you have, the more cards you can use. Capacity is the most you can hold; Regen is how much you get back each turn.";

  const PRESETS = [
    { name: "Rook",   info: "2 cells forward in every direction, horizontally or vertically" },
    { name: "Bishop", info: "2 cells forward in every diagonal direction" },
    { name: "King",   info: "1 cell in every direction: diagonal, horizontal or vertical" },
    { name: "Pawn",   info: "2 steps forward, 1 diagonal forward, and 4 steps back" }
  ];

  /* ---------- State ---------- */

  let roomID = "";
  let username = "";
  let hostRoomID = "";
  let availableClasses = [];
  let activeClass = 0;
  let cardOffset = 0;
  let sliding = false;
  let chosenClass = "";
  let movement = [];
  let firstPattern = [];
  let cardMode = { type: "", limit: 2, assignmentId: null };   // first card (limit 2) or an issued card (limit 2-6)
  let pendingYes = null;
  let toastTimer;

  /* ---------- Small helpers ---------- */

  function showView(id) {
    document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
    window.scrollTo(0, 0);
  }

  function say(id, text = "") { $(id).textContent = text; }

  function toast(text) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
  }

  // Use the asset if it exists, otherwise fall back to missing.png.
  // A card png can live in its group folder (/assets/cards/hp-grid/attack.png) or directly in /assets/cards/ (/assets/cards/attack.png).
  function setImage(img, src) {
    const chain = window.HGCards.iconChain(src);          // own folder, then the other card folders (battlefield-grid too), then /assets/cards/
    let i = 0;
    img.onerror = () => {
      if (++i < chain.length) { img.src = chain[i]; return; }
      img.onerror = null;
      img.src = "/assets/missing.png";
    };
    img.src = chain[0];
  }
  const classIcon = name => `/assets/classes/${name.toLowerCase()}/${name.toLowerCase()}.png`;

  function ask(text, onYes) {
    say("confirm-text", text);
    pendingYes = onYes;
    $("confirm-dialog").hidden = false;
    $("confirm-yes").focus();
  }
  function closeAsk() { $("confirm-dialog").hidden = true; pendingYes = null; }

  $("confirm-no").addEventListener("click", closeAsk);
  $("confirm-yes").addEventListener("click", () => { const go = pendingYes; closeAsk(); if (go) go(); });
  $("confirm-dialog").addEventListener("click", e => { if (e.target === $("confirm-dialog")) closeAsk(); });
  $("card-dialog-close").addEventListener("click", () => { $("card-dialog").hidden = true; });
  $("card-dialog").addEventListener("click", e => { if (e.target === $("card-dialog")) $("card-dialog").hidden = true; });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeAsk(); $("card-dialog").hidden = true; $("assign-dialog").hidden = true; }
  });

  // Tooltips: anything with data-tip.
  const tip = $("tooltip");
  function placeTip(x, y) {
    const pad = 14;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(x + pad, innerWidth - w - 8)) + "px";
    tip.style.top = Math.max(8, Math.min(y + pad, innerHeight - h - 8)) + "px";
  }
  function showTip(el, x, y) {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    placeTip(x, y);
  }
  document.addEventListener("mouseover", e => {
    const el = e.target.closest("[data-tip]");
    if (el) showTip(el, e.clientX, e.clientY); else tip.hidden = true;
  });
  document.addEventListener("mousemove", e => { if (!tip.hidden) placeTip(e.clientX, e.clientY); });
  document.addEventListener("focusin", e => {
    const el = e.target.closest("[data-tip]");
    if (!el) return;
    const r = el.getBoundingClientRect();
    showTip(el, r.left, r.bottom);
  });
  document.addEventListener("focusout", () => { tip.hidden = true; });

  // Splash screen: any key, click or tap continues to the Main Menu.
  setImage($("splash-logo"), "assets/heart-grid-logo.png"); // missing.png until you add the logo
  function leaveSplash(e) {
    if (!$("splash-screen").classList.contains("active")) return;
    e.preventDefault();
    document.removeEventListener("keydown", leaveSplash);
    document.removeEventListener("pointerdown", leaveSplash);
    $("splash-screen").classList.add("leaving");           // fade the splash away...
    setTimeout(() => {                                      // ...then show the Main Menu
      showView("home-screen");
      $("splash-screen").classList.remove("leaving");
    }, 600);                                                // keep in sync with the .6s in the CSS
  }
  document.addEventListener("keydown", leaveSplash);
  document.addEventListener("pointerdown", leaveSplash);

  // Menu navigation
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => showView(b.dataset.go)));

  function resetPlayer() {
    roomID = ""; username = ""; chosenClass = ""; movement = []; firstPattern = []; availableClasses = [];
    $("room-input").value = ""; $("name-input").value = "";
    $("class-stage").hidden = true;
    say("join-message");
  }

  /* ---------- Host ---------- */

  $("create-room-button").addEventListener("click", () => {
    $("create-room-button").disabled = true;
    socket.emit("create-room");
  });

  socket.on("room-created", data => {
    hostRoomID = data.roomID;
    $("host-room-id").hidden = false;
    $("host-room-id").querySelector("strong").textContent = hostRoomID;
    $("create-room-button").textContent = "Room Created";
    renderHostPlayers([]);
  });

  socket.on("room-state", state => { hostPlayers = state.players || []; renderHostPlayers(hostPlayers); });
  socket.on("assign-result", r => toast(r.message));
  socket.on("notice", r => toast(r.message));

  let hostPlayers = [];
  let dragId = null;

  function renderHostPlayers(players) {
    const list = $("host-players");
    list.replaceChildren();
    if (!hostRoomID) return;
    if (!players.length) {
      const empty = document.createElement("p");
      empty.className = "host-empty";
      empty.textContent = "Waiting for players to join…";
      list.append(empty);
      return;
    }
    players.forEach(p => {
      const card = document.createElement("article");
      card.className = "host-player" + (p.dead ? " is-dead" : "");
      card.draggable = true;
      card.title = "Drag onto an assignment";
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      setImage(img, classIcon(p.className));
      const text = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = p.username;
      const cls = document.createElement("span");
      cls.textContent = p.className;
      const status = document.createElement("small");
      status.className = "host-status";
      status.textContent = [
        p.dead ? "Dead" : p.inEncounter ? "In encounter" : "Out of encounter",
        `Energy ${p.energy}/${p.cap}`,
        p.pending ? `${p.pending} pending` : ""
      ].filter(Boolean).join(" · ");
      text.append(name, cls, status);
      card.append(img, text);
      card.addEventListener("dragstart", e => {
        dragId = p.id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", p.id);
        card.classList.add("dragging");
      });
      card.addEventListener("dragend", () => {
        dragId = null;
        card.classList.remove("dragging");
        document.querySelectorAll(".zone-drop").forEach(z => z.classList.remove("over"));
      });
      list.append(card);
    });
  }

  /* Assignments: drop a player card on one of the six zones */

  document.querySelectorAll(".zone-drop").forEach(zone => {
    zone.addEventListener("dragover", e => { if (dragId) { e.preventDefault(); zone.classList.add("over"); } });
    zone.addEventListener("dragleave", () => zone.classList.remove("over"));
    zone.addEventListener("drop", e => {
      e.preventDefault();
      zone.classList.remove("over");
      const player = hostPlayers.find(p => p.id === dragId);
      if (player) startAssignment(zone.dataset.kind, player);
    });
  });

  function assignDialog(title, fields, onSend) {
    say("assign-title", title);
    $("assign-fields").replaceChildren(...fields);
    $("assign-dialog").hidden = false;
    $("assign-ok").onclick = () => { if (onSend() !== false) $("assign-dialog").hidden = true; };
    $("assign-fields").querySelector("input, select")?.focus();
  }
  $("assign-cancel").addEventListener("click", () => { $("assign-dialog").hidden = true; });
  $("assign-dialog").addEventListener("click", e => { if (e.target === $("assign-dialog")) $("assign-dialog").hidden = true; });

  function field(label, control) {
    const l = document.createElement("label");
    l.className = "field";
    const t = document.createElement("span");
    t.textContent = label;
    l.append(t, control);
    return l;
  }

  function startAssignment(kind, p) {
    const send = extra => socket.emit("host-assign", { playerId: p.id, kind, ...extra });

    if (kind === "energy") {
      const input = document.createElement("input");
      input.type = "number"; input.min = 1; input.max = 99; input.value = 5;
      assignDialog(`Give Energy to ${p.username}`, [field("Amount (1-99)", input)], () => {
        const amount = Number(input.value);
        if (!Number.isInteger(amount) || amount < 1 || amount > 99) { toast("Energy must be a whole number from 1 to 99."); return false; }
        send({ amount });
      });
    } else if (kind === "materials") {
      const HS = window.HGShop;
      const mat = document.createElement("select");
      HS.MAT_KEYS.forEach(k => mat.add(new Option(HS.MATERIALS[k].name, k)));
      const input = document.createElement("input");
      input.type = "number"; input.min = 1; input.max = HS.MAX_COST; input.value = 5;
      assignDialog(`Give Materials to ${p.username}`, [field("Material", mat), field(`Amount (1-${HS.MAX_COST})`, input)], () => {
        const amount = Number(input.value);
        if (!Number.isInteger(amount) || amount < 1 || amount > HS.MAX_COST) { toast(`Amount must be a whole number from 1 to ${HS.MAX_COST}.`); return false; }
        send({ mat: mat.value, amount });
      });
    } else if (kind === "card") {
      const type = document.createElement("select");
      CLASS_INFO[p.className].cards.forEach(t => type.add(new Option(CARDS[t].name, t)));
      const pos = document.createElement("select");
      for (let n = 2; n <= 6; n++) pos.add(new Option(`${n} positions`, n));
      assignDialog(`Issue a Card to ${p.username}`, [field("Card type", type), field("Positions (2 to 6)", pos)],
        () => send({ cardType: type.value, positions: Number(pos.value) }));
    } else if (kind === "join") {
      ask(`Send Join Encounter to ${p.username}? They accept it in Preparation.`, () => send({}));
    } else if (kind === "leave") {
      ask(`Remove ${p.username} from the encounter now?`, () => send({}));
    } else if (kind === "kill") {
      ask(`Kill ${p.username}? Their HP Grid is emptied.`, () => send({}));
    } else if (kind === "revive") {
      ask(`Revive / reset the HP of ${p.username}?`, () => send({}));
    }
  }

  function leaveHost() {
    socket.emit("close-room");
    hostRoomID = "";
    $("host-room-id").hidden = true;
    $("create-room-button").disabled = false;
    $("create-room-button").textContent = "Create Room";
    renderHostPlayers([]);
    showView("home-screen");
  }
  $("host-back").addEventListener("click", () => {
    if (hostRoomID) ask("Proceeding would remove all the saved Monsters and Cards. Do you wish to proceed?", () => ask("Are you sure?", leaveHost));
    else showView("home-screen");
  });

  /* ---------- Player: Room ID, then class infographic ---------- */

  $("room-input").addEventListener("input", e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  });
  ["room-input", "name-input"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") tryJoin(); }));
  $("join-button").addEventListener("click", tryJoin);

  function tryJoin() {
    roomID = $("room-input").value.trim().toUpperCase();
    username = $("name-input").value.trim();
    if (roomID.length !== 6) return say("join-message", "Enter the 6-character Room ID.");
    if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(username)) return say("join-message", "Name must be 2-16 letters, numbers, spaces, _ or -.");
    say("join-message");
    socket.emit("check-room", roomID);
  }

  socket.on("room-availability", data => {
    if (!data.exists) {
      $("class-stage").hidden = true;
      return say("join-message", "That Room ID was not found.");
    }
    availableClasses = data.availableClasses || [];
    say("join-message");
    // Start on a class that is still open.
    const firstOpen = CLASSES.findIndex(c => availableClasses.includes(c));
    activeClass = firstOpen === -1 ? 0 : firstOpen;
    $("class-stage").hidden = false;
    renderClass();
    if (!availableClasses.length) say("join-message", "Every class in this room is taken.");
  });

  function renderClass() {
    const name = CLASSES[activeClass];
    const info = CLASS_INFO[name];
    const key = name.toLowerCase();
    const taken = !availableClasses.includes(name);

    $("class-name").textContent = name;
    $("class-description").textContent = info.description;
    $("hp-size").textContent = `${info.grid}×${info.grid}`;
    $("energy-cap").textContent = info.cap;
    $("energy-regen").textContent = `+${info.regen}`;
    $("energy-box").dataset.tip = ENERGY_TIP;

    const hp = $("hp-grid");
    hp.style.setProperty("--n", info.grid);
    hp.replaceChildren(...Array.from({ length: info.grid * info.grid }, () => document.createElement("span")));

    setImage($("character-img"), `/assets/classes/${key}/character.png`); // not made yet -> missing.png
    setImage($("class-icon"), classIcon(name));

    $("class-slide").classList.toggle("is-taken", taken);
    $("taken-text").hidden = !taken;
    $("confirm-class-button").disabled = taken;

    cardOffset = 0;
    renderCards();
  }

  function renderCards() {
    const cards = CLASS_INFO[CLASSES[activeClass]].cards;
    const maxOffset = Math.max(0, cards.length - 3);
    $("card-prev").disabled = cardOffset <= 0;
    $("card-next").disabled = cardOffset >= maxOffset;
    $("card-row").replaceChildren(...cards.slice(cardOffset, cardOffset + 3).map(type => {
      const data = CARDS[type];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "card";
      b.dataset.tip = data.text;
      const img = document.createElement("img");
      img.alt = "";
      setImage(img, CARDS[type].icon);
      const label = document.createElement("strong");
      label.textContent = data.name;
      b.append(img, label);
      b.addEventListener("click", () => openCard(type));
      return b;
    }));
  }

  $("card-prev").addEventListener("click", () => { cardOffset--; renderCards(); });
  $("card-next").addEventListener("click", () => { cardOffset++; renderCards(); });

  // The current class slides out, the next one slides in. Only one is ever on screen.
  async function switchClass(step) {
    if (sliding) return;
    sliding = true;
    tip.hidden = true;
    const slide = $("class-slide");
    const away = step > 0 ? -1 : 1;
    const out = slide.animate(
      [{ transform: "translateX(0)", opacity: 1 }, { transform: `translateX(${away * 115}%)`, opacity: 0 }],
      { duration: 220, easing: "ease-in", fill: "forwards" }
    );
    await out.finished;
    activeClass = (activeClass + step + CLASSES.length) % CLASSES.length;
    renderClass();
    out.cancel();
    await slide.animate(
      [{ transform: `translateX(${-away * 115}%)`, opacity: 0 }, { transform: "translateX(0)", opacity: 1 }],
      { duration: 260, easing: "ease-out" }
    ).finished;
    sliding = false;
  }
  $("class-prev").addEventListener("click", () => switchClass(-1));
  $("class-next").addEventListener("click", () => switchClass(1));

  $("confirm-class-button").addEventListener("click", () => {
    const name = CLASSES[activeClass];
    ask(`Play as ${name}?`, () => {
      chosenClass = name;
      movement = [];
      buildMovement();
      showView("movement-screen");
    });
  });

  /* ---------- Card details (click a card) ---------- */
  // The detailed version: what the card costs, how far it reaches, how to use it, and a looping animation of what it does
  // to a sample 5x5 HP Grid using the card's own pattern.

  function demoGrid(kind, on, over = []) {
    const g = document.createElement("div");
    g.className = `demo-grid ${kind}`;
    for (let i = 0; i < 9; i++) {
      const s = document.createElement("span");
      if (on.includes(i)) s.classList.add("on");
      if (over.includes(i)) s.classList.add("over");
      g.append(s);
    }
    return g;
  }

  function demoStep(label, grid) {
    const d = document.createElement("div");
    d.className = "demo-step";
    const l = document.createElement("small");
    l.textContent = label;
    d.append(grid, l);
    return d;
  }

  const DN = 5;                                    // sample grid size in the dialog
  const dMarks = () => ({ guard: Array(DN * DN).fill(null), ret: Array(DN * DN).fill(0), curse: Array(DN * DN).fill(0), armor: Array(DN * DN).fill(0) });
  const dSnap = (cells, marks) => ({ cells: [...cells], marks: { guard: [...marks.guard], ret: [...marks.ret], curse: [...marks.curse], armor: [...(marks.armor || [])] } });
  const dNeighbors = i => {
    const x = i % DN, y = Math.floor(i / DN), out = [];
    if (y > 0) out.push(i - DN);
    if (y < DN - 1) out.push(i + DN);
    if (x > 0) out.push(i - 1);
    if (x < DN - 1) out.push(i + 1);
    return out;
  };

  // Builds fake "fx steps" in the same shape the server sends, so the dialog plays the real animations.
  function buildDemo(type, pattern) {
    const cells = HGC.aimCells(pattern, { x: 2, y: 2 }, DN);
    const full = Array(DN * DN).fill(1);
    const picks = [7, 21, 13, 3, 17, 11].slice(0, Math.max(1, pattern.length));
    const mk = (anim, bC, bM, aC, aM, changes, extra = {}) => ({
      anim, target: { kind: "monster", id: "demo", name: "Sample", n: DN },
      before: dSnap(bC, bM), after: dSnap(aC, aM), changes, ...extra
    });
    const dmg = (before, idxs) => {
      const after = [...before], ch = [];
      for (const i of idxs) { if (after[i] <= 0) continue; ch.push({ idx: i, from: after[i], to: after[i] - 1, wave: 0 }); after[i]--; }
      return { after, ch };
    };
    const marked = key => {
      const m = dMarks();
      cells.forEach(i => { m[key][i] = key === "guard" ? "tank" : 1; });
      return mk(key === "guard" ? "guard" : key === "ret" ? "retaliate" : "curse", full, dMarks(), full, m, cells.map(i => ({ idx: i, mark: key, on: true })));
    };

    switch (type) {
      case "attack":
      case "blast": {
        const before = [...full];
        if (cells.length > 1) before[cells[0]] = 2;          // one Over-heal cell to show both outcomes
        const { after, ch } = dmg(before, cells);
        return { steps: [mk(type === "blast" ? "blast" : "pop", before, dMarks(), after, dMarks(), ch)], caption: "Healthy cells become empty. The Over-heal cell (blue square) only loses its Over-heal." };
      }
      case "heal": {
        const before = [...full], after = [...full], ch = [];
        cells.forEach((i, k) => { before[i] = k % 2 === 0 ? 0 : 1; after[i] = before[i] + 1; ch.push({ idx: i, from: before[i], to: after[i], wave: 0 }); });
        return { steps: [mk("heal", before, dMarks(), after, dMarks(), ch)], caption: "Empty cells return as healthy cells. Healthy cells gain an Over-heal square." };
      }
      case "guard": return { steps: [marked("guard")], caption: "Light blue marks. Hits on them go to the Tank instead. The Host can't see them." };
      case "retaliate": return { steps: [marked("ret")], caption: "Deep green marks. Each one that is hit hits the attacker back for 1." };
      case "curse": {
        const m = dMarks();
        cells.forEach(i => { m.curse[i] = 1; });
        const start = cells[0], after = [...full], ch = [], m2 = { ...dMarks(), curse: [...m.curse] };
        const hit = (i, w) => { if (after[i] <= 0) return false; ch.push({ idx: i, from: after[i], to: after[i] - 1, wave: w }); after[i]--; return true; };
        hit(start, 0); m2.curse[start] = 0; ch.push({ idx: start, mark: "curse", on: false, wave: 0 });
        let wave = [start], w = 0;
        while (wave.length) {
          w++;
          const next = [];
          for (const c of wave) for (const nb of dNeighbors(c)) {
            if (!hit(nb, w)) continue;
            if (m2.curse[nb]) { m2.curse[nb] = 0; ch.push({ idx: nb, mark: "curse", on: false, wave: w }); next.push(nb); }
          }
          wave = next;
        }
        return {
          steps: [marked("curse"), mk("pop", full, m, after, m2, ch)],
          caption: "Marks do nothing until a marked cell is damaged. Then it explodes onto the cells around it, and chains through other curses."
        };
      }
      case "rage": {
        const { after, ch } = dmg(full, cells);
        return { steps: [mk("rage", full, dMarks(), after, dMarks(), ch)], caption: `Each sacrificed cell gives 2 Energy. This pattern: +${cells.length * 2}.`, self: true };
      }
      case "execute": {
        const { after, ch } = dmg(full, picks);
        return { steps: [mk("execute", full, dMarks(), after, dMarks(), ch)], caption: "One random healthy or Over-heal cell per position. No aiming." };
      }
      case "poison": {
        const { after, ch } = dmg(full, picks.slice(0, 2));
        return { steps: [mk("poison", full, dMarks(), after, dMarks(), ch, { caption: "Poison 3 > 2" })], charge: { from: 0, to: pattern.length }, caption: "Every Attack you use spends 1 charge: random 1 up to the card's positions damage, eaten by acid." };
      }
      case "lifesteal": {
        const before = [...full];
        [0, 1, 5, 6].forEach(i => { before[i] = 0; });
        const after = [...before], ch = [];
        [0, 1].forEach(i => { after[i] = 1; ch.push({ idx: i, from: 0, to: 1, wave: 0 }); });
        const st = mk("lifesteal", before, dMarks(), after, dMarks(), ch, { caption: "Lifesteal 2 > 0" });
        st.target = { kind: "player", id: "you", name: "Your", n: DN };
        return { steps: [st], charge: { from: 0, to: pattern.length }, caption: "Every cell your Attack damages spends 1 charge and heals one empty cell. Never Over-heal.", player: true };
      }
      case "taunt": case "counter": {                              // charge / turn based: a sample battlefield instead of an HP Grid
        const st = HGFxField.stage(type);
        return { field7: st, caption: st.caption, charge: { from: 0, to: pattern.length, unit: type === "counter" ? "rounds" : "charges" } };
      }
      case "spellvamp": {
        const before = [...full], after = [...full], bm = dMarks(), am = dMarks(), ch = [];
        const [a, b = a] = cells;
        bm.armor[a] = 1;                                            // one Armored cell...
        ch.push({ idx: a, mark: "armor", on: false });
        before[b] = 2; after[b] = 1;                                // ...and one Over-heal cell (the same cell if the pattern has one position)
        ch.push({ idx: b, from: 2, to: 1, wave: 0 });
        const gain = 2;
        return { steps: [mk("spellvamp", before, bm, after, am, ch, { caption: `Spellvamp 0 > ${gain}` })], charge: { from: 0, to: gain }, caption: "The cells shake wildly in purple, then pop away with their Armor and Over-heal. Each layer taken gives you 1 charge for Blast." };
      }
      case "penetrate": {
        const armored = [6, 8, 16, 18], bm = dMarks(), am = dMarks(), ch = [];
        armored.forEach(i => { bm.armor[i] = 1; am.armor[i] = 1; });
        [6, 18].forEach(i => { am.armor[i] = 0; ch.push({ idx: i, mark: "armor", on: false }); });
        return { steps: [mk("penetrate", full, bm, full, am, ch, { caption: "Penetrate 2 > 0" })], charge: { from: 0, to: pattern.length }, caption: "After your Attack, every charge left sends a lance through the Armor of a random Armored cell, however far away it is." };
      }
      case "hex": return { field: "hex", caption: "Everyone in the 3x3 around the Mage pays 2 less Energy per card (min 0.5). The Mage too, except for Hex cards." };
      case "buff": return { field: "buff", caption: "The teammate gains 1.5 Energy per position. You pay 1 per position." };
      case "weaken": return { field: "weaken", caption: "A pink spark lands on the Monster: it gets Weaken charges. Its next Attack rolls are lowered by 1 per charge." };
      case "shield": return { field: "shield", caption: "A blue spark lands on your teammate: for the rounds of the Shield Monsters can't target them. When it ends they can't be shielded again for 3 rounds longer." };
      // Battlefield cards: a 7x7 sample grid (js/fx-field.js)
      case "trail": case "smoke": case "clone": case "force": case "gravity": case "hold": case "move": case "presence": {
        const st = HGFxField.stage(type);
        return st ? { field7: st, caption: st.caption, ...(type === "presence" ? { charge: { from: 0, to: pattern.length, unit: "rounds" } } : {}) } : null;
      }
      // Repair and Breach work on a Wall's HP Grid: shown on a 7x7 sample
      case "repair": case "breach": {
        const N = 7, c7 = HGC.aimCells(pattern, { x: 3, y: 3 }, N) || [];
        const before = Array(N * N).fill(1);
        const mk7 = (anim, b, a, ch) => ({
          anim, target: { kind: "wall", id: "demo", name: "Sample Wall", n: N },
          before: { cells: [...b], marks: { guard: Array(N * N).fill(null), ret: Array(N * N).fill(0), curse: Array(N * N).fill(0) } },
          after: { cells: [...a], marks: { guard: Array(N * N).fill(null), ret: Array(N * N).fill(0), curse: Array(N * N).fill(0) } }, changes: ch
        });
        if (type === "breach") {
          const after = [...before], ch = [];
          c7.forEach(i => { ch.push({ idx: i, from: 1, to: 0, wave: 0 }); after[i] = 0; });
          return { n: N, steps: [mk7("breach", before, after, ch)], caption: "Like breaking a block in Minecraft, but in three heavy hits: THUD... THUD- THUD!! Every cell of the pattern cracks more with each hit, and the last one shatters it." };
        }
        const b = [...before], a = [...before], ch = [];
        c7.forEach((i, k) => { b[i] = k % 2 === 0 ? 0 : 1; a[i] = b[i] + 1; ch.push({ idx: i, from: b[i], to: a[i], wave: 0 }); });
        return { n: N, steps: [mk7("repair", b, a, ch)], caption: "A hammer hits each cell twice. Empty cells come back healthy, healthy cells gain an Over-heal square. Walls only." };
      }
      default: return null;                                   // Counter, Weaken, Shield, Penetrate, Spellvamp: no animated preview yet
    }
  }

  let demoRT = null;
  const stopDemo = () => { if (demoRT) { demoRT.skip(); demoRT = null; } };
  new MutationObserver(() => { if ($("card-dialog").hidden) stopDemo(); }).observe($("card-dialog"), { attributes: true, attributeFilter: ["hidden"] });

  function miniField(kind) {
    const f = document.createElement("div");
    f.className = "mini-field";
    const cells = [];
    for (let i = 0; i < 25; i++) { const c = document.createElement("div"); c.className = "bf-cell"; f.append(c); cells.push(c); }
    const put = (i, cls) => { const img = document.createElement("img"); img.alt = ""; setImage(img, classIcon(cls)); cells[i].classList.add("other"); cells[i].append(img); };
    if (kind === "hex") { put(12, "Mage"); put(13, "Warrior"); put(6, "Rogue"); put(24, "Tank"); [6, 7, 8, 11, 12, 13, 16, 17, 18].forEach(i => cells[i].classList.add("hex-aura")); }
    else if (kind === "weaken") {
      put(11, "Support");
      const m = document.createElement("img"); m.alt = ""; m.src = "/assets/monsters/devil.png"; cells[14].classList.add("monster"); cells[14].append(m);
    } else { put(11, "Support"); put(14, "Warrior"); }
    return { el: f, cells };
  }

  async function loopFieldDemo(rt, kind, mf) {
    const c = mf.cells;
    while (true) {
      if (kind === "hex") {
        await Promise.all([6, 7, 8, 11, 12, 13, 16, 17, 18].map(i => {
          const o = document.createElement("i");
          o.className = "bf-fx hex-pulse";
          c[i].append(o);
          return rt.anim(o, [{ transform: "scale(.2)", opacity: 0.9 }, { transform: "scale(1.15)", opacity: 0.7, offset: 0.5 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 1000 });
        }));
      } else {
        const tint = kind === "buff" ? "" : " " + kind;
        const spark = document.createElement("i");
        spark.className = "bf-spark" + tint;
        c[11].append(spark);
        spark.style.left = "50%"; spark.style.top = "50%";
        await rt.anim(spark, [{ transform: "translate(-50%,-50%) scale(.5)" }, { transform: `translate(calc(-50% + ${c[14].offsetLeft - c[11].offsetLeft}px), -50%) scale(1.4)` }], { duration: 800, easing: "ease-in-out" });
        spark.remove();
        const ring = document.createElement("i");
        ring.className = "bf-fx buff-ring" + tint;
        c[14].append(ring);
        await rt.anim(ring, [{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 450 });
      }
      await rt.wait(700);
      c.forEach(x => x.querySelectorAll(".bf-fx").forEach(o => o.remove()));
    }
  }

  function openCard(type, opts = {}) {
    stopDemo();
    const data = CARDS[type];
    const pattern = opts.pattern && opts.pattern.length ? opts.pattern : [4, 5];   // class list: an example 2-position pattern
    const pos = pattern.length;
    const self = me();
    const custom = opts.name && opts.name !== data.name;
    $("card-dialog-title").textContent = opts.name || data.name;
    const body = $("card-dialog-body");
    body.replaceChildren();
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

    // header: art + tags
    const head = el("div", "cd-head");
    const img = el("img");
    img.alt = "";
    setImage(img, data.icon);
    const tags = el("div", "cd-tags");
    tags.append(el("span", "tag", HGC.GROUP_LABEL[data.group]), el("span", "tag", `${pos} positions`));
    if (custom) tags.append(el("span", "tag", `${data.name} card`));
    if (!data.playable) tags.append(el("span", "tag soon", "Coming soon"));
    head.append(img, tags);

    const detail = el("p", "cd-detail", data.detail);

    // numbers
    const stats = el("dl", "cd-stats");
    const row = (k, v) => { stats.append(el("dt", "", k), el("dd", "", v)); };
    if (data.playable) {
      const base = HGC.baseCost(type, pos);
      const per = data.costPer;
      row("Energy", base === 0 ? "Free: costs nothing" : `${fmt(per)} per position × ${pos} = ${fmt(base)}`);
      if (base > 0) row("With Hex", `${fmt(HGC.discountedCost(type, pos))} (2 less, never below 0.5)`);
      const r = HGC.rangeOf(type, pos);
      row("Range", r === null ? (data.kind === "aura" ? "A 3×3 around you" : "None, it's for you") :
        data.rangeFixed ? "A 3×3 around you (1 cell outward)" : data.rangePer ? `${data.rangePer} per position × ${pos} = ${r} cells outward` : `positions − 1 = ${r} cell${r === 1 ? "" : "s"} outward${r === 1 ? ": you must stand next to it" : ""}`);
      row("Works on", type === "breach" ? "Walls (every cell hits) and Monsters (only 1 hit)" : { enemy: "Monsters and Walls (never teammates)", monster: "Monsters (never Walls or teammates)", structure: "Walls only", ally: type === "heal" ? "Teammates, or yourself" : "Teammates (never Monsters)", self: "Yourself" }[data.side] || "Yourself");
      if (data.give) row("Gives", `${fmt(data.give)} Energy per position = ${fmt(data.give * pos)}`);
      if (data.kind === "charge" || data.charges) row("Charges", `${pos} per use${data.charges ? ", put on the Monster" : ""}`);
      if (type === "weaken") row("Effect", "Each charge: its Attack roll is 1 lower (never below 0), then the charge is spent");
      if (data.kind === "turn") row("Lasts", `${pos} round${pos === 1 ? "" : "s"}`);
      if (data.fixedTurns) row("Lasts", `${data.fixedTurns} rounds, whatever the positions`);
      if (data.maintenance) row("Upkeep", `${data.maintenance} Energy at the start of each of your turns, even below 0. Use the card again to remove it for free.`);
      if (type === "shield") row("Then", `Shield Break for ${pos + 3} rounds: they can't be shielded again`);
      if (type === "spellvamp") row("Damage", "None. It strips Armor and Over-heal and gives you charges");
      if (data.kind === "grid" && data.side === "enemy" && type !== "spellvamp") row("Armor", `Armored cells punish you: −${fmt(HGC.ARMOR_PUNISH)} Energy each`);
      if (type === "poison") row("Damage", `random 1 to ${pos} per Attack`);
      if (type === "execute") row("Damage", `1 per position = ${pos} random cells`);
      if (self?.charges?.[type] > 0) row("Your charges", String(self.charges[type]));
      if (self?.turns?.[type] > 0) row("Your rounds left", String(self.turns[type]));
    }

    // how to use
    const how = el("ol", "cd-how");
    if (data.playable) {
      const steps = ["Drag the card out of its slot. The cells within its range light up while you drag."];
      steps.push(data.aim === "none"
        ? "Drop it on the battlefield. The grid glows yellow and the card is used."
        : "Drop it on the battlefield. The grid glows yellow when you can use it. It turns red and shakes if nothing is in range.");
      if (data.aim === "pattern") steps.push(`Pick the target if there is more than one, then aim: the ${data.side === "enemy" ? "red" : "yellow"} pattern follows your cursor and can't leave the HP Grid. Click to use.`);
      if (data.aim === "field") steps.push("Then click a cell of the battlefield in range: the pattern is placed around it. Esc or right-click cancels. Use the card again to remove it.");
      if (data.aim === "random") steps.push("Pick the Monster. The cells are chosen for you.");
      if (data.aim === "pick") steps.push(data.side === "monster" ? "Pick the Monster." : "Pick the teammate who gets it.");
      steps.push("The card icon shakes, then shows what it did. Everyone, including the Host, sees it. Press any key or click to skip.");
      how.append(...steps.map(s => el("li", "", s)));
    }

    // looping animation
    const demo = buildDemo(type, pattern);
    const stage = el("div", "cd-demo");
    let play = null;
    const chargeRow = d => {
      const row = el("div", "cd-charge"), ci = el("img");
      ci.alt = "";
      setImage(ci, data.icon);
      row.append(ci, el("span", "", "Using the card:"), ...[el("s", "", String(d.from)), el("span", "fx-arrow", ">"), el("b", "", String(d.to))], ...(d.unit ? [el("span", "", d.unit)] : []));
      return row;
    };
    if (demo?.field7) {
      stage.append(demo.field7.el);
      if (demo.charge) stage.append(chargeRow(demo.charge));
      stage.append(el("p", "cd-caption", demo.caption));
      play = rt => demo.field7.loop(rt);
    } else if (demo?.field) {
      const mf = miniField(demo.field);
      stage.append(mf.el, el("p", "cd-caption", demo.caption));
      play = rt => loopFieldDemo(rt, demo.field, mf);
    } else if (demo) {
      const parts = el("div", "cd-demo-row");
      const pat = data.noPattern ? null : demoStep("Your pattern", demoGrid("plain", pattern));
      const N = demo.n || DN;
      const grid = el("div", "hp-grid cd-grid" + (N > DN ? " big" : ""));
      HGFx.buildGrid(grid, N);
      const result = el("div", "demo-step");
      result.append(grid, el("small", "", demo.player ? "Your HP Grid" : demo.self ? "Your HP Grid" : "Sample HP Grid"));
      const arrow = el("span", "demo-arrow", "→");
      if (pat) parts.append(pat, arrow, result); else parts.append(result);
      const replay = el("button", "button quiet", "Replay");
      replay.type = "button";
      stage.append(parts);
      let charge = null;
      if (demo.charge) { charge = chargeRow(demo.charge); stage.append(charge); }
      stage.append(el("p", "cd-caption", demo.caption), replay);
      play = async rt => {
        while (true) {
          for (const st of demo.steps) await HGFx.playStep(rt, grid, st);
          if (!demo.steps.length) { HGFx.applyCells(grid, Array(N * N).fill(1), {}); }
          await rt.wait(1100);
        }
      };
      replay.addEventListener("click", () => start());
    } else if (data.playable === false) stage.append(el("p", "cd-caption", "The art and rules for this card come with encounters, initiative and dice."));

    function start() {
      stopDemo();
      if (!play) return;
      demoRT = HGFx.makeRT();
      const rt = demoRT;
      play(rt).catch(() => {});
    }

    body.append(head, detail, stats, demo || !data.playable ? stage : document.createComment(""), how);
    $("card-dialog").hidden = false;
    setTimeout(start, 120);
  }

/* ---------- Movement Pattern ---------- */
  // 9x9 grid, index = y*9 + x, center = 40.
  // Screen directions: Front = left, Right = top, Left = bottom, Back = right.

  const CENTER = 40;
  const at = (x, y) => y * 9 + x;

  function presetCells(name) {
    const cells = [];
    if (name === "Rook") for (let n = 1; n <= 2; n++) cells.push(at(4 - n, 4), at(4 + n, 4), at(4, 4 - n), at(4, 4 + n));
    if (name === "Bishop") for (let n = 1; n <= 2; n++) cells.push(at(4 - n, 4 - n), at(4 + n, 4 - n), at(4 - n, 4 + n), at(4 + n, 4 + n));
    if (name === "King") for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) if (x !== 4 || y !== 4) cells.push(at(x, y));
    if (name === "Pawn") {
      cells.push(at(3, 4), at(2, 4));            // 1 or 2 steps forward
      cells.push(at(3, 3), at(3, 5));            // 1 diagonal forward (front only)
      for (let x = 5; x <= 8; x++) cells.push(at(x, 4)); // 4 steps back
    }
    return cells;
  }

  // Every chosen cell must touch the center through other chosen cells (diagonals count).
  function connectedToCenter(cells) {
    const chosen = new Set(cells);
    const seen = new Set([CENTER]);
    const queue = [CENTER];
    while (queue.length) {
      const cur = queue.shift();
      const x = cur % 9, y = Math.floor(cur / 9);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx > 8 || ny < 0 || ny > 8) continue;
        const n = at(nx, ny);
        if (chosen.has(n) && !seen.has(n)) { seen.add(n); queue.push(n); }
      }
    }
    return cells.every(c => seen.has(c));
  }

  function buildMovement() {
    const grid = $("move-grid");
    grid.replaceChildren();
    for (let i = 0; i < 81; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cell";
      if (i === CENTER) {
        b.classList.add("center");
        b.disabled = true;
        b.textContent = "YOU";
      } else {
        b.addEventListener("click", () => {
          if (movement.includes(i)) movement = movement.filter(n => n !== i);
          else if (movement.length < 8) movement = [...movement, i];
          else return say("move-message", "A movement pattern has 8 cells at most.");
          clearPresetHighlight();
          refreshMovement();
        });
      }
      grid.append(b);
    }
    $("preset-list").replaceChildren(...PRESETS.map(p => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "preset";
      b.innerHTML = "<strong></strong><span></span>";
      b.querySelector("strong").textContent = p.name;
      b.querySelector("span").textContent = p.info;
      b.addEventListener("click", () => {
        movement = presetCells(p.name);
        clearPresetHighlight();
        b.classList.add("active");
        refreshMovement();
      });
      return b;
    }));
    refreshMovement();
  }

  function clearPresetHighlight() {
    document.querySelectorAll(".preset").forEach(p => p.classList.remove("active"));
  }

  function refreshMovement() {
    document.querySelectorAll("#move-grid .cell").forEach((c, i) => c.classList.toggle("selected", movement.includes(i)));
    $("move-count").textContent = movement.length;
    const ok = movement.length > 0 && connectedToCenter(movement);
    $("confirm-movement-button").disabled = !ok;
    say("move-message", movement.length && !ok ? "Every cell must connect back to the center." : "");
  }

  $("confirm-movement-button").addEventListener("click", () => {
    ask("Use this movement pattern?", () => {
      buildCard({ type: STARTER_CARD[chosenClass], limit: 2, assignmentId: null });
      showView("card-screen");
    });
  });

  /* ---------- First card / issued card ---------- */
  // Same screen for both: the first card (always 2 cells) and cards the Host issues (2 to 6 cells).
  // Both end with naming the card; the name starts as the card type's label.

  function buildCard(mode) {
    cardMode = mode;
    firstPattern = [];
    const issued = mode.assignmentId !== null;
    $("card-heading").textContent = issued ? "New Card" : "First Card";
    $("card-title").textContent = CARDS[mode.type].name;
    $("card-description").textContent = CARDS[mode.type].text;
    $("card-limit").textContent = mode.limit;
    $("card-name").value = CARDS[mode.type].name;
    $("confirm-card-button").textContent = issued ? "Save" : "Confirm";
    $("cancel-card-button").hidden = !issued;
    say("card-message");
     const grid = $("card-grid"), noPattern = !!CARDS[mode.type].noPattern;
     grid.parentElement.hidden = noPattern;                       // no grid editor for cards that never use their pattern
     const note = document.querySelector("#card-screen .warning");
     if (note) note.textContent = noPattern ? `${CARDS[mode.type].name} doesn't use a pattern, only its ${mode.limit} positions (they set its cost and range). Just name it and save.` : "If you don't know what you are doing, always start at the center.";
     grid.replaceChildren();
     if (noPattern) { firstPattern = [...Array(mode.limit).keys()]; refreshCard(); return; }
     for (let i = 0; i < 9; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cell";
      const noCenter = i === 4 && CARDS[mode.type].noCenter;                  // Gravity: the center is the pull point, so it can't be a position
      if (i === 4) { b.classList.add("center"); b.textContent = noCenter ? "NO CENTER" : "CENTER"; }
      if (noCenter) b.disabled = true;
      b.addEventListener("click", () => {
        if (firstPattern.includes(i)) firstPattern = firstPattern.filter(n => n !== i);
        else if (firstPattern.length < cardMode.limit) firstPattern = [...firstPattern, i];
        refreshCard();
      });
      grid.append(b);
    }
    refreshCard();
  }

  function refreshCard() {
    document.querySelectorAll("#card-grid .cell").forEach((c, i) => c.classList.toggle("selected", firstPattern.includes(i)));
    $("card-count").textContent = firstPattern.length;
    $("confirm-card-button").disabled = firstPattern.length !== cardMode.limit;
  }

  $("confirm-card-button").addEventListener("click", () => {
    const name = $("card-name").value.trim();
    if (!name || name.length > 16) return say("card-message", "Give the card a name (1-16 characters).");
    say("card-message");
    const issued = cardMode.assignmentId !== null;
    ask(issued ? `Save "${name}"?` : `Confirm "${name}" and join the room?`, () => {
      $("confirm-card-button").disabled = true;
      if (issued) {
        socket.emit("submit-card", { assignmentId: cardMode.assignmentId, name, pattern: firstPattern });
      } else {
        socket.emit("join-room", {
          roomID, username, className: chosenClass,
          movementPattern: movement,
          firstCard: { type: cardMode.type, name, pattern: firstPattern }
        });
      }
    });
  });

  $("cancel-card-button").addEventListener("click", () => {
    showView("lobby-screen");
    setTab("character");
    setSub("preparation");
  });

  socket.on("card-saved", () => {
    toast("Card saved.");
    showView("lobby-screen");
    setTab("character");
    setSub("overview");
  });
  socket.on("card-error", err => { toast(err.message); refreshCard(); });

  socket.on("join-error", err => {
    const message = typeof err === "string" ? err : err.message;
    toast(message);
    if (err.refresh) {
      // The class (or room) changed while this player was setting up: go back to the class list.
      showView("player-screen");
      socket.emit("check-room", roomID);
    } else {
      refreshCard();
    }
  });

  /* ---------- Player Panel: tabs ---------- */

  function setTab(tab) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    $("stage").dataset.tab = tab;
    tip.hidden = true;
    closeAim();
    if (tab === "activities" && $("lobby-screen").classList.contains("active")) socket.emit("training-enter");   // a fresh sandbox for you each visit
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => setTab(t.dataset.tab)));

  // Character tab: Character (class sheet) / Preparation (assignments) / Inventories
  function setSub(sub) {
    document.querySelectorAll("#character-pane .subtab, .character-pane .subtab").forEach(t => t.classList.toggle("active", t.dataset.sub === sub));
    $("character-pane").dataset.sub = sub;
  }
  document.querySelectorAll(".subtab:not(.act-subtab)").forEach(t => t.addEventListener("click", () => setSub(t.dataset.sub)));

  /* ---------- Battlefield ---------- */
  // Two fields share the same code: the real Combat battlefield and the 5x5 Training field.
  // Movement pattern cell (9x9, index = y*9 + x, center 40) = offset from the player: dx = x-4, dy = y-4.
  // Energy cost = ring distance: the nearest ring costs 1, the farthest of the 9x9 costs 4. Training moves are free.

  const MAX_CARDS = 4;
  let battle = { players: [], monsters: [], hexAura: [] };
  let train = null;                       // private Training sandbox state from the server
  let trainTurn = "player";               // Training: "player" = you use your cards, "dummy" = you control the Training Dummy's dice
  let myPattern = [];
  let myCards = [];
  let myAssignments = [];

  const moveCost = (dx, dy) => Math.max(Math.abs(dx), Math.abs(dy));
  const fmt = n => Number.isInteger(n) ? String(n) : n.toFixed(1);
  const me = () => battle.players.find(p => p.id === socket.id);
  const isMonster = e => !e.className;
  const isHost = () => !!hostRoomID;

  function createField(el) {
    const f = { el, cols: 0, rows: 0, cells: [], showReach: true, rerender: () => {} };
    f.build = (cols, rows) => {
      f.cols = cols; f.rows = rows; f.cells = [];
      el.style.setProperty("--cols", cols);
      el.style.setProperty("--rows", rows);
      el.replaceChildren();
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const c = document.createElement("button");
        c.type = "button";
        c.className = "bf-cell";
        c.dataset.x = x; c.dataset.y = y;
        c.style.gridColumn = x + 1; c.style.gridRow = y + 1;     // explicit, so the monster overlay never shifts the cells
        el.append(c);
        f.cells.push(c);
      }
    };
    f.cell = (x, y) => (x >= 0 && y >= 0 && x < f.cols && y < f.rows) ? f.cells[y * f.cols + x] : null;
    return f;
  }
  const combatField = createField($("battlefield"));
  const trainField = createField($("train-field"));

  // One picture for a whole structure (it spans its cells and turns with R). x0, y0 = the grid's first column / row.
  function structureArt(p, x0, y0) {
    const cells = HGS.cellsOf(p), r = (((p.rot || 0) % 4) + 4) % 4;
    const minX = Math.min(...cells.map(q => q.x)), maxX = Math.max(...cells.map(q => q.x));
    const minY = Math.min(...cells.map(q => q.y)), maxY = Math.max(...cells.map(q => q.y));
    const cw = maxX - minX + 1, ch = maxY - minY + 1;
    const el = document.createElement("div");
    el.className = "bf-struct";
    el.dataset.cells = cells.map(q => q.x + "," + q.y).join(";");
    el.style.gridColumn = `${minX - x0 + 1} / span ${cw}`;
    el.style.gridRow = `${minY - y0 + 1} / span ${ch}`;
    const img = document.createElement("img");
    img.alt = HGS.labelOf(p);
    const odd = r % 2 === 1;
    img.style.width = ((odd ? ch : cw) / cw * 100) + "%";           // the picture is drawn un-rotated, so on a quarter turn its box is swapped
    img.style.height = ((odd ? cw : ch) / ch * 100) + "%";
    img.style.transform = `translate(-50%, -50%) rotate(${r * 90}deg)`;
    setImage(img, HGS.iconUrl(HGS.iconOf(p)));
    el.append(img);
    if (p.ok) el.classList.add("working");
    if (p.heldBy) { el.classList.add("held"); el.style.setProperty("--glow", HGS.GLOW[p.heldClass] || "#fff"); }
    return el;
  }

  const cellsOf = e => {
    const out = [];
    for (let y = e.y; y < e.y + (e.h || 1); y++) for (let x = e.x; x < e.x + (e.w || 1); x++) out.push([x, y]);
    return out;
  };

  // Which columns this screen shows. Players: the Fog Area while standing in it, otherwise the Active + Class Areas.
  function fogView(st) {
    const full = { x0: 0, x1: st.cols - 1 };
    if (st.activeStart == null || st.training || !st.me) return full;
    if (st.enc?.phase === "prepare") return { x0: st.zoneStart, x1: st.cols - 1 };          // Prepare Phase: the Class Area only
    if (st.enc?.phase === "setup") return { x0: st.midCol, x1: st.cols - 1 };               // Setup Phase: the middle column, your 3 columns and the Class Area
    return st.me.inEncounter && st.me.x < st.activeStart ? { x0: 0, x1: st.activeStart - 1 } : { x0: st.activeStart, x1: st.cols - 1 };
  }

  // st = { cols, rows, zoneStart?, activeStart?, players, monsters, hexAura, me, training }
  function renderField(f, st) {
    if (f.cols !== st.cols || f.rows !== st.rows) f.build(st.cols, st.rows);
    const zs = st.zoneStart ?? Infinity;
    // Fog Area view: a player only sees the Fog Area (left third), or the Active + Class Areas. The Host and Training see it all.
    const v = f.view = fogView(st);
    f.el.style.setProperty("--cols", v.x1 - v.x0 + 1);
    for (const c of f.cells) {
      const cx = +c.dataset.x;
      c.style.display = cx < v.x0 || cx > v.x1 ? "none" : "";
      c.style.gridColumn = cx - v.x0 + 1;
    }
    f.el.querySelectorAll(".bf-monster, .bf-area, .bf-struct").forEach(m => m.remove());
    for (const c of f.cells) {
      const cx = +c.dataset.x, ph = st.enc?.phase;
      c.className = "bf-cell" + (cx >= zs ? " zone" : "") + (cx === zs ? " zone-edge" : "") + (st.activeStart != null && cx === st.activeStart - 1 ? " fog-edge" : "") +
        (ph === "setup" && cx === st.midCol ? " divider" : "") +
        (!st.me && !st.training && (ph === "prepare" || ph === "setup") && cx === st.midCol ? " host-mid" : "");   // the Host sees the no-placement column from the Prepare Phase on
      c.replaceChildren();
      c.removeAttribute("data-tip");
      const cy = +c.dataset.y;
      if (cy === 0) { const n = document.createElement("em"); n.className = "coord cx"; n.textContent = cx + 1; c.append(n); }                       // faint chess-style edge labels: numbers across the top...
      if (cx === v.x0) { const n = document.createElement("em"); n.className = "coord cy"; n.textContent = String.fromCharCode(65 + cy); c.append(n); }   // ...letters down the side
    }
    const D = st.dropship;                          // the Dropship Area: bottom-right 2x2 of the Class Area
    if (D) for (let y = D.y0; y < D.y0 + D.h; y++) for (let x = D.x0; x < D.x0 + D.w; x++) {
      const c = f.cell(x, y);
      if (!c) continue;
      c.classList.add("dropship", x === D.x0 ? "ds-l" : "ds-r", y === D.y0 ? "ds-t" : "ds-b");
      c.dataset.tip = `Dropship Area · ${HGS.cellName(x, y)}`;
      if (x === D.x0 && y === D.y0) { const t = document.createElement("span"); t.className = "drop-tag"; t.textContent = "Dropship Area"; c.append(t); }
    }
    const occupant = (x, y) => st.players.some(p => p.inEncounter && p.x === x && p.y === y) ||
      st.monsters.some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) ||
      (st.structures || []).some(s => s.x === x && s.y === y) ||
      (st.props || []).some(p => HGS.cellsOf(p).some(q => q.x === x && q.y === y));
    const pre = st.enc?.phase === "prepare" || st.enc?.phase === "setup";           // walking phases: no movement pattern, no Class Range
    const prevPos = f.prevPos || {}, nowPos = {};
    const slide = (from, to, el) => {                // the icon slides from the cell it was in (one walking step)
      if (!pre || !from || !el) return;
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      if (!a.width || !b.width) return;
      const dx = a.left - b.left, dy = a.top - b.top;
      if (Math.abs(dx) + Math.abs(dy) < 1 || Math.abs(dx) > b.width * 3 || Math.abs(dy) > b.width * 3) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 140, easing: "linear" });
    };

    for (const p of st.players) {
      if (!p.inEncounter) continue;
      const c = f.cell(p.x, p.y);
      if (!c) continue;
      const mine = st.me && p.id === st.me.id;
      c.classList.add(mine ? "mine" : "other");
      if (st.enc?.phase === "running" && st.enc.turn?.kind === "player" && st.enc.turn.id === p.id) c.classList.add("acting");
      if (p.dead) c.classList.add("dead");
      const img = document.createElement("img");
      img.alt = p.className;
      setImage(img, classIcon(p.className));
      c.append(img);
      c.append(...statusBadges(p));
      c.dataset.tip = `${p.username} · ${p.className}${mine ? " (you)" : ""}${p.dead ? " · dead" : ""}`;
      const was = prevPos["p" + p.id];
      if (was && (was.x !== p.x || was.y !== p.y)) slide(f.cell(was.x, was.y), c, img);
      nowPos["p" + p.id] = { x: p.x, y: p.y };
    }

    // Structures: a light gray Wall with its 2x2 HP Grid. A carried wall moves with its carrier.
    for (const s of st.structures || []) {
      const c = f.cell(s.x, s.y);
      if (!c) continue;
      c.classList.add("has-wall");
      c.dataset.tip = `Wall · ${HGS.cellName(s.x, s.y)} · HP Grid ${s.n}×${s.n}${s.carriedBy ? " · being carried" : ""}`;
      const body = document.createElement("i");
      body.className = "wall-body" + (s.carriedBy ? " carried" : "");
      const art = document.createElement("img");
      art.className = "wall-art"; art.alt = "Wall";
      setImage(art, HGS.iconUrl(HGS.WALL_ICON));
      body.append(art);
      for (let i = 0; i < s.n * s.n; i++) { const q = document.createElement("b"); if (!s.hp[i]) q.className = "gone"; body.append(q); }
      c.append(body);
      const was = prevPos["w" + s.id];
      if (was && (was.x !== s.x || was.y !== s.y)) slide(f.cell(was.x, was.y), c, body);
      nowPos["w" + s.id] = { x: s.x, y: s.y };
    }
    f.prevPos = nowPos;

    // Structure pieces (Shop, Wall Generator, Crafting Table, Quest Board). Hover shows the cell and whether the structure works.
    for (const p of st.props || []) {
      const cells = HGS.cellsOf(p), def = HGS.STRUCTURES[p.type];
      const names = cells.map(q => HGS.cellName(q.x, q.y)).join(", ");
      cells.forEach((q, i) => {
        const c = f.cell(q.x, q.y);
        if (!c) return;
        c.classList.add("prop", "prop-" + p.type);
        if (p.heldBy) { c.classList.add("prop-held"); c.style.setProperty("--glow", HGS.GLOW[p.heldClass] || "#fff"); }
        else c.style.removeProperty("--glow");
        c.dataset.tip = `${HGS.labelOf(p)} · ${names} · ${p.ok ? "working" : `not working (${p.linked}/${p.total} pieces connected)`}`;
      });
      if (cells.every(q => q.x >= v.x0 && q.x <= v.x1)) f.el.append(structureArt(p, v.x0, 0));
    }

    for (const m of st.monsters) {
      const down = !m.hp.some(v => v > 0);
      for (const [x, y] of cellsOf(m)) {
        const c = f.cell(x, y);
        if (!c) continue;
        c.classList.add("monster");
        c.dataset.tip = down ? `${m.name} · no HP left` : [m.name, m.hold > 0 ? `held for ${m.hold} more round${m.hold === 1 ? "" : "s"}` : "", m.weaken > 0 ? `weakened ×${m.weaken}` : ""].filter(Boolean).join(" · ");
      }
      const el = document.createElement("div");
      el.className = "bf-monster" + (down ? " down" : "") + (m.hold > 0 ? " held" : "") + (st.enc?.phase === "running" && st.enc.turn?.kind === "monster" && st.enc.turn.id === m.id ? " acting" : "");
      el.dataset.id = m.id;
      el.style.gridColumn = `${m.x - v.x0 + 1} / span ${m.w}`;
      if (m.x + m.w - 1 < v.x0 || m.x > v.x1) el.style.display = "none";
      el.style.gridRow = `${m.y + 1} / span ${m.h}`;
      const img = document.createElement("img");
      img.alt = m.name;
      setImage(img, m.sprite || "/assets/missing.png");
      el.append(img);
      f.el.append(el);
    }

    // Area names: Fog Area | Active Area | Class Area (only the ones in view)
    if (st.activeStart != null) {
      const areas = [["Fog Area", "fog", 0, st.activeStart - 1], ["Active Area", "active", st.activeStart, zs - 1], ["Class Area", "class", zs, st.cols - 1]];
      for (const [name, kind, a0, a1] of areas) {
        const s0 = Math.max(a0, v.x0), s1 = Math.min(a1, v.x1);
        if (s0 > s1) continue;
        const tag = document.createElement("div");
        tag.className = "bf-area " + kind;
        tag.textContent = name;
        tag.style.gridColumn = `${s0 - v.x0 + 1} / ${s1 - v.x0 + 2}`;
        f.el.append(tag);
      }
    }

    // Hex aura: everyone standing in the Mage's 3x3 pays 2 less Energy
    for (const a of st.hexAura || []) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) f.cell(a.x + dx, a.y + dy)?.classList.add("hex-aura");
    }

    // Your movement pattern, laid over the cells around you
    const self = st.me;
    // Class Range: a square centered on you. Monsters inside it are revealed to the whole team (left panel).
    const presenceUp = self?.className === "Tank" && self.turns?.presence > 0;
    const crN = st.classRangeN && self ? (presenceUp ? 7 : st.classRangeN[self.className]) : 0;
    if (!st.training && !pre) {
      for (const tk of st.players) {                                         // Presence: everyone sees the Tank's 7x7. Step in and the Monsters can see you.
        if (!(tk.className === "Tank" && tk.turns?.presence > 0 && tk.inEncounter && !tk.dead)) continue;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) f.cell(tk.x + dx, tk.y + dy)?.classList.add("presence-zone");
      }
      for (const s of st.smoke || []) f.cell(s.x, s.y)?.classList.add("smoke");     // only the players see the smoke
      for (const s of st.trail || []) f.cell(s.x, s.y)?.classList.add("trail");     // ...and only the Warrior and the Support the Trail (the server sends it just to them)
      for (const cl of st.clones || []) {                                            // the Clone: a ghost of the Rogue, visible to players only
        const c = f.cell(cl.x, cl.y);
        if (!c) continue;
        const g = document.createElement("img");
        g.className = "clone-ghost" + (st.me && cl.by === st.me.id ? " mine" : "");
        g.alt = "Clone";
        setImage(g, HGC.CARDS.clone.icon);
        c.append(g);
      }
    }
    if (crN && self.inEncounter && !self.dead && !st.training && !pre) {
      const r = (crN - 1) / 2;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx || dy) f.cell(self.x + dx, self.y + dy)?.classList.add("cr");
      }
    }
    if (self && self.inEncounter && !self.dead && f.showReach && !pre) {
      const free = st.training || st.freeMove;
      for (const i of myPattern) {
        const dx = (i % 9) - 4, dy = Math.floor(i / 9) - 4;
        const x = self.x + dx, y = self.y + dy;
        if (x < v.x0 || x > v.x1 || y < 0 || y >= st.rows || occupant(x, y)) continue;
        if (!HGC.pathClear(self, { x, y }, occupant)) continue;                 // can't jump over monsters, players or walls
        const onTrail = (self.className === "Warrior" || self.className === "Support") && (st.trail || []).some(t => t.x === x && t.y === y);    // Trail cells are free
        const dist = onTrail ? 0 : moveCost(dx, dy), cost = free ? 0 : dist;
        const c = f.cell(x, y);
        c.classList.add("reach", "c" + dist);
        const poor = !free && self.energy < cost;
        if (poor) c.classList.add("poor");
        const label = document.createElement("span");
        label.className = "cost";
        label.textContent = free ? "·" : cost;
        c.append(label);
        c.dataset.tip = st.training ? "Moving is free in Training" : st.freeMove ? "Moving is free right now" : poor ? `Costs ${cost} Energy: not enough Energy` : `Move here for ${cost} Energy`;
      }
    }
    tip.hidden = true;
  }

  function wireField(f, getSelf, move) {
    f.el.addEventListener("click", e => {
      const c = e.target.closest(".bf-cell");
      if (!c) return;
      const x = +c.dataset.x, y = +c.dataset.y;
      const self = getSelf();
      if (!self) return;
      if (x === self.x && y === self.y) {                                  // click yourself: hide / show the pattern (Combat only)
        const ph = f === combatField ? battle?.enc?.phase : null;
        if (ph === "prepare" || ph === "setup") return;
        f.showReach = !f.showReach; return f.rerender();
      }   // click yourself: hide / show the pattern
      if (!c.classList.contains("reach")) return;
      if (c.classList.contains("poor")) {
        c.classList.add("deny");
        setTimeout(() => c.classList.remove("deny"), 300);
        return toast("Not enough Energy to move there.");
      }
      move(x, y);
    });
  }

  let lastPhase = null, prevPhase = null;

  // Prepare -> Setup: the Active Area pops in from the left and slams onto the Class Area. Nobody moves.
  function dockActiveArea(f) {
    const mid = battle.midCol, edge = battle.zoneStart;
    const pieces = [...f.cells.filter(c => +c.dataset.x >= mid && +c.dataset.x < edge), ...f.el.querySelectorAll(".bf-area.active, .bf-area.fog")];
    f.el.querySelectorAll(".bf-monster").forEach(m => { if (m.style.display !== "none") pieces.push(m); });
    const first = f.cell(mid, 0), last = f.cell(edge - 1, 0);
    if (!first || !last || !f.el.getBoundingClientRect().width) return;
    const w = last.getBoundingClientRect().right - first.getBoundingClientRect().left;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const prevClip = f.el.style.overflow;
    f.el.style.overflow = "hidden";
    const anims = pieces.map(p => p.animate(
      [{ transform: `translateX(${-w - 80}px)`, opacity: 0 }, { transform: `translateX(${-w * 0.35}px)`, opacity: 1, offset: 0.35 }, { transform: "translateX(0)", opacity: 1 }],
      { duration: 650, easing: "cubic-bezier(.55, 0, .9, .5)", fill: "backwards" }
    ));
    Promise.all(anims.map(a => a.finished.catch(() => {}))).then(() => {            // the slam: the whole field jolts, the seam flashes
      f.el.style.overflow = prevClip;
      f.el.animate([{ transform: "translateX(0)" }, { transform: "translateX(7px)" }, { transform: "translateX(-5px)" }, { transform: "translateX(3px)" }, { transform: "translateX(0)" }], { duration: 300, easing: "ease-out" });
      for (let y = 0; y < f.rows; y++) {
        const c = f.cell(edge, y);
        c?.animate([{ boxShadow: "inset 0 0 0 2px #fff, 0 0 18px #f3c751" }, { boxShadow: "none" }], { duration: 450, easing: "ease-out" });
      }
    });
  }
  function renderCombat() {
    const ph = battle.enc?.phase;
    if (ph === "running" && lastPhase !== "running") combatField.showReach = true;   // Combat starts: always show your movement pattern
    lastPhase = ph;
    renderField(combatField, { ...battle, me: me(), training: false });
    paintFieldAim();
    paintMoveAim();
    if (typeof paintPropGhost === "function") paintPropGhost();
    if (typeof paintVision === "function") paintVision();
    renderClonePanel();
    paintCloneMode();
    if (prevPhase === "prepare" && ph === "setup" && me()) dockActiveArea(combatField);
    prevPhase = ph;
    const self = me(), a = battle.activeStart, canAct = !!self && self.inEncounter && !self.dead;
    $("fog-enter").hidden = !(canAct && self.x === a && battle.enc?.phase === "running");   // on the Active Area's left edge, only during an encounter
    $("fog-enter").classList.toggle("poor", !!self && self.energy < battle.fogCost);
    $("fog-leave").hidden = !(canAct && self.x === a - 1);                   // on the Fog Area's right edge
    $("fog-enter").textContent = battle.fogCost ? `Enter Fog Area · cost ${battle.fogCost} Energy` : "Enter Fog Area · free";
    $("ready-btn").hidden = !(battle.enc?.phase === "setup" && canAct);
    if (self) $("ready-btn").textContent = self.ready ? "Ready ✓ (click to undo)" : "Ready";
    $("carry-bar").hidden = !self?.carry;
    if (self?.carry) say("carry-text", `Carrying a wall with you. Click a cell to walk.`);
    renderGuide();
    renderTeamPanel();
    renderFogPanel();
    renderHud();
    renderCharacter();
    renderHand();
  }
  function renderTraining() {
    if (!train) return;
    renderField(trainField, { cols: train.cols, rows: train.rows, players: [train.player], monsters: [train.dummy], hexAura: train.hexAura, me: train.player, training: true });
    const d = $("train-dummy-grid");
    if (d.children.length !== train.dummy.n ** 2) HGFx.buildGrid(d, train.dummy.n);
    HGFx.applyCells(d, train.dummy.hp, train.dummy.marks);
    const p = $("train-me-grid");
    if (p.children.length !== train.player.n ** 2) HGFx.buildGrid(p, train.player.n);
    HGFx.applyCells(p, train.player.hp, train.player.marks);
    say("train-me-label", `${train.player.n}×${train.player.n}`);
    renderTrainTurn();
    renderHud();
    renderHand();
  }

  // Player's Turn / Dummy's Turn: you can flip it whenever you like. A new Dummy's Turn gives the dummy fresh dice.
  function renderTrainTurn() {
    const dummyTurn = trainTurn === "dummy";
    document.querySelectorAll("#train-turn .turn-btn").forEach(b => b.classList.toggle("active", b.dataset.turn === trainTurn));
    $("train-dice").classList.toggle("off", !dummyTurn);
    const dice = train?.dice || {};
    const left = dummyTurn ? dice.hitsLeft || 0 : 0;
    for (const die of ["attack", "heal"]) {
      const b = $("die-" + die), v = dice[die];
      b.disabled = !dummyTurn || (v !== null && v !== undefined);          // once per turn
      b.querySelector(".die-roll").textContent = v === null || v === undefined ? "-" : v;
    }
    $("train-attack-open").hidden = left < 1;
    say("train-dice-hint",
      !dummyTurn ? "Switch to Dummy's Turn to roll."
      : left > 0 && !dice.inRange ? `Attack rolled ${dice.attack}, but you are outside its range (${2 * dice.range + 1}×${2 * dice.range + 1}). Step closer on Player's Turn, then start a new Dummy's Turn.`
      : left > 0 ? `Attack rolled ${dice.attack}: choose up to ${left} cell${left === 1 ? "" : "s"} on your HP Grid.`
      : dice.attack === 0 ? "Attack rolled 0: nothing happens."
      : "Roll the Dummy's dice. Each die can be rolled once per turn.");
    // the Dummy's Range Grid, shown on the field during its turn
    if (train) for (const c of trainField.cells) {
      const d = HGC.cheb(train.dummy.x, train.dummy.y, +c.dataset.x, +c.dataset.y);
      c.classList.toggle("mon-range", dummyTurn && d > 0 && d <= dice.range);
    }
  }

  // The Dummy's attack picker: same screen the Host gets for a real monster, but you are the one choosing.
  function openTrainAttack() {
    if (!train || !(train.dice.hitsLeft > 0) || trainTurn !== "dummy") return;
    if (!train.dice.inRange) return toast("Nobody is in the Dummy's range. Step closer on Player's Turn.");
    window.HGHost?.openAttack({
      title: "Training Dummy attacks", icon: train.dummy.sprite, total: train.dice.hitsLeft,
      targets: [train.player],
      submit: picks => socket.emit("training-dummy-attack", { picks: picks.map(p => p.idx) })
    });
  }

  combatField.rerender = renderCombat;
  trainField.rerender = renderTraining;

  wireField(combatField, me, (x, y) => socket.emit("move", { x, y }));
  wireField(trainField, () => train?.player, (x, y) => {
    if (trainTurn === "dummy") return toast("It's the Dummy's Turn. Switch to Player's Turn to move.");
    socket.emit("training-move", { x, y });
  });

  // Fog Area transitions: the screen fades to black, the new view swaps in while it is black, then it fades back in.
  let fogHold = false, fogHeld = null;
  socket.on("battle-state", state => {
    if (fogHold) { fogHeld = state; return; }
    battle = state;
    renderCombat();
  });
  // "Prepare for your next battle": the Host's Energy blessing after an encounter, with a guide to what comes next.
  let blessTimer = null;
  socket.on("blessing", data => {
    clearTimeout(blessTimer);
    blessTimer = setTimeout(() => {
      say("bless-text", data.amount > 0 ? `Prepare for your next battle, you have all been blessed with ${fmtN(data.amount)} energy.` : "Prepare for your next battle.");
      $("bless-guide").hidden = true;
      $("bless-main").hidden = false;
      $("bless-dialog").hidden = false;
    }, data.wait || 300);
  });
  const fmtN = n => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  $("bless-continue").addEventListener("click", () => { $("bless-dialog").hidden = true; });
  $("bless-open-guide").addEventListener("click", () => { $("bless-main").hidden = true; $("bless-guide").hidden = false; });
  $("bless-back").addEventListener("click", () => { $("bless-guide").hidden = true; $("bless-main").hidden = false; });

  socket.on("fog-transition", () => {
    const fade = $("fog-fade");
    fogHold = true; fogHeld = null;
    closeAim();
    fade.classList.add("on");
    setTimeout(() => {
      fogHold = false;
      if (fogHeld) { battle = fogHeld; fogHeld = null; renderCombat(); }
      setTimeout(() => fade.classList.remove("on"), 300);
    }, 550);
  });
  // Prepare / Setup Phase: click a cell to walk there (the icon slides). Click a Wall for Move / Destroy.
  let menuWall = null;
  const closeWallMenu = () => { $("wall-menu").hidden = true; menuWall = null; };
  function openWallMenu(wall, ev) {
    const self = me(), setup = battle.enc.phase === "setup";
    const mine = wall.x >= battle.setupX0;
    const near = !!self && Math.abs(self.x - wall.x) + Math.abs(self.y - wall.y) === 1;
    menuWall = wall.id;
    $("wall-move").disabled = !(setup && mine && near && !wall.carriedBy && !self?.carry);
    $("wall-destroy").disabled = !(setup && mine && (!wall.carriedBy || wall.carriedBy === self?.id));
    say("wall-menu-note", !setup ? "Walls can only be moved or destroyed in the Setup Phase."
      : !mine ? "That wall is on the other side of the middle column."
      : wall.carriedBy && wall.carriedBy !== self?.id ? "Someone is carrying it."
      : !near ? "Stand right next to it (up, down, left or right) to move it." : "Move Wall: you and the wall walk together, up to 8 steps.");
    const m = $("wall-menu");
    m.hidden = false;
    m.style.left = Math.min(ev.clientX + 8, window.innerWidth - 250) + "px";
    m.style.top = Math.min(ev.clientY + 8, window.innerHeight - 190) + "px";
  }
  combatField.el.addEventListener("click", ev => {
    const ph = battle?.enc?.phase;
    if (ph !== "prepare" && ph !== "setup") return;
    const c = ev.target.closest(".bf-cell");
    if (!c || c.classList.contains("divider")) return;
    const x = +c.dataset.x, y = +c.dataset.y;
    const self = me();
    const holding = self?.holding && (battle.props || []).find(p => p.id === self.holding.id);
    const prop = (battle.props || []).find(p => HGS.cellsOf(p).some(q => q.x === x && q.y === y));
    if (holding) {                                 // moving a structure: click within reach puts it down there, farther away you walk (it comes along)
      closeWallMenu(); closePropMenu();
      if (c.classList.contains("mine")) return toast(`Click within ${HGS.REACH} cells to put it down, farther away to walk. Esc sets it down here.`);
      if (HGS.cheb(self.x, self.y, x, y) <= HGS.REACH) return socket.emit("prop-place", { x, y });
      return socket.emit("walk-to", { x, y });
    }
    if (prop) { closeWallMenu(); return openPropMenu(prop, ev); }       // structures: click one, then Move Structure / Use
    closePropMenu();
    const wall = (battle.structures || []).find(s => s.x === x && s.y === y);
    if (wall) return openWallMenu(wall, ev);
    closeWallMenu();
    if (c.classList.contains("mine") || c.classList.contains("other")) return;
    socket.emit("walk-to", { x, y });
  });

  /* ---- Structures: menu, aiming ghost, R / Esc ---- */
  let menuProp = null;
  const closePropMenu = () => { $("prop-menu").hidden = true; menuProp = null; };
  function openPropMenu(prop, ev) {
    const self = me(), def = HGS.STRUCTURES[prop.type];
    const near = !!self && HGS.touches(prop, self.x, self.y);
    menuProp = prop.id;
    say("prop-menu-name", HGS.labelOf(prop));
    const other = prop.heldBy && prop.heldBy !== self?.id;
    $("prop-move").disabled = !(near && !prop.heldBy && !self?.holding && !self?.carry && self?.inEncounter);
    const status = prop.ok ? "All pieces are connected: it works. " : `Not working: only ${prop.linked}/${prop.total} pieces are connected side by side. `;
    say("prop-menu-note", other ? "Someone is already moving it." : !near ? status + "Stand right next to it (up, down, left or right) to move it." : status + def.note);
    $("prop-use").hidden = !["generate", "soon", "shop"].includes(def.use);
    $("prop-use").textContent = def.use === "generate" ? (prop.gen ? "Generate Wall (used this encounter)" : "Generate Wall") : "Use";
    const m = $("prop-menu");
    m.hidden = false;
    m.style.left = Math.min(ev.clientX + 8, window.innerWidth - 250) + "px";
    m.style.top = Math.min(ev.clientY + 8, window.innerHeight - 190) + "px";
  }
  $("prop-move").addEventListener("click", () => { if (menuProp) socket.emit("prop-grab", { id: menuProp }); closePropMenu(); });
  $("prop-use").addEventListener("click", () => { if (menuProp) socket.emit("prop-use", { id: menuProp }); closePropMenu(); });
  document.addEventListener("click", ev => { if (menuProp && !ev.target.closest("#prop-menu") && !ev.target.closest(".prop")) closePropMenu(); });

/* ---- Vision Range (Combat) = your camera ----
     You always look through a 5x5 window of big cells. Move the camera with W A S D only (one whole cell per press, hold to keep going).
     Nothing is hidden. An arrow on a side means there is more grid that way; it goes away at the edge of the grid (it is only an indicator).
     Leash: you can look far, but the window must always keep at least ONE cell touching your Class Range.
     C (or moving) brings the camera back to you. ---- */
  const CAM_N = 5, CAM_H = (CAM_N - 1) / 2;
  const camView = $("cam-view");
  let cam = null;                                   // null = following you; otherwise the center cell the player panned to
  let camSelf = null;                               // where you were last time: moving brings the camera back to you
  const camOn = () => { const self = battle && me(); return !!self && battle.enc?.phase === "running" && self.inEncounter && !self.dead; };
  // Grid limits of the window center, plus the leash: |center - you| <= half a window + your Class Range radius (that is 1 cell of overlap).
  function camBounds() {
    const v = combatField.view || { x0: 0, x1: battle.cols - 1 };
    const b = { x0: v.x0 + CAM_H, x1: v.x1 - CAM_H, y0: CAM_H, y1: battle.rows - 1 - CAM_H };
    if (b.x1 < b.x0) b.x0 = b.x1 = (v.x0 + v.x1) / 2;                           // a grid narrower than the window: just center it
    if (b.y1 < b.y0) b.y0 = b.y1 = (battle.rows - 1) / 2;
    const self = me(), presenceUp = self.className === "Tank" && self.turns?.presence > 0;
    const crN = presenceUp ? 7 : battle.classRangeN?.[self.className] || 0;
    const L = { ...b };
    if (crN) {
      const reach = CAM_H + (crN - 1) / 2;
      L.x0 = Math.max(b.x0, self.x - reach); L.x1 = Math.min(b.x1, self.x + reach);
      L.y0 = Math.max(b.y0, self.y - reach); L.y1 = Math.min(b.y1, self.y + reach);
    }
    return { grid: b, lim: L };
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  function camCenter() {
    const self = me(), { grid, lim } = camBounds(), c = cam || { x: self.x, y: self.y };
    return { x: clamp(c.x, lim.x0, lim.x1), y: clamp(c.y, lim.y0, lim.y1), grid };
  }
  function panCam(dx, dy) {
    if (!camOn()) return;
    const c = camCenter();
    cam = { x: c.x + dx, y: c.y + dy };
    paintVision();
  }
  function paintVision() {
    const f = combatField, on = camOn();
    camView.classList.toggle("cam-on", on);
    f.el.classList.toggle("cam", on);
    const arrows = camView.querySelectorAll(".cam-arrow");
    if (!on) {
      f.el.style.removeProperty("--cam-x"); f.el.style.removeProperty("--cam-y");
      arrows.forEach(a => a.classList.remove("show"));
      cam = null; camSelf = null;
      return;
    }
    const self = me();
    if (camSelf && (camSelf.x !== self.x || camSelf.y !== self.y)) cam = null;      // you moved: the camera comes back to you
    camSelf = { x: self.x, y: self.y };
    const c = camCenter(), v = f.view || { x0: 0 };
    const a = f.cell(v.x0, 0), b = f.cell(v.x0 + 1, 0) || f.cell(v.x0, 1);
    const pitch = a && b ? Math.max(b.offsetLeft - a.offsetLeft, b.offsetTop - a.offsetTop) : 0;
    if (!pitch) return;
    f.el.style.setProperty("--cam-x", (-(c.x - CAM_H - v.x0) * pitch) + "px");
    f.el.style.setProperty("--cam-y", (-(c.y - CAM_H) * pitch) + "px");
    const g = c.grid, e = 0.01;                                                   // arrows: is there more GRID past the window on that side?
    const more = { up: c.y > g.y0 + e, down: c.y < g.y1 - e, left: c.x > g.x0 + e, right: c.x < g.x1 - e };
    arrows.forEach(el => { const k = el.classList.contains("up") ? "up" : el.classList.contains("down") ? "down" : el.classList.contains("left") ? "left" : "right"; el.classList.toggle("show", more[k]); });
  }
  window.addEventListener("resize", () => { if (camOn()) requestAnimationFrame(paintVision); });
  document.addEventListener("keydown", ev => {
    if (!camOn() || ev.ctrlKey || ev.metaKey || ev.altKey || ev.target.closest?.("input, textarea, select")) return;
    const k = ev.key.toLowerCase();
    const d = { a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1] }[k];
    if (d) { ev.preventDefault(); panCam(d[0], d[1]); }
    else if (k === "c") { cam = null; paintVision(); }
  });

  // The ghost: where the structure would land if you click the cell under the mouse.
  let ghostAt = null;
  function paintPropGhost() {
    combatField.el.querySelectorAll(".prop-ghost, .prop-ghost-bad").forEach(c => c.classList.remove("prop-ghost", "prop-ghost-bad"));
    const self = battle && me();
    const prop = self?.holding && (battle.props || []).find(p => p.id === self.holding.id);
    if (!prop || !ghostAt || HGS.cheb(self.x, self.y, ghostAt.x, ghostAt.y) > HGS.REACH || (ghostAt.x === self.x && ghostAt.y === self.y)) return;
    const D = battle.dropship;
    const cells = HGS.cellsOf({ ...prop, x: ghostAt.x, y: ghostAt.y });
    const free = q => q.x >= battle.zoneStart && q.x < battle.cols && q.y >= 0 && q.y < battle.rows && !HGS.inDrop(D, q.x, q.y) &&
      HGS.cheb(self.x, self.y, q.x, q.y) <= HGS.REACH &&
      !battle.players.some(p => p.inEncounter && p.x === q.x && p.y === q.y) &&
      !battle.monsters.some(m => q.x >= m.x && q.x < m.x + m.w && q.y >= m.y && q.y < m.y + m.h) &&
      !battle.structures.some(s => s.x === q.x && s.y === q.y) &&
      !battle.props.some(o => o.id !== prop.id && HGS.cellsOf(o).some(r => r.x === q.x && r.y === q.y));
    const ok = cells.every(free);
    for (const q of cells) combatField.cell(q.x, q.y)?.classList.add(ok ? "prop-ghost" : "prop-ghost-bad");
  }
  combatField.el.addEventListener("mouseover", ev => {
    const c = ev.target.closest(".bf-cell");
    if (!c) return;
    const g = { x: +c.dataset.x, y: +c.dataset.y };
    if (ghostAt && ghostAt.x === g.x && ghostAt.y === g.y) return;
    ghostAt = g; paintPropGhost();
  });
  combatField.el.addEventListener("mouseleave", () => { ghostAt = null; paintPropGhost(); });
  document.addEventListener("keydown", ev => {      // Esc sets down the piece you are moving where it is
    if (!battle || /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
    const self = me();
    if (!self?.holding) { if (ev.key === "Escape") closePropMenu(); return; }
    if (ev.key === "Escape") return socket.emit("prop-place", {});
  });
  document.addEventListener("click", ev => { if (menuWall && !ev.target.closest("#wall-menu") && !ev.target.closest(".has-wall")) closeWallMenu(); });
  $("wall-move").addEventListener("click", () => { if (menuWall) socket.emit("carry-start", { wallId: menuWall }); closeWallMenu(); });
  $("wall-destroy").addEventListener("click", () => {
    const id = menuWall;
    closeWallMenu();
    if (id) ask("Destroy this wall?", () => socket.emit("destroy-wall", { wallId: id }));
  });
  $("carry-drop").addEventListener("click", () => socket.emit("carry-drop"));
  $("ready-btn").addEventListener("click", () => socket.emit("set-ready", { ready: !me()?.ready }));

  $("fog-enter").addEventListener("click", () => {
    if (battle && me() && me().energy < battle.fogCost) return toast(`Entering the Fog Area costs ${battle.fogCost} Energy.`);
    socket.emit("enter-fog");
  });
  $("fog-leave").addEventListener("click", () => socket.emit("leave-fog"));
  let trainAwaitAttack = false;          // you just rolled the Dummy's Attack die: open the picker when the result arrives
  socket.on("training-state", state => {
    train = state;
    renderTraining();
    if (trainAwaitAttack) {
      trainAwaitAttack = false;
      if (state.dice.hitsLeft > 0) openTrainAttack();
      else if (state.dice.attack === 0) toast("Attack rolled 0: nothing happens.");
    }
  });
  socket.on("move-error", err => toast(err.message));

  /* ---------- Energy bar (Combat, Character and Training show the same one) ---------- */
  // 0 or below: zero-energy.png, shaking hard.  Above the cap: 3 x energy.png, shaking lightly.  Otherwise 1 x energy.png.
  // Hexed: hex-energy.png with hex.png beside it, bar turns purple.  Training: infinite.

  // Small icons on a player's cell: Counter, Shield and Shield Break, each with the turns left.
  function statusBadges(p) {
    const t = p.turns || {}, out = [];
    const add = (cls, icon, n, tip) => {
      const b = document.createElement("span");
      b.className = "bf-badge " + cls;
      const im = document.createElement("img");
      im.alt = "";
      setImage(im, icon);
      const num = document.createElement("b");
      num.textContent = n;
      b.append(im, num);
      b.dataset.tip = tip;
      out.push(b);
    };
    if (t.shield > 0) add("shield", CARDS.shield.icon, t.shield, `Shielded for ${t.shield} more round${t.shield === 1 ? "" : "s"}: the Host can't target ${p.username}`);
    else if (t.shieldBreak > 0) add("break", HGC.SHIELD_BREAK_ICON, t.shieldBreak, `Shield Break for ${t.shieldBreak} more round${t.shieldBreak === 1 ? "" : "s"}: can't be shielded`);
    if (t.counter > 0) add("counter", CARDS.counter.icon, t.counter, `Counter for ${t.counter} more round${t.counter === 1 ? "" : "s"}`);
    if (t.presence > 0) add("presence", CARDS.presence.icon, t.presence, `Presence for ${t.presence} more round${t.presence === 1 ? "" : "s"}: Monsters see only a 3x3, but they always see ${p.username} and anyone within 3 cells of them`);
    return out;
  }

  /* ---------- What the party is being asked to do (Fog Area rules, decided by the server) ---------- */
  function renderGuide() {
    const el = $("guide-banner"), self = me();
    let text = "";
    if (self && self.inEncounter && !self.dead && battle.enc?.phase === "prepare") {
      text = "Prepare Phase: click any empty cell to walk there. No Energy and no movement pattern. Your Class Range can't see outside the Class Area.";
    } else if (self && self.inEncounter && !self.dead && battle.enc?.phase === "setup") {
      text = "Setup Phase: the Active Area has docked onto the Class Area. Position yourself, anywhere in the Class Area or your 3 Active Area columns. The middle column blocks your view of the other side. Click a Wall to move or destroy it. Press Ready (top right) when you're set.";
    } else if (self && self.inEncounter && !self.dead) {
      const a = battle.activeStart, near = a + battle.nearEdge;
      if (battle.guide === "advance") {
        text = self.x < a ? "The Active Area is clear. Waiting for the rest of the party to reach the Fog Area…"
          : self.x <= near ? "You're near the left edge. Waiting for the rest of the party…"
          : "No monsters left in the Active Area. Movement is free: move to the left edge of the Active Area. The whole party enters the Fog Area together.";
      } else if (battle.guide === "retreat") {
        text = self.x >= battle.zoneStart ? "Encounter cleared. You're in the Class Area."
          : "No monsters left. Movement is free: move towards the Class Area.";
      }
    }
    el.hidden = !text;
    el.textContent = text;
  }

  /* ---------- Right panel: you and your teammates. Tabs are class icons; yours is open by default ---------- */
  let teamSel = null;

  function teamCard(p, card) {
    const data = CARDS[card.type], pos = card.pattern.length;
    const base = HGC.baseCost(card.type, pos), cost = cardCost(p, card.type, pos);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "hand-card team-card";
    b.dataset.tip = data.tip;                                   // hover: the simple version
    if (!data.playable) b.classList.add("soon");
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    setImage(img, data.icon);
    const text = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = card.name || data.name;
    const line = document.createElement("small");
    if (!data.playable) line.textContent = `${pos} positions · Coming soon`;
    else line.textContent = `${pos} pos · ${cost < base ? `${fmt(cost)} (was ${fmt(base)})` : `${fmt(cost)} Energy`} · ${rangeText(card.type, pos)}`;
    text.append(name, line);
    b.append(img, text);
    const stacks = p.charges?.[card.type] ?? p.turns?.[card.type];
    if (stacks > 0) {
      const s = document.createElement("i");
      s.className = "stacks";
      s.textContent = stacks;
      b.append(s);
    }
    b.addEventListener("click", () => openCard(card.type, { name: card.name, pattern: card.pattern }));   // click: the in-depth version
    return b;
  }

  function renderTeamPanel() {
    const self = me();
    if (!self) return;
    if (!CLASSES.includes(teamSel)) teamSel = self.className;
    const tabs = $("team-tabs"), body = $("team-body");
    tabs.replaceChildren();
    for (const cls of CLASSES) {
      const p = battle.players.find(x => x.className === cls);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "side-tab" + (cls === teamSel ? " active" : "") + (p ? "" : " empty") + (cls === self.className ? " mine" : "");
      b.title = p ? `${p.username} · ${cls}` : `${cls} · nobody`;
      const img = document.createElement("img");
      img.alt = cls;
      setImage(img, classIcon(cls));
      b.append(img);
      b.addEventListener("click", () => { teamSel = cls; renderTeamPanel(); });
      tabs.append(b);
    }
    body.replaceChildren();
    const p = battle.players.find(x => x.className === teamSel);
    if (!p) {
      const none = document.createElement("p");
      none.className = "side-empty";
      none.textContent = "No player is occupying this class.";
      body.append(none);
      return;
    }
    const mine = p.id === self.id;
    const who = document.createElement("span");
    who.className = "side-who";
    who.textContent = mine ? `You · ${p.className}` : `${p.username} · ${p.className}`;
    const grid = document.createElement("div");
    grid.className = "hp-grid side-grid";
    HGFx.buildGrid(grid, p.n);
    HGFx.applyCells(grid, p.hp, p.marks || {});
    if (p.dead) grid.classList.add("dead");
    body.append(who, grid);
    const badges = statusBadges(p);
    if (badges.length) {
      const row = document.createElement("div");
      row.className = "side-status";
      row.append(...badges);
      body.append(row);
    }
    if (mine) return;                                           // your own Energy and Cards are already on screen

    const en = document.createElement("div");
    en.className = "mini-energy";
    const icon = document.createElement("img");
    icon.alt = "Energy";
    setImage(icon, "/assets/classes/general/energy.png");
    const track = document.createElement("div");
    track.className = "mini-track";
    const fill = document.createElement("span");
    fill.style.width = Math.max(0, Math.min(1, p.energy / p.cap)) * 100 + "%";
    if (p.energy > p.cap) fill.classList.add("over");
    track.append(fill);
    const num = document.createElement("b");
    num.textContent = `${fmt(p.energy)} / ${p.cap}`;
    en.append(icon, track, num);
    body.append(en);

    const list = document.createElement("div");
    list.className = "team-cards";
    const cards = (p.cards || []).slice(0, MAX_CARDS);
    if (!cards.length) {
      const e = document.createElement("p");
      e.className = "side-empty small";
      e.textContent = "No cards.";
      list.append(e);
    }
    for (const c of cards) list.append(teamCard(p, c));
    body.append(list);
  }

  /* ---------- Left panel: monsters your team's Class Ranges touch (their HP Grid only, never their dice) ---------- */
  let monSel = null;

  function renderFogPanel() {
    const tabs = $("fog-tabs"), body = $("fog-body");
    tabs.replaceChildren();
    body.replaceChildren();
    const seen = battle.monsters.filter(m => (battle.revealed || []).includes(m.id));
    if (!seen.length) {
      const msg = document.createElement("p");
      msg.className = "side-empty fog";
      msg.textContent = "The Fog denies you knowledge.";
      body.append(msg);
      return;
    }
    if (!seen.some(m => m.id === monSel)) monSel = seen[0].id;
    for (const m of seen) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "side-tab" + (m.id === monSel ? " active" : "");
      b.title = m.name;
      const img = document.createElement("img");
      img.alt = m.name;
      setImage(img, m.sprite);
      b.append(img);
      b.addEventListener("click", () => { monSel = m.id; renderFogPanel(); });
      tabs.append(b);
    }
    const m = seen.find(x => x.id === monSel);
    const who = document.createElement("span");
    who.className = "side-who";
    who.textContent = `${m.name} · HP Grid ${m.n}×${m.n}`;
    const grid = document.createElement("div");
    grid.className = "hp-grid side-grid";
    HGFx.buildGrid(grid, m.n);
    HGFx.applyCells(grid, m.hp, m.marks || {});
    body.append(who, grid);
  }

  function renderHud() {
    document.querySelectorAll(".energy-hud").forEach(hud => {
      const training = hud.dataset.train === "1";
      const self = training ? train?.player : me();
      if (!self) return;
      const hexed = !!self.hexed;
      const state = training ? "inf" : self.energy <= 0 ? "zero" : self.energy > self.cap ? "over" : "normal";
      const main = state === "zero" ? "/assets/classes/general/zero-energy.png" : hexed ? "/assets/classes/general/hex-energy.png" : "/assets/classes/general/energy.png";
      const srcs = Array.from({ length: state === "over" ? 3 : 1 }, () => main);
      if (hexed) srcs.push(HGC.CARDS.hex.icon);                 // hex.png is energy.png's new friend
      hud.classList.remove("zero", "over", "normal", "inf", "hexed");
      hud.classList.add(state);
      hud.classList.toggle("hexed", hexed);
      const icons = hud.querySelector(".hud-icons");
      const key = srcs.join("|");
      if (icons.dataset.key !== key) {                          // only rebuild when it changes so the shake never restarts
        icons.dataset.key = key;
        icons.replaceChildren(...srcs.map(src => {
          const img = document.createElement("img");
          img.alt = "Energy";
          setImage(img, src);
          return img;
        }));
      }
      hud.querySelector(".hud-fill").style.width = (training ? 1 : Math.max(0, Math.min(1, self.energy / self.cap))) * 100 + "%";
      hud.querySelector(".hud-number").innerHTML = training ? "∞" : `${fmt(self.energy)}<small>/ ${self.cap}</small>`;
    });
  }

  /* ---------- Cards (at most 4, landscape) ---------- */

  const cardCost = (self, type, positions) =>
    self && self.hexed && type !== "hex" ? HGC.discountedCost(type, positions) : HGC.baseCost(type, positions);

  function rangeText(type, positions) {
    const r = HGC.rangeOf(type, positions);
    const kind = CARDS[type].kind;
    return r === null ? (kind === "aura" ? "Aura" : "Self") : `Range ${r}`;
  }

  function renderHand() {
    document.querySelectorAll(".hand").forEach(hand => {
      const compact = hand.classList.contains("compact");
      const ctx = hand.dataset.ctx;
      const self = ctx === "training" ? train?.player : me();
      const slots = [];
      for (let i = 0; i < MAX_CARDS; i++) {
        const card = myCards[i];
        if (!card) {
          const empty = document.createElement("div");
          empty.className = "hand-empty";
          empty.textContent = "Empty";
          slots.push(empty);
          continue;
        }
        const data = CARDS[card.type];
        const pos = card.pattern.length;
        const base = HGC.baseCost(card.type, pos);
        const cost = cardCost(self, card.type, pos);
        const b = document.createElement("button");
        b.type = "button";
        b.className = "hand-card";
        b.dataset.index = i;
        b.dataset.tip = data.tip;                                   // hover: the simple version
        if (!data.playable) b.classList.add("soon");
        if (ctx === "combat" && self && data.playable && self.energy < cost) b.classList.add("poor");
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        setImage(img, data.icon);
        const text = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = card.name || data.name;
        const line = document.createElement("small");
        const kind = card.name && card.name !== data.name ? `${data.name} · ` : "";
        if (!data.playable) line.textContent = `${kind}${pos} positions · Coming soon`;
        else {
          line.append(`${kind}${pos} pos · `);
          const c = document.createElement("span");
          c.className = "cost" + (cost < base ? " hexed" : "");
          c.textContent = cost < base ? `${fmt(cost)} (was ${fmt(base)})` : `${fmt(cost)} Energy`;
          line.append(c, ` · ${rangeText(card.type, pos)}`);
        }
        text.append(name, line);
        b.append(img, text);
        const stacks = self?.charges?.[card.type] ?? self?.turns?.[card.type];
        if (stacks > 0) {
          const s = document.createElement("i");
          s.className = "stacks";
          s.textContent = stacks;
          s.title = "Charges";
          b.append(s);
        }
        if (!compact) {
          if (data.noPattern) { const n = document.createElement("span"); n.className = "demo-positions"; n.textContent = `×${pos}`; n.title = `${pos} positions`; b.append(n); }
          else b.append(demoGrid(card.type, card.pattern));
        }
        else {                                                       // Character tab only: hover shows a small X to discard
          const x = document.createElement("span");
          x.className = "discard-x";
          x.setAttribute("role", "button");
          x.title = "Discard this card";
          x.textContent = "×";
          b.append(x);
        }
        slots.push(b);
      }
      hand.replaceChildren(...slots);
    });
  }

  const openCardFor = i => { const c = myCards[i]; if (c) openCard(c.type, { name: c.name, pattern: c.pattern }); };

  // Compact hand (Character tab): click for the detailed version. Combat / Training hands: click, or drag onto the field.
  document.querySelectorAll(".hand").forEach(hand => {
    hand.addEventListener("click", e => {
      const x = e.target.closest(".discard-x");
      if (x) {
        e.stopPropagation();
        const i = +x.closest(".hand-card").dataset.index, c = myCards[i];
        if (c) ask(`Are you sure you want to Discard "${c.name}"?`, () => socket.emit("discard-card", { index: i }));
        return;
      }
      const b = e.target.closest(".hand-card");
      if (b && (hand.classList.contains("compact") || e.detail === 0)) openCardFor(+b.dataset.index);   // detail 0 = keyboard
    });
  });

  /* ---------- Using a card: drag, aim, confirm ---------- */

  const ctxs = {
    combat: {
      name: "combat", field: combatField, infinite: false,
      self: () => me(),
      arena: () => {                                         // cards can only pick targets you can see (Fog Area)
        const v = combatField.view || { x0: 0, x1: Infinity };
        const seen = e => e.x >= v.x0 && e.x <= v.x1;
        const fighting = battle.enc?.phase === "running";           // no encounter: nothing to attack
        return { training: false, zoneStart: battle.zoneStart, players: battle.players.filter(seen), monsters: fighting ? battle.monsters.filter(seen) : [], structures: fighting ? (battle.structures || []).filter(seen) : [] };
      },
      send: payload => socket.emit("use-card", payload)
    },
    training: {
      name: "training", field: trainField, infinite: true,
      self: () => train?.player,
      arena: () => ({ training: true, players: train ? [train.player] : [], monsters: train ? [train.dummy] : [] }),
      send: payload => socket.emit("training-use", payload)
    }
  };

  function flashDeny(f) {
    f.el.classList.remove("bf-deny");
    void f.el.offsetWidth;
    f.el.classList.add("bf-deny");
    setTimeout(() => f.el.classList.remove("bf-deny"), 480);
  }
  function deny(ctx, message) {
    flashDeny(ctx.field);                  // the whole grid turns red and shakes
    toast(message);
  }
  socket.on("use-error", err => { toast(err.message); flashDeny(combatField); flashDeny(trainField); });

  function tryUse(ctx, idx) {
    const self = ctx.self();
    const card = myCards[idx];
    if (!self || !card) return;
    if (ctx.name === "training" && trainTurn === "dummy") return deny(ctx, "It's the Dummy's Turn. Switch to Player's Turn to use cards.");
    if (!self.inEncounter) return deny(ctx, "You are not in the encounter.");
    if (self.dead) return deny(ctx, "You are dead.");
    const def = CARDS[card.type];
    if (!def.playable) return deny(ctx, `${def.name} can't be used yet.`);
    if (ctx.name === "training" && ["field", "displace", "move", "clone"].includes(def.kind)) return deny(ctx, `${def.name} isn't available in Training.`);
    const pos = card.pattern.length;
    const removingField = ctx.name === "combat" && (def.kind === "field" ? (battle?.[def.marks] || []).some(s => s.by === self.id)
      : def.kind === "clone" ? (battle?.clones || []).some(c => c.by === self.id) : false);
    if (!ctx.infinite && self.energy < 0 && !removingField) return deny(ctx, "Your Energy is below 0: you can't use any card, not even a free one. Remove your Smoke, Trail or Clone to get out.");
    if (def.aim === "field") {                                           // Smoke, Trail, Clone, Force, Gravity: click a cell of the battlefield (Smoke, Trail and Clone: use it again to remove it)
      if (removingField) return ctx.send({ cardIndex: idx });
      if (!ctx.infinite && self.energy < cardCost(self, card.type, pos)) return deny(ctx, `Not enough Energy: ${card.name} costs ${fmt(cardCost(self, card.type, pos))}.`);
      return startFieldAim(ctx, idx, card, def);
    }
    const cost = cardCost(self, card.type, pos);
    if (!ctx.infinite && self.energy < cost) return deny(ctx, `Not enough Energy: ${card.name} costs ${fmt(cost)}.`);

    const arena = ctx.arena();
    const cands = HGC.candidates(arena, self, card.type, pos);
    if (!cands.length) {
      if (def.side === "structure") return deny(ctx, (arena.structures || []).some(HGC.aliveMonster) ? "No Wall in range." : "There is no Wall to repair.");
      if (def.side === "enemy" || def.side === "monster") {
        const alive = arena.monsters.filter(HGC.aliveMonster).concat((arena.structures || []).filter(HGC.aliveMonster));
        return deny(ctx, !alive.length ? (ctx.infinite ? "The dummy has no HP left. Press Reset HP." : "There is no Monster or Wall to target.") : "No Monster or Wall in range.");
      }
      return deny(ctx, "No teammate in range.");
    }
    if (def.aim === "none") return ctx.send({ cardIndex: idx });          // Taunt, Lifesteal, Poison, Hex
    if (def.aim === "move") return startMoveAim(ctx, idx, card, def, cands);
    startAim(ctx, idx, card, def, cands);
  }

  /* Battlefield-Grid cards (Smoke): the pattern follows your cursor over the battlefield itself */
  let fieldAim = null;
  function paintFieldAim() {
    if (!fieldAim) return;
    const { ctx, card, range } = fieldAim, f = ctx.field, self = ctx.self();
    f.cells.forEach(c => c.classList.remove("in-range", "aim-field"));
    if (!self) return endFieldAim();
    for (const c of f.cells) {
      const d = HGC.cheb(self.x, self.y, +c.dataset.x, +c.dataset.y);
      if (d > 0 && d <= range) c.classList.add("in-range");
    }
    if (fieldAim.cursor) for (const i of (CARDS[card.type].noPattern ? [4] : card.pattern)) f.cell(fieldAim.cursor.x + (i % 3) - 1, fieldAim.cursor.y + Math.floor(i / 3) - 1)?.classList.add("aim-field");
  }
  function endFieldAim() {
    if (!fieldAim) return;
    const f = fieldAim.ctx.field;
    f.cells.forEach(c => c.classList.remove("in-range", "aim-field"));
    f.el.classList.remove("field-aiming");
    f.el.removeEventListener("mousemove", fieldAim.move);
    f.el.removeEventListener("click", fieldAim.click, true);
    f.el.removeEventListener("contextmenu", fieldAim.cancel, true);
    fieldAim = null;
  }
  function startFieldAim(ctx, idx, card, def) {
    endFieldAim();
    closeAim();
    const f = ctx.field, range = HGC.rangeOf(card.type, card.pattern.length);
    const cellAt = e => { const c = e.target.closest?.(".bf-cell"); return c ? { x: +c.dataset.x, y: +c.dataset.y } : null; };
    fieldAim = {
      ctx, card, range, cursor: null,
      move: e => {
        const c = cellAt(e), self = ctx.self();
        fieldAim.cursor = c && self && HGC.cheb(self.x, self.y, c.x, c.y) <= range ? c : null;
        paintFieldAim();
      },
      click: e => {
        e.preventDefault(); e.stopImmediatePropagation();                 // this click is not a move
        const c = cellAt(e), self = ctx.self();
        if (!c || !self || HGC.cheb(self.x, self.y, c.x, c.y) > range) return toast("That cell is out of range.");
        endFieldAim();
        ctx.send({ cardIndex: idx, cursor: c });
      },
      cancel: e => { e.preventDefault(); endFieldAim(); }
    };
    f.el.classList.add("field-aiming");
    f.el.addEventListener("mousemove", fieldAim.move);
    f.el.addEventListener("click", fieldAim.click, true);
    f.el.addEventListener("contextmenu", fieldAim.cancel, true);
    paintFieldAim();
    toast(`${card.name}: click a cell in range to place it. Esc or right-click to cancel.`);
  }

  /* Move (Support): pick a teammate, then a cell of THEIR movement pattern */
  let moveAim = null;
  function paintMoveAim() {
    if (!moveAim) return;
    const { ctx, card, def } = moveAim, f = ctx.field, self = ctx.self();
    f.cells.forEach(c => { c.classList.remove("can-target", "move-pick", "poor"); c.querySelector(":scope > .cost")?.remove(); });
    if (!self) return endMoveAim();
    const st = battle || {}, cardPrice = cardCost(self, card.type, card.pattern.length);
    if (!moveAim.target) {
      for (const p of moveAim.cands) f.cell(p.x, p.y)?.classList.add("can-target");
      return;
    }
    const t = (st.players || []).find(p => p.id === moveAim.target);
    if (!t) return endMoveAim();
    f.cell(t.x, t.y)?.classList.add("can-target");
    const occ = (x, y) => (st.players || []).some(p => p.inEncounter && p.id !== t.id && p.x === x && p.y === y) ||
      (st.monsters || []).some(m => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h) || (st.structures || []).some(s => s.x === x && s.y === y);
    for (const i of t.movementPattern || []) {
      const dx = (i % 9) - 4, dy = Math.floor(i / 9) - 4, x = t.x + dx, y = t.y + dy;
      if (x < 0 || y < 0 || x >= st.cols || y >= st.rows || occ(x, y) || (x < st.activeStart) !== (t.x < st.activeStart) || !HGC.pathClear(t, { x, y }, occ)) continue;
      const c = f.cell(x, y);
      if (!c) continue;
      const free = (st.trail || []).some(tr => tr.x === x && tr.y === y);
      const price = cardPrice + (free ? 0 : moveCost(dx, dy));
      c.classList.add("move-pick");
      if (self.energy < price) c.classList.add("poor");
      const label = document.createElement("span");
      label.className = "cost";
      label.textContent = fmt(price);
      c.append(label);
    }
  }
  function endMoveAim() {
    if (!moveAim) return;
    const f = moveAim.ctx.field;
    f.cells.forEach(c => { c.classList.remove("can-target", "move-pick", "poor"); c.querySelector(":scope > .cost")?.remove(); });
    f.el.classList.remove("field-aiming");
    f.el.removeEventListener("click", moveAim.click, true);
    f.el.removeEventListener("contextmenu", moveAim.cancel, true);
    moveAim = null;
  }
  function startMoveAim(ctx, idx, card, def, cands) {
    endMoveAim(); endFieldAim(); closeAim();
    const f = ctx.field;
    moveAim = {
      ctx, card, def, cands, target: cands.length === 1 ? cands[0].id : null,
      click: e => {
        const c = e.target.closest?.(".bf-cell");
        if (!c) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const x = +c.dataset.x, y = +c.dataset.y;
        if (!moveAim.target) {
          const p = moveAim.cands.find(q => q.x === x && q.y === y);
          if (!p) return toast("Click a teammate in range.");
          moveAim.target = p.id;
          paintMoveAim();
          return toast(`Now click the cell ${p.username} goes to (their movement pattern).`);
        }
        if (!c.classList.contains("move-pick")) {                         // clicking another teammate switches; anything else does nothing
          const p = moveAim.cands.find(q => q.x === x && q.y === y);
          if (p) { moveAim.target = p.id; paintMoveAim(); }
          return;
        }
        const target = moveAim.target;
        endMoveAim();
        ctx.send({ cardIndex: idx, targetId: target, to: { x, y } });
      },
      cancel: e => { e.preventDefault(); endMoveAim(); }
    };
    f.el.classList.add("field-aiming");
    f.el.addEventListener("click", moveAim.click, true);
    f.el.addEventListener("contextmenu", moveAim.cancel, true);
    paintMoveAim();
    toast(moveAim.target ? "Click the cell your teammate goes to. Esc or right-click cancels." : "Click the teammate you want to move. Esc or right-click cancels.");
  }

  /* Clone (Rogue): a small panel to move it or make it fake an attack, once each per turn */
  let cloneMode = null;                                                   // "move" | "fake" | null
  function cloneEls() {
    let p = document.getElementById("clone-panel");
    if (!p) {
      p = document.createElement("div");
      p.id = "clone-panel";
      p.innerHTML = '<b>Clone</b><button type="button" data-a="move">Move</button><button type="button" data-a="fake">Fake attack</button>';
      p.addEventListener("click", e => {
        const a = e.target.dataset?.a;
        if (!a) return;
        cloneMode = cloneMode === a ? null : a;
        if (cloneMode) toast(a === "move" ? "Click a cell of your movement pattern around the Clone (free)." : "Click a Monster in your Clone's range.");
        renderClonePanel(); renderField(combatField, { ...battle, me: me(), training: false }); paintCloneMode();
      });
      document.body.append(p);
    }
    return p;
  }
  function paintCloneMode() {
    const f = combatField, mine = (battle?.clones || []).find(c => c.by === me()?.id);
    f.el.classList.toggle("clone-aiming", !!(cloneMode && mine));
    if (!cloneMode || !mine) return;
    if (cloneMode === "move") {
      for (const i of myPattern) {
        const x = mine.x + (i % 9) - 4, y = mine.y + Math.floor(i / 9) - 4;
        if (x < 0 || y < 0 || x >= battle.cols || y >= battle.rows) continue;
        f.cell(x, y)?.classList.add("clone-reach");
      }
    }
  }
  function renderClonePanel() {
    const p = cloneEls(), self = me(), mine = (battle?.clones || []).find(c => c.by === self?.id);
    const myTurn = battle?.enc?.phase === "running" && battle.enc.turn?.kind === "player" && battle.enc.turn.id === self?.id;
    p.hidden = !(mine && myTurn);
    if (p.hidden) { cloneMode = null; return; }
    const [mv, fk] = p.querySelectorAll("button");
    mv.disabled = mine.moved; fk.disabled = mine.acted;
    mv.classList.toggle("on", cloneMode === "move"); fk.classList.toggle("on", cloneMode === "fake");
  }
  document.addEventListener("click", e => {                               // while a Clone mode is on, the next click on the battlefield is the Clone's action
    if (!cloneMode || !combatField.el.contains(e.target)) return;
    const c = e.target.closest?.(".bf-cell"), mon = e.target.closest?.(".bf-monster");
    const mine = (battle?.clones || []).find(cl => cl.by === me()?.id);
    if (!mine) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (cloneMode === "move" && c) { socket.emit("clone-move", { x: +c.dataset.x, y: +c.dataset.y }); }
    else if (cloneMode === "fake" && (mon || c)) {
      const id = mon?.dataset.id || battle.monsters.find(m => c && +c.dataset.x >= m.x && +c.dataset.x < m.x + m.w && +c.dataset.y >= m.y && +c.dataset.y < m.y + m.h)?.id;
      if (id) socket.emit("clone-fake", { monsterId: id }); else return;
    } else return;
    cloneMode = null;
  }, true);

  /* drag */
  let drag = null;

  function showRange(ctx, d) {
    const f = ctx.field, self = ctx.self();
    f.cells.forEach(c => c.classList.remove("in-range", "can-target"));
    if (!self) return;
    const pos = d.card.pattern.length;
    const range = HGC.rangeOf(d.card.type, pos);
    if (range === null) return;
    for (const c of f.cells) {
      const dist = HGC.cheb(self.x, self.y, +c.dataset.x, +c.dataset.y);
      if (dist > 0 && dist <= range) c.classList.add("in-range");
    }
    for (const e of HGC.candidates(ctx.arena(), self, d.card.type, pos)) {
      for (const [x, y] of cellsOf(e)) f.cell(x, y)?.classList.add("can-target");
    }
  }

  function endDrag() {
    if (!drag) return;
    drag.ghost?.remove();
    const f = drag.ctx.field;
    f.cells.forEach(c => c.classList.remove("in-range", "can-target"));
    f.el.classList.remove("bf-glow");
    document.body.classList.remove("card-dragging");
    drag = null;
  }
  const overField = (f, e) => {
    const r = f.el.getBoundingClientRect();
    return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };

  document.querySelectorAll(".hand[data-ctx]").forEach(hand => {
    hand.addEventListener("pointerdown", e => {
      const b = e.target.closest(".hand-card");
      if (!b || e.button !== 0 || currentAim || drag) return;
      const idx = +b.dataset.index;
      const card = myCards[idx];
      if (!card) return;
      e.preventDefault();
      drag = { ctx: ctxs[hand.dataset.ctx], idx, card, x: e.clientX, y: e.clientY, active: false, ghost: null };
    });
  });

  window.addEventListener("pointermove", e => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      tip.hidden = true;
      document.body.classList.add("card-dragging");
      const g = document.createElement("div");
      g.className = "drag-ghost";
      const img = document.createElement("img");
      img.alt = "";
      setImage(img, CARDS[drag.card.type].icon);
      const n = document.createElement("strong");
      n.textContent = drag.card.name;
      g.append(img, n);
      document.body.append(g);
      drag.ghost = g;
      showRange(drag.ctx, drag);                   // the range shows while the card is out of its slot
    }
    drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -60%)`;
    drag.ctx.field.el.classList.toggle("bf-glow", overField(drag.ctx.field, e));   // the whole grid glows yellow
  });

  window.addEventListener("pointerup", e => {
    if (!drag) return;
    const d = drag;
    const dropped = d.active && overField(d.ctx.field, e);
    endDrag();
    if (!d.active) openCardFor(d.idx);             // a plain click: the detailed version
    else if (dropped) tryUse(d.ctx, d.idx);        // letting go on the battlefield uses the card
  });
  window.addEventListener("pointercancel", endDrag);

  /* aim: the battlefield fades, the target's HP Grid shows, the card's pattern follows the cursor */
  let currentAim = null;

  const isWall = e => e.kind === "wall";
  const targetName = e => isWall(e) ? `Wall (${e.x + 1}, ${e.y + 1})` : (e.username || e.name);
  const clampFor = (t, pattern, cur) => HGC.clampCursor(pattern, cur, t.n, isWall(t));   // a Wall's 2x2 grid is smaller than the pattern: it may overhang
  function chipIcon(e) {
    if (isWall(e)) { const w = document.createElement("i"); w.className = "chip-wall"; return w; }
    const img = document.createElement("img");
    img.alt = "";
    setImage(img, isMonster(e) ? (e.sprite || "/assets/missing.png") : classIcon(e.className));
    return img;
  }

  function startAim(ctx, idx, card, def, cands) {
    closeAim();
    const aim = { ctx, idx, card, def, cands, pos: card.pattern.length, queue: [], phase: 0, results: [], cursor: null };
    aim.queue = def.side === "self" ? [ctx.self()] : [cands[0]];

    const el = document.createElement("div");
    el.className = "aim";
    el.innerHTML = `<div class="aim-panel">
      <header class="aim-head"><img alt=""><div><strong></strong><span class="aim-hint"></span></div><button type="button" class="button quiet aim-cancel">Cancel</button></header>
      <div class="aim-chips"></div>
      <div class="aim-body"><div class="hp-grid aim-grid"></div></div>
      <footer class="aim-foot"><span class="aim-info"></span><button type="button" class="button primary aim-use">Use</button></footer>
    </div>`;
    aim.el = el;
    setImage(el.querySelector(".aim-head img"), def.icon);
    el.querySelector(".aim-head strong").textContent = card.name;
    el.querySelector(".aim-hint").textContent = {
      pattern: def.side === "enemy" ? "Aim the red pattern. Click to use." : "Aim the yellow pattern. Click to use.",
      random: "Cells are picked at random. Click to use.",
      pick: "Pick who gets it."
    }[def.aim];

    const chips = el.querySelector(".aim-chips");
    if (cands.length > 1 && def.side !== "self") {
      for (const c of cands) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.dataset.id = c.id;
        b.append(chipIcon(c), document.createTextNode(targetName(c)));
        b.addEventListener("click", () => chooseTarget(aim, c));
        chips.append(b);
      }
    } else chips.hidden = true;

    el.querySelector(".aim-cancel").addEventListener("click", closeAim);
    el.querySelector(".aim-use").addEventListener("click", () => aimConfirm(aim));
    el.addEventListener("contextmenu", e => { e.preventDefault(); closeAim(); });
    const grid = el.querySelector(".aim-grid");
    const cellAtEvent = e => { const s = e.target.closest("span"); return s ? [...grid.children].indexOf(s) : -1; };
    const clampTo = i => { const t = aim.queue[aim.phase]; return clampFor(t, card.pattern, { x: i % t.n, y: Math.floor(i / t.n) }); };
    grid.addEventListener("mousemove", e => {
      const i = cellAtEvent(e);
      if (i < 0 || def.aim !== "pattern") return;
      aim.cursor = clampTo(i);
      paintPreview(aim);
    });
    grid.addEventListener("click", e => {
      const i = cellAtEvent(e);
      if (i < 0) return;
      if (def.aim === "pattern") {
        const c = clampTo(i);
        if (aim.cursor && c.x === aim.cursor.x && c.y === aim.cursor.y) aimConfirm(aim);   // mouse: hovering already put it there
        else { aim.cursor = c; paintPreview(aim); }                                         // touch: first tap aims, second tap uses
      } else aimConfirm(aim);
    });

    (ctx.field.el.closest(".field-wrap") || ctx.field.el.parentElement).append(el);
    (ctx.field.el.closest(".field-wrap") || ctx.field.el.parentElement).classList.add("aiming");
    currentAim = aim;
    aimRefresh(aim);
    el.querySelector(".aim-use").focus({ preventScroll: true });
  }

  function chooseTarget(aim, c) {
    const multi = aim.def.multi > 1;
    if (multi) {
      const at = aim.queue.indexOf(c);
      if (at >= 0 && aim.queue.length > 1) aim.queue.splice(at, 1);
      else if (at < 0 && aim.queue.length < aim.def.multi) aim.queue.push(c);
      else if (at < 0) aim.queue = [aim.queue[0], c];
    } else aim.queue = [c];
    aim.phase = 0; aim.results = [];
    if (aim.def.aim === "pick") return aimConfirm(aim);
    aimRefresh(aim);
  }

  function paintPreview(aim) {
    const t = aim.queue[aim.phase];
    const grid = aim.el.querySelector(".aim-grid");
    grid.querySelectorAll("span").forEach(s => s.classList.remove("aim-red", "aim-yellow"));
    const cls = aim.def.side === "enemy" ? "aim-red" : "aim-yellow";      // yellow when it's for your side
    (HGC.aimCells(aim.card.pattern, aim.cursor, t.n, isWall(t)) || []).forEach(i => grid.children[i].classList.add(cls));
  }

  function aimRefresh(aim) {
    const t = aim.queue[aim.phase];
    const body = aim.el.querySelector(".aim-body");
    const grid = aim.el.querySelector(".aim-grid");
    body.hidden = aim.def.aim === "pick";
    if (!body.hidden) {
      HGFx.buildGrid(grid, t.n);
      HGFx.applyCells(grid, t.hp, t.marks || {});
      grid.classList.toggle("is-monster", isMonster(t));
      if (aim.def.aim === "pattern") {
        aim.cursor = clampFor(t, aim.card.pattern, aim.cursor || { x: Math.floor(t.n / 2), y: Math.floor(t.n / 2) });   // starts on the pattern's center
        paintPreview(aim);
      } else if (aim.def.aim === "random") {
        grid.querySelectorAll("span:not(.empty)").forEach(s => s.classList.add("aim-random"));
      }
    }
    aim.el.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", aim.queue.some(q => String(q.id) === c.dataset.id)));
    const more = aim.phase + 1 < aim.queue.length;
    aim.el.querySelector(".aim-use").textContent = more ? "Next target" : aim.def.aim === "pick" ? "Use" : "Use card";
    aim.el.querySelector(".aim-info").textContent =
      `${isWall(t) ? "The Wall" : (t.username || t.name)}'s HP Grid` + (aim.queue.length > 1 ? ` · target ${aim.phase + 1} of ${aim.queue.length}` : "") +
      (aim.def.multi > 1 && aim.cands.length > 1 ? " · pick up to 2 targets" : "");
  }

  function aimConfirm(aim) {
    const t = aim.queue[aim.phase];
    aim.results.push(aim.def.aim === "pattern" ? { id: t.id, cursor: { ...aim.cursor } } : { id: t.id });
    if (aim.phase + 1 < aim.queue.length) {
      aim.phase++;
      aim.cursor = null;
      return aimRefresh(aim);
    }
    const targets = aim.def.side === "self" ? [{ cursor: aim.results[0].cursor }] : aim.results;
    const { ctx, idx } = aim;
    closeAim();
    ctx.send({ cardIndex: idx, targets });
  }

  function closeAim() {
    if (!currentAim) return;
    currentAim.el.parentElement?.classList.remove("aiming");
    currentAim.el.remove();
    currentAim = null;
  }

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { if (currentAim) closeAim(); endFieldAim(); endMoveAim(); cloneMode = null; renderClonePanel(); endDrag(); return; }
    if (!currentAim || currentAim.def.aim !== "pattern") return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (step) {
      e.preventDefault();
      const aim = currentAim, t = aim.queue[aim.phase];
      aim.cursor = clampFor(t, aim.card.pattern, { x: aim.cursor.x + step[0], y: aim.cursor.y + step[1] });
      paintPreview(aim);
    }
  });

  /* ---------- Card animations that play on the battlefield itself (Hex, Buff) ---------- */

  HGFx.setHooks({
    async battlefield(e, rt) {
      if (isHost()) { toast(`${e.actor.name} used ${e.name}`); return; }       // the Host has no battlefield view
      const training = e.ctx === "training";
      const f = training ? trainField : combatField;
      if ($("stage").dataset.tab !== (training ? "activities" : "combat") || !f.cells.length) return;
      if (HGFxField.handles(e.bf.kind)) { await HGFxField.playReal(f, e.bf, rt); return; }     // Trail, Smoke, Force, Gravity, Clone, Hold, Move (js/fx-field.js)
      if (e.bf.kind === "hex") {
        const cells = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = f.cell(e.bf.x + dx, e.bf.y + dy); if (c) cells.push(c); }
        await Promise.all(cells.map(c => {
          const o = document.createElement("i");
          o.className = "bf-fx hex-pulse";
          c.append(o);
          return rt.anim(o, [{ transform: "scale(.2)", opacity: 0.9 }, { transform: "scale(1.15)", opacity: 0.7, offset: 0.5 }, { transform: "scale(.6)", opacity: 0.9, offset: 0.7 }, { transform: "scale(1.3)", opacity: 0 }], { duration: 1000 });
        }));
      } else if (e.bf.kind === "fake") {                                    // the Clone's fake attack: a slash that hurts nobody
        const from = f.cell(e.bf.from.x, e.bf.from.y), to = f.cell(e.bf.to.x, e.bf.to.y);
        if (from && to) {
          const o = document.createElement("i"); o.className = "bf-fx fake-hit"; to.append(o);
          const g = document.createElement("i"); g.className = "bf-fx clone-ring"; from.append(g);
          await Promise.all([
            rt.anim(g, [{ transform: "scale(.5)", opacity: 0.9 }, { transform: "scale(1.4)", opacity: 0 }], { duration: 500 }),
            rt.anim(o, [{ transform: "scale(.3) rotate(-40deg)", opacity: 0 }, { transform: "scale(1) rotate(0)", opacity: 1, offset: 0.5 }, { transform: "scale(1.2)", opacity: 0 }], { duration: 650, delay: 200 })
          ]);
        }
      } else if (e.bf.kind === "buff" || e.bf.kind === "weaken" || e.bf.kind === "shield") {     // Buff, and the same spark + ring in pink (Weaken) and blue (Shield)
        const tint = e.bf.kind === "buff" ? "" : " " + e.bf.kind, t = e.bf.to;
        const a = f.cell(e.bf.from.x, e.bf.from.y), b = f.cell(t.x + Math.floor(((t.w || 1) - 1) / 2), t.y + Math.floor(((t.h || 1) - 1) / 2));
        if (!a || !b) return;
        const fr = f.el.getBoundingClientRect(), ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        const spark = document.createElement("i");
        spark.className = "bf-spark" + tint;
        spark.style.left = (ar.left - fr.left + ar.width / 2) + "px";
        spark.style.top = (ar.top - fr.top + ar.height / 2) + "px";
        f.el.append(spark);
        try {
          await rt.anim(spark, [{ transform: "translate(-50%,-50%) scale(.5)", opacity: 1 }, { transform: `translate(calc(-50% + ${br.left - ar.left}px), calc(-50% + ${br.top - ar.top}px)) scale(1.4)`, opacity: 1 }], { duration: 700, easing: "ease-in-out" });
          const ring = document.createElement("i");
          ring.className = "bf-fx buff-ring" + tint;
          b.append(ring);
          await rt.anim(ring, [{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 450 });
        } finally { spark.remove(); }
      }
    }
  });
  socket.on("fx", e => HGFx.enqueue(e));

  // "Animations: On / Off" (the skip-all button): lives on the Host panel and the Player panel
  const syncFxToggle = off => document.querySelectorAll(".fx-toggle").forEach(b => { b.textContent = `Animations: ${off ? "Off" : "On"}`; b.classList.toggle("is-off", off); });
  document.querySelectorAll(".fx-toggle").forEach(b => b.addEventListener("click", () => HGFx.setSkipAll(!HGFx.isSkipAll())));
  HGFx.onSkipAll(syncFxToggle);
  syncFxToggle(HGFx.isSkipAll());

  /* ---------- Training buttons ---------- */

  $("train-reset").addEventListener("click", () => socket.emit("training-reset"));         // only the dummy
  $("train-reset-me").addEventListener("click", () => socket.emit("training-reset-me"));   // only you

  document.querySelectorAll("#train-turn .turn-btn").forEach(b => b.addEventListener("click", () => {
    if (trainTurn === b.dataset.turn) return;
    trainTurn = b.dataset.turn;
    closeAim();
    window.HGHost?.closeAttack();
    socket.emit("training-turn", { turn: trainTurn });
    renderTrainTurn();
  }));
  document.querySelectorAll("#train-dice .die").forEach(b => b.addEventListener("click", () => {
    if (trainTurn !== "dummy" || b.disabled) return;
    if (b.dataset.die === "attack") trainAwaitAttack = true;
    socket.emit("training-roll", { die: b.dataset.die });
  }));
  $("train-attack-open").addEventListener("click", openTrainAttack);

/* ---------- Character tab ---------- */

  function renderCharacter() {
    const self = me();
    if (!self) return;
    const info = CLASS_INFO[self.className];
    $("ch-class").textContent = self.className;
    $("ch-hp-size").textContent = `${info.grid}×${info.grid}`;
    const hp = $("ch-hp-grid");
    if (hp.children.length !== info.grid ** 2) HGFx.buildGrid(hp, info.grid);
    HGFx.applyCells(hp, self.hp || [], self.marks || {});          // empty / Over-heal / Guard / Retaliate / Curse
    $("ch-dead").hidden = !self.dead;
    if ($("ch-icon").dataset.cls !== self.className) {
      $("ch-icon").dataset.cls = self.className;
      setImage($("ch-icon"), classIcon(self.className));
      setImage($("ch-character"), `/assets/classes/${self.className.toLowerCase()}/character.png`); // not made yet -> missing.png
    }
  }

  /* ---------- Preparation: assignments from the Host ---------- */

  function assignmentText(a) {
    if (a.kind === "energy") return { title: `Energy +${a.amount}`, text: "The Host is giving you Energy.", button: "Accept" };
    if (a.kind === "join") return { title: "Join Encounter", text: "The Host is dropping you onto the Battlefield.", button: "Join" };
    return { title: `New Card · ${CARDS[a.cardType].name}`, text: `Create a card with ${a.positions} positions, then name it.`, button: "Create" };
  }

  function renderAssignments() {
    const n = myAssignments.length;
    for (const id of ["tab-badge", "sub-badge"]) { $(id).hidden = !n; $(id).textContent = n; }

    const list = $("assignment-list");
    if (!n) {
      const none = document.createElement("p");
      none.className = "panel-note";
      none.textContent = "No assignments.";
      return list.replaceChildren(none);
    }
    list.replaceChildren(...myAssignments.map(a => {
      const t = assignmentText(a);
      const row = document.createElement("article");
      row.className = "assignment";
      const body = document.createElement("div");
      const h = document.createElement("strong");
      h.textContent = t.title;
      const p = document.createElement("p");
      p.textContent = t.text;
      body.append(h, p);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "button primary";
      btn.textContent = t.button;
      btn.addEventListener("click", () => {
        if (a.kind === "card") {
          buildCard({ type: a.cardType, limit: a.positions, assignmentId: a.id });
          showView("card-screen");
        } else {
          socket.emit("accept-assignment", a.id);
        }
      });
      row.append(body, btn);
      return row;
    }));
  }

  socket.on("my-state", state => {
    myCards = state.cards || [];
    myAssignments = state.assignments || [];
    renderHand();
    renderAssignments();
  });

  /* ---------- Player Panel ---------- */

  socket.on("room-joined", data => {
    $("lobby-room-id").textContent = data.roomID;
    myPattern = data.player.movementPattern || [];
    myCards = data.player.cards || [];
    myAssignments = [];
    combatField.showReach = true;
    trainField.showReach = true;
    battle = { players: [], monsters: [], hexAura: [] };
    train = null;
    trainTurn = "player";
    trainAwaitAttack = false;
    renderTrainTurn();
    combatField.cols = 0;
    trainField.cols = 0;
    setTab("combat");
    setSub("overview");
    renderHand();
    renderAssignments();
    showView("lobby-screen");
  });

  $("leave-button").addEventListener("click", () => {
    ask("Leave this server?", () => {
      socket.emit("leave-room");
      resetPlayer();
      showView("home-screen");
    });
  });

  socket.on("room-closed", () => {
    toast("The Host closed the room.");
    resetPlayer();
    showView("home-screen");
  });

  socket.on("disconnect", () => toast("Connection lost. Refresh the page to reconnect."));

  // What encounter.js (Host Monsters / Combat, turn order, initiative, attack picker) needs from this file.
  window.HGApp = { structureArt, socket, $, say, toast, ask, setImage, classIcon, createField, renderField, cellsOf, getBattle: () => battle, isHost };
})();