/* =====================================
   MONSTERS  (client side)
===================================== */

/*
    Everything the browser does for Monsters lives here (script.js only runs
    the rest of the game):

        - the Monster creator and the Bench (Host)
        - the encounter state: up to three Monsters, each with its own grid
        - choosing which Monster a card targets (players)
        - the initiative octagon (everyone)
        - the Monster's Effects panel
        - what players and the Host are told when a Monster acts

    The Species themselves (dice, passives) are described once, in
    monster-species.js (MonsterData), which the server also uses. There is no
    general "monster" icon any more: every Monster shows its Species portrait,
    /assets/spirit.png, /assets/devil.png or /assets/scale.png.

    Loads AFTER script.js and cards.js, BEFORE stage.js, battlefield.js and
    host-battle.js (they use the helpers below).
*/


/* =====================================
   HELPERS
===================================== */

function monsterIconURL(species) {
    return `/assets/${species}.png`;
}

function getEncounterMonsters() {
    return currentEncounter?.monsters || [];
}

function getMonsterByID(id) {
    return getEncounterMonsters().find(monster => monster.id === id) || null;
}

function getAliveMonsters() {
    return getEncounterMonsters().filter(monster => !monster.dead);
}

function countMonsterHp(monster) {
    return monster.grid.filter(cell => cell !== "empty").length;
}

// The Host's message line. Older code writes to monsterEncounterMessage;
// it lands in the creator's line and in the battle panel's line.
const monsterEncounterMessage = {
    set textContent(text) {
        ["monster-encounter-message", "hb-message"].forEach(id => {
            const node = document.getElementById(id);
            if (node) node.textContent = text;
        });
    },

    get textContent() {
        return document.getElementById("monster-encounter-message")?.textContent || "";
    }
};

// A message for whoever is looking: players on their card line, the Host on theirs.
function announceMonsterEvent(text) {
    if (!text) return;

    if (currentRole === "player") {
        combatCardMessage.textContent = text;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = text;
    }
}

function createMonsterIcon(species, className = "monster-icon") {
    const image = document.createElement("img");

    image.src = monsterIconURL(species);
    image.alt = "";
    image.draggable = false;
    image.className = className;

    return image;
}


/* =====================================
   PLAYER TARGETING: WHICH MONSTER?
===================================== */

/*
    Every card that targets a Monster (Attack, Blast, Spellvamp, Curse,
    Execute, Counter ...) lets the player pick WHICH one in the targeting
    screen. The server checks it again; this only keeps the screen honest.

        Taunt   while a Monster's Taunt has cards left, only it can be chosen
        Counter on a Warrior's Counter turn only the countered Monster can
                be chosen (Taunt is ignored)
        Blast   can aim at two DIFFERENT Monsters, one aim each
*/

let selectedMonsterID = null;
let blastAims = [];           // [{ monsterID, anchor }] aims already placed

function getMonsterLock() {
    return isMyCounterTurn()
        ? currentEncounter.currentTurn.counterMonsterID || null
        : null;
}

function getSelectableMonsters(card) {
    const alive = getAliveMonsters();
    const lock = getMonsterLock();

    if (lock) return alive.filter(monster => monster.id === lock);

    // Counter ignores Taunt.
    if (card?.type === "counter") return alive;

    const taunting = alive.filter(monster => monster.taunt > 0);

    return taunting.length > 0 ? taunting : alive;
}

// Why a Monster can't be picked right now ("" when it can).
function whyMonsterBlocked(monster, card) {
    if (monster.dead) return "Defeated";

    const lock = getMonsterLock();

    if (lock && monster.id !== lock) return "Counter locks you onto another Monster";

    if (!getSelectableMonsters(card).some(item => item.id === monster.id)) {
        return "Taunted: aim at the Monster that used Taunt first";
    }

    if (card?.type === "execute" && !monster.grid.includes("hp")) {
        return "No healthy cells to execute";
    }

    return "";
}

function prepareMonsterTarget(card) {
    blastAims = [];

    const list = getSelectableMonsters(card).filter(
        monster => !whyMonsterBlocked(monster, card)
    );

    selectedMonsterID = list.some(monster => monster.id === selectedMonsterID)
        ? selectedMonsterID
        : list[0]?.id || null;
}

function resetMonsterTargeting() {
    selectedMonsterID = null;
    blastAims = [];
}

// Grid data (cells, size, curses) for one Monster; the picked one by default.
function getMonsterGridData(monster = null) {
    const target =
        monster ||
        getMonsterByID(selectedMonsterID) ||
        getAliveMonsters()[0] ||
        null;

    return {
        cells: target?.grid || [],
        size: target?.size || 3,
        marks: new Set(),
        curses: new Set(target?.curses || [])
    };
}

