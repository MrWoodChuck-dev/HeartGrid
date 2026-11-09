/* =====================================
   CARD GUIDES  (what a card does, shown before you make it)
===================================== */

/*
    When a player picks a card that is NOT aimed on a grid, the Preparation
    tab shows a full-screen guide instead of the pattern grid. This file is
    ALL the text and examples for those guides, so they can be edited here
    without touching any code. The screen that draws them is player-ui.js.

    A guide is:
        summary   one plain sentence
        frames    a story told frame by frame, left to right
        can       what the card CAN affect
        cannot    what it CANNOT affect

    A frame is { title, caption, visual }. A visual is one of:
        { kind: "card",  type, note }              a card icon with a note
        { kind: "grids", grids: [ { label, cells, hit } ] }
                                                    small example grids
                                                    (hit = positions just hit)
        { kind: "text",  lines: [ ... ] }           big text lines
        { kind: "hex-costs" }                       the Hex price table
                                                    (built from the real costs)

    Grid cells use the real cell names: hp, overheal, armor, empty.
    The example grids are 3x3, positions numbered left to right, top to bottom.

    THESE ARE EXAMPLES ONLY. The real numbers live in the card rules:
        cost of every card ........ CARD_DEFS[type].cost in cards-server.js
                                    AND in public/cards.js (keep both the same)
        Hex discount and cards ..... HEX_DISCOUNT / HEX_MIN_COST /
                                    HEX_AFFECTED_CARDS at the top of both files
        Energy regeneration ........ ENERGY_REGEN in server.js
*/

