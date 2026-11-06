const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const MAX_CARDS = 4;
const MAX_ENERGY = 9;
const STARTING_ENERGY = 5;

// Every card (definitions, costs, rules and the socket handler that plays it)
// lives in cards-server.js. This file only keeps the core game.
const cards = require("./cards-server");

const ENERGY_REGEN = {
    Tank: 1,
    Warrior: 2,
    Support: 2,
    Thief: 3,
    Mage: 3
};

const CLASSES = ["Tank", "Warrior", "Mage", "Support", "Thief"];

const CLASS_GRID_SIZES = {
    Tank: 6,
    Warrior: 5,
    Support: 4,
    Mage: 3,
    Thief: 3
};

// Monster cells the Host may paint before an encounter starts.
const MONSTER_SETUP_STATES = ["hp", "overheal", "armor", "armor-overheal"];

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

/* =====================================
   BASIC HELPERS
===================================== */

function generateRoomID() {
    return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function createGrid(size) {
    return Array(size * size).fill("hp");
}

function shuffle(array) {
    const result = [...array];

    for (let i = result.length - 1; i > 0; i--) {
        const j = crypto.randomInt(0, i + 1);

        [result[i], result[j]] = [result[j], result[i]];
    }

    return result;
}

function regeneratePlayerEnergy(player) {
    const regen = ENERGY_REGEN[player.className] || 0;

    // Players above the Energy cap keep their extra Energy.
    if (player.energy < MAX_ENERGY) {
        player.energy = Math.min(
            MAX_ENERGY,
            player.energy + regen
        );
    }
}

// Retaliate marks, Energy and the cards a player is holding are all secret
// from the Host, so they are only included when the state is sent to a player.
// Teammates can look at them on the battlefield; the Host cannot.
function getPublicPlayer(player, includeMarks = false, room = null) {
    const publicPlayer = {
        id: player.id,
        username: player.username,
        className: player.className,
        gridSize: player.gridSize,
        grid: [...player.grid],
        cardCount: player.cards.length,
        hasAssignment: Boolean(player.assignment),
        counterTurns: player.counterTurns ?? 0,

        // Card effects are visible to everyone (Retaliate marks are the one secret).
        charges: { ...(player.charges || {}) },
        rest: player.rest || 0,
        shieldBreak: player.shieldBreak || 0,
        shielded: Boolean(room && cards.isShielded(room, player))
    };

    if (includeMarks) {
        // Energy is private too: a Host who can watch it could work out
        // that a Retaliate was played (Energy spent, nothing visible happened).
        publicPlayer.energy = player.energy ?? 0;

        publicPlayer.marks = [...(player.marks || [])];

        publicPlayer.cards = player.cards.map(card => ({
            id: card.id,
            name: card.name,
            type: card.type,
            targetCount: card.targetCount,
            pattern: [...(card.pattern || [])]
        }));
    }

    return publicPlayer;
}

function getPartyState(room, includeMarks = false) {
    return Array.from(room.players.values()).map(
        player => getPublicPlayer(player, includeMarks, room)
    );
}

function getRoomState(roomID) {
    const room = rooms.get(roomID);

    if (!room) return null;

    // This is only sent to the Host, so no marks.
    const players = getPartyState(room, false);
    const takenClasses = players.map(player => player.className);

    return {
        roomID,
        players,
        availableClasses: CLASSES.filter(
            className => !takenClasses.includes(className)
        )
    };
}

/* =====================================
   INITIATIVE HELPERS
===================================== */

function getCurrentTurn(room) {
    // While a Counter turn is running it replaces the normal turn.
    if (room.counterTurn) {
        const base = room.initiativeOrder?.find(
            participant =>
                participant.type === "player" &&
                participant.id === room.counterTurn.playerID
        );

        return base
            ? { ...base, counter: true }
            : null;
    }

    return room.initiativeOrder?.[room.turnIndex] || null;
}

function getMonsterEffects(room) {
    const players = Array.from(room.players.values());

    // The Counter turn that is running right now still counts, the same way
    // the turn order shows it.
    const counter =
        players.reduce(
            (total, player) => total + (player.counterTurns || 0),
            0
        ) + (room.counterTurn ? 1 : 0);

    // Status is a Charge card now: the total the Thief is holding.
    const status = players.reduce(
        (total, player) =>
            total + Math.max(0, player.charges?.status || 0),
        0
    );

    return {
        taunt: Math.max(0, room.taunt?.remainingDamage || 0),
        weaken: Math.max(0, room.weaken || 0),
        counter,
        status,
        // Battlefield effects that count down in monster turns.
        hex: Math.max(0, room.hex?.remaining || 0),
        shield: Math.max(0, room.shield?.remaining || 0)
    };
}

function getEncounterState(room) {
    if (!room.encounter) return null;

    return {
        name: room.encounter.name,
        size: room.encounter.size,
        grid: [...room.encounter.grid],
        active: room.encounter.active,
        initiativeOrder: room.initiativeOrder || [],
        currentTurn: getCurrentTurn(room),
        // Keep bonus Counter turns visible to the Host as well as players.
        counterPlayers: Array.from(room.players.values())
            .filter(player => (player.counterTurns || 0) > 0 || room.counterTurn?.playerID === player.id)
            .map(player => ({
                playerID: player.id,
                username: player.username,
                counterTurns: player.counterTurns || 0,
                active: room.counterTurn?.playerID === player.id
            })),
        monsterHasActed: room.monsterHasActed || false,

        weaken: room.weaken || 0,
        curses: [...(room.encounter.curses || [])],

        // Shown in the Monster's Effects panel (Host and players).
        // Taunt and Weaken are Charges; Counter and Status are Turns.
        effects: getMonsterEffects(room),

        taunt: room.taunt
            ? {
                tankID: room.taunt.tankID,
                tankUsername: room.taunt.tankUsername,
                remainingDamage: room.taunt.remainingDamage,
                // Resting or Shielded: the charges wait, the monster is free.
                paused: cards.isTauntPaused(
                    room,
                    room.players.get(room.taunt.tankID)
                )
            }
            : null,

        // Hex discounts Attack / Blast costs for everyone while it lasts.
        hex: room.hex
            ? { remaining: room.hex.remaining }
            : null,

        // The one player the monster can't target right now.
        shield: room.shield
            ? {
                targetID: room.shield.targetID,
                supportID: room.shield.supportID,
                remaining: room.shield.remaining,
                total: room.shield.total
            }
            : null
    };
}

function updateRoom(roomID) {
    const room = rooms.get(roomID);

    if (!room) return;

    io.to(room.host).emit("room-state", getRoomState(roomID));

    // Players see each other's Retaliate marks. The Host does not.
    const withMarks = getPartyState(room, true);
    const withoutMarks = getPartyState(room, false);

    for (const player of room.players.values()) {
        io.to(player.id).emit("party-update", withMarks);
    }

    io.to(room.host).emit("party-update", withoutMarks);
}

function updateEncounter(roomID) {
    const room = rooms.get(roomID);

    if (!room) return;

    io.to(roomID).emit(
        "encounter-state",
        getEncounterState(room)
    );
}

function sendPlayerState(player) {
    io.to(player.id).emit("player-state", {
        assignment: player.assignment,
        cards: player.cards,
        gridSize: player.gridSize,
        grid: player.grid,
        energy: player.energy ?? 0,
        counterTurns: player.counterTurns ?? 0,
        marks: [...(player.marks || [])],
        charges: { ...(player.charges || {}) },
        rest: player.rest || 0,
        shieldBreak: player.shieldBreak || 0
    });
}

function emitTurnState(roomID) {
    const room = rooms.get(roomID);

    if (!room) return;

    updateEncounter(roomID);
    updateRoom(roomID);

    for (const player of room.players.values()) {
        sendPlayerState(player);
    }
}

// Sends the full data to players and the reduced data to the Host.
function emitToPlayersAndHost(room, eventName, fullData, hostData) {
    for (const player of room.players.values()) {
        io.to(player.id).emit(eventName, fullData);
    }

    // Unless told otherwise, the Host gets the same result without anyone's
    // Energy figures (see getPublicPlayer for why).
    if (hostData === undefined) {
        const {
            energySpent,
            remainingEnergy,
            energyPenalty,
            ...publicData
        } = fullData;
        hostData = publicData;
    }

    io.to(room.host).emit(eventName, hostData);
}

/* =====================================
   GRID HELPERS
===================================== */

function isHittable(cell) {
    return cell === "hp" || cell === "overheal";
}

function getHittablePositions(grid) {
    return grid
        .map((cell, index) => isHittable(cell) ? index : -1)
        .filter(index => index !== -1);
}

// Healthy monster cells: plain HP only (no Overheal, no Armor).
function getHealthyMonsterPositions(encounter) {
    return encounter.grid
        .map((cell, index) => cell === "hp" ? index : -1)
        .filter(index => index !== -1);
}

// What Status may pick: healthy and Overheal cells, never Armor.
function getStatusTargetPositions(encounter) {
    return encounter.grid
        .map((cell, index) => isHittable(cell) ? index : -1)
        .filter(index => index !== -1);
}

/* =====================================
   MONSTER DAMAGE (ARMOR + CURSE CHAINS)
===================================== */

/*
    Every source of damage to the monster goes through here:
    attacks, Blast, Spellvamp, Execute, Status, Retaliate and Curse
    explosions.

    Hitting a cell:
        hp        -> empty
        overheal  -> hp      (the Overheal is used up)
        armor     -> empty / overheal   (only if options.gridBased)

    ARMOR is only ever touched by grid-based attacks (options.gridBased).
    Execute, Status, Retaliate and Curse explosions skip it completely.

    A cursed position that is damaged explodes: the positions up, down,
    left and right of it are damaged too (Armor ignores explosions). Those
    can be cursed as well, which makes a chain reaction. Each curse only
    explodes once.

    Returns:
        damage          cells that lost HP (direct hits and explosions)
        overhealDamage  cells that lost Overheal
        exploded        curses that went off
        armorBroken     Armor cells destroyed (positions)
        directPositions every cell the attack itself changed (Armor included)
        directHits      the same, without Armor: the "successful hits"
*/
function damageMonsterCells(room, positions, source = "attack", options = {}) {
    const encounter = room.encounter;
    const size = encounter.size;
    const curses = encounter.curses;
    const gridBased = Boolean(options.gridBased);

    const exploded = [];

    // Visual chain for the clients: step 0 is everything hit directly,
    // step 1 is everything hurt by the explosions of step 0, and so on.
    // Each cell carries its old and new state so the client can animate it.
    const steps = [];

    const result = {
        damage: 0,
        overhealDamage: 0,
        exploded,
        armorBroken: [],
        directPositions: [],
        directHits: []
    };

    // Changes one cell, or returns null when this hit does nothing to it.
    function hitCell(index, canBreakArmor) {
        const before = encounter.grid[index];

        let after = null;

        if (before === "hp") {
            after = "empty";
        } else if (before === "overheal") {
            after = "hp";
        } else if (canBreakArmor && cards.isArmorCell(before)) {
            after = cards.ARMOR_BREAKS_TO[before];
        }

        if (after === null) return null;

        encounter.grid[index] = after;

        if (before === "overheal") {
            result.overhealDamage++;
        } else if (before === "hp") {
            result.damage++;
        }

        return { index, before, after };
    }

    let current = [];
    const seen = new Set();

    positions.forEach(position => {
        if (seen.has(position)) return;
        seen.add(position);

        const change = hitCell(position, gridBased);

        if (!change) return;

        current.push(change);
        result.directPositions.push(position);

        if (cards.isArmorCell(change.before)) {
            result.armorBroken.push(position);
        } else {
            result.directHits.push(position);
        }
    });

    while (current.length > 0) {
        steps.push({
            cells: current.map(change => ({
                index: change.index,
                cursed: curses.has(change.index),
                before: change.before,
                after: change.after
            }))
        });

        const next = [];

        current.forEach(change => {
            if (!curses.has(change.index)) return;

            curses.delete(change.index);
            exploded.push(change.index);

            const row = Math.floor(change.index / size);
            const column = change.index % size;

            [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dRow, dColumn]) => {
                const r = row + dRow;
                const c = column + dColumn;

                if (r < 0 || r >= size || c < 0 || c >= size) return;

                // Armor ignores Curse explosions.
                const explosion = hitCell(r * size + c, false);

                if (explosion) next.push(explosion);
            });
        });

        current = next;
    }

    // Everyone (Host included) gets the same animation order.
    if (steps.length > 0) {
        io.to(room.roomID).emit("monster-damage-fx", {
            source,
            steps
        });
    }

    return result;
}