// The chips at the top of the targeting screen.
function renderMonsterPicker(picker, card, mode) {
    // The picked Monster may have died or become untargetable meanwhile.
    const picked = getMonsterByID(selectedMonsterID);

    if (!picked || whyMonsterBlocked(picked, card)) {
        const keep = blastAims;

        prepareMonsterTarget(card);
        blastAims = keep;
    }

    const def = CARD_DEFS[card.type];
    const multi = def?.multi === 2;
    const aimed = new Set(blastAims.map(aim => aim.monsterID));

    getEncounterMonsters().forEach(monster => {
        const reason = whyMonsterBlocked(monster, card);
        const alreadyAimed = aimed.has(monster.id);

        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "play-chip monster-chip";
        chip.dataset.species = monster.species;

        chip.classList.toggle("selected", monster.id === selectedMonsterID);
        chip.classList.toggle("is-dead", Boolean(monster.dead));
        chip.classList.toggle("is-aimed", alreadyAimed);
        chip.classList.toggle("is-taunting", monster.taunt > 0 && !monster.dead);

        chip.disabled = combatAttackPending || Boolean(reason) || alreadyAimed;
        chip.title = alreadyAimed ? "Already aimed at" : reason || monster.name;

        const portrait = document.createElement("span");
        portrait.className = "monster-chip-art";
        portrait.appendChild(createMonsterIcon(monster.species));

        const name = document.createElement("strong");
        name.textContent = monster.name;

        const detail = document.createElement("small");
        detail.textContent = monster.dead
            ? "Defeated"
            : alreadyAimed
                ? "Aimed"
                : monster.taunt > 0
                    ? `TAUNT ${monster.taunt}`
                    : `${MonsterData.SPECIES[monster.species].name} · ${countMonsterHp(monster)} cells`;

        chip.append(portrait, name, detail);

        chip.addEventListener("click", () => {
            if (combatAttackPending || reason || alreadyAimed) return;

            if (mode === "monsterpick") {
                confirmMonsterPick(card, monster);
                return;
            }

            selectedMonsterID = monster.id;
            overlayHoverAnchor = null;
            overlayArmedAnchor = null;

            setOverlayMessage("");
            refreshPlayOverlay();
        });

        picker.appendChild(chip);
    });

    // Blast: one aim is down, the second is optional.
    if (multi && blastAims.length === 1) {
        const fire = document.createElement("button");
        fire.type = "button";
        fire.className = "play-chip blast-fire";
        fire.disabled = combatAttackPending;
        fire.textContent = "FIRE NOW (1 TARGET)";
        fire.addEventListener("click", () => fireBlast(card));

        picker.appendChild(fire);
    }
}