const CARD_GUIDES = {

    status: {
        summary: "Status adds extra damage to your Attack.",
        frames: [
            {
                title: "Status Card used",
                caption: "You pay Energy and gain one Status Charge per position. Here: 3 charges.",
                visual: { kind: "card", type: "status", note: "3 Status Charges" }
            },
            {
                title: "Attack Card used on the monster",
                caption: "Your Attack hits 2 cells. Both are emptied.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["empty", "empty", "hp", "hp", "overheal", "armor", "hp", "hp", "hp"],
                        hit: [0, 1]
                    }]
                }
            },
            {
                title: "Status Card activates",
                caption: "Each successful hit spends one charge to deal 1-2 extra damage to a random cell. Here 2 charges are spent (1 left).",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "EXTRA DAMAGE",
                        cells: ["empty", "empty", "hp", "hp", "hp", "armor", "empty", "hp", "hp"],
                        hit: [4, 6]
                    }]
                }
            },
            {
                title: "Aftermath: the monster's HP",
                caption: "The Overheal was used up, one HP cell was emptied, and the Armor was not touched.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["empty", "empty", "hp", "hp", "hp", "armor", "empty", "hp", "hp"],
                        hit: []
                    }]
                }
            }
        ],
        can: ["Overheal cells", "Normal HP cells"],
        cannot: ["Armor cells"]
    },

    execute: {
        summary: "Execute removes random healthy cells. You do not aim it.",
        frames: [
            {
                title: "Execute Card used",
                caption: "You choose the Monster. You pay Energy. Here: 2 positions.",
                visual: { kind: "card", type: "execute", note: "2 positions" }
            },
            {
                title: "It picks healthy cells at random",
                caption: "Only normal HP cells can be picked.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["hp", "hp", "hp", "hp", "overheal", "armor", "hp", "hp", "hp"],
                        hit: [2, 7]
                    }]
                }
            },
            {
                title: "Aftermath: the monster's HP",
                caption: "Two normal HP cells are now empty. Overheal and Armor stayed.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["hp", "hp", "empty", "hp", "overheal", "armor", "hp", "empty", "hp"],
                        hit: []
                    }]
                }
            }
        ],
        can: ["Normal HP cells"],
        cannot: ["Armor cells", "Overheal cells"]
    },

    lifesteal: {
        summary: "Lifesteal heals you when your Attack hits.",
        frames: [
            {
                title: "Lifesteal Card used",
                caption: "You gain one Lifesteal Charge per position. Here: 3 charges.",
                visual: { kind: "card", type: "lifesteal", note: "3 Lifesteal Charges" }
            },
            {
                title: "Attack Card used on the monster",
                caption: "Your Attack hits 2 normal cells.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["empty", "empty", "hp", "hp", "hp", "hp", "hp", "hp", "hp"],
                        hit: [0, 1]
                    }]
                }
            },
            {
                title: "Lifesteal activates",
                caption: "Each successful hit spends one charge to restore one of YOUR empty cells.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "YOU, BEFORE",
                        cells: ["hp", "empty", "hp", "empty", "hp", "hp", "hp", "hp", "hp"],
                        hit: []
                    }, {
                        label: "YOU, AFTER",
                        cells: ["hp", "hp", "hp", "hp", "hp", "hp", "hp", "hp", "hp"],
                        hit: [1, 3]
                    }]
                }
            },
            {
                title: "Aftermath",
                caption: "The monster lost 2 cells, you healed 2, and 1 charge is left.",
                visual: { kind: "text", lines: ["Monster: -2 HP", "You: +2 HP", "1 charge left"] }
            }
        ],
        can: ["Your own empty cells"],
        cannot: [
            "Overheal (it only refills empty cells)",
            "Armor hits do not trigger it, unless Penetrate pierces the Armor"
        ]
    },

    penetrate: {
        summary: "Penetrate lets your Attack get through Armor.",
        frames: [
            {
                title: "Penetrate Card used",
                caption: "You gain one Penetrate Charge per position. Here: 2 charges.",
                visual: { kind: "card", type: "penetrate", note: "2 Penetrate Charges" }
            },
            {
                title: "Attack Card hits Armor directly",
                caption: "A charge pierces the Armor you hit: no extra Energy cost, and Lifesteal still works.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["empty", "empty", "hp", "armor", "hp", "hp", "hp", "hp", "hp"],
                        hit: [0, 1]
                    }]
                }
            },
            {
                title: "Penetrate strips connected Armor",
                caption: "A charge also removes Armor right next to a cell you hit (up, down, left, right). This deals no damage.",
                visual: {
                    kind: "grids",
                    grids: [{
                        label: "MONSTER",
                        cells: ["empty", "empty", "hp", "hp", "hp", "hp", "hp", "hp", "hp"],
                        hit: [3]
                    }]
                }
            },
            {
                title: "Aftermath",
                caption: "Armor is gone and you paid no Armor penalty.",
                visual: { kind: "text", lines: ["No Armor penalty", "Connected Armor: no damage"] }
            }
        ],
        can: ["Armor you hit directly", "Armor touching a cell you hit"],
        cannot: ["Armor further away", "Connected Armor takes no damage, it is only removed"]
    },

    counter: {
        summary: "Counter gives you an extra Attack right after a Monster's turn.",
        frames: [
            {
                title: "Counter Card used",
                caption: "You pick ONE Monster. You gain one Counter Turn per position. Here: 2.",
                visual: { kind: "card", type: "counter", note: "2 Counter Turns" }
            },
            {
                title: "That Monster finishes its turn",
                caption: "It makes no difference if it attacked or not. Its Taunt is ignored.",
                visual: { kind: "text", lines: ["Monster's turn ends"] }
            },
            {
                title: "You get a bonus turn",
                caption: "Your Attack can only hit the Monster you countered. No Energy regeneration on this turn.",
                visual: { kind: "text", lines: ["Bonus Attack", "Only that Monster"] }
            },
            {
                title: "Repeat",
                caption: "One Counter Turn is used each time that Monster finishes a turn.",
                visual: { kind: "text", lines: ["2 -> 1 -> 0"] }
            }
        ],
        can: ["One chosen Monster"],
        cannot: ["Any other Monster during the bonus turn"]
    },

    weaken: {
        summary: "Weaken makes the monster's next attack weaker.",
        frames: [
            {
                title: "Weaken Card used",
                caption: "You gain Weaken charges, one per position. They stack. Here: 3.",
                visual: { kind: "card", type: "weaken", note: "3 Weaken charges" }
            },
            {
                title: "The monster rolls its attack",
                caption: "Say it rolls 5 positions.",
                visual: { kind: "text", lines: ["Roll: 5"] }
            },
            {
                title: "Weaken absorbs",
                caption: "Each charge removes one position. The monster only gets 2 positions.",
                visual: { kind: "text", lines: ["5 - 3 = 2 positions"] }
            },
            {
                title: "Big enough Weaken",
                caption: "If it absorbs the whole roll, the monster's attack is skipped.",
                visual: { kind: "text", lines: ["Roll 2, Weaken 3", "Attack skipped"] }
            }
        ],
        can: ["The monster's next attack"],
        cannot: ["Anything that is not a monster attack roll"]
    },

    shield: {
        summary: "Shield makes one player untargetable by the monsters.",
        frames: [
            {
                title: "Shield Card used",
                caption: "Pick one player (you can pick yourself). Here: 2 positions.",
                visual: { kind: "card", type: "shield", note: "Shield for 2 rounds" }
            },
            {
                title: "The Shield is up",
                caption: "Counting from the NEXT round, monsters cannot target that player for as many rounds as positions.",
                visual: { kind: "text", lines: ["Untargetable", "2 rounds"] }
            },
            {
                title: "Shield Break",
                caption: "Afterwards that player cannot be Shielded again for 4 rounds (5 if the Shield lasted 3).",
                visual: { kind: "text", lines: ["Shield Break", "4 rounds"] }
            }
        ],
        can: ["One player at a time"],
        cannot: ["A player with Shield Break", "More than one Shield at once"]
    },

    taunt: {
        summary: "Taunt forces the monsters to target you.",
        frames: [
            {
                title: "Taunt Card used",
                caption: "You gain Taunt charges, one per position. They stack. Here: 3.",
                visual: { kind: "card", type: "taunt", note: "3 Taunt charges" }
            },
            {
                title: "Monsters must attack you",
                caption: "While Taunt lasts you are their only legal target. Each hit on you uses up one charge.",
                visual: { kind: "text", lines: ["Only target: YOU"] }
            },
            {
                title: "It waits",
                caption: "While you are Resting or Shielded the charges wait and the monsters are free.",
                visual: { kind: "text", lines: ["Resting / Shielded", "Taunt waits"] }
            }
        ],
        can: ["Monster attacks"],
        cannot: ["Monster abilities that are not attacks (for example Debuff or Counter)"]
    },

    rest: {
        summary: "Rest trades your turns for Energy and healing.",
        frames: [
            {
                title: "Rest Card used",
                caption: "It costs no Energy. You rest for one of your turns per position. Here: 4.",
                visual: { kind: "card", type: "rest", note: "Rest for 4 turns" }
            },
            {
                title: "While you rest",
                caption: "You cannot do anything and Rest cannot be cancelled, even if the monster attacks you.",
                visual: { kind: "text", lines: ["No actions", "Cannot be cancelled"] }
            },
            {
                title: "What you gain each Rest turn",
                caption: "+3 Energy instead of the usual +1, and one of your cells is healed (empty cells first, then Overheal).",
                visual: { kind: "text", lines: ["+3 Energy", "+1 cell healed"] }
            }
        ],
        can: ["Your own empty cells, then Overheal"],
        cannot: ["Skipping or cancelling a Rest turn"]
    },

    buff: {
        summary: "Buff gives a teammate Energy.",
        frames: [
            {
                title: "Buff Card used",
                caption: "You pick a teammate. Here: 3 positions.",
                visual: { kind: "card", type: "buff", note: "3 positions" }
            },
            {
                title: "The Energy moves",
                caption: "You pay the same amount that they receive.",
                visual: { kind: "text", lines: ["You: -3 Energy", "Teammate: +3 Energy"] }
            }
        ],
        can: ["Any teammate"],
        cannot: ["Anyone but a teammate"]
    },

    hex: {
        summary: "Hex makes your whole team's cards cheaper.",
        frames: [
            {
                title: "Hex Card used",
                caption: "For one round per position (counting from the next round), the Hex discount applies to EVERY player. Re-casting only refreshes it.",
                visual: { kind: "card", type: "hex", note: "Cheaper cards for the team" }
            },
            {
                title: "What it changes",
                caption: "Example: every card below is made with 4 positions. Hex takes the discount off the cards it covers. It never goes below the minimum price.",
                visual: { kind: "hex-costs" }
            }
        ],
        can: ["Attack", "Heal", "Blast", "Spellvamp", "Curse"],
        cannot: ["Every other card keeps its normal price"]
    }
};