/*
    Takes defences off cells WITHOUT damaging them: no HP is ever lost.
    Used by Penetrate (Armor next to a hit cell) and Spellvamp.

        armor           -> hp        (the HP cell that was underneath)
        armor-overheal  -> overheal  (or hp when options.stripOverheal)
        overheal        -> hp        (only when options.stripOverheal)

    Returns what changed: [{ index, before, after }].
*/
function stripMonsterDefenses(room, positions, source, options = {}) {
    const encounter = room.encounter;
    const changes = [];

    positions.forEach(index => {
        const before = encounter.grid[index];

        let after = null;

        if (before === "armor") {
            after = "hp";
        } else if (before === "armor-overheal") {
            after = options.stripOverheal ? "hp" : "overheal";
        } else if (before === "overheal" && options.stripOverheal) {
            after = "hp";
        }

        if (after === null) return;

        encounter.grid[index] = after;
        changes.push({ index, before, after });
    });

    if (changes.length > 0) {
        io.to(room.roomID).emit("monster-damage-fx", {
            source,
            steps: [{
                cells: changes.map(change => ({ ...change, cursed: false }))
            }]
        });
    }

    return changes;
}

/* =====================================
   CARD POSITION CALCULATION
===================================== */

function calculateCardPositions(card, anchor, gridSize) {
    if (
        !card ||
        !Array.isArray(card.pattern) ||
        !Number.isInteger(anchor) ||
        !Number.isInteger(gridSize) ||
        anchor < 0 ||
        anchor >= gridSize * gridSize
    ) {
        return null;
    }

    const anchorRow = Math.floor(anchor / gridSize);
    const anchorColumn = anchor % gridSize;

    const positions = [];

    for (const position of card.pattern) {
        const rowOffset = Math.floor(position / 3) - 1;
        const columnOffset = (position % 3) - 1;

        const targetRow = anchorRow + rowOffset;
        const targetColumn = anchorColumn + columnOffset;

        if (
            targetRow < 0 ||
            targetRow >= gridSize ||
            targetColumn < 0 ||
            targetColumn >= gridSize
        ) {
            return null;
        }

        positions.push(
            targetRow * gridSize + targetColumn
        );
    }

    if (
        positions.length !== card.targetCount ||
        new Set(positions).size !== positions.length
    ) {
        return null;
    }

    return positions;
}

