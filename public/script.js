/* =====================================
   SOCKET CONNECTION
===================================== */

const socket = io();


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

let playerGridSize = 3;
let playerGridCells = Array(9).fill("hp");

let currentEncounter = null;
let monsterAttackRoll = null;

let selectedTargetPositions = new Set();


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

        const details = document.createElement("span");
        details.textContent =
            `${player.className} · ${player.cardCount}/4 Cards · ` +
            `${player.hasAssignment ? "Assignment pending" : "No assignment"}`;

        item.append(identity, details);
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
        !player.hasAssignment && player.cardCount < 4
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

    cardTypeSelect.value = "attack";
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

let selectedPositions = new Set();


function canCreateHealCards() {
    return ["Support", "Mage"].includes(currentPlayerClass);
}


function updateCardTypeVisibility() {
    const canHeal = canCreateHealCards();

    cardTypeContainer.hidden = !canHeal;

    if (!canHeal) {
        cardTypeSelect.value = "attack";
    }

    updateCardTypeDescription();
    checkCardValidity();
}


function updateCardTypeDescription() {
    if (cardTypeSelect.value === "heal") {
        cardTypeDescription.textContent =
            "Heal cards target yourself or a teammate. Empty cells become HP, and HP becomes Overheal.";
    } else {
        cardTypeDescription.textContent =
            "Attack cards target the monster and deal damage.";
    }
}


cardTypeSelect?.addEventListener("change", updateCardTypeDescription);


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
    if (!activeAssignment) {
        cardSelectionCount.textContent =
            "Waiting for assignment.";
    } else {
        cardSelectionCount.textContent =
            `Selected: ${selectedPositions.size} / ${activeAssignment.targetCount}`;
    }

    checkCardValidity();
}


function checkCardValidity() {
    const hasName = cardNameInput.value.trim().length > 0;

    const hasCorrectTargets =
        activeAssignment &&
        selectedPositions.size === activeAssignment.targetCount;

    const validType =
        cardTypeSelect.value === "attack" ||
        (cardTypeSelect.value === "heal" && canCreateHealCards());

    saveCardButton.disabled =
        !activeAssignment ||
        savedCards.length >= 4 ||
        !hasName ||
        !hasCorrectTargets ||
        !validType;
}


cardNameInput?.addEventListener("input", checkCardValidity);


/* =====================================
   PLAYER: SAVE CARD
===================================== */

