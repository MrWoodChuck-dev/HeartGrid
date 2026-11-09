/* =====================================
   CARDS  (client side)
===================================== */

/*
    Every card is described ONCE, in CARD_DEFS below: its name, colour, rules,
    how it is aimed, how it reads on the card, and what message each player
    (and the Host) sees when it is played. script.js only knows how to run a
    generic card (drag it in, aim it, send it), so adding a card never means
    touching script.js.

    TO ADD A NEW CARD
        1. Add an entry to CARD_DEFS.
        2. Put its name in CARD_TYPES_BY_CLASS.
        3. Mirror it in cards-server.js (CARD_DEFS, CLASS_CARD_TYPES, handler).
        4. Drop its icon in assets/<type>.png.
        5. (Optional) add an animation for it in stage.js.

    This file loads BEFORE script.js and only defines things. Everything it
    needs from the game (socket, currentEncounter, roomPlayers ...) is read
    when a card is actually used, and the event listeners are attached by
    registerCardEvents(socket), which script.js calls once the socket exists.

    HOW A CARD IS AIMED  (def.mode)
        monster   pick a Monster (the overlay lists them), then aim its 3x3
                  pattern on that Monster's grid. def.multi = 2 lets Blast
                  aim at two different Monsters.
        monsterpick  pick a Monster, nothing to aim (Execute, Counter)
        self      aim its pattern on your own grid
        heal      pick a player, then aim its pattern on their grid
        buff      pick a teammate (no grid)
        shield    pick any player, you included (no grid)
        none      no aiming at all: dropping the card is the whole action
*/

const RAGE_ENERGY_PER_POSITION = 2;

// Hex takes this much off Attack / Blast / Spellvamp / Curse (never below the minimum).
const HEX_DISCOUNT = 2;
const HEX_MIN_COST = 0.5;
const HEX_AFFECTED_CARDS = ["attack", "heal", "blast", "spellvamp", "curse"];

// Destroying an Armor cell with a direct attack costs the attacker this much.
const ARMOR_ENERGY_PENALTY = 0.5;

const CARD_TYPES_BY_CLASS = {
    Tank: ["attack", "taunt", "retaliate", "rest"],
    Warrior: ["attack", "rage", "counter", "execute"],
    Mage: ["blast", "spellvamp", "curse", "hex"],
    Support: ["heal", "buff", "weaken", "shield"],
    Thief: ["attack", "status", "lifesteal", "penetrate"]
};