// One click on a Monster's grid, for pattern cards.
function confirmMonsterPlacement(card, def, anchor) {
    const monster = getMonsterByID(selectedMonsterID);

    if (!monster || monster.dead) {
        combatCardMessage.textContent = "Choose a Monster to target first.";
        return;
    }

    const data = getMonsterGridData(monster);
    const positions = getCardTargetPositions(card, anchor, data.size);

    if (!positions) {
        combatCardMessage.textContent =
            `Invalid placement. The pattern must fit inside ${monster.name}'s grid.`;
        return;
    }

    if (!isPlacementValid(card, "monster", positions, data)) {
        combatCardMessage.textContent =
            def.invalidMessage || "That placement isn't valid.";
        return;
    }

    // Blast: the first aim waits for an optional second, different Monster.
    if (def.multi === 2) {
        blastAims.push({ monsterID: monster.id, anchor });

        const others = getSelectableMonsters(card).filter(
            item => !blastAims.some(aim => aim.monsterID === item.id)
        );

        if (blastAims.length >= 2 || others.length === 0) {
            fireBlast(card);
            return;
        }

        selectedMonsterID = others[0].id;
        overlayHoverAnchor = null;

        combatCardMessage.textContent =
            `Blast aimed at ${monster.name}. Aim at a second Monster, or fire now.`;
        return;
    }

    combatAttackPending = true;

    socket.emit(def.event, {
        cardID: card.id,
        anchor,
        monsterID: monster.id
    });

    combatCardMessage.textContent = def.pending
        ? def.pending(card)
        : `Playing ${card.name}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

function fireBlast(card) {
    if (blastAims.length === 0 || combatAttackPending) return;

    const def = CARD_DEFS[card.type];

    combatAttackPending = true;

    socket.emit(def.event, {
        cardID: card.id,
        targets: blastAims.map(aim => ({ ...aim }))
    });

    combatCardMessage.textContent = def.pending
        ? def.pending(card)
        : `Playing ${card.name}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

// Execute and Counter: nothing to aim, the Monster is the whole choice.
function confirmMonsterPick(card, monster) {
    if (!card || combatAttackPending) return;

    const def = CARD_DEFS[card.type];

    combatAttackPending = true;

    socket.emit(def.event, { cardID: card.id, monsterID: monster.id });

    setOverlayMessage(`Targeting ${monster.name}...`);
    combatCardMessage.textContent = `Playing ${card.name} on ${monster.name}...`;

    renderCombatCards();
    refreshPlayOverlay();
}

// Old name, still called after card results. The screens that show a
// Monster's grid redraw from the state; here only the targeting screen.
function renderCombatMonsterGrid() {
    if (typeof isPlayOverlayOpen === "function" && isPlayOverlayOpen()) {
        refreshPlayOverlay();
    }
}



/* =====================================
   MONSTER'S EFFECTS
===================================== */

/*
    Right under Turn Order, for the Host and for players.
    Taunt, Weaken and Status are Charges; Counter, Hex and Shield are Turns
    (Hex and Shield count monster turns).
    Icon + number only (the words are in the tooltip / screen-reader label).
*/
const MONSTER_EFFECT_TYPES = [
    { key: "taunt", label: "Taunt", unit: "Charge" },
    { key: "weaken", label: "Weaken", unit: "Charge" },
    { key: "counter", label: "Counter", unit: "Turn" },
    { key: "status", label: "Status", unit: "Charge" },
    { key: "hex", label: "Hex", unit: "Turn" },
    { key: "shield", label: "Shield", unit: "Turn" }
];

function ensureMonsterEffectsPanels() {
    if (!document.getElementById("monster-effects-styles")) {
        const style = document.createElement("style");
        style.id = "monster-effects-styles";
        style.textContent = `
            .monster-effects-panel {
                margin: 12px 0 16px;
                padding: 12px;
                border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
                border-radius: 10px;
                background: var(--surface, rgba(128, 128, 128, 0.06));
            }
            .monster-effects-panel .monster-effects-heading {
                margin: 0 0 9px;
                font-size: 10px;
                font-weight: 800;
                letter-spacing: 1.5px;
                opacity: 0.7;
            }
            .monster-effects-panel .monster-effects-list {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                min-height: 40px;
                align-items: center;
            }
            .monster-effects-panel .monster-effect {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 12px 6px 8px;
                border: 1px solid rgba(128, 128, 128, 0.3);
                border-radius: 8px;
                background: rgba(128, 128, 128, 0.05);
            }
            .monster-effects-panel .monster-effect img {
                width: 40px;
                height: 40px;
                object-fit: contain;
            }
            .monster-effects-panel .monster-effect-count {
                min-width: 14px;
                font-size: 20px;
                font-weight: 800;
                line-height: 1;
                text-align: center;
            }
            .monster-effects-panel .monster-effect.just-changed {
                animation: monster-effect-bump 0.35s ease;
            }
            .monster-effects-panel .monster-effects-empty {
                margin: 0;
                font-size: 11px;
                opacity: 0.55;
            }
            @keyframes monster-effect-bump {
                0% { transform: scale(1); }
                40% { transform: scale(1.12); }
                100% { transform: scale(1); }
            }
        `;
        document.head.appendChild(style);
    }

    const placements = [
        // Players: right under their Turn Order panel.
        {
            id: "player-monster-effects",
            anchor: document.getElementById("combat-order-panel")
        },
        // Host: right under the initiative list.
        {
            id: "host-monster-effects",
            anchor: document.getElementById("host-initiative-list")
        }
    ];

    placements.forEach(({ id, anchor }) => {
        if (!anchor || document.getElementById(id)) return;

        const panel = document.createElement("section");
        panel.id = id;
        panel.className = "monster-effects-panel";
        panel.hidden = true;

        const heading = document.createElement("h3");
        heading.className = "monster-effects-heading";
        heading.textContent = "MONSTER'S EFFECTS";

        const list = document.createElement("div");
        list.className = "monster-effects-list";

        panel.append(heading, list);
        anchor.insertAdjacentElement("afterend", panel);
    });
}

const previousMonsterEffects = {};

function renderMonsterEffects() {
    ensureCombatOrderUI();
    ensureMonsterEffectsPanels();

    const effects = currentEncounter?.effects || {};
    const show = Boolean(currentEncounter?.active);

    ["player-monster-effects", "host-monster-effects"].forEach(id => {
        const panel = document.getElementById(id);

        if (!panel) return;

        panel.hidden = !show;

        const list = panel.querySelector(".monster-effects-list");

        list.replaceChildren();

        if (!show) return;

        let shown = 0;

        MONSTER_EFFECT_TYPES.forEach(type => {
            const amount = effects[type.key] || 0;

            if (amount <= 0) return;

            shown++;

            const item = document.createElement("div");
            item.className = "monster-effect";

            const text =
                `${type.label}: ${amount} ${type.unit}${amount === 1 ? "" : "s"}`;

            item.title = text;
            item.setAttribute("aria-label", text);

            if (
                previousMonsterEffects[type.key] !== undefined &&
                previousMonsterEffects[type.key] !== amount
            ) {
                item.classList.add("just-changed");
            }

            const icon = document.createElement("img");
            icon.src = `/assets/${type.key}.png`;
            icon.alt = "";

            const count = document.createElement("span");
            count.className = "monster-effect-count";
            count.textContent = String(amount);

            item.append(icon, count);
            list.appendChild(item);
        });

        if (shown === 0) {
            const empty = document.createElement("p");
            empty.className = "monster-effects-empty";
            empty.textContent = "None active";
            list.appendChild(empty);
        }
    });

    // Hex changes what Attack and Blast cost, so redraw the cards.
    const hadHex = (previousMonsterEffects.hex || 0) > 0;
    const hexChanged = (previousMonsterEffects.hex || 0) !== (effects.hex || 0);

    MONSTER_EFFECT_TYPES.forEach(type => {
        previousMonsterEffects[type.key] = effects[type.key] || 0;
    });

    if (hexChanged && currentRole === "player") {
        // A Hex that has just started makes the costs count down on screen.
        if ((previousMonsterEffects.hex || 0) > 0 && !(hadHex)) {
            hexCostAnimationUntil = performance.now() + 600;
        }

        renderSavedCards();
        renderCombatCards();
    }
}

/* =====================================
   ENCOUNTER STATE
===================================== */

socket.on("encounter-state", encounter => {
    currentEncounter = encounter;

    // A Monster that died, or a Taunt that ended, can change who is pickable.
    if (selectedMonsterID && !getMonsterByID(selectedMonsterID)) {
        selectedMonsterID = null;
    }

    renderHostCreator();

    if (!encounter) {
        combatStatus.textContent = "Waiting for an encounter...";

        cancelCardTargeting(false);
        renderCombatOrder();
        renderMonsterEffects();

        return;
    }

    refreshCombatStatusLine();
    renderMonsterEffects();

    if (!encounter.active) {
        cancelCardTargeting(false);
    }

    // If it stopped being my turn, drop any half-aimed card.
    if (
        currentRole === "player" &&
        selectedCombatCard &&
        !combatAttackPending &&
        !isMyTurn()
    ) {
        cancelCardTargeting(false);
    }

    renderCombatMonsterGrid();

    renderPlayerGrid();
    renderPlayerPartyGrids();
});

socket.on("room-closed", () => {
    resetMonsterTargeting();
    closeInitiativeOverlay();
    creator.selectedBenchID = null;
    renderHostCreator();
});


/* =====================================
   WHAT EVERYONE IS TOLD
===================================== */

socket.on("monster-weakened", result => {
    if (currentRole !== "player") return;

    combatCardMessage.textContent = result.skipped
        ? `${result.monsterName}'s attack was fully weakened.`
        : `${result.monsterName}'s attack was reduced from ${result.roll} to ${result.effective}. ` +
            `${result.positionsNegated ?? result.absorbed} position(s) negated; ` +
            `${result.weakenLeft} Weaken remains.`;
});

socket.on("monster-attack-resolved", result => {
    if (currentRole !== "player") return;

    let text =
        `${result.monsterName} hit ${result.username} for ` +
        `${result.positions.length} position(s).`;

    if (result.rageExtraPositions?.length) {
        text += ` Raging Demon dealt ${result.rageExtraPositions.length} extra damage.`;
    }

    if (result.tauntRemaining === 0) text += " The Taunt has ended.";

    combatCardMessage.textContent = text;

    clearCombatTargetPreview();
});

socket.on("monster-action-resolved", result => {
    if (currentRole !== "player") return;

    const who = result.monsterName;

    const text = {
        heal: () => `${who} healed ${result.targetName}.`,
        armor: () => `${who} armored ${result.targetName}.`,
        undying: () => `${who} made ${result.cells.length} cell(s) Undying.`,
        debuff: () => result.playerID === currentPlayerID
            ? `${who} drained ${result.amount} of your Energy!`
            : `${who} drained ${result.amount} Energy from ${result.username}.`,
        counter: () => result.playerID === currentPlayerID
            ? `${who} put Counter on you for ${result.turns} turn(s): whenever you end a turn, it acts again.`
            : `${who} put Counter on ${result.username} for ${result.turns} turn(s).`,
        taunt: () => `${who} used Taunt! Aim ${result.taunt} card(s) at it before targeting anyone else.`,
        "raging-demon": () => `${who} is Raging Demon for ${result.rage} turn(s)!`
    }[result.kind];

    if (text) combatCardMessage.textContent = text();
});

socket.on("monster-passive", result => {
    if (result.passive === "Spirited Health") {
        const names = [...new Set(result.heals.map(heal => heal.targetName))].join(", ");

        announceMonsterEvent(
            `${result.monsterName}'s Spirited Health healed ${result.heals.length} cell(s) of ${names}.`
        );
    } else if (result.passive === "Adaptive Armor") {
        announceMonsterEvent(
            `${result.monsterName}'s Adaptive Armor turned a ${result.converted} into healing!`
        );
    }
    // Wrathful Position (Advantage) is shown on Devil's portrait.
});

socket.on("monster-died", result => {
    announceMonsterEvent(`${result.monsterName} was defeated!`);
});

socket.on("monsters-defeated", () => {
    announceMonsterEvent(
        currentRole === "host"
            ? "Every Monster is defeated. End the encounter when you are ready."
            : "Every Monster is defeated!"
    );
});

socket.on("monster-taunt-ended", result => {
    announceMonsterEvent(`${result.monsterName}'s Taunt has ended.`);
});

socket.on("monster-effect-ended", result => {
    announceMonsterEvent(`${result.monsterName}'s ${result.effect} has ended.`);
});

socket.on("monster-bonus-started", result => {
    announceMonsterEvent(
        `${result.monsterName} gets a bonus action (Counter on ${result.username}): restricted attack only.`
    );
});


/* =====================================
   INITIATIVE  (the octagon)
===================================== */

/*
    Up to eight take part: five players and three Monsters, each with a
    unique number from 1 to 8 (1 acts first). When the encounter starts the
    server sends the result and every screen plays the same animation: an
    octagon spins through 1-8, then each participant's number lands.

    Underneath: Monsters on the left (name under the icon), player classes on
    the right (username under the icon).
*/

let initiativeOverlay = null;
let initiativeTimers = [];

function closeInitiativeOverlay() {
    initiativeTimers.forEach(timer => {
        clearTimeout(timer);
        clearInterval(timer);
    });

    initiativeTimers = [];

    if (initiativeOverlay) {
        initiativeOverlay.remove();
        initiativeOverlay = null;
    }
}

function createInitiativeChip(participant) {
    const chip = document.createElement("div");
    chip.className = "init-chip";

    const art = document.createElement("div");
    art.className = "init-chip-art";

    const icon = document.createElement("img");
    icon.src = participant.type === "monster"
        ? monsterIconURL(participant.species)
        : `/assets/${participant.className.toLowerCase()}.png`;
    icon.alt = "";
    icon.draggable = false;

    const number = document.createElement("span");
    number.className = "init-chip-number";
    number.textContent = "?";

    art.append(icon, number);

    const name = document.createElement("span");
    name.className = "init-chip-name";
    name.textContent = participant.username;

    chip.append(art, name);

    chip._number = number;

    return chip;
}

function showInitiativeAnimation(order) {
    closeInitiativeOverlay();

    if (!order?.length) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const overlay = document.createElement("div");
    overlay.className = "init-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Initiative");

    const card = document.createElement("div");
    card.className = "init-card";

    const title = document.createElement("h2");
    title.className = "init-title";
    title.textContent = "INITIATIVE";

    const octagon = document.createElement("div");
    octagon.className = "init-octagon is-spinning";

    const face = document.createElement("div");
    face.className = "init-octagon-face";

    const value = document.createElement("span");
    value.className = "init-octagon-value";
    value.textContent = "1";

    face.appendChild(value);
    octagon.appendChild(face);

    const sides = document.createElement("div");
    sides.className = "init-sides";

    const left = document.createElement("div");
    left.className = "init-side init-monsters";

    const right = document.createElement("div");
    right.className = "init-side init-players";

    const chips = new Map();

    order
        .filter(participant => participant.type === "monster")
        .forEach(participant => {
            const chip = createInitiativeChip(participant);
            chips.set(participant.id, chip);
            left.appendChild(chip);
        });

    order
        .filter(participant => participant.type === "player")
        .forEach(participant => {
            const chip = createInitiativeChip(participant);
            chips.set(participant.id, chip);
            right.appendChild(chip);
        });

    sides.append(left, right);

    const hint = document.createElement("p");
    hint.className = "init-hint";
    hint.textContent = "Number 1 acts first. Click to continue.";
    hint.hidden = true;

    card.append(title, octagon, sides, hint);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    initiativeOverlay = overlay;

    overlay.addEventListener("click", closeInitiativeOverlay);

    const SPIN_MS = reduced ? 0 : 2300;
    const STEP_MS = reduced ? 0 : 420;
    const HOLD_MS = 4200;

    // Phase 1: the octagon spins through the numbers.
    let shown = 1;

    if (SPIN_MS > 0) {
        const spinner = setInterval(() => {
            shown = shown % 8 + 1;
            value.textContent = String(shown);
        }, 75);

        initiativeTimers.push(spinner);
    }

    // Phase 2: the numbers land, 1 first.
    const reveal = () => {
        octagon.classList.remove("is-spinning");
        octagon.classList.add("is-landed");

        const first = order[0];

        order.forEach((participant, index) => {
            const land = () => {
                const chip = chips.get(participant.id);

                chip._number.textContent = String(participant.initiative);
                chip.classList.add("is-landed");

                value.textContent = String(participant.initiative);
                octagon.classList.remove("is-pulse");
                void octagon.offsetWidth;
                octagon.classList.add("is-pulse");

                if (index === order.length - 1) {
                    hint.hidden = false;
                    value.textContent = String(first.initiative);

                    initiativeTimers.push(setTimeout(closeInitiativeOverlay, HOLD_MS));
                }
            };

            if (STEP_MS === 0) land();
            else initiativeTimers.push(setTimeout(land, index * STEP_MS));
        });
    };

    initiativeTimers.push(setTimeout(() => {
        initiativeTimers.forEach(timer => clearInterval(timer));
        reveal();
    }, SPIN_MS));
}