/* =====================================
   COMBAT ACTION GUARDS
===================================== */

// Returns the acting player if this is a valid combat action, otherwise
// emits an error and returns null.
function getActingPlayer(
    socket,
    room,
    className = null,
    classError = null,
    isAttackCard = false,
    allowRageDuringCounter = false
) {
    if (!isPlayer(socket, room)) return null;

    const player = room.players.get(socket.id);

    if (!room.encounter?.active) {
        socket.emit("combat-action-error", "There is no active encounter.");
        return null;
    }

    if (!isPlayersTurn(socket, room)) {
        socket.emit("combat-action-error", "It is not your turn.");
        return null;
    }

    // Counter turns are bonus Warrior actions. Attack is the normal action;
    // Rage may be used as a setup action when its handler explicitly allows it.
    if (
        getCurrentTurn(room)?.counter &&
        !isAttackCard &&
        !allowRageDuringCounter
    ) {
        socket.emit(
            "combat-action-error",
            "During a Counter turn you can only use an Attack card or Rage."
        );

        return null;
    }

    if (className && player.className !== className) {
        socket.emit("combat-action-error", classError || `Only ${className} can do that.`);
        return null;
    }

    return player;
}

// A player is dead when their grid has no HP or Overheal left.
function isDead(player) {
    return getHittablePositions(player.grid).length === 0;
}

// Dead players lose their turn. The monster is never skipped,
// so this loop always ends.
function skipDeadTurns(room) {
    const total = room.initiativeOrder?.length || 0;

    for (let i = 0; i < total; i++) {
        const turn = getCurrentTurn(room);

        if (turn?.type !== "player") return;

        const member = room.players.get(turn.id);

        if (member && !isDead(member)) return;

        room.turnIndex = (room.turnIndex + 1) % total;
    }
}

// A player whose Energy hits 0 automatically ends their turn.
function endTurnIfOutOfEnergy(room, player) {
    if (player.energy > 0) return;

    // Rage costs 0 Energy and GIVES Energy, so a Warrior at 0 Energy who still
    // holds a Rage card and has HP to sacrifice keeps their turn (they can
    // still press End Turn manually).
    const canStillRage =
        player.className === "Warrior" &&
        !isDead(player) &&
        player.cards.some(card => card.type === "rage");

    if (canStillRage) return;

    advanceTurn(room);
}

// Called after a player finishes using a card. A Counter turn is a
// single attack, so it ends right after the Warrior's attack.
function finishPlayerAction(room, player) {
    if (room.counterTurn) {
        advanceTurn(room);
        return;
    }

    endTurnIfOutOfEnergy(room, player);
}