function isArmorCellType(cell) {
    return cell === "armor" || cell === "armor-overheal";
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// What the monster-damage part of an Attack / Blast result says.
function describeGridDamage(result) {
    const parts = [
        `${result.damage ?? 0} HP removed from ${result.monsterName || "the monster"}`
    ];

    if (result.overhealDamage > 0) {
        parts.push(`${result.overhealDamage} Overheal stripped`);
    }

    if (result.armorDestroyed > 0) {
        parts.push(`${plural(result.armorDestroyed, "Armor cell")} destroyed`);
    }

    if (result.connectedArmor > 0) {
        parts.push(`${result.connectedArmor} connected Armor stripped`);
    }

    if (result.statusDamage > 0) {
        parts.push(`Status dealt ${result.statusDamage} more`);
    }

    if (result.healed > 0) {
        parts.push(`${result.healed} HP restored`);
    }

    return parts.join(" · ");
}

function describeEnergyPenalty(result) {
    return result.energyPenalty > 0
        ? ` (Armor cost you ${result.energyPenalty} extra Energy)`
        : "";
}

function describeAimHint() {
    return window.matchMedia("(hover: none)").matches
        ? "Tap a spot to preview the pattern, then tap it again to confirm."
        : "Move over the grid to preview the pattern, then click to confirm.";
}


/* =====================================
   CARD DEFINITIONS
===================================== */

const CARD_DEFS = {

    /* ---------- Shared: Attack ---------- */

    attack: {
        name: "Attack",
        label: "ATTACK CARD",
        color: "#d94848",
        pattern: true,
        cost: n => n,
        mode: "monster",
        event: "player-attack",
        resolvedEvent: "player-attack-resolved",
        duringCounter: true,

        description:
            "Attack the monster using the selected pattern. Costs 1 Energy per position. " +
            "Destroying Armor works, but costs you 0.5 extra Energy per Armor cell.",
        play: () =>
            "Strike the monster. Aim this card's pattern on the monster's grid; every position " +
            "it covers is hit. Each Armor cell you destroy costs you 0.5 extra Energy.",
        aim: () => `Choose where to strike the monster. ${describeAimHint()}`,
        pending: card => `Attacking with ${card.name}...`,

        messages: r => ({
            own: `You used ${r.cardName}. ${describeGridDamage(r)}.${describeEnergyPenalty(r)}`,
            other: `${r.username} used ${r.cardName}. ${describeGridDamage(r)}.`,
            host: `${r.username} used ${r.cardName}: ${describeGridDamage(r)}.`
        })
    },

    /* ---------- Heal (Support) ---------- */

    heal: {
        name: "Heal",
        label: "HEAL CARD",
        color: "#3986d6",
        pattern: true,
        cost: n => n,
        mode: "heal",
        event: "player-heal",
        resolvedEvent: "player-heal-resolved",

        description:
            "Heal yourself or a teammate. Empty cells become HP, and HP becomes Overheal. " +
            "Costs 1 Energy per position.",
        play: () =>
            "Heal yourself or a teammate. Empty positions in the pattern become HP, and HP " +
            "positions become Overheal.",
        aim: () =>
            "Choose who to heal, then aim on their grid. Empty positions become HP, and HP becomes Overheal.",

        hasTarget: card =>
            roomPlayers.some(
                player => !isDeadPlayer(player) &&
                    hasValidPlacement(card, "heal", getGridDataForPlayer(player))
            ),

        messages: r => ({
            own: `You used ${r.cardName}. ${r.healed ?? 0} HP restored · ${r.overhealed ?? 0} Overheal added.`,
            other: `${r.username} used ${r.cardName} on ${r.targetUsername}.`,
            host: `${r.username} healed ${r.targetUsername} with ${r.cardName}.`
        })
    },

    /* ---------- Support ---------- */

    buff: {
        name: "Buff",
        label: "BUFF CARD",
        color: "#d49a1a",
        pattern: false,
        cost: n => n,
        mode: "buff",
        event: "player-buff",
        resolvedEvent: "player-buff-resolved",

        description:
            "Give a teammate Energy equal to this card's position count. You pay the same amount. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Gives a teammate ${n} Energy and costs ${cost} Energy.`,
        effect: (n, cost) => `Give ${n} Energy · costs ${cost}`,
        play: card =>
            `Give a teammate ${card.targetCount} Energy. You spend ${card.targetCount} Energy too. No grid needed.`,
        aim: card =>
            `Choose a teammate. You spend ${card.targetCount} Energy and they gain ${card.targetCount}.`,

        hasTarget: () => getLivingTeammates().length > 0,

        messages: r => ({
            own: `You gave ${r.energyTransferred} Energy to ${r.targetUsername}.`,
            other: r.targetPlayerID === currentPlayerID
                ? `${r.username} gave you ${r.energyTransferred} Energy!`
                : `${r.username} gave ${r.energyTransferred} Energy to ${r.targetUsername}.`,
            host: `${r.username} gave ${r.energyTransferred} Energy to ${r.targetUsername}.`
        })
    },

    weaken: {
        name: "Weaken",
        label: "WEAKEN CARD",
        color: "#54728a",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "none",
        event: "player-weaken",
        resolvedEvent: "player-weaken-resolved",

        description:
            "Reduce the monster's next damage by one per position. Weaken stacks; if it absorbs the " +
            "whole D10 roll, the monster skips its turn. Costs exactly 1.5 Energy per position. " +
            "Requires 2-6 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Adds ${n} Weaken and costs ${cost} Energy.`,
        effect: (n, cost) => `Add ${n} Weaken · costs ${cost}`,
        play: card =>
            `Reduce the monster's next attack by ${card.targetCount}. Weaken stacks, and if it cancels the whole ` +
            "D10 roll the monster skips its turn. No grid needed.",

        messages: r => {
            const text = `${r.username} added ${r.added} Weaken. ${r.weaken} total Weaken now active.`;
            return { own: text, other: text, host: text };
        }
    },

    shield: {
        name: "Shield",
        label: "SHIELD CARD",
        color: "#3d9ec7",
        pattern: false,
        min: 2,
        max: 3,
        cost: n => n * 2.5,
        mode: "shield",
        event: "player-shield",
        resolvedEvent: "player-shield-resolved",

        description:
            "Make one player (you can pick yourself) untargetable by the monsters for a number of rounds " +
            "(counting from the next round) equal to this card's positions. Afterwards they get Shield Break and " +
            "can't be Shielded again for 4 rounds (5 if the Shield lasted 3). Only one Shield at a time. " +
            "Costs 2.5 Energy per position. Requires 2-3 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Shields a player for ${n} rounds (from next round) and costs ${cost} Energy.`,
        effect: (n, cost) => `Shield ${n} rounds · costs ${cost}`,
        play: card =>
            `Pick a player: for ${card.targetCount} rounds (counting from next round) the monsters cannot target them. ` +
            `Then they suffer Shield Break (${card.targetCount === 3 ? 5 : 4} turns) and can't be ` +
            "Shielded again. Only one Shield can be active at a time.",
        aim: card =>
            `Choose who to protect. The monster can't target them for ${card.targetCount} of its turns.`,

        hasTarget: () => getShieldCandidates().some(entry => entry.allowed),

        messages: r => ({
            own: `You shielded ${r.targetUsername} for ${r.turns} round(s), starting next round.`,
            other: r.targetPlayerID === currentPlayerID
                ? `${r.username} shielded you! The monsters can't target you for ${r.turns} round(s).`
                : `${r.username} shielded ${r.targetUsername} for ${r.turns} round(s).`,
            host: `${r.username} shielded ${r.targetUsername}: the monsters cannot target them for ${r.turns} round(s).`
        })
    },

    /* ---------- Warrior ---------- */

    rage: {
        name: "Rage",
        label: "RAGE CARD",
        color: "#b02a2a",
        pattern: true,
        cost: () => 0,
        mode: "self",
        event: "player-rage",
        resolvedEvent: "player-rage-resolved",
        duringCounter: true,

        description:
            "Sacrifice your own HP / Overheal positions to gain 2 Energy per position. Costs no Energy.",
        effect: n => `Sacrifice ${n} positions · gain ${n * RAGE_ENERGY_PER_POSITION} Energy`,
        play: () =>
            `Sacrifice HP or Overheal positions from your own grid. You gain ${RAGE_ENERGY_PER_POSITION} ` +
            "Energy for every position sacrificed. This card costs no Energy.",
        aim: card =>
            `Aim at your own HP or Overheal positions to sacrifice. You gain ${card.targetCount * RAGE_ENERGY_PER_POSITION} Energy.`,
        pending: card => `Unleashing ${card.name}...`,

        valid: (card, positions, data) =>
            positions.every(
                position => data.cells[position] === "hp" ||
                    data.cells[position] === "overheal"
            ),
        invalidMessage: "Rage can only sacrifice HP or Overheal positions.",

        messages: r => {
            const sacrificed = (r.healthSacrificed || 0) + (r.overhealSacrificed || 0);

            return {
                own: `You used ${r.cardName}. Sacrificed ${sacrificed} position(s), gained ${r.energyGained} Energy.`,
                other: `${r.username} used ${r.cardName} and gained ${r.energyGained} Energy.`,
                host: `${r.username} used ${r.cardName} and gained ${r.energyGained} Energy.`
            };
        }
    },

    counter: {
        name: "Counter",
        label: "COUNTER CARD",
        color: "#2878a8",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n,
        mode: "monsterpick",
        event: "player-counter",
        resolvedEvent: "player-counter-resolved",

        description:
            "Pick ONE Monster (its Taunt is ignored). Gain one Counter Turn per position: after THAT Monster " +
            "finishes its turn you interrupt the turn order and get an extra Attack turn, and that attack can " +
            "only hit the Monster you countered. No Energy regeneration during that extra turn. Costs exactly " +
            "1 Energy per position. Requires 2-6 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Grants ${n} Counter Turns and costs ${cost} Energy.`,
        effect: (n, cost) => `${n} Counter Turns · costs ${cost}`,
        play: card =>
            `Choose one Monster. Gain ${card.targetCount} Counter Turn${card.targetCount === 1 ? "" : "s"}: after that ` +
            "Monster finishes its turn, you get an extra Attack turn for each one, aimed only at it (no Energy " +
            "regeneration on those turns). Ignores Taunt.",
        aim: () => "Choose the one Monster to Counter. Its Taunt is ignored.",

        messages: r => ({
            own: `Counter activated on ${r.monsterName}. ${r.counterTurns} Counter Turn(s) ready. ` +
                `After ${r.monsterName}'s turn, you can make an additional Attack against it.`,
            other: `${r.username} gained ${r.added} Counter Turn(s) against ${r.monsterName}. ${r.counterTurns} now ready.`,
            host: `${r.username} readied ${r.added} Counter Turn(s) against ${r.monsterName} (${r.counterTurns} total). ` +
                "They get a bonus turn after its turn."
        })
    },

    execute: {
        name: "Execute",
        label: "EXECUTE CARD",
        color: "#8a1f1f",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "monsterpick",
        event: "player-execute",
        resolvedEvent: "player-execute-resolved",

        description:
            "Eliminate random healthy monster cells, one per position. No aiming. It is not a grid attack, so " +
            "it can't touch Armor (or Overheal). Costs 1.5 Energy per position. Requires 2-6 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Executes up to ${n} random healthy cells and costs ${cost} Energy.`,
        effect: (n, cost) => `Execute ${n} random cells · costs ${cost}`,
        play: card =>
            `Eliminate up to ${card.targetCount} random healthy monster positions. You don't aim it, and it ` +
            "ignores Armor and Overheal.",

        hasTarget: card =>
            getSelectableMonsters(card).some(monster => monster.grid.includes("hp")),

        messages: r => {
            const text = r.adaptive
                ? `${r.monsterName}'s Adaptive Armor turned it into healing!`
                : `${r.damage} HP removed from ${r.monsterName}.`;

            return {
                own: `You used ${r.cardName}. ${text}`,
                other: `${r.username} used ${r.cardName}. ${text}`,
                host: `${r.username} used ${r.cardName}: ${text}`
            };
        }
    },

    /* ---------- Tank ---------- */

    taunt: {
        name: "Taunt",
        label: "TAUNT CARD",
        color: "#7a5bc4",
        pattern: false,
        cost: n => n,
        mode: "none",
        event: "player-taunt",
        resolvedEvent: "player-taunt-resolved",

        description:
            "Force the monster to target you. Each position absorbs one hit, and Taunt stacks. Costs 1 Energy " +
            "per position. No pattern needed. (It waits while you are Resting or Shielded.)",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Soaks ${n} monster hits and costs ${cost} Energy.`,
        effect: (n, cost) => `Soak ${n} hits · costs ${cost}`,
        play: card =>
            `Force the monster to attack you. It must hit you ${card.targetCount} time` +
            `${card.targetCount === 1 ? "" : "s"}, and using Taunt again stacks more hits. No grid needed.`,

        messages: r => ({
            own: `You used ${r.cardName}. The monster must hit you for ${r.remainingDamage} more hit(s).`,
            other: `${r.username} taunted the monster! (${r.remainingDamage} hit(s) forced)`,
            host: `${r.username} taunted the monster! It must hit them ${r.remainingDamage} more time(s).`
        })
    },

    retaliate: {
        name: "Retaliate",
        label: "RETALIATE CARD",
        color: "#c9a000",
        pattern: true,
        cost: n => n,
        mode: "self",
        event: "player-retaliate",
        resolvedEvent: "player-retaliate-resolved",

        description:
            "Mark your own plain HP positions. Each marked position retaliates once when that exact cell takes " +
            "HP damage, striking a random healthy monster cell (never Armor). Marks cannot be placed on " +
            "Overheal or empty cells. Costs 1 Energy per position.",
        effect: (n, cost) => `Mark ${n} HP positions · retaliate once per mark · costs ${cost}`,
        play: () =>
            "Mark plain HP positions on your own grid. Each mark strikes back once, hitting a random healthy " +
            "monster position, the first time that exact position takes damage.",
        aim: () =>
            "Aim at your own plain HP positions to mark them. Each mark retaliates once when that cell takes damage.",
        pending: card => `Setting ${card.name} marks...`,

        valid: (card, positions, data) =>
            positions.every(
                position => data.cells[position] === "hp" &&
                    !data.marks.has(position)
            ),
        invalidMessage:
            "Retaliate can only mark unmarked plain HP positions (not Overheal or empty cells).",

        messages: r => ({
            own: `You set ${r.marked} Retaliate mark(s). Each triggers once when damaged.`,
            other: `${r.username} marked ${r.marked} position(s) with ${r.cardName}.`,
            host: `${r.username} prepared ${r.marked} hidden Retaliate mark(s).`
        })
    },

    rest: {
        name: "Rest",
        label: "REST CARD",
        color: "#4a7bb5",
        pattern: false,
        min: 4,
        max: 7,
        cost: () => 0,
        mode: "none",
        event: "player-rest",
        resolvedEvent: "player-rest-resolved",

        description:
            "Rest for a number of your turns equal to this card's positions. You can't do anything while " +
            "resting (it can't be cancelled, even if the monster attacks you) and your Taunt waits. Each Rest " +
            "turn you gain +3 Energy instead of +1 and heal a cell (empty ones first, then Overheal). " +
            "Costs no Energy. Requires 4-7 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Rest for ${n} turns (+3 Energy and a heal each turn). Costs ${cost} Energy.`,
        effect: (n, cost) => `Rest ${n} turns · costs ${cost}`,
        play: card =>
            `Skip your next ${card.targetCount} turns to recover: +3 Energy and a heal on each. You can't act ` +
            "or be woken up, and Taunt is paused. Playing Rest ends your turn right away.",

        messages: r => ({
            own: `You are resting for ${r.turns} turn(s). You can't act until it ends.`,
            other: `${r.username} is resting for ${r.turns} turn(s).`,
            host: `${r.username} is resting for ${r.turns} turn(s).`
        })
    },

    /* ---------- Mage ---------- */

    blast: {
        name: "Blast",
        label: "BLAST CARD",
        color: "#e0702a",
        pattern: true,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "monster",
        multi: 2,
        event: "player-blast",
        resolvedEvent: "player-blast-resolved",

        description:
            "Area attack on the monster's grid. Built to hit up to two different monsters at once (never the " +
            "same one twice), so against a single monster it lands once. Costs 1.5 Energy per position. " +
            "Requires 2-6 positions. Destroying Armor costs you 0.5 extra Energy each.",
        play: () =>
            "Blast the monster's grid with this pattern. It can hit two different monsters at once, but it " +
            "can never hit the same monster twice. Each Armor cell destroyed costs you 0.5 extra Energy.",
        aim: () => `Choose where to blast the monster. ${describeAimHint()}`,
        pending: card => `Blasting with ${card.name}...`,

        messages: r => ({
            own: `You used ${r.cardName}. ${describeGridDamage(r)}.${describeEnergyPenalty(r)}`,
            other: `${r.username} blasted with ${r.cardName}. ${describeGridDamage(r)}.`,
            host: `${r.username} used ${r.cardName}: ${describeGridDamage(r)}.`
        })
    },

    spellvamp: {
        name: "Spellvamp",
        label: "SPELLVAMP CARD",
        color: "#2fa8a0",
        pattern: true,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "monster",
        event: "player-spellvamp",
        resolvedEvent: "player-spellvamp-resolved",

        description:
            "Strips Armor and Overheal off the monster's grid. It deals NO damage, and only those cells are " +
            "affected. Each layer removed gives 1 Spellvamp Charge (Armor over Overheal gives 2 and leaves plain HP). " +
            "Every 3 charges heal you automatically: empty cells first, then Overheal. Costs 1.5 Energy per " +
            "position. Requires 2-6 positions. Removing Armor costs you 0.5 extra Energy each.",
        play: () =>
            "Strip the Armor and Overheal under this pattern (other cells are ignored). No damage is dealt. " +
            "Each layer removed gives a Spellvamp Charge (2 for Armor over Overheal) and every 3 charges heal you.",
        aim: () =>
            `Aim at Armor or Overheal cells; the rest of the pattern is ignored. ${describeAimHint()}`,
        pending: card => `Casting ${card.name}...`,

        // At least one Armor / Overheal cell must be under the pattern.
        valid: (card, positions, data) =>
            positions.some(
                position => isArmorCellType(data.cells[position]) ||
                    data.cells[position] === "overheal"
            ),
        invalidMessage:
            "There is nothing to hit there. Spellvamp only targets Armor and Overheal.",

        messages: r => {
            const healed =
                (r.healedPositions?.length || 0) + (r.overhealedPositions?.length || 0);

            const base =
                `${r.armorDestroyed > 0 ? plural(r.armorDestroyed, "Armor cell") + " removed · " : ""}` +
                `${r.overhealStripped > 0 ? r.overhealStripped + " Overheal removed · " : ""}` +
                `+${r.chargesGained} charge(s) (${r.charges} stored)` +
                (healed > 0 ? ` · healed ${healed}` : "");

            return {
                own: `You used ${r.cardName}. ${base}.${describeEnergyPenalty(r)}`,
                other: `${r.username} used ${r.cardName}. ${base}.`,
                host: `${r.username} used ${r.cardName}. ${base}.`
            };
        }
    },

    curse: {
        name: "Curse",
        label: "CURSE CARD",
        color: "#9b63d2",
        pattern: true,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "monster",
        event: "player-curse",
        resolvedEvent: "player-curse-resolved",

        description:
            "Mark healthy monster cells. When a marked cell is damaged, it also damages its up, down, left, and " +
            "right neighbors. Explosions can trigger other marked cells in a chain, but Armor can't be marked and " +
            "ignores explosions. Costs exactly 1.5 Energy per position. Requires 2-6 positions.",
        effect: (n, cost) => `Mark ${n} monster cells · chain explosions · costs ${cost}`,
        play: () =>
            "Mark healthy monster positions. When a marked position is damaged, it also damages the positions " +
            "above, below, left and right of it, chaining through other marks. Armor can't be cursed.",
        aim: () => `Choose which healthy monster positions to curse. ${describeAimHint()}`,
        pending: card => `Marking monster cells with ${card.name}...`,

        valid: (card, positions, data) =>
            positions.some(
                position => data.cells[position] === "hp" &&
                    !data.curses.has(position)
            ),
        invalidMessage:
            "There is nothing to curse there. Aim at healthy, uncursed positions.",

        messages: r => r.adaptive
            ? {
                own: `${r.monsterName}'s Adaptive Armor turned your Curse into healing!`,
                other: `${r.username}'s Curse on ${r.monsterName} became healing.`,
                host: `${r.username}'s Curse on ${r.monsterName} became healing.`
            }
            : {
                own: `You marked ${r.marked} cell(s) of ${r.monsterName} with Curse. Damaging them triggers chain explosions.`,
                other: `${r.username} cursed ${r.marked} position(s) of ${r.monsterName}.`,
                host: `${r.username} cursed ${r.marked} position(s) of ${r.monsterName}.`
            }
    },

    hex: {
        name: "Hex",
        label: "HEX CARD",
        color: "#7a3fb0",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n * 1.5,
        mode: "none",
        event: "player-hex",
        resolvedEvent: "player-hex-resolved",

        description:
            "For a number of rounds (counting from the next round) equal to this card's positions, EVERY player's Attack, Heal, Blast, Spellvamp and Curse cards " +
            "cost 2 less Energy (never below 0.5). Re-casting it doesn't stack, it only refreshes. Costs 1.5 Energy " +
            "per position. Requires 2-6 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Attack, Heal, Blast, Spellvamp and Curse cost 2 less for ${n} rounds. Costs ${cost} Energy.`,
        effect: (n, cost) => `Hex ${n} rounds · costs ${cost}`,
        play: card =>
            `For ${card.targetCount} rounds, every player's Attack, Heal, Blast, Spellvamp and Curse cards cost 2 less Energy (never below 0.5) ` +
            "(never below 0.5). No grid needed.",

        messages: r => ({
            own: `Hex cast! Attack, Heal, Blast, Spellvamp and Curse cost 2 less for ${r.turns} round(s), starting next round.`,
            other: `${r.username} cast Hex: Attack, Heal, Blast, Spellvamp and Curse cost 2 less for ${r.turns} round(s).`,
            host: `${r.username} cast Hex: Attack, Heal, Blast, Spellvamp and Curse cost 2 less for ${r.turns} round(s).`
        })
    },

    /* ---------- Thief ---------- */

    status: {
        name: "Status",
        label: "STATUS CARD",
        color: "#43a66b",
        pattern: false,
        cost: n => n,
        mode: "none",
        event: "player-status",
        resolvedEvent: "player-status-resolved",

        description:
            "Gain one Status Charge per position. Every successful hit of your Attack spends one to deal 1-2 " +
            "extra damage to random healthy or Overheal cells (never Armor). Costs 1 Energy per position. " +
            "No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Gives ${n} Status Charges and costs ${cost} Energy.`,
        effect: (n, cost) => `${n} Status Charges · costs ${cost}`,
        play: card =>
            `Load ${card.targetCount} Status Charge${card.targetCount === 1 ? "" : "s"}. Each successful hit of ` +
            "your Attack spends one to deal 1-2 more damage to random healthy or Overheal cells. Never hits Armor.",

        messages: r => ({
            own: `You loaded ${r.added} Status Charge(s). ${r.charges} ready.`,
            other: `${r.username} loaded ${r.added} Status Charge(s).`,
            host: `${r.username} loaded ${r.added} Status Charge(s) (${r.charges} total).`
        })
    },

    lifesteal: {
        name: "Lifesteal",
        label: "LIFESTEAL CARD",
        color: "#c0396b",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n,
        mode: "none",
        event: "player-lifesteal",
        resolvedEvent: "player-lifesteal-resolved",

        description:
            "Gain one Lifesteal Charge per position. Every successful hit of your Attack spends one to heal one " +
            "of your empty cells (never Overheal). Armor doesn't trigger it unless Penetrate pierces it. " +
            "Costs 1 Energy per position. Requires 2-6 positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Gives ${n} Lifesteal Charges and costs ${cost} Energy.`,
        effect: (n, cost) => `${n} Lifesteal Charges · costs ${cost}`,
        play: card =>
            `Load ${card.targetCount} Lifesteal Charge${card.targetCount === 1 ? "" : "s"}. Each successful hit ` +
            "of your Attack spends one to heal an empty cell on your grid. It can't Overheal.",

        messages: r => ({
            own: `You loaded ${r.added} Lifesteal Charge(s). ${r.charges} ready.`,
            other: `${r.username} loaded ${r.added} Lifesteal Charge(s).`,
            host: `${r.username} loaded ${r.added} Lifesteal Charge(s) (${r.charges} total).`
        })
    },

    penetrate: {
        name: "Penetrate",
        label: "PENETRATE CARD",
        color: "#c98a2b",
        pattern: false,
        min: 2,
        max: 6,
        cost: n => n,
        mode: "none",
        event: "player-penetrate",
        resolvedEvent: "player-penetrate-resolved",

        description:
            "Gain one Penetrate Charge per position. A charge pierces Armor your Attack hits directly (no Energy " +
            "penalty, and it lets Lifesteal work), or strips the Armor right next to a cell you hit (up, down, " +
            "left, right). That connected removal deals no damage. Costs 1 Energy per position. Requires 2-6 " +
            "positions. No pattern needed.",
        summary: (n, cost) =>
            `Assigned: ${n} positions. Gives ${n} Penetrate Charges and costs ${cost} Energy.`,
        effect: (n, cost) => `${n} Penetrate Charges · costs ${cost}`,
        play: card =>
            `Load ${card.targetCount} Penetrate Charge${card.targetCount === 1 ? "" : "s"}. Each one pierces Armor ` +
            "you attack (no Energy penalty, Lifesteal works) or strips Armor next to a cell you hit (no damage).",

        messages: r => ({
            own: `You loaded ${r.added} Penetrate Charge(s). ${r.charges} ready.`,
            other: `${r.username} loaded ${r.added} Penetrate Charge(s).`,
            host: `${r.username} loaded ${r.added} Penetrate Charge(s) (${r.charges} total).`
        })
    }
};


/* =====================================
   LOOKUPS  (what script.js calls)
===================================== */

function getCardDef(type) {
    return CARD_DEFS[type] || null;
}

function getCardRule(type) {
    const def = CARD_DEFS[type];

    return def && def.min !== undefined
        ? { min: def.min, max: def.max }
        : null;
}

function cardUsesPattern(type) {
    return Boolean(CARD_DEFS[type]?.pattern);
}

function getCardTypeLabel(type) {
    return CARD_DEFS[type]?.label || "CARD";
}

function getCardOptionName(type) {
    return CARD_DEFS[type]?.name || type;
}

function getCardColor(type) {
    return CARD_DEFS[type]?.color || "#666";
}

function getCardTypeDescription(type) {
    return CARD_DEFS[type]?.description || "";
}

function getCardPlayMode(card) {
    return CARD_DEFS[card.type]?.mode || "none";
}

// Is this card allowed on a Counter turn?
function isAllowedOnCounterTurn(card) {
    return Boolean(CARD_DEFS[card.type]?.duringCounter);
}

// Plain-language "what does this card do" text for the hover card.
function getCardPlayDescription(card) {
    const def = CARD_DEFS[card.type];

    return def?.play ? def.play(card) : (def?.description || "");
}

function getCardAimInstruction(card) {
    const def = CARD_DEFS[card.type];

    return def?.aim ? def.aim(card) : "";
}

// Base Energy cost, plus the Hex discount while it is running.
function getCardEnergyCost(type, count, { discounted = true } = {}) {
    const def = CARD_DEFS[type];

    let cost = def ? def.cost(count) : count;

    if (
        discounted &&
        HEX_AFFECTED_CARDS.includes(type) &&
        (currentEncounter?.active && currentEncounter?.hex?.remaining > 0)
    ) {
        cost = Math.max(HEX_MIN_COST, cost - HEX_DISCOUNT);
    }

    return cost;
}

function isCardTypeValidForAssignment(type) {
    if (!activeAssignment) return true;

    const rule = getCardRule(type);

    if (!rule) return true;

    return activeAssignment.targetCount >= rule.min &&
        activeAssignment.targetCount <= rule.max;
}

// The line under the card creator for cards that don't use the 3x3 pattern.
function getCardCreatorSummary(type, count) {
    const def = CARD_DEFS[type];
    const cost = getCardEnergyCost(type, count, { discounted: false });
    const rule = getCardRule(type);

    if (rule && !isCardTypeValidForAssignment(type)) {
        return `${getCardOptionName(type)} requires ${rule.min}-${rule.max} positions. ` +
            `This assignment has ${count}. Choose another card type.`;
    }

    return def?.summary
        ? def.summary(count, cost)
        : `Assigned: ${count} positions. Energy cost: ${cost}.`;
}

function describeCardEffect(card) {
    const def = CARD_DEFS[card.type];
    const n = card.targetCount;
    const cost = getCardEnergyCost(card.type, n);

    return def?.effect
        ? def.effect(n, cost)
        : `${n} Target Positions · costs ${cost}`;
}

// "Lifesteal 2 · Rest 3" style pieces for a player's heading / status line.
function describePlayerCardEffects(player) {
    const parts = [];
    const charges = player.charges || {};

    if (charges.lifesteal > 0) parts.push(`Lifesteal ${charges.lifesteal}`);
    if (charges.status > 0) parts.push(`Status ${charges.status}`);
    if (charges.penetrate > 0) parts.push(`Penetrate ${charges.penetrate}`);
    if (charges.spellvamp > 0) parts.push(`Spellvamp ${charges.spellvamp}`);
    if (player.rest > 0) parts.push(`Rest ${player.rest}`);
    if (player.shielded) parts.push("Shielded");
    if (player.shieldBreak > 0) parts.push(`Shield Break ${player.shieldBreak}`);
    if (player.counterTurns > 0) parts.push(`Counter ${player.counterTurns}`);

    return parts;
}


/* =====================================
   PLAYING A CARD: ELIGIBILITY AND AIMING
===================================== */

// Would the server accept this placement? (Mirrors its checks.)
function isPlacementValid(card, mode, positions, data) {
    const def = CARD_DEFS[card.type];

    return def?.valid ? def.valid(card, positions, data) : true;
}

// Playing a card can't be cancelled, so refuse cards that could leave the
// player with nowhere to put them.
function hasPlayableTarget(card) {
    const def = CARD_DEFS[card.type];

    if (!def) return true;
    if (def.hasTarget) return def.hasTarget(card);

    switch (def.mode) {
        case "monster":
            return getSelectableMonsters(card).some(monster =>
                hasValidPlacement(card, "monster", getMonsterGridData(monster))
            );
        case "monsterpick":
            return getSelectableMonsters(card).length > 0;
        case "self":
            return hasValidPlacement(card, "self", getOwnGridData());
        default:
            return true;
    }
}

// Players Shield could be cast on, with the reason when it can't be.
function getShieldCandidates() {
    const shieldActive = Boolean(currentEncounter?.shield);

    return roomPlayers
        .filter(player => !isDeadPlayer(player))
        .map(player => ({
            player,
            allowed: !shieldActive && !(player.shieldBreak > 0),
            reason: shieldActive
                ? "A Shield is already active"
                : player.shieldBreak > 0
                    ? `Shield Break ${player.shieldBreak}`
                    : ""
        }));
}

// Cards with no aiming: dropping the card is the whole action.
function playUnaimedCard(card) {
    const def = CARD_DEFS[card.type];

    combatAttackPending = true;
    socket.emit(def.event, { cardID: card.id });
    combatCardMessage.textContent = `Activating ${card.name}...`;
    renderCombatCards();
}

// One click on the monster's grid or your own grid, for pattern cards.
function confirmCardPlacement(anchor) {
    const card = selectedCombatCard;

    if (!card || !currentEncounter?.active || combatAttackPending) return;

    const def = CARD_DEFS[card.type];

    if (!def || (def.mode !== "monster" && def.mode !== "self")) return;

    // Aiming at a Monster (one, or two for Blast) is handled in monster.js.
    if (def.mode === "monster") {
        confirmMonsterPlacement(card, def, anchor);
        return;
    }

    const data = getOwnGridData();
    const positions = getCardTargetPositions(card, anchor, data.size);

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside your grid.";

        return;
    }

    if (!isPlacementValid(card, def.mode, positions, data)) {
        combatCardMessage.textContent =
            def.invalidMessage || "That placement isn't valid.";

        return;
    }

    combatAttackPending = true;
    socket.emit(def.event, { cardID: card.id, anchor });

    combatCardMessage.textContent = def.pending
        ? def.pending(card)
        : `Playing ${card.name}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

function confirmPlayerHeal(anchor, targetPlayer) {
    const card = selectedCombatCard;

    if (
        !card ||
        card.type !== "heal" ||
        !currentEncounter?.active ||
        combatAttackPending ||
        !targetPlayer
    ) {
        return;
    }

    const positions = getCardTargetPositions(card, anchor, targetPlayer.gridSize);

    if (!positions) {
        combatCardMessage.textContent =
            "Invalid placement. The pattern must fit inside the target's grid.";

        return;
    }

    combatAttackPending = true;

    socket.emit("player-heal", {
        cardID: card.id,
        targetPlayerID: targetPlayer.id,
        anchor
    });

    combatCardMessage.textContent = `Healing ${targetPlayer.username}...`;

    clearCombatTargetPreview();
    renderCombatCards();
}

// Buff and Shield: pick a player, nothing to aim.
function confirmCardPlayerPick(player) {
    const card = selectedCombatCard;

    if (!card || combatAttackPending) return;

    const def = CARD_DEFS[card.type];

    selectedHealTargetID = player.id;
    combatAttackPending = true;

    socket.emit(def.event, {
        cardID: card.id,
        targetPlayerID: player.id
    });

    setOverlayMessage(
        card.type === "shield"
            ? `Shielding ${player.username}...`
            : `Giving Energy to ${player.username}...`
    );

    refreshPlayOverlay();
}

/*
    The player chips shown for Heal / Buff / Shield in the aiming screen.
    (createPlayerChip and the overlay live in script.js.)
*/
function renderCardPicker(picker, card, mode) {
    // Which Monster (monster.js).
    if (mode === "monster" || mode === "monsterpick") {
        renderMonsterPicker(picker, card, mode);
        return;
    }

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

    if (mode === "shield") {
        getShieldCandidates().forEach(({ player, allowed, reason }) => {
            const chip = createPlayerChip(player, { showEnergy: false, note: reason });

            chip.disabled = chip.disabled || !allowed;

            chip.addEventListener("click", () => {
                if (!allowed) return;

                confirmCardPlayerPick(player);
            });

            picker.appendChild(chip);
        });

        return;
    }

    // Buff: pick a teammate; each option shows how much Energy that class has.
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

        chip.addEventListener("click", () => confirmCardPlayerPick(player));

        picker.appendChild(chip);
    });
}

// A click on a cell of the aiming grid.
function onCardCellClick(card, mode, index) {
    if (mode === "heal") {
        confirmPlayerHeal(
            index,
            roomPlayers.find(player => player.id === selectedHealTargetID)
        );

        return;
    }

    confirmCardPlacement(index);
}


/* =====================================
   CARD EVENTS  (results from the server)
===================================== */

function registerCardEvents(socket) {

    // One listener per card: each player and the Host get their own wording.
    Object.values(CARD_DEFS).forEach(def => {
        if (!def.resolvedEvent) return;

        socket.on(def.resolvedEvent, result => {
            const text = def.messages(result);

            if (result.playerID === currentPlayerID) {
                finishOwnAction(text.own);
            } else if (currentRole === "player") {
                combatCardMessage.textContent = text.other;
            } else if (currentRole === "host" && text.host) {
                monsterEncounterMessage.textContent = text.host;
            }

            clearCombatTargetPreview();
            renderCombatMonsterGrid();
            renderPlayerGrid();
            renderPlayerPartyGrids();
        });
    });

    // Retaliate striking back after the monster hit a marked cell.
    socket.on("retaliate-triggered", result => {
        if (currentRole === "player") {
            combatCardMessage.textContent =
                result.converted
                    ? `${result.username}'s Retaliate triggered, but ${result.monsterName}'s ` +
                        "Adaptive Armor turned it into healing."
                    : `${result.username}'s Retaliate triggered ${result.triggered} time(s), ` +
                        `dealing ${result.damage} damage to ${result.monsterName}.`;
        }

        renderCombatMonsterGrid();
    });

    // A Rest turn went by (the resting player is skipped).
    socket.on("player-rest-tick", result => {
        const text = result.expired
            ? `${result.username} wakes up from Rest.`
            : `${result.username} rests: +Energy and a heal. ${result.turnsLeft} Rest turn(s) left.`;

        if (currentRole === "player") {
            combatCardMessage.textContent = text;
        } else if (currentRole === "host") {
            monsterEncounterMessage.textContent = text;
        }
    });

    socket.on("shield-expired", result => {
        const text =
            `The Shield on ${result.targetUsername} has expired. ` +
            `Shield Break for ${result.breakTurns} round(s).`;

        if (currentRole === "player") {
            combatCardMessage.textContent = text;
        } else if (currentRole === "host") {
            monsterEncounterMessage.textContent = text;
        }
    });

    socket.on("hex-expired", () => {
        const text = "Hex has worn off. Attack, Heal, Blast, Spellvamp and Curse cost full Energy again.";

        if (currentRole === "player") {
            combatCardMessage.textContent = text;
        } else if (currentRole === "host") {
            monsterEncounterMessage.textContent = text;
        }
    });
}


