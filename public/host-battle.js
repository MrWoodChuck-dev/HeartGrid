/* =====================================
   HOST: BATTLEFIELD MANAGEMENT
===================================== */

/*
    The Host's combat panel:

        Combat Order (on top)
        [Monster] [Monster] [Monster]           [Tank] [Warrior] [Support] [Mage] [Thief]
        The active Monster's DICE: click one to roll it, click it again to use it.

    Hover a portrait for details:
        Monster  ->  its HP grid and what it is carrying (Taunt, Advantage, Rage)
        Player   ->  their HP grid and how MANY cards they hold. Never their
                     Energy and never what the cards are (the Host could work
                     out a hidden Retaliate from either). A dead player gets a
                     REVIVE button here.

    Every die is a Species die (public/monster-species.js). Using one opens
    the full-screen action screen:

        Attack   pick a class, pick positions on their grid
        Heal     pick a Monster (yourself or a teammate), pick cells
        Armor    pick a Monster, pick cells
        Undying  pick cells across the whole team
        Debuff / Counter   pick a player

    NO RULES LIVE HERE. Every action is sent to the server (monster-server.js),
    which checks it and tells everyone what happened.

    Relies on globals from script.js / monster.js: socket, currentRole,
    currentEncounter, roomPlayers, isDeadPlayer, createReviveButton, renderGrid,
    getEncounterMonsters, getMonsterByID, monsterIconURL.
*/