/* =====================================
   COUNTER (WARRIOR)
===================================== */

function canAffordAnAttack(player, room) {
    return player.cards.some(
        card =>
            card.type === "attack" &&
            player.energy >= cards.getCardCost(card, room)
    );
}

// The Warrior who gets to Counter after the monster's attack, if any.
function findCounteringWarrior(room) {
    // A stored Counter charge grants a bonus turn to a living Warrior.
    // Do not require Energy or an Attack card here: the Warrior still gets
    // the turn and may use an available legal action or simply end it.
    return Array.from(room.players.values()).find(
        player =>
            player.className === "Warrior" &&
            (player.counterTurns || 0) > 0 &&
            !isDead(player)
    ) || null;
}

/* =====================================
   TURN ADVANCEMENT
===================================== */

function advanceTurn(room) {
    if (!room.initiativeOrder?.length) return;

    if (room.counterTurn) {
        // The Counter turn is over: resume the order that was interrupted.
        room.turnIndex =
            room.counterTurn.resumeIndex % room.initiativeOrder.length;

        room.counterTurn = null;
    } else {
        const currentTurn = getCurrentTurn(room);

        // The monster's turn is over: Hex, Shield and Shield Break count down.
        if (currentTurn?.type === "monster") {
            cards.tickMonsterTurnEffects(room);
        }

        // Counter is a bonus turn after the Monster's turn, whether the monster
        // attacked, was ended early by the Host, or was skipped by Weaken.
        // Resolve Counter BEFORE advancing the natural initiative index.
        // This matters when the monster is the final participant: the Counter
        // interrupt must run first, then resume at index 0 in the next cycle.
        if (currentTurn?.type === "monster") {
            const warrior = findCounteringWarrior(room);

            if (warrior) {
                warrior.counterTurns--;

                room.counterTurn = {
                    playerID: warrior.id,
                    // Save the exact natural next turn. If the monster is last,
                    // this correctly wraps to the first participant.
                    resumeIndex: (room.turnIndex + 1) % room.initiativeOrder.length
                };

                room.attackRoll = null;
                room.monsterHasActed = false;
                room.monsterAttackedThisTurn = false;

                io.to(room.roomID).emit("counter-turn-started", {
                    playerID: warrior.id,
                    username: warrior.username,
                    counterTurnsLeft: warrior.counterTurns
                });

                // No Energy regeneration during a Counter turn.
                return;
            }
        }

        room.turnIndex =
            (room.turnIndex + 1) % room.initiativeOrder.length;
    }

    // Skip anyone who is dead.
    skipDeadTurns(room);

    room.attackRoll = null;
    room.monsterHasActed = false;
    room.monsterAttackedThisTurn = false;

    beginTurn(room);
}

/*
    The new turn has started: its player regenerates Energy.

    A player who is Resting gets extra Energy and a heal instead of a turn,
    and the turn passes straight on to whoever is next. Rest can't be
    cancelled, so nothing (not even the monster) wakes them up early.
*/
function beginTurn(room) {
    const total = room.initiativeOrder.length;

    for (let guard = 0; guard <= total; guard++) {
        const turn = getCurrentTurn(room);

        if (turn?.type !== "player") return;

        const player = room.players.get(turn.id);

        if (!player) return;

        regeneratePlayerEnergy(player);

        if (!(player.rest > 0)) return;

        cards.processRestTurn(room, player);

        // Sleep through the turn.
        room.turnIndex = (room.turnIndex + 1) % total;

        skipDeadTurns(room);

        room.attackRoll = null;
        room.monsterHasActed = false;
        room.monsterAttackedThisTurn = false;
    }
}

function isPlayersTurn(socket, room) {
    const turn = getCurrentTurn(room);

    return Boolean(
        turn &&
        turn.type === "player" &&
        turn.id === socket.id
    );
}

function isMonstersTurn(room) {
    return getCurrentTurn(room)?.type === "monster";
}

// Clears every per-encounter effect on the room and its players.
function resetEncounterEffects(room) {
    room.attackRoll = null;
    room.monsterHasActed = false;
    room.monsterAttackedThisTurn = false;
    room.taunt = null;
    room.weaken = 0;
    room.counterTurn = null;

    for (const player of room.players.values()) {
        player.energy = STARTING_ENERGY;
        player.marks = new Set();
        player.counterTurns = 0;
    }

    // Charges, Rest, Shield Break, Hex and Shield.
    cards.resetCardState(room);
}

function startInitiative(room) {
    const participants = [];

    for (const player of room.players.values()) {
        participants.push({
            id: player.id,
            type: "player",
            username: player.username,
            className: player.className,
            initiative: 0
        });
    }

    participants.push({
        id: "monster",
        type: "monster",
        username: room.encounter.name,
        className: "Monster",
        initiative: 0
    });

    const numbers = shuffle([1, 2, 3, 4, 5, 6]);

    participants.forEach((participant, index) => {
        participant.initiative = numbers[index];
    });

    participants.sort(
        (a, b) => b.initiative - a.initiative
    );

    room.initiativeOrder = participants;
    room.turnIndex = 0;

    // Everyone starts with 5 Energy and no leftover effects.
    resetEncounterEffects(room);

    room.encounter.curses = new Set();

    // Anyone who is already dead does not get to go first.
    skipDeadTurns(room);
}

