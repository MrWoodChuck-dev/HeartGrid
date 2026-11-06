/* =====================================
   ACTION STAGE
===================================== */

/*
    Every action that changes a grid is played for EVERYONE (players and Host)
    on a full-screen stage, so the person who acted sees it as well as their
    team:

        1. The card that was used pops up, shakes, then explodes.
        2. The affected grid (the monster's or a player's) appears and the
           effect is animated on it.
        3. The stage closes and the normal screen is back.

    Stages play one after another from a queue. Tap, click or press any key to
    skip the one that is playing; SKIP ALL drops the rest of the queue.

    The game state itself still updates immediately underneath. So that a
    queued stage never shows the result of an action that came after it, each
    stage is built from a snapshot of the grid taken the moment its event
    arrives (the server sends "...-resolved" before the state update).

    Shown:      Attack, Lifesteal, Curse, Heal, Rage, Retaliate (players only),
                Counter (card only), the monster's attacks, Retaliate strikes,
                and Thief Status ticks (turn count dropping + the damage).
    Not shown:  Taunt, Buff, Weaken, and a Thief activating Status. None of
                them change a grid, so there is nothing to look at.

    Relies on globals from script.js: socket, currentRole, currentEncounter,
    roomPlayers, renderGrid, registerFx, fxRegistry, fxReducedMotion, the FX_*
    durations, and the card colours / labels (getCardColor and getCardTypeLabel in cards.js).
*/

