/* =====================================
   SOCKET CONNECTION
===================================== */

const socket = io();


/* =====================================
   CLASS / CARD CONFIGURATION
===================================== */

const CARD_TYPES_BY_CLASS = {
    Tank: ["attack", "taunt", "retaliate"],
    Warrior: ["attack", "rage", "counter"],
    Mage: ["attack", "heal", "curse"],
    Support: ["heal", "buff", "weaken"],
    Thief: ["attack", "status", "lifesteal"]
};

// Cards that require the player to choose a pattern in the 3x3 editor.
const PATTERN_TYPES = [
    "attack", "heal", "rage", "lifesteal", "retaliate", "curse"
];

const RAGE_ENERGY_PER_POSITION = 2;

// Expensive cards have assignment-size restrictions so their cost fits
// within the normal 9 Energy cap.
const CARD_RULES = {
    lifesteal: { min: 2, max: 4, cost: n => n * 2 },
    counter: { min: 2, max: 6, cost: n => n * 1.5 },
    curse: { min: 2, max: 6, cost: n => n * 1.5 },
    weaken: { min: 2, max: 6, cost: n => n * 1.5 }
};

const CARD_TYPE_LABELS = {
    attack: "ATTACK CARD",
    heal: "HEAL CARD",
    buff: "BUFF CARD",
    rage: "RAGE CARD",
    taunt: "TAUNT CARD",
    status: "STATUS CARD",
    lifesteal: "LIFESTEAL CARD",
    retaliate: "RETALIATE CARD",
    counter: "COUNTER CARD",
    curse: "CURSE CARD",
    weaken: "WEAKEN CARD"
};

const CARD_TYPE_OPTION_NAMES = {
    attack: "Attack",
    heal: "Heal",
    buff: "Buff",
    rage: "Rage",
    taunt: "Taunt",
    status: "Status",
    lifesteal: "Lifesteal",
    retaliate: "Retaliate",
    counter: "Counter",
    curse: "Curse",
    weaken: "Weaken"
};

const CARD_TYPE_DESCRIPTIONS = {
    attack:
        "Attack the monster using the selected pattern. Costs 1 Energy per position.",
    heal:
        "Heal yourself or a teammate. Empty cells become HP, and HP becomes Overheal. Costs 1 Energy per position.",
    buff:
        "Give a teammate Energy equal to this card's position count. You pay the same amount. No pattern needed.",
    rage:
        "Sacrifice your own HP / Overheal positions to gain 2 Energy per position. Costs no Energy.",
    taunt:
        "Force the monster to target you. Each position absorbs one hit, and Taunt stacks. Costs 1 Energy per position. No pattern needed.",
    status:
        "Poison the monster for a number of turns equal to this card's positions. At the end of each of your turns, it deals 1-2 damage to random healthy monster positions. Costs 1 Energy per position. No pattern needed.",
    lifesteal:
        "Attack the monster, then restore HP equal to the damage that actually landed. Choose the empty positions on your own grid after targeting the monster; it cannot Overheal. Costs 2 Energy per position. Requires 2-4 positions.",
    retaliate:
        "Mark your own plain HP positions. Each marked position retaliates once when that exact cell takes HP damage, striking a random healthy monster cell. Marks cannot be placed on Overheal or empty cells. Costs 1 Energy per position.",
    counter:
        "Gain one Counter Turn per position. After the monster completes an attack, you interrupt the turn order and get an extra Attack turn. No Energy regeneration during that extra turn. Costs exactly 1.5 Energy per position. Requires 2-6 positions. No pattern needed.",
    curse:
        "Mark healthy monster cells. When a marked cell is damaged, it also damages its up, down, left, and right neighbors. Explosions can trigger other marked cells in a chain. Costs exactly 1.5 Energy per position. Requires 2-6 positions.",
    weaken:
        "Reduce the monster's next damage by one per position. Weaken stacks; if it absorbs the whole D10 roll, the monster skips its turn. Costs exactly 1.5 Energy per position. Requires 2-6 positions. No pattern needed."
};

function getCardRule(type) {
    return CARD_RULES[type] || null;
}

function isCardTypeValidForAssignment(type) {
    if (!activeAssignment) return true;

    const rule = getCardRule(type);
    if (!rule) return true;

    return activeAssignment.targetCount >= rule.min &&
        activeAssignment.targetCount <= rule.max;
}

function getCardEnergyCost(type, count) {
    const rule = getCardRule(type);
    return rule ? rule.cost(count) : (type === "rage" ? 0 : count);
}

function getCardTypes() {
    return CARD_TYPES_BY_CLASS[currentPlayerClass] || [];
}

function cardUsesPattern(type) {
    return PATTERN_TYPES.includes(type);
}


/* =====================================
   ENERGY ICON  (public/assets/energy.png)
===================================== */

// One lightning-bolt icon. Sized with the --energy-icon-size CSS variable.
function createEnergyIcon() {
    const icon = document.createElement("span");
    icon.className = "energy-icon";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", "Energy");
    return icon;
}

// Fills a container with the Energy icon: one normally, three when the
// player has overflowed past the normal 9 Energy cap.
function setEnergyIcons(container, overflow) {
    if (!container) return;

    const count = overflow ? 3 : 1;
    if (Number(container.dataset.count) === count) return;

    container.dataset.count = String(count);
    container.classList.toggle("is-overflow", overflow);
    container.replaceChildren(
        ...Array.from({ length: count }, () => createEnergyIcon())
    );
}

// "⚡: 3" style label used on cards and pickers.
function createEnergyLabel(amount) {
    const label = document.createElement("span");
    label.className = "energy-label";
    label.append(createEnergyIcon(), document.createTextNode(`: ${amount}`));
    return label;
}


/* =====================================
   EXTRA STYLES FOR NEW CARD TYPES
===================================== */

(function injectStyles() {
    const style = document.createElement("style");

    style.textContent = `
        .combat-card-type.buff { color: #8a5a00; opacity: 1; }
        .combat-card-type.rage { color: #b02a2a; opacity: 1; }
        .combat-card-type.taunt { color: #5a3d99; opacity: 1; }
        .combat-card-type.status { color: #2f7d32; opacity: 1; }
        .combat-card-type.lifesteal { color: #c0396b; opacity: 1; }
        .combat-card-type.retaliate { color: #b58a00; opacity: 1; }
        .combat-card-type.counter { color: #2878a8; opacity: 1; }
        .combat-card-type.weaken { color: #54728a; opacity: 1; }

        .combat-card-button.status-card.selected {
            border-color: #4c9a50;
            background: rgba(76, 154, 80, 0.1);
        }
        .combat-card-button.rage-card.selected {
            border-color: var(--red);
            background: rgba(217, 72, 72, 0.08);
        }
        .combat-card-button.buff-card.selected {
            border-color: #d49a1a;
            background: rgba(212, 154, 26, 0.1);
        }
        .combat-card-button.taunt-card.selected {
            border-color: #7a5bc4;
            background: rgba(122, 91, 196, 0.1);
        }
        .combat-card-button.lifesteal-card.selected {
            border-color: #c0396b;
            background: rgba(192, 57, 107, 0.1);
        }
        .combat-card-button.retaliate-card.selected {
            border-color: #d5ad20;
            background: rgba(213, 173, 32, 0.12);
        }

        #heart-grid.rage-targeting .grid-cell.target-preview {
            outline-color: var(--red);
            background: var(--red-light);
            box-shadow: 0 0 10px rgba(217, 72, 72, 0.55);
        }
        #heart-grid.retaliate-targeting .grid-cell.target-preview {
            outline-color: #e2bd24;
            background: rgba(255, 220, 65, 0.35);
            box-shadow: 0 0 10px rgba(226, 189, 36, 0.55);
        }
        #monster-grid.lifesteal-targeting .grid-cell.target-preview {
            outline-color: #c0396b;
            background: rgba(192, 57, 107, 0.2);
            box-shadow: 0 0 10px rgba(192, 57, 107, 0.45);
        }
        .grid-cell.retaliate-mark {
            outline: 2px solid #e2bd24;
            outline-offset: -3px;
            background: rgba(255, 220, 65, 0.5) !important;
            box-shadow: inset 0 0 0 2px rgba(226, 189, 36, 0.5);
        }

        .card-count-badge {
            display: grid;
            place-items: center;
            flex-shrink: 0;
            width: 65px;
            height: 65px;
            border: 1px solid #888;
            border-radius: 8px;
            font-size: 26px;
            font-weight: bold;
        }

        .taunt-banner {
            margin: 0 0 15px;
            padding: 10px 12px;
            border-left: 3px solid #7a5bc4;
            background: rgba(122, 91, 196, 0.1);
            font-size: 12px;
            font-weight: bold;
        }

        .thief-status-panel {
            margin-bottom: 18px;
            padding: 14px;
            border: 1px solid #888;
            border-radius: 8px;
        }
        .thief-status-panel p {
            margin: 0 0 12px;
            font-size: 12px;
            line-height: 1.6;
        }

        #buff-confirm-button {
            margin-top: 12px;
        }

        .party-member.dead {
            opacity: 0.65;
        }

        .revive-button {
            padding: 8px 12px;
            border: 1px solid #3a8f5c;
            border-radius: 6px;
            background: transparent;
            color: #3a8f5c;
            font-size: 10px;
            letter-spacing: 1px;
            cursor: pointer;
        }
        .revive-button:hover {
            background: #3a8f5c;
            color: white;
        }
        .party-member .revive-button {
            display: block;
            margin: 8px auto 0;
        }
    `;

    document.head.appendChild(style);
})();


/* =====================================
   GAME SCREENS
===================================== */

const splashScreen = document.getElementById("onyro-splash");
const gameTitle = document.getElementById("game-title");
const gameContent = document.getElementById("game-content");

const roleScreen = document.getElementById("role-screen");
const hostScreen = document.getElementById("host-screen");
const playerScreen = document.getElementById("player-screen");

let gameReady = false;
let gameStarted = false;

window.addEventListener("load", () => {
    setTimeout(() => {
        splashScreen?.classList.remove("active");
        gameTitle?.classList.add("active");
        gameReady = true;
    }, 2500);
});

function startGame() {
    if (!gameReady || gameStarted) return;

    gameStarted = true;
    gameReady = false;

    gameTitle?.classList.remove("active");

    setTimeout(() => {
        gameContent?.classList.add("active");
    }, 800);
}

document.addEventListener("keydown", event => {
    if (event.repeat) return;
    startGame();
});

gameTitle?.addEventListener("pointerdown", startGame);


/* =====================================
   PANEL NAVIGATION
===================================== */

function showPanel(panel) {
    document.querySelectorAll(".panel-screen").forEach(screen => {
        screen.classList.remove("active");
    });

    panel?.classList.add("active");
}

document.getElementById("host-role-button")?.addEventListener("click", () => {
    showPanel(hostScreen);
});

document.getElementById("player-role-button")?.addEventListener("click", () => {
    showPanel(playerScreen);
});

document.querySelectorAll(".back-button").forEach(button => {
    button.addEventListener("click", () => {
        showPanel(roleScreen);
        clearCardPreview();
        cancelCardTargeting(false);
    });
});


/* =====================================
   PLAYER TABS
===================================== */

const playerTabs = document.querySelectorAll(".player-tab");
const playerTabContents = document.querySelectorAll(".player-tab-content");

playerTabs.forEach(button => {
    button.addEventListener("click", () => {
        const tabName = button.dataset.tab;

        playerTabs.forEach(tab => tab.classList.remove("active"));
        playerTabContents.forEach(content => content.classList.remove("active"));

        button.classList.add("active");

        document.getElementById(`${tabName}-tab`)?.classList.add("active");
    });
});


/* =====================================
   ROOM STATE
===================================== */

let currentRoomID = null;
let currentRole = null;
let currentPlayerID = null;
let currentPlayerClass = null;

let roomPlayers = [];
let activeAssignment = null;
let savedCards = [];
let myStatus = null;
let myMarks = [];
let myCounterTurns = 0;

let playerGridSize = 3;
let playerGridCells = Array(9).fill("hp");

let currentEncounter = null;
let monsterAttackRoll = null;

let selectedTargetPositions = new Set();

function isMyTurn() {
    const turn = currentEncounter?.currentTurn;

    return Boolean(
        currentEncounter?.active &&
        turn?.type === "player" &&
        turn.id === currentPlayerID
    );
}

function isMyCounterTurn() {
    return Boolean(
        isMyTurn() &&
        currentEncounter?.currentTurn?.counter
    );
}


/* =====================================
   HOST ELEMENTS
===================================== */

const createRoomButton = document.getElementById("create-room-button");
const hostRoomInfo = document.getElementById("host-room-info");
const hostRoomID = document.getElementById("host-room-id");
const hostPlayerCount = document.getElementById("host-player-count");
const hostRoomMessage = document.getElementById("host-room-message");

const hostPlayerList = document.getElementById("host-player-list");

const assignmentPlayer = document.getElementById("assignment-player");
const hostTargetCount = document.getElementById("host-target-count");
const issueAssignmentButton = document.getElementById("issue-assignment-button");
const hostMessage = document.getElementById("host-message");


/* =====================================
   HOST: CREATE ROOM
===================================== */

createRoomButton?.addEventListener("click", () => {
    if (currentRoomID) return;

    createRoomButton.disabled = true;
    hostRoomMessage.textContent = "Creating room...";

    socket.emit("create-room");
});

socket.on("room-created", data => {
    currentRoomID = data.roomID;
    currentRole = "host";

    hostRoomID.textContent = data.roomID;
    hostRoomInfo.hidden = false;

    createRoomButton.textContent = "ROOM CREATED";
    hostRoomMessage.textContent = "Waiting for players to join...";

    renderHostLobby();
});


/* =====================================
   HOST: ROOM UPDATES
===================================== */

socket.on("room-state", state => {
    if (currentRole !== "host") return;

    roomPlayers = state.players || [];

    hostPlayerCount.textContent =
        `Players: ${roomPlayers.length} / 5`;

    renderHostLobby();
});


// A player is dead when their grid has no HP or Overheal left.
function isDeadPlayer(player) {
    return Boolean(player?.grid) && !player.grid.some(
        cell => cell === "hp" || cell === "overheal"
    );
}


// Host-only button that revives a dead player after a confirmation.
function createReviveButton(player) {
    const button = document.createElement("button");

    button.type = "button";
    button.className = "revive-button";
    button.textContent = "REVIVE";

    button.addEventListener("click", () => {
        const confirmed = window.confirm(
            `Revive ${player.username}?\n\n` +
            "They return with full HP and 5 Energy, and keep their cards."
        );

        if (!confirmed) return;

        socket.emit("revive-player", { playerID: player.id });
    });

    return button;
}


function renderHostLobby() {
    hostPlayerList.innerHTML = "";

    if (roomPlayers.length === 0) {
        hostPlayerList.innerHTML =
            '<p class="empty-message">Waiting for players...</p>';
    }

    roomPlayers.forEach(player => {
        const item = document.createElement("div");
        item.className = "lobby-player";

        const identity = document.createElement("strong");
        identity.textContent = player.username;

        const cardDetails = [];
        if (player.className === "Thief" && player.status?.remainingTurns) {
            cardDetails.push(`Poison ${player.status.remainingTurns}`);
        }
        if (player.counterTurns > 0) {
            cardDetails.push(`Counter ${player.counterTurns}`);
        }
        const cardText =
            `${player.cardCount}/4 Cards` +
            (cardDetails.length ? ` · ${cardDetails.join(" · ")}` : "");

        const dead = isDeadPlayer(player);

        const details = document.createElement("span");
        details.textContent =
            `${player.className} · ${cardText} · ` +
            `${player.hasAssignment ? "Assignment pending" : "No assignment"}` +
            (dead ? " · DEAD" : "");

        item.append(identity, details);

        if (dead) {
            item.appendChild(createReviveButton(player));
        }

        hostPlayerList.appendChild(item);
    });

    updateAssignmentPlayerOptions();
    updateMonsterTargetOptions();
    renderHostPartyGrids();
}


