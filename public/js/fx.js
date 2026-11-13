// Heart Grid - card animations.
// The server decides what happened and sends an "fx" event (see cards.js). This file only plays it:
//   1. the card icon shakes for 0.3s
//   2. HP-Grid cards show the grid that changed, cell by cell. Charge cards explode and show "old > new".
//      Battlefield cards (Hex, Buff) play on the battlefield itself, with no icon pop-up.
// Press any key or click to skip the current animation. "Skip all animations" turns them off until you turn them on again.
window.HGFx = (() => {
  const HP_COLOR = "#5fbf7a";
  const classIcon = name => `/assets/classes/${name.toLowerCase()}/${name.toLowerCase()}.png`;

  /* ---------- runtime: waits and animations that can be skipped ---------- */

  const SKIP = { skipped: true };
  function makeRT() {
    let cancelled = false;
    const active = new Set();
    let sleepers = [];
    const check = () => { if (cancelled) throw SKIP; };
    return {
      get cancelled() { return cancelled; },
      check,
      wait(ms) {
        return new Promise(res => {
          const t = setTimeout(() => { sleepers = sleepers.filter(s => s !== done); res(); }, ms);
          const done = () => { clearTimeout(t); res(); };
          sleepers.push(done);
        }).then(check);
      },
      anim(el, keyframes, opts) {
        if (cancelled) throw SKIP;
        const a = el.animate(keyframes, { fill: "forwards", easing: "ease-out", ...opts });
        active.add(a);
        return a.finished.catch(() => {}).then(() => { active.delete(a); check(); });
      },
      skip() {
        cancelled = true;
        active.forEach(a => { try { a.finish(); } catch (e) { /* element already gone */ } });
        sleepers.forEach(f => f());
        sleepers = [];
      }
    };
  }

  /* ---------- HP grid rendering ---------- */

  function buildGrid(el, n) {
    el.style.setProperty("--n", n);
    el.replaceChildren(...Array.from({ length: n * n }, () => document.createElement("span")));
    return el;
  }

  // cells: 0 empty, 1 healthy, 2 Over-heal. marks: { guard, ret, curse }
  function applyCells(grid, cells, marks = {}) {
    [...grid.children].forEach((s, i) => {
      if (s.classList.contains("fx-o")) return;
      s.classList.toggle("empty", cells[i] === 0);
      s.classList.toggle("over", cells[i] === 2);
      s.classList.toggle("armored", cells[i] > 0 && !!marks.armor?.[i]);      // layers: HP cell (back) > Armor icon (middle) > Over-heal square (front)
      s.classList.toggle("m-guard", !!marks.guard?.[i]);
      s.classList.toggle("m-ret", !!marks.ret?.[i]);
      s.classList.toggle("m-curse", !!marks.curse?.[i]);
    });
  }

  function clearOverlays(grid) {
    grid.getAnimations({ subtree: true }).forEach(a => a.cancel());
    grid.querySelectorAll(".fx-o").forEach(o => o.remove());
  }

  /* ---------- per-card cell animations ---------- */

  const cellOf = (grid, i) => grid.children[i];
  function add(cell, cls) {
    const o = document.createElement("i");
    o.className = "fx-o " + cls;
    cell.append(o);
    return o;
  }
  const setHp = (cell, v) => { cell.classList.toggle("empty", v === 0); cell.classList.toggle("over", v === 2); };
  const hpChanges = st => st.changes.filter(c => c.from !== undefined);
  const markChanges = (st, on) => st.changes.filter(c => c.mark && (on === undefined || c.on === on));
  const wave0 = st => hpChanges(st).filter(c => !c.wave);
  const SHAKE = [{ transform: "translate(0,0)" }, { transform: "translate(-3px,2px)" }, { transform: "translate(3px,-2px)" }, { transform: "translate(-2px,-2px)" }, { transform: "translate(0,0)" }];
  const shakeGrid = (rt, grid) => rt.anim(grid, SHAKE, { duration: 180, fill: "none" });

  const popKf = [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.45)", opacity: 1, offset: 0.4 }, { transform: "scale(.1)", opacity: 0 }];

  // Damage cells: healthy cells pop away, the Over-heal square pops off a healthy cell.
  function popCell(rt, grid, c, ring) {
    const cell = cellOf(grid, c.idx);
    const ghost = add(cell, c.from === 2 ? "ghost-over" : "ghost-hp");
    if (ring) ghost.classList.add(ring);
    setHp(cell, c.to);
    return rt.anim(ghost, popKf, { duration: 360 });
  }

  // Curse: marked cells shake and explode, then the cells around them shake and pop, wave after wave, all in one go.
  async function runWaves(rt, grid, st) {
    const max = Math.max(0, ...st.changes.map(c => c.wave || 0));
    for (let k = 1; k <= max; k++) {
      const src = markChanges(st, false).filter(c => c.mark === "curse" && (c.wave || 0) === k - 1).map(c => c.idx);
      await Promise.all(src.map(i => {
        const cell = cellOf(grid, i);
        cell.classList.remove("m-curse");
        return rt.anim(add(cell, "curse-mark"), [{ transform: "translate(0,0)" }, { transform: "translate(-3px,2px)" }, { transform: "translate(3px,-2px)" }, { transform: "translate(-3px,-1px)" }, { transform: "translate(2px,2px)" }, { transform: "translate(0,0)" }], { duration: 260 });
      }));
      await Promise.all([
        ...src.map(i => rt.anim(add(cellOf(grid, i), "curse-burst"), [{ transform: "scale(.4)", opacity: 1 }, { transform: "scale(1.9)", opacity: 0 }], { duration: 420 })),
        ...hpChanges(st).filter(c => (c.wave || 0) === k).map(c => popCell(rt, grid, c, "violet"))
      ]);
    }
  }

  const RECIPES = {
    async pop(rt, grid, st) {
      await Promise.all(wave0(st).map(c => popCell(rt, grid, c)));
    },
    "retaliate-hit": async (rt, grid, st) => {
      await Promise.all(wave0(st).map(c => popCell(rt, grid, c, "green")));
    },

    async heal(rt, grid, st) {
      await Promise.all(hpChanges(st).map(c => {
        const ghost = add(cellOf(grid, c.idx), c.to === 2 ? "ghost-over" : "ghost-hp");
        return rt.anim(ghost, [{ transform: "scale(0)", opacity: 0.3 }, { transform: "scale(1.25)", opacity: 1, offset: 0.65 }, { transform: "scale(1)", opacity: 1 }], { duration: 520 });
      }));
    },

    async blast(rt, grid, st) {
      await Promise.all(wave0(st).map(c => {
        const cell = cellOf(grid, c.idx);
        setHp(cell, c.to);
        const fire = add(cell, "blast-fire");
        const smoke = add(cell, "smoke");
        return Promise.all([
          rt.anim(fire, [{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.5)", opacity: 1, offset: 0.55 }, { transform: "scale(2)", opacity: 0 }], { duration: 520 }),
          rt.anim(smoke, [{ transform: "scale(.6) translateY(0)", opacity: 0 }, { transform: "scale(1.4) translateY(-10%)", opacity: 0.8, offset: 0.35 }, { transform: "scale(2.6) translateY(-45%)", opacity: 0 }], { duration: 900, delay: 220 })
        ]);
      }));
    },

    async execute(rt, grid, st) {
      const ch = wave0(st);
      await Promise.all(ch.map(async (c, n) => {
        await rt.wait(n * 70);
        const cell = cellOf(grid, c.idx);
        await rt.anim(add(cell, "slash"), [{ transform: "rotate(-35deg) scaleX(0)", opacity: 1 }, { transform: "rotate(-35deg) scaleX(1.2)", opacity: 1, offset: 0.7 }, { transform: "rotate(-35deg) scaleX(1.2)", opacity: 0 }], { duration: 220 });
        await popCell(rt, grid, c);
      }));
    },

    async poison(rt, grid, st) {
      await Promise.all(wave0(st).map(async c => {
        const cell = cellOf(grid, c.idx);
        const acid = add(cell, "acid");
        await rt.anim(acid, [{ opacity: 0 }, { opacity: 1 }], { duration: 750, easing: "ease-in" });
        setHp(cell, c.to);
        await rt.anim(acid, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.85)" }], { duration: 420 });
      }));
    },

    async rage(rt, grid, st) {
      await Promise.all(hpChanges(st).map(async c => {
        const cell = cellOf(grid, c.idx);
        const ghost = add(cell, "ghost-hp");
        setHp(cell, c.to);
        const steam = add(cell, "steam");
        await Promise.all([
          rt.anim(ghost, [{ backgroundColor: HP_COLOR }, { backgroundColor: "#ff5a60" }], { duration: 950, easing: "ease-in" }),
          rt.anim(steam, [{ transform: "translateY(10%) scale(.7)", opacity: 0 }, { transform: "translateY(-30%) scale(1)", opacity: 0.9, offset: 0.5 }, { transform: "translateY(-80%) scale(1.3)", opacity: 0 }], { duration: 950 })
        ]);
        await rt.anim(ghost, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.5)", opacity: 1, offset: 0.4 }, { transform: "scale(.1)", opacity: 0 }], { duration: 300 });
      }));
    },

    // Guard: the Tank's icon pops on the cell, then light blue smashes in 1/3, 2/3, 3/3 and covers the icon.
    async guard(rt, grid, st) {
      await Promise.all(markChanges(st, true).map(async c => {
        const cell = cellOf(grid, c.idx);
        const icon = add(cell, "tank-icon");
        await rt.anim(icon, [{ transform: "scale(0)", opacity: 0 }, { transform: "scale(1.35)", opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }], { duration: 380 });
        const fill = add(cell, "fill-guard");
        for (const part of [1 / 3, 2 / 3, 1]) {
          await rt.anim(fill, [{ transform: `scaleY(${part - 1 / 3})` }, { transform: `scaleY(${part})` }], { duration: 150, easing: "cubic-bezier(.6,0,1,.6)" });
          shakeGrid(rt, grid);
        }
        icon.remove();
      }));
    },
    async "guard-break"(rt, grid, st) {
      await Promise.all(markChanges(st, false).map(c => {
        const cell = cellOf(grid, c.idx);
        cell.classList.remove("m-guard");
        return rt.anim(add(cell, "fill-guard"), [{ transform: "scaleY(1) scale(1)", opacity: 1 }, { transform: "scaleY(1) scale(1.5)", opacity: 0 }], { duration: 420 });
      }));
    },

    // Retaliate: the cell swells into deep green, then thumps into place.
    async retaliate(rt, grid, st) {
      await Promise.all(markChanges(st, true).map(async c => {
        const fill = add(cellOf(grid, c.idx), "fill-ret");
        await rt.anim(fill, [{ transform: "scale(.2)" }, { transform: "scale(1.7)" }], { duration: 380 });
        await rt.anim(fill, [{ transform: "scale(1.7)" }, { transform: "scale(.95)" }, { transform: "scale(1)" }], { duration: 170, easing: "ease-in" });
        shakeGrid(rt, grid);
      }));
    },

    async curse(rt, grid, st) {
      await Promise.all(markChanges(st, true).map(async c => {
        const fill = add(cellOf(grid, c.idx), "fill-curse");
        await rt.anim(fill, [{ transform: "scale(0)", opacity: 0.4 }, { transform: "scale(1.3)", opacity: 1, offset: 0.65 }, { transform: "scale(1)", opacity: 1 }], { duration: 480 });
      }));
    },

    // Lifesteal: the top row turns red, then the middle, then the bottom. Empty cells it heals swell green.
    // Then the red fades away from top to bottom.
    async lifesteal(rt, grid, st) {
      const n = st.target.n;
      const rows = Array.from({ length: n }, (_, r) => {
        const o = document.createElement("i");
        o.className = "fx-o row-red";
        o.style.top = (r * 100 / n) + "%";
        o.style.height = (100 / n) + "%";
        grid.append(o);
        return o;
      });
      for (const o of rows) await rt.anim(o, [{ opacity: 0 }, { opacity: 0.55 }], { duration: 170 });
      await Promise.all(hpChanges(st).map(c => {
        const ghost = add(cellOf(grid, c.idx), "ghost-hp");
        return rt.anim(ghost, [{ transform: "scale(0)", opacity: 0.4 }, { transform: "scale(1.45)", opacity: 1, offset: 0.55 }, { transform: "scale(1)", opacity: 1 }], { duration: 480 });
      }));
      for (const o of rows) await rt.anim(o, [{ opacity: 0.55 }, { opacity: 0 }], { duration: 170 });
    }
  };

  async function playStep(rt, grid, st) {
    clearOverlays(grid);
    applyCells(grid, st.before.cells, st.before.marks);
    await rt.wait(260);
    await (RECIPES[st.anim] || RECIPES.pop)(rt, grid, st);
    await runWaves(rt, grid, st);
    applyCells(grid, st.after.cells, st.after.marks);
    clearOverlays(grid);
    await rt.wait(380);
  }

  /* ---------- the overlay everybody sees ---------- */

  const $ = id => document.getElementById(id);
  const queue = [];
  let playing = false;
  let rt = null;
  let hooks = {};
  let skipAll = false;
  const listeners = [];
  try { skipAll = localStorage.getItem("hg-skip-fx") === "1"; } catch (e) { /* storage blocked: default */ }

  const SHAKE_ICON = [
    { transform: "translate(0,0) rotate(0)" }, { transform: "translate(-7px,3px) rotate(-8deg)" }, { transform: "translate(6px,-4px) rotate(7deg)" },
    { transform: "translate(-6px,-3px) rotate(-6deg)" }, { transform: "translate(7px,4px) rotate(8deg)" }, { transform: "translate(0,0) rotate(0)" }
  ];

  function setSkipAll(on) {
    skipAll = !!on;
    try { localStorage.setItem("hg-skip-fx", skipAll ? "1" : "0"); } catch (e) { /* ignore */ }
    if (skipAll) { queue.length = 0; if (rt) rt.skip(); }
    listeners.forEach(f => f(skipAll));
  }
  const skip = () => { if (rt) rt.skip(); };

  function stage() {
    const el = $("fx");
    return {
      el,
      card: el.querySelector(".fx-card"), icon: el.querySelector(".fx-icon"), title: el.querySelector(".fx-title"),
      panel: el.querySelector(".fx-panel"), ptitle: el.querySelector(".fx-ptitle"), grid: el.querySelector(".fx-grid"), caption: el.querySelector(".fx-caption"),
      stacks: el.querySelector(".fx-stacks")
    };
  }

  function setIcon(S, e) {
    const chain = window.HGCards.iconChain(e.icon);           // own folder, the other card folders (battlefield-grid too), then /assets/cards/
    let i = 0;
    S.icon.onerror = () => { if (++i < chain.length) { S.icon.src = chain[i]; return; } S.icon.onerror = null; S.icon.src = "/assets/missing.png"; };
    S.icon.src = chain[0];
    S.title.textContent = e.type === "strike" ? `${e.actor.name} attacks` : `${e.actor.name} used ${e.name}`;
  }

  async function playMain(e) {
    const S = stage();
    S.card.hidden = false; S.panel.hidden = true; S.stacks.hidden = true;
    S.card.className = "fx-card";
    setIcon(S, e);
    S.el.hidden = false;
    S.el.classList.add("show");

    // 1. the icon shakes for 0.3 seconds (Guard hidden from the Host: this is all the Host sees of it)
    await rt.anim(S.icon, SHAKE_ICON, { duration: 300, fill: "none" });

    if (e.mode === "charge") {
      // charge / turn-based: the icon explodes, comes back, and the stacks show "old > new"
      S.card.classList.add("boom");
      await rt.anim(S.icon, [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.9)", opacity: 0 }], { duration: 380, fill: "none" });
      S.card.classList.remove("boom");
      S.stacks.hidden = false;
      S.stacks.innerHTML = `<s>${e.charge.from}</s><span class="fx-arrow">&gt;</span><b>${e.charge.to}</b>`;
      await Promise.all([
        rt.anim(S.icon, [{ transform: "scale(.5)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { duration: 300, fill: "none" }),
        rt.anim(S.stacks, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 300, fill: "none" })
      ]);
      await rt.anim(S.stacks.querySelector("b"), [{ transform: "scale(1)" }, { transform: "scale(1.6)" }, { transform: "scale(1.3)" }], { duration: 380 });
      await rt.wait(900);
      return;
    }

    if (e.mode === "grid" && e.steps.length) {
      S.card.classList.add("small");
      let shownId = null;
      for (const st of e.steps) {
        const key = st.target.kind + st.target.id;
        if (key !== shownId) {
          shownId = key;
          S.panel.hidden = false;
          S.ptitle.textContent = `${st.target.name}'s HP Grid`;
          buildGrid(S.grid, st.target.n);
          S.grid.classList.toggle("is-monster", st.target.kind === "monster");
          await rt.anim(S.panel, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 180, fill: "none" });
        }
        S.caption.textContent = st.caption || "";
        await playStep(rt, S.grid, st);
      }
      await rt.wait(350);
      return;
    }

    // Host seeing a Guard card, or nothing else to show: a short beat on the icon
    await rt.wait(650);
  }

  async function run(e) {
    rt = makeRT();
    const S = stage();
    try {
      if (e.mode === "battlefield") {
        // Hex / Buff play on the battlefield itself
        await (hooks.battlefield ? hooks.battlefield(e, rt) : Promise.resolve());
      } else {
        await playMain(e);
      }
    } catch (err) {
      if (err !== SKIP) console.error(err);
    } finally {
      S.el.classList.remove("show");
      S.el.hidden = true;
      clearOverlays(S.grid);
      rt = null;
    }
  }

  async function pump() {
    if (playing) return;
    playing = true;
    while (queue.length) await run(queue.shift());
    playing = false;
  }

  function enqueue(e) {
    if (skipAll) return;
    queue.push(e);
    pump();
  }

  // Any key or click skips the animation that is playing right now.
  document.addEventListener("keydown", () => { if (rt) skip(); }, true);
  document.addEventListener("pointerdown", ev => {
    if (!rt || ev.target.closest(".fx-skipall")) return;
    skip();
  }, true);
  document.addEventListener("DOMContentLoaded", () => {
    $("fx")?.querySelector(".fx-skipall")?.addEventListener("click", () => setSkipAll(true));
  });

  return {
    classIcon, buildGrid, applyCells, clearOverlays, makeRT, playStep,
    enqueue, skip, setSkipAll, isSkipAll: () => skipAll, onSkipAll: f => listeners.push(f),
    setHooks: h => { hooks = h; }
  };
})();
