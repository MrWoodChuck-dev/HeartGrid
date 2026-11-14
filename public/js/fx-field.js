// Heart Grid - Battlefield card animations: Trail, Smoke, Force, Gravity, Clone, Hold, Move, and the Presence "danger" screen.
// (Repair and Breach play on the target's HP Grid, so their recipes live in fx.js.)
//
// One adapter describes "a field": the element everything is drawn over, how to find a cell, and where a Monster is.
// The real battlefield and the 7x7 sample grid in the card dialog both use it, so what you see in the dialog is exactly what plays in a fight.
//   HGFxField.playReal(field, bf, rt)  -> main.js, for the "fx" event of a Battlefield card
//   HGFxField.stage(kind)              -> the card dialog: a 7x7 sample grid that loops the animation
//   HGFxField.presenceDanger(rt, host, scoped) -> the exclamation-mark screen, used by fx.js (full screen) and the dialog (inside the sample grid)
window.HGFxField = (() => {
  "use strict";

  const ICON = name => `/assets/cards/battlefield-grid/${name}.png`;
  const classIcon = name => `/assets/classes/${name.toLowerCase()}/${name.toLowerCase()}.png`;
  const R = Math.random;
  const mk = (cls, tag = "i") => { const n = document.createElement(tag); n.className = cls; return n; };
  const bg = p => { p.catch(() => {}); return p; };            // an animation nobody waits for: never report "skipped" as an error
  const px = n => n.toFixed(1) + "px";

  /* ---------- the adapter: where is everything? ---------- */

  function adapt(root, cellFn) {
    return {
      root,
      cell: cellFn,
      // Rectangle of 1 or more cells, in pixels, relative to the field. null if none of them are on screen.
      rect(x, y, w = 1, h = 1) {
        const rr = root.getBoundingClientRect();
        let l = 1e9, t = 1e9, r = -1e9, b = -1e9;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          const c = cellFn(x + i, y + j);
          if (!c) continue;
          const q = c.getBoundingClientRect();
          if (!q.width) continue;
          l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom);
        }
        if (l === 1e9) return null;
        const o = { l: l - rr.left - root.clientLeft, t: t - rr.top - root.clientTop, w: r - l, h: b - t };
        o.cx = o.l + o.w / 2; o.cy = o.t + o.h / 2;
        return o;
      },
      monster: id => root.querySelector(`.bf-monster[data-id="${String(id).replace(/"/g, "")}"]`)
    };
  }
  const realAdapter = f => adapt(f.el, (x, y) => f.cell(x, y));

  const put = (L, el, cx, cy) => { el.style.left = px(cx); el.style.top = px(cy); L.append(el); return el; };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function centroid(cells) {
    return { x: cells.reduce((s, c) => s + c.x, 0) / cells.length, y: cells.reduce((s, c) => s + c.y, 0) / cells.length };
  }
  // The field shakes (an impact): amplitude in px.
  const shakeField = (rt, A, amp, ms = 380) => {
    const kf = [{ transform: "translate(0,0)" }];
    for (let i = 1; i <= 7; i++) { const k = (1 - i / 8) * amp; kf.push({ transform: `translate(${px(i % 2 ? -k : k)}, ${px(i % 3 ? k * .5 : -k * .5)})` }); }
    kf.push({ transform: "translate(0,0)" });
    return rt.anim(A.root, kf, { duration: ms, fill: "none", easing: "linear" });
  };

  /* ---------- Trail: an engine starting up ---------- */
  // Cells shake from left to right. The center starts, then the shaking spreads outward, wild at first, then slowing down to a stop.

  function engineKeyframes(D, amp) {
    const kf = [{ transform: "translateX(0)", offset: 0 }];
    let t = 0, k = 0;
    for (;;) {
      t += 32 + Math.pow(t / D, 1.7) * 170;                                  // the gaps grow: the shaking slows down
      if (t >= D * 0.96) break;
      const env = Math.min(1, t / (D * 0.12)) * (1 - 0.7 * Math.pow(t / D, 1.3));
      kf.push({ transform: `translateX(${px((k++ % 2 ? -1 : 1) * amp * env)})`, offset: t / D });
    }
    kf.push({ transform: "translateX(0)", offset: 1 });
    return kf;
  }

  async function trail({ A, e, rt, L, undo }) {
    const cells = (e.cells || []).map(([x, y]) => ({ x, y, c: A.cell(x, y), r: A.rect(x, y) })).filter(o => o.c && o.r);
    if (!cells.length) { await rt.wait(500); return; }
    if (e.off) {                                                              // removed: the glow just winds down
      await Promise.all(cells.map(o => {
        const g = mk("fxf-glow trail"); put(L, g, o.r.l, o.r.t); g.style.width = px(o.r.w); g.style.height = px(o.r.h);
        return rt.anim(g, [{ opacity: .8 }, { opacity: 0 }], { duration: 600 });
      }));
      return;
    }
    const mid = centroid(cells);
    cells.forEach(o => { o.d = dist(o, mid); });
    const maxD = Math.max(...cells.map(o => o.d));
    const STEP = 190, TAIL = 1500;
    const end = maxD * STEP + TAIL;
    cells.forEach(o => { o.c.style.zIndex = "3"; undo.push(() => { o.c.style.zIndex = ""; }); });
    await Promise.all(cells.map(async o => {
      const delay = o.d * STEP, D = end - delay;
      const g = mk("fxf-glow trail"); put(L, g, o.r.l, o.r.t); g.style.width = px(o.r.w); g.style.height = px(o.r.h);
      bg(rt.anim(g, [{ opacity: 0 }, { opacity: .6, offset: .12 }, { opacity: .35, offset: .8 }, { opacity: 0 }], { duration: D, delay, easing: "linear", fill: "both" }));
      await rt.anim(o.c, engineKeyframes(D, Math.max(4, o.r.w * .16)), { duration: D, delay, fill: "none", easing: "linear" });
    }));
  }

  /* ---------- Smoke / Clone: puffs ---------- */

  // The cell itself swells into a grey cloud and fades away.
  function fog(L, r) {
    const f = mk("fxf-fog");
    f.style.cssText = `left:${px(r.l)};top:${px(r.t)};width:${px(r.w)};height:${px(r.h)}`;
    L.append(f);
    return f;
  }

  async function smoke({ A, e, rt, L }) {
    const cells = (e.cells || []).map(([x, y]) => ({ x, y, r: A.rect(x, y) })).filter(o => o.r);
    if (!cells.length) { await rt.wait(500); return; }
    const off = !!e.off, mid = centroid(cells);
    await Promise.all(cells.map(o => {
      const kf = off
        ? [{ transform: "scale(1)", opacity: .8 }, { transform: "scale(1.9)", opacity: 0 }]
        : [{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1)", opacity: .95, offset: .3 }, { transform: "scale(1.15)", opacity: .85, offset: .55 }, { transform: "scale(2.1)", opacity: 0 }];
      return rt.anim(fog(L, o.r), kf, { duration: off ? 700 : 1100, delay: dist(o, mid) * 90, easing: "ease-out", fill: "both" });
    }));
  }

  // Clone: just a puff of smoke. The Clone is already standing there when it clears (onPeak = "now the Clone is on the field").
  async function clone({ A, e, rt, L }) {
    if (e.x == null) { await rt.wait(400); return; }
    const r = A.rect(e.x, e.y);
    if (!r) { await rt.wait(400); return; }
    const parts = [0, 1].map(k => rt.anim(fog(L, r), [
      { transform: "scale(.5)", opacity: 0 }, { transform: "scale(1.1)", opacity: 1, offset: .28 },
      { transform: "scale(1.7)", opacity: .85, offset: .55 }, { transform: `scale(${2.6 + k * .5})`, opacity: 0 }], { duration: 1000, delay: k * 120, easing: "ease-out", fill: "both" }));
    bg(rt.wait(280).then(() => { if (e.onPeak) e.onPeak(); }));              // thickest point of the smoke
    await Promise.all(parts);
  }

  /* ---------- Hold: smack the Hold icon onto the Monster ---------- */

  async function hold({ A, e, rt, L }) {
    const r = A.rect(e.x, e.y, e.w || 1, e.h || 1);
    if (!r) { await rt.wait(500); return; }
    const mon = A.monster(e.id);
    const size = Math.max(r.w, r.h) * 1.05;
    const icon = mk("fxf-holdicon", "img");
    icon.alt = ""; icon.src = ICON("hold");
    icon.onerror = () => { icon.onerror = null; icon.src = "/assets/missing.png"; };
    icon.style.width = px(size);
    put(L, icon, r.cx, r.cy);
    const T = (s, rot, o) => ({ transform: `translate(-50%,-50%) translateY(${px(-r.h * (s > 1 ? 1.1 : 0))}) scale(${s}) rotate(${rot}deg)`, opacity: o });
    await rt.anim(icon, [T(2.2, -10, 0), T(2.8, -24, 1)], { duration: 300, easing: "cubic-bezier(.2,.7,.3,1)" });      // winds up, huge
    await rt.wait(140);
    await rt.anim(icon, [T(2.8, -24, 1), { transform: "translate(-50%,-50%) scale(1) rotate(0deg)", opacity: 1 }], { duration: 95, easing: "cubic-bezier(.8,0,1,.6)" });   // SMACK
    // impact
    const flash = mk("fxf-flash"); flash.style.cssText = `left:${px(r.l - 4)};top:${px(r.t - 4)};width:${px(r.w + 8)};height:${px(r.h + 8)}`; L.append(flash);
    const ringKf = [{ transform: "translate(-50%,-50%) scale(.2)", opacity: .95 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 0 }];
    const rings = [0, 90].map(delay => {
      const g = mk("fxf-shock"); g.style.width = px(Math.max(r.w, r.h) * 2.6); g.style.height = g.style.width; put(L, g, r.cx, r.cy);
      return rt.anim(g, ringKf, { duration: 520, delay, easing: "ease-out", fill: "both" });
    });
    const dust = Array.from({ length: 10 }, (_, i) => {
      const d = mk("fxf-dust"), a = i / 10 * Math.PI * 2 + R() * .4, far = Math.max(r.w, r.h) * (.8 + R() * .6);
      d.style.width = d.style.height = px(5 + R() * 6); put(L, d, r.cx, r.cy);
      return rt.anim(d, [{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${px(Math.cos(a) * far)}), calc(-50% + ${px(Math.sin(a) * far)})) scale(.2)`, opacity: 0 }], { duration: 520, easing: "ease-out", fill: "both" });
    });
    const squash = mon ? rt.anim(mon, [{ transform: "scale(1,1)" }, { transform: "scale(1.28,.62)", offset: .25 }, { transform: "scale(.94,1.08)", offset: .6 }, { transform: "scale(1,1)" }], { duration: 480, fill: "none", easing: "ease-out" }) : null;
    await Promise.all([
      shakeField(rt, A, Math.max(8, r.w * .28), 420),
      rt.anim(flash, [{ opacity: .95 }, { opacity: 0 }], { duration: 220 }),
      rt.anim(icon, [{ transform: "translate(-50%,-50%) scale(1.25) rotate(4deg)" }, { transform: "translate(-50%,-50%) scale(.92) rotate(-3deg)", offset: .5 }, { transform: "translate(-50%,-50%) scale(1) rotate(0deg)" }], { duration: 380, easing: "ease-out" }),
      squash, ...rings, ...dust
    ].filter(Boolean));
    await rt.wait(420);
    await rt.anim(icon, [{ transform: "translate(-50%,-50%) scale(1)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(.6)", opacity: 0 }], { duration: 300 });
  }

  /* ---------- Move: arrows circle the player, then go away ---------- */

  const ARROW = '<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M5 3l14 9-14 9 4-9z" fill="#7be6a5" stroke="#e6fff0" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  async function move({ A, e, rt, L }) {
    const at = e.at || e.to;
    const r = at && A.rect(at.x, at.y);
    if (!r) { await rt.wait(500); return; }
    const N = 8, radius = r.w * .82, sz = Math.max(14, r.w * .34);
    const ring = mk("fxf-orbit", "div"); put(L, ring, r.cx, r.cy);
    const track = mk("fxf-track"); track.style.width = track.style.height = px(radius * 2); ring.append(track);
    for (let i = 0; i < N; i++) {
      const a = mk("fxf-arrow", "div");
      a.innerHTML = ARROW;
      a.style.width = a.style.height = px(sz);
      a.style.marginLeft = a.style.marginTop = px(-sz / 2);
      a.style.transform = `rotate(${i * 360 / N}deg) translateY(${px(-radius)})`;
      ring.append(a);
    }
    await rt.anim(ring, [
      { transform: "rotate(0deg) scale(.3)", opacity: 0 },
      { transform: "rotate(200deg) scale(1)", opacity: 1, offset: .25 },
      { transform: "rotate(520deg) scale(1)", opacity: 1, offset: .72 },
      { transform: "rotate(720deg) scale(2.1)", opacity: 0 }], { duration: 1500, easing: "linear" });
  }

  /* ---------- Force / Gravity: a tornado ---------- */

  // A flat tornado seen from above: rings with gaps spinning in opposite directions, and a line through the middle so the spin reads at a glance.
  function buildTornado(L, cx, cy, cs, pull, rt) {
    const el = mk("fxf-tornado" + (pull ? " pull" : ""), "div");
    el.style.left = px(cx); el.style.top = px(cy);
    const bw = Math.max(3, cs * .09);
    [1.9, 1.3, .7].forEach((d, i) => {
      const r = mk("fxf-ring"), D = cs * d;
      r.style.width = r.style.height = px(D);
      r.style.marginLeft = r.style.marginTop = px(-D / 2);
      r.style.borderWidth = px(bw);
      el.append(r);
      bg(rt.anim(r, [{ transform: "rotate(0deg)" }, { transform: `rotate(${i % 2 ? -360 : 360}deg)` }], { duration: 650 - i * 170, iterations: 16, easing: "linear", fill: "none" }));
    });
    const line = mk("fxf-spoke");
    line.style.width = px(cs * 1.9); line.style.height = px(bw);
    line.style.marginLeft = px(-cs * .95); line.style.marginTop = px(-bw / 2);
    el.append(line);
    bg(rt.anim(line, [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 520, iterations: 20, easing: "linear", fill: "none" }));
    L.append(el);
    return { el };
  }

  async function displace({ A, e, rt, L }) {
    const pull = e.dir === "pull";
    const c = e.center, rc = c && A.rect(c.x, c.y);
    if (!rc) { await rt.wait(600); return; }
    const cs = rc.w;
    const cells = (e.cells || []).map(([x, y]) => ({ x, y, r: A.rect(x, y) })).filter(o => o.r && !(o.x === c.x && o.y === c.y));
    const span = Math.max(1, ...cells.map(o => Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y)))) * 2 + 1;
    const slide = (m, ms, easing, wobble) => {
      const el = A.monster(m.id), a = A.rect(m.from.x, m.from.y), b = A.rect(m.to.x, m.to.y);
      if (!el || !a || !b) return null;
      const dx = a.l - b.l, dy = a.t - b.t;
      return rt.anim(el, [{ transform: `translate(${px(dx)}, ${px(dy)}) rotate(0deg)` },
        ...(wobble ? [{ transform: `translate(${px(dx * .5)}, ${px(dy * .5)}) rotate(${wobble}deg)`, offset: .5 }] : []),
        { transform: "translate(0,0) rotate(0deg)" }], { duration: ms, easing, fill: "none" });
    };
    // the tornado forms on the center cell
    const T = buildTornado(L, rc.cx, rc.cy, cs, pull, rt);
    const base = "";
    await rt.anim(T.el, [{ transform: `scale(.05)`, opacity: 0 }, { transform: `scale(1)`, opacity: 1 }], { duration: 560, easing: "cubic-bezier(.2,.8,.3,1)", fill: "both" });

    if (!pull) {
      // Force: it winds up, then the gust pushes everything out from the center
      await rt.anim(T.el, [{ transform: `scale(1)` }, { transform: `scale(1.14)` }, { transform: `scale(1.05)` }], { duration: 380, easing: "ease-in-out", fill: "both" });
      e.onRelease && e.onRelease();
      const waves = [];
      for (let k = 0; k < 2; k++) {
        const g = mk("fxf-shock push"); g.style.width = g.style.height = px(cs * (span + 1.2)); put(L, g, rc.cx, rc.cy);
        waves.push(rt.anim(g, [{ transform: "translate(-50%,-50%) scale(.15)", opacity: .95 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 0 }], { duration: 620, delay: k * 120, easing: "ease-out", fill: "both" }));
      }
      for (const o of cells) {                                               // streaks fly outward from the center, one per cell of the pattern
        const a = Math.atan2(o.r.cy - rc.cy, o.r.cx - rc.cx), d0 = dist({ x: o.r.cx, y: o.r.cy }, { x: rc.cx, y: rc.cy });
        const s = mk("fxf-streak"); s.style.width = px(cs * .7); put(L, s, rc.cx, rc.cy);
        waves.push(rt.anim(s, [{ transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(cs * .3)}) scaleX(.2)`, opacity: 0 },
          { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(d0)}) scaleX(1)`, opacity: 1, offset: .55 },
          { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(d0 + cs * 1.2)}) scaleX(.6)`, opacity: 0 }], { duration: 560, delay: (d0 / cs) * 25, easing: "ease-out", fill: "both" }));
      }
      waves.push(rt.anim(T.el, [{ transform: `scale(1.05)`, opacity: 1 }, { transform: `scale(1.9)`, opacity: 0 }], { duration: 520, easing: "ease-in", fill: "both" }));
      (e.moves || []).forEach(m => { const p = slide(m, 520, "cubic-bezier(.1,.9,.3,1)", R() < .5 ? -14 : 14); if (p) waves.push(p); });
      await Promise.all(waves);
      await rt.wait(180);
      return;
    }
    // Gravity: the tornado stays and pulls everything in
    e.onRelease && e.onRelease();
    const pulls = [];
    for (let rep = 0; rep < 2; rep++) for (const o of cells) {
      const a = Math.atan2(o.r.cy - rc.cy, o.r.cx - rc.cx), d0 = dist({ x: o.r.cx, y: o.r.cy }, { x: rc.cx, y: rc.cy });
      const s = mk("fxf-streak pull"); s.style.width = px(cs * .6); put(L, s, rc.cx, rc.cy);
      pulls.push(rt.anim(s, [{ transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(d0 + cs * .5)}) scaleX(.5)`, opacity: 0 },
        { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(d0 * .5)}) scaleX(1)`, opacity: 1, offset: .5 },
        { transform: `translate(-50%,-50%) rotate(${a}rad) translateX(${px(cs * .15)}) scaleX(.2)`, opacity: 0 }], { duration: 640, delay: 200 + rep * 520 + R() * 120, easing: "ease-in", fill: "both" }));
    }
    for (let k = 0; k < 3; k++) {
      const g = mk("fxf-shock pull"); g.style.width = g.style.height = px(cs * (span + 1.2)); put(L, g, rc.cx, rc.cy);
      pulls.push(rt.anim(g, [{ transform: "translate(-50%,-50%) scale(1)", opacity: 0 }, { transform: "translate(-50%,-50%) scale(1)", opacity: .8, offset: .25 }, { transform: "translate(-50%,-50%) scale(.1)", opacity: 0 }], { duration: 800, delay: k * 380, easing: "ease-in", fill: "both" }));
    }
    (e.moves || []).forEach(m => { const p = slide(m, 1100, "cubic-bezier(.5,0,.8,.6)", R() < .5 ? -22 : 22); if (p) pulls.push(p); });
    pulls.push(rt.anim(T.el, [{ transform: `scale(1)` }, { transform: `scale(1.12)`, offset: .4 }, { transform: `scale(1)` }], { duration: 1300, easing: "ease-in-out", fill: "both" }));
    await Promise.all(pulls);
    await rt.anim(T.el, [{ transform: `scale(1)`, opacity: 1 }, { transform: `scale(.05)`, opacity: 0 }], { duration: 420, easing: "ease-in", fill: "both" });
  }

  /* ---------- Taunt / Counter: guide samples (these two are charge / turn based, nothing in a fight plays on the grid) ---------- */

  // A flat bar from one cell to another (an attack, or a hit back).
  function beam(L, a, b, color) {
    const len = Math.hypot(b.cx - a.cx, b.cy - a.cy), ang = Math.atan2(b.cy - a.cy, b.cx - a.cx);
    const o = mk("fxf-beam");
    o.style.cssText = `left:${px(a.cx)};top:${px(a.cy)};width:${px(len)};background:${color};transform:rotate(${ang}rad) scaleX(0)`;
    o.dataset.ang = ang;
    L.append(o);
    return o;
  }
  const grow = (rt, o, ms = 260) => rt.anim(o, [{ transform: `rotate(${o.dataset.ang}rad) scaleX(0)`, opacity: 1 }, { transform: `rotate(${o.dataset.ang}rad) scaleX(1)`, opacity: 1 }], { duration: ms, easing: "ease-in" });
  const fade = (rt, o, ms = 300) => rt.anim(o, [{ opacity: 1 }, { opacity: 0 }], { duration: ms });
  function word(L, text, cx, cy, color) {
    const w = mk("fxf-text"); w.textContent = text; w.style.color = color || "#fff"; put(L, w, cx, cy); return w;
  }
  const hitFlash = (rt, L, r) => {
    const f = mk("fxf-flash"); f.style.cssText = `left:${px(r.l)};top:${px(r.t)};width:${px(r.w)};height:${px(r.h)};background:#ff4a52`;
    L.append(f);
    return rt.anim(f, [{ opacity: .9 }, { opacity: 0 }], { duration: 360 });
  };

  async function taunt({ A, e, rt, L }) {
    const m = A.rect(e.from.x, e.from.y), decoy = A.rect(e.decoy.x, e.decoy.y), tank = A.rect(e.tank.x, e.tank.y);
    if (!m || !decoy || !tank) { await rt.wait(500); return; }
    const aim = beam(L, m, decoy, "#ff5a60");                                   // the Monster picks the easiest target...
    aim.style.opacity = ".55";
    await grow(rt, aim, 380);
    await rt.wait(300);
    const ring = mk("fxf-shock push"); ring.style.width = ring.style.height = px(tank.w * 2.4); put(L, ring, tank.cx, tank.cy);   // ...but the Tank's Taunt rings out
    const bang = word(L, "!", tank.cx, tank.t - tank.h * .1, "#ffd45a");
    await Promise.all([
      rt.anim(ring, [{ transform: "translate(-50%,-50%) scale(.2)", opacity: 1 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 0 }], { duration: 600 }),
      rt.anim(bang, [{ transform: "translate(-50%,-50%) scale(0)", opacity: 0 }, { transform: "translate(-50%,-50%) scale(1.6)", opacity: 1, offset: .4 }, { transform: "translate(-50%,-50%) scale(1.2)", opacity: 1 }], { duration: 500 }),
      fade(rt, aim, 450)
    ]);
    const hit = beam(L, m, tank, "#ff1f2b");                                    // so it has to hit the Tank
    await grow(rt, hit, 260);
    const num = word(L, "Taunt  2 > 1", tank.cx, tank.t - tank.h * .45, "#ffd45a");
    await Promise.all([
      hitFlash(rt, L, tank),
      rt.anim(num, [{ transform: "translate(-50%,-50%) translateY(0)", opacity: 0 }, { transform: "translate(-50%,-50%) translateY(-8px)", opacity: 1, offset: .25 }, { transform: "translate(-50%,-50%) translateY(-16px)", opacity: 0 }], { duration: 1100 }),
      fade(rt, hit, 500)
    ]);
  }

  async function counter({ A, e, rt, L }) {
    const m = A.rect(e.from.x, e.from.y), w = A.rect(e.me.x, e.me.y);
    if (!m || !w) { await rt.wait(500); return; }
    const mon = A.monster("m1");
    const atk = beam(L, m, w, "#ff1f2b");                                      // the Monster damages the Warrior...
    await grow(rt, atk, 300);
    await Promise.all([hitFlash(rt, L, w), fade(rt, atk, 400)]);
    await rt.wait(200);
    const say = word(L, "COUNTER!", w.cx, w.t - w.h * .1, "#ffd45a");           // ...so the Warrior gets a bonus action right after
    await rt.anim(say, [{ transform: "translate(-50%,-50%) scale(.4)", opacity: 0 }, { transform: "translate(-50%,-50%) scale(1.3)", opacity: 1, offset: .4 }, { transform: "translate(-50%,-50%) scale(1)", opacity: 1 }], { duration: 380 });
    const back = beam(L, w, m, "#ffd45a");
    await grow(rt, back, 200);
    const gain = word(L, "+6 Energy", w.cx, w.t - w.h * .55, "#7be6a5");
    await Promise.all([
      mon ? rt.anim(mon, [{ transform: "scale(1)" }, { transform: "scale(1.25,.7)", offset: .3 }, { transform: "scale(1)" }], { duration: 420, fill: "none" }) : rt.wait(420),
      shakeField(rt, A, 5, 300),
      rt.anim(gain, [{ transform: "translate(-50%,-50%) translateY(0)", opacity: 0 }, { transform: "translate(-50%,-50%) translateY(-8px)", opacity: 1, offset: .25 }, { transform: "translate(-50%,-50%) translateY(-18px)", opacity: 0 }], { duration: 1200 }),
      fade(rt, back, 500), fade(rt, say, 900)
    ]);
  }

  /* ---------- Presence: the screen fills with "!" ---------- */
  // Returns { fadeAway() }: the screen is black when this resolves; the caller shows what comes next underneath and calls fadeAway().

  async function presenceDanger(rt, host, scoped) {
    const ov = mk("fxf-danger" + (scoped ? " scoped" : ""), "div");
    (scoped ? host : document.body).append(ov);
    const W = scoped ? host.clientWidth : window.innerWidth, H = scoped ? host.clientHeight : window.innerHeight;
    const size = scoped ? 34 : Math.max(64, Math.min(W, H) / 6.5);
    const cols = Math.max(1, Math.ceil(W / size)), rows = Math.max(1, Math.ceil(H / size));
    ov.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    ov.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    ov.style.fontSize = px(size * .95);
    const marks = Array.from({ length: cols * rows }, (_, i) => { const s = mk("fxf-bang" + (i % 3 === 0 ? " amber" : ""), "span"); s.textContent = "!"; return s; });
    ov.append(...marks);
    const remove = () => ov.remove();
    try {
      bg(rt.anim(ov, [{ backgroundColor: "#1d0003" }, { backgroundColor: "#6e0710" }, { backgroundColor: "#1d0003" }, { backgroundColor: "#6e0710" }, { backgroundColor: "#1d0003" }], { duration: 1500, easing: "linear" }));
      await Promise.all(marks.map(s => rt.anim(s, [{ transform: "scale(0) rotate(-25deg)", opacity: 0 }, { transform: "scale(1.6) rotate(7deg)", opacity: 1, offset: .55 }, { transform: "scale(1) rotate(0deg)", opacity: 1 }], { duration: 280, delay: R() * 650 })));
      await Promise.all(marks.map(s => rt.anim(s, [{ transform: "scale(1) rotate(0deg)" }, { transform: "scale(1.22) rotate(-3deg)" }, { transform: "scale(.96) rotate(3deg)" }, { transform: "scale(1.22) rotate(-2deg)" }, { transform: "scale(1) rotate(0deg)" }], { duration: 850, easing: "ease-in-out" })));
      await Promise.all([                                                    // everything fades to black
        rt.anim(ov, [{ backgroundColor: "#1d0003" }, { backgroundColor: "#000" }], { duration: 520 }),
        ...marks.map(s => rt.anim(s, [{ opacity: 1 }, { opacity: 0 }], { duration: 520 }))
      ]);
    } catch (err) { remove(); throw err; }
    return {
      remove,
      fadeAway: () => rt.anim(ov, [{ opacity: 1 }, { opacity: 0 }], { duration: 700 }).then(remove, remove)
    };
  }

  /* ---------- play ---------- */

  const PLAYERS = {
    trail, "trail-off": c => trail({ ...c, e: { ...c.e, off: true } }),
    smoke, "smoke-off": c => smoke({ ...c, e: { ...c.e, off: true } }),
    clone, "clone-off": clone, displace, move, hold, taunt, counter
  };
  async function play(kind, A, e, rt) {
    const L = mk("fxf-layer", "div");
    A.root.append(L);
    const undo = [];
    try { await PLAYERS[kind]({ A, e, rt, L, undo }); }
    finally { undo.forEach(f => { try { f(); } catch (x) { /* element already gone */ } }); L.remove(); }
  }
  const handles = kind => !!PLAYERS[kind];

  // main.js: the server's "fx" event for a Battlefield card. bf = fx.bf
  function playReal(f, bf, rt) {
    const e = { ...bf };
    if (bf.kind === "move") e.at = bf.to;
    if (bf.kind === "clone" || bf.kind === "clone-off") e.x = bf.x, e.y = bf.y;
    return play(bf.kind, realAdapter(f), e, rt);
  }

  /* ---------- the 7x7 sample grid (card dialog) ---------- */

  const CS = 40, GAP = 2, PITCH = CS + GAP;
  const sq = (cx, cy, r, keep) => { const o = []; for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if (!keep || keep(x - cx, y - cy)) o.push([x, y]); return o; };

  const SPECS = {
    trail: {
      players: [["Warrior", 3, 3], ["Support", 4, 4]], zone: sq(3, 3, 2, (dx, dy) => Math.abs(dx) + Math.abs(dy) <= 2),
      caption: "Trail starts like an engine: the center shakes left and right wildly, the shaking spreads outward cell by cell, then slows down to a stop. Only the Warrior and the Support see it."
    },
    smoke: {
      players: [["Rogue", 3, 3]], monsters: [["m1", 1, 1, "devil"]], zone: sq(3, 3, 1),
      caption: "A puff of smoke fills the pattern. Players inside it are hidden from Monsters."
    },
    clone: {
      players: [["Rogue", 1, 5]], clone: [4, 2],
      caption: "A puff of smoke, and by the time it clears the Clone is already on the field."
    },
    force: {
      players: [["Mage", 3, 6]], monsters: [["m1", 2, 3, "devil"], ["m2", 4, 2, "spirit"]], zone: sq(3, 3, 1), center: [3, 3],
      moves: [["m1", [2, 3], [1, 3]], ["m2", [4, 2], [5, 1]]],
      caption: "A tornado forms on the center, then bursts: every Monster touching the pattern is pushed 1 cell away from the center."
    },
    gravity: {
      players: [["Mage", 3, 6]], monsters: [["m1", 1, 3, "devil"], ["m2", 5, 5, "spirit"]], zone: sq(3, 3, 2, (dx, dy) => dx || dy), center: [3, 3],
      moves: [["m1", [1, 3], [2, 3]], ["m2", [5, 5], [4, 4]]],
      caption: "The tornado stays on the center and pulls every Monster touching the pattern 1 cell toward it. The center cell itself can't be part of the pattern."
    },
    hold: {
      players: [["Tank", 1, 3]], monsters: [["m1", 4, 3, "devil"]],
      caption: "The Hold icon smacks the Monster into the ground. It can't move for 2 rounds, but it can still attack."
    },
    move: {
      players: [["Support", 1, 5], ["Warrior", 2, 3]], hop: [[2, 3], [5, 3]],
      caption: "Arrows circle the teammate, then fly away: the Support just forced them to move."
    },
    taunt: {
      players: [["Tank", 2, 3], ["Rogue", 3, 5]], monsters: [["m1", 5, 3, "devil"]],
      caption: "A Monster that can reach you must target you, even when someone else is easier to hit. Each damage it deals to you uses up 1 charge."
    },
    counter: {
      players: [["Warrior", 2, 3]], monsters: [["m1", 5, 3, "devil"]],
      caption: "If a Monster damages you even once while Counter lasts, you get a bonus action right after its turn and +6 Energy for it."
    },
    presence: {
      players: [["Tank", 3, 3]], monsters: [["m1", 0, 0, "devil"], ["m2", 6, 0, "spirit"], ["m3", 0, 6, "scale"]],
      caption: "Danger! Every screen fills with warnings, fades to black, and the Tank has Presence up: the Tank's Class Range becomes a 7x7 (red) and every Monster's Range shrinks to a 3x3."
    }
  };

  function stage(kind) {
    const spec = SPECS[kind];
    if (!spec) return null;
    const el = mk("mini-field mf7", "div");
    const cells = [];
    for (let i = 0; i < 49; i++) { const c = mk("bf-cell", "div"); el.append(c); cells.push(c); }
    const A = adapt(el, (x, y) => (x >= 0 && y >= 0 && x < 7 && y < 7) ? cells[y * 7 + x] : null);
    const icons = new Map();                                                   // "Class" -> its <img>
    const at = (x, y) => ({ left: px(x * PITCH), top: px(y * PITCH) });
    const set = (n, x, y) => { Object.assign(n.style, at(x, y)); };
    for (const [cls, x, y] of spec.players || []) {
      const c = cells[y * 7 + x], img = document.createElement("img");
      img.alt = ""; img.src = classIcon(cls); c.classList.add("other"); c.append(img); icons.set(cls, img);
    }
    const mons = new Map();
    for (const [id, x, y, sprite] of spec.monsters || []) {
      const m = mk("bf-monster", "div"), img = document.createElement("img");
      m.dataset.id = id; img.alt = ""; img.src = `/assets/monsters/${sprite}.png`; m.append(img);
      m.style.position = "absolute"; m.style.width = m.style.height = CS + "px"; set(m, x, y);
      cells[y * 7 + x].classList.add("monster"); el.append(m); mons.set(id, m);
    }
    let cloneEl = null;
    if (spec.clone) {
      cloneEl = mk("bf-monster fxf-clone", "div");
      const img = document.createElement("img"); img.alt = ""; img.src = ICON("clone"); cloneEl.append(img);
      cloneEl.style.cssText = `position:absolute;width:${CS}px;height:${CS}px;left:${px(spec.clone[0] * PITCH)};top:${px(spec.clone[1] * PITCH)};opacity:0;border:2px dashed #9be7ff;border-radius:50%;box-sizing:border-box`;
      el.append(cloneEl);
    }
    (spec.zone || []).forEach(([x, y]) => cells[y * 7 + x] && cells[y * 7 + x].classList.add("fxf-zone"));

    const reset = () => {
      for (const [id, x, y] of spec.monsters || []) set(mons.get(id), x, y);
      if (cloneEl) cloneEl.style.opacity = "0";
      if (spec.hop) {                                                          // the moved teammate goes back to the start
        const [a, b] = spec.hop, img = icons.get("Warrior");
        cells[b[1] * 7 + b[0]].classList.remove("other"); cells[a[1] * 7 + a[0]].classList.add("other");
        if (img.parentNode !== cells[a[1] * 7 + a[0]]) cells[a[1] * 7 + a[0]].append(img);
      }
      cells.forEach(c => c.classList.remove("presence-zone"));
    };

    async function run(rt) {
      const sp = spec;
      if (kind === "trail") return play("trail", A, { cells: sp.zone }, rt);
      if (kind === "smoke") return play("smoke", A, { cells: sp.zone }, rt);
      if (kind === "clone") return play("clone", A, { x: sp.clone[0], y: sp.clone[1], onPeak: () => { cloneEl.style.opacity = "1"; } }, rt);
      if (kind === "hold") return play("hold", A, { id: "m1", x: 4, y: 3, w: 1, h: 1 }, rt);
      if (kind === "taunt") return play("taunt", A, { from: { x: 5, y: 3 }, decoy: { x: 3, y: 5 }, tank: { x: 2, y: 3 } }, rt);
      if (kind === "counter") return play("counter", A, { from: { x: 5, y: 3 }, me: { x: 2, y: 3 } }, rt);
      if (kind === "force" || kind === "gravity") {
        const moves = sp.moves.map(([id, from, to]) => ({ id, from: { x: from[0], y: from[1] }, to: { x: to[0], y: to[1] } }));
        return play("displace", A, {
          dir: kind === "force" ? "push" : "pull", cells: sp.zone, center: { x: sp.center[0], y: sp.center[1] }, moves,
          onRelease: () => moves.forEach(m => set(mons.get(m.id), m.to.x, m.to.y))      // the state has already moved them when the animation plays
        }, rt);
      }
      if (kind === "move") {
        const [a, b] = sp.hop;
        await play("move", A, { at: { x: a[0], y: a[1] } }, rt);
        const img = icons.get("Warrior"), cell = cells[b[1] * 7 + b[0]];
        cells[a[1] * 7 + a[0]].classList.remove("other"); cell.classList.add("other");
        cell.append(img);
        const ring = mk("bf-fx move-flash"); cell.append(ring);
        await rt.anim(ring, [{ transform: "scale(.3)", opacity: 0 }, { transform: "scale(1.1)", opacity: 1, offset: .4 }, { transform: "scale(1)", opacity: 0 }], { duration: 700 });
        ring.remove();
        return;
      }
      if (kind === "presence") {
        const danger = await presenceDanger(rt, el, true);
        try {
          cells.forEach(c => c.classList.add("presence-zone"));
          const tank = icons.get("Tank");
          const away = danger.fadeAway();
          await Promise.all([away, rt.anim(tank, [{ transform: "scale(1)" }, { transform: "scale(1.5) rotate(-8deg)" }, { transform: "scale(.9) rotate(6deg)" }, { transform: "scale(1)" }], { duration: 700, fill: "none" })]);
          await rt.wait(800);
        } finally { danger.remove(); }
      }
    }
    async function loop(rt) {
      for (;;) {
        reset();
        await rt.wait(450);
        await run(rt);
        await rt.wait(1300);
      }
    }
    return { el, caption: spec.caption, loop };
  }

  return { stage, playReal, handles, presenceDanger, ICON };
})();