function updateAssignmentPlayerOptions() {
    const previousValue = assignmentPlayer.value;

    assignmentPlayer.innerHTML = "";

    const eligiblePlayers = roomPlayers.filter(player =>
        !player.hasAssignment &&
        player.cardCount < 4
    );

    if (eligiblePlayers.length === 0) {
        const option = document.createElement("option");
        option.value = "";

        option.textContent = roomPlayers.length === 0
            ? "Waiting for players"
            : "No eligible players";

        assignmentPlayer.appendChild(option);
        assignmentPlayer.disabled = true;

    } else {
        const placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "Select a player";

        assignmentPlayer.appendChild(placeholder);

        eligiblePlayers.forEach(player => {
            const option = document.createElement("option");

            option.value = player.id;
            option.textContent =
                `${player.username} (${player.className})`;

            assignmentPlayer.appendChild(option);
        });

        assignmentPlayer.disabled = false;

        if (eligiblePlayers.some(player => player.id === previousValue)) {
            assignmentPlayer.value = previousValue;
        }
    }

    updateIssueButton();
}


/* =====================================
   HOST: ISSUE CARD ASSIGNMENT
===================================== */

function updateIssueButton() {
    const targetCount = Number(hostTargetCount.value);

    issueAssignmentButton.disabled =
        !currentRoomID ||
        !assignmentPlayer.value ||
        !Number.isInteger(targetCount) ||
        targetCount < 2 ||
        targetCount > 7;
}

assignmentPlayer?.addEventListener("change", updateIssueButton);
hostTargetCount?.addEventListener("change", updateIssueButton);

issueAssignmentButton?.addEventListener("click", () => {
    if (!currentRoomID || !assignmentPlayer.value) return;

    const targetCount = Number(hostTargetCount.value);

    if (targetCount < 2 || targetCount > 7) return;

    socket.emit("issue-assignment", {
        playerID: assignmentPlayer.value,
        targetCount
    });

    issueAssignmentButton.disabled = true;
    hostMessage.textContent = "Sending assignment...";
});

socket.on("assignment-success", message => {
    hostMessage.textContent = message;
    hostTargetCount.value = "";
    updateIssueButton();
});

socket.on("assignment-error", message => {
    hostMessage.textContent = message;
    updateAssignmentPlayerOptions();
});


/* =====================================
   PLAYER REGISTRATION
===================================== */

const joinRoomInput = document.getElementById("join-room-input");
const playerUsernameInput = document.getElementById("player-username");
const playerClassSelect = document.getElementById("player-class");

const joinRoomButton = document.getElementById("join-room-button");
const playerRoomMessage = document.getElementById("player-room-message");

const playerRegistration = document.getElementById("player-registration");
const playerLobbyInfo = document.getElementById("player-lobby-info");
const playerIdentity = document.getElementById("player-identity");
const playerRoomStatus = document.getElementById("player-room-status");
const playerGameArea = document.getElementById("player-game-area");

const playerAssignmentStatus =
    document.getElementById("player-assignment-status");

let availabilityTimer = null;
let availableClasses = [];


/* =====================================
   PLAYER: CHECK ROOM
===================================== */

joinRoomInput?.addEventListener("input", () => {
    clearTimeout(availabilityTimer);

    const roomID = joinRoomInput.value.trim().toUpperCase();

    availableClasses = [];
    joinRoomButton.disabled = true;

    playerRoomMessage.textContent = "Checking room...";

    availabilityTimer = setTimeout(() => {
        if (roomID.length === 6) {
            socket.emit("check-room", roomID);
        } else {
            playerRoomMessage.textContent = "";
            joinRoomButton.disabled = false;
            resetClassOptions();
        }
    }, 300);
});


function resetClassOptions() {
    const classes = ["Tank", "Warrior", "Mage", "Support", "Thief"];

    playerClassSelect.innerHTML =
        '<option value="" selected disabled>Choose a class</option>';

    classes.forEach(className => {
        const option = document.createElement("option");

        option.value = className;
        option.textContent = className;

        playerClassSelect.appendChild(option);
    });
}


socket.on("room-availability", data => {
    availableClasses = data.availableClasses || [];

    if (!data.exists) {
        playerRoomMessage.textContent = "Room does not exist.";
        joinRoomButton.disabled = false;
        resetClassOptions();
        return;
    }

    const previousValue = playerClassSelect.value;

    playerClassSelect.innerHTML =
        '<option value="" selected disabled>Choose an available class</option>';

    ["Tank", "Warrior", "Mage", "Support", "Thief"].forEach(className => {
        const option = document.createElement("option");

        option.value = className;

        if (availableClasses.includes(className)) {
            option.textContent = className;
        } else {
            option.textContent = `${className} — Taken`;
            option.disabled = true;
        }

        playerClassSelect.appendChild(option);
    });

    if (availableClasses.includes(previousValue)) {
        playerClassSelect.value = previousValue;
    }

    playerRoomMessage.textContent =
        `${availableClasses.length} class(es) available.`;

    joinRoomButton.disabled = false;
});


/* =====================================
   PLAYER: JOIN ROOM
===================================== */

joinRoomButton?.addEventListener("click", () => {
    if (currentRoomID) return;

    const roomID = joinRoomInput.value.trim().toUpperCase();
    const username = playerUsernameInput.value.trim();
    const className = playerClassSelect.value;

    if (roomID.length !== 6) {
        playerRoomMessage.textContent =
            "Enter a valid six-character Room ID.";
        return;
    }

    if (!username || !className) {
        playerRoomMessage.textContent =
            "Enter a username and select a class.";
        return;
    }

    if (!availableClasses.includes(className)) {
        playerRoomMessage.textContent =
            "That class is not available.";
        return;
    }

    joinRoomButton.disabled = true;
    playerRoomMessage.textContent = "Joining room...";

    socket.emit("join-room", {
        roomID,
        username,
        className
    });
});


socket.on("room-joined", data => {
    currentRoomID = data.roomID;
    currentRole = "player";
    currentPlayerID = data.player.id;
    currentPlayerClass = data.player.className;

    playerRegistration.hidden = true;
    playerLobbyInfo.hidden = false;
    playerGameArea.hidden = false;

    playerIdentity.textContent =
        `${data.player.username} · ${data.player.className}`;

    playerRoomStatus.textContent =
        `Room ID: ${data.roomID} · Connected`;

    playerRoomMessage.textContent = "Joined successfully.";

    playerAssignmentStatus.textContent =
        "Waiting for a Host assignment.";

    updateCardTypeVisibility();
    renderCombatCards();
});


socket.on("join-error", message => {
    playerRoomMessage.textContent = message;
    joinRoomButton.disabled = false;
});


/* =====================================
   PLAYER: RECEIVE OWN STATE
===================================== */

socket.on("player-state", state => {
    if (currentRole !== "player") return;

    activeAssignment = state.assignment;
    savedCards = state.cards || [];
    myStatus = state.status || null;
    myMarks = state.marks || [];
    myCounterTurns = state.counterTurns || 0;

    playerGridSize = state.gridSize;
    playerGridCells = state.grid || [];

    if (
        selectedCombatCard &&
        !savedCards.some(card => card.id === selectedCombatCard.id)
    ) {
        cancelCardTargeting(false);
    }

    renderPlayerGrid();
    renderSavedCards();
    renderCombatCards();
    updatePlayerAssignment();
    refreshCombatStatusLine();
});


/* =====================================
   PLAYER: RECEIVE ASSIGNMENT
===================================== */

socket.on("assignment-received", assignment => {
    if (currentRole !== "player") return;

    activeAssignment = assignment;
    selectedPositions.clear();

    cardNameInput.value = "";
    cardMessage.textContent = "";

    updateCardTypeVisibility();
    updateCardTypeDescription();

    updatePlayerAssignment();
    updateCardGrid();
});


function updatePlayerAssignment() {
    if (!activeAssignment) {
        playerAssignmentStatus.textContent =
            "Waiting for a Host assignment.";

        cardSelectionCount.textContent =
            "Waiting for assignment.";

        updateCardGrid();
        return;
    }

    if (savedCards.length >= 4) {
        playerAssignmentStatus.textContent =
            "Your inventory is full. Discard a card before creating another.";

        updateCardGrid();
        return;
    }

    playerAssignmentStatus.textContent =
        `HOST ASSIGNED YOU ${activeAssignment.targetCount} TARGET POSITIONS.`;

    updateCardGrid();
}


/* =====================================
   CARD CREATOR
===================================== */

const cardNameInput = document.getElementById("card-name");
const cardSelectionCount = document.getElementById("card-selection-count");
const cardGrid = document.getElementById("card-grid");

const saveCardButton = document.getElementById("save-card-button");
const cardMessage = document.getElementById("card-message");

const cardTypeContainer = document.getElementById("card-type-container");
const cardTypeSelect = document.getElementById("card-type");
const cardTypeDescription = document.getElementById("card-type-description");

const savedCardsContainer = document.getElementById("saved-cards");
const cardInventoryCount = document.getElementById("card-inventory-count");

const cardCreatorSection = cardNameInput?.closest(".player-section");

let selectedPositions = new Set();


function canCreateHealCards() {
    return ["Support", "Mage"].includes(currentPlayerClass);
}


function getSelectedCardType() {
    const types = getCardTypes();

    if (types.length === 0) return null;

    if (
        types.includes(cardTypeSelect.value) &&
        isCardTypeValidForAssignment(cardTypeSelect.value)
    ) {
        return cardTypeSelect.value;
    }

    return types.find(isCardTypeValidForAssignment) || null;
}


function updateCardTypeVisibility() {
    const types = getCardTypes();
    const previousType = cardTypeSelect.value;

    cardTypeSelect.innerHTML = "";

    types.forEach(type => {
        const option = document.createElement("option");
        const rule = getCardRule(type);
        const valid = isCardTypeValidForAssignment(type);

        option.value = type;
        option.disabled = !valid;
        option.textContent = rule
            ? `${CARD_TYPE_OPTION_NAMES[type]} (${rule.min}-${rule.max} positions)`
            : CARD_TYPE_OPTION_NAMES[type];

        cardTypeSelect.appendChild(option);
    });

    const validTypes = types.filter(isCardTypeValidForAssignment);
    if (validTypes.includes(previousType)) {
        cardTypeSelect.value = previousType;
    } else if (validTypes.length > 0) {
        cardTypeSelect.value = validTypes[0];
    } else if (types.length > 0) {
        cardTypeSelect.value = types[0];
    }

    cardTypeContainer.hidden = types.length < 2;
    if (cardCreatorSection) {
        cardCreatorSection.hidden = types.length === 0;
    }

    updateCardTypeDescription();
    updatePlayerAssignment();
    updateCardGrid();
    checkCardValidity();
}


function updateCardTypeDescription() {
    const type = getSelectedCardType();

    cardTypeDescription.textContent =
        type ? CARD_TYPE_DESCRIPTIONS[type] : "";
}


cardTypeSelect?.addEventListener("change", () => {
    selectedPositions.clear();
    updateCardTypeDescription();
    updateCardGrid();
    checkCardValidity();
});


function createCardGrid() {
    cardGrid.innerHTML = "";
    cardGrid.style.gridTemplateColumns = "repeat(3, 1fr)";

    for (let i = 0; i < 9; i++) {
        const cell = document.createElement("button");

        cell.type = "button";
        cell.className = "card-cell";
        cell.setAttribute("aria-label", `Position ${i + 1}`);

        cell.addEventListener("click", () => {
            if (!activeAssignment || savedCards.length >= 4) return;

            if (selectedPositions.has(i)) {
                selectedPositions.delete(i);
            } else if (selectedPositions.size < activeAssignment.targetCount) {
                selectedPositions.add(i);
            }

            updateCardGrid();
        });

        cardGrid.appendChild(cell);
    }

    updateCardGrid();
}


function updateCardGrid() {
    const usesPattern = cardUsesPattern(getSelectedCardType());

    // Buff and Taunt cards only use the number of positions.
    cardGrid.hidden = !usesPattern;

    Array.from(cardGrid.children).forEach((cell, index) => {
        const selected = selectedPositions.has(index);

        cell.classList.toggle("selected", selected);

        cell.disabled =
            !activeAssignment ||
            savedCards.length >= 4;

        cell.setAttribute(
            "aria-label",
            `Position ${index + 1}${selected ? ": Selected" : ""}`
        );
    });

    updateCardCounter();
}


