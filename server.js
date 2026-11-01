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

const ENERGY_REGEN = {
    Tank: 1,
    Warrior: 2,
    Support: 2,
    Thief: 5,
    Mage: 3
};

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const CLASSES = ["Tank", "Warrior", "Mage", "Support", "Thief"];

const CLASS_GRID_SIZES = {
    Tank: 6,
    Warrior: 5,
    Support: 4,
    Mage: 3,
    Thief: 3
};

const HEALING_CLASSES = ["Support", "Mage"];

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

    player.energy = Math.min(
        MAX_ENERGY,
        player.energy + regen
    );
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
        energy: player.energy ?? 0
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
        monsterHasActed: room.monsterHasActed || false
    };
}

function updateRoom(roomID) {
    const room = rooms.get(roomID);
    if (!room) return;

    io.to(room.host).emit("room-state", getRoomState(roomID));
    io.to(roomID).emit("party-update", getPartyState(room));
}

function updateEncounter(roomID) {
    const room = rooms.get(roomID);
    if (!room) return;

    io.to(roomID).emit("encounter-state", getEncounterState(room));
}

function sendPlayerState(player) {
    io.to(player.id).emit("player-state", {
        assignment: player.assignment,
        cards: player.cards,
        gridSize: player.gridSize,
        grid: player.grid,
        energy: player.energy ?? 0
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

function advanceTurn(room) {
    if (!room.initiativeOrder?.length) return;

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

    participants.sort((a, b) => b.initiative - a.initiative);

    room.initiativeOrder = participants;
    room.turnIndex = 0;
    room.monsterHasActed = false;
    room.attackRoll = null;

    // Everyone starts with 5 Energy.
    for (const player of room.players.values()) {
        player.energy = STARTING_ENERGY;
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
        return;
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

        positions.push(targetRow * gridSize + targetColumn);
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
            host: socket.id,
            players: new Map(),
            encounter: null,
            attackRoll: null,
            initiativeOrder: [],
            turnIndex: 0,
            monsterHasActed: false
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
        roomID = String(roomID || "").trim().toUpperCase();

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

        const roomID = String(data?.roomID || "").trim().toUpperCase();
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
            player => player.username.toLowerCase() === username.toLowerCase()
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
            energy: STARTING_ENERGY
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
            socket.emit("assignment-error", "Player already has a pending assignment.");
            return;
        }

        if (player.cards.length >= MAX_CARDS) {
            socket.emit("assignment-error", "Player has four cards. They must discard one first.");
            return;
        }

        if (!Number.isInteger(targetCount) || targetCount < 2 || targetCount > 7) {
            socket.emit("assignment-error", "Target count must be between 2 and 7.");
            return;
        }

        player.assignment = {
            id: crypto.randomUUID(),
            targetCount,
            issuedAt: Date.now()
        };

        io.to(player.id).emit("assignment-received", player.assignment);
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
            socket.emit("card-save-error", "You do not have an active assignment.");
            return;
        }

        if (player.cards.length >= MAX_CARDS) {
            socket.emit("card-save-error", "Your card inventory is full. Discard a card first.");
            return;
        }

        const name = String(data?.name || "").trim();
        const pattern = data?.pattern;
        const targetCount = player.assignment.targetCount;

        const cardType = data?.type === "heal" ? "heal" : "attack";

        if (!name || name.length > 24) {
            socket.emit("card-save-error", "Card name must be 1–24 characters.");
            return;
        }

        if (
            !Array.isArray(pattern) ||
            pattern.length !== targetCount ||
            pattern.some(position =>
                !Number.isInteger(position) || position < 0 || position > 8
            ) ||
            new Set(pattern).size !== pattern.length
        ) {
            socket.emit("card-save-error", "Invalid card pattern.");
            return;
        }

        if (
            cardType === "heal" &&
            !HEALING_CLASSES.includes(player.className)
        ) {
            socket.emit(
                "card-save-error",
                "Only Support and Mage can create Heal cards."
            );
            return;
        }

        const card = {
            id: crypto.randomUUID(),
            name,
            targetCount,
            pattern,
            type: cardType,
            createdAt: Date.now()
        };

        player.cards.push(card);
        player.assignment = null;

        socket.emit("card-saved", card);
        sendPlayerState(player);
        updateRoom(roomID);

        console.log(`${player.username} created ${cardType} card: ${name}`);
    });

    /* =====================================
       DISCARD CARD
    ===================================== */

    socket.on("discard-card", cardID => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);

        const cardIndex = player.cards.findIndex(card => card.id === cardID);

        if (cardIndex === -1) {
            socket.emit("card-discard-error", "Card not found.");
            return;
        }

        const [discardedCard] = player.cards.splice(cardIndex, 1);

        socket.emit("card-discarded", discardedCard);
        sendPlayerState(player);
        updateRoom(roomID);

        console.log(`${player.username} discarded ${discardedCard.name}`);
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
            socket.emit("encounter-error", "Only the Host can create monsters.");
            return;
        }

        if (room.encounter?.active) {
            socket.emit("encounter-error", "End the current encounter first.");
            return;
        }

        const name = String(data?.name || "").trim();
        const size = Number(data?.size);

        if (!name || name.length > 24) {
            socket.emit("encounter-error", "Monster name must be 1–24 characters.");
            return;
        }

        if (![3, 5, 7].includes(size)) {
            socket.emit("encounter-error", "Invalid monster grid size.");
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

        for (const player of room.players.values()) {
            player.energy = STARTING_ENERGY;
        }

        socket.emit("encounter-created", "Monster encounter created.");

        updateEncounter(roomID);
        updateRoom(roomID);

        console.log("Monster successfully created:", room.encounter);
    });

    /* =====================================
       START ENCOUNTER
    ===================================== */

    socket.on("start-encounter", () => {
        const roomID = socket.data.roomID;
        const room = rooms.get(roomID);

        if (!isHost(socket, room)) return;

        if (!room.encounter) {
            socket.emit("encounter-error", "Create a monster first.");
            return;
        }

        if (room.encounter.active) {
            socket.emit("encounter-error", "The encounter is already active.");
            return;
        }

        if (room.players.size === 0) {
            socket.emit("encounter-error", "At least one player must join first.");
            return;
        }

        room.encounter.active = true;

        startInitiative(room);
        emitTurnState(roomID);

        console.log("Encounter started:", room.encounter.name);
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

        for (const player of room.players.values()) {
            player.energy = STARTING_ENERGY;
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

        if (!room.encounter?.active || !isPlayersTurn(socket, room)) {
            socket.emit("turn-error", "It is not your turn.");
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

        if (!room.encounter?.active || !isMonstersTurn(room)) {
            socket.emit("turn-error", "It is not the monster's turn.");
            return;
        }

        if (room.attackRoll !== null) {
            socket.emit("turn-error", "Resolve the pending monster attack first.");
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

        if (!room.encounter?.active || !isMonstersTurn(room)) {
            socket.emit("monster-attack-error", "It is not the monster's turn.");
            return;
        }

        if (room.monsterHasActed) {
            socket.emit("monster-attack-error", "The monster has already acted this turn.");
            return;
        }

        if (room.attackRoll !== null) {
            socket.emit("monster-attack-error", "Resolve the current attack first.");
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

        if (!room.encounter?.active || !isMonstersTurn(room)) {
            socket.emit("monster-attack-error", "It is not the monster's turn.");
            return;
        }

        if (room.monsterHasActed) {
            socket.emit("monster-attack-error", "The monster has already acted this turn.");
            return;
        }

        if (room.attackRoll === null) {
            socket.emit("monster-attack-error", "Roll the D10 before attacking.");
            return;
        }

        const player = room.players.get(data?.playerID);
        const positions = data?.positions;

        if (!player) {
            socket.emit("monster-attack-error", "Target player not found.");
            return;
        }

        // The roll is a MAXIMUM number of positions, not a requirement.
        // Only cells that can actually be hit (hp / overheal) are valid targets.
        const isHittable = cell => cell === "hp" || cell === "overheal";
        const hittableCount = player.grid.filter(isHittable).length;

        if (hittableCount === 0) {
            socket.emit(
                "monster-attack-error",
                `${player.username} has no HP left to hit. Pick another target.`
            );
            return;
        }

        const maxCount = Math.min(room.attackRoll, hittableCount);

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

        const result = {
            playerID: player.id,
            username: player.username,
            positions,
            roll: room.attackRoll,
            damage,
            overhealDamage
        };

        room.attackRoll = null;
        room.monsterHasActed = true;

        io.to(roomID).emit("monster-attack-resolved", result);

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

        if (!isPlayer(socket, room)) return;

        const player = room.players.get(socket.id);
        const encounter = room.encounter;

        if (!encounter?.active) {
            socket.emit("combat-action-error", "There is no active encounter.");
            return;
        }

        if (!isPlayersTurn(socket, room)) {
            socket.emit("combat-action-error", "It is not your turn.");
            return;
        }

        const card = player.cards.find(item => item.id === data?.cardID);

        if (!card) {
            socket.emit("combat-action-error", "You do not own that card.");
            return;
        }

        if (card.type !== "attack") {
            socket.emit(
                "combat-action-error",
                "Heal cards can only target teammates."
            );
            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit("combat-action-error", "Not enough Energy to use this card.");
            return;
        }

        const positions = calculateCardPositions(
            card,
            data?.anchor,
            encounter.size
        );

        if (!positions) {
            socket.emit("combat-action-error", "That pattern does not fit there.");
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

        const result = {
            playerID: player.id,
            username: player.username,
            cardName: card.name,
            positions,
            damage,
            energySpent: card.targetCount,
            remainingEnergy: player.energy
        };

        io.to(roomID).emit("player-attack-resolved", result);

        if (player.energy <= 0) {
            advanceTurn(room);
        }

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

        const player = room.players.get(socket.id);

        if (!room.encounter?.active) {
            socket.emit("combat-action-error", "There is no active encounter.");
            return;
        }

        if (!isPlayersTurn(socket, room)) {
            socket.emit("combat-action-error", "It is not your turn.");
            return;
        }

        if (!HEALING_CLASSES.includes(player.className)) {
            socket.emit(
                "combat-action-error",
                "Only Support and Mage can use Heal cards."
            );
            return;
        }

        const card = player.cards.find(item => item.id === data?.cardID);

        if (!card) {
            socket.emit("combat-action-error", "You do not own that card.");
            return;
        }

        if (card.type !== "heal") {
            socket.emit(
                "combat-action-error",
                "This is an Attack card. It cannot be used for healing."
            );
            return;
        }

        if (player.energy < card.targetCount) {
            socket.emit("combat-action-error", "Not enough Energy to use this card.");
            return;
        }

        const target = room.players.get(data?.targetPlayerID);

        if (!target) {
            socket.emit("combat-action-error", "That teammate could not be found.");
            return;
        }

        const positions = calculateCardPositions(
            card,
            data?.anchor,
            target.gridSize
        );

        if (!positions) {
            socket.emit("combat-action-error", "That healing pattern does not fit there.");
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

        const result = {
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
        };

        io.to(roomID).emit("player-heal-resolved", result);

        sendPlayerState(target);
        updateRoom(roomID);

        if (player.energy <= 0) {
            advanceTurn(room);
        }

        emitTurnState(roomID);

        console.log(
            `${player.username} healed ${target.username} with ${card.name}. ` +
            `HP restored: ${healed}, Overheal added: ${overhealed}`
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
            console.log(`${player.username} left ${roomID}`);

            removePlayerFromInitiative(room, socket.id);
            room.players.delete(socket.id);
        }

        emitTurnState(roomID);
    });
});

/* =====================================
   START SERVER
===================================== */

server.listen(PORT, () => {
    console.log(`Heart Grid running at http://localhost:${PORT}`);
});