(function () {
    "use strict";

    const FORMATION = ["Tank", "Warrior", "Support", "Mage", "Thief"];
    const CLOSE_DELAY_MS = 140;
    const EDGE = 10;
    const POPOVER_GAP = 10;

    const scene = document.getElementById("host-battlefield");

    if (!scene) return;

    const messageEl = document.getElementById("hb-message");
    const bannerEl = document.getElementById("hb-banner");

    let monstersEl = null;
    let diceEl = null;
    let partyEl = null;

    const monsterSlots = new Map();   // monster id -> { slot, token, name, badges }
    const slots = new Map();          // class name -> { slot, token, name, playerID }

    const popover = document.createElement("div");
    popover.className = "hb-popover";
    popover.hidden = true;
    document.body.appendChild(popover);

    let open = null;                  // { kind, id, host, anchor }
    let closeTimer = null;
    let lastPointerType = "mouse";

    let overlay = null;

    // What the action screen is doing right now.
    const ui = {
        dieIndex: null,
        playerID: null,
        targetMonsterID: null,
        positions: new Set(),          // cells on one grid (attack, heal, armor)
        cells: new Map()               // "monsterID:index" -> { monsterID, index } (Undying)
    };

    let hostMessage = "";


    /* ---------- Helpers ---------- */

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function isHost() {
        return currentRole === "host";
    }

    function setMessage(text) {
        hostMessage = text || "";
        if (messageEl) messageEl.textContent = hostMessage;
    }

    function isMonsterTurn() {
        return Boolean(
            currentEncounter?.active &&
            currentEncounter.currentTurn?.type === "monster" &&
            currentEncounter.monsterTurn
        );
    }

    function activeMonster() {
        const turn = currentEncounter?.monsterTurn;

        return turn ? getMonsterByID(turn.monsterID) : null;
    }

    function orderedPlayers() {
        return [...roomPlayers].sort(
            (a, b) => FORMATION.indexOf(a.className) - FORMATION.indexOf(b.className)
        );
    }

    function countHp(cells) {
        return cells.filter(
            cell => cell === "hp" || cell === "overheal" || cell === "undying" ||
                cell === "armor" || cell === "armor-overheal" || cell === "armor-undying"
        ).length;
    }

    function iconFor(className) {
        const image = document.createElement("img");

        image.src = `/assets/${className.toLowerCase()}.png`;
        image.alt = "";
        image.draggable = false;

        return image;
    }

    function monsterIconNode(monster) {
        const image = document.createElement("img");

        image.src = monsterIconURL(monster.species);
        image.alt = "";
        image.draggable = false;

        return image;
    }

    function getDie() {
        const turn = currentEncounter?.monsterTurn;

        return turn && ui.dieIndex !== null ? turn.dice[ui.dieIndex] : null;
    }

    // Under the Tank's Taunt the Tank is the only legal attack target.
    function getTauntTank() {
        const taunt = currentEncounter?.taunt;

        if (!taunt || taunt.paused) return null;

        const tank = roomPlayers.find(player => player.id === taunt.tankID);

        if (!tank) return null;

        const hasHealth = tank.grid.some(
            cell => cell === "hp" || cell === "overheal"
        );

        return hasHealth ? tank : null;
    }

    function canTargetPlayer(player, die) {
        if (!die || isDeadPlayer(player) || player.shielded) return false;

        if (die.type === "attack") {
            const tank = getTauntTank();

            return !tank || tank.id === player.id;
        }

        return true;
    }

    function isHittable(cell) {
        return cell === "hp" || cell === "overheal";
    }

    // Which cells a pool die may touch, per kind.
    const CELL_RULES = {
        heal: cell => cell === "empty" || cell === "hp",
        armor: cell => cell === "hp" || cell === "overheal" || cell === "undying",
        undying: cell => cell === "hp" || cell === "armor"
    };

    function dieKind(die) {
        if (!die) return null;

        if (die.type === "ultimate") {
            const monster = activeMonster();

            return monster ? MonsterData.SPECIES[monster.species].ultimate.id : null;
        }

        return die.type;
    }

    function isPoolOnMonsters(kind) {
        return kind === "heal" || kind === "armor" || kind === "undying";
    }

    function maxSelectable(die) {
        const kind = dieKind(die);

        if (kind === "attack") {
            const target = roomPlayers.find(player => player.id === ui.playerID);
            const hittable = target
                ? target.grid.filter(isHittable).length
                : 0;

            let max = Math.min(die.remaining, hittable);

            const taunt = currentEncounter?.taunt;

            if (taunt && !taunt.paused && target?.id === taunt.tankID) {
                max = Math.min(max, taunt.remainingDamage);
            }

            return max;
        }

        return die.remaining;
    }


    /* ---------- The scene ---------- */

    function buildScene() {
        if (monstersEl) return;

        monstersEl = el("div", "hb-monsters");
        partyEl = el("div", "hb-party");
        diceEl = el("div", "hb-dice-tray");

        scene.append(monstersEl, partyEl, diceEl);
    }

    function createMonsterSlot(monster) {
        const slot = el("div", "hb-slot hb-monster-slot");
        slot.dataset.species = monster.species;

        const token = el("button", "hb-token hb-monster-token");
        token.type = "button";
        token.appendChild(monsterIconNode(monster));

        const name = el("span", "hb-name");
        const badges = el("span", "hb-badges");

        slot.append(token, name, badges);
        monstersEl.appendChild(slot);

        const entry = { slot, token, name, badges, monsterID: monster.id };

        attachHover(slot, token, () => ({
            kind: "monster",
            id: monster.id,
            anchor: token
        }));

        return entry;
    }

    function createSlot(className) {
        const slot = el("div", "hb-slot");
        slot.dataset.class = className;

        const token = el("button", "hb-token");
        token.type = "button";
        token.appendChild(iconFor(className));

        const name = el("span", "hb-name");

        slot.append(token, name);
        partyEl.appendChild(slot);

        const entry = { slot, token, name, playerID: null };

        attachHover(slot, token, () => ({
            kind: "player",
            id: entry.playerID,
            anchor: token
        }));

        // While the Host is choosing a target, clicking a class picks it.
        token.addEventListener("click", () => {
            const player = roomPlayers.find(item => item.id === entry.playerID);
            const die = getDie();

            if (!player || !overlay || overlay.hidden || !die) return;

            if (canTargetPlayer(player, die)) pickPlayer(player.id);
        });

        return entry;
    }

    function badgesFor(monster) {
        const parts = [];

        if (monster.taunt > 0) parts.push(`TAUNT ${monster.taunt}`);
        if (monster.advantage > 0) parts.push(`ADV +${monster.advantage}`);
        if (monster.rage > 0) parts.push(`RAGE ${monster.rage}`);

        return parts;
    }

    function render() {
        if (!isHost()) return;

        buildScene();

        const encounter = currentEncounter;
        const list = encounter?.monsters || [];
        const turn = encounter?.currentTurn;

        /* Monsters */
        const present = new Set();

        list.forEach(monster => {
            present.add(monster.id);

            let entry = monsterSlots.get(monster.id);

            if (!entry) {
                entry = createMonsterSlot(monster);
                monsterSlots.set(monster.id, entry);
            }

            entry.name.textContent = monster.name;

            entry.slot.classList.toggle("is-dead", Boolean(monster.dead));
            entry.slot.classList.toggle(
                "is-active-turn",
                Boolean(
                    encounter?.active &&
                    turn?.type === "monster" &&
                    turn.id === monster.id
                )
            );

            entry.badges.replaceChildren(
                ...badgesFor(monster).map(text => el("span", "hb-badge", text))
            );

            entry.token.setAttribute(
                "aria-label",
                `${monster.name}, a ${MonsterData.SPECIES[monster.species].name}` +
                    (monster.dead ? ", defeated" : "")
            );
        });

        monsterSlots.forEach((entry, id) => {
            if (present.has(id)) return;

            if (open?.kind === "monster" && open.id === id) closePopover();

            entry.slot.remove();
            monsterSlots.delete(id);
        });

        // Keep them in bench order.
        list.forEach(monster => {
            const entry = monsterSlots.get(monster.id);
            if (entry) monstersEl.appendChild(entry.slot);
        });

        monstersEl.classList.toggle("is-empty", list.length === 0);

        /* Party */
        const presentClasses = new Set();
        const die = getDie();
        const choosing = Boolean(overlay && !overlay.hidden && die);

        orderedPlayers().forEach(player => {
            presentClasses.add(player.className);

            let entry = slots.get(player.className);

            if (!entry) {
                entry = createSlot(player.className);
                slots.set(player.className, entry);
            }

            entry.playerID = player.id;
            entry.name.textContent = player.username;

            const dead = isDeadPlayer(player);
            const selectable = choosing && canTargetPlayer(player, die);

            entry.slot.classList.toggle("is-dead", dead);
            entry.slot.classList.toggle("is-selecting", selectable);
            entry.slot.classList.toggle("is-locked", choosing && !dead && !selectable);
            entry.slot.classList.toggle(
                "is-active-turn",
                Boolean(
                    encounter?.active &&
                    turn?.type === "player" &&
                    turn.id === player.id
                )
            );

            entry.token.setAttribute(
                "aria-label",
                `${player.username}, ${player.className}`
            );
        });

        slots.forEach((entry, className) => {
            if (presentClasses.has(className)) return;

            if (open?.kind === "player" && open.id === entry.playerID) {
                closePopover();
            }

            entry.slot.remove();
            slots.delete(className);
        });

        orderedPlayers().forEach(player => {
            const entry = slots.get(player.className);
            if (entry) partyEl.appendChild(entry.slot);
        });

        renderDice();
        renderBanner();

        if (open) refreshPopover();
        if (overlay && !overlay.hidden) refreshOverlay();
    }

    function renderBanner() {
        const tank = getTauntTank();
        const parts = [];

        if (tank && currentEncounter?.active) {
            parts.push(
                `TAUNT: monsters must target ${tank.username} for ` +
                `${currentEncounter.taunt.remainingDamage} more hit(s).`
            );
        }

        (currentEncounter?.monsters || []).forEach(monster => {
            if (monster.taunt > 0 && !monster.dead) {
                parts.push(
                    `${monster.name} used Taunt: players must aim ${monster.taunt} more card(s) at it.`
                );
            }
        });

        (currentEncounter?.devilCounters || []).forEach(counter => {
            parts.push(
                `${counter.monsterName}'s Counter on ${counter.username}: ${counter.turns} turn(s).`
            );
        });

        bannerEl.hidden = parts.length === 0;
        bannerEl.textContent = parts.join("  ·  ");
    }


    /* ---------- The dice tray ---------- */

    function describeDie(die, monster) {
        const kind = dieKind(die);

        if (die.type === "ultimate") {
            const ultimate = MonsterData.SPECIES[monster.species].ultimate;

            return { label: ultimate.name.toUpperCase(), text: ultimate.text };
        }

        const info = MonsterData.DIE_TYPES[kind];

        return { label: info.label.toUpperCase(), text: info.text };
    }

    function renderDice() {
        const turn = currentEncounter?.monsterTurn;
        const monster = activeMonster();

        diceEl.replaceChildren();
        diceEl.hidden = !isMonsterTurn() || !monster;

        if (diceEl.hidden) return;

        const head = el("div", "hb-dice-head");
        head.append(
            monsterIconNode(monster),
            el(
                "strong",
                "",
                turn.bonus
                    ? `${monster.name} — COUNTER BONUS ACTION`
                    : `${monster.name}'s dice`
            )
        );

        if (turn.bonus) {
            head.appendChild(el(
                "span",
                "hb-dice-note",
                "Only the restricted attack die works."
            ));
        }

        const row = el("div", "hb-dice-row");

        turn.dice.forEach(die => {
            if (die.type === "ultimate" && die.locked && !die.rolled) {
                // Used up (or a bonus action): still shown, but greyed out.
            }

            const info = describeDie(die, monster);
            const button = el("button", "hb-die");
            button.type = "button";
            button.title = info.text;

            const state = die.locked
                ? "locked"
                : !die.rolled
                    ? "ready"
                    : die.done
                        ? "done"
                        : "use";

            button.dataset.state = state;
            button.dataset.kind = die.type === "ultimate" ? "ultimate" : die.type;

            button.append(
                el("span", "hb-die-sides", `D${die.sides}`),
                el("span", "hb-die-label", info.label),
                el(
                    "strong",
                    "hb-die-value",
                    die.rolled
                        ? (needsPool(die) && !die.done
                            ? `${die.remaining}/${die.value}`
                            : String(die.value))
                        : "?"
                ),
                el(
                    "span",
                    "hb-die-action",
                    state === "ready" ? "ROLL"
                        : state === "use" ? "USE"
                            : state === "done" ? "DONE"
                                : die.type === "ultimate" ? "SPENT" : "LOCKED"
                )
            );

            button.disabled = state === "locked" || state === "done";

            button.addEventListener("click", () => {
                if (state === "ready") {
                    setMessage("Rolling...");
                    socket.emit("monster-roll-die", { dieIndex: die.index });
                } else if (state === "use") {
                    openOverlay(die.index);
                }
            });

            row.appendChild(button);
        });

        diceEl.append(head, row);
    }

    function needsPool(die) {
        return ["attack", "heal", "armor"].includes(die.type) ||
            (die.type === "ultimate" && dieKind(die) === "undying");
    }


    /* ---------- Hover panel ---------- */

    function attachHover(host, token, describe) {
        host.addEventListener("pointerenter", event => {
            lastPointerType = event.pointerType;

            if (event.pointerType === "touch") return;

            openPopover(describe(), host);
        });

        host.addEventListener("pointerleave", event => {
            if (event.pointerType !== "touch") scheduleClose();
        });

        token.addEventListener("pointerdown", event => {
            lastPointerType = event.pointerType;
        });

        // Touch: tap to look, tap again to close.
        token.addEventListener("click", () => {
            if (lastPointerType !== "touch") return;

            const target = describe();

            if (open && open.id === target.id && open.kind === target.kind) {
                closePopover();
            } else {
                openPopover(target, host);
            }
        });

        token.addEventListener("focus", () => {
            if (token.matches(":focus-visible")) openPopover(describe(), host);
        });

        token.addEventListener("blur", scheduleClose);
    }

    function openPopover(target, host) {
        clearTimeout(closeTimer);

        if (!target.id) return;

        open?.host?.classList.remove("is-open");

        open = { ...target, host };
        host.classList.add("is-open");

        refreshPopover();
    }

    function scheduleClose() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(closePopover, CLOSE_DELAY_MS);
    }

    function closePopover() {
        clearTimeout(closeTimer);

        open?.host?.classList.remove("is-open");
        open = null;

        popover.hidden = true;
        popover.replaceChildren();
    }

    popover.addEventListener("pointerenter", event => {
        if (event.pointerType !== "touch") clearTimeout(closeTimer);
    });

    popover.addEventListener("pointerleave", event => {
        if (event.pointerType !== "touch") scheduleClose();
    });

    document.addEventListener("pointerdown", event => {
        if (!open || event.pointerType !== "touch") return;

        if (popover.contains(event.target) || open.host.contains(event.target)) {
            return;
        }

        closePopover();
    });

    window.addEventListener("resize", () => open && positionPopover());
    window.addEventListener("scroll", () => open && positionPopover(), true);

    function refreshPopover() {
        if (!open) return;

        let content = null;

        if (open.kind === "monster") {
            const monster = getMonsterByID(open.id);
            content = monster ? buildMonsterPanel(monster) : null;
        } else {
            const player = roomPlayers.find(item => item.id === open.id);
            content = player ? buildPlayerPanel(player) : null;
        }

        if (!content) {
            closePopover();
            return;
        }

        popover.replaceChildren(...content);
        popover.hidden = false;

        positionPopover();
    }

    function buildGridPanel(title, cells, size, curses) {
        const total = cells.length;
        const hp = countHp(cells);

        const head = el("div", "hb-popover-head");
        head.append(
            el("strong", "", title),
            el("span", "hb-hp", `HP ${hp} / ${total}`)
        );

        const grid = el("div", "heart-grid");
        renderGrid(grid, cells, size, { curses: curses || new Set() });

        return [head, grid];
    }

    function buildMonsterPanel(monster) {
        const species = MonsterData.SPECIES[monster.species];

        const parts = buildGridPanel(
            `${monster.name}${monster.dead ? " · DEFEATED" : ""}`,
            monster.grid,
            monster.size,
            new Set(monster.curses || [])
        );

        parts.push(el("p", "hb-cards", `${species.name} · ${species.passive.name}`));

        return parts;
    }

    function buildPlayerPanel(player) {
        const dead = isDeadPlayer(player);

        const parts = buildGridPanel(
            `${player.username}${dead ? " · DEAD" : ""}`,
            player.grid,
            player.gridSize
        );

        // Only HOW MANY cards, never which (and never Energy).
        const count = player.cardCount ?? 0;
        parts.push(el("p", "hb-cards", `${count} card${count === 1 ? "" : "s"}`));

        if (dead) parts.push(createReviveButton(player));

        return parts;
    }

    function positionPopover() {
        if (!open || popover.hidden) return;

        const rect = open.anchor.getBoundingClientRect();
        const width = popover.offsetWidth;
        const height = popover.offsetHeight;

        let left = rect.left + rect.width / 2 - width / 2;
        let top = rect.bottom + POPOVER_GAP;

        // No room underneath: open above instead.
        if (top + height > window.innerHeight - EDGE) {
            top = rect.top - height - POPOVER_GAP;
        }

        left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
        top = Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE));

        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
    }


    /* ---------- The action screen ---------- */

    function ensureOverlay() {
        if (overlay) return overlay;

        overlay = el("div", "play-overlay ha-overlay");
        overlay.id = "host-attack-overlay";
        overlay.hidden = true;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Monster action");

        overlay.innerHTML = `
            <div class="play-overlay-header">
                <div class="ha-face"></div>
                <div class="play-overlay-copy">
                    <span class="play-overlay-kicker ha-kicker"></span>
                    <h2 class="play-overlay-title ha-title"></h2>
                    <p class="play-overlay-instruction ha-instruction"></p>
                </div>
                <div class="ha-left">
                    <span>LEFT</span>
                    <strong class="ha-left-value">0</strong>
                </div>
                <button type="button" class="ha-close">CLOSE</button>
            </div>
            <div class="play-overlay-picker ha-picker"></div>
            <div class="play-overlay-stage">
                <div class="play-grid heart-grid play-attack ha-grid"></div>
            </div>
            <div class="ha-actions">
                <span class="ha-count"></span>
                <button type="button" class="primary-button ha-confirm">CONFIRM</button>
                <button type="button" class="primary-button ha-forfeit">FORFEIT THE REST</button>
                <button type="button" class="primary-button ha-end">END MONSTER TURN</button>
            </div>
            <p class="play-overlay-message ha-message" aria-live="polite"></p>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector(".ha-close").addEventListener("click", closeOverlay);
        overlay.querySelector(".ha-confirm").addEventListener("click", confirmAction);

        overlay.querySelector(".ha-forfeit").addEventListener("click", () => {
            const die = getDie();

            if (!die) return;

            socket.emit("monster-skip-die", { dieIndex: die.index });
            closeOverlay();
        });

        overlay.querySelector(".ha-end").addEventListener("click", () => {
            closeOverlay();
            socket.emit("end-monster-turn");
        });

        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && overlay && !overlay.hidden) {
                closeOverlay();
            }
        });

        return overlay;
    }

    function resetSelection() {
        ui.playerID = null;
        ui.targetMonsterID = null;
        ui.positions.clear();
        ui.cells.clear();
    }

    function openOverlay(dieIndex) {
        ensureOverlay();

        ui.dieIndex = dieIndex;
        resetSelection();

        const die = getDie();
        const kind = dieKind(die);

        // Sensible defaults: the Tank under Taunt, the only living Monster ...
        if (kind === "attack") {
            ui.playerID = getTauntTank()?.id || null;
        } else if (isPoolOnMonsters(kind)) {
            const alive = currentEncounter.monsters.filter(monster => !monster.dead);
            ui.targetMonsterID = alive.some(monster => monster.id === currentEncounter.monsterTurn.monsterID)
                ? currentEncounter.monsterTurn.monsterID
                : alive[0]?.id || null;
        }

        overlay.hidden = false;
        document.body.classList.add("play-overlay-open");
        document.querySelector("main")?.setAttribute("inert", "");

        refreshOverlay();
        render();
    }

    function closeOverlay() {
        if (!overlay || overlay.hidden) return;

        overlay.hidden = true;
        document.body.classList.remove("play-overlay-open");
        document.querySelector("main")?.removeAttribute("inert");

        ui.dieIndex = null;
        resetSelection();

        render();
    }

    function pickPlayer(playerID) {
        if (ui.playerID !== playerID) ui.positions.clear();

        ui.playerID = playerID;
        refreshOverlay();
        render();
    }

    function pickMonster(monsterID) {
        if (ui.targetMonsterID !== monsterID) ui.positions.clear();

        ui.targetMonsterID = monsterID;
        refreshOverlay();
    }

    function selectionCount() {
        return dieKind(getDie()) === "undying" ? ui.cells.size : ui.positions.size;
    }

    function toggleCell(index, grid) {
        const die = getDie();
        const kind = dieKind(die);

        if (!die) return;

        if (kind === "attack") {
            const target = roomPlayers.find(player => player.id === ui.playerID);

            if (!target || !isHittable(target.grid[index])) return;
        } else if (!CELL_RULES[kind]?.(grid[index])) {
            return;
        }

        if (kind === "undying") {
            const key = `${ui.targetMonsterID}:${index}`;

            if (ui.cells.has(key)) ui.cells.delete(key);
            else if (ui.cells.size < die.remaining) {
                ui.cells.set(key, { monsterID: ui.targetMonsterID, index });
            }
        } else if (ui.positions.has(index)) {
            ui.positions.delete(index);
        } else if (ui.positions.size < maxSelectable(die)) {
            ui.positions.add(index);
        }

        refreshOverlay();
    }

    function confirmAction() {
        const die = getDie();
        const kind = dieKind(die);

        if (!die) return;

        if (kind === "attack") {
            if (!ui.playerID || ui.positions.size === 0) return;

            socket.emit("monster-attack", {
                dieIndex: die.index,
                playerID: ui.playerID,
                positions: [...ui.positions]
            });
        } else if (kind === "heal" || kind === "armor") {
            if (!ui.targetMonsterID || ui.positions.size === 0) return;

            socket.emit(kind === "heal" ? "monster-heal" : "monster-armor", {
                targetMonsterID: ui.targetMonsterID,
                positions: [...ui.positions]
            });
        } else if (kind === "undying") {
            if (ui.cells.size === 0) return;

            socket.emit("monster-undying", { cells: [...ui.cells.values()] });
        } else if (kind === "debuff" || kind === "counter") {
            if (!ui.playerID) return;

            socket.emit(kind === "debuff" ? "monster-debuff" : "monster-counter", {
                playerID: ui.playerID
            });
        } else {
            return;
        }

        overlay.querySelector(".ha-message").textContent = "Resolving...";

        // Selections are spent; the server answers with fresh state.
        ui.positions.clear();
        ui.cells.clear();
    }

    function refreshOverlay() {
        if (!overlay || overlay.hidden) return;

        const die = getDie();
        const monster = activeMonster();

        // The Monster's turn (or this die) is over: back to the normal screen.
        if (!isMonsterTurn() || !die || !monster || die.done || !die.rolled) {
            closeOverlay();
            return;
        }

        const kind = dieKind(die);
        const info = describeDie(die, monster);
        const pool = needsPool(die);
        const encounter = currentEncounter;

        overlay.querySelector(".ha-face").replaceChildren(monsterIconNode(monster));
        overlay.querySelector(".ha-kicker").textContent =
            `${info.label} · D${die.sides} · ${monster.name.toUpperCase()}`;
        overlay.querySelector(".ha-title").textContent =
            pool ? `${die.remaining} of ${die.value} left` : `Rolled ${die.value}`;

        const picker = overlay.querySelector(".ha-picker");
        const grid = overlay.querySelector(".ha-grid");
        const stage = overlay.querySelector(".play-overlay-stage");

        picker.replaceChildren();

        overlay.querySelector(".ha-left-value").textContent =
            pool ? String(die.remaining) : String(die.value);

        let instruction = "";
        let gridCells = null;
        let gridSize = 0;
        let selected = new Set();
        let max = 0;
        let needsGrid = true;

        /* Players: attack, debuff, counter */
        if (kind === "attack" || kind === "debuff" || kind === "counter") {
            orderedPlayers()
                .filter(player => !isDeadPlayer(player))
                .forEach(player => {
                    const chip = el("button", "play-chip ha-chip");
                    chip.type = "button";
                    chip.classList.toggle("selected", ui.playerID === player.id);
                    chip.disabled = !canTargetPlayer(player, die);
                    chip.title = player.shielded
                        ? "Shielded: monsters can't target this player"
                        : kind === "attack" && getTauntTank() && chip.disabled
                            ? "Taunted: the monster must hit the Tank"
                            : player.username;

                    chip.append(iconFor(player.className), el("small", "", player.username));
                    chip.addEventListener("click", () => pickPlayer(player.id));

                    picker.appendChild(chip);
                });

            const target = roomPlayers.find(player => player.id === ui.playerID);

            if (kind === "attack") {
                max = maxSelectable(die);
                gridCells = target?.grid || null;
                gridSize = target?.gridSize || 0;
                selected = ui.positions;

                instruction = target
                    ? `Pick up to ${max} position${max === 1 ? "" : "s"} on ${target.username}'s grid, ` +
                        "or switch to another class to spread the damage."
                    : "Pick a class to strike.";
            } else {
                needsGrid = false;

                instruction = kind === "debuff"
                    ? `Pick a player. They lose ${die.value} Energy.`
                    : `Pick a player. For ${die.value} of their turns, the end of each gives ` +
                        `${monster.name} a restricted bonus action.`;
            }
        }

        /* Monsters: heal, armor, undying */
        if (isPoolOnMonsters(kind)) {
            encounter.monsters
                .filter(item => !item.dead)
                .forEach(item => {
                    const chip = el("button", "play-chip ha-chip");
                    chip.type = "button";
                    chip.classList.toggle("selected", ui.targetMonsterID === item.id);
                    chip.append(monsterIconNode(item), el("small", "", item.name));
                    chip.addEventListener("click", () => pickMonster(item.id));
                    picker.appendChild(chip);
                });

            const target = getMonsterByID(ui.targetMonsterID);

            max = die.remaining;
            gridCells = target?.grid || null;
            gridSize = target?.size || 0;

            if (kind === "undying") {
                selected = new Set(
                    [...ui.cells.values()]
                        .filter(cell => cell.monsterID === ui.targetMonsterID)
                        .map(cell => cell.index)
                );
            } else {
                selected = ui.positions;
            }

            instruction =
                kind === "heal"
                    ? `Pick up to ${max} cells on a Monster: empty cells are restored, healthy cells gain Overheal.`
                    : kind === "armor"
                        ? `Pick up to ${max} healthy cells to cover with Armor.`
                        : `Pick up to ${max} healthy cells (across the team) to turn Undying. ` +
                            "Overheal can't become Undying.";
        }

        overlay.querySelector(".ha-instruction").textContent = instruction;

        picker.hidden = picker.children.length === 0;

        /* The grid */
        if (needsGrid && gridCells) {
            stage.classList.remove("is-empty");
            grid.hidden = false;
            grid.style.gridTemplateColumns = `repeat(${gridSize}, minmax(0, 1fr))`;
            grid.style.gap = gridSize >= 6 ? "4px" : "8px";

            grid.replaceChildren(
                ...gridCells.map((type, index) => {
                    const cell = document.createElement("button");
                    const legal = kind === "attack"
                        ? isHittable(type)
                        : Boolean(CELL_RULES[kind]?.(type));

                    cell.type = "button";
                    cell.className = `grid-cell ${type}`;
                    cell.classList.toggle("target-preview", selected.has(index));
                    cell.classList.toggle("is-blocked", !legal);
                    cell.setAttribute("aria-label", `Position ${index + 1}: ${type}`);
                    cell.setAttribute("aria-pressed", String(selected.has(index)));

                    cell.addEventListener("click", () => toggleCell(index, gridCells));

                    return cell;
                })
            );
        } else {
            stage.classList.add("is-empty");
            grid.hidden = true;
            grid.replaceChildren();
        }

        /* Actions */
        const count = selectionCount();

        overlay.querySelector(".ha-count").textContent =
            needsGrid ? `Selected ${count} / ${max}` : "";

        const ready = needsGrid ? count > 0 : Boolean(ui.playerID);

        overlay.querySelector(".ha-confirm").disabled = !ready;
        overlay.querySelector(".ha-confirm").textContent =
            kind === "attack" ? "CONFIRM ATTACK"
                : kind === "debuff" ? "APPLY DEBUFF"
                    : kind === "counter" ? "APPLY COUNTER"
                        : "CONFIRM";

        // Pools can be abandoned part way (the rest is forfeited).
        overlay.querySelector(".ha-forfeit").hidden = !pool;

        overlay.querySelector(".ha-message").textContent = hostMessage;
    }


    /* ---------- Messages ---------- */

    function describeAction(result) {
        const who = result.monsterName;

        switch (result.kind) {
            case "heal":
                return `${who} healed ${result.healedPositions.length} and added Overheal to ` +
                    `${result.overhealedPositions.length} cell(s) on ${result.targetName}.`;
            case "armor":
                return `${who} put Armor on ${result.positions.length} cell(s) of ${result.targetName}.`;
            case "undying":
                return `${who} made ${result.cells.length} cell(s) Undying.`;
            case "debuff":
                return `${who} drained ${result.amount} Energy from ${result.username}.`;
            case "counter":
                return `${who} put Counter on ${result.username} for ${result.turns} turn(s).`;
            case "taunt":
                return `${who} used Taunt: ${result.taunt} card(s) must target it.`;
            case "raging-demon":
                return `${who} is Raging Demon for ${result.rage} turn(s).`;
            default:
                return "";
        }
    }


    /* ---------- Keep it current ---------- */

    function afterStateChange() {
        // Run after script.js and monster.js have applied the new state.
        queueMicrotask(render);
    }

    ["encounter-state", "party-update", "room-state"].forEach(eventName => {
        socket.on(eventName, afterStateChange);
    });

    socket.on("monster-die-result", result => {
        if (!isHost()) return;

        const extra = result.advantage > 0
            ? ` (${result.raw} + ${result.advantage} Advantage)`
            : "";

        setMessage(`Rolled ${result.value}${extra}.`);
        afterStateChange();
    });

    socket.on("monster-weakened", result => {
        if (!isHost()) return;

        setMessage(
            result.skipped
                ? `${result.monsterName} rolled ${result.roll}, but Weaken negated all of it.`
                : `${result.monsterName} rolled ${result.roll}; Weaken negated ${result.positionsNegated}.`
        );
        afterStateChange();
    });

    socket.on("monster-attack-error", message => {
        if (!isHost()) return;

        setMessage(message);
        afterStateChange();
    });

    socket.on("monster-attack-resolved", result => {
        if (!isHost()) return;

        let text =
            `${result.monsterName} attacked ${result.username} at ` +
            `${result.positions.length} position(s).`;

        if (result.rageExtraPositions?.length) {
            text += ` Raging Demon added ${result.rageExtraPositions.length} damage.`;
        }

        if (result.tauntRemaining === 0) text += " The Taunt has ended.";

        if (result.remaining > 0) text += ` ${result.remaining} position(s) left.`;

        setMessage(text);
        afterStateChange();
    });

    socket.on("monster-action-resolved", result => {
        if (!isHost()) return;

        const text = describeAction(result);

        if (text) setMessage(text);
        afterStateChange();
    });

    socket.on("monster-passive", result => {
        if (!isHost()) return;

        if (result.advantage !== undefined) {
            setMessage(`${result.monsterName} gained Advantage (now +${result.advantage}).`);
        }

        afterStateChange();
    });

    socket.on("monster-died", result => {
        if (!isHost()) return;

        setMessage(`${result.monsterName} was defeated.`);
        afterStateChange();
    });

    socket.on("encounter-state", encounter => {
        if (!encounter?.active || encounter.currentTurn?.type !== "monster") {
            closeOverlay();
        }
    });

    socket.on("room-closed", () => {
        closePopover();
        closeOverlay();

        slots.forEach(entry => entry.slot.remove());
        slots.clear();

        monsterSlots.forEach(entry => entry.slot.remove());
        monsterSlots.clear();

        setMessage("");
    });

    render();
})();