function updateCardCounter() {
    const type = getSelectedCardType();

    if (!activeAssignment) {
        cardSelectionCount.textContent =
            "Waiting for assignment.";
    } else if (!cardUsesPattern(type)) {
        const count = activeAssignment.targetCount;

        const cost = getCardEnergyCost(type, count);
        const rule = getCardRule(type);

        if (rule && !isCardTypeValidForAssignment(type)) {
            cardSelectionCount.textContent =
                `${CARD_TYPE_OPTION_NAMES[type]} requires ${rule.min}-${rule.max} positions. ` +
                `This assignment has ${count}. Choose another card type.`;
        } else if (type === "buff") {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Gives a teammate ${count} Energy and costs ${cost} Energy.`;
        } else if (type === "status") {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Poisons the monster for ${count} turns and costs ${cost} Energy.`;
        } else if (type === "taunt") {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Soaks ${count} monster hits and costs ${cost} Energy.`;
        } else if (type === "counter") {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Grants ${count} Counter Turns and costs ${cost} Energy.`;
        } else if (type === "weaken") {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Adds ${count} Weaken and costs ${cost} Energy.`;
        } else {
            cardSelectionCount.textContent =
                `Assigned: ${count} positions. Energy cost: ${cost}.`;
        }
    } else {
        cardSelectionCount.textContent =
            `Selected: ${selectedPositions.size} / ${activeAssignment.targetCount}`;
    }

    checkCardValidity();
}


function checkCardValidity() {
    const type = getSelectedCardType();
    const hasName = cardNameInput.value.trim().length > 0;

    const hasCorrectTargets =
        activeAssignment &&
        (
            !cardUsesPattern(type) ||
            selectedPositions.size === activeAssignment.targetCount
        );

    saveCardButton.disabled =
        !activeAssignment ||
        savedCards.length >= 4 ||
        !hasName ||
        !hasCorrectTargets ||
        !type ||
        !isCardTypeValidForAssignment(type);
}


cardNameInput?.addEventListener("input", checkCardValidity);


/* =====================================
   PLAYER: SAVE CARD
===================================== */

saveCardButton?.addEventListener("click", () => {
    if (!activeAssignment || savedCards.length >= 4) return;

    const type = getSelectedCardType();

    if (!type) return;

    const name = cardNameInput.value.trim();

    const pattern = cardUsesPattern(type)
        ? Array.from(selectedPositions).sort((a, b) => a - b)
        : [];

    if (
        !name ||
        (cardUsesPattern(type) &&
            pattern.length !== activeAssignment.targetCount)
    ) {
        return;
    }

    saveCardButton.disabled = true;
    cardMessage.textContent = "Saving card...";

    socket.emit("save-card", {
        name,
        pattern,
        type
    });
});


socket.on("card-saved", card => {
    if (!savedCards.some(item => item.id === card.id)) {
        savedCards.push(card);
    }

    activeAssignment = null;
    selectedPositions.clear();

    cardNameInput.value = "";

    updateCardTypeVisibility();

    cardMessage.textContent = "CARD CREATED SUCCESSFULLY!";

    updateCardTypeDescription();
    renderSavedCards();
    renderCombatCards();
    updatePlayerAssignment();
});


socket.on("card-save-error", message => {
    cardMessage.textContent = message;
    updateCardGrid();
});


/* =====================================
   PLAYER: DISCARD CARD
===================================== */

function discardCard(cardID) {
    const confirmed = window.confirm(
        "Are you sure you want to discard this card?"
    );

    if (!confirmed) return;

    socket.emit("discard-card", cardID);
}


socket.on("card-discarded", card => {
    savedCards = savedCards.filter(item => item.id !== card.id);

    if (selectedCombatCard?.id === card.id) {
        cancelCardTargeting(false);
    }

    renderSavedCards();
    renderCombatCards();
    updatePlayerAssignment();
});


socket.on("card-discard-error", message => {
    cardMessage.textContent = message;
});


/* =====================================
   CARD TEXT HELPERS
===================================== */

function describeCardEffect(card) {
    const n = card.targetCount;

    const cost = getCardEnergyCost(card.type, n);

    switch (card.type) {
        case "buff":
            return `Give ${n} Energy · costs ${cost}`;
        case "taunt":
            return `Soak ${n} hits · costs ${cost}`;
        case "status":
            return `Poison ${n} turns · costs ${cost}`;
        case "rage":
            return `Sacrifice ${n} positions · gain ${n * RAGE_ENERGY_PER_POSITION} Energy`;
        case "lifesteal":
            return `Deal damage, then heal for successful damage · costs ${cost}`;
        case "retaliate":
            return `Mark ${n} HP positions · retaliate once per mark · costs ${cost}`;
        case "counter":
            return `${n} Counter Turns · costs ${cost}`;
        case "curse":
            return `Mark ${n} monster cells · chain explosions · costs ${cost}`;
        case "weaken":
            return `Add ${n} Weaken · costs ${cost}`;
        default:
            return `${n} Target Positions · costs ${cost}`;
    }
}


/* =====================================
   COMPACT ICON CARD FACE
===================================== */

function createCompactCardFace(card) {
    const face = document.createElement("div");
    face.className = "compact-card-face";

    const pattern = document.createElement("div");
    pattern.className = "compact-card-pattern";

    if (cardUsesPattern(card.type)) {
        for (let i = 0; i < 9; i++) {
            const cell = document.createElement("i");
            if ((card.pattern || []).includes(i)) cell.classList.add("active");
            pattern.appendChild(cell);
        }
    } else {
        pattern.classList.add("count-only");
        pattern.textContent = String(card.targetCount ?? 0);
    }

    const energy = document.createElement("span");
    energy.className = "compact-card-energy";
    energy.append(createEnergyLabel(getCardEnergyCost(card.type, card.targetCount)));

    const icon = document.createElement("img");
    icon.className = "compact-card-icon";
    icon.src = `/assets/${card.type}.png`;
    icon.alt = "";
    icon.draggable = false;
    icon.onerror = () => {
        icon.replaceWith(Object.assign(document.createElement("span"), {
            className: "compact-card-icon-fallback",
            textContent: (card.type || "card").toUpperCase()
        }));
    };

    face.append(pattern, energy, icon);
    return face;
}


/* =====================================
   RENDER SAVED CARDS
===================================== */

function renderSavedCards() {
    savedCardsContainer.innerHTML = "";

    cardInventoryCount.textContent =
        `${savedCards.length} / 4 CARDS`;

    if (savedCards.length === 0) {
        savedCardsContainer.innerHTML =
            '<p class="empty-message">No cards created yet.</p>';

        return;
    }

    savedCards.forEach(card => {
        const cardElement = document.createElement("div");
        cardElement.className = "saved-card";

        const info = document.createElement("div");
        info.className = "saved-card-info";

        const title = document.createElement("h3");
        title.textContent = card.name;
        info.append(title);

        const preview = createCompactCardFace(card);
        attachCardZoom(preview, card, { host: cardElement });

        const discardButton = document.createElement("button");

        discardButton.type = "button";
        discardButton.className = "discard-card-button";
        discardButton.textContent = "DISCARD";

        discardButton.addEventListener("click", event => {
            event.stopPropagation();
            discardCard(card.id);
        });

        cardElement.addEventListener("mouseenter", () => {
            previewCardPattern(card);
        });

        cardElement.addEventListener("mouseleave", clearCardPreview);

        cardElement.append(info, preview, discardButton);
        savedCardsContainer.appendChild(cardElement);
    });

    updateCardGrid();
}


function createCardPreview(card) {
    // Non-targeting cards (Buff, Taunt, Status, Counter, Weaken) show a count.
    if (!cardUsesPattern(card.type)) {
        const badge = document.createElement("div");

        badge.className = "card-count-badge";
        badge.textContent = card.targetCount;

        return badge;
    }

    const preview = document.createElement("div");
    preview.className = "card-preview-grid";

    for (let i = 0; i < 9; i++) {
        const cell = document.createElement("div");
        cell.className = "card-preview-cell";

        if (card.pattern.includes(i)) {
            cell.classList.add("selected");
        }

        preview.appendChild(cell);
    }

    return preview;
}


/* =====================================
   CARD TARGET PREVIEW ON OWN GRID
===================================== */

function previewCardPattern(card) {
    clearCardPreview();

    if (!cardUsesPattern(card.type)) return;

    card.pattern.forEach(position => {
        const cardRow = Math.floor(position / 3);
        const cardColumn = position % 3;

        const gridRow = Math.round(
            cardRow * (playerGridSize - 1) / 2
        );

        const gridColumn = Math.round(
            cardColumn * (playerGridSize - 1) / 2
        );

        const gridPosition =
            gridRow * playerGridSize + gridColumn;

        const cell = heartGrid.children[gridPosition];

        if (cell) {
            cell.classList.add("target-preview");
        }
    });
}


function clearCardPreview() {
    if (!heartGrid) return;

    Array.from(heartGrid.children).forEach(cell => {
        cell.classList.remove("target-preview");
    });
}


/* =====================================
   COMBAT ELEMENTS
===================================== */

const combatCardsContainer = document.getElementById("combat-cards");
const combatCardMessage = document.getElementById("combat-card-message");

const heartGrid = document.getElementById("heart-grid");
const monsterGrid = document.getElementById("monster-grid");

const partyGrids = document.getElementById("party-grids");
const hostPartyGrids = document.getElementById("host-party-grids");

const healTargetContainer = document.getElementById("heal-target-container");
const healTargetPlayerSelect = document.getElementById("heal-target-player");
const healTargetLabel =
    healTargetContainer?.querySelector("label");

let selectedCombatCard = null;
let lifestealTargetPhase = null;
let lifestealMonsterAnchor = null;

let hoveredMonsterAnchor = null;
let hoveredHealAnchor = null;

let selectedHealTargetID = null;

let combatAttackPending = false;


/* =====================================
   BUFF CONFIRM BUTTON
===================================== */

const buffConfirmButton = document.createElement("button");

buffConfirmButton.type = "button";
buffConfirmButton.id = "buff-confirm-button";
buffConfirmButton.className = "primary-button";
buffConfirmButton.textContent = "GIVE ENERGY";
buffConfirmButton.hidden = true;

healTargetContainer?.appendChild(buffConfirmButton);

buffConfirmButton.addEventListener("click", () => {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "buff" ||
        combatAttackPending ||
        !selectedHealTargetID
    ) {
        return;
    }

    const target = roomPlayers.find(
        player => player.id === selectedHealTargetID
    );

    combatAttackPending = true;

    socket.emit("player-buff", {
        cardID: selectedCombatCard.id,
        targetPlayerID: selectedHealTargetID
    });

    combatCardMessage.textContent =
        `Giving Energy to ${target?.username || "teammate"}...`;

    renderCombatCards();
});


/* =====================================
   THIEF STATUS CARD RESULTS
===================================== */

socket.on("player-status-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. Poison will hit the monster for ` +
            `${result.duration} turn(s).`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} poisoned the monster for ${result.duration} turn(s)!`;
    }
});


socket.on("player-revived", result => {
    const message =
        `${result.username} was revived with full HP and 5 Energy.`;

    if (result.playerID === currentPlayerID) {
        combatCardMessage.textContent =
            "The Host revived you! Full HP and 5 Energy.";
    } else if (currentRole === "player") {
        combatCardMessage.textContent = message;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;
    }
});


socket.on("revive-error", message => {
    if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;
    }
});


socket.on("thief-status-resolved", result => {
    const message = result.damage > 0
        ? `${result.thiefUsername}'s poison hit ${result.monsterName} for ` +
          `${result.damage} position(s).` +
          (result.expired ? " The poison has worn off." : ` ${result.remainingTurns} turn(s) left.`)
        : `${result.thiefUsername}'s poison found nothing left to damage.` +
          (result.expired ? " The poison has worn off." : "");

    if (currentRole === "player") {
        combatCardMessage.textContent = message;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;
    }
});


/* =====================================
   COMBAT STATUS LINE
===================================== */

function refreshCombatStatusLine() {
    const status = document.getElementById("combat-status");

    if (!status || !currentEncounter) return;

    let text = currentEncounter.active
        ? "COMBAT IN PROGRESS"
        : "Encounter waiting to start.";

    if (currentEncounter.active && currentEncounter.taunt) {
        text +=
            ` · TAUNT: the monster must hit ${currentEncounter.taunt.tankUsername} ` +
            `(${currentEncounter.taunt.remainingDamage} hit(s) left)`;
    }

    if (currentPlayerClass === "Thief" && myStatus?.type === "thief") {
        text += ` · POISON: ${myStatus.remainingTurns} turn(s) left`;
    }

    if (currentRole === "player" && myCounterTurns > 0) {
        text += ` · COUNTER READY: ${myCounterTurns} turn(s)`;
    }

    if ((currentEncounter.weaken || 0) > 0) {
        text += ` · WEAKEN: ${currentEncounter.weaken} monster attack position(s) will be negated`;
    }

    if (currentEncounter.currentTurn?.counter && currentEncounter.currentTurn.id === currentPlayerID) {
        text += " · COUNTER TURN: bonus Warrior action (no Energy regeneration)";
    }

    if (
        currentRole === "player" &&
        isDeadPlayer({ grid: playerGridCells })
    ) {
        text += " · YOU ARE DEAD: your turns are skipped until the Host revives you";
    }

    status.textContent = text;
    renderCombatOrder();
}


/* =====================================
   CALCULATE CARD TARGET POSITIONS
===================================== */

/*
    Cards ALWAYS use their original 3x3 coordinates.

    Position 4 is the center of the card.

    The pattern is never stretched to fit larger grids.
*/

function getCardTargetPositions(card, anchor, gridSize) {
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

    return positions;
}


/* =====================================
   TARGET PLAYER SELECTION (HEAL / BUFF)
===================================== */

function updateHealTargetOptions() {
    if (!healTargetPlayerSelect) return;

    const isBuff = selectedCombatCard?.type === "buff";

    const previousValue = selectedHealTargetID;

    healTargetPlayerSelect.innerHTML = "";

    // Buff can only go to teammates; Heal can include yourself.
    // The dead can't be targeted by either.
    const living = roomPlayers.filter(player => !isDeadPlayer(player));

    const candidates = isBuff
        ? living.filter(player => player.id !== currentPlayerID)
        : living;

    candidates.forEach(player => {
        const option = document.createElement("option");

        option.value = player.id;

        const energyText = isBuff ? ` · ${player.energy ?? 0} Energy` : "";

        option.textContent =
            player.id === currentPlayerID
                ? `${player.username} (YOU)`
                : `${player.username} (${player.className})${energyText}`;

        healTargetPlayerSelect.appendChild(option);
    });

    if (candidates.some(player => player.id === previousValue)) {
        selectedHealTargetID = previousValue;
    } else if (isBuff) {
        selectedHealTargetID = candidates[0]?.id || null;
    } else {
        selectedHealTargetID = currentPlayerID;
    }

    if (!candidates.some(player => player.id === selectedHealTargetID)) {
        selectedHealTargetID = candidates[0]?.id || null;
    }

    healTargetPlayerSelect.value = selectedHealTargetID || "";

    if (healTargetLabel) {
        healTargetLabel.textContent = isBuff ? "ENERGY TARGET" : "HEAL TARGET";
    }
}


healTargetPlayerSelect?.addEventListener("change", () => {
    selectedHealTargetID = healTargetPlayerSelect.value || null;

    hoveredHealAnchor = null;

    renderPlayerGrid();
    renderPlayerPartyGrids();
});


/* =====================================
   CANCEL CARD TARGETING
===================================== */

function cancelCardTargeting(showMessage = true) {
    endPlay();

    selectedCombatCard = null;
    lifestealTargetPhase = null;
    lifestealMonsterAnchor = null;

    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;

    selectedHealTargetID = null;
    combatAttackPending = false;

    if (healTargetContainer) healTargetContainer.hidden = true;
    buffConfirmButton.hidden = true;

    clearCombatTargetPreview();

    if (showMessage && combatCardMessage) {
        combatCardMessage.textContent = "Targeting cancelled.";
    }

    renderCombatCards();

    renderPlayerGrid();
    renderPlayerPartyGrids();

    if (currentEncounter) {
        renderCombatMonsterGrid();
    }
}


// Shared cleanup after one of my own actions resolves.
function finishOwnAction(message) {
    endPlay();

    combatCardMessage.textContent = message;

    selectedCombatCard = null;
    lifestealTargetPhase = null;
    lifestealMonsterAnchor = null;
    selectedHealTargetID = null;
    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;
    combatAttackPending = false;

    healTargetContainer.hidden = true;
    buffConfirmButton.hidden = true;

    clearCombatTargetPreview();

    renderCombatCards();
    renderCombatMonsterGrid();
    renderPlayerGrid();
    renderPlayerPartyGrids();
}


/* =====================================
   CLEAR TARGET PREVIEWS
===================================== */

function clearCombatTargetPreview() {
    document.querySelectorAll(
        "#monster-grid .grid-cell, " +
        "#heart-grid .grid-cell, " +
        "#party-grids .grid-cell"
    ).forEach(cell => {
        cell.classList.remove(
            "target-preview",
            "target-invalid"
        );
    });
}


/* =====================================
   MONSTER TARGET PREVIEW
===================================== */

function updateCombatTargetPreview(anchor) {
    clearCombatTargetPreview();

    if (
        !selectedCombatCard ||
        !["attack", "lifesteal", "curse"].includes(selectedCombatCard.type) ||
        !currentEncounter ||
        combatAttackPending
    ) {
        return;
    }

    hoveredMonsterAnchor = anchor;

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        currentEncounter.size
    );

    if (!positions) {
        monsterGrid.children[anchor]?.classList.add("target-invalid");
        return;
    }

    positions.forEach(position => {
        monsterGrid.children[position]?.classList.add("target-preview");
    });
}


/* =====================================
   HEAL / RAGE TARGET PREVIEW
===================================== */

function updateHealTargetPreview(anchor, gridSize, gridContainer) {
    clearCombatTargetPreview();

    if (
        !selectedCombatCard ||
        !( ["heal", "rage", "retaliate"].includes(selectedCombatCard.type) ||
           (selectedCombatCard.type === "lifesteal" && lifestealTargetPhase === "player") ) ||
        !currentEncounter?.active ||
        combatAttackPending
    ) {
        return;
    }

    hoveredHealAnchor = anchor;

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        gridSize
    );

    if (!positions) {
        gridContainer.children[anchor]?.classList.add("target-invalid");
        return;
    }

    positions.forEach(position => {
        const isLifestealHeal = selectedCombatCard.type === "lifesteal" && lifestealTargetPhase === "player";
        if (!isLifestealHeal || playerGridCells[position] === "empty") {
            gridContainer.children[position]?.classList.add("target-preview");
        }
    });
}


/* =====================================
   CONFIRM PLAYER ATTACK
===================================== */