/* =====================================
   CARD ANIMATIONS  (grid effects)
===================================== */

/*
    The Action Stage (stage.js) draws a full-screen copy of a grid and
    registers an effect on each cell that changes. The basic ones (pop, fade,
    curse, rage ...) live in script.js; the ones that belong to a single card
    are here, so a new card can bring its own animation.

    An effect is { kind, index, look, duration, delay, ...extras }. When the
    cell is drawn, applyFxToCell (script.js) finds its kind in CARD_FX and
    hands over an empty "ghost" laid on top of the cell. A builder fills the
    ghost and starts its animations; `delay` can be negative (the grid was
    rebuilt part way through, so the effect carries on instead of restarting).

        slash      Execute: the cell is cut diagonally and the halves fall apart
        blast      Blast: explosion colours, then grey smoke that grows and fades
        vamp       Spellvamp (monster): cell turns purple, then its new colour
        vampheal   Spellvamp (own grid): purple turns into the healed colour
        crack      Penetrate: X-shaped cracks, then 4 pieces split away
        lswave     Lifesteal: a red wave sweeps the grid row by row, then green
        lsheal     Lifesteal: the healed cell swells deep red, then slams to green
        restgrow   Rest: a small green square grows in an empty cell, then pops
*/

const CELL_COLORS = {
    empty: "#242424",
    armor: "#808080",
    purple: "#9b63d2",
    red: "rgba(214, 40, 40, 0.92)",
    deepRed: "#8b0000"
};

