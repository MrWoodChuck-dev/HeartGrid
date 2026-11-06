/* =====================================
   CARDS  (server side)
===================================== */

/*
    Everything that belongs to a card lives in this file:

        - which cards each class can make, their position limits and costs
        - the socket handler that plays each card
        - the timers / charges those cards leave behind

    server.js only keeps the core game (rooms, turns, grids, the monster).
    It hands this file the helpers it needs through init().

    TO ADD A NEW CARD
        1. Add it to CARD_DEFS (pattern / min / max / cost).
        2. Add its name to the class in CLASS_CARD_TYPES.
        3. Write its handler in registerSocketHandlers().
        4. Add the matching entry in public/cards.js (the client half).

    Card state that has to be wiped between encounters lives on the player
    (see createPlayerCardState) or on the room (room.hex, room.shield) and is
    cleared by resetCardState().
*/

/* =====================================
   CONSTANTS
===================================== */

// Rage: every HP / Overheal position sacrificed grants this much Energy.
const RAGE_ENERGY_PER_POSITION = 2;

// Armor: every Armor cell destroyed by a direct attack costs the attacker this much.
const ARMOR_ENERGY_PENALTY = 0.5;

// Hex: flat discount on Attack / Blast, which can never push a card below this.
const HEX_DISCOUNT = 1;
const HEX_MIN_COST = 0.5;
const HEX_AFFECTED_CARDS = ["attack", "blast"];

// Rest: extra Energy per Rest turn (on top of the Tank's natural +1) and
// how many cells it heals each Rest turn.
const REST_EXTRA_ENERGY = 2;
const REST_HEAL_PER_TURN = 1;

// Shield: Shield Break length, keyed by the Shield's duration.
const SHIELD_BREAK_TURNS = { 2: 4, 3: 5 };

// Spellvamp: charges needed for one healing conversion.
const SPELLVAMP_CHARGES_PER_HEAL = 3;

/*
    Which cards each class can make. The order is the order they appear in
    the card-type dropdown.
*/
const CLASS_CARD_TYPES = {
    Tank: ["attack", "taunt", "retaliate", "rest"],
    Warrior: ["attack", "rage", "counter", "execute"],
    Mage: ["blast", "spellvamp", "curse", "hex"],
    Support: ["heal", "buff", "weaken", "shield"],
    Thief: ["attack", "status", "lifesteal", "penetrate"]
};

/*
    pattern: the card needs the 3x3 pattern editor.
    min/max: allowed position counts (the Energy cap is 9, so a card that
             could cost more than 9 can never be played).
    cost:    Energy cost for a given position count.
*/
const CARD_DEFS = {
    attack: { pattern: true, cost: n => n },
    heal: { pattern: true, cost: n => n },
    buff: { pattern: false, cost: n => n },
    rage: { pattern: true, cost: () => 0 },
    taunt: { pattern: false, cost: n => n },
    retaliate: { pattern: true, cost: n => n },

    counter: { pattern: false, min: 2, max: 6, cost: n => n * 1.5 },
    curse: { pattern: true, min: 2, max: 6, cost: n => n * 1.5 },
    weaken: { pattern: false, min: 2, max: 6, cost: n => n * 1.5 },

    // Warrior
    execute: { pattern: false, min: 2, max: 6, cost: n => n * 1.5 },

    // Tank
    rest: { pattern: false, min: 4, max: 7, cost: () => 0 },

    // Support
    shield: { pattern: false, min: 2, max: 3, cost: n => n * 2.5 },

    // Mage
    blast: { pattern: true, min: 2, max: 6, cost: n => n * 1.5 },
    spellvamp: { pattern: true, min: 2, max: 6, cost: n => n * 1.5 },
    hex: { pattern: false, min: 2, max: 6, cost: n => n * 1.5 },

    // Thief
    status: { pattern: false, cost: n => n },
    lifesteal: { pattern: false, min: 2, max: 6, cost: n => n * 1.5 },
    penetrate: { pattern: false, min: 2, max: 6, cost: n => n }
};

const ATTACK_CLASSES = ["Tank", "Warrior", "Thief"];
const HEALING_CLASSES = ["Support"];

const CARD_TYPES = Object.keys(CARD_DEFS);

function cardUsesPattern(type) {
    return Boolean(CARD_DEFS[type]?.pattern);
}

function isCardCountAllowed(type, count) {
    const def = CARD_DEFS[type];

    if (!def) return false;
    if (def.min !== undefined && count < def.min) return false;
    if (def.max !== undefined && count > def.max) return false;

    return true;
}

