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

  // The Repair hammer (head on top, handle below: it swings around the bottom of the handle).
  const HAMMER_SVG = '<svg viewBox="0 0 100 100"><rect x="44" y="30" width="12" height="68" rx="4" fill="#b07a3e" stroke="#2b303b" stroke-width="3"/><rect x="16" y="6" width="68" height="30" rx="7" fill="#8b93a3" stroke="#2b303b" stroke-width="4"/></svg>';
  // Breach cracks, 3 stages. Every stage keeps the cracks of the one before.
  const CRACK_PATHS = [
    "M50 50 L38 30 M50 50 L66 36 M50 50 L44 72",
    "M50 50 L38 30 M50 50 L66 36 M50 50 L44 72 M38 30 L28 22 M38 30 L40 14 M66 36 L82 32 M66 36 L74 20 M44 72 L34 86 M44 72 L60 82 M50 50 L24 58",
    "M50 50 L38 30 M50 50 L66 36 M50 50 L44 72 M38 30 L28 22 M38 30 L40 14 M66 36 L82 32 M66 36 L74 20 M44 72 L34 86 M44 72 L60 82 M50 50 L24 58 M28 22 L14 24 M28 22 L20 8 M82 32 L94 44 M74 20 L84 8 M34 86 L18 90 M60 82 L72 94 M24 58 L8 52 M24 58 L14 74 M50 50 L82 62 M82 62 L94 70 M50 50 L60 14"
  ];
  const crackSvg = k => `<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${CRACK_PATHS[k]}" fill="none" stroke="#050507" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="${CRACK_PATHS[k]}" fill="none" stroke="#ffffffb0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

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

    // Blast: the damaged cell glows in the explosion gradient, then ends as an enlarged puff of smoke that fades away.
    async blast(rt, grid, st) {
      await Promise.all(wave0(st).map(async (c, n) => {
        const cell = cellOf(grid, c.idx);
        const fire = add(cell, "blast-fire");
        const smoke = add(cell, "smoke");
        await rt.anim(fire, [{ opacity: 0 }, { opacity: 1, offset: .35 }, { opacity: 1, offset: .7 }, { opacity: 0 }], { duration: 560, delay: n * 40, easing: "ease-in-out" });
        setHp(cell, c.to);
        await rt.anim(smoke, [{ transform: "scale(.7)", opacity: 0 }, { transform: "scale(1.5)", opacity: .95, offset: .3 }, { transform: "scale(2.8)", opacity: 0 }], { duration: 950 });
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

    // Spellvamp: the cells shake wildly in purple, then pop away, taking their Armor and Over-heal with them.
    async spellvamp(rt, grid, st) {
      const cells = [...new Set([...markChanges(st, false).filter(c => c.mark === "armor").map(c => c.idx), ...hpChanges(st).map(c => c.idx)])];
      const WILD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(k => ({ transform: `translate(${k % 2 ? -1 : 1}px, 0)` }));
      await Promise.all(cells.map(async (idx, n) => {
        const cell = cellOf(grid, idx);
        const vamp = add(cell, "vamp");
        const kf = WILD.map((f, k) => ({ transform: `translate(${(k % 2 ? -1 : 1) * (3 + (k % 3) * 2)}px, ${(k % 3 - 1) * 2}px) rotate(${(k % 2 ? -1 : 1) * 4}deg)` }));
        await Promise.all([
          rt.anim(cell, kf, { duration: 760, delay: n * 50, fill: "none", easing: "linear" }),
          rt.anim(vamp, [{ opacity: 0 }, { opacity: .95, offset: .3 }, { opacity: .95 }], { duration: 760, delay: n * 50 })
        ]);
        const hp = hpChanges(st).find(c => c.idx === idx);
        if (hp) setHp(cell, hp.to);
        cell.classList.remove("armored");
        await rt.anim(vamp, [{ transform: "scale(1)", opacity: .95 }, { transform: "scale(1.5)", opacity: 1, offset: .35 }, { transform: "scale(.1)", opacity: 0 }], { duration: 380 });
      }));
    },

    // Penetrate: a lance goes through the Armor, which cracks in two and falls away.
    async penetrate(rt, grid, st) {
      const arm = markChanges(st, false).filter(c => c.mark === "armor");
      await Promise.all(arm.map(async (c, n) => {
        await rt.wait(n * 260);
        const cell = cellOf(grid, c.idx);
        const lance = add(cell, "lance");
        await rt.anim(lance, [{ transform: "translateY(-260%)", opacity: 1 }, { transform: "translateY(0)", opacity: 1 }], { duration: 170, easing: "cubic-bezier(.7,0,1,.6)" });
        const l = add(cell, "armor-half left"), r = add(cell, "armor-half right");
        cell.classList.remove("armored");
        await Promise.all([
          rt.anim(l, [{ transform: "translate(0,0) rotate(0deg)", opacity: 1 }, { transform: "translate(-70%, 90%) rotate(-30deg)", opacity: 0 }], { duration: 520, easing: "ease-in" }),
          rt.anim(r, [{ transform: "translate(0,0) rotate(0deg)", opacity: 1 }, { transform: "translate(70%, 90%) rotate(30deg)", opacity: 0 }], { duration: 520, easing: "ease-in" }),
          rt.anim(lance, [{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 80 })
        ]);
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

    // Repair: a hammer hits the cell twice. The second hit mends it.
    async repair(rt, grid, st) {
      await Promise.all(hpChanges(st).map(async (c, n) => {
        await rt.wait(n * 260);
        const cell = cellOf(grid, c.idx);
        const hm = add(cell, "hammer");
        hm.innerHTML = HAMMER_SVG;
        const pose = (y, rot, o = 1) => ({ transform: `translateY(${y}%) rotate(${rot}deg)`, opacity: o });
        const bonk = async big => {
          await rt.anim(hm, [pose(-42, 26), pose(0, -28)], { duration: big ? 150 : 190, easing: "cubic-bezier(.7,0,1,.6)" });          // swing down
          const sp = [0, 1, 2, 3, 4].map(i => {
            const o = add(cell, "spark"), a = i / 5 * Math.PI * 2 + .6;
            return rt.anim(o, [{ transform: "translate(-50%,-50%) scale(.6)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * 160}%), calc(-50% + ${Math.sin(a) * 160}%)) scale(.2)`, opacity: 0 }], { duration: 330 });
          });
          await Promise.all([rt.anim(cell, [{ transform: "scale(1)" }, { transform: `scale(${big ? .7 : .84})` }, { transform: "scale(1)" }], { duration: 190, fill: "none" }), ...sp,
            rt.anim(hm, [pose(0, -28), pose(0, -32), pose(0, -28)], { duration: 120, fill: "forwards" })]);
        };
        await bonk(false);
        await rt.anim(hm, [pose(0, -28), pose(-40, 22)], { duration: 200, easing: "ease-out" });
        await bonk(true);
        const ghost = add(cell, c.to === 2 ? "ghost-over" : "ghost-hp");
        await Promise.all([
          rt.anim(ghost, [{ transform: "scale(0)", opacity: 0.3 }, { transform: "scale(1.3)", opacity: 1, offset: 0.6 }, { transform: "scale(1)", opacity: 1 }], { duration: 420 }),
          rt.anim(hm, [pose(0, -28), pose(-60, 30, 0)], { duration: 420, delay: 120 })
        ]);
      }));
    },

    // Breach: like breaking a block in Minecraft, but in 3 separate hits: THUD... THUD- THUD!! Each hit cracks the cell more, the last one shatters it.
    async breach(rt, grid, st) {
      const ch = wave0(st);
      const cracks = ch.map(c => add(cellOf(grid, c.idx), "crack"));
      const WORDS = ["THUD.", "THUD-", "THUD!!"], GAPS = [760, 260];
      for (let k = 0; k < 3; k++) {
        cracks.forEach(o => { o.innerHTML = crackSvg(k); });
        const word = add(grid, "thud");
        word.textContent = WORDS[k];
        await Promise.all([
          rt.anim(word, [{ transform: `translateY(-50%) scale(${.5 + k * .15})`, opacity: 0 }, { transform: `translateY(-50%) scale(${1.25 + k * .2})`, opacity: 1, offset: .25 }, { transform: `translateY(-70%) scale(${1 + k * .1})`, opacity: 0 }], { duration: 560 + k * 120 }),
          rt.anim(grid, [{ transform: "translate(0,0)" }, { transform: `translate(${-3 - k * 3}px, ${2 + k * 2}px)` }, { transform: `translate(${3 + k * 3}px, ${-2 - k * 2}px)` }, { transform: `translate(${-2 - k * 2}px, ${-1 - k}px)` }, { transform: "translate(0,0)" }], { duration: 200 + k * 60, fill: "none" }),
          ...cracks.map(o => rt.anim(o, [{ transform: "scale(1.22)", filter: "brightness(2.2)" }, { transform: "scale(1)", filter: "brightness(1)" }], { duration: 190, fill: "none" }))
        ]);
        if (k < 2) await rt.wait(GAPS[k]);
      }
      await Promise.all(ch.map((c, n) => {
        const cell = cellOf(grid, c.idx);
        setHp(cell, c.to);
        const over = c.from === 2;
        const bits = Array.from({ length: 7 }, (_, i) => {
          const sh = add(cell, "shard" + (over ? " over" : "")), a = i / 7 * Math.PI * 2 + n, far = 90 + (i % 3) * 40;
          sh.style.clipPath = `polygon(${10 + (i * 13) % 30}% 0, 100% ${20 + (i * 17) % 40}%, ${60 + (i * 7) % 30}% 100%, 0 ${50 + (i * 11) % 40}%)`;
          return rt.anim(sh, [{ transform: "translate(-50%,-50%) scale(1) rotate(0deg)", opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * far}%), calc(-50% + ${Math.sin(a) * far + 40}%)) scale(.4) rotate(${(i % 2 ? 1 : -1) * 240}deg)`, opacity: 0 }], { duration: 620, easing: "cubic-bezier(.2,.6,.4,1)" });
        });
        cracks[n].remove();
        return Promise.all([popCell(rt, grid, c), ...bits]);
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
      for (const o of rows) await rt.anim(o, [{ opacity: 0 }, { opacity: 0.92 }], { duration: 170 });
      await Promise.all(hpChanges(st).map(c => {
        const ghost = add(cellOf(grid, c.idx), "ghost-hp");
        return rt.anim(ghost, [{ transform: "scale(0)", opacity: 0.4 }, { transform: "scale(1.45)", opacity: 1, offset: 0.55 }, { transform: "scale(1)", opacity: 1 }], { duration: 480 });
      }));
      for (const o of rows) await rt.anim(o, [{ opacity: 0.92 }, { opacity: 0 }], { duration: 170 });
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
    S.title.textContent = e.type === "strike" ? `${e.actor.name} attacks` : e.type === "presence" ? `${e.actor.name} the Tank activated Presence` : `${e.actor.name} used ${e.name}`;
  }

  async function playMain(e) {
    const S = stage();
    S.card.hidden = false; S.panel.hidden = true; S.stacks.hidden = true;
    S.card.className = "fx-card";
    setIcon(S, e);
    S.el.hidden = false;
    S.el.classList.add("show");

    // Presence: every screen fills with "!" and fades to black. The card then shows who activated it.
    let away = null;
    if (e.type === "presence" && window.HGFxField) {
      const danger = await window.HGFxField.presenceDanger(rt, document.body, false);
      away = danger.fadeAway();
    }

    // 1. the icon shakes for 0.3 seconds (Guard hidden from the Host: this is all the Host sees of it)
    await rt.anim(S.icon, SHAKE_ICON, { duration: 300, fill: "none" });
    if (away) await away;

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
        if (e.type === "repair") st.anim = "repair";                         // the server sends these as "heal" / "pop"; they get their own animation
        else if (e.type === "breach" && st.anim === "pop") st.anim = "breach";
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
      document.querySelectorAll(".fxf-danger:not(.scoped)").forEach(o => o.remove());
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
