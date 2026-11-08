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

// Monsters (species, the bench, damage, the Host's monster turn) live in
// monster-server.js.
const monsters = require("./monster-server");

const ENERGY_REGEN = {
    Tank: 1,
    Warrior: 2,
    Support: 3,
    Thief: 4,
    Mage: 3
};

// Classes whose natural regeneration ignores the Energy cap (the display
// still says 9, but they can keep climbing into Overheal-style overflow).
const UNCAPPED_REGEN_CLASSES = ["Thief"];

const CLASSES = ["Tank", "Warrior", "Mage", "Support", "Thief"];

const CLASS_GRID_SIZES = {
    Tank: 6,
    Warrior: 5,
    Support: 4,
    Mage: 3,
    Thief: 3
};

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

    // The Thief's regeneration bypasses the cap entirely.
    if (UNCAPPED_REGEN_CLASSES.includes(player.className)) {
        player.energy += regen;
        return;
    }

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
        counters: { ...(player.counters || {}) },

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
    // While a bonus turn is running it replaces the normal turn.
    if (room.counterTurn) {
        const bonus = room.counterTurn;

        // Devil's Counter: the Monster itself gets a restricted bonus action.
        if (bonus.kind === "devil") {
            const monster = room.initiativeOrder?.find(
                participant =>
                    participant.type === "monster" &&
                    participant.id === bonus.monsterID
            );

            return monster
                ? { ...monster, bonus: true, restricted: true }
                : null;
        }

        // The Warrior's Counter: a bonus Attack after a Monster's turn.
        const base = room.initiativeOrder?.find(
            participant =>
                participant.type === "player" &&
                participant.id === bonus.playerID
        );

        return base
            ? { ...base, counter: true, counterMonsterID: bonus.monsterID }
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
        ) + (room.counterTurn?.kind === "warrior" ? 1 : 0);

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

    const counterBonus = room.counterTurn;

    return {
        active: room.encounter.active,

        // Every Monster on the bench, each with its own grid and state.
        monsters: monsters.getPublicMonsters(room),
        maxMonsters: monsters.MAX_MONSTERS,

        initiativeOrder: room.initiativeOrder || [],

        // Which pass through the initiative order we are on. Durations
        // (Hex, Shield, Shield Break, Raging Demon) count rounds.
        round: room.encounter.active ? room.round || 1 : 0,
        currentTurn: getCurrentTurn(room),

        // What the current Monster has rolled / spent this turn.
        monsterTurn: monsters.getPublicMonsterTurn(room),

        // Keep bonus Counter turns visible to the Host as well as players.
        counterPlayers: Array.from(room.players.values())
            .filter(player =>
                (player.counterTurns || 0) > 0 ||
                (counterBonus?.kind === "warrior" && counterBonus.playerID === player.id)
            )
            .map(player => ({
                playerID: player.id,
                username: player.username,
                counterTurns: player.counterTurns || 0,
                counters: { ...(player.counters || {}) },
                active:
                    counterBonus?.kind === "warrior" &&
                    counterBonus.playerID === player.id
            })),

        // Counters Devils have put on players.
        devilCounters: monsters.getPublicDevilCounters(room),

        weaken: room.weaken || 0,

        // Shown in the Monster's Effects panel (Host and players).
        // Taunt and Weaken are Charges; Counter and Status are Turns.
        effects: getMonsterEffects(room),

        taunt: room.taunt
            ? {
                tankID: room.taunt.tankID,
                tankUsername: room.taunt.tankUsername,
                remainingDamage: room.taunt.remainingDamage,
                // Resting or Shielded: the charges wait, the monsters are free.
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

        // The one player the monsters can't target right now.
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

// Dead players lose their turn, and so do defeated Monsters. The loop is
// bounded by the number of participants, so it always ends.
/*
    ROUNDS. One round is one full pass through the initiative order: it ends
    when the turn order wraps from the last participant back to the first.
    Effects that last a number of "turns" (Hex, Shield, Shield Break, Raging
    Demon) count ROUNDS, not individual turns. They do not lose anything in
    the round they were made: they start counting in the next round, so
    an effect with a duration of 2 made in round 1 is gone after round 3.
*/
function endRound(room) {
    const finished = room.round || 1;

    cards.tickRoundEffects(room, finished);
    monsters.onRoundEnd(room, finished);

    room.round = finished + 1;

    io.to(room.roomID).emit("round-started", { round: room.round });
}

// Moves the turn pointer. Wrapping past the last participant ends the round.
function setTurnIndex(room, index) {
    const total = room.initiativeOrder?.length || 0;

    if (total === 0) return;

    const next = ((index % total) + total) % total;

    // Always called for a step FORWARD, so landing on or before where we
    // were means the order wrapped around.
    const wrapped = next <= room.turnIndex;

    room.turnIndex = next;

    if (wrapped) endRound(room);
}

function isParticipantOut(room, participant) {
    if (participant?.type === "monster") {
        const monster = monsters.getMonster(room, participant.id);

        return !monster || monsters.isMonsterDead(monster);
    }

    const member = room.players.get(participant?.id);

    return !member || isDead(member);
}

function skipDeadTurns(room) {
    const total = room.initiativeOrder?.length || 0;

    for (let i = 0; i < total; i++) {
        const turn = getCurrentTurn(room);

        // A bonus turn is only ever started for someone who can take it.
        if (!turn || turn.bonus || turn.counter) return;

        if (!isParticipantOut(room, turn)) return;

        setTurnIndex(room, room.turnIndex + 1);
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

/* =====================================
   TURN ADVANCEMENT
===================================== */

// Forgets what the last turn did (the Monster's dice, leftover rolls).
function resetTurnFlags(room) {
    monsters.clearMonsterTurn(room);
}

// Starts a bonus turn: a Warrior's Counter or a Devil's Counter.
function startBonusTurn(room, bonus) {
    room.counterTurn = bonus;

    resetTurnFlags(room);

    if (bonus.kind === "warrior") {
        const warrior = room.players.get(bonus.playerID);

        io.to(room.roomID).emit("counter-turn-started", {
            playerID: warrior.id,
            username: warrior.username,
            monsterID: bonus.monsterID,
            monsterName: monsters.getMonster(room, bonus.monsterID)?.name || "",
            counterTurnsLeft: warrior.counterTurns
        });
    } else {
        const monster = monsters.getMonster(room, bonus.monsterID);
        const target = room.players.get(bonus.playerID);

        io.to(room.roomID).emit("monster-bonus-started", {
            monsterID: bonus.monsterID,
            monsterName: monster?.name || "",
            playerID: bonus.playerID,
            username: target?.username || ""
        });
    }
}

function advanceTurn(room) {
    if (!room.initiativeOrder?.length) return;

    const total = room.initiativeOrder.length;

    if (room.counterTurn) {
        const finished = room.counterTurn;

        if (finished.kind === "devil") {
            monsters.onMonsterTurnEnd(room);
        }

        // Other Devils may be waiting for the same player's turn to have ended.
        const pending = (room.pendingBonuses || []).filter(next => {
            const monster = monsters.getMonster(room, next.monsterID);

            return monster && !monsters.isMonsterDead(monster);
        });

        room.pendingBonuses = [];

        if (pending.length > 0) {
            const next = pending.shift();

            room.pendingBonuses = pending;

            startBonusTurn(room, {
                kind: "devil",
                monsterID: next.monsterID,
                playerID: next.playerID,
                resumeIndex: finished.resumeIndex
            });

            return;
        }

        // The bonus turn is over: resume the order that was interrupted.
        room.counterTurn = null;

        // resumeIndex is "the next participant": past the end means a new round.
        setTurnIndex(room, finished.resumeIndex);
    } else {
        const currentTurn = getCurrentTurn(room);

        // A Monster's turn is over. (Durations count rounds, see endRound.)
        if (currentTurn?.type === "monster") {
            monsters.onMonsterTurnEnd(room);
        }

        const resumeIndex = (room.turnIndex + 1) % total;

        // Counter is a bonus turn after the turn of the Monster it was aimed
        // at, whether it attacked, was ended early by the Host, or was
        // weakened. Resolve it BEFORE advancing the natural initiative index.
        if (currentTurn?.type === "monster") {
            const warrior = monsters.findCounteringWarrior(
                room,
                currentTurn.id,
                isDead
            );

            if (warrior) {
                monsters.consumeWarriorCounter(warrior, currentTurn.id);

                // No Energy regeneration during a Counter turn.
                startBonusTurn(room, {
                    kind: "warrior",
                    playerID: warrior.id,
                    monsterID: currentTurn.id,
                    resumeIndex
                });

                return;
            }
        }

        // A player's own turn ended: every Devil Counter on them fires.
        if (currentTurn?.type === "player") {
            const bonuses = monsters.takeDevilCounterBonuses(room, currentTurn.id);

            if (bonuses.length > 0) {
                const first = bonuses.shift();

                room.pendingBonuses = bonuses;

                startBonusTurn(room, {
                    kind: "devil",
                    monsterID: first.monsterID,
                    playerID: first.playerID,
                    resumeIndex
                });

                return;
            }
        }

        setTurnIndex(room, resumeIndex);
    }

    // Skip anyone who is dead.
    skipDeadTurns(room);

    resetTurnFlags(room);

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
        setTurnIndex(room, room.turnIndex + 1);

        skipDeadTurns(room);

        resetTurnFlags(room);
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
    resetTurnFlags(room);

    room.taunt = null;
    room.weaken = 0;
    room.counterTurn = null;

    monsters.resetRoomEffects(room);

    for (const player of room.players.values()) {
        player.energy = STARTING_ENERGY;
        player.marks = new Set();
        player.counterTurns = 0;
        player.counters = {};
    }

    // Charges, Rest, Shield Break, Hex and Shield.
    cards.resetCardState(room);
}

/*
    Up to eight take part (five players, three Monsters). Every participant
    gets a UNIQUE number from 1 to 8: number 1 acts first, number 8 last.
*/
const INITIATIVE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8];

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

    participants.push(...monsters.getParticipants(room));

    const numbers = shuffle(INITIATIVE_NUMBERS);

    participants.forEach((participant, index) => {
        participant.initiative = numbers[index];
    });

    participants.sort(
        (a, b) => a.initiative - b.initiative
    );

    room.initiativeOrder = participants;
    room.turnIndex = 0;
    room.round = 1;

    // Everyone starts with 5 Energy and no leftover effects.
    resetEncounterEffects(room);

    // Anyone who is already dead does not get to go first.
    skipDeadTurns(room);

    // Every screen plays the octagon animation with this result.
    io.to(room.roomID).emit("initiative-rolled", {
        order: participants.map(participant => ({
            id: participant.id,
            type: participant.type,
            username: participant.username,
            className: participant.className,
            species: participant.species || null,
            initiative: participant.initiative
        }))
    });
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

        resetTurnFlags(room);
    }

    // The Warrior left in the middle of their Counter turn, or the player a
    // Devil's bonus action was for left: the bonus is over.
    if (
        counter &&
        (counter.playerID === playerID) &&
        (counter.kind === "warrior" || counter.kind === "devil")
    ) {
        room.counterTurn = null;

        if (room.initiativeOrder.length > 0) {
            room.turnIndex =
                counter.resumeIndex % room.initiativeOrder.length;
        }

        resetTurnFlags(room);
    }

    // Counters aimed at or owned by someone who left are void.
    room.devilCounters = (room.devilCounters || []).filter(
        entry => entry.playerID !== playerID
    );
    room.pendingBonuses = (room.pendingBonuses || []).filter(
        entry => entry.playerID !== playerID
    );

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

// Everything cards-server.js and monster-server.js need from the core game.
const sharedContext = {
    io,
    rooms,
    MAX_ENERGY,
    randomInt: (min, max) => crypto.randomInt(min, max),
    shuffle,
    getActingPlayer,
    getCurrentTurn,
    isPlayer,
    isHost,
    isDead,
    isHittable,
    getHittablePositions,
    calculateCardPositions,
    emitToPlayersAndHost,
    emitTurnState,
    updateEncounter,
    updateRoom,
    sendPlayerState,
    resetEncounterEffects,
    finishPlayerAction,
    advanceTurn,

    // The Monster half: damage and targeting go through monster-server.js.
    monsters,
    damageMonsterCells: monsters.damageMonsterCells,
    stripMonsterDefenses: monsters.stripMonsterDefenses,
    getHealthyMonsterPositions: monsters.getHealthyMonsterPositions,
    getStatusTargetPositions: monsters.getStatusTargetPositions
};

cards.init(sharedContext);
monsters.init(sharedContext);

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
            encounter: monsters.createEncounterState(),
            monsterTurn: null,
            devilCounters: [],
            pendingBonuses: [],
            initiativeOrder: [],
            turnIndex: 0,
            round: 0,
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
       START ENCOUNTER
    ===================================== */

    // The bench itself (add / remove / paint a Monster) is in monster-server.js.
    socket.on("start-encounter", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (monsters.getMonsters(room).length === 0) {
            socket.emit(
                "encounter-error",
                "Put at least one Monster on the bench first."
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

        monsters.beginEncounter(room);

        room.encounter.active = true;

        startInitiative(room);
        emitTurnState(roomID);

        console.log(
            "Encounter started:",
            monsters.getMonsters(room).map(monster => monster.name).join(", ")
        );
    });

    /* =====================================
       END ENCOUNTER
    ===================================== */

    // Stops the fight early and returns to setup: the Monsters keep their
    // names, Species and the grids the Host painted.
    socket.on("end-encounter", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room) || !room.encounter?.active) return;

        room.encounter.active = false;

        monsters.finishEncounter(room);

        room.initiativeOrder = [];
        room.turnIndex = 0;
        room.round = 0;

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
        player.counters = {};
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

    // Rolling dice and acting (attack, heal, armor ...) is in monster-server.js.
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
                "It is not a Monster's turn."
            );

            return;
        }

        // Devil's Counter bonus action must use its restricted attack.
        const turn = monsters.ensureMonsterTurn(room);
        const turnInfo = getCurrentTurn(room);

        if (turnInfo?.bonus && turn) {
            const attack = turn.dice.find(die => die.type === "attack");

            const someoneToHit = Array.from(room.players.values()).some(
                member =>
                    getHittablePositions(member.grid).length > 0 &&
                    !cards.isShielded(room, member)
            );

            if (attack && !attack.rolled && someoneToHit) {
                socket.emit(
                    "monster-attack-error",
                    "Counter bonus action: the Monster must use its restricted attack."
                );

                return;
            }
        }

        // Ending the turn early forfeits anything left from the dice.
        advanceTurn(room);
        emitTurnState(roomID);
    });

    /* =====================================
       CARDS
    ===================================== */

    // Every card handler (player-attack, player-heal, player-rest ...)
    // is registered by cards-server.js.
    cards.registerSocketHandlers(socket);

    // Every Monster action (bench, dice, attack ...) is registered by
    // monster-server.js.
    monsters.registerSocketHandlers(socket);

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