// Can this class make ANY card out of an assignment of this size?
function classCanUseCount(className, count) {
    return (CLASS_CARD_TYPES[className] || []).some(
        type => isCardCountAllowed(type, count)
    );
}

// The Energy cost of a card right now (includes the Hex discount).
function getCardCost(card, room = null) {
    const def = CARD_DEFS[card.type];

    let cost = def ? def.cost(card.targetCount) : card.targetCount;

    if (
        HEX_AFFECTED_CARDS.includes(card.type) &&
        (room?.hex?.remaining || 0) > 0
    ) {
        cost = Math.max(HEX_MIN_COST, cost - HEX_DISCOUNT);
    }

    return cost;
}


/* =====================================
   MONSTER ARMOR
===================================== */

/*
    Armor sits on top of an ordinary monster HP cell. Grid cell states:

        hp              healthy
        overheal        healthy + Overheal
        armor           Armor over a normal HP cell
        armor-overheal  Armor over an Overheal cell
        empty           no HP

    Breaking Armor leaves the cell below it: empty for plain Armor, and the
    original Overheal for Armor-over-Overheal.
*/
const ARMOR_BREAKS_TO = {
    armor: "empty",
    "armor-overheal": "overheal"
};

function isArmorCell(cell) {
    return Object.prototype.hasOwnProperty.call(ARMOR_BREAKS_TO, cell);
}


/* =====================================
   PLAYER CARD STATE
===================================== */

function createPlayerCardState() {
    return {
        // Charges are spent by the Thief's Attack hits (and by Spellvamp conversions).
        charges: {
            lifesteal: 0,
            status: 0,
            penetrate: 0,
            spellvamp: 0
        },
        // Rest turns left. While above 0 the player sleeps through their turns.
        rest: 0,
        // Turns (monster turns) left before this player can be Shielded again.
        shieldBreak: 0
    };
}

function resetPlayerCardState(player) {
    Object.assign(player, createPlayerCardState());
}


/* =====================================
   INIT  (helpers handed over by server.js)
===================================== */

let ctx = null;

function init(context) {
    ctx = context;
}

function resetCardState(room) {
    room.hex = null;
    room.shield = null;

    for (const player of room.players.values()) {
        resetPlayerCardState(player);
    }
}


/* =====================================
   SMALL HELPERS
===================================== */

function pickRandom(list) {
    if (list.length === 0) return null;

    return list[ctx.randomInt(0, list.length)];
}

// Energy gain that respects the cap the same way natural regeneration does.
function addEnergy(player, amount) {
    if (player.energy < ctx.MAX_ENERGY) {
        player.energy = Math.min(ctx.MAX_ENERGY, player.energy + amount);
    }
}

function findCard(socket, player, cardID, type, label) {
    const card = player.cards.find(item => item.id === cardID);

    if (!card || card.type !== type) {
        socket.emit("combat-action-error", `Invalid ${label} card.`);
        return null;
    }

    return card;
}

// Returns false (and tells the player) when they can't afford the card.
function canAfford(socket, player, cost, label) {
    if (player.energy >= cost) return true;

    socket.emit(
        "combat-action-error",
        `Not enough Energy. ${label} costs ${cost}.`
    );

    return false;
}

function isShielded(room, player) {
    return Boolean(room.shield && room.shield.targetID === player.id);
}

/*
    The Tank's Taunt waits while the Tank is resting or Shielded: its
    charges are kept but the monster is not forced to obey them.
*/
function isTauntPaused(room, tank) {
    return Boolean(tank && (tank.rest > 0 || isShielded(room, tank)));
}

// Heals one cell: an empty cell first, otherwise Overheal on a healthy one.
function healOneCell(player, { allowOverheal }) {
    const empties = player.grid
        .map((cell, index) => cell === "empty" ? index : -1)
        .filter(index => index !== -1);

    const emptyPick = pickRandom(empties);

    if (emptyPick !== null) {
        player.grid[emptyPick] = "hp";
        return { index: emptyPick, kind: "hp" };
    }

    if (!allowOverheal) return null;

    // Retaliate-marked HP can't be Overhealed.
    const plain = player.grid
        .map((cell, index) =>
            cell === "hp" && !player.marks?.has(index) ? index : -1
        )
        .filter(index => index !== -1);

    const plainPick = pickRandom(plain);

    if (plainPick === null) return null;

    player.grid[plainPick] = "overheal";
    return { index: plainPick, kind: "overheal" };
}

// The Thief's own empty cells, for Lifesteal.
function getEmptyIndices(player) {
    return player.grid
        .map((cell, index) => cell === "empty" ? index : -1)
        .filter(index => index !== -1);
}