socket.on("initiative-rolled", result => {
    if (!currentRole) return;

    showInitiativeAnimation(result.order);
});


/* =====================================
   HOST: MONSTER CREATOR AND BENCH
===================================== */

/*
    Pick a Species with the arrows (they loop), hover it to see its dice,
    hover a die to see what it does. Name it, choose its grid, then DRAG the
    Monster card onto the Bench (three places; the same Species can be used
    more than once). Click a Monster on the Bench to paint its grid. START
    ENCOUNTER and END ENCOUNTER sit side by side underneath.
*/

const creator = {
    built: false,
    speciesIndex: 0,
    size: 5,
    name: "",
    selectedBenchID: null,
    drag: null
};

const SPECIES_ORDER = Object.keys(MonsterData.SPECIES);

const creatorRoot = document.getElementById("monster-creator-root");

function mcEl(tag, className, text) {
    const node = document.createElement(tag);

    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;

    return node;
}

function currentSpecies() {
    return MonsterData.SPECIES[SPECIES_ORDER[creator.speciesIndex]];
}

function dieLabel(die) {
    return `D${die.sides} ${MonsterData.DIE_TYPES[die.type].label}`;
}

// A row of the Species' dice. Hovering one shows what it does.
function createDiceRow(species, { withUltimate = true } = {}) {
    const row = mcEl("div", "mc-dice");

    species.dice.forEach(die => {
        const chip = mcEl("span", `mc-die mc-die-${die.type}`);
        chip.tabIndex = 0;
        chip.dataset.tip = MonsterData.DIE_TYPES[die.type].text;
        chip.append(
            mcEl("strong", "", `D${die.sides}`),
            mcEl("span", "", MonsterData.DIE_TYPES[die.type].label)
        );
        row.appendChild(chip);
    });

    if (withUltimate) {
        const ultimate = species.ultimate;
        const chip = mcEl("span", "mc-die mc-die-ultimate");
        chip.tabIndex = 0;
        chip.dataset.tip = `${ultimate.name}: ${ultimate.text}`;
        chip.append(mcEl("strong", "", `D${ultimate.sides}`), mcEl("span", "", ultimate.name));
        row.appendChild(chip);
    }

    return row;
}