function confirmPlayerAttack(anchor) {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "attack" ||
        !currentEncounter?.active ||
        combatAttackPending
    ) {
        return;
    }

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        currentEncounter.size
    );

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside the grid.";

        return;
    }

    combatAttackPending = true;

    socket.emit("player-attack", {
        cardID: selectedCombatCard.id,
        anchor
    });

    combatCardMessage.textContent =
        `Attacking with ${selectedCombatCard.name}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

function confirmMonsterPatternCard(anchor) {
    if (
        !selectedCombatCard ||
        !["lifesteal", "curse"].includes(selectedCombatCard.type) ||
        !currentEncounter?.active ||
        combatAttackPending
    ) return;

    const positions = getCardTargetPositions(selectedCombatCard, anchor, currentEncounter.size);
    if (!positions) {
        combatCardMessage.textContent = "Invalid placement. The pattern must fit inside the monster grid.";
        return;
    }

    if (selectedCombatCard.type === "lifesteal") {
        lifestealMonsterAnchor = anchor;
        lifestealTargetPhase = "player";
        hoveredMonsterAnchor = null;
        hoveredHealAnchor = null;
        combatCardMessage.textContent =
            `${selectedCombatCard.name}: STEP 2/2 — choose the empty positions on YOUR grid where healing may go. ` +
            `Only successful monster damage can be restored; no Overheal.`;
        clearCombatTargetPreview();
        renderCombatMonsterGrid();
        renderPlayerGrid();
        return;
    }

    combatAttackPending = true;
    socket.emit("player-curse", { cardID: selectedCombatCard.id, anchor });
    combatCardMessage.textContent = `Marking monster cells with ${selectedCombatCard.name}...`;
    clearCombatTargetPreview();
    renderCombatCards();
}

function confirmPlayerLifestealHeal(anchor) {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "lifesteal" ||
        lifestealTargetPhase !== "player" ||
        !Number.isInteger(lifestealMonsterAnchor) ||
        !currentEncounter?.active ||
        combatAttackPending
    ) return;

    const positions = getCardTargetPositions(selectedCombatCard, anchor, playerGridSize);
    if (!positions) {
        combatCardMessage.textContent = "Invalid placement. The healing pattern must fit inside your grid.";
        return;
    }

    const emptySelected = positions.filter(position => playerGridCells[position] === "empty");
    if (emptySelected.length === 0) {
        combatCardMessage.textContent = "Choose a pattern that includes at least one EMPTY position on your grid.";
        return;
    }

    combatAttackPending = true;
    socket.emit("player-lifesteal", {
        cardID: selectedCombatCard.id,
        monsterAnchor: lifestealMonsterAnchor,
        healAnchor: anchor
    });
    combatCardMessage.textContent = `Resolving ${selectedCombatCard.name}...`;
    clearCombatTargetPreview();
    renderCombatCards();
}


/* =====================================
   CONFIRM PLAYER HEAL
===================================== */

function confirmPlayerHeal(anchor, targetPlayer) {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "heal" ||
        !currentEncounter?.active ||
        combatAttackPending ||
        !targetPlayer
    ) {
        return;
    }

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        targetPlayer.gridSize
    );

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside the target's grid.";

        return;
    }

    combatAttackPending = true;

    socket.emit("player-heal", {
        cardID: selectedCombatCard.id,
        targetPlayerID: targetPlayer.id,
        anchor
    });

    combatCardMessage.textContent =
        `Healing ${targetPlayer.username}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}


/* =====================================
   CONFIRM PLAYER RAGE
===================================== */

function confirmPlayerRage(anchor) {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "rage" ||
        !currentEncounter?.active ||
        combatAttackPending
    ) {
        return;
    }

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        playerGridSize
    );

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside your grid.";

        return;
    }

    if (
        positions.some(position =>
            playerGridCells[position] !== "hp" &&
            playerGridCells[position] !== "overheal"
        )
    ) {
        combatCardMessage.textContent =
            "Rage can only sacrifice HP or Overheal positions.";

        return;
    }

    combatAttackPending = true;

    socket.emit("player-rage", {
        cardID: selectedCombatCard.id,
        anchor
    });

    combatCardMessage.textContent =
        `Unleashing ${selectedCombatCard.name}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

function confirmPlayerRetaliate(anchor) {
    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "retaliate" ||
        !currentEncounter?.active ||
        combatAttackPending
    ) {
        return;
    }

    const positions = getCardTargetPositions(
        selectedCombatCard,
        anchor,
        playerGridSize
    );

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside your grid.";
        return;
    }

    if (positions.some(position =>
        playerGridCells[position] !== "hp" ||
        myMarks.includes(position)
    )) {
        combatCardMessage.textContent =
            "Retaliate can only mark unmarked plain HP positions (not Overheal or empty cells).";
        return;
    }

    combatAttackPending = true;
    socket.emit("player-retaliate", {
        cardID: selectedCombatCard.id,
        anchor
    });

    combatCardMessage.textContent =
        `Setting ${selectedCombatCard.name} marks...`;

    clearCombatTargetPreview();
    renderCombatCards();
}


/* =====================================
   RENDER COMBAT MONSTER GRID
===================================== */

function renderCombatMonsterGrid() {
    if (!currentEncounter || !monsterGrid) return;

    const isMonsterPatternTarget =
        currentRole === "player" &&
        (["attack", "curse"].includes(selectedCombatCard?.type) ||
         (selectedCombatCard?.type === "lifesteal" && lifestealTargetPhase === "monster")) &&
        currentEncounter.active &&
        !combatAttackPending;

    monsterGrid.classList.toggle("targeting", isMonsterPatternTarget);
    monsterGrid.classList.toggle(
        "curse-targeting",
        isMonsterPatternTarget && selectedCombatCard?.type === "curse"
    );
    monsterGrid.classList.toggle(
        "lifesteal-targeting",
        isMonsterPatternTarget && selectedCombatCard?.type === "lifesteal"
    );

    renderGrid(
        monsterGrid,
        currentEncounter.grid,
        currentEncounter.size,
        {
            interactive: isMonsterPatternTarget,
            curses: new Set(currentEncounter.curses || []),
            fxKey: "monster",

            onHover: index => {
                updateCombatTargetPreview(index);
            },

            onClick: index => {
                if (selectedCombatCard?.type === "attack") {
                    confirmPlayerAttack(index);
                } else {
                    confirmMonsterPatternCard(index);
                }
            }
        }
    );

    if (
        isMonsterPatternTarget &&
        hoveredMonsterAnchor !== null
    ) {
        updateCombatTargetPreview(hoveredMonsterAnchor);
    }
}


/* =====================================
   LEAVE GRIDS
===================================== */

monsterGrid?.addEventListener("mouseleave", () => {
    if (!( ["attack", "curse"].includes(selectedCombatCard?.type) || (selectedCombatCard?.type === "lifesteal" && lifestealTargetPhase === "monster") )) return;

    hoveredMonsterAnchor = null;
    clearCombatTargetPreview();
});

heartGrid?.addEventListener("mouseleave", () => {
    if (!["heal", "rage", "retaliate"].includes(selectedCombatCard?.type) &&
        !(selectedCombatCard?.type === "lifesteal" && lifestealTargetPhase === "player")) return;

    hoveredHealAnchor = null;
    clearCombatTargetPreview();
});


/* =====================================
   COMBAT ERRORS
===================================== */

socket.on("combat-action-error", message => {
    combatAttackPending = false;

    combatCardMessage.textContent = message;

    if (isPlayOverlayOpen()) {
        // The card is already locked in: stay on the targeting screen and
        // let the player try a different spot / target.
        setOverlayMessage(message);
        refreshPlayOverlay();
    } else if (playLocked) {
        // A no-grid card the server refused: nothing was played.
        selectedCombatCard = null;
        endPlay();
    }

    renderCombatCards();
    renderCombatMonsterGrid();
    renderPlayerGrid();
    renderPlayerPartyGrids();
});


/* =====================================
   COMBAT RESULTS
===================================== */

socket.on("player-attack-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. ` +
            `${result.damage} monster HP removed.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName}. ` +
            `${result.damage} monster HP removed.`;
    }

    clearCombatTargetPreview();
    renderCombatMonsterGrid();
});


socket.on("player-heal-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. ` +
            `${result.healed ?? 0} HP restored · ${result.overhealed ?? 0} Overheal added.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName} on ${result.targetUsername}.`;
    }

    clearCombatTargetPreview();
});


socket.on("player-buff-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You gave ${result.energyTransferred} Energy to ${result.targetUsername}.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            result.targetPlayerID === currentPlayerID
                ? `${result.username} gave you ${result.energyTransferred} Energy!`
                : `${result.username} gave ${result.energyTransferred} Energy to ${result.targetUsername}.`;
    }
});


socket.on("player-rage-resolved", result => {
    const sacrificed =
        (result.healthSacrificed || 0) + (result.overhealSacrificed || 0);

    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. Sacrificed ${sacrificed} position(s), ` +
            `gained ${result.energyGained} Energy.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName} and gained ${result.energyGained} Energy.`;
    }
});


socket.on("player-taunt-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. The monster must hit you for ` +
            `${result.remainingDamage} more hit(s).`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} taunted the monster! (${result.remainingDamage} hit(s) forced)`;
    }
});


socket.on("player-lifesteal-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You used ${result.cardName}. ${result.damage} monster HP removed; ` +
            `${result.healed} HP restored.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName}: ${result.damage} damage, ` +
            `${result.healed} HP restored.`;
    }
    clearCombatTargetPreview();
    renderCombatMonsterGrid();
    renderPlayerGrid();
});

socket.on("player-retaliate-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You set ${result.marked} Retaliate mark(s). Each triggers once when damaged.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} marked ${result.marked} position(s) with ${result.cardName}.`;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent =
            `${result.username} prepared ${result.marked} hidden Retaliate mark(s).`;
    }
    renderPlayerGrid();
    renderPlayerPartyGrids();
});

socket.on("player-counter-resolved", result => {
    const message =
        `${result.username} gained ${result.added} Counter Turn(s). ` +
        `${result.counterTurns} now ready.`;

    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `Counter activated. ${result.counterTurns} Counter Turn(s) ready. ` +
            `After the monster attacks, you can make an additional Attack.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent = message;
    }
});

socket.on("player-curse-resolved", result => {
    if (result.playerID === currentPlayerID) {
        finishOwnAction(
            `You marked ${result.marked} monster cell(s) with Curse. Damaging them triggers chain explosions.`
        );
    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} cursed ${result.marked} monster position(s).`;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent =
            `${result.username} cursed ${result.marked} monster position(s).`;
    }
    renderCombatMonsterGrid();
});

socket.on("player-weaken-resolved", result => {
    const message =
        `${result.username} added ${result.added} Weaken. ` +
        `${result.weaken} total Weaken now active.`;

    if (result.playerID === currentPlayerID) {
        finishOwnAction(message);
    } else if (currentRole === "player") {
        combatCardMessage.textContent = message;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;
    }
});

socket.on("retaliate-triggered", result => {
    if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username}'s Retaliate triggered ${result.triggered} time(s), ` +
            `dealing ${result.damage} monster damage.`;
    }
    renderCombatMonsterGrid();
});

socket.on("counter-turn-started", result => {
    const message = result.playerID === currentPlayerID
        ? `COUNTER TURN! You have an extra Attack. ${result.counterTurnsLeft} Counter Turn(s) remain.`
        : `${result.username} is taking a Counter Turn.`;

    if (currentRole === "player") {
        combatCardMessage.textContent = message;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;
    }
});

socket.on("monster-weakened", result => {
    const message = result.skipped
        ? `${result.monsterName}'s attack was fully weakened. The monster skips its turn!`
        : `${result.monsterName}'s attack was reduced from ${result.roll} to ${result.effective}. ` +
          `${result.positionsNegated ?? result.absorbed} monster attack position(s) negated; ` +
          `${result.weakenLeft} Weaken remains.`;

    if (currentRole === "player") {
        combatCardMessage.textContent = message;
    } else if (currentRole === "host") {
        monsterEncounterMessage.textContent = message;

        if (result.skipped) {
            // Whole roll negated: nothing to target, so clear the roll UI.
            monsterAttackRoll = null;
            selectedTargetPositions.clear();
            monsterD10Result.textContent = "?";
            monsterAttackMessage.textContent = message;
        } else {
            monsterAttackMessage.textContent =
                `${message} Select a player and up to ${result.effective} target positions.`;
        }
    }
});


socket.on("monster-attack-resolved", result => {
    if (currentRole !== "player") return;

    combatCardMessage.textContent =
        `The monster hit ${result.username} for ` +
        `${result.positions.length} position(s).` +
        (result.tauntRemaining === 0 ? " The Taunt has ended." : "");

    clearCombatTargetPreview();
});


/* =====================================
   GRID ANIMATIONS (FX)
===================================== */

/*
    The server already changed the grids by the time these run, so every
    animation is drawn on top of the new state:

    - "ghost" effects lay a copy of the OLD cell over the new one and play it
      out (pop, fade, curse shake, rage, retaliate thump).
    - "popin" effects animate the new cell itself (heals).

    Grids get rebuilt from scratch on every update, so running effects are
    kept here and re-applied on each render at the point they are up to.
*/
const FX_POP_MS = 260;
const FX_FADE_MS = 1100;
const FX_RAGE_MS = 850;
const FX_THUMP_MS = 650;
const FX_POPIN_MS = 380;

// Curse: slow shake + grow, then a quick shrink. Long chains speed up.
const FX_CURSE_MS = 800;
const FX_CURSE_FAST_MS = 480;
const FX_CURSE_FULL_SPEED_STEPS = 3;

const fxRegistry = new Map(); // gridKey -> Map(index -> [effect])

const fxReducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;

function registerFx(gridKey, index, effect) {
    if (fxReducedMotion?.matches) return;

    if (!fxRegistry.has(gridKey)) {
        fxRegistry.set(gridKey, new Map());
    }

    const cells = fxRegistry.get(gridKey);

    if (!cells.has(index)) {
        cells.set(index, []);
    }

    cells.get(index).push({ ...effect, startedAt: performance.now() });
}

function getActiveFx(gridKey, index, now) {
    const cells = fxRegistry.get(gridKey);
    const effects = cells?.get(index);

    if (!effects) return [];

    const active = effects.filter(
        effect => now < effect.startedAt + effect.delay + effect.duration
    );

    if (active.length === 0) {
        cells.delete(index);

        if (cells.size === 0) fxRegistry.delete(gridKey);
    } else if (active.length !== effects.length) {
        cells.set(index, active);
    }

    return active;
}

function applyFxToCell(cell, gridKey, index, now) {
    getActiveFx(gridKey, index, now).forEach(effect => {
        // Negative when the effect has already started (the grid was rebuilt
        // part way through), so it carries on instead of restarting.
        const delay = Math.round(
            effect.delay - (now - effect.startedAt)
        );

        if (effect.kind === "popin") {
            cell.classList.add("fx-popin", `fx-popin-${effect.look}`);
            cell.style.setProperty("--fx-delay", `${delay}ms`);
            cell.style.setProperty("--fx-dur", `${effect.duration}ms`);
            return;
        }

        const ghost = document.createElement("span");
        const body = document.createElement("span");

        ghost.className = `fx-ghost fx-${effect.kind}`;
        body.className = `fx-body fx-look-${effect.look}`;

        ghost.setAttribute("aria-hidden", "true");
        ghost.style.setProperty("--fx-delay", `${delay}ms`);
        ghost.style.setProperty("--fx-dur", `${effect.duration}ms`);

        if (effect.kind === "rage") {
            ghost.style.setProperty(
                "--fx-from",
                effect.look === "overheal" ? "var(--blue)" : "var(--green)"
            );
        }

        ghost.appendChild(body);

        ghost.addEventListener("animationend", event => {
            if (event.target === ghost) ghost.remove();
        });

        cell.appendChild(ghost);
    });
}

/* ---------- Monster damage: attack, Lifesteal, Status, Retaliate ---------- */

socket.on("monster-damage-fx", data => {
    if (!data || !Array.isArray(data.steps)) return;

    // Each step starts once the cursed cells of the step before it have
    // finished shaking, so the chain reads in the order it happened.
    let startAt = 0;

    data.steps.forEach((step, stepIndex) => {
        const curseMs =
            stepIndex < FX_CURSE_FULL_SPEED_STEPS
                ? FX_CURSE_MS
                : FX_CURSE_FAST_MS;

        let hasCurse = false;

        step.cells.forEach(cell => {
            if (cell.cursed) {
                hasCurse = true;

                registerFx("monster", cell.index, {
                    kind: "curse",
                    look: "curse",
                    delay: startAt,
                    duration: curseMs
                });
            } else if (stepIndex === 0 && data.source === "status") {
                registerFx("monster", cell.index, {
                    kind: "fade",
                    look: "hp",
                    delay: startAt,
                    duration: FX_FADE_MS
                });
            } else {
                registerFx("monster", cell.index, {
                    kind: "pop",
                    look: "hp",
                    delay: startAt,
                    duration: FX_POP_MS
                });
            }
        });

        if (hasCurse) startAt += curseMs;
    });
});

/* ---------- Monster hits a player ---------- */

socket.on("monster-attack-resolved", result => {
    const key = `player:${result.playerID}`;

    (result.emptiedPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "pop", look: "hp", delay: 0, duration: FX_POP_MS
        });
    });

    (result.overhealLostPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "pop", look: "overheal", delay: 0, duration: FX_POP_MS
        });
    });
});

/* ---------- Heal / Lifesteal heal ---------- */

socket.on("player-heal-resolved", result => {
    const key = `player:${result.targetPlayerID}`;

    (result.healedPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "popin", look: "hp", delay: 0, duration: FX_POPIN_MS
        });
    });

    (result.overhealedPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "popin", look: "overheal", delay: 0, duration: FX_POPIN_MS
        });
    });
});