function neighbours(index, size) {
    const row = Math.floor(index / size);
    const column = index % size;

    return [[-1, 0], [1, 0], [0, -1], [0, 1]]
        .map(([dRow, dColumn]) => [row + dRow, column + dColumn])
        .filter(([r, c]) => r >= 0 && r < size && c >= 0 && c < size)
        .map(([r, c]) => r * size + c);
}


/* =====================================
   GRID ATTACKS  (Attack, Blast)
===================================== */

/*
    Shared by every card that attacks the monster's grid.

    ARMOR
      A directly attacked Armor cell is destroyed, but costs the attacker an
      extra ARMOR_ENERGY_PENALTY each. Armor never feeds Lifesteal.

    THIEF CHARGES (only the Thief ever has any)
      Each successful hit (a cell that lost HP or Overheal) can spend:
        Lifesteal  1 charge -> heal one of the Thief's empty cells
        Status     1 charge -> 1-2 more damage to random healthy / Overheal cells
      Penetrate charges deal with Armor, in this priority:
        1. a directly attacked Armor cell: no Energy penalty, and it can feed
           Lifesteal (this is "Lifesteal through Armor")
        2. Armor next to a cell that was hit (up, down, left, right): removed
*/
function resolveGridAttack(room, player, positions, source) {
    const encounter = room.encounter;
    const size = encounter.size;

    const isThief = player.className === "Thief";
    const charges = player.charges;

    // --- The attack itself ---
    const hit = ctx.damageMonsterCells(room, positions, source, {
        gridBased: true
    });

    // --- Penetrate: pierce directly attacked Armor ---
    let pierced = 0;

    if (isThief) {
        pierced = Math.min(hit.armorBroken.length, charges.penetrate);
        charges.penetrate -= pierced;
    }

    const armorPenalty =
        (hit.armorBroken.length - pierced) * ARMOR_ENERGY_PENALTY;

    // --- Lifesteal: pierced Armor goes first, then ordinary hits ---
    const healedPositions = [];

    if (isThief) {
        const empties = getEmptyIndices(player);
        const lifestealHits = pierced + hit.directHits.length;

        for (let i = 0; i < lifestealHits; i++) {
            if (charges.lifesteal <= 0 || empties.length === 0) break;

            const pick = empties.splice(
                ctx.randomInt(0, empties.length),
                1
            )[0];

            player.grid[pick] = "hp";
            healedPositions.push(pick);
            charges.lifesteal--;
        }
    }

    // --- Penetrate: Armor connected to a cell that was hit ---
    let connectedArmor = [];

    if (isThief && charges.penetrate > 0 && hit.directHits.length > 0) {
        const candidates = [];

        hit.directHits.forEach(index => {
            neighbours(index, size).forEach(next => {
                if (
                    isArmorCell(encounter.grid[next]) &&
                    !candidates.includes(next)
                ) {
                    candidates.push(next);
                }
            });
        });

        const chosen = candidates.slice(0, charges.penetrate);

        if (chosen.length > 0) {
            // Removing connected Armor deals no damage: the cell underneath stays.
            connectedArmor = ctx.stripMonsterDefenses(room, chosen, "penetrate")
                .map(change => change.index);
            charges.penetrate -= connectedArmor.length;
        }
    }

    // --- Status: every successful hit can fire one charge ---
    let statusCharges = 0;
    let statusHit = { damage: 0, overhealDamage: 0, exploded: [] };
    let statusPositions = [];

    if (isThief && charges.status > 0 && hit.directHits.length > 0) {
        const eligible = new Set(
            ctx.getStatusTargetPositions(encounter)
        );

        for (let i = 0; i < hit.directHits.length; i++) {
            if (charges.status <= 0 || eligible.size === 0) break;

            charges.status--;
            statusCharges++;

            // A charge deals a random 1 or 2 damage.
            const wanted = ctx.randomInt(1, 3);
            const pool = ctx.shuffle([...eligible]).slice(0, wanted);

            pool.forEach(index => {
                eligible.delete(index);
                statusPositions.push(index);
            });
        }

        if (statusPositions.length > 0) {
            statusHit = ctx.damageMonsterCells(room, statusPositions, "status");
        }
    }

    return {
        hit,
        armorPenalty,
        piercedArmor: pierced,
        healedPositions,
        connectedArmor,
        statusCharges,
        statusPositions,
        statusHit
    };
}