(function () {
    "use strict";

    const SHAKE_MS = 1000;        // the card shakes for one second
    const CURSE_SHAKE_MS = 700;   // the Curse card that appears mid-chain
    const POP_IN_MS = 320;
    const BURST_MS = 540;
    const GRID_LEAD_MS = 420;     // time spent looking at the grid before it changes
    const GRID_HOLD_MS = 600;     // time spent looking at it after
    const FADE_MS = 200;
    const SPARK_COUNT = 18;

    const FX_KEY = "stage";

    const MONSTER_COLOR = "#8b1a1a";


    /* ---------- Queue ---------- */

    const queue = [];
    let running = false;
    let currentRun = null;

    let overlay = null;
    let centerEl = null;
    let actorEl = null;
    let queueEl = null;

    function enqueue(stage) {
        // Same rule the old animations followed.
        if (fxReducedMotion?.matches) return;
        if (!currentRole || !stage?.segments?.length) return;

        queue.push(stage);
        updateQueueLabel();

        if (!running) pump();
    }

    async function pump() {
        running = true;
        ensureOverlay();
        openOverlay();

        try {
            while (true) {
                while (queue.length > 0) {
                    const stage = queue.shift();
                    updateQueueLabel();

                    try {
                        await playStage(stage);
                    } catch (error) {
                        console.error("Stage failed:", error);
                    }
                }

                beginClose();
                await sleep(FADE_MS);

                // Something arrived while the stage was fading out.
                if (queue.length === 0) break;

                openOverlay();
            }
        } finally {
            hideOverlay();
            running = false;
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // A wait that ends early when the current stage is skipped.
    function wait(ms, run) {
        return new Promise(resolve => {
            if (run.skipped) {
                resolve();
                return;
            }

            const finish = () => {
                clearTimeout(timer);
                run.waiters.delete(finish);
                resolve();
            };

            const timer = setTimeout(finish, ms);
            run.waiters.add(finish);
        });
    }

    function skipCurrent() {
        if (!currentRun || currentRun.skipped) return;

        currentRun.skipped = true;
        [...currentRun.waiters].forEach(finish => finish());
    }

    function skipAll() {
        queue.length = 0;
        updateQueueLabel();
        skipCurrent();
    }

    function reset() {
        skipAll();
    }


    /* ---------- Overlay ---------- */

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function ensureOverlay() {
        if (overlay) return overlay;

        overlay = el("div", "stage-overlay");
        overlay.id = "stage-overlay";
        overlay.hidden = true;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-label", "Action replay");

        const top = el("div", "stage-top");
        actorEl = el("span", "stage-actor");
        queueEl = el("span", "stage-queue");
        top.append(actorEl, queueEl);

        centerEl = el("div", "stage-center");

        const bottom = el("div", "stage-bottom");
        const hint = el("span", "stage-hint", "TAP ANYWHERE TO SKIP");

        const skipAllButton = el("button", "stage-skip-all", "SKIP ALL");
        skipAllButton.type = "button";
        skipAllButton.addEventListener("click", event => {
            event.stopPropagation();
            skipAll();
        });

        bottom.append(hint, skipAllButton);

        overlay.append(top, centerEl, bottom);
        document.body.appendChild(overlay);

        // Click (not pointerdown) so the tap that skips can never fall through
        // to whatever is underneath once the stage closes.
        overlay.addEventListener("click", skipCurrent);

        document.addEventListener("keydown", event => {
            if (!overlay || overlay.hidden || event.repeat) return;

            // Keep Enter / Space from pressing a button behind the stage.
            event.preventDefault();
            event.stopPropagation();

            skipCurrent();
        }, true);

        return overlay;
    }

    function openOverlay() {
        overlay.hidden = false;
        overlay.classList.remove("is-closing");
        document.body.classList.add("stage-open");
    }

    function beginClose() {
        overlay.classList.add("is-closing");
    }

    function hideOverlay() {
        if (!overlay) return;

        overlay.hidden = true;
        overlay.classList.remove("is-closing");
        document.body.classList.remove("stage-open");

        centerEl.replaceChildren();
        actorEl.textContent = "";
    }

    function updateQueueLabel() {
        if (!queueEl) return;

        queueEl.textContent =
            queue.length > 0 ? `+${queue.length} MORE` : "";

        const skipAllButton = overlay?.querySelector(".stage-skip-all");
        if (skipAllButton) skipAllButton.hidden = queue.length === 0;
    }


    /* ---------- Playing one stage ---------- */

    async function playStage(stage) {
        const run = { skipped: false, waiters: new Set() };
        currentRun = run;

        actorEl.textContent = stage.actor || "";

        try {
            for (const segment of stage.segments) {
                if (run.skipped) break;

                if (segment.type === "card") {
                    await playCard(segment, run);
                } else {
                    await playGrid(segment, run);
                }
            }
        } finally {
            currentRun = null;
            centerEl.replaceChildren();
        }
    }


    /* ---------- Card segment: pop in, shake, explode ---------- */

    function buildCard(segment) {
        const wrap = el("div", "stage-card-wrap");
        const card = el("div", "stage-card");

        wrap.style.setProperty(
            "--card-color",
            segment.color || getCardColor(segment.cardType)
        );

        const header = el(
            "div",
            "stage-card-kicker",
            segment.kicker || getCardTypeLabel(segment.cardType)
        );

        const art = el("div", "stage-card-art");
        const icon = document.createElement("img");
        icon.src = `/assets/${segment.art || segment.cardType}.png`;
        icon.alt = "";
        icon.draggable = false;
        icon.onerror = () => icon.remove();
        art.appendChild(icon);

        const name = el("h3", "stage-card-name", segment.title || "");

        card.append(header, art, name);

        if (segment.counter) {
            card.appendChild(buildCounter(segment.counter));
        }

        (segment.lines || []).forEach(line => {
            card.appendChild(el("p", "stage-card-line", line));
        });

        wrap.appendChild(card);

        return { wrap, card };
    }

    // "3 -> 2" style readout for Counter and Status turns.
    function buildCounter(counter) {
        const box = el("div", "stage-counter");

        const row = el("div", "stage-counter-row");

        const from = el("span", "stage-counter-from", String(counter.from));
        const arrow = el("span", "stage-counter-arrow", "→");
        const to = el("span", "stage-counter-to", String(counter.to));

        if (counter.from === counter.to) {
            row.append(to);
        } else {
            row.append(from, arrow, to);
        }

        box.append(row, el("span", "stage-counter-label", counter.label));

        return box;
    }

    // The sparks live on the stage, not inside the card, so they do not fade
    // out together with it.
    function spawnSparks(wrap) {
        const burst = el("div", "stage-burst");
        burst.setAttribute("aria-hidden", "true");
        burst.style.setProperty(
            "--card-color",
            wrap.style.getPropertyValue("--card-color")
        );

        burst.appendChild(el("i", "stage-flash"));

        for (let i = 0; i < SPARK_COUNT; i++) {
            const spark = el("i", "stage-spark");
            const angle = (i / SPARK_COUNT) * Math.PI * 2 + Math.random() * 0.35;
            const distance = 110 + Math.random() * 110;

            spark.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
            spark.style.setProperty("--dy", `${Math.sin(angle) * distance}px`);
            spark.style.setProperty("--size", `${5 + Math.random() * 8}px`);
            spark.style.animationDelay = `${Math.random() * 60}ms`;

            burst.appendChild(spark);
        }

        centerEl.appendChild(burst);
    }

    async function playCard(segment, run) {
        const { wrap, card } = buildCard(segment);

        centerEl.replaceChildren(wrap);

        wrap.classList.add("is-entering");
        await wait(POP_IN_MS, run);
        if (run.skipped) return;

        const shake = segment.shake ?? SHAKE_MS;

        if (shake > 0) {
            wrap.classList.add("is-charging");
            wrap.style.setProperty("--charge-ms", `${shake}ms`);
            card.classList.add("is-shaking");
            await wait(shake, run);
            if (run.skipped) return;
        }

        if (segment.hold) {
            wrap.classList.add("is-holding");
            await wait(segment.hold, run);
            if (run.skipped) return;
        }

        wrap.classList.remove("is-charging");
        card.classList.remove("is-shaking");
        wrap.classList.add("is-bursting");
        spawnSparks(wrap);

        await wait(BURST_MS, run);
    }


    /* ---------- Grid segment ---------- */

    function renderStageGrid(gridEl, size, state, fxKey) {
        renderGrid(gridEl, state.cells, size, {
            curses: state.curses || new Set(),
            marks: state.marks || new Set(),
            fxKey
        });
    }

    async function playGrid(segment, run) {
        const panel = el("div", "stage-grid-panel");
        const title = el("p", "stage-grid-title", segment.label || "");
        const gridEl = el("div", "heart-grid stage-grid");

        panel.append(title, gridEl);
        centerEl.replaceChildren(panel);
        panel.classList.add("is-entering");

        fxRegistry.delete(FX_KEY);

        // Show how it looked first, so the change is something you can see.
        renderStageGrid(gridEl, segment.size, segment.before, null);
        await wait(segment.lead ?? GRID_LEAD_MS, run);
        if (run.skipped) return;

        (segment.fx || []).forEach(effect => {
            registerFx(FX_KEY, effect.index, effect);
        });

        renderStageGrid(gridEl, segment.size, segment.after, FX_KEY);

        const effectsEnd = Math.max(
            0,
            ...(segment.fx || []).map(effect => effect.delay + effect.duration)
        );

        await wait(effectsEnd + (segment.hold ?? GRID_HOLD_MS), run);
    }


    /* ---------- Snapshots ---------- */

    function snapshotMonster() {
        const encounter = currentEncounter;
        if (!encounter) return null;

        return {
            size: encounter.size,
            cells: [...encounter.grid],
            curses: new Set(encounter.curses || []),
            name: encounter.name
        };
    }

    function snapshotPlayer(playerID) {
        const player = roomPlayers.find(item => item.id === playerID);
        if (!player) return null;

        return {
            size: player.gridSize,
            cells: [...player.grid],
            // The Host is never sent Retaliate marks, so this is empty for them.
            marks: new Set(player.marks || []),
            name: player.username
        };
    }

    function copyState(state) {
        return {
            cells: [...state.cells],
            curses: new Set(state.curses || []),
            marks: new Set(state.marks || [])
        };
    }

    function actorLabel(playerID, fallbackName) {
        const player = roomPlayers.find(item => item.id === playerID);
        const name = player?.username || fallbackName || "";

        return player
            ? `${name.toUpperCase()} · ${player.className.toUpperCase()}`
            : name.toUpperCase();
    }

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? "" : "s"}`;
    }


    /* ---------- Monster damage (attacks, Curse chains, poison, Retaliate) ---------- */

    // The server announces monster damage a moment BEFORE the card result
    // that caused it. Hold it here until that result arrives.
    const pendingMonsterDamage = {};

    function takePending(source) {
        const pending = pendingMonsterDamage[source] || null;
        delete pendingMonsterDamage[source];
        return pending;
    }

    socket.on("monster-damage-fx", data => {
        if (!data || !Array.isArray(data.steps) || data.steps.length === 0) return;

        const snapshot = snapshotMonster();
        if (!snapshot) return;

        const pending = { snapshot, steps: data.steps, source: data.source };

        // The Host is never told Retaliate happened, so there is no card to
        // show and nothing to wait for: just the monster's grid taking damage.
        if (data.source === "retaliate" && currentRole === "host") {
            enqueue({
                actor: "",
                segments: monsterDamageSegments(pending)
            });
            return;
        }

        pendingMonsterDamage[data.source] = pending;
    });

    /*
        Builds the grid segments for one monster-damage event.

        Phase 1: the cells hit directly pop (cursed ones stay put).
        If a cursed cell was hit, a Curse card appears (once) and then the
        explosions play as one unbroken chain, however far it spreads.
    */
    // How a cell looked, for the pop / fade ghost (shared with cards.js).
    const lookOf = cellLook;

    // The monster grid after the last grid segment (so a follow-up
    // animation can carry on from where the previous one ended).
    function finalGridState(segments) {
        for (let i = segments.length - 1; i >= 0; i--) {
            if (segments[i].type === "grid") return segments[i].after;
        }

        return null;
    }

    /*
        "base" lets one damage event carry on from the grid an earlier event
        left behind (an Attack, then Penetrate clearing Armor, then Status).
        Each cell in a step says what it was and what it became, so the
        animation shows exactly what happened (Overheal stripped, Armor
        broken, HP lost).
    */
    function monsterDamageSegments(pending, base = null) {
        const { snapshot, steps, source } = pending;
        const size = snapshot.size;
        const label = `${(snapshot.name || "Monster").toUpperCase()} · MONSTER GRID`;

        const cells = [...(base?.cells || snapshot.cells)];
        const curses = new Set(base?.curses || snapshot.curses);

        const hitCurse = steps.some(step => step.cells.some(cell => cell.cursed));
        const isPoison = source === "status";

        const segments = [];

        // Phase 1: direct, non-cursed hits.
        let before = copyState({ cells, curses });
        const directHits = steps[0].cells.filter(cell => !cell.cursed);
        const phaseOneFx = [];

        // Penetrate-pierced Armor cracks instead of popping.
        const hitState = { cracksLeft: pending.pierced || 0 };

        directHits.forEach(cell => {
            cells[cell.index] = cell.after || "empty";

            // Some cards bring their own look for the cell they hit (cards.js).
            const special = getMonsterHitFx(source, cell, hitState);

            phaseOneFx.push(special
                ? { index: cell.index, delay: 0, ...special }
                : {
                    index: cell.index,
                    kind: isPoison ? "fade" : "pop",
                    look: lookOf(cell.before),
                    delay: 0,
                    duration: isPoison ? FX_FADE_MS : FX_POP_MS
                });
        });

        segments.push({
            type: "grid",
            label,
            size,
            before,
            after: copyState({ cells, curses }),
            fx: phaseOneFx,
            hold: hitCurse ? 250 : undefined
        });

        if (!hitCurse) return segments;

        // The Curse card shows once, when the first cursed cell is hit.
        segments.push({
            type: "card",
            cardType: "curse",
            kicker: "CURSE TRIGGERED",
            title: "Chain Explosion",
            lines: ["A cursed position was hit"],
            shake: CURSE_SHAKE_MS
        });

        // Phase 2: the whole chain, step by step.
        before = copyState({ cells, curses });

        const chainFx = [];
        let startAt = 0;

        steps.forEach((step, stepIndex) => {
            const curseMs =
                stepIndex < FX_CURSE_FULL_SPEED_STEPS
                    ? FX_CURSE_MS
                    : FX_CURSE_FAST_MS;

            let stepHasCurse = false;

            step.cells.forEach(cell => {
                // Step 0's plain hits already played in phase 1.
                if (stepIndex === 0 && !cell.cursed) return;

                cells[cell.index] = cell.after || "empty";

                if (cell.cursed) {
                    stepHasCurse = true;
                    curses.delete(cell.index);

                    chainFx.push({
                        index: cell.index,
                        kind: "curse",
                        look: "curse",
                        delay: startAt,
                        duration: curseMs
                    });
                } else {
                    // Explosion damage is a plain pop whichever card started it.
                    chainFx.push({
                        index: cell.index,
                        kind: "pop",
                        look: lookOf(cell.before),
                        delay: startAt,
                        duration: FX_POP_MS
                    });
                }
            });

            if (stepHasCurse) startAt += curseMs;
        });

        segments.push({
            type: "grid",
            label,
            size,
            before,
            after: copyState({ cells, curses }),
            fx: chainFx,
            lead: 200
        });

        return segments;
    }


    /* ---------- Card results ---------- */

    function monsterLabelOf(snapshot) {
        return (snapshot?.name || "Monster").toUpperCase();
    }

    // The Thief's own empty cells refilling (Lifesteal), or any self-heal.
    function ownHealSegment(playerID, healed, overhealed, style = "popin") {
        const own = snapshotPlayer(playerID);

        if (!own || (healed.length === 0 && overhealed.length === 0)) return null;

        const cells = [...own.cells];
        const fx = [];

        // Rest and Spellvamp heal in their own way (cards.js).
        const healFx = {
            popin: { kind: "popin", duration: FX_POPIN_MS },
            rest: { kind: "restgrow", duration: 1700 },
            vamp: { kind: "vampheal", duration: 1000 }
        }[style] || { kind: "popin", duration: FX_POPIN_MS };

        healed.forEach(index => {
            cells[index] = "hp";
            fx.push({ index, look: "hp", delay: 0, ...healFx });
        });

        overhealed.forEach(index => {
            cells[index] = "overheal";
            fx.push({ index, look: "overheal", delay: 0, ...healFx });
        });

        return {
            type: "grid",
            label: `${own.name.toUpperCase()} · HEART GRID`,
            size: own.size,
            before: copyState(own),
            after: copyState({ cells, marks: own.marks }),
            fx
        };
    }

    /*
        Lifesteal healing the Thief: a red wave sweeps the grid top row to
        bottom row, then the rows turn green again in the same order. A cell
        that gets healed stays empty until the wave hits it, swells deep red,
        and slams down into green once its row is green again.
    */
    function lifestealSegment(playerID, healed) {
        const own = snapshotPlayer(playerID);

        if (!own || healed.length === 0) return null;

        const STEP = 320;
        const SLAM = 260;
        const size = own.size;
        const cells = [...own.cells];

        healed.forEach(index => {
            cells[index] = "hp";
        });

        const fx = own.cells.map((cell, index) => {
            const row = Math.floor(index / size);

            return healed.includes(index)
                ? { index, kind: "lsheal", look: "hp", row, rows: size, step: STEP, delay: 0, duration: (size + row + 1) * STEP + SLAM }
                : { index, kind: "lswave", look: cell, row, rows: size, step: STEP, delay: 0, duration: (size + row + 1) * STEP };
        });

        return {
            type: "grid",
            label: `${own.name.toUpperCase()} · HEART GRID`,
            size,
            before: copyState(own),
            after: copyState({ cells, marks: own.marks }),
            fx
        };
    }

    /*
        Attack and Blast: the card, then everything that happened to the
        monster's grid in order: the hit itself, Penetrate clearing Armor
        next to it, Status adding damage, then the Thief's Lifesteal.
    */
    function gridAttackResolved(result, cardType, mainSource) {
        const lines = [`${result.damage} damage`];

        if (result.armorDestroyed > 0) {
            lines.push(`${plural(result.armorDestroyed, "Armor cell")} destroyed`);
        }

        const segments = [{
            type: "card",
            cardType,
            title: result.cardName,
            lines
        }];

        let base = null;

        const main = takePending(mainSource);

        if (main) {
            // Armor the Thief pierced cracks apart (Penetrate).
            main.pierced = result.piercedArmor || 0;

            const part = monsterDamageSegments(main, base);
            segments.push(...part);
            base = finalGridState(part) || base;
        }

        const penetrate = takePending("penetrate");

        if (penetrate) {
            segments.push({
                type: "card",
                cardType: "penetrate",
                kicker: "PENETRATE",
                title: "Armor Cleared",
                lines: [`${plural(result.connectedArmor || 1, "connected Armor cell")} removed`]
            });

            const part = monsterDamageSegments(penetrate, base);
            segments.push(...part);
            base = finalGridState(part) || base;
        }

        const status = takePending("status");

        if (status) {
            segments.push({
                type: "card",
                cardType: "status",
                kicker: "STATUS CHARGE",
                title: "Status",
                lines: [`${result.statusDamage} extra damage`]
            });

            const part = monsterDamageSegments(status, base);
            segments.push(...part);
            base = finalGridState(part) || base;
        }

        const heal = lifestealSegment(result.playerID, result.healPositions || []);

        if (heal) segments.push(heal);

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    }

    socket.on("player-attack-resolved", result => {
        gridAttackResolved(result, "attack", "attack");
    });

    socket.on("player-blast-resolved", result => {
        gridAttackResolved(result, "blast", "blast");
    });

    socket.on("player-spellvamp-resolved", result => {
        const pending = takePending("spellvamp");

        const segments = [{
            type: "card",
            cardType: "spellvamp",
            title: result.cardName,
            lines: [
                `+${result.chargesGained} Spellvamp Charge${result.chargesGained === 1 ? "" : "s"}`
            ]
        }];

        if (pending) segments.push(...monsterDamageSegments(pending));

        const heal = ownHealSegment(
            result.playerID,
            result.healedPositions || [],
            result.overhealedPositions || [],
            "vamp"
        );

        if (heal) segments.push(heal);

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    socket.on("player-execute-resolved", result => {
        const pending = takePending("execute");

        const segments = [{
            type: "card",
            cardType: "execute",
            title: result.cardName,
            lines: [`${result.damage} damage`]
        }];

        if (pending) segments.push(...monsterDamageSegments(pending));

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    socket.on("player-curse-resolved", result => {
        const snapshot = snapshotMonster();

        const segments = [{
            type: "card",
            cardType: "curse",
            title: result.cardName,
            lines: [`${plural(result.marked, "position")} cursed`]
        }];

        if (snapshot) {
            const curses = new Set(snapshot.curses);

            (result.positions || []).forEach(index => curses.add(index));

            segments.push({
                type: "grid",
                label: `${monsterLabelOf(snapshot)} · MONSTER GRID`,
                size: snapshot.size,
                before: copyState(snapshot),
                after: copyState({ cells: snapshot.cells, curses }),
                fx: (result.positions || []).map(index => ({
                    index, kind: "popin", look: "curse", delay: 0, duration: FX_POPIN_MS
                }))
            });
        }

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    socket.on("player-heal-resolved", result => {
        const target = snapshotPlayer(result.targetPlayerID);

        const segments = [{
            type: "card",
            cardType: "heal",
            title: result.cardName,
            lines: [
                result.targetPlayerID === result.playerID
                    ? "Healing themselves"
                    : `Healing ${result.targetUsername}`
            ]
        }];

        if (target) {
            const cells = [...target.cells];
            const fx = [];

            (result.healedPositions || []).forEach(index => {
                cells[index] = "hp";
                fx.push({
                    index, kind: "popin", look: "hp", delay: 0, duration: FX_POPIN_MS
                });
            });

            (result.overhealedPositions || []).forEach(index => {
                cells[index] = "overheal";
                fx.push({
                    index, kind: "popin", look: "overheal", delay: 0, duration: FX_POPIN_MS
                });
            });

            segments.push({
                type: "grid",
                label: `${target.name.toUpperCase()} · HEART GRID`,
                size: target.size,
                before: copyState(target),
                after: copyState({ cells, marks: target.marks }),
                fx
            });
        }

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    socket.on("player-rage-resolved", result => {
        const own = snapshotPlayer(result.playerID);
        const sacrificed =
            (result.healthSacrificed || 0) + (result.overhealSacrificed || 0);

        const segments = [{
            type: "card",
            cardType: "rage",
            title: result.cardName,
            lines: [
                `${plural(sacrificed, "position")} sacrificed`,
                `+${result.energyGained} Energy`
            ]
        }];

        if (own) {
            const cells = [...own.cells];
            const fx = [];

            (result.healthPositions || []).forEach(index => {
                cells[index] = "empty";
                fx.push({
                    index, kind: "rage", look: "hp", delay: 0, duration: FX_RAGE_MS
                });
            });

            (result.overhealPositions || []).forEach(index => {
                cells[index] = "hp";
                fx.push({
                    index, kind: "rage", look: "overheal", delay: 0, duration: FX_RAGE_MS
                });
            });

            segments.push({
                type: "grid",
                label: `${own.name.toUpperCase()} · HEART GRID`,
                size: own.size,
                before: copyState(own),
                after: copyState({ cells, marks: own.marks }),
                fx
            });
        }

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    // Retaliate is secret from the Host: their copy of this event carries no
    // positions, and they get no stage for it at all.
    socket.on("player-retaliate-resolved", result => {
        if (currentRole === "host" || !Array.isArray(result.positions)) return;

        const own = snapshotPlayer(result.playerID);

        const segments = [{
            type: "card",
            cardType: "retaliate",
            title: result.cardName,
            lines: [`${plural(result.marked, "position")} marked`]
        }];

        if (own) {
            const marks = new Set(own.marks);

            result.positions.forEach(index => marks.add(index));

            segments.push({
                type: "grid",
                label: `${own.name.toUpperCase()} · HEART GRID`,
                size: own.size,
                before: copyState(own),
                after: copyState({ cells: own.cells, marks }),
                fx: result.positions.map(index => ({
                    index, kind: "thump", look: "hp", delay: 0, duration: FX_THUMP_MS
                }))
            });
        }

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    // A marked cell got hit: the Retaliate strikes back. Players only.
    socket.on("retaliate-triggered", result => {
        const pending = takePending("retaliate");

        const segments = [{
            type: "card",
            cardType: "retaliate",
            kicker: "RETALIATE",
            title: "Strikes Back!",
            lines: [
                `${plural(result.triggered, "strike")}`,
                `${result.damage} damage`
            ]
        }];

        if (pending) segments.push(...monsterDamageSegments(pending));

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    // Counter has no grid: just the card and how many turns are ready.
    socket.on("player-counter-resolved", result => {
        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments: [{
                type: "card",
                cardType: "counter",
                title: result.cardName,
                counter: {
                    from: result.counterTurns - result.added,
                    to: result.counterTurns,
                    label: result.counterTurns === 1 ? "COUNTER TURN" : "COUNTER TURNS"
                },
                shake: 0,
                hold: 1500
            }]
        });
    });

    // Cards that only load a number: a card with a counter going up.
    function chargeCard(event, cardType, label, valueOf) {
        socket.on(event, result => {
            const { added, total } = valueOf(result);

            enqueue({
                actor: actorLabel(result.playerID, result.username),
                segments: [{
                    type: "card",
                    cardType,
                    title: result.cardName,
                    counter: { from: total - added, to: total, label },
                    shake: 0,
                    hold: 1500
                }]
            });
        });
    }

    chargeCard("player-status-resolved", "status", "STATUS CHARGES",
        r => ({ added: r.added, total: r.charges }));
    chargeCard("player-lifesteal-resolved", "lifesteal", "LIFESTEAL CHARGES",
        r => ({ added: r.added, total: r.charges }));
    chargeCard("player-penetrate-resolved", "penetrate", "PENETRATE CHARGES",
        r => ({ added: r.added, total: r.charges }));

    // Hex has no staging: every Attack / Blast card shows its discount
    // instead (cards.js). Shield has none either: the Battlefield zooms in
    // on the protected player and shows the bubble (battlefield.js).

    socket.on("player-rest-resolved", result => {
        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments: [{
                type: "card",
                cardType: "rest",
                title: result.cardName,
                lines: ["Resting. Can't act until it ends"],
                counter: { from: 0, to: result.turns, label: "REST TURNS" },
                shake: 0,
                hold: 1500
            }]
        });
    });

    // A Rest turn passing: the turn count drops and the Tank heals.
    socket.on("player-rest-tick", result => {
        const segments = [{
            type: "card",
            cardType: "rest",
            kicker: result.expired ? "REST ENDED" : "RESTING",
            title: `${result.username} rests`,
            counter: {
                from: result.turnsLeft + 1,
                to: result.turnsLeft,
                label: "REST TURNS LEFT"
            },
            shake: 0,
            hold: 900
        }];

        const heal = ownHealSegment(
            result.playerID,
            result.healedPositions || [],
            result.overhealedPositions || [],
            "rest"
        );

        if (heal) segments.push(heal);

        enqueue({
            actor: actorLabel(result.playerID, result.username),
            segments
        });
    });

    // The monster hits a player.
    socket.on("monster-attack-resolved", result => {
        const target = snapshotPlayer(result.playerID);
        const monster = currentEncounter?.name || "Monster";

        const segments = [{
            type: "card",
            cardType: "monster",
            kicker: "MONSTER ATTACK",
            art: "monster",
            color: MONSTER_COLOR,
            title: monster,
            lines: [`Hits ${result.username}`]
        }];

        if (target) {
            const cells = [...target.cells];
            const marks = new Set(target.marks);
            const fx = [];

            (result.emptiedPositions || []).forEach(index => {
                cells[index] = "empty";
                // A damaged Retaliate mark is spent.
                marks.delete(index);

                fx.push({
                    index, kind: "pop", look: "hp", delay: 0, duration: FX_POP_MS
                });
            });

            (result.overhealLostPositions || []).forEach(index => {
                cells[index] = "hp";

                fx.push({
                    index, kind: "pop", look: "overheal", delay: 0, duration: FX_POP_MS
                });
            });

            segments.push({
                type: "grid",
                label: `${target.name.toUpperCase()} · HEART GRID`,
                size: target.size,
                before: copyState(target),
                after: copyState({ cells, marks }),
                fx
            });
        }

        enqueue({
            actor: monster.toUpperCase(),
            segments
        });
    });


    /* ---------- Cleanup ---------- */

    socket.on("room-closed", () => {
        Object.keys(pendingMonsterDamage).forEach(key => {
            delete pendingMonsterDamage[key];
        });

        reset();
    });
})();
