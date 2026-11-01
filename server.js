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
    Tank: ["attack", "taunt"],
    Warrior: ["attack", "rage"],
    Mage: ["attack", "heal"],
    Support: ["heal", "buff"],
    Thief: ["attack"]
};

// Every class except Support can use Attack cards.
const ATTACK_CLASSES = ["Tank", "Warrior", "Mage", "Thief"];

// Card types that use the 3x3 pattern editor.
const PATTERN_CARD_TYPES = ["attack", "heal", "rage"];

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

function getPublicPlayer(player) {
    return {
        id: player.id,
        username: player.username,
        className: player.className,
        gridSize: player.gridSize,
        grid: [...player.grid],
        cardCount: player.cards.length,
        hasAssignment: Boolean(player.assignment),
        energy: player.energy ?? 0,
        status: player.status
            ? { ...player.status }
            : null
    };
}

function getPartyState(room) {
    return Array.from(room.players.values()).map(getPublicPlayer);
}

function getRoomState(roomID) {
    const room = rooms.get(roomID);

    if (!room) return null;

    const players = getPartyState(room);
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
    return room.initiativeOrder?.[room.turnIndex] || null;
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
        monsterHasActed: room.monsterHasActed || false,

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

    io.to(roomID).emit(
        "party-update",
        getPartyState(room)
    );
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
function getActingPlayer(socket, room, className = null, classError = null) {
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

    if (className && player.className !== className) {
        socket.emit("combat-action-error", classError || `Only ${className} can do that.`);
        return null;
    }

    return player;
}

// A player whose Energy hits 0 automatically ends their turn.
function endTurnIfOutOfEnergy(room, player) {
    if (player.energy <= 0) {
        advanceTurn(room);
    }
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

    const possibleTargets = [];

    for (const player of room.players.values()) {
        const positions = getHittablePositions(player.grid);

        if (positions.length > 0) {
            possibleTargets.push({
                player,
                positions
            });
        }
    }

    let result = {
        thiefID: thief.id,
        thiefUsername: thief.username,
        targetPlayerID: null,
        targetUsername: null,
        positions: [],
        damage: 0,
        overhealDamage: 0,
        damageRoll: 0
    };

    if (possibleTargets.length > 0) {
        // Randomly choose a player's HP grid.
        const selectedTarget = possibleTargets[
            crypto.randomInt(0, possibleTargets.length)
        ];

        // Randomly deal either 1 or 2 damage.
        const damageRoll = crypto.randomInt(1, 3);

        const positions = shuffle(selectedTarget.positions).slice(
            0,
            Math.min(damageRoll, selectedTarget.positions.length)
        );

        let damage = 0;
        let overhealDamage = 0;

        positions.forEach(position => {
            if (selectedTarget.player.grid[position] === "overheal") {
                selectedTarget.player.grid[position] = "hp";
                overhealDamage++;
            } else {
                selectedTarget.player.grid[position] = "empty";
                damage++;
            }
        });

        result = {
            ...result,
            targetPlayerID: selectedTarget.player.id,
            targetUsername: selectedTarget.player.username,
            positions,
            damage,
            overhealDamage,
            damageRoll
        };
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

    const currentTurn = getCurrentTurn(room);

    // Resolve Thief Status when the Thief finishes their turn.
    if (currentTurn?.type === "player") {
        const currentPlayer = room.players.get(currentTurn.id);

        if (currentPlayer) {
            resolveThiefStatus(room, currentPlayer);
        }
    }

    room.turnIndex =
        (room.turnIndex + 1) % room.initiativeOrder.length;

    room.attackRoll = null;
    room.monsterHasActed = false;

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
    room.monsterHasActed = false;
    room.attackRoll = null;
    room.taunt = null;

    // Everyone starts with 5 Energy.
    for (const player of room.players.values()) {
        player.energy = STARTING_ENERGY;
        player.status = null;
    }
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

    room.initiativeOrder.splice(removedIndex, 1);

    if (removedIndex < currentIndex) {
        room.turnIndex--;
    } else if (removedIndex === currentIndex) {
        if (room.turnIndex >= room.initiativeOrder.length) {
            room.turnIndex = 0;
        }

        room.attackRoll = null;
        room.monsterHasActed = false;
    }

    if (room.initiativeOrder.length === 0) {
        room.turnIndex = 0;
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
            status: null
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

        // Thieves never hold cards, so the card limit does not apply to them.
        if (
            player.className !== "Thief" &&
            player.cards.length >= MAX_CARDS
        ) {
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

        if (!name || name.length > 24) {
            socket.emit(
                "card-save-error",
                "Card name must be 1–24 characters."
            );

            return;
        }

        // Buff and Taunt do not need a 3x3 pattern.
        // Attack, Heal, and Rage do.
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
       THIEF STATUS ACTIVATION
    ===================================== */

    socket.on("activate-thief-status", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);

        if (player.className !== "Thief") {
            socket.emit(
                "combat-action-error",
                "Only Thief can activate Status."
            );

            return;
        }

        if (!room.encounter?.active || !isPlayersTurn(socket, room)) {
            socket.emit(
                "combat-action-error",
                "You can only activate Status during your turn."
            );

            return;
        }

        if (!player.assignment) {
            socket.emit(
                "combat-action-error",
                "You need a Host assignment before activating Status."
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
        const duration = player.assignment.targetCount;

        if (player.energy < duration) {
            socket.emit(
                "combat-action-error",
                "Not enough Energy to activate Status."
            );

            return;
        }

        player.energy -= duration;

        player.status = {
            type: "thief",
            remainingTurns: duration
        };

        player.assignment = null;

        socket.emit("thief-status-activated", {
            duration,
            energySpent: duration,
            remainingEnergy: player.energy,
            message: `Status activated for ${duration} turns.`
        });

        endTurnIfOutOfEnergy(room, player);

        emitTurnState(roomID);

        console.log(
            `${player.username} activated Thief Status for ${duration} turns.`
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
            active: false
        };

        room.attackRoll = null;
        room.initiativeOrder = [];
        room.turnIndex = 0;
        room.monsterHasActed = false;
        room.taunt = null;

        for (const player of room.players.values()) {
            player.energy = STARTING_ENERGY;
            player.status = null;
        }

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
        room.attackRoll = null;
        room.initiativeOrder = [];
        room.turnIndex = 0;
        room.monsterHasActed = false;
        room.taunt = null;

        for (const player of room.players.values()) {
            player.energy = STARTING_ENERGY;
            player.status = null;
        }

        emitTurnState(roomID);
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

        if (room.attackRoll !== null) {
            socket.emit(
                "turn-error",
                "Resolve the pending monster attack first."
            );

            return;
        }

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

        const result = crypto.randomInt(1, 11);

        room.attackRoll = result;

        socket.emit("monster-d10-result", result);
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

        positions.forEach(position => {
            if (player.grid[position] === "overheal") {
                player.grid[position] = "hp";
                overhealDamage++;
            } else if (player.grid[position] === "hp") {
                player.grid[position] = "empty";
                damage++;
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

        const result = {
            playerID: player.id,
            username: player.username,
            positions,
            roll: room.attackRoll,
            damage,
            overhealDamage,
            tauntRemaining
        };

        room.attackRoll = null;
        room.monsterHasActed = true;

        io.to(roomID).emit(
            "monster-attack-resolved",
            result
        );

        sendPlayerState(player);
        updateRoom(roomID);
        updateEncounter(roomID);
    });

    /* =====================================
       PLAYER ATTACK - MAGE
    ===================================== */

    socket.on("player-attack", data => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        const player = getActingPlayer(socket, room);

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

        let damage = 0;

        positions.forEach(position => {
            if (encounter.grid[position] === "hp") {
                encounter.grid[position] = "empty";
                damage++;
            }
        });

        player.energy -= card.targetCount;

        io.to(roomID).emit("player-attack-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions,
            damage,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        endTurnIfOutOfEnergy(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} attacked ${encounter.name} with ${card.name}. Damage: ${damage}`
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

        positions.forEach(position => {
            if (target.grid[position] === "empty") {
                target.grid[position] = "hp";
                healed++;
            } else if (target.grid[position] === "hp") {
                target.grid[position] = "overheal";
                overhealed++;
            } else {
                unchanged++;
            }
        });

        player.energy -= card.targetCount;

        io.to(roomID).emit("player-heal-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            positions,
            healed,
            overhealed,
            unchanged,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        endTurnIfOutOfEnergy(room, player);
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

        // Support pays the cost, the teammate receives the same amount.
        player.energy -= card.targetCount;
        target.energy += card.targetCount;

        io.to(roomID).emit("player-buff-resolved", {
            playerID: player.id,
            username: player.username,
            targetPlayerID: target.id,
            targetUsername: target.username,
            cardName: card.name,
            energyTransferred: card.targetCount,
            remainingEnergy: player.energy,
            targetEnergy: target.energy
        });

        endTurnIfOutOfEnergy(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} buffed ${target.username} with ${card.name}. ` +
            `Energy transferred: ${card.targetCount}`
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
            "Only Warrior can use Rage cards."
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

        // HP is lost; Overheal is stripped back down to plain HP.
        positions.forEach(position => {
            if (player.grid[position] === "overheal") {
                player.grid[position] = "hp";
                overhealSacrificed++;
            } else {
                player.grid[position] = "empty";
                healthSacrificed++;
            }
        });

        // Rage costs no Energy. Each position taken gives Energy.
        const energyGained =
            positions.length * RAGE_ENERGY_PER_POSITION;

        player.energy += energyGained;

        io.to(roomID).emit("player-rage-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions,
            healthSacrificed,
            overhealSacrificed,
            energyGained,
            remainingEnergy: player.energy
        });

        emitTurnState(roomID);

        console.log(
            `${player.username} used Rage. ` +
            `Positions taken: ${positions.length}, Energy gained: ${energyGained}`
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

        io.to(roomID).emit("player-taunt-resolved", {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            tauntedDamage: card.targetCount,
            remainingDamage: room.taunt.remainingDamage,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        });

        endTurnIfOutOfEnergy(room, player);
        emitTurnState(roomID);

        console.log(
            `${player.username} activated Taunt. ` +
            `Forced damage remaining: ${room.taunt?.remainingDamage}`
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