socket.on("player-lifesteal-resolved", result => {
    (result.healPositions || []).forEach(index => {
        registerFx(`player:${result.playerID}`, index, {
            kind: "popin", look: "hp", delay: 0, duration: FX_POPIN_MS
        });
    });
});

/* ---------- Rage ---------- */

socket.on("player-rage-resolved", result => {
    const key = `player:${result.playerID}`;

    (result.healthPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "rage", look: "hp", delay: 0, duration: FX_RAGE_MS
        });
    });

    (result.overhealPositions || []).forEach(index => {
        registerFx(key, index, {
            kind: "rage", look: "overheal", delay: 0, duration: FX_RAGE_MS
        });
    });
});

/* ---------- Retaliate thump ---------- */

// The Host's version of this event has no positions, so the marks stay secret.
socket.on("player-retaliate-resolved", result => {
    if (!Array.isArray(result.positions)) return;

    result.positions.forEach(index => {
        registerFx(`player:${result.playerID}`, index, {
            kind: "thump", look: "hp", delay: 0, duration: FX_THUMP_MS
        });
    });
});


/* =====================================
   GRID RENDERING HELPER
===================================== */

function renderGrid(container, cells, size, options = {}) {
    if (!container) return;

    container.innerHTML = "";

    container.style.gridTemplateColumns =
        `repeat(${size}, minmax(0, 1fr))`;

    const fxNow = performance.now();

    cells.forEach((cellType, index) => {
        const cell = document.createElement("button");

        cell.type = "button";
        cell.className = `grid-cell ${cellType}`;

        cell.setAttribute(
            "aria-label",
            `Position ${index + 1}: ${cellType}`
        );

        if (options.interactive) {
            cell.disabled = false;

            if (options.onHover) {
                cell.addEventListener("mouseenter", () => {
                    options.onHover(index);
                });
            }

            cell.addEventListener("click", () => {
                options.onClick?.(index);
            });

        } else {
            cell.disabled = true;
        }

        if (
            options.selected &&
            options.selected.has(index)
        ) {
            cell.classList.add("target-preview");
        }

        if (options.marks?.has(index)) {
            cell.classList.add("retaliate-mark");
            cell.setAttribute(
                "aria-label",
                `Position ${index + 1}: ${cellType}, Retaliate marked`
            );
        }

        if (options.curses?.has(index)) {
            cell.classList.add("curse-mark");
            cell.setAttribute(
                "aria-label",
                `Position ${index + 1}: ${cellType}, Cursed`
            );
        }

        if (options.fxKey) {
            applyFxToCell(cell, options.fxKey, index, fxNow);
        }

        container.appendChild(cell);
    });
}


/* =====================================
   PLAYER: HEART GRID
===================================== */

function renderPlayerGrid() {
    if (!heartGrid) return;

    const isHealTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "heal" &&
        selectedHealTargetID === currentPlayerID &&
        currentEncounter?.active &&
        !combatAttackPending;

    const isRageTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "rage" &&
        currentEncounter?.active &&
        !combatAttackPending;

    const isRetaliateTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "retaliate" &&
        currentEncounter?.active &&
        !combatAttackPending;

    const isLifestealHealTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "lifesteal" &&
        lifestealTargetPhase === "player" &&
        currentEncounter?.active &&
        !combatAttackPending;

    const isSelfTarget = isHealTarget || isRageTarget || isRetaliateTarget || isLifestealHealTarget;

    heartGrid.classList.toggle("targeting", isSelfTarget);
    heartGrid.classList.toggle("rage-targeting", isRageTarget);
    heartGrid.classList.toggle("retaliate-targeting", isRetaliateTarget);

    renderGrid(
        heartGrid,
        playerGridCells,
        playerGridSize,
        {
            interactive: isSelfTarget,
            marks: new Set(myMarks),
            fxKey: `player:${currentPlayerID}`,

            onHover: index => {
                updateHealTargetPreview(
                    index,
                    playerGridSize,
                    heartGrid
                );
            },

            onClick: index => {
                if (isLifestealHealTarget) {
                    confirmPlayerLifestealHeal(index);
                    return;
                }

                if (isRageTarget) {
                    confirmPlayerRage(index);
                    return;
                }

                if (isRetaliateTarget) {
                    confirmPlayerRetaliate(index);
                    return;
                }

                const target = roomPlayers.find(
                    player => player.id === currentPlayerID
                );

                confirmPlayerHeal(index, target);
            }
        }
    );

    if (
        isSelfTarget &&
        hoveredHealAnchor !== null
    ) {
        updateHealTargetPreview(
            hoveredHealAnchor,
            playerGridSize,
            heartGrid
        );
    }
}


socket.on("grid-size-updated", data => {
    playerGridSize = data.size;

    clearCardPreview();
    renderPlayerGrid();
});


socket.on("grid-size-error", message => {
    playerRoomStatus.textContent = message;
});


/* =====================================
   SHARED PARTY STATE
===================================== */

function renderPartyGrid(player, container) {
    const member = document.createElement("div");

    member.className = "party-member";

    const heading = document.createElement("h3");

    const energyText = player.energy !== undefined
        ? ` · ${player.energy} Energy`
        : "";

    const statusParts = [];
    if (player.status?.type === "thief") {
        statusParts.push(`Poison ${player.status.remainingTurns}`);
    }
    if (player.counterTurns > 0) {
        statusParts.push(`Counter ${player.counterTurns}`);
    }
    const statusText = statusParts.length
        ? ` · ${statusParts.join(" · ")}`
        : "";

    const dead = isDeadPlayer(player);

    heading.textContent =
        `${player.username} · ${player.className}${energyText}${statusText}` +
        (dead ? " · DEAD" : "");

    member.classList.toggle("dead", dead);

    const grid = document.createElement("div");

    grid.className = "heart-grid";

    const isHealTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "heal" &&
        selectedHealTargetID === player.id &&
        currentEncounter?.active &&
        !combatAttackPending;

    member.classList.toggle("targeting", isHealTarget);
    grid.classList.toggle("targeting", isHealTarget);

    renderGrid(
        grid,
        player.grid,
        player.gridSize,
        {
            interactive: isHealTarget,
            marks: new Set(player.marks || []),
            fxKey: `player:${player.id}`,

            onHover: index => {
                updateHealTargetPreview(
                    index,
                    player.gridSize,
                    grid
                );
            },

            onClick: index => {
                confirmPlayerHeal(index, player);
            }
        }
    );

    if (
        isHealTarget &&
        hoveredHealAnchor !== null
    ) {
        updateHealTargetPreview(
            hoveredHealAnchor,
            player.gridSize,
            grid
        );
    }

    member.append(heading, grid);

    if (dead && currentRole === "host") {
        member.appendChild(createReviveButton(player));
    }

    container.appendChild(member);
}


function renderPlayerPartyGrids() {
    if (!partyGrids) return;

    partyGrids.innerHTML = "";

    const teammates = roomPlayers.filter(
        player => player.id !== currentPlayerID
    );

    if (teammates.length === 0) {
        partyGrids.innerHTML =
            '<p class="empty-message">Waiting for party members.</p>';

        return;
    }

    teammates.forEach(player => {
        renderPartyGrid(player, partyGrids);
    });
}


function renderHostPartyGrids() {
    if (!hostPartyGrids) return;

    hostPartyGrids.innerHTML = "";

    if (roomPlayers.length === 0) {
        hostPartyGrids.innerHTML =
            '<p class="empty-message">Waiting for players.</p>';

        return;
    }

    roomPlayers.forEach(player => {
        renderPartyGrid(player, hostPartyGrids);
    });
}


socket.on("party-update", players => {
    roomPlayers = players || [];

    if (currentRole === "player") {
        const ownPlayer = roomPlayers.find(
            player => player.id === currentPlayerID
        );

        if (ownPlayer) {
            playerGridSize = ownPlayer.gridSize;
            playerGridCells = [...ownPlayer.grid];
            myStatus = ownPlayer.status || null;
            myMarks = ownPlayer.marks || [];
            myCounterTurns = ownPlayer.counterTurns || 0;
            renderPlayerGrid();
        }

        // Keep an open Buff/Heal target list fresh.
        if (!healTargetContainer.hidden) {
            updateHealTargetOptions();
        } else {
            updateHealTargetOptions();
        }

        renderPlayerPartyGrids();
        refreshCombatStatusLine();
    }

    if (currentRole === "host") {
        renderHostPartyGrids();
        updateMonsterTargetOptions();
    }
});


/* =====================================
   HOST: MONSTER ENCOUNTER
===================================== */

const monsterNameInput = document.getElementById("monster-name");
const monsterGridSizeSelect = document.getElementById("monster-grid-size");

const createEncounterButton =
    document.getElementById("create-encounter-button");

const monsterEncounterInfo =
    document.getElementById("monster-encounter-info");

const activeMonsterName =
    document.getElementById("active-monster-name");

const monsterEncounterStatus =
    document.getElementById("monster-encounter-status");

const monsterEncounterMessage =
    document.getElementById("monster-encounter-message");

const startEncounterButton =
    document.getElementById("start-encounter-button");

const endEncounterButton =
    document.getElementById("end-encounter-button");

const hostMonsterGrid =
    document.getElementById("host-monster-grid");


createEncounterButton?.addEventListener("click", () => {
    const name = monsterNameInput.value.trim();
    const size = Number(monsterGridSizeSelect.value);

    if (!name) {
        monsterEncounterMessage.textContent =
            "Enter a monster name.";

        return;
    }

    createEncounterButton.disabled = true;
    monsterEncounterMessage.textContent = "Creating encounter...";

    socket.emit("create-encounter", {
        name,
        size
    });
});


socket.on("encounter-created", message => {
    monsterEncounterMessage.textContent = message;

    monsterNameInput.disabled = true;
    monsterGridSizeSelect.disabled = true;

    createEncounterButton.textContent = "ENCOUNTER CREATED";
});


socket.on("encounter-error", message => {
    monsterEncounterMessage.textContent = message;
    createEncounterButton.disabled = false;
});


/* =====================================
   ENCOUNTER STATE
===================================== */

const combatStatus = document.getElementById("combat-status");
const combatMonsterName = document.getElementById("combat-monster-name");
const combatMonsterStatus = document.getElementById("combat-monster-status");

/* =====================================
   COMBAT ORDER — NATURAL + BONUS TURNS
===================================== */

function ensureCombatOrderUI() {
    if (!combatStatus) return null;

    const battlePanel = document.getElementById("player-turn-system");
    if (battlePanel && !battlePanel.dataset.battleLayoutReady) {
        battlePanel.dataset.battleLayoutReady = "true";
        const statusSection = combatStatus.closest(".player-section");
        const statusHeading = statusSection?.querySelector("h2");
        if (statusHeading) statusHeading.remove();
        if (statusSection) {
            const battleHeader = battlePanel.querySelector(".turn-system-header");
            if (battleHeader) battleHeader.insertAdjacentElement("afterend", combatStatus);
            else battlePanel.prepend(combatStatus);
            statusSection.remove();
        }
        const cardsSection = combatCardsContainer?.closest(".player-section");
        if (cardsSection) battlePanel.appendChild(cardsSection);
        const title = battlePanel.querySelector(".turn-system-header h2");
        if (title) title.textContent = "BATTLE STATUS";
        const label = battlePanel.querySelector(".turn-round-label");
        if (label) label.textContent = "TURN ORDER";
        const energyDescription = battlePanel.querySelector(".energy-description");
        if (energyDescription) energyDescription.textContent = "Energy costs are shown beside each card; some cards cost 1.5 per position.";
        const oldInitiative = document.getElementById("player-initiative-list");
        if (oldInitiative) oldInitiative.hidden = true;
        const cardsHeading = cardsSection?.querySelector("h2");
        if (cardsHeading) cardsHeading.textContent = "COMBAT CARDS";
        const cardsDescription = cardsSection?.querySelector(".section-description");
        if (cardsDescription) cardsDescription.textContent = "Drag a card into the Active Area to play it. Once you let go, it is locked in.";
    }

    let panel = document.getElementById("combat-order-panel");
    if (panel) return panel;

    const style = document.createElement("style");
    style.id = "combat-order-styles";
    style.textContent = `
        #combat-order-panel {
            margin: 12px 0 16px;
            padding: 12px;
            border: 1px solid var(--border, rgba(128, 128, 128, 0.35));
            border-radius: 10px;
            background: var(--surface, rgba(128, 128, 128, 0.06));
        }
        #combat-order-panel .combat-order-heading {
            margin: 0 0 9px;
            font-size: 10px;
            font-weight: 800;
            letter-spacing: 1.5px;
            opacity: 0.7;
        }
        #combat-order-panel .combat-order-list {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin: 0;
            padding: 0;
            list-style: none;
        }
        #combat-order-panel .combat-order-item {
            display: flex;
            align-items: center;
            gap: 12px;
            min-width: 170px;
            padding: 10px 14px 10px 10px;
            border: 1px solid rgba(128, 128, 128, 0.3);
            border-radius: 8px;
            background: rgba(128, 128, 128, 0.05);
        }
        #combat-order-panel .combat-order-number {
            display: grid;
            place-items: center;
            flex: 0 0 34px;
            width: 34px;
            height: 34px;
            border-radius: 8px;
            background: #3a3a3a;
            color: #f2efe6;
            font-size: 15px;
            font-weight: 800;
        }
        #combat-order-panel .combat-order-copy {
            display: flex;
            flex: 1;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
        }
        #combat-order-panel .combat-order-name {
            font-size: 16px;
            font-weight: 800;
            line-height: 1.2;
            overflow-wrap: anywhere;
        }
        #combat-order-panel .combat-order-class {
            font-size: 11px;
            font-weight: 400;
            line-height: 1.2;
            color: #98978f;
        }
        #combat-order-panel .combat-order-item.is-active {
            border-color: var(--green, #3aaf70);
            background: rgba(58, 175, 112, 0.12);
            box-shadow: inset 0 0 0 1px rgba(58, 175, 112, 0.18);
        }
        #combat-order-panel .combat-order-item.is-bonus {
            border-style: dashed;
            border-color: #d39a24;
        }
        #combat-order-panel .combat-order-count {
            flex: 0 0 auto;
            font-size: 10px;
            font-weight: 800;
            white-space: nowrap;
        }
    `;
    document.head.appendChild(style);

    panel = document.createElement("section");
    panel.id = "combat-order-panel";
    panel.hidden = true;

    const heading = document.createElement("h3");
    heading.className = "combat-order-heading";
    heading.textContent = "TURN ORDER";

    const list = document.createElement("ol");
    list.className = "combat-order-list";

    panel.append(heading, list);
    const panelHost = document.getElementById("player-turn-system");
    const currentTurnLine = document.getElementById("player-turn-current");
    if (panelHost && currentTurnLine) currentTurnLine.insertAdjacentElement("afterend", panel);
    else combatStatus.insertAdjacentElement("afterend", panel);

    return panel;
}

