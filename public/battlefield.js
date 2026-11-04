/* =====================================
   BATTLEFIELD
===================================== */

/*
    The Combat tab's scene. The Monster stands on the left (monster.png); the
    party stands on the right, drawn from public/assets/<class>.png, in this
    formation (the Monster is on the left, so "front" is the left):

            Tank in front, Warrior beside him, Support in the middle,
            Mage and Thief behind the Support.

    Nothing is shown on the portraits except the player's name underneath.
    Hover one (tap on touch screens, focus with the keyboard) for details:

        Monster  ->  its grid, and its current effects
        Player   ->  Energy on top, their Heart Grid in the center, their
                     cards at the bottom

    The portraits are created once and updated in place, so a hover is never
    interrupted when the game state changes underneath it.

    Relies on globals from script.js: currentEncounter, roomPlayers,
    currentPlayerID, currentRole, savedCards, renderGrid, createCompactCardFace,
    attachCardZoom, createEnergyIcon, MONSTER_EFFECT_TYPES.
*/

(function () {
    "use strict";

    const MAX_ENERGY = 9;
    const NARROW_SCREEN = 700;
    const CLOSE_DELAY_MS = 140;
    const POPOVER_GAP = 12;
    const EDGE = 10;

    const root = document.getElementById("battlefield");

    if (!root) return;

    const monsterSide = root.querySelector(".bf-monster-side");
    const formation = root.querySelector(".bf-formation");

    const popover = document.createElement("div");
    popover.className = "bf-popover";
    popover.hidden = true;
    document.body.appendChild(popover);

    let monsterNameEl = null;
    let monsterToken = null;

    const slots = new Map();        // class name -> { slot, token, name, playerID }

    let open = null;                // { kind: "monster" | "player", id, anchor }
    let closeTimer = null;
    let lastPointerType = "mouse";


    /* ---------- Small helpers ---------- */

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function formatEnergy(value) {
        return Number.isInteger(value) ? String(value) : value.toFixed(1);
    }

    function getPlayerByID(id) {
        return roomPlayers.find(player => player.id === id) || null;
    }

    function isDead(player) {
        return !player.grid.some(cell => cell === "hp" || cell === "overheal");
    }


    /* ---------- Portraits ---------- */

    function ensureMonster() {
        if (monsterToken) return;

        monsterToken = el("button", "bf-token");
        monsterToken.type = "button";

        const image = document.createElement("img");
        image.src = "/assets/monster.png";
        image.alt = "";
        image.draggable = false;
        monsterToken.appendChild(image);

        monsterNameEl = el("span", "bf-name");

        monsterSide.append(monsterToken, monsterNameEl);

        attachHover(monsterSide, monsterToken, () => ({
            kind: "monster",
            id: "monster",
            anchor: monsterToken
        }));
    }

    function renderMonster() {
        ensureMonster();

        const encounter = currentEncounter;

        monsterNameEl.textContent = encounter ? encounter.name : "No monster";
        monsterToken.setAttribute(
            "aria-label",
            encounter ? `${encounter.name}, the monster` : "No monster yet"
        );

        monsterSide.classList.toggle("is-empty", !encounter);
        monsterSide.classList.toggle(
            "is-active-turn",
            Boolean(encounter?.active && encounter.currentTurn?.type === "monster")
        );
    }

    function createSlot(className) {
        const slot = el("div", "bf-slot");
        slot.dataset.class = className;

        const token = el("button", "bf-token");
        token.type = "button";

        const image = document.createElement("img");
        image.src = `/assets/${className.toLowerCase()}.png`;
        image.alt = "";
        image.draggable = false;
        token.appendChild(image);

        const name = el("span", "bf-name");

        slot.append(token, name);
        formation.appendChild(slot);

        const entry = { slot, token, name, playerID: null };

        attachHover(slot, token, () => ({
            kind: "player",
            id: entry.playerID,
            anchor: token
        }));

        return entry;
    }

    function renderParty() {
        const present = new Set();
        const turn = currentEncounter?.active ? currentEncounter.currentTurn : null;

        // Only players have this scene, and nobody is in it once the room closes.
        const party = currentRole === "player" ? roomPlayers : [];

        party.forEach(player => {
            present.add(player.className);

            let entry = slots.get(player.className);

            if (!entry) {
                entry = createSlot(player.className);
                slots.set(player.className, entry);
            }

            entry.playerID = player.id;

            entry.name.textContent = player.username;

            if (player.id === currentPlayerID && currentRole === "player") {
                entry.name.appendChild(el("span", "bf-you", "YOU"));
            }

            entry.token.setAttribute(
                "aria-label",
                `${player.username}, ${player.className}`
            );

            entry.slot.classList.toggle("is-dead", isDead(player));
            entry.slot.classList.toggle(
                "is-active-turn",
                Boolean(turn && turn.type === "player" && turn.id === player.id)
            );
        });

        // Someone left: take their portrait away.
        slots.forEach((entry, className) => {
            if (present.has(className)) return;

            if (open?.kind === "player" && open.id === entry.playerID) {
                closePopover();
            }

            entry.slot.remove();
            slots.delete(className);
        });
    }

    function renderBattlefield() {
        renderMonster();
        renderParty();

        if (open) refreshPopover();
    }


    /* ---------- Opening / closing ---------- */

    function attachHover(host, token, describe) {
        host.addEventListener("pointerenter", event => {
            lastPointerType = event.pointerType;

            if (event.pointerType === "touch") return;

            openPopover(describe(), host);
        });

        host.addEventListener("pointerleave", event => {
            if (event.pointerType === "touch") return;

            scheduleClose();
        });

        // Tap (touch) to open, tap again to close.
        token.addEventListener("pointerdown", event => {
            lastPointerType = event.pointerType;
        });

        token.addEventListener("click", () => {
            if (lastPointerType !== "touch") return;

            const target = describe();

            if (open && open.id === target.id && open.kind === target.kind) {
                closePopover();
            } else {
                openPopover(target, host);
            }
        });

        // Keyboard.
        token.addEventListener("focus", () => {
            if (token.matches(":focus-visible")) {
                openPopover(describe(), host);
            }
        });

        token.addEventListener("blur", scheduleClose);
    }

    function openPopover(target, host) {
        clearTimeout(closeTimer);

        if (!target.id) return;
        if (target.kind === "monster" && !currentEncounter) return;

        if (open?.host && open.host !== host) {
            open.host.classList.remove("is-open");
        }

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

    // Moving from the portrait onto the panel must not close it.
    popover.addEventListener("pointerenter", event => {
        if (event.pointerType !== "touch") clearTimeout(closeTimer);
    });

    popover.addEventListener("pointerleave", event => {
        if (event.pointerType !== "touch") scheduleClose();
    });

    // Tapping anywhere else closes a panel that was opened by touch.
    document.addEventListener("pointerdown", event => {
        if (!open || event.pointerType !== "touch") return;

        if (popover.contains(event.target) || open.host.contains(event.target)) {
            return;
        }

        closePopover();
    });

    document.querySelectorAll(".player-tab, .back-button").forEach(button => {
        button.addEventListener("click", closePopover);
    });

    window.addEventListener("resize", () => {
        if (open) positionPopover();
    });

    window.addEventListener("scroll", () => {
        if (open) positionPopover();
    }, true);


    /* ---------- Panel contents ---------- */

    function refreshPopover() {
        if (!open) return;

        let content = null;

        if (open.kind === "monster") {
            content = buildMonsterPanel();
        } else {
            const player = getPlayerByID(open.id);
            content = player ? buildPlayerPanel(player) : null;
        }

        if (!content) {
            closePopover();
            return;
        }

        // Rebuilding the panel would strand a card zoom opened from inside it.
        if (cardZoomOwner && popover.contains(cardZoomOwner)) hideCardZoom();

        popover.replaceChildren(...content);
        popover.hidden = false;

        positionPopover();
    }

    function buildMonsterPanel() {
        const encounter = currentEncounter;

        if (!encounter) return null;

        const title = el("h3", "bf-popover-title", encounter.name);

        const grid = el("div", "heart-grid");
        renderGrid(grid, encounter.grid, encounter.size, {
            curses: new Set(encounter.curses || [])
        });

        const effects = el("div");
        effects.appendChild(el("p", "bf-popover-label", "CURRENT EFFECTS"));

        const list = el("div", "bf-effects");
        const active = encounter.active ? encounter.effects || {} : {};
        let shown = 0;

        MONSTER_EFFECT_TYPES.forEach(type => {
            const amount = active[type.key] || 0;

            if (amount <= 0) return;

            shown++;

            const item = el("div", "bf-effect");
            const text =
                `${type.label}: ${amount} ${type.unit}${amount === 1 ? "" : "s"}`;

            item.title = text;
            item.setAttribute("aria-label", text);

            const icon = document.createElement("img");
            icon.src = `/assets/${type.key}.png`;
            icon.alt = "";

            item.append(icon, el("strong", "", String(amount)));
            list.appendChild(item);
        });

        if (shown === 0) {
            list.appendChild(el("p", "bf-empty", "None active"));
        }

        effects.appendChild(list);

        return [title, grid, effects];
    }

    function buildPlayerPanel(player) {
        const own = player.id === currentPlayerID && currentRole === "player";
        const dead = isDead(player);

        /* Energy, on top */
        const energyValue = player.energy ?? 0;
        const energy = el("div", "bf-energy");
        energy.classList.toggle("is-overflow", energyValue > MAX_ENERGY);

        const head = el("div", "bf-energy-head");
        head.appendChild(
            el("strong", "", `${player.username}${dead ? " · DEAD" : ""}`)
        );

        const readout = el("span", "bf-energy-readout");
        readout.append(
            createEnergyIcon(),
            document.createTextNode(`${formatEnergy(energyValue)} / ${MAX_ENERGY}`)
        );
        head.appendChild(readout);

        const track = el("div", "energy-track");
        const fill = el("div", "energy-fill");
        fill.style.width =
            `${Math.max(0, Math.min(100, energyValue / MAX_ENERGY * 100))}%`;
        track.appendChild(fill);

        energy.append(head, track);

        /* Their grid, in the center */
        const grid = el("div", "heart-grid");
        renderGrid(grid, player.grid, player.gridSize, {
            marks: new Set(player.marks || [])
        });

        /* Their cards, at the bottom */
        const cards = el("div");
        cards.appendChild(el("p", "bf-popover-label", "CARDS"));

        const cardList = own ? savedCards : player.cards;

        if (Array.isArray(cardList)) {
            const row = el("div", "bf-cards");

            cardList.forEach(card => {
                const item = el("div", "bf-card");
                const faceBox = el("div", "bf-card-face");

                faceBox.appendChild(createCompactCardFace(card));
                item.append(faceBox, el("span", "bf-card-name", card.name));

                attachCardZoom(faceBox, card, { host: item });

                row.appendChild(item);
            });

            if (cardList.length === 0) {
                row.appendChild(el("p", "bf-empty", "No cards"));
            }

            cards.appendChild(row);
        } else {
            const count = player.cardCount ?? 0;

            cards.appendChild(
                el("p", "bf-empty", `${count} card${count === 1 ? "" : "s"}`)
            );
        }

        return [energy, grid, cards];
    }


    /* ---------- Placement ---------- */

    function positionPopover() {
        if (!open || popover.hidden) return;

        const rect = open.anchor.getBoundingClientRect();
        const width = popover.offsetWidth;
        const height = popover.offsetHeight;

        let left;
        let top = rect.top + rect.height / 2 - height / 2;

        if (window.innerWidth < NARROW_SCREEN) {
            // Small screens: a centered panel.
            left = (window.innerWidth - width) / 2;
            top = (window.innerHeight - height) / 2;
        } else if (open.kind === "monster") {
            // The Monster is on the left: open toward the middle of the scene.
            left = rect.right + POPOVER_GAP;
        } else {
            left = rect.left - width - POPOVER_GAP;

            if (left < EDGE) left = rect.right + POPOVER_GAP;
        }

        left = Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE));
        top = Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE));

        popover.style.left = `${left}px`;
        popover.style.top = `${top}px`;
    }


    /* ---------- Keep it current ---------- */

    ["party-update", "encounter-state", "player-state", "room-joined"].forEach(
        eventName => {
            socket.on(eventName, () => {
                // Run after script.js has applied the new state.
                queueMicrotask(renderBattlefield);
            });
        }
    );

    socket.on("room-closed", () => {
        closePopover();

        slots.forEach(entry => entry.slot.remove());
        slots.clear();

        renderBattlefield();
    });

    renderBattlefield();
})();