// "hp" | "overheal" | "armor" | "armor-overheal" (anything else counts as hp)
function cellLook(cellState) {
    return ["hp", "overheal", "armor", "armor-overheal"].includes(cellState)
        ? cellState
        : "hp";
}

function cssColor(name, fallback) {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();

    return value || fallback;
}

function colorOfCell(state) {
    switch (state) {
        case "hp": return cssColor("--green", "#4fb99f");
        case "overheal": return cssColor("--blue", "#3986d6");
        case "empty": return CELL_COLORS.empty;
        default: return CELL_COLORS.armor;
    }
}

function fxSpan(className, styles = {}) {
    const node = document.createElement("span");

    node.className = className;
    Object.assign(node.style, styles);

    return node;
}

// Keeps the ghost hidden until its delay, then removes it when it is over.
function fxTimeline(ghost, total, delay) {
    ghost.style.visibility = "hidden";

    const timeline = ghost.animate(
        [{ visibility: "visible" }, { visibility: "visible" }],
        { duration: total, delay, fill: "forwards" }
    );

    timeline.onfinish = () => ghost.remove();
}

const CARD_FX = {

    // EXECUTE: a diagonal slash, then the two halves slide apart and fade.
    slash(effect, ghost, delay) {
        const total = effect.duration;

        const halves = [
            { clip: "polygon(0 0, 100% 0, 0 100%)", move: "translate(-24%, -24%) rotate(-12deg)" },
            { clip: "polygon(100% 0, 100% 100%, 0 100%)", move: "translate(24%, 24%) rotate(12deg)" }
        ];

        halves.forEach(half => {
            const body = fxSpan(`fx-body fx-look-${cellLook(effect.look)}`, {
                clipPath: half.clip
            });

            ghost.appendChild(body);

            body.animate(
                [
                    { transform: "none", opacity: 1, offset: 0 },
                    { transform: "none", opacity: 1, offset: 0.24 },
                    { transform: half.move, opacity: 0, offset: 1 }
                ],
                { duration: total, delay, easing: "ease-in", fill: "both" }
            );
        });

        const line = fxSpan("fx-slash-line");

        ghost.appendChild(line);

        line.animate(
            [
                { transform: "translate(-50%, -50%) rotate(-45deg) scaleX(0)", opacity: 1, offset: 0 },
                { transform: "translate(-50%, -50%) rotate(-45deg) scaleX(1)", opacity: 1, offset: 0.1 },
                { transform: "translate(-50%, -50%) rotate(-45deg) scaleX(1)", opacity: 0, offset: 0.4 },
                { transform: "translate(-50%, -50%) rotate(-45deg) scaleX(1)", opacity: 0, offset: 1 }
            ],
            { duration: total, delay, fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // BLAST: flash, fire, then grey smoke that swells and fades.
    blast(effect, ghost, delay) {
        const total = effect.duration;
        const body = fxSpan("fx-body");

        ghost.appendChild(body);

        body.animate(
            [
                { backgroundColor: colorOfCell(cellLook(effect.look)), transform: "scale(1)", opacity: 1, borderRadius: "6px", boxShadow: "0 0 0 0 rgba(255, 190, 70, 0)", offset: 0 },
                { backgroundColor: "#fff6c2", transform: "scale(1.12)", opacity: 1, borderRadius: "6px", boxShadow: "0 0 20px 8px rgba(255, 200, 80, 0.95)", offset: 0.1 },
                { backgroundColor: "#ffb21f", transform: "scale(1.32)", opacity: 1, borderRadius: "20%", boxShadow: "0 0 22px 8px rgba(255, 140, 30, 0.85)", offset: 0.26 },
                { backgroundColor: "#ff5a1f", transform: "scale(1.55)", opacity: 1, borderRadius: "30%", boxShadow: "0 0 20px 6px rgba(255, 70, 20, 0.7)", offset: 0.42 },
                { backgroundColor: "#8c8c8c", transform: "scale(1.85)", opacity: 0.9, borderRadius: "42%", boxShadow: "0 0 14px 2px rgba(120, 120, 120, 0.4)", offset: 0.68 },
                { backgroundColor: "#5e5e5e", transform: "scale(2.3)", opacity: 0, borderRadius: "50%", boxShadow: "0 0 0 0 rgba(90, 90, 90, 0)", offset: 1 }
            ],
            { duration: total, delay, easing: "ease-out", fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // SPELLVAMP on the monster: old colour -> purple -> what the cell became.
    vamp(effect, ghost, delay) {
        const total = effect.duration;
        const body = fxSpan("fx-body");

        ghost.appendChild(body);

        body.animate(
            [
                { backgroundColor: colorOfCell(cellLook(effect.look)), transform: "scale(1)", boxShadow: "0 0 0 0 rgba(155, 99, 210, 0)", offset: 0 },
                { backgroundColor: CELL_COLORS.purple, transform: "scale(1.1)", boxShadow: "0 0 16px 5px rgba(155, 99, 210, 0.8)", offset: 0.42 },
                { backgroundColor: colorOfCell(effect.to), transform: "scale(1)", boxShadow: "0 0 0 0 rgba(155, 99, 210, 0)", offset: 1 }
            ],
            { duration: total, delay, easing: "ease-in-out", fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // SPELLVAMP healing the Mage: purple turns into solid green (a healed
    // empty cell) or solid Overheal blue (a healthy cell that was Overhealed).
    vampheal(effect, ghost, delay) {
        const total = effect.duration;

        // What the cell looked like before it was healed.
        ghost.appendChild(fxSpan("fx-body", {
            background: effect.look === "overheal" ? colorOfCell("hp") : CELL_COLORS.empty,
            border: "1px solid " + (effect.look === "overheal" ? colorOfCell("hp") : "#333")
        }));

        const body = fxSpan("fx-body");

        ghost.appendChild(body);

        body.animate(
            [
                { backgroundColor: CELL_COLORS.purple, transform: "scale(0.4)", opacity: 0.5, offset: 0 },
                { backgroundColor: CELL_COLORS.purple, transform: "scale(1.12)", opacity: 1, offset: 0.2 },
                { backgroundColor: CELL_COLORS.purple, transform: "scale(1)", opacity: 1, offset: 0.4 },
                { backgroundColor: colorOfCell(effect.look), transform: "scale(1)", opacity: 1, offset: 1 }
            ],
            { duration: total, delay, easing: "ease-in-out", fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // PENETRATE: four cracks flash in, hold, then the armor splits in 4 and fades.
    crack(effect, ghost, delay) {
        const total = effect.duration;
        const look = `fx-look-${cellLook(effect.look)}`;

        const pieces = [
            { clip: "polygon(0 0, 100% 0, 50% 50%)", move: "translate(0, -48%) rotate(-10deg)" },
            { clip: "polygon(100% 0, 100% 100%, 50% 50%)", move: "translate(48%, 0) rotate(10deg)" },
            { clip: "polygon(100% 100%, 0 100%, 50% 50%)", move: "translate(0, 48%) rotate(-10deg)" },
            { clip: "polygon(0 100%, 0 0, 50% 50%)", move: "translate(-48%, 0) rotate(10deg)" }
        ];

        pieces.forEach(piece => {
            const body = fxSpan(`fx-body ${look}`, { clipPath: piece.clip });

            ghost.appendChild(body);

            body.animate(
                [
                    { transform: "none", opacity: 1, offset: 0 },
                    { transform: "none", opacity: 1, offset: 0.58 },
                    { transform: piece.move, opacity: 0, offset: 1 }
                ],
                { duration: total, delay, easing: "ease-in", fill: "both" }
            );
        });

        // The cracks run from the centre to the four corners.
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");

        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;overflow:visible;";

        [[0, 0], [100, 0], [100, 100], [0, 100]].forEach(([x, y], i) => {
            const line = document.createElementNS(svgNS, "line");

            line.setAttribute("x1", "50");
            line.setAttribute("y1", "50");
            line.setAttribute("x2", String(x));
            line.setAttribute("y2", String(y));
            line.setAttribute("stroke", "#161616");
            line.setAttribute("stroke-width", "4");
            line.setAttribute("stroke-linecap", "round");
            line.setAttribute("pathLength", "1");
            line.style.strokeDasharray = "1";
            svg.appendChild(line);

            const appear = 0.05 + i * 0.025;

            line.animate(
                [
                    { strokeDashoffset: 1, opacity: 1, offset: 0 },
                    { strokeDashoffset: 1, opacity: 1, offset: appear },
                    { strokeDashoffset: 0, opacity: 1, offset: appear + 0.07 },
                    { strokeDashoffset: 0, opacity: 1, offset: 0.58 },
                    { strokeDashoffset: 0, opacity: 0, offset: 1 }
                ],
                { duration: total, delay, fill: "both" }
            );
        });

        ghost.appendChild(svg);

        fxTimeline(ghost, total, delay);
    },

    // LIFESTEAL, every cell: a red wave down the grid, then back to green.
    lswave(effect, ghost, delay) {
        const { row, rows, step } = effect;
        const total = effect.duration;

        const red = fxSpan("fx-body", { background: CELL_COLORS.red });

        ghost.appendChild(red);

        red.animate(
            [
                { opacity: 0, offset: 0 },
                { opacity: 0, offset: (row * step) / total },
                { opacity: 1, offset: ((row + 1) * step) / total },
                { opacity: 1, offset: ((rows + row) * step) / total },
                { opacity: 0, offset: 1 }
            ],
            { duration: total, delay, fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // LIFESTEAL, the healed cell: stays empty until the wave reaches it,
    // swells into deep red, then slams down into green once its row is green.
    lsheal(effect, ghost, delay) {
        const { row, rows, step } = effect;
        const total = effect.duration;

        const hit = (row + 1) * step;
        const back = (rows + row + 1) * step;     // the row has gone green again
        const swell = hit + 180;

        ghost.appendChild(fxSpan("fx-body", {
            background: CELL_COLORS.empty,
            border: "1px solid #333"
        }));

        const red = fxSpan("fx-body", { background: CELL_COLORS.deepRed });

        ghost.appendChild(red);

        red.animate(
            [
                { opacity: 0, backgroundColor: CELL_COLORS.deepRed, offset: 0 },
                { opacity: 0, backgroundColor: CELL_COLORS.deepRed, offset: (row * step) / total },
                { opacity: 1, backgroundColor: CELL_COLORS.deepRed, offset: hit / total },
                { opacity: 1, backgroundColor: CELL_COLORS.deepRed, offset: back / total },
                { opacity: 1, backgroundColor: colorOfCell("hp"), offset: 1 }
            ],
            { duration: total, delay, fill: "both" }
        );

        ghost.animate(
            [
                { transform: "scale(1)", offset: 0 },
                { transform: "scale(1)", offset: (row * step) / total },
                { transform: "scale(1.32)", offset: swell / total },
                { transform: "scale(1.32)", offset: back / total },
                { transform: "scale(1)", offset: 1 }
            ],
            { duration: total, delay, easing: "ease-in", fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    },

    // REST: a small green square grows slowly in the middle, then pops to fill the cell.
    restgrow(effect, ghost, delay) {
        const total = effect.duration;

        // What the cell looked like before: empty when it is being healed,
        // plain HP when it is being Overhealed.
        const overheal = effect.look === "overheal";

        ghost.appendChild(fxSpan("fx-body", {
            background: overheal ? colorOfCell("hp") : CELL_COLORS.empty,
            border: "1px solid " + (overheal ? colorOfCell("hp") : "#333")
        }));

        const square = fxSpan("fx-body", {
            background: colorOfCell(effect.look === "overheal" ? "overheal" : "hp")
        });

        ghost.appendChild(square);

        square.animate(
            [
                { transform: "scale(0.14)", opacity: 0.95, offset: 0 },
                { transform: "scale(0.58)", opacity: 1, offset: 0.86 },
                { transform: "scale(1.16)", opacity: 1, easing: "ease-out", offset: 0.94 },
                { transform: "scale(1)", opacity: 1, offset: 1 }
            ],
            { duration: total, delay, fill: "both" }
        );

        fxTimeline(ghost, total, delay);
    }
};

/*
    How one monster cell that was hit should be drawn, by the card that hit
    it. Returns null for the ordinary pop. `state` carries the number of
    Armor cells the Thief pierced with Penetrate (they crack instead of pop).
*/
function getMonsterHitFx(source, cell, state = {}) {
    const before = cell.before || "hp";
    const after = cell.after || "empty";

    switch (source) {
        case "execute":
            return { kind: "slash", look: cellLook(before), duration: 950 };

        case "blast":
            return { kind: "blast", look: cellLook(before), duration: 1000 };

        case "spellvamp":
            return { kind: "vamp", look: cellLook(before), to: after, duration: 1100 };

        case "penetrate":
            return isArmorCellType(before)
                ? { kind: "crack", look: before, duration: 1400 }
                : null;

        case "attack":
            if (isArmorCellType(before) && (state.cracksLeft || 0) > 0) {
                state.cracksLeft--;
                return { kind: "crack", look: before, duration: 1400 };
            }

            return null;

        default:
            return null;
    }
}


/* =====================================
   HEX: THE DISCOUNT ON A CARD'S COST
===================================== */

// While this is in the future, freshly drawn costs count down visibly.
let hexCostAnimationUntil = 0;

function formatCostNumber(value) {
    return String(Number(value.toFixed(1)));
}

/*
    The Energy cost shown on a card. While Hex discounts it, the Hex icon sits
    next to the cost; the moment Hex is cast the number shakes and slowly
    counts down by the discount.
*/
function createCardCostLabel(card) {
    const base = getCardEnergyCost(card.type, card.targetCount, { discounted: false });
    const current = getCardEnergyCost(card.type, card.targetCount);

    if (current === base) return createEnergyLabel(base);

    const label = document.createElement("span");
    const number = document.createElement("span");
    const badge = document.createElement("img");

    label.className = "energy-label hex-cost";
    number.className = "hex-cost-number";
    badge.className = "hex-badge";
    badge.src = "/assets/hex.png";
    badge.alt = "Hex discount";
    badge.draggable = false;

    label.append(
        createEnergyIcon(),
        document.createTextNode(": "),
        number,
        badge
    );

    const animate =
        performance.now() < hexCostAnimationUntil &&
        !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (!animate) {
        number.textContent = formatCostNumber(current);
        return label;
    }

    number.textContent = formatCostNumber(base);
    number.classList.add("is-shaking");

    const startedAt = performance.now();
    const duration = 1700;

    const tick = now => {
        const progress = Math.min(1, (now - startedAt) / duration);
        const value = base - (base - current) * progress;

        number.textContent = formatCostNumber(progress >= 1 ? current : value);

        if (progress < 1 && number.isConnected !== false) {
            requestAnimationFrame(tick);
        } else {
            number.classList.remove("is-shaking");
        }
    };

    requestAnimationFrame(tick);

    return label;
}


/* =====================================
   EXTRA STYLES FOR CARD TYPES
===================================== */

(function injectCardStyles() {
    const style = document.createElement("style");

    // A selected card gets the border colour of its own type.
    const selected = Object.entries(CARD_DEFS).map(([type, def]) => `
        .combat-card-button.${type}-card.selected {
            border-color: ${def.color};
            box-shadow: inset 0 0 0 1px ${def.color};
        }
    `).join("");

    style.textContent = `
        ${selected}

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
    `;

    document.head.appendChild(style);
})();