// The numbers every attack result carries to the clients.
function describeAttackResult(room, player, card, cost, outcome) {
    const { hit } = outcome;

    return {
        playerID: player.id,
        username: player.username,
        cardName: card.name,
        cardType: card.type,
        positions: hit.directPositions,
        damage: hit.damage,
        overhealDamage: hit.overhealDamage,
        armorDestroyed: hit.armorBroken.length,
        exploded: hit.exploded.length,

        // Thief extras
        piercedArmor: outcome.piercedArmor,
        connectedArmor: outcome.connectedArmor.length,
        healPositions: outcome.healedPositions,
        healed: outcome.healedPositions.length,
        statusCharges: outcome.statusCharges,
        statusDamage:
            outcome.statusHit.damage + outcome.statusHit.overhealDamage,

        // Private: the Host's copy has these removed.
        energyPenalty: outcome.armorPenalty,
        energySpent: cost + outcome.armorPenalty,
        remainingEnergy: player.energy
    };
}


/* =====================================
   TURN HOOKS  (called by server.js)
===================================== */

/*
    The monster's turn has just ended. Hex, Shield and Shield Break all count
    down in monster turns, so a Shield of 2 stops exactly two monster turns.
*/
function tickMonsterTurnEffects(room) {
    for (const player of room.players.values()) {
        if (player.shieldBreak > 0) player.shieldBreak--;
    }

    if (room.hex) {
        room.hex.remaining--;

        if (room.hex.remaining <= 0) {
            room.hex = null;

            ctx.io.to(room.roomID).emit("hex-expired");
        }
    }

    if (room.shield) {
        room.shield.remaining--;

        if (room.shield.remaining <= 0) {
            const { targetID, total } = room.shield;
            const target = room.players.get(targetID);

            room.shield = null;

            const breakTurns = SHIELD_BREAK_TURNS[total] || 4;

            if (target) target.shieldBreak = breakTurns;

            ctx.io.to(room.roomID).emit("shield-expired", {
                targetID,
                targetUsername: target?.username || "",
                breakTurns
            });
        }
    }
}

/*
    A resting player's turn has started (natural regeneration is already
    applied). They get bonus Energy and a heal, then the turn is skipped.
*/
function processRestTurn(room, player) {
    addEnergy(player, REST_EXTRA_ENERGY);

    const healedPositions = [];
    const overhealedPositions = [];

    for (let i = 0; i < REST_HEAL_PER_TURN; i++) {
        const healed = healOneCell(player, { allowOverheal: true });

        if (!healed) break;

        (healed.kind === "hp" ? healedPositions : overhealedPositions)
            .push(healed.index);
    }

    player.rest = Math.max(0, player.rest - 1);

    ctx.io.to(room.roomID).emit("player-rest-tick", {
        playerID: player.id,
        username: player.username,
        healedPositions,
        overhealedPositions,
        turnsLeft: player.rest,
        expired: player.rest <= 0
    });
}


/* =====================================
   SOCKET HANDLERS
===================================== */

