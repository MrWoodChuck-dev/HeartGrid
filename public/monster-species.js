/* =====================================
   MONSTER SPECIES  (shared data)
===================================== */

/*
    The ONE place the three Species are described. The server (monster-server.js)
    requires this file for the rules, and the browser loads it with a <script>
    tag for the creator, the hover panels and the Host's dice tray.

    There is no general "monster" icon any more: every Species has its own
    portrait, public/assets/<id>.png (spirit.png, devil.png, scale.png).

    TO ADD A SPECIES
        1. Add it to SPECIES below (id = its icon file name).
        2. Write its passive / dice / ultimate behaviour in monster-server.js.
        3. Drop its icon in public/assets/<id>.png.
*/

(function (root, factory) {
    const data = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = data;
    } else {
        root.MonsterData = data;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const MAX_MONSTERS = 3;
    const GRID_SIZES = [3, 5, 7, 9, 12, 15];

    // What each kind of die does. A Species picks which ones it owns.
    const DIE_TYPES = {
        attack: {
            label: "Attack",
            text:
                "Roll for a number of positions. Spend them on any player's grid, " +
                "all on one player or spread out. Taunt, Shield and Weaken apply."
        },
        heal: {
            label: "Heal",
            text:
                "Roll for a number of positions. Restore empty cells on a Monster " +
                "(yourself or a teammate), or add Overheal to healthy cells."
        },
        armor: {
            label: "Armor",
            text:
                "Roll for a number of positions. Put Armor on healthy cells of a " +
                "Monster (yourself or a teammate)."
        },
        debuff: {
            label: "Debuff",
            text: "Pick a player. They lose Energy equal to the roll."
        },
        counter: {
            label: "Counter",
            text:
                "Pick a player. For as many of their turns as the roll, whenever " +
                "they end a turn this Monster gets a bonus action (restricted)."
        },
        taunt: {
            label: "Taunt",
            text:
                "Players must aim that many cards at this Monster before they " +
                "can target any other opponent."
        }
    };

    const SPECIES = {
        spirit: {
            id: "spirit",
            name: "Spirit",
            identity: "Regeneration and health manipulation.",
            color: "#3ec7a4",
            passive: {
                name: "Spirited Health",
                text:
                    "Whenever a card damages one of this Monster's cells, that cell " +
                    "has its own 50% check: heal a random empty cell of a random " +
                    "teammate, or Overheal one of their healthy cells if none is empty. " +
                    "No teammates, no effect."
            },
            dice: [
                { type: "heal", sides: 10 },
                { type: "attack", sides: 4 },
                { type: "armor", sides: 4 }
            ],
            ultimate: {
                id: "undying",
                name: "Undying",
                sides: 20,
                text:
                    "Roll a D20 and turn that many healthy cells into Undying, spread " +
                    "across the team or on Spirit itself. Undying is a third health " +
                    "layer: when hit it becomes Overheal. Spellvamp can't touch it."
            }
        },

        devil: {
            id: "devil",
            name: "Devil",
            identity: "Aggression, punishment and turn disruption.",
            color: "#d6453d",
            passive: {
                name: "Wrathful Position",
                text:
                    "Whenever a player damages one of Devil's cells there is a 25% " +
                    "chance to gain 1 Advantage. Advantage piles up and is added to " +
                    "Devil's next die roll, then resets."
            },
            dice: [
                { type: "attack", sides: 10 },
                { type: "debuff", sides: 6 },
                { type: "counter", sides: 2 }
            ],
            // Devil's D10 becomes a D6 and D2 / D6 are locked on a Counter bonus action.
            bonusAttackSides: 6,
            ultimate: {
                id: "raging-demon",
                name: "Raging Demon",
                sides: 20,
                text:
                    "Roll a D20 for how many of Devil's turns it lasts. Every damage " +
                    "event Devil causes has a 25% chance to heal one of its empty " +
                    "cells and a separate 25% chance to deal 1 extra damage."
            }
        },

        scale: {
            id: "scale",
            name: "Scale",
            identity: "Adaptive defense and resistance to player effects.",
            color: "#d6a93d",
            passive: {
                name: "Adaptive Armor",
                text:
                    "Whenever a Marking card or a non-grid effect (Execute, Status, " +
                    "Retaliate, Curse) hits Scale there is a 20% chance it becomes " +
                    "healing instead: an empty cell is restored, or a healthy cell " +
                    "gains Overheal."
            },
            dice: [
                { type: "armor", sides: 8 },
                { type: "attack", sides: 6 },
                { type: "taunt", sides: 2 }
            ],
            ultimate: {
                id: "taunt",
                name: "Taunt",
                sides: 20,
                text:
                    "Roll a D20: players must aim that many cards at Scale before " +
                    "they can target any other opponent."
            }
        }
    };

    // Everything a Monster's grid cell can be.
    const CELL_STATES = [
        "hp", "overheal", "undying",
        "armor", "armor-overheal", "armor-undying",
        "empty"
    ];

    return { MAX_MONSTERS, GRID_SIZES, DIE_TYPES, SPECIES, CELL_STATES };
});