function removePlayerFromInitiative(room, playerID) {
    if (!room.initiativeOrder?.length) return;

    const removedIndex = room.initiativeOrder.findIndex(
        participant =>
            participant.type === "player" &&
            participant.id === playerID
    );

    if (removedIndex === -1) return;

    const currentIndex = room.turnIndex;
    const counter = room.counterTurn;

    room.initiativeOrder.splice(removedIndex, 1);

    if (counter && removedIndex < counter.resumeIndex) {
        counter.resumeIndex--;
    }

    if (removedIndex < currentIndex) {
        room.turnIndex--;
    } else if (removedIndex === currentIndex) {
        if (room.turnIndex >= room.initiativeOrder.length) {
            room.turnIndex = 0;
        }

        room.attackRoll = null;
        room.monsterHasActed = false;
    }

    // The Warrior left in the middle of their Counter turn.
    if (counter && counter.playerID === playerID) {
        room.counterTurn = null;

        if (room.initiativeOrder.length > 0) {
            room.turnIndex =
                counter.resumeIndex % room.initiativeOrder.length;
        }

        room.attackRoll = null;
        room.monsterHasActed = false;
    }

    if (room.initiativeOrder.length === 0) {
        room.turnIndex = 0;
        room.counterTurn = null;
    } else {
        skipDeadTurns(room);
    }
}

/* =====================================
   ROLE HELPERS
===================================== */

function isHost(socket, room) {
    return Boolean(
        room &&
        room.host === socket.id &&
        socket.data.role === "host"
    );
}

function isPlayer(socket, room) {
    return Boolean(
        room &&
        socket.data.role === "player" &&
        room.players.has(socket.id)
    );
}

/* =====================================
   CONNECTION
===================================== */

// Everything cards-server.js needs from the core game.
cards.init({
    io,
    rooms,
    MAX_ENERGY,
    randomInt: (min, max) => crypto.randomInt(min, max),
    shuffle,
    getActingPlayer,
    isPlayer,
    isDead,
    isHittable,
    getHittablePositions,
    getHealthyMonsterPositions,
    getStatusTargetPositions,
    calculateCardPositions,
    damageMonsterCells,
    stripMonsterDefenses,
    emitToPlayersAndHost,
    emitTurnState,
    finishPlayerAction,
    advanceTurn
});