function renderCombatOrder() {
    const panel = ensureCombatOrderUI();
    if (!panel) return;

    updateActiveAreaState();

    const order = currentEncounter?.initiativeOrder || [];
    const list = panel.querySelector(".combat-order-list");

    if (!currentEncounter?.active || order.length === 0) {
        panel.hidden = true;
        list.replaceChildren();
        return;
    }

    panel.hidden = false;
    list.replaceChildren();

    const current = currentEncounter.currentTurn;
    const activeCounterID = current?.counter ? current.id : null;
    const counterWarrior = roomPlayers.find(
        player => player.className === "Warrior" &&
            ((player.counterTurns || 0) > 0 || player.id === activeCounterID)
    ) || (activeCounterID ? {
        id: activeCounterID,
        username: current?.username || "Warrior",
        className: "Warrior",
        counterTurns: 0
    } : null);

    let bonusInserted = false;

    const addCounterEntry = () => {
        if (bonusInserted || !counterWarrior) return;
        bonusInserted = true;

        const isActive = activeCounterID === counterWarrior.id;
        // The server consumes a stored Counter when the bonus turn begins.
        // Add the active turn back so the displayed count includes it.
        const totalTurns = Math.max(
            0,
            (counterWarrior.counterTurns || 0) + (isActive ? 1 : 0)
        );
        if (totalTurns <= 0) return;

        const item = document.createElement("li");
        item.className = "combat-order-item is-bonus";
        if (isActive) item.classList.add("is-active");

        const number = document.createElement("span");
        number.className = "combat-order-number";
        number.textContent = "#";

        const copy = document.createElement("span");
        copy.className = "combat-order-copy";

        const name = document.createElement("span");
        name.className = "combat-order-name";
        name.textContent = counterWarrior.username || "Warrior";

        const detail = document.createElement("span");
        detail.className = "combat-order-class";
        detail.textContent = "Warrior · Combat Turn";

        const count = document.createElement("span");
        count.className = "combat-order-count";
        count.textContent = `${totalTurns} Combat Turn${totalTurns === 1 ? "" : "s"}`;

        copy.append(name, detail);
        item.append(number, copy, count);
        list.appendChild(item);
    };

    order.forEach((participant, index) => {
        const item = document.createElement("li");
        item.className = "combat-order-item";

        const isActive = !current?.counter &&
            current?.type === participant.type &&
            current?.id === participant.id;
        if (isActive) item.classList.add("is-active");

        const number = document.createElement("span");
        number.className = "combat-order-number";
        number.textContent = String(index + 1);

        const copy = document.createElement("span");
        copy.className = "combat-order-copy";

        const name = document.createElement("span");
        name.className = "combat-order-name";
        name.textContent = participant.username;

        const playerClass = document.createElement("span");
        playerClass.className = "combat-order-class";
        playerClass.textContent = participant.type === "monster"
            ? "Monster"
            : participant.className;

        copy.append(name, playerClass);
        item.append(number, copy);
        list.appendChild(item);

        // Counter is a bonus slot immediately after the Monster's turn.
        if (participant.type === "monster") addCounterEntry();
    });

    // Defensive fallback in case a future encounter format omits the Monster row.
    addCounterEntry();
}

/* =====================================
   MONSTER'S EFFECTS
===================================== */

/*
    Right under Turn Order, for the Host and for players.
    Taunt and Weaken are Charges; Counter and Status are Turns.
    Icon + number only (the words are in the tooltip / screen-reader label).
*/
const MONSTER_EFFECT_TYPES = [
    { key: "taunt", label: "Taunt", unit: "Charge" },
    { key: "weaken", label: "Weaken", unit: "Charge" },
    { key: "counter", label: "Counter", unit: "Turn" },
    { key: "status", label: "Status", unit: "Turn" }
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

    MONSTER_EFFECT_TYPES.forEach(type => {
        previousMonsterEffects[type.key] = effects[type.key] || 0;
    });
}

socket.on("encounter-state", encounter => {
    currentEncounter = encounter;

    if (!encounter) {
        monsterEncounterInfo.hidden = true;

        combatMonsterName.textContent = "No monster";
        combatMonsterStatus.textContent = "No active encounter.";

        combatStatus.textContent =
            "Waiting for an encounter...";

        cancelCardTargeting(false);
        renderGrid(monsterGrid, [], 3);
        renderCombatOrder();
        renderMonsterEffects();

        return;
    }

    // Leftover positions are forfeited when the monster's turn ends.
    if (
        currentRole === "host" &&
        monsterAttackRoll !== null &&
        (!encounter.active || encounter.currentTurn?.type !== "monster")
    ) {
        monsterAttackRoll = null;
        selectedTargetPositions.clear();
        monsterD10Result.textContent = "?";
        monsterTargetPlayer.value = "";
        renderHostTargetGrid();
    }

    activeMonsterName.textContent = encounter.name;
    combatMonsterName.textContent = encounter.name;

    monsterEncounterInfo.hidden = false;

    monsterEncounterStatus.textContent =
        encounter.active
            ? "Encounter in progress."
            : "Encounter ready.";

    combatMonsterStatus.textContent =
        encounter.active
            ? "Monster is active."
            : "Encounter has not started.";

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

    renderGrid(
        hostMonsterGrid,
        encounter.grid,
        encounter.size,
        { curses: new Set(encounter.curses || []), fxKey: "monster" }
    );

    renderCombatMonsterGrid();

    renderPlayerGrid();
    renderPlayerPartyGrids();

    startEncounterButton.disabled = encounter.active;
    endEncounterButton.disabled = !encounter.active;

    createEncounterButton.disabled = encounter.active;

    if (!encounter.active) {
        createEncounterButton.disabled = false;
        createEncounterButton.textContent = "CREATE NEW ENCOUNTER";

        monsterNameInput.disabled = false;
        monsterGridSizeSelect.disabled = false;
    }

    if (currentRole === "host") {
        applyTauntToTargetSelection();
        refreshTauntBanner();
    }

    updateMonsterAttackControls();
});


/* =====================================
   HOST: START / END ENCOUNTER
===================================== */

startEncounterButton?.addEventListener("click", () => {
    socket.emit("start-encounter");
});

endEncounterButton?.addEventListener("click", () => {
    socket.emit("end-encounter");
});


/* =====================================
   HOST: D10 ATTACK CONTROLS
===================================== */

const rollMonsterD10Button =
    document.getElementById("roll-monster-d10-button");

const monsterD10Result =
    document.getElementById("monster-d10-result");

const monsterTargetPlayer =
    document.getElementById("monster-target-player");

const monsterTargetCount =
    document.getElementById("monster-target-count");

const hostTargetGrid =
    document.getElementById("host-target-grid");

const confirmMonsterAttackButton =
    document.getElementById("confirm-monster-attack-button");

const monsterAttackMessage =
    document.getElementById("monster-attack-message");


/* ---------- Taunt banner (Host) ---------- */

const tauntBanner = document.createElement("p");

tauntBanner.className = "taunt-banner";
tauntBanner.hidden = true;

rollMonsterD10Button?.parentElement?.insertBefore(
    tauntBanner,
    rollMonsterD10Button.previousElementSibling
);


function getActiveTauntTank() {
    const taunt = currentEncounter?.taunt;

    if (!taunt) return null;

    const tank = roomPlayers.find(player => player.id === taunt.tankID);

    if (!tank) return null;

    const hasHealth = tank.grid.some(
        cell => cell === "hp" || cell === "overheal"
    );

    return hasHealth ? tank : null;
}


function refreshTauntBanner() {
    const tank = getActiveTauntTank();

    if (!tank || !currentEncounter?.active) {
        tauntBanner.hidden = true;
        return;
    }

    tauntBanner.hidden = false;

    tauntBanner.textContent =
        `TAUNT ACTIVE: the monster must target ${tank.username} ` +
        `for ${currentEncounter.taunt.remainingDamage} more hit(s).`;
}


// When Taunt is active the Tank is the only legal target.
function applyTauntToTargetSelection() {
    if (!monsterTargetPlayer) return;

    const tank = getActiveTauntTank();

    if (!tank || monsterAttackRoll === null) return;

    if (monsterTargetPlayer.value !== tank.id) {
        monsterTargetPlayer.value = tank.id;
        selectedTargetPositions.clear();
        renderHostTargetGrid();
    }
}


rollMonsterD10Button?.addEventListener("click", () => {
    socket.emit("roll-monster-d10");

    rollMonsterD10Button.disabled = true;
    monsterAttackMessage.textContent = "Rolling...";
});


socket.on("monster-d10-result", result => {
    monsterAttackRoll = result;

    selectedTargetPositions.clear();

    monsterD10Result.textContent = result;

    const tank = getActiveTauntTank();

    monsterAttackMessage.textContent = tank
        ? `The monster rolled ${result}. Taunt forces it to hit ${tank.username} ` +
          `(max ${Math.min(result, currentEncounter.taunt.remainingDamage)} positions).`
        : `The monster rolled ${result}. Select a player and up to ${result} target positions.`;

    updateMonsterTargetOptions();
    applyTauntToTargetSelection();
    renderHostTargetGrid();
    updateMonsterAttackControls();
});


function updateMonsterTargetOptions() {
    if (!monsterTargetPlayer) return;

    const previousValue = monsterTargetPlayer.value;

    monsterTargetPlayer.innerHTML = "";

    const placeholder = document.createElement("option");

    placeholder.value = "";
    placeholder.textContent = "Select a player";

    monsterTargetPlayer.appendChild(placeholder);

    roomPlayers.forEach(player => {
        const option = document.createElement("option");

        option.value = player.id;

        const dead = isDeadPlayer(player);

        option.textContent =
            `${player.username} (${player.className})${dead ? " · DEAD" : ""}`;

        option.disabled = dead;

        monsterTargetPlayer.appendChild(option);
    });

    if (roomPlayers.some(player => player.id === previousValue)) {
        monsterTargetPlayer.value = previousValue;
    }

    monsterTargetPlayer.disabled =
        !currentEncounter?.active ||
        monsterAttackRoll === null ||
        roomPlayers.length === 0 ||
        Boolean(getActiveTauntTank());

    refreshTauntBanner();
}


monsterTargetPlayer?.addEventListener("change", () => {
    selectedTargetPositions.clear();

    renderHostTargetGrid();
    updateMonsterAttackControls();
});


function getSelectedTargetPlayer() {
    return roomPlayers.find(
        player => player.id === monsterTargetPlayer.value
    );
}


/*
    The D10 roll is a MAXIMUM number of positions.
    The host may choose anywhere from 1 up to this number,
    and can only choose cells that can actually be hit
    (HP or Overheal), so a player with few hearts left
    can't dodge by having the monster waste hits on empty cells.

    If the selected player is the taunting Tank, the number is also
    capped by how much Taunt is left.
*/
function getMaxMonsterTargets() {
    const player = getSelectedTargetPlayer();

    if (!player || monsterAttackRoll === null) return 0;

    const hittable = player.grid.filter(
        cell => cell === "hp" || cell === "overheal"
    ).length;

    let max = Math.min(monsterAttackRoll, hittable);

    const taunt = currentEncounter?.taunt;

    if (taunt && taunt.tankID === player.id) {
        max = Math.min(max, taunt.remainingDamage);
    }

    return max;
}


/* =====================================
   HOST: SELECT MONSTER TARGET POSITIONS
===================================== */

function renderHostTargetGrid() {
    const player = getSelectedTargetPlayer();

    if (!player) {
        hostTargetGrid.innerHTML = "";
        return;
    }

    renderGrid(
        hostTargetGrid,
        player.grid,
        player.gridSize,
        {
            interactive: monsterAttackRoll !== null,
            selected: selectedTargetPositions,

            onClick: index => {
                const max = getMaxMonsterTargets();
                const cell = player.grid[index];

                // Empty cells can't be hit.
                if (cell !== "hp" && cell !== "overheal") return;

                if (selectedTargetPositions.has(index)) {
                    selectedTargetPositions.delete(index);
                } else if (selectedTargetPositions.size < max) {
                    selectedTargetPositions.add(index);
                }

                renderHostTargetGrid();
                updateMonsterAttackControls();
            }
        }
    );
}


function updateMonsterAttackControls() {
    const hasActiveEncounter =
        Boolean(currentEncounter?.active);

    const hasRoll =
        monsterAttackRoll !== null;

    const player = getSelectedTargetPlayer();

    const max = getMaxMonsterTargets();
    const selected = selectedTargetPositions.size;

    const turn = currentEncounter?.currentTurn;
    const isMonsterTurn = turn?.type === "monster";

    rollMonsterD10Button.disabled =
        !hasActiveEncounter ||
        !isMonsterTurn ||
        Boolean(currentEncounter?.monsterHasActed) ||
        hasRoll;

    monsterTargetPlayer.disabled =
        !hasActiveEncounter ||
        !hasRoll ||
        roomPlayers.length === 0 ||
        Boolean(getActiveTauntTank());

    monsterTargetCount.textContent =
        hasRoll
            ? `Positions selected: ${selected} (up to ${max})`
            : "Positions remaining: 0";

    confirmMonsterAttackButton.disabled =
        !hasActiveEncounter ||
        !player ||
        !hasRoll ||
        selected < 1 ||
        selected > max;
}


confirmMonsterAttackButton?.addEventListener("click", () => {
    const player = getSelectedTargetPlayer();
    const max = getMaxMonsterTargets();

    if (
        !player ||
        monsterAttackRoll === null ||
        selectedTargetPositions.size < 1 ||
        selectedTargetPositions.size > max
    ) {
        return;
    }

    socket.emit("monster-attack", {
        playerID: player.id,
        positions: Array.from(selectedTargetPositions)
    });

    confirmMonsterAttackButton.disabled = true;
    monsterAttackMessage.textContent = "Resolving monster attack...";
});


socket.on("monster-attack-error", message => {
    monsterAttackMessage.textContent = message;
    updateMonsterAttackControls();
});


socket.on("monster-attack-resolved", result => {
    if (currentRole !== "host") return;

    selectedTargetPositions.clear();

    const attackText =
        `${result.username} was attacked at ${result.positions.length} position(s).` +
        (result.tauntRemaining === 0 ? " The Taunt has ended." : "");

    if (result.remaining > 0) {
        // Part of the roll is still unspent: keep attacking.
        monsterAttackRoll = result.remaining;

        monsterD10Result.textContent = result.remaining;
        monsterTargetPlayer.value = "";

        monsterAttackMessage.textContent =
            `${attackText} ${result.remaining} position(s) left to use.`;

        updateMonsterTargetOptions();

        // Only re-lock onto the Tank if the Taunt is still going.
        if (result.tauntRemaining > 0) {
            applyTauntToTargetSelection();
        }
    } else {
        monsterAttackRoll = null;

        monsterD10Result.textContent = "?";
        monsterTargetPlayer.value = "";

        monsterAttackMessage.textContent = attackText;

        updateMonsterTargetOptions();
    }

    renderHostTargetGrid();
    updateMonsterAttackControls();
});


/* =====================================
   HOST ACTIVITY LOG (cards that had no Host message)
===================================== */

const HOST_CARD_LOGS = {
    "player-attack-resolved": r =>
        `${r.username} used ${r.cardName}: ${r.damage} monster HP removed.`,
    "player-heal-resolved": r =>
        `${r.username} healed ${r.targetUsername} with ${r.cardName}.`,
    "player-buff-resolved": r =>
        `${r.username} gave ${r.energyTransferred} Energy to ${r.targetUsername}.`,
    "player-rage-resolved": r =>
        `${r.username} used ${r.cardName} and gained ${r.energyGained} Energy.`,
    "player-taunt-resolved": r =>
        `${r.username} taunted the monster! It must hit them ${r.remainingDamage} more time(s).`,
    "player-lifesteal-resolved": r =>
        `${r.username} used ${r.cardName}: ${r.damage} damage, ${r.healed} HP restored.`,
    "player-counter-resolved": r =>
        `${r.username} readied ${r.added} Counter Turn(s) (${r.counterTurns} total). ` +
        `They get a bonus turn after the monster's turn.`,
    "player-status-resolved": r =>
        `${r.username} poisoned the monster for ${r.duration} turn(s).`
};

Object.entries(HOST_CARD_LOGS).forEach(([eventName, format]) => {
    socket.on(eventName, result => {
        if (currentRole !== "host") return;
        monsterEncounterMessage.textContent = format(result);
    });
});


/* =====================================
   ROOM CLOSED
===================================== */

socket.on("room-closed", () => {
    endPlay();
    hideCardZoom();

    currentRoomID = null;
    currentRole = null;
    currentPlayerID = null;
    currentPlayerClass = null;

    activeAssignment = null;
    savedCards = [];
    myStatus = null;

    currentEncounter = null;
    monsterAttackRoll = null;

    selectedTargetPositions.clear();

    selectedCombatCard = null;
    lifestealTargetPhase = null;
    lifestealMonsterAnchor = null;

    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;

    selectedHealTargetID = null;
    combatAttackPending = false;

    healTargetContainer.hidden = true;
    buffConfirmButton.hidden = true;
    cardTypeContainer.hidden = true;
    tauntBanner.hidden = true;

    if (cardCreatorSection) cardCreatorSection.hidden = false;

    playerRegistration.hidden = false;
    playerLobbyInfo.hidden = true;
    playerGameArea.hidden = true;

    playerRoomStatus.textContent =
        "The Host has closed the room.";

    playerRoomMessage.textContent =
        "The Host has closed the room.";

    joinRoomButton.disabled = false;

    savedCardsContainer.innerHTML =
        '<p class="empty-message">No cards created yet.</p>';

    combatCardsContainer.innerHTML =
        '<p class="empty-message">You have no cards available.</p>';

    renderPlayerGrid();
});