function buildCreator() {
    if (creator.built || !creatorRoot) return;

    creator.built = true;
    creatorRoot.replaceChildren();

    /* 1. Species strip */
    const picker = mcEl("div", "mc-picker");

    const left = mcEl("button", "mc-arrow", "‹");
    left.type = "button";
    left.setAttribute("aria-label", "Previous Species");

    const right = mcEl("button", "mc-arrow", "›");
    right.type = "button";
    right.setAttribute("aria-label", "Next Species");

    const strip = mcEl("div", "mc-strip");
    strip.id = "mc-strip";

    SPECIES_ORDER.forEach((id, index) => {
        const species = MonsterData.SPECIES[id];

        const card = mcEl("button", "mc-species");
        card.type = "button";
        card.dataset.species = id;
        card.style.setProperty("--species-color", species.color);

        const art = mcEl("span", "mc-species-art");
        art.appendChild(createMonsterIcon(id));

        // Hover: the fixed dice loadout.
        const pop = mcEl("span", "mc-species-pop");
        pop.append(
            mcEl("strong", "", `${species.name} · fixed dice`),
            createDiceRow(species)
        );

        card.append(art, mcEl("span", "mc-species-name", species.name), pop);

        card.addEventListener("click", () => selectSpecies(index));

        strip.appendChild(card);
    });

    left.addEventListener("click", () => stepSpecies(-1));
    right.addEventListener("click", () => stepSpecies(1));

    picker.append(left, strip, right);

    /* 2. Species detail */
    const detail = mcEl("div", "mc-detail");
    detail.id = "mc-detail";

    /* 3. Form: name + grid size */
    const form = mcEl("div", "mc-form");

    const nameLabel = mcEl("label", "mc-label", "MONSTER NAME");
    nameLabel.htmlFor = "mc-name";

    const nameInput = mcEl("input", "mc-name");
    nameInput.id = "mc-name";
    nameInput.type = "text";
    nameInput.maxLength = 24;
    nameInput.placeholder = "Name your Monster";
    nameInput.autocomplete = "off";

    nameInput.addEventListener("input", () => {
        creator.name = nameInput.value;
        updateCreatorCard();
    });

    const sizeLabel = mcEl("p", "mc-label", "HP GRID");
    const sizes = mcEl("div", "mc-sizes");
    sizes.id = "mc-sizes";

    MonsterData.GRID_SIZES.forEach(size => {
        const button = mcEl("button", "mc-size");
        button.type = "button";
        button.dataset.size = String(size);
        button.setAttribute("aria-label", `${size} by ${size} grid`);

        const mini = mcEl("span", "mc-size-mini");
        // A tiny picture of the grid (never more than 6x6 dots).
        const dots = Math.min(size, 6);
        mini.style.gridTemplateColumns = `repeat(${dots}, 1fr)`;

        for (let i = 0; i < dots * dots; i++) mini.appendChild(mcEl("i"));

        button.append(mini, mcEl("strong", "", `${size}×${size}`));

        button.addEventListener("click", () => {
            creator.size = size;
            updateCreatorCard();
        });

        sizes.appendChild(button);
    });

    form.append(nameLabel, nameInput, sizeLabel, sizes);

    /* 4. The Monster card: drag it onto the Bench */
    const stage = mcEl("div", "mc-stage");

    const card = mcEl("div", "mc-card");
    card.id = "mc-card";
    card.setAttribute("aria-label", "Monster card. Drag it onto the Bench.");

    const cardArt = mcEl("div", "mc-card-art");
    const cardName = mcEl("strong", "mc-card-name");
    const cardMeta = mcEl("span", "mc-card-meta");
    const cardGrid = mcEl("div", "mc-card-grid");

    card.append(cardArt, cardName, cardMeta, cardGrid);

    const dragHint = mcEl("p", "mc-drag-hint", "Drag this card onto the Bench");

    const addButton = mcEl("button", "primary-button mc-add", "ADD TO BENCH");
    addButton.type = "button";
    addButton.addEventListener("click", addCreatedMonster);

    stage.append(card, dragHint, addButton);

    attachCardDrag(card);

    /* 5. The Bench */
    const bench = mcEl("div", "mc-bench");
    bench.id = "mc-bench";

    /* 6. Paint panel */
    const paint = mcEl("div", "mc-paint");
    paint.id = "mc-paint";

    /* 7. Start / End */
    const controls = mcEl("div", "mc-controls");

    const start = mcEl("button", "primary-button", "START ENCOUNTER");
    start.type = "button";
    start.id = "start-encounter-button";
    start.addEventListener("click", () => socket.emit("start-encounter"));

    const end = mcEl("button", "primary-button", "END ENCOUNTER");
    end.type = "button";
    end.id = "end-encounter-button";
    end.addEventListener("click", () => socket.emit("end-encounter"));

    controls.append(start, end);

    const top = mcEl("div", "mc-top");
    top.append(picker, detail);

    const middle = mcEl("div", "mc-middle");
    middle.append(form, stage);

    creatorRoot.append(top, middle, bench, paint, controls);

    renderCreatorSpecies();
}