saveCardButton?.addEventListener("click", () => {
    if (!activeAssignment || savedCards.length >= 4) return;

    const name = cardNameInput.value.trim();

    const pattern = Array.from(selectedPositions)
        .sort((a, b) => a - b);

    const type = canCreateHealCards()
        ? cardTypeSelect.value
        : "attack";

    if (
        !name ||
        pattern.length !== activeAssignment.targetCount ||
        (type === "heal" && !canCreateHealCards())
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
    cardTypeSelect.value = "attack";

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

        const description = document.createElement("p");
        description.textContent =
            `${card.targetCount} Target Positions · ` +
            `${card.type === "heal" ? "HEAL CARD" : "ATTACK CARD"}`;

        info.append(title, description);

        const preview = createCardPreview(card);

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

let selectedCombatCard = null;

let hoveredMonsterAnchor = null;
let hoveredHealAnchor = null;

let selectedHealTargetID = null;

let combatAttackPending = false;


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
   HEAL TARGET SELECTION
===================================== */

function updateHealTargetOptions() {
    if (!healTargetPlayerSelect) return;

    const previousValue = selectedHealTargetID;

    healTargetPlayerSelect.innerHTML = "";

    roomPlayers.forEach(player => {
        const option = document.createElement("option");

        option.value = player.id;

        option.textContent =
            player.id === currentPlayerID
                ? `${player.username} (YOU)`
                : `${player.username} (${player.className})`;

        healTargetPlayerSelect.appendChild(option);
    });

    const previousTargetExists = roomPlayers.some(
        player => player.id === previousValue
    );

    if (previousTargetExists) {
        selectedHealTargetID = previousValue;
    } else {
        selectedHealTargetID = currentPlayerID;
    }

    if (
        !roomPlayers.some(player => player.id === selectedHealTargetID)
    ) {
        selectedHealTargetID = roomPlayers[0]?.id || null;
    }

    healTargetPlayerSelect.value = selectedHealTargetID || "";
}


healTargetPlayerSelect?.addEventListener("change", () => {
    selectedHealTargetID = healTargetPlayerSelect.value || null;

    hoveredHealAnchor = null;

    renderPlayerGrid();
    renderPlayerPartyGrids();
});


function getHealTargetPlayer() {
    return roomPlayers.find(
        player => player.id === selectedHealTargetID
    );
}


/* =====================================
   SELECT COMBAT CARD
===================================== */

function selectCombatCard(card) {
    if (!currentEncounter?.active) {
        combatCardMessage.textContent =
            "There is no active encounter.";

        return;
    }

    if (combatAttackPending) return;

    if (selectedCombatCard?.id === card.id) {
        cancelCardTargeting();
        return;
    }

    if (card.type === "heal" && !canCreateHealCards()) {
        combatCardMessage.textContent =
            "Your class cannot use Heal cards.";

        return;
    }

    selectedCombatCard = card;

    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;

    if (card.type === "heal") {
        updateHealTargetOptions();

        healTargetContainer.hidden = false;

        combatCardMessage.textContent =
            `${card.name} selected. Hover over your chosen player's grid to aim.`;

        renderPlayerGrid();
        renderPlayerPartyGrids();
    } else {
        selectedHealTargetID = null;
        healTargetContainer.hidden = true;

        combatCardMessage.textContent =
            `${card.name} selected. Hover over the monster's grid to aim.`;

        renderCombatMonsterGrid();
    }

    renderCombatCards();
}


/* =====================================
   CANCEL CARD TARGETING
===================================== */

function cancelCardTargeting(showMessage = true) {
    selectedCombatCard = null;

    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;

    selectedHealTargetID = null;
    combatAttackPending = false;

    healTargetContainer.hidden = true;

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


/* =====================================
   RENDER COMBAT CARDS
===================================== */

function renderCombatCards() {
    combatCardsContainer.innerHTML = "";

    if (savedCards.length === 0) {
        combatCardsContainer.innerHTML =
            '<p class="empty-message">You have no cards available.</p>';

        return;
    }

    savedCards.forEach(card => {
        const isHeal = card.type === "heal";

        const button = document.createElement("button");

        button.type = "button";
        button.className =
            `saved-card combat-card-button ${isHeal ? "heal-card" : ""}`;

        button.classList.toggle(
            "selected",
            selectedCombatCard?.id === card.id
        );

        button.disabled = combatAttackPending;

        const info = document.createElement("div");
        info.className = "saved-card-info";

        const title = document.createElement("h3");
        title.textContent = card.name;

        const description = document.createElement("p");
        description.textContent =
            `${card.targetCount} Target Positions`;

        const typeLabel = document.createElement("span");
        typeLabel.className =
            `combat-card-type ${isHeal ? "heal" : ""}`;

        typeLabel.textContent =
            isHeal ? "HEAL CARD" : "ATTACK CARD";

        info.append(title, description, typeLabel);

        const preview = createCardPreview(card);

        button.append(info, preview);

        button.addEventListener("click", () => {
            selectCombatCard(card);
        });

        combatCardsContainer.appendChild(button);
    });
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
        selectedCombatCard.type === "heal" ||
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
        const cell = monsterGrid.children[anchor];

        if (cell) {
            cell.classList.add("target-invalid");
        }

        return;
    }

    positions.forEach(position => {
        monsterGrid.children[position]?.classList.add("target-preview");
    });
}


/* =====================================
   HEAL TARGET PREVIEW
===================================== */

function updateHealTargetPreview(anchor, gridSize, gridContainer) {
    clearCombatTargetPreview();

    if (
        !selectedCombatCard ||
        selectedCombatCard.type !== "heal" ||
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
        gridContainer.children[position]?.classList.add("target-preview");
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
   RENDER COMBAT MONSTER GRID
===================================== */

function renderCombatMonsterGrid() {
    if (!currentEncounter || !monsterGrid) return;

    const isAttackTarget =
        currentRole === "player" &&
        selectedCombatCard?.type === "attack" &&
        currentEncounter.active &&
        !combatAttackPending;

    monsterGrid.classList.toggle("targeting", isAttackTarget);

    renderGrid(
        monsterGrid,
        currentEncounter.grid,
        currentEncounter.size,
        {
            interactive: isAttackTarget,

            onHover: index => {
                updateCombatTargetPreview(index);
            },

            onClick: index => {
                confirmPlayerAttack(index);
            }
        }
    );

    if (
        isAttackTarget &&
        hoveredMonsterAnchor !== null
    ) {
        updateCombatTargetPreview(hoveredMonsterAnchor);
    }
}


/* =====================================
   LEAVE MONSTER GRID
===================================== */

monsterGrid?.addEventListener("mouseleave", () => {
    if (selectedCombatCard?.type !== "attack") return;

    hoveredMonsterAnchor = null;
    clearCombatTargetPreview();
});


/* =====================================
   COMBAT ERRORS
===================================== */

socket.on("combat-action-error", message => {
    combatAttackPending = false;

    combatCardMessage.textContent = message;

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
        combatCardMessage.textContent =
            `You used ${result.cardName}. ` +
            `${result.damage} monster HP removed.`;

        selectedCombatCard = null;
        hoveredMonsterAnchor = null;
        combatAttackPending = false;

        renderCombatCards();

    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName}. ` +
            `${result.damage} monster HP removed.`;
    }

    clearCombatTargetPreview();
    renderCombatMonsterGrid();
});


/* =====================================
   HEAL RESULTS
===================================== */

socket.on("player-heal-resolved", result => {
    const isHealer = result.playerID === currentPlayerID;

    if (isHealer) {
        const healed = result.healed ?? 0;
        const overhealed = result.overhealed ?? 0;

        combatCardMessage.textContent =
            `You used ${result.cardName}. ` +
            `${healed} HP restored · ${overhealed} Overheal added.`;

        selectedCombatCard = null;
        selectedHealTargetID = null;
        hoveredHealAnchor = null;
        combatAttackPending = false;

        healTargetContainer.hidden = true;

        renderCombatCards();
        renderPlayerGrid();
        renderPlayerPartyGrids();

    } else if (currentRole === "player") {
        combatCardMessage.textContent =
            `${result.username} used ${result.cardName}.`;
    }

    clearCombatTargetPreview();
});


/* =====================================
   GRID RENDERING HELPER
===================================== */

function renderGrid(container, cells, size, options = {}) {
    if (!container) return;

    container.innerHTML = "";

    container.style.gridTemplateColumns =
        `repeat(${size}, minmax(0, 1fr))`;

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

    heartGrid.classList.toggle("targeting", isHealTarget);

    renderGrid(
        heartGrid,
        playerGridCells,
        playerGridSize,
        {
            interactive: isHealTarget,

            onHover: index => {
                updateHealTargetPreview(
                    index,
                    playerGridSize,
                    heartGrid
                );
            },

            onClick: index => {
                const target = roomPlayers.find(
                    player => player.id === currentPlayerID
                );

                confirmPlayerHeal(index, target);
            }
        }
    );

    if (
        isHealTarget &&
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

    heading.textContent =
        `${player.username} · ${player.className}`;

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
            renderPlayerGrid();
        }

        updateHealTargetOptions();
        renderPlayerPartyGrids();
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

        return;
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

    combatStatus.textContent =
        encounter.active
            ? "COMBAT IN PROGRESS"
            : "Encounter waiting to start.";

    if (!encounter.active) {
        cancelCardTargeting(false);
    }

    renderGrid(
        hostMonsterGrid,
        encounter.grid,
        encounter.size
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


rollMonsterD10Button?.addEventListener("click", () => {
    socket.emit("roll-monster-d10");

    rollMonsterD10Button.disabled = true;
    monsterAttackMessage.textContent = "Rolling...";
});


socket.on("monster-d10-result", result => {
    monsterAttackRoll = result;

    selectedTargetPositions.clear();

    monsterD10Result.textContent = result;

    monsterAttackMessage.textContent =
        `The monster rolled ${result}. Select a player and up to ${result} target positions.`;

    updateMonsterTargetOptions();
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
        option.textContent =
            `${player.username} (${player.className})`;

        monsterTargetPlayer.appendChild(option);
    });

    if (roomPlayers.some(player => player.id === previousValue)) {
        monsterTargetPlayer.value = previousValue;
    }

    monsterTargetPlayer.disabled =
        !currentEncounter?.active ||
        monsterAttackRoll === null ||
        roomPlayers.length === 0;
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
*/
function getMaxMonsterTargets() {
    const player = getSelectedTargetPlayer();

    if (!player || monsterAttackRoll === null) return 0;

    const hittable = player.grid.filter(
        cell => cell === "hp" || cell === "overheal"
    ).length;

    return Math.min(monsterAttackRoll, hittable);
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

    rollMonsterD10Button.disabled =
        !hasActiveEncounter ||
        hasRoll;

    monsterTargetPlayer.disabled =
        !hasActiveEncounter ||
        !hasRoll ||
        roomPlayers.length === 0;

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
    monsterAttackRoll = null;

    selectedTargetPositions.clear();

    monsterD10Result.textContent = "?";
    monsterTargetPlayer.value = "";

    monsterAttackMessage.textContent =
        `${result.username} was attacked at ${result.positions.length} position(s).`;

    renderHostTargetGrid();
    updateMonsterAttackControls();
});


/* =====================================
   ROOM CLOSED
===================================== */

socket.on("room-closed", () => {
    currentRoomID = null;
    currentRole = null;
    currentPlayerID = null;
    currentPlayerClass = null;

    activeAssignment = null;
    savedCards = [];

    currentEncounter = null;
    monsterAttackRoll = null;

    selectedTargetPositions.clear();

    selectedCombatCard = null;

    hoveredMonsterAnchor = null;
    hoveredHealAnchor = null;

    selectedHealTargetID = null;
    combatAttackPending = false;

    healTargetContainer.hidden = true;
    cardTypeContainer.hidden = true;

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
   INITIALIZE
===================================== */

createCardGrid();

renderSavedCards();

renderCombatCards();

updatePlayerAssignment();

renderPlayerGrid();

renderHostLobby();