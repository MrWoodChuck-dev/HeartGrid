/* =====================================
   THE PLAYER SCREEN: PREPARATION TAB
===================================== */

/*
    Once a player has joined, the whole page is the game (no scrolling):

        top right     the room number
        centre        the battlefield, which is also the Active Area
        right under   your Energy, whichever tab is open
        bottom left   what the selected tab shows
        bottom right  four tab squares (Preparation, Combat, two Coming Soon)

    This file draws the PREPARATION tab:

        No assignment     "(No Assignment)"
        An assignment     a card picker: LEFT and RIGHT arrows step through the
                          cards your class can make. Hover the card icon to see
                          the whole card (the same zoom the Combat tab uses).
                          Click it to make that card:

            grid card      (Attack, Heal, Rage, Retaliate, Blast, Spellvamp,
                           Curse) a full-screen grid, with a large warning
                           beside it, to pick the positions
            any other card a full-screen guide (card-guides.js) that explains
                           it, frame by frame where it hits the grid

        Hand already full a short list to discard from first

    The card-making rules live in script.js (activeAssignment, selectedPositions,
    the hidden card-creator inputs and save-card-button). This file is only the
    view: it fills those in and presses the same save button, so the server
    still checks everything.

    Relies on globals from script.js / cards.js / card-guides.js: socket,
    currentRole, activeAssignment, savedCards, selectedPositions, getCardTypes,
    getCardRule, getCardOptionName, cardUsesPattern, isCardTypeValidForAssignment,
    getCardEnergyCost, createCardCostLabel, createCompactCardFace, attachCardZoom,
    hideCardZoom, discardCard, CARD_DEFS, CARD_GUIDES, HEX_* constants.
*/

