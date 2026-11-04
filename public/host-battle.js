/* =====================================
   HOST: BATTLEFIELD MANAGEMENT
===================================== */

/*
    The Host's combat panel. It replaces the three long sections that used to
    be there (Combat Order, Monster Attack, Party Status) with one:

        Combat Order (on top)
        [Monster] [D10]                    [Tank] [Warrior] [Support] [Mage] [Thief]

    Hover a portrait for details:
        Monster  ->  its HP grid
        Player   ->  their HP grid and how MANY cards they hold. Never their
                     Energy and never what the cards are (the Host could work
                     out a hidden Retaliate from either). A dead player gets a
                     REVIVE button here.

    Once the D10 is rolled the party starts shaking: click one to open the
    attack screen (the same full-screen targeting the players see). In it the
    Host can switch between classes, spend the roll across as many players as
    they like, and end the monster's turn once at least one position was used,
    all without leaving the grid.

    NO RULES LIVE HERE. The original attack controls still exist, hidden, in
    #host-engine, and everything below drives them (roll, target, positions,
    confirm), so Taunt, Weaken, the position limit and the server's checks all
    behave exactly as before.

    Relies on globals from script.js: socket, currentRole, currentEncounter,
    roomPlayers, monsterAttackRoll, selectedTargetPositions, monsterTargetPlayer,
    monsterD10Result, monsterAttackMessage, rollMonsterD10Button,
    confirmMonsterAttackButton, tauntBanner, getActiveTauntTank,
    getMaxMonsterTargets, getSelectedTargetPlayer, renderHostTargetGrid,
    updateMonsterAttackControls, isDeadPlayer, createReviveButton, renderGrid.
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
    const endTurnLegacy = document.getElementById("end-monster-turn");

    let monsterToken = null;
    let monsterNameEl = null;
    let monsterBox = null;
    let diceValueEl = null;
    let rollButton = null;
    let partyEl = null;

    const slots = new Map();        // class name -> { slot, token, name, playerID }

    const popover = document.createElement("div");
    popover.className = "hb-popover";
    popover.hidden = true;
    document.body.appendChild(popover);

    let open = null;                // { kind, id, host, anchor }
    let closeTimer = null;
    let lastPointerType = "mouse";

    // At least one monster attack has been made this turn.
    let attackedThisTurn = false;

    let overlay = null;


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

    function isMonsterTurn() {
        return Boolean(
            currentEncounter?.active &&
            currentEncounter.currentTurn?.type === "monster"
        );
    }

    function hasRoll() {
        return monsterAttackRoll !== null;
    }

    function orderedPlayers() {
        return [...roomPlayers].sort(
            (a, b) => FORMATION.indexOf(a.className) - FORMATION.indexOf(b.className)
        );
    }

    // Under Taunt only the Tank can be chosen.
    function canTarget(player) {
        if (!isMonsterTurn() || !hasRoll() || isDeadPlayer(player)) return false;

        const tank = getActiveTauntTank();

        return !tank || tank.id === player.id;
    }

    function countHp(cells) {
        return cells.filter(cell => cell === "hp" || cell === "overheal").length;
    }

    function iconFor(className) {
        const image = document.createElement("img");

        image.src = `/assets/${className.toLowerCase()}.png`;
        image.alt = "";
        image.draggable = false;

        return image;
    }


    /* ---------- The scene ---------- */

    function buildScene() {
        if (monsterBox) return;

        monsterBox = el("div", "hb-monster");

        const monsterWrap = el("div", "hb-slot");
        monsterToken = el("button", "hb-token hb-monster-token");
        monsterToken.type = "button";

        const image = document.createElement("img");
        image.src = "/assets/monster.png";
        image.alt = "";
        image.draggable = false;
        monsterToken.appendChild(image);

        monsterNameEl = el("span", "hb-name");
        monsterWrap.append(monsterToken, monsterNameEl);

        const dice = el("div", "hb-dice");
        dice.appendChild(el("span", "hb-dice-label", "D10"));
        diceValueEl = el("strong", "hb-dice-value", "?");
        dice.appendChild(diceValueEl);

        rollButton = el("button", "hb-roll", "ROLL");
        rollButton.type = "button";
        rollButton.addEventListener("click", () => {
            if (rollMonsterD10Button.disabled) return;

            rollMonsterD10Button.click();
            render();
        });
        dice.appendChild(rollButton);

        monsterBox.append(monsterWrap, dice);

        partyEl = el("div", "hb-party");

        scene.append(monsterBox, partyEl);

        attachHover(monsterWrap, monsterToken, () => ({
            kind: "monster",
            id: "monster",
            anchor: monsterToken
        }));
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

        // While the Host is choosing a target, clicking a class opens the attack.
        token.addEventListener("click", () => {
            const player = roomPlayers.find(item => item.id === entry.playerID);

            if (player && canTarget(player)) {
                closePopover();
                openOverlay(player.id);
            }
        });

        return entry;
    }

    function render() {
        if (!isHost()) return;

        buildScene();

        const encounter = currentEncounter;

        /* Monster + dice */
        monsterNameEl.textContent = encounter ? encounter.name : "No monster";
        monsterToken.setAttribute(
            "aria-label",
            encounter ? `${encounter.name}, the monster` : "No monster yet"
        );
        monsterBox.classList.toggle("is-empty", !encounter);
        monsterBox.classList.toggle("is-active-turn", isMonsterTurn());

        diceValueEl.textContent = hasRoll() ? String(monsterAttackRoll) : "?";
        diceValueEl.parentElement.classList.toggle("has-roll", hasRoll());

        rollButton.disabled = rollMonsterD10Button.disabled;
        rollButton.hidden = hasRoll();

        /* Party */
        const present = new Set();
        const selecting = isMonsterTurn() && hasRoll();

        orderedPlayers().forEach(player => {
            present.add(player.className);

            let entry = slots.get(player.className);

            if (!entry) {
                entry = createSlot(player.className);
                slots.set(player.className, entry);
            }

            entry.playerID = player.id;
            entry.name.textContent = player.username;

            const dead = isDeadPlayer(player);
            const selectable = canTarget(player);

            entry.slot.classList.toggle("is-dead", dead);
            entry.slot.classList.toggle("is-selecting", selectable);
            entry.slot.classList.toggle("is-locked", selecting && !dead && !selectable);
            entry.slot.classList.toggle(
                "is-active-turn",
                Boolean(
                    encounter?.active &&
                    encounter.currentTurn?.type === "player" &&
                    encounter.currentTurn.id === player.id
                )
            );

            entry.token.setAttribute(
                "aria-label",
                `${player.username}, ${player.className}` +
                    (selectable ? ". Click to attack this player." : "")
            );
        });

        slots.forEach((entry, className) => {
            if (present.has(className)) return;

            if (open?.kind === "player" && open.id === entry.playerID) {
                closePopover();
            }

            entry.slot.remove();
            slots.delete(className);
        });

        // Order the icons Tank - Warrior - Support - Mage - Thief.
        orderedPlayers().forEach(player => {
            const entry = slots.get(player.className);
            if (entry) partyEl.appendChild(entry.slot);
        });

        /* Messages (the original attack messages are shown as they are) */
        messageEl.textContent = monsterAttackMessage?.textContent || "";

        bannerEl.hidden = tauntBanner.hidden;
        bannerEl.textContent = tauntBanner.textContent;

        if (open) refreshPopover();
        if (overlay && !overlay.hidden) refreshOverlay();
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
        if (target.kind === "monster" && !currentEncounter) return;

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
            content = buildMonsterPanel();
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

    function buildMonsterPanel() {
        const encounter = currentEncounter;

        if (!encounter) return null;

        return buildGridPanel(
            encounter.name,
            encounter.grid,
            encounter.size,
            new Set(encounter.curses || [])
        );
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


    /* ---------- The attack screen ---------- */

    function ensureOverlay() {
        if (overlay) return overlay;

        overlay = el("div", "play-overlay ha-overlay");
        overlay.id = "host-attack-overlay";
        overlay.hidden = true;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Monster attack");

        overlay.innerHTML = `
            <div class="play-overlay-header">
                <div class="ha-face"><img src="/assets/monster.png" alt="" draggable="false"></div>
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
                <button type="button" class="primary-button ha-confirm">CONFIRM ATTACK</button>
                <button type="button" class="primary-button ha-end">END MONSTER TURN</button>
            </div>
            <p class="play-overlay-message ha-message" aria-live="polite"></p>
        `;

        document.body.appendChild(overlay);

        overlay.querySelector(".ha-close").addEventListener("click", closeOverlay);

        overlay.querySelector(".ha-confirm").addEventListener("click", () => {
            if (confirmMonsterAttackButton.disabled) return;

            confirmMonsterAttackButton.click();
            render();
        });

        overlay.querySelector(".ha-end").addEventListener("click", () => {
            if (!canEndTurn()) return;

            // Same button the Host always had; it ends the turn on the server.
            endTurnLegacy.click();
        });

        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && overlay && !overlay.hidden) {
                closeOverlay();
            }
        });

        return overlay;
    }

    // Ending the turn early is allowed once at least one position was used.
    function canEndTurn() {
        return Boolean(
            isMonsterTurn() &&
            (attackedThisTurn || currentEncounter?.monsterHasActed) &&
            !endTurnLegacy.disabled
        );
    }

    function setTarget(playerID) {
        if (monsterTargetPlayer.value === playerID) return;

        monsterTargetPlayer.value = playerID;

        // The original control clears the picked positions and redraws.
        monsterTargetPlayer.dispatchEvent(new Event("change"));
    }

    function openOverlay(playerID) {
        ensureOverlay();

        if (playerID) setTarget(playerID);

        overlay.hidden = false;
        document.body.classList.add("play-overlay-open");
        document.querySelector("main")?.setAttribute("inert", "");

        refreshOverlay();
    }

    function closeOverlay() {
        if (!overlay || overlay.hidden) return;

        overlay.hidden = true;
        document.body.classList.remove("play-overlay-open");
        document.querySelector("main")?.removeAttribute("inert");
    }

    function refreshOverlay() {
        if (!overlay || overlay.hidden) return;

        // The monster's turn is over: back to the normal screen.
        if (!isMonsterTurn()) {
            closeOverlay();
            return;
        }

        const encounter = currentEncounter;
        const roll = hasRoll();
        const target = getSelectedTargetPlayer();
        const max = getMaxMonsterTargets();
        const selected = selectedTargetPositions.size;

        overlay.querySelector(".ha-kicker").textContent = "MONSTER ATTACK";
        overlay.querySelector(".ha-title").textContent = encounter.name;
        overlay.querySelector(".ha-left-value").textContent =
            roll ? String(monsterAttackRoll) : "0";

        overlay.querySelector(".ha-instruction").textContent = !roll
            ? "All positions used. End the monster's turn."
            : target
                ? `Pick up to ${max} position${max === 1 ? "" : "s"} on ${target.username}'s grid, ` +
                  "or switch to another class to spread the damage."
                : "Pick a class to strike.";

        /* Class icons: the selection */
        const picker = overlay.querySelector(".ha-picker");
        picker.replaceChildren();

        orderedPlayers()
            .filter(player => !isDeadPlayer(player))
            .forEach(player => {
                const chip = el("button", "play-chip ha-chip");
                chip.type = "button";
                chip.classList.toggle("selected", target?.id === player.id);
                chip.disabled = !canTarget(player);
                chip.title = getActiveTauntTank() && chip.disabled
                    ? "Taunted: the monster must hit the Tank"
                    : player.username;

                chip.append(iconFor(player.className), el("small", "", player.username));

                chip.addEventListener("click", () => {
                    setTarget(player.id);
                    render();
                });

                picker.appendChild(chip);
            });

        /* Their grid: pick positions */
        const grid = overlay.querySelector(".ha-grid");

        if (target && roll) {
            grid.hidden = false;
            grid.style.gridTemplateColumns =
                `repeat(${target.gridSize}, minmax(0, 1fr))`;
            grid.style.gap = target.gridSize >= 6 ? "4px" : "8px";

            grid.replaceChildren(
                ...target.grid.map((type, index) => {
                    const cell = document.createElement("button");
                    const hittable = type === "hp" || type === "overheal";

                    cell.type = "button";
                    cell.className = `grid-cell ${type}`;
                    cell.classList.toggle("target-preview", selectedTargetPositions.has(index));
                    cell.classList.toggle("is-blocked", !hittable);
                    cell.setAttribute("aria-label", `Position ${index + 1}: ${type}`);
                    cell.setAttribute("aria-pressed", String(selectedTargetPositions.has(index)));

                    cell.addEventListener("click", () => toggleCell(target, index));

                    return cell;
                })
            );
        } else {
            grid.hidden = true;
            grid.replaceChildren();
        }

        overlay.querySelector(".play-overlay-stage").classList.toggle(
            "is-empty",
            !(target && roll)
        );

        /* Actions */
        overlay.querySelector(".ha-count").textContent =
            target && roll ? `Selected ${selected} / ${max}` : "";

        overlay.querySelector(".ha-confirm").disabled =
            confirmMonsterAttackButton.disabled;

        const endButton = overlay.querySelector(".ha-end");
        endButton.hidden = !(attackedThisTurn || encounter.monsterHasActed);
        endButton.disabled = !canEndTurn();

        overlay.querySelector(".ha-message").textContent =
            monsterAttackMessage?.textContent || "";
    }

    // Same rules as the original grid: only HP / Overheal, never above the max.
    function toggleCell(player, index) {
        const cell = player.grid[index];

        if (cell !== "hp" && cell !== "overheal") return;

        if (selectedTargetPositions.has(index)) {
            selectedTargetPositions.delete(index);
        } else if (selectedTargetPositions.size < getMaxMonsterTargets()) {
            selectedTargetPositions.add(index);
        }

        renderHostTargetGrid();
        updateMonsterAttackControls();
        refreshOverlay();
    }


    /* ---------- Keep it current ---------- */

    function afterStateChange() {
        // Run after script.js has applied the new state.
        queueMicrotask(render);
    }

    ["encounter-state", "party-update", "room-state", "monster-weakened",
     "monster-attack-error", "monster-d10-result"].forEach(eventName => {
        socket.on(eventName, afterStateChange);
    });

    socket.on("monster-d10-result", () => {
        attackedThisTurn = false;
    });

    socket.on("monster-attack-resolved", () => {
        if (!isHost()) return;

        attackedThisTurn = true;
        afterStateChange();
    });

    socket.on("encounter-state", encounter => {
        if (!encounter?.active || encounter.currentTurn?.type !== "monster") {
            attackedThisTurn = false;
        }
    });

    socket.on("room-closed", () => {
        attackedThisTurn = false;

        closePopover();
        closeOverlay();

        slots.forEach(entry => entry.slot.remove());
        slots.clear();
    });

    render();
})();