/* =====================================
   CARD TYPE COLORS + PLAY DESCRIPTIONS
===================================== */

const CARD_TYPE_COLORS = {
    attack: "#d94848",
    heal: "#3986d6",
    buff: "#d49a1a",
    rage: "#b02a2a",
    taunt: "#7a5bc4",
    status: "#43a66b",
    lifesteal: "#c0396b",
    retaliate: "#c9a000",
    counter: "#2878a8",
    curse: "#9b63d2",
    weaken: "#54728a"
};

// Plain-language "what does this card do" text for the hover card.
function getCardPlayDescription(card) {
    const n = card.targetCount ?? 0;
    const s = n === 1 ? "" : "s";

    switch (card.type) {
        case "attack":
            return "Strike the monster. Aim this card's pattern on the monster's grid; every position it covers is hit.";
        case "heal":
            return "Heal yourself or a teammate. Empty positions in the pattern become HP, and HP positions become Overheal.";
        case "buff":
            return `Give a teammate ${n} Energy. You spend ${n} Energy too. No grid needed.`;
        case "rage":
            return `Sacrifice HP or Overheal positions from your own grid. You gain ${RAGE_ENERGY_PER_POSITION} Energy for every position sacrificed. This card costs no Energy.`;
        case "taunt":
            return `Force the monster to attack you. It must hit you ${n} time${s}, and using Taunt again stacks more hits. No grid needed.`;
        case "status":
            return `Poison the monster for ${n} turn${s}. At the end of each of your turns it damages 1-2 random healthy monster positions. No grid needed.`;
        case "lifesteal":
            return "Attack the monster, then heal yourself for the damage that actually landed. You pick the empty positions on your own grid to refill. Cannot Overheal.";
        case "retaliate":
            return "Mark plain HP positions on your own grid. Each mark strikes back once, hitting a random healthy monster position, the first time that exact position takes damage.";
        case "counter":
            return `Gain ${n} Counter Turn${s}. After the monster finishes an attack, you get an extra Attack turn for each one (no Energy regeneration on those turns). No grid needed.`;
        case "curse":
            return "Mark healthy monster positions. When a marked position is damaged, it also damages the positions above, below, left and right of it, chaining through other marks.";
        case "weaken":
            return `Reduce the monster's next attack by ${n}. Weaken stacks, and if it cancels the whole D10 roll the monster skips its turn. No grid needed.`;
        default:
            return CARD_TYPE_DESCRIPTIONS[card.type] || "";
    }
}


/* =====================================
   CARD ZOOM  (hover a card -> tall card with its description)
===================================== */

let cardZoomElement = null;
let cardZoomOwner = null;

function getCardZoomElement() {
    if (!cardZoomElement) {
        cardZoomElement = document.createElement("div");
        cardZoomElement.id = "card-zoom";
        cardZoomElement.hidden = true;
        cardZoomElement.setAttribute("aria-hidden", "true");
        document.body.appendChild(cardZoomElement);
    }

    return cardZoomElement;
}

function buildZoomCard(card, hint) {
    const root = document.createElement("div");
    root.className = "zoom-card";
    root.style.setProperty("--card-color", CARD_TYPE_COLORS[card.type] || "#666");

    const header = document.createElement("div");
    header.className = "zoom-card-header";

    const type = document.createElement("span");
    type.textContent = CARD_TYPE_LABELS[card.type] || "CARD";

    const cost = document.createElement("span");
    cost.className = "zoom-card-cost";
    cost.append(createEnergyLabel(getCardEnergyCost(card.type, card.targetCount)));

    header.append(type, cost);

    const name = document.createElement("h3");
    name.className = "zoom-card-name";
    name.textContent = card.name;

    const art = document.createElement("div");
    art.className = "zoom-card-art";

    const icon = document.createElement("img");
    icon.src = `/assets/${card.type}.png`;
    icon.alt = "";
    icon.draggable = false;
    icon.onerror = () => icon.remove();
    art.appendChild(icon);

    const shape = document.createElement("div");

    if (cardUsesPattern(card.type)) {
        shape.className = "zoom-card-pattern";

        for (let i = 0; i < 9; i++) {
            const cell = document.createElement("i");
            if ((card.pattern || []).includes(i)) cell.classList.add("active");
            shape.appendChild(cell);
        }
    } else {
        shape.className = "zoom-card-count";
        shape.textContent = String(card.targetCount ?? 0);
    }

    art.appendChild(shape);

    const stats = document.createElement("div");
    stats.className = "zoom-card-stats";

    const positions = document.createElement("span");
    positions.textContent = `Positions: ${card.targetCount ?? 0}`;
    stats.appendChild(positions);

    if (card.type === "rage") {
        const gain = document.createElement("span");
        gain.append(
            document.createTextNode("Gain: "),
            createEnergyLabel(`+${(card.targetCount ?? 0) * RAGE_ENERGY_PER_POSITION}`)
        );
        stats.appendChild(gain);
    }

    const description = document.createElement("p");
    description.className = "zoom-card-desc";
    description.textContent = getCardPlayDescription(card);

    root.append(header, name, art, stats, description);

    if (hint) {
        const hintLine = document.createElement("p");
        hintLine.className = "zoom-card-hint";
        hintLine.textContent = hint;
        root.appendChild(hintLine);
    }

    return root;
}

function showCardZoom(card, anchorElement, hint, owner) {
    const zoom = getCardZoomElement();

    zoom.replaceChildren(buildZoomCard(card, hint));
    zoom.hidden = false;
    cardZoomOwner = owner || anchorElement;

    const rect = anchorElement.getBoundingClientRect();
    const width = zoom.offsetWidth;
    const height = zoom.offsetHeight;
    const margin = 8;

    // Grow out of the original card, then keep the result on screen.
    let left = rect.left + rect.width / 2 - width / 2;
    let top = rect.top + rect.height / 2 - height / 2;

    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    zoom.style.left = `${left}px`;
    zoom.style.top = `${top}px`;
}

function hideCardZoom() {
    if (!cardZoomElement) return;

    cardZoomElement.hidden = true;
    cardZoomOwner = null;
}

// Hover (mouse), focus (keyboard) or tap (touch) a card to see it enlarged.
function attachCardZoom(anchorElement, card, options = {}) {
    const host = options.host || anchorElement;
    const hint = options.hint || "";

    host.classList.add("zoom-host");

    const canShow = () => !playDrag?.started && !playLocked;

    host.addEventListener("pointerenter", event => {
        if (event.pointerType === "touch" || !canShow()) return;
        showCardZoom(card, anchorElement, hint, host);
    });

    host.addEventListener("pointerleave", event => {
        if (event.pointerType === "touch") return;
        hideCardZoom();
    });

    host.addEventListener("focus", () => {
        if (host.matches(":focus-visible") && canShow()) {
            showCardZoom(card, anchorElement, hint, host);
        }
    });

    host.addEventListener("blur", hideCardZoom);

    let touchStart = null;

    host.addEventListener("pointerdown", event => {
        touchStart = event.pointerType === "touch"
            ? { x: event.clientX, y: event.clientY }
            : null;
    });

    host.addEventListener("pointerup", event => {
        if (event.pointerType !== "touch" || !touchStart) return;

        const moved = Math.hypot(
            event.clientX - touchStart.x,
            event.clientY - touchStart.y
        );
        touchStart = null;

        if (moved > 8 || !canShow()) return;

        if (cardZoomOwner === host && !cardZoomElement.hidden) {
            hideCardZoom();
        } else {
            showCardZoom(card, anchorElement, hint, host);
        }
    });
}

// Tapping anywhere that isn't a card closes a touch-opened zoom.
document.addEventListener("pointerdown", event => {
    if (event.pointerType === "touch" && !event.target.closest?.(".zoom-host")) {
        hideCardZoom();
    }
});

window.addEventListener("scroll", hideCardZoom, true);
window.addEventListener("resize", hideCardZoom);


/* =====================================
   ACTIVE AREA  (drag a card in = play it, no cancelling)
===================================== */

let activeAreaElement = null;

let playDrag = null;          // current drag session
let playLocked = false;       // true once a card has been dropped in
let renderAfterDrag = false;  // a card re-render was skipped mid-drag

function ensureActiveArea() {
    if (activeAreaElement?.isConnected) return activeAreaElement;

    const area = document.createElement("div");
    area.id = "active-area";
    area.className = "active-area";

    const label = document.createElement("span");
    label.className = "active-area-label";
    label.textContent = "ACTIVE AREA";

    const hint = document.createElement("span");
    hint.className = "active-area-hint";

    area.append(label, hint);
    combatCardsContainer.parentElement.insertBefore(area, combatCardsContainer);

    activeAreaElement = area;
    return area;
}

function updateActiveAreaState() {
    const area = ensureActiveArea();
    const hint = area.querySelector(".active-area-hint");

    let text;
    let state;

    if (playLocked && selectedCombatCard) {
        state = "locked";
        text = `${selectedCombatCard.name} is locked in.`;
    } else if (!currentEncounter?.active) {
        state = "disabled";
        text = "Waiting for an encounter to start.";
    } else if (!isMyTurn()) {
        state = "disabled";
        text = "Wait for your turn to play a card.";
    } else {
        state = "ready";
        text = "Drag a card here to play it. Once you let go, it is locked in.";
    }

    area.classList.toggle("is-disabled", state === "disabled");
    area.classList.toggle("is-locked", state === "locked");
    hint.textContent = text;
}

function flashActiveArea() {
    const area = ensureActiveArea();

    area.classList.remove("is-blocked");
    void area.offsetWidth;
    area.classList.add("is-blocked");

    setTimeout(() => area.classList.remove("is-blocked"), 450);
}

function getMyEnergy() {
    const me = roomPlayers.find(player => player.id === currentPlayerID);
    return me?.energy ?? 0;
}


/* ---------- Can this card be played right now? ---------- */

function getGridDataForPlayer(player) {
    return {
        cells: player?.grid || [],
        size: player?.gridSize || 3,
        marks: new Set(player?.marks || []),
        curses: new Set()
    };
}

function getMonsterGridData() {
    return {
        cells: currentEncounter?.grid || [],
        size: currentEncounter?.size || 3,
        marks: new Set(),
        curses: new Set(currentEncounter?.curses || [])
    };
}

function getOwnGridData() {
    return {
        cells: playerGridCells,
        size: playerGridSize,
        marks: new Set(myMarks),
        curses: new Set()
    };
}

// Which grid a committed card is currently aiming at.
function getPlayMode(card) {
    switch (card.type) {
        case "buff":
            return "buff";
        case "heal":
            return "heal";
        case "lifesteal":
            return lifestealTargetPhase === "player" ? "self" : "monster";
        case "attack":
        case "curse":
            return "monster";
        default:
            return "self"; // rage, retaliate
    }
}

// Would the server accept this placement? (Mirrors its checks.)
function isPlacementValid(card, mode, positions, data) {
    switch (card.type) {
        case "rage":
            return positions.every(
                position => data.cells[position] === "hp" ||
                    data.cells[position] === "overheal"
            );
        case "retaliate":
            return positions.every(
                position => data.cells[position] === "hp" &&
                    !data.marks.has(position)
            );
        case "lifesteal":
            return mode === "monster" ||
                positions.some(position => data.cells[position] === "empty");
        case "curse":
            return positions.some(
                position => data.cells[position] === "hp" &&
                    !data.curses.has(position)
            );
        default:
            return true;
    }
}

function hasValidPlacement(card, mode, data) {
    for (let anchor = 0; anchor < data.cells.length; anchor++) {
        const positions = getCardTargetPositions(card, anchor, data.size);

        if (positions && isPlacementValid(card, mode, positions, data)) {
            return true;
        }
    }

    return false;
}

function getLivingTeammates() {
    return roomPlayers.filter(
        player => player.id !== currentPlayerID && !isDeadPlayer(player)
    );
}

// Playing a card can't be cancelled, so refuse cards that could leave the
// player with nowhere to put them.
function hasPlayableTarget(card) {
    switch (card.type) {
        case "buff":
            return getLivingTeammates().length > 0;
        case "heal":
            return roomPlayers.some(
                player => !isDeadPlayer(player) &&
                    hasValidPlacement(card, "heal", getGridDataForPlayer(player))
            );
        case "attack":
        case "curse":
            return hasValidPlacement(card, "monster", getMonsterGridData());
        case "lifesteal":
            return hasValidPlacement(card, "monster", getMonsterGridData()) &&
                hasValidPlacement(card, "self", getOwnGridData());
        case "rage":
        case "retaliate":
            return hasValidPlacement(card, "self", getOwnGridData());
        default:
            return true;
    }
}

function canPlayCard(card) {
    if (currentRole !== "player") return { ok: false, reason: "" };

    if (!currentEncounter?.active) {
        return { ok: false, reason: "There is no active encounter." };
    }

    if (combatAttackPending || playLocked) {
        return { ok: false, reason: "An action is already in progress." };
    }

    if (!isMyTurn()) {
        return { ok: false, reason: "It is not your turn." };
    }

    if (isMyCounterTurn() && !["attack", "rage"].includes(card.type)) {
        return {
            ok: false,
            reason: "During a Counter Turn, you can only use an Attack or Rage card."
        };
    }

    const cost = getCardEnergyCost(card.type, card.targetCount);

    if (getMyEnergy() < cost) {
        return {
            ok: false,
            reason: `Not enough Energy. ${card.name} costs ${cost}.`
        };
    }

    if (!hasPlayableTarget(card)) {
        return {
            ok: false,
            reason: `${card.name} has nowhere valid to go right now.`
        };
    }

    return { ok: true, reason: "" };
}


/* ---------- Dropping a card in the Active Area ---------- */

function tryPlayCard(card) {
    const check = canPlayCard(card);

    if (!check.ok) {
        if (check.reason) combatCardMessage.textContent = check.reason;
        flashActiveArea();
        return;
    }

    commitCard(card);
}

// Letting go inside the Active Area is the confirmation. From here on the
// action cannot be cancelled.
function commitCard(card) {
    playLocked = true;

    selectedCombatCard = card;
    lifestealTargetPhase = card.type === "lifesteal" ? "monster" : null;
    lifestealMonsterAnchor = null;
    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;
    selectedHealTargetID = null;

    hideCardZoom();
    updateActiveAreaState();

    switch (card.type) {
        case "taunt":
        case "status":
        case "counter":
        case "weaken":
            // No grid and no target: dropping the card is the whole action.
            combatAttackPending = true;
            socket.emit(`player-${card.type}`, { cardID: card.id });
            combatCardMessage.textContent = `Activating ${card.name}...`;
            renderCombatCards();
            return;

        case "heal":
            selectedHealTargetID = currentPlayerID;
            break;

        default:
            break;
    }

    renderCombatCards();
    openPlayOverlay();
}

// Release the lock without an action having happened (errors, turn changes).
function endPlay() {
    closePlayOverlay();

    playLocked = false;

    if (activeAreaElement?.isConnected) updateActiveAreaState();
}


/* ---------- Dragging ---------- */

function attachCardDrag(button, card, faceElement) {
    button.addEventListener("dragstart", event => event.preventDefault());

    button.addEventListener("pointerdown", event => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (playDrag || playLocked) return;

        playDrag = {
            card,
            button,
            faceElement,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            started: false,
            ghost: null,
            over: false
        };

        document.addEventListener("pointermove", onCardDragMove);
        document.addEventListener("pointerup", onCardDragEnd);
        document.addEventListener("pointercancel", onCardDragEnd);
    });

    // Keyboard fallback: Enter / Space plays the focused card.
    button.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;

        event.preventDefault();
        tryPlayCard(card);
    });
}

function isPointOverActiveArea(x, y) {
    const rect = ensureActiveArea().getBoundingClientRect();

    return x >= rect.left && x <= rect.right &&
        y >= rect.top && y <= rect.bottom;
}

