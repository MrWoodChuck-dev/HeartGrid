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

// Rage: every HP / Overheal position sacrificed grants this much Energy.
const RAGE_ENERGY_PER_POSITION = 2;

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

const HEALING_CLASSES = ["Support", "Mage"];

const ALLOWED_CARD_TYPES = {
    Tank: ["attack", "taunt", "retaliate"],
    Warrior: ["attack", "rage", "counter"],
    Mage: ["attack", "heal", "curse"],
    Support: ["heal", "buff", "weaken"],
    Thief: ["attack", "status", "lifesteal"]
};

// Every class except Support can use Attack cards.
const ATTACK_CLASSES = ["Tank", "Warrior", "Mage", "Thief"];

// Card types that use the 3x3 pattern editor.
const PATTERN_CARD_TYPES = [
    "attack",
    "heal",
    "rage",
    "lifesteal",
    "retaliate",
    "curse"
];

/*
    Position limits for the expensive cards. The Energy cap is 9, so a
    card that would cost more than 9 could never be used.

    Lifesteal: 2 Energy per position   -> 2-4 positions (max 8)
    Counter / Curse / Weaken: 1.5x     -> 2-6 positions (max 9)
*/
const CARD_RULES = {
    lifesteal: { min: 2, max: 4 },
    counter: { min: 2, max: 6 },
    curse: { min: 2, max: 6 },
    weaken: { min: 2, max: 6 }
};