function registerSocketHandlers(socket) {
    const { rooms, io } = ctx;

    /* ---------- Attack  (Tank, Warrior, Thief) ---------- */

    socket.on("player-attack", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(socket, room, null, null, true);

        if (!player) return;

        if (!ATTACK_CLASSES.includes(player.className)) {
            socket.emit(
                "combat-action-error",
                "Your class cannot use Attack cards."
            );

            return;
        }

        const encounter = room.encounter;
        const card = findCard(socket, player, data?.cardID, "attack", "Attack");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Attack")) return;

        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit("combat-action-error", "That pattern does not fit there.");
            return;
        }

        const outcome = resolveGridAttack(room, player, positions, "attack");

        player.energy -= cost + outcome.armorPenalty;

        const result = describeAttackResult(room, player, card, cost, outcome);

        ctx.emitToPlayersAndHost(room, "player-attack-resolved", result);

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} attacked ${encounter.name} with ${card.name}. ` +
            `Damage: ${result.damage}, Armor broken: ${result.armorDestroyed}`
        );
    });

    /* ---------- Blast  (Mage) ---------- */

    /*
        Blast is built to hit up to TWO different monsters at once. A fight
        only has one monster at the moment, so it lands on that monster once
        (it can never hit the same monster twice for double damage). When
        multi-monster encounters arrive, this is the handler to extend.
    */
    socket.on("player-blast", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Mage",
            "Only Mage can use Blast cards."
        );

        if (!player) return;

        const encounter = room.encounter;
        const card = findCard(socket, player, data?.cardID, "blast", "Blast");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Blast")) return;

        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit("combat-action-error", "That pattern does not fit there.");
            return;
        }

        const outcome = resolveGridAttack(room, player, positions, "blast");

        player.energy -= cost + outcome.armorPenalty;

        const result = describeAttackResult(room, player, card, cost, outcome);

        ctx.emitToPlayersAndHost(room, "player-blast-resolved", result);

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} blasted ${encounter.name} with ${card.name}. ` +
            `Damage: ${result.damage}`
        );
    });

    /* ---------- Spellvamp  (Mage) ---------- */

    socket.on("player-spellvamp", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Mage",
            "Only Mage can use Spellvamp cards."
        );

        if (!player) return;

        const encounter = room.encounter;
        const card = findCard(socket, player, data?.cardID, "spellvamp", "Spellvamp");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Spellvamp")) return;

        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit("combat-action-error", "That pattern does not fit there.");
            return;
        }

        // Spellvamp only touches Armor and Overheal.
        const targets = positions.filter(position => {
            const cell = encounter.grid[position];

            return isArmorCell(cell) || cell === "overheal";
        });

        if (targets.length === 0) {
            socket.emit(
                "combat-action-error",
                "There is nothing to hit there. Spellvamp only targets Armor and Overheal."
            );

            return;
        }

        // Charges: 1 per layer removed, so 2 for Armor over Overheal. Read
        // before anything changes.
        let gained = 0;

        targets.forEach(position => {
            gained += encounter.grid[position] === "armor-overheal" ? 2 : 1;
        });

        // Spellvamp deals NO damage. It only strips Armor and Overheal, and
        // whatever is under them stays: Armor + Overheal -> plain HP, Armor
        // alone -> the HP underneath, Overheal alone -> plain HP.
        const stripped = ctx.stripMonsterDefenses(room, targets, "spellvamp", {
            stripOverheal: true
        });

        const armorRemoved = stripped.filter(change => isArmorCell(change.before)).length;
        const armorPenalty = armorRemoved * ARMOR_ENERGY_PENALTY;

        player.energy -= cost + armorPenalty;
        player.charges.spellvamp += gained;

        // Every full set of charges becomes one heal.
        const healedPositions = [];
        const overhealedPositions = [];

        while (player.charges.spellvamp >= SPELLVAMP_CHARGES_PER_HEAL) {
            const healed = healOneCell(player, { allowOverheal: true });

            // Nothing left to heal or Overheal: keep the charges.
            if (!healed) break;

            player.charges.spellvamp -= SPELLVAMP_CHARGES_PER_HEAL;

            (healed.kind === "hp" ? healedPositions : overhealedPositions)
                .push(healed.index);
        }

        ctx.emitToPlayersAndHost(room, "player-spellvamp-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions: stripped.map(change => change.index),
            armorDestroyed: armorRemoved,
            overhealStripped: stripped.filter(change => change.before === "overheal").length,
            chargesGained: gained,
            charges: player.charges.spellvamp,
            healedPositions,
            overhealedPositions,
            energyPenalty: armorPenalty,
            energySpent: cost + armorPenalty,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} used Spellvamp. Hits: ${targets.length}, ` +
            `charges gained: ${gained}, healed: ${healedPositions.length + overhealedPositions.length}`
        );
    });

    /* ---------- Execute  (Warrior) ---------- */

    socket.on("player-execute", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Warrior",
            "Only Warrior can use Execute cards."
        );

        if (!player) return;

        const encounter = room.encounter;
        const card = findCard(socket, player, data?.cardID, "execute", "Execute");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Execute")) return;

        // Healthy cells only. Armor and Overheal are never picked.
        const healthy = ctx.getHealthyMonsterPositions(encounter);

        if (healthy.length === 0) {
            socket.emit(
                "combat-action-error",
                "There are no healthy monster positions left to execute."
            );

            return;
        }

        const targets = ctx.shuffle(healthy).slice(0, card.targetCount);

        const hit = ctx.damageMonsterCells(room, targets, "execute");

        player.energy -= cost;

        ctx.emitToPlayersAndHost(room, "player-execute-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions: targets,
            damage: hit.damage,
            exploded: hit.exploded.length,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(`${player.username} executed ${hit.damage} position(s).`);
    });

    /* ---------- Rest  (Tank) ---------- */

    socket.on("player-rest", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Tank",
            "Only Tank can use Rest cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "rest", "Rest");

        if (!card) return;

        if (player.rest > 0) {
            socket.emit(
                "combat-action-error",
                "You are already resting. Rest cannot be stacked."
            );

            return;
        }

        player.rest = card.targetCount;

        ctx.emitToPlayersAndHost(room, "player-rest-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            turns: card.targetCount,
            energySpent: 0,
            remainingEnergy: player.energy
        });

        // Resting means doing nothing else: the Tank's turn ends right now.
        ctx.advanceTurn(room);
        ctx.emitTurnState(room.roomID);

        console.log(`${player.username} is resting for ${card.targetCount} turns.`);
    });

    /* ---------- Shield  (Support) ---------- */

    socket.on("player-shield", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Support",
            "Only Support can use Shield cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "shield", "Shield");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Shield")) return;

        if (room.shield) {
            const current = room.players.get(room.shield.targetID);

            socket.emit(
                "combat-action-error",
                `A Shield is already active on ${current?.username || "a player"}. ` +
                "Wait for it to expire."
            );

            return;
        }

        const target = room.players.get(data?.targetPlayerID);

        if (!target) {
            socket.emit("combat-action-error", "That player could not be found.");
            return;
        }

        if (ctx.isDead(target)) {
            socket.emit(
                "combat-action-error",
                `${target.username} is dead and cannot be shielded.`
            );

            return;
        }

        if (target.shieldBreak > 0) {
            socket.emit(
                "combat-action-error",
                `${target.username} has Shield Break for ${target.shieldBreak} more turn(s) ` +
                "and cannot be shielded yet."
            );

            return;
        }

        player.energy -= cost;

        room.shield = {
            supportID: player.id,
            targetID: target.id,
            remaining: card.targetCount,
            total: card.targetCount
        };

        ctx.emitToPlayersAndHost(room, "player-shield-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            turns: card.targetCount,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} shielded ${target.username} for ${card.targetCount} turns.`
        );
    });

    /* ---------- Hex  (Mage) ---------- */

    socket.on("player-hex", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Mage",
            "Only Mage can use Hex cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "hex", "Hex");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Hex")) return;

        player.energy -= cost;

        // Hex does not stack: a second Hex only refreshes it if it lasts longer.
        room.hex = {
            remaining: Math.max(room.hex?.remaining || 0, card.targetCount),
            casterID: player.id
        };

        ctx.emitToPlayersAndHost(room, "player-hex-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            turns: room.hex.remaining,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(`${player.username} cast Hex for ${room.hex.remaining} turns.`);
    });

    /* ---------- Thief charge cards: Status, Lifesteal, Penetrate ---------- */

    const chargeCards = [
        { type: "status", label: "Status", charge: "status" },
        { type: "lifesteal", label: "Lifesteal", charge: "lifesteal" },
        { type: "penetrate", label: "Penetrate", charge: "penetrate" }
    ];

    chargeCards.forEach(({ type, label, charge }) => {
        socket.on(`player-${type}`, data => {
            const room = rooms.get(socket.data.roomID);

            const player = ctx.getActingPlayer(
                socket,
                room,
                "Thief",
                `Only Thief can use ${label} cards.`
            );

            if (!player) return;

            const card = findCard(socket, player, data?.cardID, type, label);

            if (!card) return;

            const cost = getCardCost(card, room);

            if (!canAfford(socket, player, cost, label)) return;

            player.energy -= cost;

            // Each position is one charge. Charges stack.
            player.charges[charge] += card.targetCount;

            ctx.emitToPlayersAndHost(room, `player-${type}-resolved`, {
                playerID: player.id,
                username: player.username,
                cardName: card.name,
                added: card.targetCount,
                charges: player.charges[charge],
                energySpent: cost,
                remainingEnergy: player.energy
            });

            ctx.finishPlayerAction(room, player);
            ctx.emitTurnState(room.roomID);

            console.log(
                `${player.username} used ${label}. Charges: ${player.charges[charge]}`
            );
        });
    });

    /* ---------- Curse  (Mage) ---------- */

    socket.on("player-curse", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Mage",
            "Only Mage can use Curse cards."
        );

        if (!player) return;

        const encounter = room.encounter;
        const card = findCard(socket, player, data?.cardID, "curse", "Curse");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Curse")) return;

        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit("combat-action-error", "That pattern does not fit there.");
            return;
        }

        // Only healthy, not-yet-cursed positions can be marked. Armor and
        // Overheal are never "hp", so they can never be cursed.
        const markable = positions.filter(
            position =>
                encounter.grid[position] === "hp" &&
                !encounter.curses.has(position)
        );

        if (markable.length === 0) {
            socket.emit(
                "combat-action-error",
                "There is nothing to curse there. Aim at healthy, uncursed positions."
            );

            return;
        }

        markable.forEach(position => encounter.curses.add(position));

        player.energy -= cost;

        ctx.emitToPlayersAndHost(room, "player-curse-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions: markable,
            marked: markable.length,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} cursed ${markable.length} positions with ${card.name}`
        );
    });

    /* ---------- Heal  (Support) ---------- */

    socket.on("player-heal", data => {
        const room = rooms.get(socket.data.roomID);

        if (!ctx.isPlayer(socket, room)) return;

        const actor = room.players.get(socket.id);

        if (!HEALING_CLASSES.includes(actor.className)) {
            socket.emit("combat-action-error", "Only Support can use Heal cards.");
            return;
        }

        const player = ctx.getActingPlayer(socket, room);

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "heal", "Heal");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Heal")) return;

        const target = room.players.get(data?.targetPlayerID);

        if (!target) {
            socket.emit("combat-action-error", "That teammate could not be found.");
            return;
        }

        if (ctx.isDead(target)) {
            socket.emit(
                "combat-action-error",
                `${target.username} is dead and cannot be healed. Ask the Host to revive them.`
            );

            return;
        }

        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            target.gridSize
        );

        if (!positions) {
            socket.emit(
                "combat-action-error",
                "That healing pattern does not fit there."
            );

            return;
        }

        let healed = 0;
        let overhealed = 0;
        let unchanged = 0;

        // For the heal animation.
        const healedPositions = [];
        const overhealedPositions = [];

        positions.forEach(position => {
            if (target.grid[position] === "empty") {
                target.grid[position] = "hp";
                healed++;
                healedPositions.push(position);
            } else if (
                target.grid[position] === "hp" &&
                !target.marks?.has(position)
            ) {
                // Retaliate-marked HP can't be Overhealed.
                target.grid[position] = "overheal";
                overhealed++;
                overhealedPositions.push(position);
            } else {
                unchanged++;
            }
        });

        player.energy -= cost;

        ctx.emitToPlayersAndHost(room, "player-heal-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            positions,
            healedPositions,
            overhealedPositions,
            healed,
            overhealed,
            unchanged,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} healed ${target.username} with ${card.name}. ` +
            `HP restored: ${healed}, Overheal added: ${overhealed}`
        );
    });

    /* ---------- Buff  (Support) ---------- */

    socket.on("player-buff", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Support",
            "Only Support can use Buff cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "buff", "Buff");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Buff")) return;

        const target = room.players.get(data?.targetPlayerID);

        if (!target || target.id === player.id) {
            socket.emit(
                "combat-action-error",
                "Choose another teammate to receive Energy."
            );

            return;
        }

        if (ctx.isDead(target)) {
            socket.emit(
                "combat-action-error",
                `${target.username} is dead and cannot receive Energy. Ask the Host to revive them.`
            );

            return;
        }

        // Support pays the cost, the teammate receives the same amount.
        player.energy -= cost;
        target.energy += card.targetCount;

        ctx.emitToPlayersAndHost(room, "player-buff-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            energyTransferred: card.targetCount,
            remainingEnergy: player.energy,
            targetEnergy: target.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} buffed ${target.username} with ${card.name}. ` +
            `Energy transferred: ${card.targetCount}`
        );
    });

    /* ---------- Weaken  (Support) ---------- */

    socket.on("player-weaken", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Support",
            "Only Support can use Weaken cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "weaken", "Weaken");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Weaken")) return;

        player.energy -= cost;

        // Each Weaken point negates one monster attack position on its next roll.
        room.weaken = (room.weaken || 0) + card.targetCount;

        ctx.emitToPlayersAndHost(room, "player-weaken-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            added: card.targetCount,
            weaken: room.weaken,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(`${player.username} used Weaken. Total Weaken: ${room.weaken}`);
    });

    /* ---------- Rage  (Warrior) ---------- */

    socket.on("player-rage", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Warrior",
            "Only Warrior can use Rage cards.",
            false,
            true
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "rage", "Rage");

        if (!card) return;

        // Rage targets the Warrior's own grid.
        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            player.gridSize
        );

        if (!positions) {
            socket.emit(
                "combat-action-error",
                "That Rage pattern does not fit on your grid."
            );

            return;
        }

        // Every selected position must contain HP or Overheal.
        if (positions.some(position => !ctx.isHittable(player.grid[position]))) {
            socket.emit(
                "combat-action-error",
                "Rage can only sacrifice HP or Overheal positions."
            );

            return;
        }

        let healthSacrificed = 0;
        let overhealSacrificed = 0;

        // For the Rage animation.
        const healthPositions = [];
        const overhealPositions = [];

        // HP is lost; Overheal is stripped back down to plain HP.
        positions.forEach(position => {
            if (player.grid[position] === "overheal") {
                player.grid[position] = "hp";
                overhealSacrificed++;
                overhealPositions.push(position);
            } else {
                player.grid[position] = "empty";
                healthSacrificed++;
                healthPositions.push(position);
            }
        });

        // Rage costs no Energy. Each position taken gives Energy.
        const energyGained = positions.length * RAGE_ENERGY_PER_POSITION;

        player.energy += energyGained;

        ctx.emitToPlayersAndHost(room, "player-rage-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions,
            healthPositions,
            overhealPositions,
            healthSacrificed,
            overhealSacrificed,
            energyGained,
            remainingEnergy: player.energy
        });

        // Raging away your last HP is fatal, and the dead do not take turns.
        if (ctx.isDead(player)) {
            ctx.advanceTurn(room);
        }

        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} used Rage. ` +
            `Positions taken: ${positions.length}, Energy gained: ${energyGained}`
        );
    });

    /* ---------- Counter  (Warrior) ---------- */

    socket.on("player-counter", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Warrior",
            "Only Warrior can use Counter cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "counter", "Counter");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Counter")) return;

        player.energy -= cost;

        // Each position is one Counter Turn. Counter stacks.
        player.counterTurns = (player.counterTurns || 0) + card.targetCount;

        ctx.emitToPlayersAndHost(room, "player-counter-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            added: card.targetCount,
            counterTurns: player.counterTurns,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} used Counter. Counter turns: ${player.counterTurns}`
        );
    });

    /* ---------- Taunt  (Tank) ---------- */

    socket.on("player-taunt", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Tank",
            "Only Tank can use Taunt cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "taunt", "Taunt");

        if (!card) return;

        if (ctx.getHittablePositions(player.grid).length === 0) {
            socket.emit(
                "combat-action-error",
                "You need HP remaining to activate Taunt."
            );

            return;
        }

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Taunt")) return;

        player.energy -= cost;

        // Taunt stacks: using it again adds more soaked hits.
        if (room.taunt && room.taunt.tankID === player.id) {
            room.taunt.remainingDamage += card.targetCount;
        } else {
            room.taunt = {
                tankID: player.id,
                tankUsername: player.username,
                remainingDamage: card.targetCount
            };
        }

        ctx.emitToPlayersAndHost(room, "player-taunt-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            tauntedDamage: card.targetCount,
            remainingDamage: room.taunt.remainingDamage,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} activated Taunt. ` +
            `Forced damage remaining: ${room.taunt?.remainingDamage}`
        );
    });

    /* ---------- Retaliate  (Tank) ---------- */

    socket.on("player-retaliate", data => {
        const room = rooms.get(socket.data.roomID);

        const player = ctx.getActingPlayer(
            socket,
            room,
            "Tank",
            "Only Tank can use Retaliate cards."
        );

        if (!player) return;

        const card = findCard(socket, player, data?.cardID, "retaliate", "Retaliate");

        if (!card) return;

        const cost = getCardCost(card, room);

        if (!canAfford(socket, player, cost, "Retaliate")) return;

        // Retaliate marks the Tank's own grid.
        const positions = ctx.calculateCardPositions(
            card,
            data?.anchor,
            player.gridSize
        );

        if (!positions) {
            socket.emit(
                "combat-action-error",
                "That Retaliate pattern does not fit on your grid."
            );

            return;
        }

        // Marks only go on plain HP (never Overheal or empty), once each.
        if (
            positions.some(position =>
                player.grid[position] !== "hp" ||
                player.marks.has(position)
            )
        ) {
            socket.emit(
                "combat-action-error",
                "Retaliate can only mark HP that is not Overheal and not already marked."
            );

            return;
        }

        positions.forEach(position => player.marks.add(position));

        player.energy -= cost;

        // Players see which positions were marked. The Host only sees a count.
        ctx.emitToPlayersAndHost(
            room,
            "player-retaliate-resolved",
            {
                playerID: player.id,
                username: player.username,
                cardName: card.name,
                positions,
                marked: positions.length,
                energySpent: cost,
                remainingEnergy: player.energy
            },
            {
                // The Host's copy: no positions and no Energy figures.
                playerID: player.id,
                username: player.username,
                cardName: card.name,
                marked: positions.length
            }
        );

        ctx.finishPlayerAction(room, player);
        ctx.emitTurnState(room.roomID);

        console.log(
            `${player.username} set ${positions.length} Retaliate marks with ${card.name}`
        );
    });
}


module.exports = {
    // Data
    CLASS_CARD_TYPES,
    CARD_DEFS,
    CARD_TYPES,
    RAGE_ENERGY_PER_POSITION,
    ARMOR_BREAKS_TO,

    // Rules
    cardUsesPattern,
    isCardCountAllowed,
    classCanUseCount,
    getCardCost,
    isArmorCell,
    isShielded,
    isTauntPaused,

    // Player / room state
    createPlayerCardState,
    resetPlayerCardState,
    resetCardState,

    // Turn hooks
    tickMonsterTurnEffects,
    processRestTurn,

    // Wiring
    init,
    registerSocketHandlers
};