function onCardDragMove(event) {
    if (!playDrag || event.pointerId !== playDrag.pointerId) return;

    if (!playDrag.started) {
        const distance = Math.hypot(
            event.clientX - playDrag.startX,
            event.clientY - playDrag.startY
        );

        if (distance < 8) return;

        const check = canPlayCard(playDrag.card);

        if (!check.ok) {
            if (check.reason) combatCardMessage.textContent = check.reason;
            flashActiveArea();
            stopCardDrag();
            return;
        }

        beginCardDrag();
    }

    const ghost = playDrag.ghost;
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;

    playDrag.over = isPointOverActiveArea(event.clientX, event.clientY);

    ensureActiveArea().classList.toggle("drag-over", playDrag.over);
    ghost.classList.toggle("over", playDrag.over);
}

function beginCardDrag() {
    playDrag.started = true;

    hideCardZoom();

    const ghost = playDrag.faceElement.cloneNode(true);
    ghost.classList.add("drag-ghost");
    document.body.appendChild(ghost);
    playDrag.ghost = ghost;

    playDrag.button.classList.add("is-dragging");
    document.body.classList.add("is-dragging-card");
    ensureActiveArea().classList.add("drag-ready");
}

function onCardDragEnd(event) {
    if (!playDrag || event.pointerId !== playDrag.pointerId) return;

    const { card, started, over } = playDrag;
    const cancelled = event.type === "pointercancel";

    stopCardDrag();

    if (!started) {
        if (event.pointerType !== "touch" && !cancelled) {
            combatCardMessage.textContent =
                "Drag this card into the Active Area to play it.";
        }

        return;
    }

    if (over && !cancelled) {
        tryPlayCard(card);
    } else {
        combatCardMessage.textContent =
            "Drop the card inside the Active Area to play it.";
    }
}

function stopCardDrag() {
    document.removeEventListener("pointermove", onCardDragMove);
    document.removeEventListener("pointerup", onCardDragEnd);
    document.removeEventListener("pointercancel", onCardDragEnd);

    playDrag?.ghost?.remove();
    playDrag?.button.classList.remove("is-dragging");

    playDrag = null;

    document.body.classList.remove("is-dragging-card");

    if (activeAreaElement) {
        activeAreaElement.classList.remove("drag-ready", "drag-over");
    }

    if (renderAfterDrag) {
        renderAfterDrag = false;
        renderCombatCards();
    }
}


/* =====================================
   RENDER COMBAT CARDS
===================================== */

function renderCombatCards() {
    // Rebuilding the cards would pull the dragged one out from under the pointer.
    if (playDrag?.started) {
        renderAfterDrag = true;
        return;
    }

    if (!document.getElementById("combat-card-list-styles")) {
        const style = document.createElement("style");
        style.id = "combat-card-list-styles";
        style.textContent = `
            .combat-card-numbered-list { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(142px, 1fr)); gap: 12px; }
            .combat-card-list-item { min-width: 0; }
            .combat-card-button { width: 100%; min-height: 174px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 7px; text-align: center; padding: 9px; border: 1px solid var(--border, rgba(128,128,128,.35)); border-radius: 10px; background: var(--surface, rgba(128,128,128,.06)); color: inherit; cursor: grab; position: relative; touch-action: none; user-select: none; -webkit-user-select: none; }
            .combat-card-button.selected { border-color: var(--green, #3aaf70); box-shadow: inset 0 0 0 1px var(--green, #3aaf70); }
            .combat-card-button.is-unavailable { opacity: .45; }
            .combat-card-button.is-dragging { opacity: .3; }
            .combat-card-name { max-width: 100%; overflow-wrap: anywhere; font-size: 12px; font-weight: 700; }
        `;
        document.head.appendChild(style);
    }

    ensureActiveArea();
    updateActiveAreaState();

    combatCardsContainer.innerHTML = "";

    if (savedCards.length === 0) {
        combatCardsContainer.innerHTML =
            '<p class="empty-message">You have no cards available.</p>';
        return;
    }

    const list = document.createElement("ol");
    list.className = "combat-card-numbered-list";

    savedCards.forEach(card => {
        const item = document.createElement("li");
        item.className = "combat-card-list-item";

        const button = document.createElement("button");
        button.type = "button";
        button.className = `combat-card-button ${card.type}-card`;
        button.classList.toggle("selected", selectedCombatCard?.id === card.id);
        button.classList.toggle(
            "is-unavailable",
            combatAttackPending ||
                (isMyCounterTurn() && !["attack", "rage"].includes(card.type))
        );
        button.setAttribute(
            "aria-label",
            `${card.name}. ${getCardPlayDescription(card)} Press Enter to play it.`
        );

        const face = createCompactCardFace(card);
        const title = document.createElement("strong");
        title.className = "combat-card-name";
        title.textContent = card.name;

        button.append(face, title);

        attachCardZoom(face, card, {
            host: button,
            hint: "Drag into the Active Area to play"
        });
        attachCardDrag(button, card, face);

        item.appendChild(button);
        list.appendChild(item);
    });

    combatCardsContainer.appendChild(list);
}


/* =====================================
   FULL-SCREEN TARGETING (after a card is locked in)
===================================== */

let playOverlay = null;
let overlayHoverAnchor = null;
let overlayArmedAnchor = null;
let overlayLastPointerType = "mouse";

function isPlayOverlayOpen() {
    return Boolean(playOverlay && !playOverlay.hidden);
}

function ensurePlayOverlay() {
    if (playOverlay) return playOverlay;

    const overlay = document.createElement("div");
    overlay.id = "play-overlay";
    overlay.className = "play-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "play-overlay-title");

    overlay.innerHTML = `
        <div class="play-overlay-header">
            <div class="play-overlay-face"></div>
            <div class="play-overlay-copy">
                <span class="play-overlay-kicker"></span>
                <h2 id="play-overlay-title" class="play-overlay-title"></h2>
                <p class="play-overlay-instruction"></p>
            </div>
        </div>
        <div class="play-overlay-picker"></div>
        <div class="play-overlay-stage">
            <div class="play-grid heart-grid"></div>
        </div>
        <p class="play-overlay-message" aria-live="polite"></p>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector(".play-grid").addEventListener("pointerleave", () => {
        overlayHoverAnchor = null;
        clearOverlayPreview();
    });

    playOverlay = overlay;
    return overlay;
}

function setOverlayMessage(text) {
    const line = playOverlay?.querySelector(".play-overlay-message");
    if (line) line.textContent = text || "";
}

function openPlayOverlay() {
    const overlay = ensurePlayOverlay();

    overlayHoverAnchor = null;
    overlayArmedAnchor = null;

    overlay.hidden = false;
    document.body.classList.add("play-overlay-open");
    document.querySelector("main")?.setAttribute("inert", "");

    setOverlayMessage("");
    refreshPlayOverlay();
}

function closePlayOverlay() {
    if (!playOverlay) return;

    playOverlay.hidden = true;
    document.body.classList.remove("play-overlay-open");
    document.querySelector("main")?.removeAttribute("inert");

    overlayHoverAnchor = null;
    overlayArmedAnchor = null;
}

// Touch screens have no hover, so they preview with a first tap.
function getAimHint() {
    return window.matchMedia("(hover: none)").matches
        ? "Tap a spot to preview the pattern, then tap it again to confirm."
        : "Move over the grid to preview the pattern, then click to confirm.";
}

function getOverlayInstruction(card, mode) {
    const n = card.targetCount ?? 0;

    switch (card.type) {
        case "attack":
            return `Choose where to strike the monster. ${getAimHint()}`;
        case "curse":
            return `Choose which healthy monster positions to curse. ${getAimHint()}`;
        case "lifesteal":
            return mode === "monster"
                ? "STEP 1 OF 2: choose the monster positions to attack."
                : "STEP 2 OF 2: choose the empty positions on YOUR grid to heal. Only damage that lands is restored, and there is no Overheal.";
        case "heal":
            return "Choose who to heal, then aim on their grid. Empty positions become HP, and HP becomes Overheal.";
        case "buff":
            return `Choose a teammate. You spend ${n} Energy and they gain ${n}.`;
        case "rage":
            return `Aim at your own HP or Overheal positions to sacrifice. You gain ${n * RAGE_ENERGY_PER_POSITION} Energy.`;
        case "retaliate":
            return "Aim at your own plain HP positions to mark them. Each mark retaliates once when that cell takes damage.";
        default:
            return "";
    }
}

function refreshPlayOverlay() {
    if (!isPlayOverlayOpen() || !selectedCombatCard) return;

    const overlay = playOverlay;
    const card = selectedCombatCard;
    const mode = getPlayMode(card);

    // Keep a valid heal target selected (e.g. if someone fell in the meantime).
    if (mode === "heal") {
        const living = roomPlayers.filter(player => !isDeadPlayer(player));

        if (!living.some(player => player.id === selectedHealTargetID)) {
            selectedHealTargetID = living[0]?.id || null;
        }
    }

    overlay.style.setProperty("--card-color", CARD_TYPE_COLORS[card.type] || "#888");

    overlay.querySelector(".play-overlay-face")
        .replaceChildren(createCompactCardFace(card));

    overlay.querySelector(".play-overlay-kicker").textContent =
        `${CARD_TYPE_LABELS[card.type] || "CARD"} · LOCKED IN`;
    overlay.querySelector(".play-overlay-title").textContent = card.name;
    overlay.querySelector(".play-overlay-instruction").textContent =
        getOverlayInstruction(card, mode);

    renderOverlayPicker(card, mode);

    const stage = overlay.querySelector(".play-overlay-stage");
    stage.hidden = mode === "buff";

    if (mode !== "buff") renderOverlayGrid(card, mode);
}

function createPlayerChip(player, { showEnergy }) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "play-chip";
    chip.classList.toggle("selected", player.id === selectedHealTargetID);
    chip.disabled = combatAttackPending;

    const className = document.createElement("strong");
    className.textContent = player.className || "Player";

    const name = document.createElement("small");
    name.textContent = player.id === currentPlayerID
        ? `${player.username} (YOU)`
        : player.username;

    chip.append(className, name);

    if (showEnergy) {
        const energy = document.createElement("span");
        energy.className = "play-chip-energy";
        energy.appendChild(createEnergyLabel(player.energy ?? 0));
        chip.appendChild(energy);
    }

    return chip;
}

function renderOverlayPicker(card, mode) {
    const picker = playOverlay.querySelector(".play-overlay-picker");

    picker.replaceChildren();
    picker.classList.toggle("is-buff", mode === "buff");
    picker.hidden = mode !== "heal" && mode !== "buff";

    if (picker.hidden) return;

    if (mode === "heal") {
        roomPlayers
            .filter(player => !isDeadPlayer(player))
            .forEach(player => {
                const chip = createPlayerChip(player, { showEnergy: false });

                chip.addEventListener("click", () => {
                    if (combatAttackPending) return;

                    selectedHealTargetID = player.id;
                    overlayHoverAnchor = null;
                    overlayArmedAnchor = null;
                    setOverlayMessage("");
                    refreshPlayOverlay();
                });

                picker.appendChild(chip);
            });

        return;
    }

    // Buff: pick a class; each option shows how much Energy that class has.
    const teammates = getLivingTeammates();

    if (teammates.length === 0) {
        const empty = document.createElement("p");
        empty.className = "play-overlay-empty";
        empty.textContent = "You have no living teammates to give Energy to.";
        picker.appendChild(empty);
        return;
    }

    teammates.forEach(player => {
        const chip = createPlayerChip(player, { showEnergy: true });

        chip.addEventListener("click", () => {
            if (combatAttackPending) return;

            selectedHealTargetID = player.id;
            combatAttackPending = true;

            socket.emit("player-buff", {
                cardID: card.id,
                targetPlayerID: player.id
            });

            setOverlayMessage(`Giving Energy to ${player.username}...`);
            refreshPlayOverlay();
        });

        picker.appendChild(chip);
    });
}

function getOverlayGridData(mode) {
    if (mode === "monster") return getMonsterGridData();

    if (mode === "heal") {
        return getGridDataForPlayer(
            roomPlayers.find(player => player.id === selectedHealTargetID)
        );
    }

    return getOwnGridData();
}

function renderOverlayGrid(card, mode) {
    const container = playOverlay.querySelector(".play-grid");
    const data = getOverlayGridData(mode);

    container.className =
        `play-grid heart-grid play-${card.type}` +
        (card.type === "lifesteal" ? `-${mode}` : "") +
        (combatAttackPending ? " is-pending" : "");

    container.style.gridTemplateColumns =
        `repeat(${data.size}, minmax(0, 1fr))`;
    container.style.gap = data.size >= 6 ? "4px" : "8px";

    container.replaceChildren(
        ...data.cells.map((cellType, index) => {
            const cell = document.createElement("button");

            cell.type = "button";
            cell.className = `grid-cell ${cellType}`;
            cell.setAttribute("aria-label", `Position ${index + 1}: ${cellType}`);

            if (data.marks.has(index)) cell.classList.add("retaliate-mark");
            if (data.curses.has(index)) cell.classList.add("curse-mark");

            cell.addEventListener("pointerenter", event => {
                if (event.pointerType === "touch" || combatAttackPending) return;

                overlayHoverAnchor = index;
                previewOverlayPlacement(index);
            });

            cell.addEventListener("pointerdown", event => {
                overlayLastPointerType = event.pointerType;
            });

            cell.addEventListener("click", () => onOverlayCellClick(index));

            return cell;
        })
    );

    if (overlayHoverAnchor !== null && !combatAttackPending) {
        previewOverlayPlacement(overlayHoverAnchor);
    }
}

function clearOverlayPreview() {
    playOverlay?.querySelectorAll(".play-grid .grid-cell").forEach(cell => {
        cell.classList.remove("target-preview", "target-invalid");
    });
}

function previewOverlayPlacement(anchor) {
    clearOverlayPreview();

    if (!selectedCombatCard || !isPlayOverlayOpen()) return;

    const card = selectedCombatCard;
    const mode = getPlayMode(card);
    const data = getOverlayGridData(mode);
    const cells = playOverlay.querySelector(".play-grid").children;

    const positions = getCardTargetPositions(card, anchor, data.size);

    if (!positions) {
        cells[anchor]?.classList.add("target-invalid");
        return;
    }

    const valid = isPlacementValid(card, mode, positions, data);
    const healsOnlyEmpty = card.type === "lifesteal" && mode === "self";

    positions.forEach(position => {
        if (!valid) {
            cells[position]?.classList.add("target-invalid");
        } else if (!healsOnlyEmpty || data.cells[position] === "empty") {
            cells[position]?.classList.add("target-preview");
        }
    });
}

function onOverlayCellClick(index) {
    if (!selectedCombatCard || combatAttackPending) return;

    // Touch has no hover: the first tap previews, the second tap fires.
    if (overlayLastPointerType === "touch" && overlayArmedAnchor !== index) {
        overlayArmedAnchor = index;
        overlayHoverAnchor = index;
        previewOverlayPlacement(index);
        setOverlayMessage("Tap the same spot again to fire.");
        return;
    }

    overlayArmedAnchor = null;

    const card = selectedCombatCard;
    const mode = getPlayMode(card);

    switch (card.type) {
        case "attack":
            confirmPlayerAttack(index);
            break;

        case "curse":
            confirmMonsterPatternCard(index);
            break;

        case "lifesteal":
            if (mode === "monster") {
                confirmMonsterPatternCard(index);
                overlayHoverAnchor = null;
            } else {
                confirmPlayerLifestealHeal(index);
            }
            break;

        case "rage":
            confirmPlayerRage(index);
            break;

        case "retaliate":
            confirmPlayerRetaliate(index);
            break;

        case "heal":
            confirmPlayerHeal(
                index,
                roomPlayers.find(player => player.id === selectedHealTargetID)
            );
            break;

        default:
            break;
    }

    // The confirm helpers report problems / progress on the message line.
    setOverlayMessage(combatCardMessage.textContent);
    refreshPlayOverlay();
}

// Keep the overlay in step with live game data (grids, energy, turns).
["party-update", "encounter-state", "player-state"].forEach(eventName => {
    socket.on(eventName, () => {
        // Run after the main handlers for this event have updated the state.
        queueMicrotask(() => {
            if (isPlayOverlayOpen()) refreshPlayOverlay();
        });
    });
});


/* =====================================
   INITIALIZE
===================================== */

createCardGrid();

renderSavedCards();

renderCombatCards();

updatePlayerAssignment();

renderPlayerGrid();

renderHostLobby();