function stepSpecies(direction) {
    // Past the last Species the strip loops back to the first, and the other way.
    creator.speciesIndex =
        (creator.speciesIndex + direction + SPECIES_ORDER.length) % SPECIES_ORDER.length;

    renderCreatorSpecies(true);
}

function selectSpecies(index) {
    creator.speciesIndex = index;
    renderCreatorSpecies(true);
}

function renderCreatorSpecies(scroll = false) {
    const species = currentSpecies();

    creatorRoot.querySelectorAll(".mc-species").forEach(card => {
        const selected = card.dataset.species === species.id;

        card.classList.toggle("is-selected", selected);
        card.setAttribute("aria-pressed", String(selected));

        if (selected && scroll) {
            card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
        }
    });

    const detail = document.getElementById("mc-detail");

    detail.style.setProperty("--species-color", species.color);
    detail.replaceChildren(
        mcEl("h3", "mc-detail-name", species.name),
        mcEl("p", "mc-detail-identity", species.identity),
        mcEl("p", "mc-detail-label", `PASSIVE · ${species.passive.name.toUpperCase()}`),
        mcEl("p", "mc-detail-text", species.passive.text),
        mcEl("p", "mc-detail-label", "FIXED DICE"),
        createDiceRow(species),
        mcEl("p", "mc-detail-label", `ULTIMATE · ${species.ultimate.name.toUpperCase()}`),
        mcEl("p", "mc-detail-text", species.ultimate.text)
    );

    updateCreatorCard();
}