// Energy cost of using a card. 1.5x costs remain fractional.
function getCardCost(card) {
    const n = card.targetCount;

    switch (card.type) {
        case "rage":
            return 0;
        case "lifesteal":
            return n * 2;
        case "counter":
        case "curse":
        case "weaken":
            return n * 1.5;
        default:
            return n;
    }
}

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
function getPublicPlayer(player, includeMarks = false) {
    const publicPlayer = {
        id: player.id,
        username: player.username,
        className: player.className,
        gridSize: player.gridSize,
        grid: [...player.grid],
        cardCount: player.cards.length,
        hasAssignment: Boolean(player.assignment),
        counterTurns: player.counterTurns ?? 0,
        status: player.status
            ? { ...player.status }
            : null
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
        player => getPublicPlayer(player, includeMarks)
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

    const status = players.reduce(
        (total, player) =>
            total +
            (player.status?.type === "thief"
                ? Math.max(0, player.status.remainingTurns || 0)
                : 0),
        0
    );

    return {
        taunt: Math.max(0, room.taunt?.remainingDamage || 0),
        weaken: Math.max(0, room.weaken || 0),
        counter,
        status
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
                remainingDamage: room.taunt.remainingDamage
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
        status: player.status
            ? { ...player.status }
            : null
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
        const { energySpent, remainingEnergy, ...publicData } = fullData;
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

function getHealthyMonsterPositions(encounter) {
    return encounter.grid
        .map((cell, index) => cell === "hp" ? index : -1)
        .filter(index => index !== -1);
}

/* =====================================
   MONSTER DAMAGE (WITH CURSE CHAINS)
===================================== */

/*
    Every source of damage to the monster goes through here:
    attacks, Lifesteal, poison, Retaliate, and Curse explosions.

    A cursed position that is damaged explodes: the positions up, down,
    left and right of it are damaged too. Those can be cursed as well,
    which makes a chain reaction. Each curse only explodes once.
*/
function damageMonsterCells(room, positions, source = "attack") {
    const encounter = room.encounter;
    const size = encounter.size;
    const curses = encounter.curses;

    const exploded = [];

    // Visual chain for the clients: step 0 is everything hit directly,
    // step 1 is everything hurt by the explosions of step 0, and so on.
    // Each cell says whether it was cursed so the client can shake it first.
    const steps = [];

    let damage = 0;
    let current = [];

    positions.forEach(position => {
        if (encounter.grid[position] === "hp") {
            encounter.grid[position] = "empty";
            damage++;
            current.push(position);
        }
    });

    while (current.length > 0) {
        steps.push({
            cells: current.map(index => ({
                index,
                cursed: curses.has(index)
            }))
        });

        const next = [];

        current.forEach(cell => {
            if (!curses.has(cell)) return;

            curses.delete(cell);
            exploded.push(cell);

            const row = Math.floor(cell / size);
            const column = cell % size;

            [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dRow, dColumn]) => {
                const r = row + dRow;
                const c = column + dColumn;

                if (r < 0 || r >= size || c < 0 || c >= size) return;

                const index = r * size + c;

                if (encounter.grid[index] === "hp") {
                    encounter.grid[index] = "empty";
                    damage++;
                    next.push(index);
                }
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

    return { damage, exploded };
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

function canAffordAnAttack(player) {
    return player.cards.some(
        card =>
            card.type === "attack" &&
            player.energy >= getCardCost(card)
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
   THIEF STATUS (POISON)
===================================== */

function resolveThiefStatus(room, thief) {
    if (
        !thief.status ||
        thief.status.type !== "thief"
    ) {
        return;
    }

    // Poison only ever hits the MONSTER's grid. No friendly fire.
    const encounter = room.encounter;

    let result = {
        thiefID: thief.id,
        thiefUsername: thief.username,
        monsterName: encounter?.name || "the monster",
        positions: [],
        damage: 0,
        damageRoll: 0
    };

    if (encounter?.active) {
        const healthyPositions = getHealthyMonsterPositions(encounter);

        if (healthyPositions.length > 0) {
            // Randomly deal either 1 or 2 damage.
            const damageRoll = crypto.randomInt(1, 3);

            const positions = shuffle(healthyPositions).slice(
                0,
                Math.min(damageRoll, healthyPositions.length)
            );

            // Goes through the shared damage code so Curses can chain.
            const hit = damageMonsterCells(room, positions, "status");

            result = {
                ...result,
                positions,
                damage: hit.damage,
                damageRoll
            };
        }
    }

    thief.status.remainingTurns--;

    const remainingTurns = Math.max(0, thief.status.remainingTurns);

    if (remainingTurns <= 0) {
        thief.status = null;
    }

    io.to(room.roomID).emit("thief-status-resolved", {
        ...result,
        remainingTurns,
        expired: remainingTurns <= 0
    });
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

        // Resolve Thief Status when the Thief finishes their turn.
        if (currentTurn?.type === "player") {
            const currentPlayer = room.players.get(currentTurn.id);

            if (currentPlayer) {
                resolveThiefStatus(room, currentPlayer);
            }
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

    const nextTurn = getCurrentTurn(room);

    if (nextTurn?.type === "player") {
        const player = room.players.get(nextTurn.id);

        if (player) {
            regeneratePlayerEnergy(player);
        }
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
        player.status = null;
        player.marks = new Set();
        player.counterTurns = 0;
    }
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
            taunt: null
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
            status: null,
            marks: new Set(),
            counterTurns: 0
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

        if (!ALLOWED_CARD_TYPES[player.className]?.includes(cardType)) {
            socket.emit(
                "card-save-error",
                "Invalid card type for your class."
            );

            return;
        }

        // Expensive cards only work with certain position counts,
        // because their Energy cost must fit under the cap of 9.
        const rule = CARD_RULES[cardType];

        if (rule && (targetCount < rule.min || targetCount > rule.max)) {
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

        // Buff, Taunt, Status, Counter and Weaken do not need a 3x3 pattern.
        if (PATTERN_CARD_TYPES.includes(cardType)) {
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
            pattern: PATTERN_CARD_TYPES.includes(cardType) ? [...pattern] : [],
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
       THIEF STATUS CARD
    ===================================== */

    socket.on("player-status", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Thief",
            "Only Thief can use Status cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "status") {
            socket.emit(
                "combat-action-error",
                "Invalid Status card."
            );

            return;
        }

        if (player.status?.type === "thief") {
            socket.emit(
                "combat-action-error",
                "Your Status is already active."
            );

            return;
        }

        // Position count = number of turns = Energy cost.
        const duration = card.targetCount;

        if (player.energy < duration) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this Status card."
            );

            return;
        }

        player.energy -= duration;

        player.status = {
            type: "thief",
            remainingTurns: duration
        };

        emitToPlayersAndHost(room, "player-status-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            duration,
            energySpent: duration,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} used Status card ${card.name} for ${duration} turns.`
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
        player.status = null;
        player.marks = new Set();
        player.counterTurns = 0;

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
            } else if (data?.playerID !== tank.id) {
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

        const hittableCount = getHittablePositions(player.grid).length;

        if (hittableCount === 0) {
            socket.emit(
                "monster-attack-error",
                `${player.username} has no HP left to hit. Pick another target.`
            );

            return;
        }

        const tauntedTank =
            room.taunt && room.taunt.tankID === player.id;

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
            member => getHittablePositions(member.grid).length > 0
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
       PLAYER ATTACK
    ===================================== */

    socket.on("player-attack", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(socket, room, null, null, true);

        if (!player) return;

        if (!ATTACK_CLASSES.includes(player.className)) {
            socket.emit(
                "combat-action-error",
                "Your class cannot use Attack cards."
            );

            return;
        }

        const encounter = room.encounter;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "attack") {
            socket.emit(
                "combat-action-error",
                "Invalid Attack card."
            );

            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this card."
            );

            return;
        }

        const positions = calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit(
                "combat-action-error",
                "That pattern does not fit there."
            );

            return;
        }

        const hit = damageMonsterCells(room, positions);

        player.energy -= card.targetCount;

        emitToPlayersAndHost(room, "player-attack-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions,
            damage: hit.damage,
            exploded: hit.exploded.length,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} attacked ${encounter.name} with ${card.name}. Damage: ${hit.damage}`
        );
    });

    /* =====================================
       THIEF LIFESTEAL
    ===================================== */

    socket.on("player-lifesteal", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Thief",
            "Only Thief can use Lifesteal cards."
        );

        if (!player) return;

        const encounter = room.encounter;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "lifesteal") {
            socket.emit(
                "combat-action-error",
                "Invalid Lifesteal card."
            );

            return;
        }

        const cost = getCardCost(card);

        if (player.energy < cost) {
            socket.emit(
                "combat-action-error",
                `Not enough Energy. Lifesteal costs ${cost}.`
            );

            return;
        }

        const monsterPositions = calculateCardPositions(
            card,
            data?.monsterAnchor,
            encounter.size
        );

        const healPositions = calculateCardPositions(
            card,
            data?.healAnchor,
            player.gridSize
        );

        if (!monsterPositions || !healPositions) {
            socket.emit(
                "combat-action-error",
                "The monster or healing pattern does not fit inside its grid."
            );
            return;
        }

        const hit = damageMonsterCells(room, monsterPositions, "lifesteal");
        player.energy -= cost;

        // Heal only selected EMPTY cells, capped by actual damage. No random
        // placement and no Overheal: occupied selected cells remain unchanged.
        const healable = healPositions.filter(
            position => player.grid[position] === "empty"
        );
        const healedPositions = healable.slice(
            0,
            Math.min(hit.damage, healable.length)
        );
        healedPositions.forEach(position => {
            player.grid[position] = "hp";
        });

        emitToPlayersAndHost(room, "player-lifesteal-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions: monsterPositions,
            healPositions: healedPositions,
            damage: hit.damage,
            exploded: hit.exploded.length,
            healed: healedPositions.length,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} used Lifesteal. Damage: ${hit.damage}, Healed: ${healedPositions.length}`
        );
    });

    /* =====================================
       MAGE CURSE
    ===================================== */

    socket.on("player-curse", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Mage",
            "Only Mage can use Curse cards."
        );

        if (!player) return;

        const encounter = room.encounter;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "curse") {
            socket.emit(
                "combat-action-error",
                "Invalid Curse card."
            );

            return;
        }

        const cost = getCardCost(card);

        if (player.energy < cost) {
            socket.emit(
                "combat-action-error",
                `Not enough Energy. Curse costs ${cost}.`
            );

            return;
        }

        const positions = calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit(
                "combat-action-error",
                "That pattern does not fit there."
            );

            return;
        }

        // Only healthy, not-yet-cursed positions can be marked.
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

        emitToPlayersAndHost(room, "player-curse-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions: markable,
            marked: markable.length,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} cursed ${markable.length} positions with ${card.name}`
        );
    });

    /* =====================================
       PLAYER HEAL
    ===================================== */

    socket.on("player-heal", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        const actor = room.players.get(socket.id);

        if (!HEALING_CLASSES.includes(actor.className)) {
            socket.emit(
                "combat-action-error",
                "Only Support and Mage can use Heal cards."
            );

            return;
        }

        const player = getActingPlayer(socket, room);

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "heal") {
            socket.emit(
                "combat-action-error",
                "Invalid Heal card."
            );

            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this card."
            );

            return;
        }

        const target = room.players.get(data?.targetPlayerID);

        if (!target) {
            socket.emit(
                "combat-action-error",
                "That teammate could not be found."
            );

            return;
        }

        if (isDead(target)) {
            socket.emit(
                "combat-action-error",
                `${target.username} is dead and cannot be healed. Ask the Host to revive them.`
            );

            return;
        }

        const positions = calculateCardPositions(
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

        player.energy -= card.targetCount;

        emitToPlayersAndHost(room, "player-heal-resolved", {
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
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} healed ${target.username} with ${card.name}. ` +
            `HP restored: ${healed}, Overheal added: ${overhealed}`
        );
    });

    /* =====================================
       SUPPORT BUFF
    ===================================== */

    socket.on("player-buff", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Support",
            "Only Support can use Buff cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "buff") {
            socket.emit(
                "combat-action-error",
                "Invalid Buff card."
            );

            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this card."
            );

            return;
        }

        const target = room.players.get(data?.targetPlayerID);

        if (!target || target.id === player.id) {
            socket.emit(
                "combat-action-error",
                "Choose another teammate to receive Energy."
            );

            return;
        }

        if (isDead(target)) {
            socket.emit(
                "combat-action-error",
                `${target.username} is dead and cannot receive Energy. Ask the Host to revive them.`
            );

            return;
        }

        // Support pays the cost, the teammate receives the same amount.
        player.energy -= card.targetCount;
        target.energy += card.targetCount;

        emitToPlayersAndHost(room, "player-buff-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            energyTransferred: card.targetCount,
            remainingEnergy: player.energy,
            targetEnergy: target.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} buffed ${target.username} with ${card.name}. ` +
            `Energy transferred: ${card.targetCount}`
        );
    });

    /* =====================================
       SUPPORT WEAKEN
    ===================================== */

    socket.on("player-weaken", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Support",
            "Only Support can use Weaken cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "weaken") {
            socket.emit(
                "combat-action-error",
                "Invalid Weaken card."
            );

            return;
        }

        const cost = getCardCost(card);

        if (player.energy < cost) {
            socket.emit(
                "combat-action-error",
                `Not enough Energy. Weaken costs ${cost}.`
            );

            return;
        }

        player.energy -= cost;

        // Each Weaken point negates one monster attack position on its next roll.
        room.weaken = (room.weaken || 0) + card.targetCount;

        emitToPlayersAndHost(room, "player-weaken-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            added: card.targetCount,
            weaken: room.weaken,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} used Weaken. Total Weaken: ${room.weaken}`
        );
    });

    /* =====================================
       WARRIOR RAGE
    ===================================== */

    socket.on("player-rage", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Warrior",
            "Only Warrior can use Rage cards.",
            false,
            true
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "rage") {
            socket.emit(
                "combat-action-error",
                "Invalid Rage card."
            );

            return;
        }

        // Rage targets the Warrior's own grid.
        const positions = calculateCardPositions(
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
        if (
            positions.some(position =>
                !isHittable(player.grid[position])
            )
        ) {
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
        const energyGained =
            positions.length * RAGE_ENERGY_PER_POSITION;

        player.energy += energyGained;

        emitToPlayersAndHost(room, "player-rage-resolved", {
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
        if (isDead(player)) {
            advanceTurn(room);
        }

        emitTurnState(roomID);

        console.log(
            `${player.username} used Rage. ` +
            `Positions taken: ${positions.length}, Energy gained: ${energyGained}`
        );
    });

    /* =====================================
       WARRIOR COUNTER
    ===================================== */

    socket.on("player-counter", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Warrior",
            "Only Warrior can use Counter cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "counter") {
            socket.emit(
                "combat-action-error",
                "Invalid Counter card."
            );

            return;
        }

        const cost = getCardCost(card);

        if (player.energy < cost) {
            socket.emit(
                "combat-action-error",
                `Not enough Energy. Counter costs ${cost}.`
            );

            return;
        }

        player.energy -= cost;

        // Each position is one Counter Turn. Counter stacks.
        player.counterTurns = (player.counterTurns || 0) + card.targetCount;

        emitToPlayersAndHost(room, "player-counter-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            added: card.targetCount,
            counterTurns: player.counterTurns,
            energySpent: cost,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} used Counter. Counter turns: ${player.counterTurns}`
        );
    });

    /* =====================================
       TANK TAUNT
    ===================================== */

    socket.on("player-taunt", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Tank",
            "Only Tank can use Taunt cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "taunt") {
            socket.emit(
                "combat-action-error",
                "Invalid Taunt card."
            );

            return;
        }

        if (getHittablePositions(player.grid).length === 0) {
            socket.emit(
                "combat-action-error",
                "You need HP remaining to activate Taunt."
            );

            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this Taunt card."
            );

            return;
        }

        player.energy -= card.targetCount;

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

        emitToPlayersAndHost(room, "player-taunt-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            tauntedDamage: card.targetCount,
            remainingDamage: room.taunt.remainingDamage,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} activated Taunt. ` +
            `Forced damage remaining: ${room.taunt?.remainingDamage}`
        );
    });

    /* =====================================
       TANK RETALIATE
    ===================================== */

    socket.on("player-retaliate", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(
            socket,
            room,
            "Tank",
            "Only Tank can use Retaliate cards."
        );

        if (!player) return;

        const card = player.cards.find(
            item => item.id === data?.cardID
        );

        if (!card || card.type !== "retaliate") {
            socket.emit(
                "combat-action-error",
                "Invalid Retaliate card."
            );

            return;
        }

        const cost = getCardCost(card);

        if (player.energy < cost) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to use this card."
            );

            return;
        }

        // Retaliate marks the Tank's own grid.
        const positions = calculateCardPositions(
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
        emitToPlayersAndHost(
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

        finishPlayerAction(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} set ${positions.length} Retaliate marks with ${card.name}`
        );
    });

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