io.on("connection", socket => {
    console.log("Connected:", socket.id);

    /* =====================================
       CREATE ROOM
    ===================================== */

    socket.on("create-room", () => {
        if (socket.data.roomID) {
            socket.emit("join-error", "You are already in a room.");
            return;
        }

        let roomID;

        do {
            roomID = generateRoomID();
        } while (rooms.has(roomID));

        rooms.set(roomID, {
            roomID,
            host: socket.id,
            players: new Map(),
            encounter: null,
            attackRoll: null,
            initiativeOrder: [],
            turnIndex: 0,
            monsterHasActed: false,
            monsterAttackedThisTurn: false,
            counterTurn: null,
            weaken: 0,
            taunt: null,
            hex: null,
            shield: null
        });

        socket.data.roomID = roomID;
        socket.data.role = "host";

        socket.join(roomID);

        socket.emit("room-created", { roomID });

        updateRoom(roomID);

        console.log("Room created:", roomID);
    });

    /* =====================================
       CHECK ROOM
    ===================================== */

    socket.on("check-room", roomID => {
        roomID = String(roomID || "")
            .trim()
            .toUpperCase();

        const room = rooms.get(roomID);

        if (!room) {
            socket.emit("room-availability", {
                exists: false,
                availableClasses: []
            });

            return;
        }

        const takenClasses = Array.from(room.players.values())
            .map(player => player.className);

        socket.emit("room-availability", {
            exists: true,
            availableClasses: CLASSES.filter(
                className => !takenClasses.includes(className)
            )
        });
    });

    /* =====================================
       JOIN ROOM
    ===================================== */

    socket.on("join-room", data => {
        if (socket.data.roomID) {
            socket.emit("join-error", "You are already in a room.");
            return;
        }

        const roomID = String(data?.roomID || "")
            .trim()
            .toUpperCase();

        const username = String(data?.username || "").trim();
        const className = String(data?.className || "");

        const room = rooms.get(roomID);

        if (!room) {
            socket.emit("join-error", "Room does not exist.");
            return;
        }

        if (!/^[a-zA-Z0-9 _-]{2,16}$/.test(username)) {
            socket.emit("join-error", "Username must be 2–16 characters.");
            return;
        }

        if (!CLASSES.includes(className)) {
            socket.emit("join-error", "Invalid class selection.");
            return;
        }

        if (room.players.size >= CLASSES.length) {
            socket.emit("join-error", "This room is full.");
            return;
        }

        const usernameTaken = Array.from(room.players.values()).some(
            player =>
                player.username.toLowerCase() === username.toLowerCase()
        );

        if (usernameTaken) {
            socket.emit("join-error", "That username is already in use.");
            return;
        }

        const classTaken = Array.from(room.players.values()).some(
            player => player.className === className
        );

        if (classTaken) {
            socket.emit("join-error", `${className} is already taken.`);
            return;
        }

        const gridSize = CLASS_GRID_SIZES[className];

        const player = {
            id: socket.id,
            username,
            className,
            assignment: null,
            cards: [],
            gridSize,
            grid: createGrid(gridSize),
            energy: STARTING_ENERGY,
            marks: new Set(),
            counterTurns: 0,
            ...cards.createPlayerCardState()
        };

        room.players.set(socket.id, player);

        socket.data.roomID = roomID;
        socket.data.role = "player";

        socket.join(roomID);

        socket.emit("room-joined", {
            roomID,
            player: {
                id: player.id,
                username: player.username,
                className: player.className,
                gridSize: player.gridSize
            }
        });

        sendPlayerState(player);

        updateRoom(roomID);
        updateEncounter(roomID);

        console.log(
            `${username} joined ${roomID} as ${className} (${gridSize}x${gridSize})`
        );
    });

    /* =====================================
       ISSUE CARD ASSIGNMENT
    ===================================== */

    socket.on("issue-assignment", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        const player = room.players.get(data?.playerID);
        const targetCount = Number(data?.targetCount);

        if (!player) {
            socket.emit("assignment-error", "Player not found.");
            return;
        }

        if (player.assignment) {
            socket.emit(
                "assignment-error",
                "Player already has a pending assignment."
            );

            return;
        }

        if (player.cards.length >= MAX_CARDS) {
            socket.emit(
                "assignment-error",
                "Player has four cards. They must discard one first."
            );

            return;
        }

        if (
            !Number.isInteger(targetCount) ||
            targetCount < 2 ||
            targetCount > 7
        ) {
            socket.emit(
                "assignment-error",
                "Target count must be between 2 and 7."
            );

            return;
        }

        // Some cards only allow certain sizes. Don't hand out a number
        // that none of this class's cards can use.
        if (!cards.classCanUseCount(player.className, targetCount)) {
            socket.emit(
                "assignment-error",
                `${player.className} has no card that can use ${targetCount} positions. ` +
                "Choose a smaller number."
            );

            return;
        }

        player.assignment = {
            id: crypto.randomUUID(),
            targetCount,
            issuedAt: Date.now()
        };

        io.to(player.id).emit(
            "assignment-received",
            player.assignment
        );

        sendPlayerState(player);

        socket.emit(
            "assignment-success",
            `Assigned ${targetCount} positions to ${player.username}.`
        );

        updateRoom(roomID);
    });

    /* =====================================
       SAVE CARD
    ===================================== */

    socket.on("save-card", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);

        if (!player.assignment) {
            socket.emit(
                "card-save-error",
                "You do not have an active assignment."
            );

            return;
        }

        if (player.cards.length >= MAX_CARDS) {
            socket.emit(
                "card-save-error",
                "Your card inventory is full. Discard a card first."
            );

            return;
        }

        const name = String(data?.name || "").trim();
        const pattern = data?.pattern;
        const targetCount = player.assignment.targetCount;

        const cardType = String(data?.type || "");

        if (!cards.CLASS_CARD_TYPES[player.className]?.includes(cardType)) {
            socket.emit(
                "card-save-error",
                "Invalid card type for your class."
            );

            return;
        }

        // Expensive cards only work with certain position counts,
        // because their Energy cost must fit under the cap of 9.
        if (!cards.isCardCountAllowed(cardType, targetCount)) {
            const rule = cards.CARD_DEFS[cardType];

            socket.emit(
                "card-save-error",
                `${cardType.toUpperCase()} cards can only have ${rule.min}-${rule.max} positions. ` +
                `This assignment has ${targetCount}.`
            );

            return;
        }

        if (!name || name.length > 24) {
            socket.emit(
                "card-save-error",
                "Card name must be 1–24 characters."
            );

            return;
        }

        // Only grid cards need a 3x3 pattern; charge and turn cards just use a count.
        if (cards.cardUsesPattern(cardType)) {
            if (
                !Array.isArray(pattern) ||
                pattern.length !== targetCount ||
                pattern.some(position =>
                    !Number.isInteger(position) ||
                    position < 0 ||
                    position > 8
                ) ||
                new Set(pattern).size !== pattern.length
            ) {
                socket.emit(
                    "card-save-error",
                    "Invalid card pattern."
                );

                return;
            }
        }

        const card = {
            id: crypto.randomUUID(),
            name,
            targetCount,
            pattern: cards.cardUsesPattern(cardType) ? [...pattern] : [],
            type: cardType,
            createdAt: Date.now()
        };

        player.cards.push(card);
        player.assignment = null;

        socket.emit("card-saved", card);

        sendPlayerState(player);
        updateRoom(roomID);

        console.log(
            `${player.username} created ${cardType} card: ${name}`
        );
    });

    /* =====================================
       DISCARD CARD
    ===================================== */

    socket.on("discard-card", cardID => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);

        const cardIndex = player.cards.findIndex(
            card => card.id === cardID
        );

        if (cardIndex === -1) {
            socket.emit("card-discard-error", "Card not found.");
            return;
        }

        const [discardedCard] = player.cards.splice(cardIndex, 1);

        socket.emit("card-discarded", discardedCard);

        sendPlayerState(player);
        updateRoom(roomID);

        console.log(
            `${player.username} discarded ${discardedCard.name}`
        );
    });

    /* =====================================
       PLAYER GRID SIZE
    ===================================== */

    socket.on("player-grid-size", () => {
        const room = rooms.get(socket.data.roomID);

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);

        socket.emit(
            "grid-size-error",
            `Your ${player.className} grid is fixed at ${player.gridSize}×${player.gridSize}.`
        );
    });

    /* =====================================
       CREATE ENCOUNTER
    ===================================== */

    socket.on("create-encounter", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) {
            socket.emit(
                "encounter-error",
                "Only the Host can create monsters."
            );

            return;
        }

        if (room.encounter?.active) {
            socket.emit(
                "encounter-error",
                "End the current encounter first."
            );

            return;
        }

        const name = String(data?.name || "").trim();
        const size = Number(data?.size);

        if (!name || name.length > 24) {
            socket.emit(
                "encounter-error",
                "Monster name must be 1–24 characters."
            );

            return;
        }

        if (![3, 5, 7].includes(size)) {
            socket.emit(
                "encounter-error",
                "Invalid monster grid size."
            );

            return;
        }

        room.encounter = {
            name,
            size,
            grid: createGrid(size),
            active: false,
            curses: new Set()
        };

        room.initiativeOrder = [];
        room.turnIndex = 0;

        resetEncounterEffects(room);

        socket.emit(
            "encounter-created",
            "Monster encounter created."
        );

        updateEncounter(roomID);
        updateRoom(roomID);

        console.log(
            "Monster successfully created:",
            room.encounter
        );
    });

    /* =====================================
       HOST PAINTS MONSTER CELLS (Overheal / Armor)
    ===================================== */

    socket.on("edit-monster-cell", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        const encounter = room.encounter;

        if (!encounter || encounter.active) {
            socket.emit(
                "encounter-error",
                "Monster cells can only be changed before the encounter starts."
            );

            return;
        }

        const index = Number(data?.index);
        const state = String(data?.state || "");

        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= encounter.grid.length ||
            !MONSTER_SETUP_STATES.includes(state)
        ) {
            return;
        }

        encounter.grid[index] = state;
        encounter.curses.delete(index);

        updateEncounter(roomID);
    });

    /* =====================================
       START ENCOUNTER
    ===================================== */

    socket.on("start-encounter", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (!room.encounter) {
            socket.emit(
                "encounter-error",
                "Create a monster first."
            );

            return;
        }

        if (room.encounter.active) {
            socket.emit(
                "encounter-error",
                "The encounter is already active."
            );

            return;
        }

        if (room.players.size === 0) {
            socket.emit(
                "encounter-error",
                "At least one player must join first."
            );

            return;
        }

        room.encounter.active = true;

        startInitiative(room);
        emitTurnState(roomID);

        console.log(
            "Encounter started:",
            room.encounter.name
        );
    });

    /* =====================================
       END ENCOUNTER
    ===================================== */

    socket.on("end-encounter", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room) || !room.encounter) return;

        room.encounter.active = false;
        room.encounter.curses = new Set();

        room.initiativeOrder = [];
        room.turnIndex = 0;

        resetEncounterEffects(room);

        emitTurnState(roomID);
    });

    /* =====================================
       HOST REVIVES A DEAD PLAYER
    ===================================== */

    socket.on("revive-player", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        const player = room.players.get(data?.playerID);

        if (!player) {
            socket.emit("revive-error", "Player not found.");
            return;
        }

        if (!isDead(player)) {
            socket.emit(
                "revive-error",
                `${player.username} is not dead.`
            );

            return;
        }

        // Soft reset: full HP and starting Energy. Cards are kept.
        player.grid = createGrid(player.gridSize);
        player.energy = STARTING_ENERGY;
        player.marks = new Set();
        player.counterTurns = 0;
        cards.resetPlayerCardState(player);

        if (room.shield?.targetID === player.id) {
            room.shield = null;
        }

        // A revived Tank starts fresh, without a leftover Taunt.
        if (room.taunt?.tankID === player.id) {
            room.taunt = null;
        }

        io.to(roomID).emit("player-revived", {
            playerID: player.id,
            username: player.username
        });

        emitTurnState(roomID);

        console.log(`${player.username} was revived by the Host.`);
    });

    /* =====================================
       PLAYER ENDS TURN
    ===================================== */

    socket.on("end-player-turn", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        if (
            !room.encounter?.active ||
            !isPlayersTurn(socket, room)
        ) {
            socket.emit(
                "turn-error",
                "It is not your turn."
            );

            return;
        }

        advanceTurn(room);
        emitTurnState(roomID);
    });

    /* =====================================
       MONSTER ENDS TURN
    ===================================== */

    socket.on("end-monster-turn", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (
            !room.encounter?.active ||
            !isMonstersTurn(room)
        ) {
            socket.emit(
                "turn-error",
                "It is not the monster's turn."
            );

            return;
        }

        // Ending the turn early forfeits any unused positions from the roll.
        // advanceTurn checks monsterAttackedThisTurn BEFORE changing the natural
        // initiative index, so a Counter is never skipped when the Monster is last.
        // Do not clear the marker here: advanceTurn owns its consumption/reset.
        room.attackRoll = null;
        advanceTurn(room);
        emitTurnState(roomID);
    });

    /* =====================================
       MONSTER D10
    ===================================== */

    socket.on("roll-monster-d10", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (
            !room.encounter?.active ||
            !isMonstersTurn(room)
        ) {
            socket.emit(
                "monster-attack-error",
                "It is not the monster's turn."
            );

            return;
        }

        if (room.monsterHasActed) {
            socket.emit(
                "monster-attack-error",
                "The monster has already acted this turn."
            );

            return;
        }

        if (room.attackRoll !== null) {
            socket.emit(
                "monster-attack-error",
                "Resolve the current attack first."
            );

            return;
        }

        const rolled = crypto.randomInt(1, 11);

        // Each Weaken point fully negates one selectable monster attack
        // position. Any unused negation carries into the next monster turn.
        const weaken = Math.max(0, Number(room.weaken) || 0);

        if (weaken > 0) {
            const positionsNegated = Math.min(weaken, rolled);
            const effective = Math.max(0, rolled - positionsNegated);

            room.weaken = weaken - positionsNegated;

            const info = {
                monsterName: room.encounter.name,
                roll: rolled,
                positionsNegated,
                absorbed: positionsNegated, // compatibility with existing clients
                effective,
                skipped: effective === 0,
                weakenLeft: room.weaken
            };

            if (effective <= 0) {
                // Every rolled attack position was negated; the monster skips its turn.
                io.to(roomID).emit("monster-weakened", info);

                advanceTurn(room);
                emitTurnState(roomID);

                return;
            }

            room.attackRoll = effective;

            socket.emit("monster-d10-result", effective);
            io.to(roomID).emit("monster-weakened", info);

            updateEncounter(roomID);

            return;
        }

        room.attackRoll = rolled;

        socket.emit("monster-d10-result", rolled);
    });

    /* =====================================
       MONSTER ATTACK
    ===================================== */

    socket.on("monster-attack", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (
            !room.encounter?.active ||
            !isMonstersTurn(room)
        ) {
            socket.emit(
                "monster-attack-error",
                "It is not the monster's turn."
            );

            return;
        }

        if (room.monsterHasActed) {
            socket.emit(
                "monster-attack-error",
                "The monster has already acted this turn."
            );

            return;
        }

        if (room.attackRoll === null) {
            socket.emit(
                "monster-attack-error",
                "Roll the D10 before attacking."
            );

            return;
        }

        // =================================
        // TAUNT ENFORCEMENT
        // =================================

        if (room.taunt) {
            const tank = room.players.get(room.taunt.tankID);

            // Remove Taunt if the Tank is gone or has no hittable HP.
            if (
                !tank ||
                getHittablePositions(tank.grid).length === 0
            ) {
                room.taunt = null;
                updateEncounter(roomID);
            } else if (
                !cards.isTauntPaused(room, tank) &&
                data?.playerID !== tank.id
            ) {
                socket.emit(
                    "monster-attack-error",
                    `Taunt is active! You must target ${tank.username}.`
                );

                return;
            }
        }

        const player = room.players.get(data?.playerID);
        const positions = data?.positions;

        if (!player) {
            socket.emit(
                "monster-attack-error",
                "Target player not found."
            );

            return;
        }

        if (cards.isShielded(room, player)) {
            socket.emit(
                "monster-attack-error",
                `${player.username} is Shielded and cannot be targeted.`
            );

            return;
        }

        const hittableCount = getHittablePositions(player.grid).length;

        if (hittableCount === 0) {
            socket.emit(
                "monster-attack-error",
                `${player.username} has no HP left to hit. Pick another target.`
            );

            return;
        }

        // A paused Taunt (Tank resting) doesn't force or soak anything.
        const tauntedTank =
            room.taunt &&
            room.taunt.tankID === player.id &&
            !cards.isTauntPaused(room, player);

        let maxCount = Math.min(
            room.attackRoll,
            hittableCount
        );

        // The hit is capped by the remaining Taunt only if the Tank
        // is the forced target; the monster can't hit past what is taunted.
        if (tauntedTank) {
            maxCount = Math.min(
                maxCount,
                room.taunt.remainingDamage
            );
        }

        if (
            !Array.isArray(positions) ||
            positions.length < 1 ||
            positions.length > maxCount ||
            new Set(positions).size !== positions.length ||
            positions.some(position =>
                !Number.isInteger(position) ||
                position < 0 ||
                position >= player.grid.length ||
                !isHittable(player.grid[position])
            )
        ) {
            socket.emit(
                "monster-attack-error",
                `Select between 1 and ${maxCount} hittable positions.`
            );

            return;
        }

        let damage = 0;
        let overhealDamage = 0;
        let retaliations = 0;

        // For the hit animation: which cells lost HP, which lost Overheal.
        const emptiedPositions = [];
        const overhealLostPositions = [];

        positions.forEach(position => {
            if (player.grid[position] === "overheal") {
                player.grid[position] = "hp";
                overhealDamage++;
                overhealLostPositions.push(position);
            } else if (player.grid[position] === "hp") {
                player.grid[position] = "empty";
                damage++;
                emptiedPositions.push(position);

                // A damaged Retaliate mark strikes back (once).
                if (player.marks?.has(position)) {
                    player.marks.delete(position);
                    retaliations++;
                }
            }
        });

        let tauntRemaining = null;

        if (tauntedTank) {
            room.taunt.remainingDamage -= positions.length;

            if (room.taunt.remainingDamage <= 0) {
                room.taunt = null;
                tauntRemaining = 0;
            } else {
                tauntRemaining = room.taunt.remainingDamage;
            }
        }

        // The D10 roll is a pool of positions. Spend what was used
        // and keep the rest for more attacks this turn.
        const rolled = room.attackRoll;

        let remaining = rolled - positions.length;

        // If nobody has HP left to hit, the leftover is lost.
        const anyoneHittable = Array.from(room.players.values()).some(
            member =>
                getHittablePositions(member.grid).length > 0 &&
                !cards.isShielded(room, member)
        );

        if (!anyoneHittable) {
            remaining = 0;
        }

        const result = {
            playerID: player.id,
            username: player.username,
            positions,
            emptiedPositions,
            overhealLostPositions,
            roll: rolled,
            remaining: Math.max(0, remaining),
            damage,
            overhealDamage,
            tauntRemaining
        };

        if (remaining > 0) {
            room.attackRoll = remaining;
        } else {
            room.attackRoll = null;
            room.monsterHasActed = true;
        }

        // The monster attacked this turn, so Counter can trigger later.
        room.monsterAttackedThisTurn = true;

        io.to(roomID).emit(
            "monster-attack-resolved",
            result
        );

        // Retaliate: each damaged mark hits a random healthy monster position.
        if (retaliations > 0) {
            const targets = shuffle(
                getHealthyMonsterPositions(room.encounter)
            ).slice(0, retaliations);

            const hit = damageMonsterCells(room, targets, "retaliate");

            // Only players are told (the Host can't see the marks).
            for (const member of room.players.values()) {
                io.to(member.id).emit("retaliate-triggered", {
                    playerID: player.id,
                    username: player.username,
                    triggered: retaliations,
                    damage: hit.damage
                });
            }
        }

        sendPlayerState(player);
        updateRoom(roomID);
        updateEncounter(roomID);
    });

    /* =====================================
       CARDS
    ===================================== */

    // Every card handler (player-attack, player-heal, player-rest ...)
    // is registered by cards-server.js.
    cards.registerSocketHandlers(socket);

    /* =====================================
       DISCONNECT
    ===================================== */

    socket.on("disconnect", () => {
        const roomID = socket.data.roomID;

        if (!roomID) return;

        const room = rooms.get(roomID);

        if (!room) return;

        if (room.host === socket.id) {
            io.to(roomID).emit("room-closed");

            rooms.delete(roomID);

            console.log("Room closed:", roomID);

            return;
        }

        const player = room.players.get(socket.id);

        if (player) {
            console.log(
                `${player.username} left ${roomID}`
            );

            removePlayerFromInitiative(room, socket.id);

            // Remove Taunt if its Tank disconnects.
            if (room.taunt?.tankID === socket.id) {
                room.taunt = null;
            }

            // A Shield needs both its Support and its target.
            if (
                room.shield?.targetID === socket.id ||
                room.shield?.supportID === socket.id
            ) {
                room.shield = null;
            }

            room.players.delete(socket.id);
        }

        emitTurnState(roomID);
    });
});

/* =====================================
   START SERVER
===================================== */

server.listen(PORT, () => {
    console.log(
        `Heart Grid running at http://localhost:${PORT}`
    );
});