// The card follows the name, Species and grid as they change.
function updateCreatorCard() {
    const species = currentSpecies();
    const card = document.getElementById("mc-card");

    if (!card) return;

    card.dataset.species = species.id;
    card.style.setProperty("--species-color", species.color);

    card.querySelector(".mc-card-art").replaceChildren(createMonsterIcon(species.id));
    card.querySelector(".mc-card-name").textContent =
        creator.name.trim() || "Unnamed Monster";
    card.querySelector(".mc-card-meta").textContent =
        `${species.name} · ${creator.size}×${creator.size}`;

    const grid = card.querySelector(".mc-card-grid");
    const dots = Math.min(creator.size, 9);

    grid.style.gridTemplateColumns = `repeat(${dots}, 1fr)`;
    grid.replaceChildren(
        ...Array.from({ length: dots * dots }, () => mcEl("i"))
    );

    document.querySelectorAll("#mc-sizes .mc-size").forEach(button => {
        const selected = Number(button.dataset.size) === creator.size;

        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });

    const input = document.getElementById("mc-name");

    if (input && input.value !== creator.name) input.value = creator.name;
}

function creatorLocked() {
    return Boolean(currentEncounter?.active);
}

function benchIsFull() {
    return getEncounterMonsters().length >= MonsterData.MAX_MONSTERS;
}

function addCreatedMonster() {
    if (creatorLocked()) {
        monsterEncounterMessage.textContent =
            "End the current encounter before changing the Bench.";
        return;
    }

    if (benchIsFull()) {
        monsterEncounterMessage.textContent =
            `The Bench is full (${MonsterData.MAX_MONSTERS} Monsters). Remove one first.`;
        return;
    }

    const name = creator.name.trim();

    if (!name) {
        monsterEncounterMessage.textContent = "Give your Monster a name first.";

        const input = document.getElementById("mc-name");
        input?.focus();
        input?.classList.remove("is-shaking");
        void input?.offsetWidth;
        input?.classList.add("is-shaking");

        return;
    }

    socket.emit("monster-add", {
        species: currentSpecies().id,
        name,
        size: creator.size
    });

    monsterEncounterMessage.textContent = "Adding to the Bench...";
}

socket.on("monster-added", result => {
    monsterEncounterMessage.textContent = result.message;

    creator.selectedBenchID = result.monsterID;
    creator.name = "";

    updateCreatorCard();
});

socket.on("encounter-error", message => {
    monsterEncounterMessage.textContent = message;
});


/* ---------- Dragging the card onto the Bench ---------- */

// Pointer-based, so it works with a mouse, a pen and a finger.
function attachCardDrag(card) {
    card.style.touchAction = "none";

    card.addEventListener("pointerdown", event => {
        if (event.button !== undefined && event.button !== 0) return;

        creator.drag = {
            pointerID: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            ghost: null
        };

        card.setPointerCapture?.(event.pointerId);
    });

    card.addEventListener("pointermove", event => {
        const drag = creator.drag;

        if (!drag || drag.pointerID !== event.pointerId) return;

        if (!drag.ghost) {
            const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);

            if (moved < 6) return;

            drag.ghost = card.cloneNode(true);
            drag.ghost.removeAttribute("id");
            drag.ghost.classList.add("mc-ghost");

            const rect = card.getBoundingClientRect();
            drag.ghost.style.width = `${rect.width}px`;
            drag.offsetX = drag.startX - rect.left;
            drag.offsetY = drag.startY - rect.top;

            document.body.appendChild(drag.ghost);
            card.classList.add("is-dragging");
            document.getElementById("mc-bench")?.classList.add("is-ready");
        }

        drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
        drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;

        const over = isOverBench(event.clientX, event.clientY);
        document.getElementById("mc-bench")?.classList.toggle("is-over", over);
    });

    const finish = (event, cancelled) => {
        const drag = creator.drag;

        if (!drag || drag.pointerID !== event.pointerId) return;

        creator.drag = null;

        card.releasePointerCapture?.(event.pointerId);
        card.classList.remove("is-dragging");

        const bench = document.getElementById("mc-bench");
        bench?.classList.remove("is-ready", "is-over");

        if (!drag.ghost) return;

        const dropped = !cancelled && isOverBench(event.clientX, event.clientY);

        drag.ghost.remove();

        if (dropped) addCreatedMonster();
    };

    card.addEventListener("pointerup", event => finish(event, false));
    card.addEventListener("pointercancel", event => finish(event, true));
}