(function () {
    "use strict";

    const root = document.getElementById("pg-prep");

    if (!root) return;

    // The words next to the grid. Large on purpose.
    const GRID_WARNING =
        "It is highly advised you start at the center if you do not know what you are doing.";

    const CENTER = 4;

    // What the player is doing on this tab.
    const ui = {
        assignmentKey: null,     // changes when a new assignment arrives
        index: 0,                // which card the arrows are showing
        maker: null,             // the card type open in the full-screen maker
        notice: ""
    };

    let overlay = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);

        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;

        return node;
    }

    function handIsFull() {
        return savedCards.length >= 4;
    }

    // A card that does not exist yet, just for showing it (icon + zoom).
    function previewCard(type) {
        return {
            id: `preview-${type}`,
            type,
            name: getCardOptionName(type),
            targetCount: activeAssignment.targetCount,
            pattern: []
        };
    }

    // A new assignment (or none) starts the tab over.
    function syncAssignment() {
        const key = activeAssignment
            ? `${activeAssignment.targetCount}:${activeAssignment.id ?? ""}:${savedCards.length}`
            : null;

        if (key === ui.assignmentKey) return;

        ui.assignmentKey = key;
        ui.index = 0;
        ui.notice = "";

        closeMaker();
    }


    /* ---------- The card picker (arrows) ---------- */

    function step(direction) {
        const total = getCardTypes().length;

        if (total === 0) return;

        ui.index = (ui.index + direction + total) % total;
        ui.notice = "";

        hideCardZoom();
        render();
    }

    function renderEmpty(text) {
        root.replaceChildren(el("p", "pg-prep-empty", text));
    }

    function renderHandFull() {
        const list = el("div", "pg-discard-list");

        savedCards.forEach(card => {
            const row = el("div", "pg-discard-row");

            const button = el("button", "pg-discard-button", "DISCARD");
            button.type = "button";
            button.addEventListener("click", () => discardCard(card.id));

            row.append(el("strong", "", card.name), button);
            list.appendChild(row);
        });

        root.replaceChildren(
            el("p", "pg-prep-title", "YOUR HAND IS FULL"),
            el("p", "pg-prep-sub", "Discard a card to make room for the new one."),
            list
        );
    }

    function render() {
        if (currentRole !== "player") return;

        syncAssignment();

        if (!activeAssignment) {
            renderEmpty("(No Assignment)");
            return;
        }

        if (handIsFull()) {
            renderHandFull();
            return;
        }

        const types = getCardTypes();

        if (types.length === 0) {
            renderEmpty("(No cards available)");
            return;
        }

        ui.index = Math.min(ui.index, types.length - 1);

        const type = types[ui.index];
        const count = activeAssignment.targetCount;
        const valid = isCardTypeValidForAssignment(type);
        const rule = getCardRule(type);
        const card = previewCard(type);

        /* The picker row: [<]  [card icon]  [>] */
        const left = el("button", "pg-arrow", "◀");
        left.type = "button";
        left.setAttribute("aria-label", "Previous card");
        left.addEventListener("click", () => step(-1));

        const right = el("button", "pg-arrow", "▶");
        right.type = "button";
        right.setAttribute("aria-label", "Next card");
        right.addEventListener("click", () => step(1));

        const pick = el("button", "pg-pick");
        pick.type = "button";
        pick.classList.toggle("is-invalid", !valid);
        pick.setAttribute(
            "aria-label",
            `${getCardOptionName(type)}. Click to make this card.`
        );

        const face = createCompactCardFace(card);
        pick.appendChild(face);

        // Hover the icon to see the whole card, like the Combat tab.
        attachCardZoom(face, card, {
            host: pick,
            hint: valid ? "Click to make this card" : "Not available for this assignment"
        });

        pick.addEventListener("click", () => {
            if (!valid) {
                ui.notice = rule
                    ? `${getCardOptionName(type)} needs ${rule.min}-${rule.max} positions. ` +
                        `This assignment has ${count}.`
                    : "That card can't be made from this assignment.";
                render();
                return;
            }

            hideCardZoom();
            openMaker(type);
        });

        const picker = el("div", "pg-picker");
        picker.append(left, pick, right);

        /* Under it: the name, how many, and what to do. */
        const caption = el("div", "pg-pick-caption");
        caption.append(
            el("strong", "pg-pick-name", getCardOptionName(type)),
            el("span", "pg-pick-count", `${ui.index + 1} / ${types.length}`)
        );

        const hint = el(
            "p",
            "pg-pick-hint",
            valid
                ? "Click the card to make it. Hover it to read it."
                : "Not available for this assignment."
        );

        const title = el(
            "p",
            "pg-prep-title",
            `ASSIGNMENT: ${count} POSITIONS`
        );

        const notice = el("p", "pg-prep-notice", ui.notice);

        root.replaceChildren(title, picker, caption, hint, notice);
    }


    /* ---------- The full-screen maker ---------- */

    function ensureOverlay() {
        if (overlay) return overlay;

        overlay = el("div", "play-overlay pg-maker");
        overlay.hidden = true;
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Make a card");

        document.body.appendChild(overlay);

        document.addEventListener("keydown", event => {
            if (event.key === "Escape" && overlay && !overlay.hidden) closeMaker();
        });

        return overlay;
    }

    function openMaker(type) {
        ensureOverlay();

        ui.maker = type;

        // Fill in the hidden creator, which holds the rules.
        cardTypeSelect.value = type;
        selectedPositions.clear();
        cardNameInput.value = `${getCardOptionName(type)} ${activeAssignment.targetCount}`;

        updateCardTypeDescription();
        updateCardGrid();
        checkCardValidity();

        overlay.hidden = false;
        document.body.classList.add("play-overlay-open");

        renderMaker("");
    }

    function closeMaker() {
        if (!overlay || overlay.hidden) {
            ui.maker = null;
            return;
        }

        overlay.hidden = true;
        document.body.classList.remove("play-overlay-open");
        ui.maker = null;
    }

    function isReady(type) {
        if (!activeAssignment || !isCardTypeValidForAssignment(type)) return false;

        if (!cardNameInput.value.trim()) return false;

        return !cardUsesPattern(type) ||
            selectedPositions.size === activeAssignment.targetCount;
    }

    function confirmCard() {
        const type = ui.maker;

        if (!type || !isReady(type)) return;

        checkCardValidity();

        if (saveCardButton.disabled) {
            renderMaker("That card can't be saved yet.");
            return;
        }

        renderMaker("Saving card...");

        // The same button the old creator used; script.js sends the card.
        saveCardButton.click();
    }

    function toggleCell(index) {
        const count = activeAssignment.targetCount;

        if (selectedPositions.has(index)) {
            selectedPositions.delete(index);
        } else if (selectedPositions.size < count) {
            selectedPositions.add(index);
        }

        updateCardGrid();
        checkCardValidity();
        renderMaker("");
    }

    function renderMaker(message) {
        const type = ui.maker;

        if (!type || !activeAssignment) {
            closeMaker();
            return;
        }

        const count = activeAssignment.targetCount;
        const usesPattern = cardUsesPattern(type);
        const card = previewCard(type);

        card.pattern = [...selectedPositions];

        /* Header: the card, and what to do */
        const header = el("div", "play-overlay-header");

        const faceBox = el("div", "play-overlay-face");
        faceBox.appendChild(createCompactCardFace(card));

        const copy = el("div", "play-overlay-copy");
        copy.append(
            el("span", "play-overlay-kicker", `NEW ${getCardOptionName(type).toUpperCase()} CARD`),
            el("h2", "play-overlay-title", getCardOptionName(type)),
            el(
                "p",
                "play-overlay-instruction pg-maker-instruction",
                usesPattern
                    ? `Pick exactly ${count} positions for this card's pattern.`
                    : "Read how this card works, then confirm to make it."
            )
        );

        header.append(faceBox, copy);

        /* Body: the grid + warning, or the guide */
        const body = el("div", usesPattern ? "pg-maker-body" : "pg-maker-body pg-guide-body");

        if (usesPattern) {
            body.append(buildPatternGrid(count), buildWarning());
        } else {
            body.appendChild(buildGuide(type, count));
        }

        /* Footer: name, back, confirm */
        const footer = el("div", "pg-maker-footer");

        const nameLabel = el("label", "pg-maker-label", "CARD NAME");
        nameLabel.htmlFor = "pg-maker-name";

        const name = el("input", "pg-maker-name");
        name.id = "pg-maker-name";
        name.type = "text";
        name.maxLength = 24;
        name.value = cardNameInput.value;
        name.autocomplete = "off";

        name.addEventListener("input", () => {
            cardNameInput.value = name.value;
            checkCardValidity();
            confirm.disabled = !isReady(type);
        });

        const status = el(
            "span",
            "pg-maker-status",
            message ||
                (usesPattern ? `${selectedPositions.size} / ${count} selected` : "")
        );

        const back = el("button", "primary-button pg-maker-back", "BACK");
        back.type = "button";
        back.addEventListener("click", closeMaker);

        const confirm = el("button", "primary-button pg-maker-confirm", "CONFIRM CARD");
        confirm.type = "button";
        confirm.disabled = !isReady(type);
        confirm.addEventListener("click", confirmCard);

        footer.append(nameLabel, name, status, back, confirm);

        // Keep typing focus when only the footer status changes.
        const hadFocus = document.activeElement?.id === "pg-maker-name";

        overlay.replaceChildren(header, body, footer);

        if (hadFocus) {
            const field = document.getElementById("pg-maker-name");
            field?.focus();
            field?.setSelectionRange(field.value.length, field.value.length);
        }
    }

    function buildPatternGrid(count) {
        const wrap = el("div", "pg-grid-wrap");
        const grid = el("div", "pg-big-grid");

        for (let i = 0; i < 9; i++) {
            const cell = el("button", "grid-cell hp pg-big-cell");
            cell.type = "button";
            cell.classList.toggle("target-preview", selectedPositions.has(i));
            cell.classList.toggle("is-center", i === CENTER);
            cell.setAttribute(
                "aria-label",
                `Position ${i + 1}${i === CENTER ? " (center)" : ""}` +
                    `${selectedPositions.has(i) ? ", selected" : ""}`
            );
            cell.setAttribute("aria-pressed", String(selectedPositions.has(i)));
            cell.addEventListener("click", () => toggleCell(i));

            if (i === CENTER) cell.appendChild(el("span", "pg-center-tag", "CENTER"));

            grid.appendChild(cell);
        }

        wrap.append(
            grid,
            el("p", "pg-grid-count", `${selectedPositions.size} / ${count}`)
        );

        return wrap;
    }

    function buildWarning() {
        const warning = el("div", "pg-warning");

        warning.setAttribute("role", "note");
        warning.append(
            el("span", "pg-warning-mark", "!"),
            el("p", "pg-warning-text", GRID_WARNING)
        );

        return warning;
    }


    /* ---------- The guides (cards that are not aimed on a grid) ---------- */

    function buildMiniGrid(spec) {
        const box = el("div", "pg-mini");
        const grid = el("div", "pg-mini-grid");

        spec.cells.forEach((state, index) => {
            const cell = el("i", `grid-cell ${state}`);
            cell.classList.toggle("is-hit", (spec.hit || []).includes(index));
            grid.appendChild(cell);
        });

        box.append(grid);

        if (spec.label) box.appendChild(el("span", "pg-mini-label", spec.label));

        return box;
    }

    // What every card costs at 4 positions, with and without Hex.
    function buildHexCosts() {
        const count = 4;

        // Mage's whole toolkit, plus the Attack and Heal cards everyone can make.
        const types = ["attack", "heal", "blast", "spellvamp", "curse", "hex"];

        const table = el("div", "pg-hex-table");

        types.forEach(type => {
            const base = getCardEnergyCost(type, count, { discounted: false });
            const affected = HEX_AFFECTED_CARDS.includes(type);
            const cheaper = affected ? Math.max(HEX_MIN_COST, base - HEX_DISCOUNT) : base;

            const row = el("div", "pg-hex-row");
            row.classList.toggle("is-affected", affected);

            const icon = document.createElement("img");
            icon.src = `/assets/${type}.png`;
            icon.alt = "";
            icon.draggable = false;

            const name = el("span", "pg-hex-name", getCardOptionName(type));

            const price = el("span", "pg-hex-price");

            if (affected) {
                price.append(
                    el("s", "pg-hex-old", String(base)),
                    el("strong", "pg-hex-new", String(cheaper))
                );
            } else {
                price.append(el("strong", "pg-hex-same", String(base)));
            }

            const note = el(
                "span",
                "pg-hex-note",
                affected ? `-${base - cheaper}` : "no change"
            );

            row.append(icon, name, price, note);
            table.appendChild(row);
        });

        return table;
    }

    function buildFrameVisual(visual) {
        const box = el("div", "pg-frame-visual");

        if (visual.kind === "card") {
            const icon = document.createElement("img");
            icon.className = "pg-frame-icon";
            icon.src = `/assets/${visual.type}.png`;
            icon.alt = "";
            icon.draggable = false;

            box.append(icon, el("strong", "pg-frame-note", visual.note || ""));
        } else if (visual.kind === "grids") {
            visual.grids.forEach(grid => box.appendChild(buildMiniGrid(grid)));
        } else if (visual.kind === "text") {
            visual.lines.forEach(line => box.appendChild(el("strong", "pg-frame-line", line)));
        } else if (visual.kind === "hex-costs") {
            box.appendChild(buildHexCosts());
        }

        return box;
    }

    function buildGuide(type, count) {
        const guide = CARD_GUIDES[type];
        const wrap = el("div", "pg-guide");

        if (!guide) {
            // A card with no written guide yet: at least say what it does.
            wrap.append(
                el("p", "pg-guide-summary", CARD_DEFS[type]?.description?.(previewCard(type)) || ""),
            );
            return wrap;
        }

        wrap.appendChild(el("p", "pg-guide-summary", guide.summary));

        const frames = el("ol", "pg-frames");

        guide.frames.forEach((frame, index) => {
            const item = el("li", "pg-frame");

            item.append(
                el("span", "pg-frame-number", String(index + 1)),
                el("h3", "pg-frame-title", frame.title),
                buildFrameVisual(frame.visual),
                el("p", "pg-frame-caption", frame.caption)
            );

            frames.appendChild(item);

            if (index < guide.frames.length - 1) {
                frames.appendChild(el("li", "pg-frame-arrow", "➜"));
            }
        });

        wrap.appendChild(frames);

        const lists = el("div", "pg-reach");

        const can = el("div", "pg-reach-box is-can");
        can.appendChild(el("h4", "", "IT CAN"));
        guide.can.forEach(text => can.appendChild(el("p", "", text)));

        const cannot = el("div", "pg-reach-box is-cannot");
        cannot.appendChild(el("h4", "", "IT CANNOT"));
        guide.cannot.forEach(text => cannot.appendChild(el("p", "", text)));

        lists.append(can, cannot);
        wrap.appendChild(lists);

        // Cost for this assignment, so the numbers are real.
        const cost = getCardEnergyCost(type, count, { discounted: false });

        wrap.appendChild(el(
            "p",
            "pg-guide-cost",
            `With ${count} positions this card costs ${cost} Energy.`
        ));

        return wrap;
    }


    /* ---------- Keep it current ---------- */

    function later() {
        // After script.js has applied the new state.
        queueMicrotask(render);
    }

    [
        "room-joined",
        "player-state",
        "assignment-received",
        "card-discarded",
        "card-discard-error"
    ].forEach(eventName => socket.on(eventName, later));

    socket.on("card-saved", () => {
        // Back to the start: "(No Assignment)".
        ui.assignmentKey = null;
        closeMaker();
        later();
    });

    socket.on("card-save-error", message => {
        if (ui.maker) renderMaker(message);
        else ui.notice = message;

        later();
    });

    socket.on("room-closed", () => {
        ui.assignmentKey = null;
        closeMaker();
        ui.notice = "";
    });

    renderEmpty("(No Assignment)");
})();