function isOverBench(x, y) {
    const bench = document.getElementById("mc-bench");

    if (!bench) return false;

    const rect = bench.getBoundingClientRect();

    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}


/* ---------- The Bench and its paint panel ---------- */

function renderBench() {
    const bench = document.getElementById("mc-bench");

    if (!bench) return;

    const monsters = getEncounterMonsters();
    const locked = creatorLocked();

    bench.replaceChildren(
        mcEl(
            "p",
            "mc-bench-title",
            `BENCH · ${monsters.length} / ${MonsterData.MAX_MONSTERS}`
        )
    );

    const row = mcEl("div", "mc-bench-row");

    for (let i = 0; i < MonsterData.MAX_MONSTERS; i++) {
        const monster = monsters[i];

        if (!monster) {
            const empty = mcEl("div", "mc-slot is-empty");
            empty.appendChild(mcEl("span", "", "Empty"));
            row.appendChild(empty);
            continue;
        }

        const species = MonsterData.SPECIES[monster.species];

        const slot = mcEl("div", "mc-slot");
        slot.dataset.species = monster.species;
        slot.style.setProperty("--species-color", species.color);
        slot.classList.toggle("is-selected", creator.selectedBenchID === monster.id);
        slot.classList.toggle("is-dead", Boolean(monster.dead));

        const select = mcEl("button", "mc-slot-body");
        select.type = "button";
        select.title = "Click to edit its HP grid";

        const art = mcEl("span", "mc-slot-art");
        art.appendChild(createMonsterIcon(monster.species));

        select.append(
            art,
            mcEl("strong", "mc-slot-name", monster.name),
            mcEl("span", "mc-slot-meta", `${species.name} · ${monster.size}×${monster.size}`)
        );

        select.addEventListener("click", () => {
            creator.selectedBenchID = monster.id;
            renderBench();
            renderPaintPanel();
        });

        slot.appendChild(select);

        if (!locked) {
            const remove = mcEl("button", "mc-slot-remove", "✕");
            remove.type = "button";
            remove.setAttribute("aria-label", `Remove ${monster.name} from the Bench`);
            remove.addEventListener("click", () => {
                if (creator.selectedBenchID === monster.id) creator.selectedBenchID = null;

                socket.emit("monster-remove", { monsterID: monster.id });
            });

            slot.appendChild(remove);
        }

        row.appendChild(slot);
    }

    bench.appendChild(row);
}

const PAINT_ORDER = ["hp", "armor", "overheal", "armor-overheal"];

function renderPaintPanel() {
    const panel = document.getElementById("mc-paint");

    if (!panel) return;

    const monsters = getEncounterMonsters();

    if (!monsters.some(monster => monster.id === creator.selectedBenchID)) {
        creator.selectedBenchID = monsters[monsters.length - 1]?.id || null;
    }

    const monster = getMonsterByID(creator.selectedBenchID);

    panel.hidden = !monster;

    if (!monster) {
        panel.replaceChildren();
        return;
    }

    const editable = !creatorLocked();

    const heading = mcEl("div", "mc-paint-head");
    heading.append(
        mcEl("strong", "", `${monster.name} · HP GRID`),
        mcEl(
            "span",
            "mc-paint-hint",
            editable
                ? "Click a cell to cycle it: HP, Armor, Overheal, Armor over Overheal."
                : "The encounter is running. Hover the portraits to see the live grids."
        )
    );

    const grid = mcEl("div", "heart-grid mc-paint-grid");
    grid.classList.toggle("is-editable", editable);

    renderGrid(grid, monster.grid, monster.size, {
        curses: new Set(monster.curses || []),
        fxKey: `bench-${monster.id}`,
        interactive: editable,
        onClick: index => {
            const current = PAINT_ORDER.indexOf(monster.grid[index]);
            const next = PAINT_ORDER[(current + 1) % PAINT_ORDER.length];

            socket.emit("edit-monster-cell", {
                monsterID: monster.id,
                index,
                state: next
            });
        }
    });

    panel.replaceChildren(heading, grid);
}

function renderHostCreator() {
    if (!creatorRoot) return;

    buildCreator();

    const locked = creatorLocked();
    const full = benchIsFull();
    const monsters = getEncounterMonsters();

    creatorRoot.classList.toggle("is-locked", locked);

    const add = creatorRoot.querySelector(".mc-add");

    if (add) add.disabled = locked || full;

    creatorRoot.querySelector(".mc-stage")?.classList.toggle("is-full", full);

    const dragHint = creatorRoot.querySelector(".mc-drag-hint");

    if (dragHint) {
        dragHint.textContent = locked
            ? "An encounter is running"
            : full
                ? "The Bench is full"
                : "Drag this card onto the Bench";
    }

    const start = document.getElementById("start-encounter-button");
    const end = document.getElementById("end-encounter-button");

    if (start) start.disabled = locked || monsters.length === 0;

    // Once the fight is on, End Encounter stays right beside Start.
    if (end) end.disabled = !locked;

    renderBench();
    renderPaintPanel();
}


/* =====================================
   INITIALIZE
===================================== */

renderHostCreator();
