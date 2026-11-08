/* =====================================
   MONSTERS  (server side)
===================================== */

/*
    Everything that belongs to a Monster lives in this file:

        - the bench: up to three Monsters, each with its own Species, name,
          HP grid and combat state (room.encounter.monsters)
        - damage to a Monster's grid (Armor, Overheal, Undying, Curse chains)
        - the Species passives and ultimates
        - the Host's actions on a Monster's turn (roll a die, attack, heal,
          armor, debuff, counter, undying ...)
        - who may be targeted by a player's card (Taunt, Counter lock)

    server.js only keeps the core game (rooms, players, the turn engine). It
    hands this file the helpers it needs through init(), the same way it does
    for cards-server.js. The Species themselves (dice, passive text) are
    described once, in public/monster-species.js, which the browser also loads.

    Every Monster has an id. Every damage, heal, effect and result names the
    Monster that caused / received it, so nothing is ever shared between two
    Monsters (a Retaliate only hurts the Monster that attacked, for example).
*/

const crypto = require("crypto");

const {
    SPECIES,
    GRID_SIZES,
    MAX_MONSTERS
} = require("./public/monster-species");

const cards = require("./cards-server");

/* =====================================
   CONSTANTS
===================================== */

// Cells the Host may paint on a Monster before the encounter starts.
const MONSTER_SETUP_STATES = ["hp", "overheal", "armor", "armor-overheal"];

const SPIRIT_HEAL_CHANCE = 50;      // Spirited Health, per damaged cell
const DEVIL_ADVANTAGE_CHANCE = 25;  // Wrathful Position, per damaged cell
const RAGE_HEAL_CHANCE = 25;        // Raging Demon, per damage event
const RAGE_EXTRA_CHANCE = 25;       // Raging Demon, per damage event
const SCALE_ADAPT_CHANCE = 20;      // Adaptive Armor, per incoming effect

// How many times one Monster may roll its ultimate in a whole encounter.
const ULTIMATE_USES_PER_ENCOUNTER = 1;

const ULTIMATE_INDEX = 3;

let ctx = null;

function init(context) {
    ctx = context;
}


/* =====================================
   SMALL HELPERS
===================================== */

function createGrid(size) {
    return Array(size * size).fill("hp");
}

function pickRandom(list) {
    if (list.length === 0) return null;

    return list[ctx.randomInt(0, list.length)];
}

function chance(percent) {
    return ctx.randomInt(0, 100) < percent;
}

function rollDie(sides) {
    return ctx.randomInt(1, sides + 1);
}

function getSpecies(monster) {
    return SPECIES[monster.species];
}

// Cells a hit can change: plain HP, Overheal and Undying.
function isMonsterHittable(cell) {
    return cell === "hp" || cell === "overheal" || cell === "undying";
}

// "Healthy" cells that can take Armor or Undying: HP, Overheal, Undying.
function isArmorable(cell) {
    return cell === "hp" || cell === "overheal" || cell === "undying";
}

function describeCell(monster, index) {
    return { monsterID: monster.id, index };
}


/* =====================================
   THE BENCH
===================================== */

function createEncounterState() {
    return {
        active: false,
        monsters: []
    };
}

function getMonsters(room) {
    return room.encounter?.monsters || [];
}

function getMonster(room, id) {
    return getMonsters(room).find(monster => monster.id === id) || null;
}

function isMonsterDead(monster) {
    return Boolean(monster.dead);
}

function getAliveMonsters(room) {
    return getMonsters(room).filter(monster => !isMonsterDead(monster));
}

function createMonster(species, name, size) {
    return {
        id: `m-${crypto.randomBytes(4).toString("hex")}`,
        species,
        name,
        size,
        grid: createGrid(size),
        setupGrid: null,
        curses: new Set(),
        dead: false,

        // Species state
        taunt: 0,              // Scale: cards that must still target it
        advantage: 0,          // Devil: added to the next roll
        rage: 0,               // Devil: Raging Demon turns left
        ultimateUses: 0
    };
}

function resetMonsterCombatState(monster) {
    monster.dead = false;
    monster.curses = new Set();
    monster.taunt = 0;
    monster.advantage = 0;
    monster.rage = 0;
    monster.rageStart = 0;
    monster.ultimateUses = 0;
}

function getPublicMonster(monster) {
    return {
        id: monster.id,
        species: monster.species,
        name: monster.name,
        size: monster.size,
        grid: [...monster.grid],
        curses: [...monster.curses],
        dead: Boolean(monster.dead),
        taunt: monster.taunt || 0,
        advantage: monster.advantage || 0,
        rage: monster.rage || 0,
        ultimateUsed: monster.ultimateUses >= ULTIMATE_USES_PER_ENCOUNTER
    };
}

function getPublicMonsters(room) {
    return getMonsters(room).map(getPublicMonster);
}

// What the initiative needs: one entry per living Monster.
function getParticipants(room) {
    return getMonsters(room)
        .filter(monster => !isMonsterDead(monster))
        .map(monster => ({
            id: monster.id,
            type: "monster",
            username: monster.name,
            className: SPECIES[monster.species].name,
            species: monster.species,
            initiative: 0
        }));
}

// Called by server.js when the encounter starts / ends.
function beginEncounter(room) {
    getMonsters(room).forEach(monster => {
        monster.setupGrid = [...monster.grid];
        resetMonsterCombatState(monster);
    });

    room.monsterTurn = null;
    room.devilCounters = [];
    room.pendingBonuses = [];

    if (room.encounter) room.encounter.defeatedAnnounced = false;
}

function finishEncounter(room) {
    // Back to the setup the Host made, so they can edit it or run it again.
    getMonsters(room).forEach(monster => {
        if (monster.setupGrid) monster.grid = [...monster.setupGrid];

        monster.setupGrid = null;
        resetMonsterCombatState(monster);
    });

    room.monsterTurn = null;
    room.devilCounters = [];
    room.pendingBonuses = [];
}

// Wipes what the room remembers about Monster effects (per-encounter state).
function resetRoomEffects(room) {
    room.monsterTurn = null;
    room.devilCounters = [];
    room.pendingBonuses = [];
}


/* =====================================
   HEALING (shared by the passives)
===================================== */

// Restores one empty cell, or else Overheals one plain healthy cell.
function healMonsterCell(monster, { allowOverheal = true } = {}) {
    const empties = [];
    const healthy = [];

    monster.grid.forEach((cell, index) => {
        if (cell === "empty") empties.push(index);
        else if (cell === "hp") healthy.push(index);
    });

    const emptyPick = pickRandom(empties);

    if (emptyPick !== null) {
        monster.grid[emptyPick] = "hp";
        return { index: emptyPick, kind: "hp" };
    }

    if (!allowOverheal) return null;

    const healthyPick = pickRandom(healthy);

    if (healthyPick === null) return null;

    monster.grid[healthyPick] = "overheal";
    return { index: healthyPick, kind: "overheal" };
}

function emitAction(room, monster, kind, extra = {}) {
    ctx.io.to(room.roomID).emit("monster-action-resolved", {
        monsterID: monster.id,
        monsterName: monster.name,
        species: monster.species,
        kind,
        ...extra
    });
}


/* =====================================
   MONSTER DAMAGE (ARMOR + CURSE CHAINS)
===================================== */

/*
    Every source of damage to a Monster goes through here: attacks, Blast,
    Spellvamp (strip only), Execute, Status, Retaliate and Curse explosions.

    Hitting a cell:
        hp        -> empty
        overheal  -> hp        (the Overheal is used up)
        undying   -> overheal  (the Undying layer is used up)
        armor     -> empty / overheal / undying   (only if options.gridBased)

    ARMOR is only ever touched by grid-based attacks (options.gridBased).
    Execute, Status, Retaliate and Curse explosions skip it completely.

    A cursed cell that is damaged explodes: the cells up, down, left and
    right of it are damaged too (Armor ignores explosions). Each curse only
    explodes once.

    Returns:
        damage          cells that lost HP (direct hits and explosions)
        overhealDamage  cells that lost Overheal
        undyingDamage   cells that lost Undying
        exploded        curses that went off
        armorBroken     Armor cells destroyed (positions)
        directPositions every cell the attack itself changed (Armor included)
        directHits      the same, without Armor: the "successful hits"
*/
function damageMonsterCells(room, monster, positions, source = "attack", options = {}) {
    const size = monster.size;
    const curses = monster.curses;
    const gridBased = Boolean(options.gridBased);

    const exploded = [];
    const steps = [];

    const result = {
        monsterID: monster.id,
        damage: 0,
        overhealDamage: 0,
        undyingDamage: 0,
        exploded,
        armorBroken: [],
        directPositions: [],
        directHits: []
    };

    function hitCell(index, canBreakArmor) {
        const before = monster.grid[index];

        let after = null;

        if (before === "hp") {
            after = "empty";
        } else if (before === "overheal") {
            after = "hp";
        } else if (before === "undying") {
            after = "overheal";
        } else if (canBreakArmor && cards.isArmorCell(before)) {
            after = cards.ARMOR_BREAKS_TO[before];
        }

        if (after === null) return null;

        monster.grid[index] = after;

        if (before === "overheal") result.overhealDamage++;
        else if (before === "undying") result.undyingDamage++;
        else if (before === "hp") result.damage++;

        return { index, before, after };
    }

    let current = [];
    const seen = new Set();

    positions.forEach(position => {
        if (seen.has(position)) return;
        seen.add(position);

        const change = hitCell(position, gridBased);

        if (!change) return;

        current.push(change);
        result.directPositions.push(position);

        if (cards.isArmorCell(change.before)) {
            result.armorBroken.push(position);
        } else {
            result.directHits.push(position);
        }
    });

    while (current.length > 0) {
        steps.push({
            cells: current.map(change => ({
                index: change.index,
                cursed: curses.has(change.index),
                before: change.before,
                after: change.after
            }))
        });

        const next = [];

        current.forEach(change => {
            if (!curses.has(change.index)) return;

            curses.delete(change.index);
            exploded.push(change.index);

            const row = Math.floor(change.index / size);
            const column = change.index % size;

            [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dRow, dColumn]) => {
                const r = row + dRow;
                const c = column + dColumn;

                if (r < 0 || r >= size || c < 0 || c >= size) return;

                // Armor ignores Curse explosions.
                const explosion = hitCell(r * size + c, false);

                if (explosion) next.push(explosion);
            });
        });

        current = next;
    }

    // Everyone (Host included) gets the same animation order.
    if (steps.length > 0) {
        ctx.io.to(room.roomID).emit("monster-damage-fx", {
            monsterID: monster.id,
            source,
            steps
        });
    }

    const damagedCells =
        result.damage + result.overhealDamage + result.undyingDamage;

    if (damagedCells > 0) {
        runDamagePassives(room, monster, damagedCells);
    }

    checkDeaths(room);

    return result;
}

/*
    Takes defences off cells WITHOUT damaging them: no HP is ever lost.
    Used by Penetrate (Armor next to a hit cell) and Spellvamp.

        armor           -> hp
        armor-overheal  -> overheal  (or hp when options.stripOverheal)
        armor-undying   -> undying   (Undying itself is never stripped)
        overheal        -> hp        (only when options.stripOverheal)

    Returns what changed: [{ index, before, after }].
*/
function stripMonsterDefenses(room, monster, positions, source, options = {}) {
    const changes = [];

    positions.forEach(index => {
        const before = monster.grid[index];

        let after = null;

        if (before === "armor") {
            after = "hp";
        } else if (before === "armor-overheal") {
            after = options.stripOverheal ? "hp" : "overheal";
        } else if (before === "armor-undying") {
            after = "undying";
        } else if (before === "overheal" && options.stripOverheal) {
            after = "hp";
        }

        if (after === null) return;

        monster.grid[index] = after;
        changes.push({ index, before, after });
    });

    if (changes.length > 0) {
        ctx.io.to(room.roomID).emit("monster-damage-fx", {
            monsterID: monster.id,
            source,
            steps: [{
                cells: changes.map(change => ({ ...change, cursed: false }))
            }]
        });
    }

    return changes;
}

// Healthy monster cells: plain HP only (no Overheal, no Undying, no Armor).
function getHealthyMonsterPositions(monster) {
    return monster.grid
        .map((cell, index) => cell === "hp" ? index : -1)
        .filter(index => index !== -1);
}

// What Status may pick: HP, Overheal and Undying cells, never Armor.
function getStatusTargetPositions(monster) {
    return monster.grid
        .map((cell, index) => isMonsterHittable(cell) ? index : -1)
        .filter(index => index !== -1);
}


/* =====================================
   DEATH
===================================== */

// A Monster dies when every cell of its grid is empty.
function checkDeaths(room) {
    getMonsters(room).forEach(monster => {
        if (monster.dead) return;
        if (!monster.grid.every(cell => cell === "empty")) return;

        monster.dead = true;
        monster.taunt = 0;
        monster.rage = 0;
        monster.advantage = 0;
        monster.curses = new Set();

        // Warriors who were Countering it, and Counters it handed out, are void.
        for (const player of room.players.values()) {
            if (player.counters && player.counters[monster.id]) {
                delete player.counters[monster.id];
                syncCounterTotal(player);
            }
        }

        room.devilCounters = (room.devilCounters || []).filter(
            entry => entry.monsterID !== monster.id
        );

        ctx.io.to(room.roomID).emit("monster-died", {
            monsterID: monster.id,
            monsterName: monster.name,
            species: monster.species
        });

        console.log(`${monster.name} (${monster.species}) was defeated.`);
    });

    if (
        room.encounter?.active &&
        getMonsters(room).length > 0 &&
        getAliveMonsters(room).length === 0 &&
        !room.encounter.defeatedAnnounced
    ) {
        room.encounter.defeatedAnnounced = true;
        ctx.io.to(room.roomID).emit("monsters-defeated");
    }
}


/* =====================================
   SPECIES PASSIVES
===================================== */

// Runs after a card damaged `count` cells of `monster`.
function runDamagePassives(room, monster, count) {
    if (!room.encounter?.active) return;

    if (monster.species === "spirit") {
        spiritedHealth(room, monster, count);
    } else if (monster.species === "devil") {
        wrathfulPosition(room, monster, count);
    }
}

/*
    Spirit - Spirited Health.
    Every damaged cell makes its own 50% check. A success heals one random
    empty cell of a random teammate, or Overheals one of their healthy
    cells if they have no empty one. No teammates: nothing happens.
*/
function spiritedHealth(room, monster, count) {
    const heals = [];

    for (let i = 0; i < count; i++) {
        if (!chance(SPIRIT_HEAL_CHANCE)) continue;

        const teammates = getAliveMonsters(room).filter(
            other => other.id !== monster.id
        );

        const teammate = pickRandom(teammates);

        if (!teammate) break;

        const healed = healMonsterCell(teammate);

        if (healed) {
            heals.push({
                targetMonsterID: teammate.id,
                targetName: teammate.name,
                ...healed
            });
        }
    }

    if (heals.length > 0) {
        ctx.io.to(room.roomID).emit("monster-passive", {
            monsterID: monster.id,
            monsterName: monster.name,
            species: "spirit",
            passive: "Spirited Health",
            heals
        });
    }
}

/*
    Devil - Wrathful Position.
    Every damaged cell has a 25% chance to give Devil 1 Advantage.
*/
function wrathfulPosition(room, monster, count) {
    let gained = 0;

    for (let i = 0; i < count; i++) {
        if (chance(DEVIL_ADVANTAGE_CHANCE)) gained++;
    }

    if (gained === 0) return;

    monster.advantage += gained;

    ctx.io.to(room.roomID).emit("monster-passive", {
        monsterID: monster.id,
        monsterName: monster.name,
        species: "devil",
        passive: "Wrathful Position",
        advantage: monster.advantage,
        gained
    });
}

/*
    Scale - Adaptive Armor.
    A Marking card (Curse) or a non-grid effect (Execute, Status, Retaliate)
    has a 20% chance to become healing instead. Returns null when nothing
    happened (the effect goes ahead), or an object when it was converted
    (the caller must skip the damage / marks).
*/
function adaptiveArmor(room, monster, source) {
    if (monster.species !== "scale" || monster.dead) return null;
    if (!chance(SCALE_ADAPT_CHANCE)) return null;

    const healed = healMonsterCell(monster);

    ctx.io.to(room.roomID).emit("monster-passive", {
        monsterID: monster.id,
        monsterName: monster.name,
        species: "scale",
        passive: "Adaptive Armor",
        converted: source,
        heal: healed
    });

    return healed || { index: -1, kind: "none" };
}


/* =====================================
   PLAYER TARGETING (TAUNT, COUNTER)
===================================== */

function getTauntingMonsters(room) {
    return getAliveMonsters(room).filter(monster => monster.taunt > 0);
}

/*
    Works out which Monsters a player's card is aimed at, or tells the
    player why not (and returns null).

        data.monsterID / data.monsterIDs   the choice (Blast may have two)
        options.max                        how many distinct targets (default 1)

    If the player didn't choose and only one Monster can be chosen, that is
    the target. Rules, in order:
        - targets must exist, be alive and be different from each other
        - on a Warrior's Counter turn the only legal target is the Monster
          that was countered (Taunt is ignored)
        - while a Monster's Taunt has cards left, only taunting Monsters can
          be chosen (options.ignoreTaunt skips this: the Warrior's Counter)
*/
function resolveTargets(socket, room, data, { max = 1, ignoreTaunt = false } = {}) {
    const fail = message => {
        socket.emit("combat-action-error", message);
        return null;
    };

    const alive = getAliveMonsters(room);

    if (alive.length === 0) return fail("There are no Monsters left to target.");

    const turn = ctx.getCurrentTurn(room);
    const counterLock = turn?.counter ? room.counterTurn?.monsterID : null;

    let ids = [];

    if (Array.isArray(data?.monsterIDs)) ids = data.monsterIDs;
    else if (data?.monsterID) ids = [data.monsterID];

    ids = ids.filter(id => typeof id === "string");

    // Nothing chosen: pick for them when there is only one possible target.
    if (ids.length === 0) {
        let candidates = alive;

        if (counterLock) {
            candidates = alive.filter(monster => monster.id === counterLock);
        } else if (!ignoreTaunt) {
            const taunting = getTauntingMonsters(room);
            if (taunting.length > 0) candidates = taunting;
        }

        if (candidates.length !== 1) return fail("Choose a Monster to target.");

        ids = [candidates[0].id];
    }

    if (new Set(ids).size !== ids.length) {
        return fail("You can't target the same Monster twice with one card.");
    }

    if (ids.length > max) {
        return fail(`That card can only target ${max} Monster${max === 1 ? "" : "s"}.`);
    }

    const targets = [];

    for (const id of ids) {
        const monster = getMonster(room, id);

        if (!monster) return fail("That Monster could not be found.");
        if (monster.dead) return fail(`${monster.name} is already defeated.`);

        targets.push(monster);
    }

    if (counterLock) {
        const locked = getMonster(room, counterLock);

        if (targets.length !== 1 || targets[0].id !== counterLock) {
            return fail(
                `Counter locks you onto ${locked?.name || "that Monster"}. ` +
                "You can't aim anywhere else this turn."
            );
        }

        return targets;
    }

    const taunting = ignoreTaunt ? [] : getTauntingMonsters(room);

    if (taunting.length > 0) {
        const blocked = targets.find(monster => monster.taunt <= 0);

        if (blocked) {
            const first = taunting[0];

            return fail(
                `${first.name} used Taunt! Aim ${first.taunt} more card` +
                `${first.taunt === 1 ? "" : "s"} at it before targeting ` +
                `${blocked.name}.`
            );
        }
    }

    return targets;
}

// A card was played on these Monsters: each taunting one counts it.
function consumeTaunt(room, targets) {
    if (room.counterTurn) return; // Counter ignores Taunt

    targets.forEach(monster => {
        if (monster.taunt <= 0) return;

        monster.taunt--;

        if (monster.taunt <= 0) {
            ctx.io.to(room.roomID).emit("monster-taunt-ended", {
                monsterID: monster.id,
                monsterName: monster.name
            });
        }
    });
}


/* =====================================
   COUNTER (WARRIOR) AND COUNTER (DEVIL)
===================================== */

// Player.counters = { [monsterID]: turns }. counterTurns is the total.
function syncCounterTotal(player) {
    player.counterTurns = Object.values(player.counters || {})
        .reduce((total, turns) => total + turns, 0);
}

function addWarriorCounter(player, monster, turns) {
    if (!player.counters) player.counters = {};

    player.counters[monster.id] = (player.counters[monster.id] || 0) + turns;

    syncCounterTotal(player);
}

// A living Warrior who has a Counter waiting on this Monster.
function findCounteringWarrior(room, monsterID, isDead) {
    return Array.from(room.players.values()).find(
        player =>
            player.className === "Warrior" &&
            (player.counters?.[monsterID] || 0) > 0 &&
            !isDead(player)
    ) || null;
}

function consumeWarriorCounter(player, monsterID) {
    player.counters[monsterID]--;

    if (player.counters[monsterID] <= 0) delete player.counters[monsterID];

    syncCounterTotal(player);
}

// The Counters Devils have put on players (for the clients).
function getPublicDevilCounters(room) {
    return (room.devilCounters || [])
        .filter(entry => entry.turns > 0)
        .map(entry => {
            const player = room.players.get(entry.playerID);
            const monster = getMonster(room, entry.monsterID);

            return {
                playerID: entry.playerID,
                username: player?.username || "",
                monsterID: entry.monsterID,
                monsterName: monster?.name || "",
                turns: entry.turns
            };
        });
}

/*
    A player's own turn just ended. Every living Devil whose Counter is on
    them gets a bonus action (one at a time, in the order they were placed).
    Returns the bonus actions in order (each { monsterID, playerID }).
*/
function takeDevilCounterBonuses(room, playerID) {
    const bonuses = [];

    (room.devilCounters || []).forEach(entry => {
        if (entry.playerID !== playerID || entry.turns <= 0) return;

        const monster = getMonster(room, entry.monsterID);

        if (!monster || monster.dead) return;

        entry.turns--;
        bonuses.push({ monsterID: entry.monsterID, playerID });
    });

    room.devilCounters = (room.devilCounters || []).filter(
        entry => entry.turns > 0
    );

    return bonuses;
}


/* =====================================
   THE MONSTER'S TURN
===================================== */

/*
    room.monsterTurn remembers what the current Monster has done this turn:

        { monsterID, bonus, dice: [ { index, type, sides, locked, rolled,
                                      raw, value, remaining, done } ] }

    Dice 0-2 are the Species' fixed dice, die 3 is its D20 ultimate.
    Attack / Heal / Armor / Undying dice are POOLS of positions (spent over
    one or more actions). Debuff and Counter wait for a target. Taunt and
    Raging Demon apply the moment they are rolled.

    On a Devil's Counter bonus action only the D10, reduced to a D6, works.
*/
function buildMonsterTurn(room, monster, bonus) {
    const species = getSpecies(monster);

    const dice = species.dice.map((die, index) => {
        const isAttack = die.type === "attack";

        return {
            index,
            type: die.type,
            sides: bonus && isAttack && species.bonusAttackSides
                ? species.bonusAttackSides
                : die.sides,
            locked: bonus && !isAttack,
            rolled: false,
            raw: null,
            value: null,
            remaining: 0,
            done: false
        };
    });

    dice.push({
        index: ULTIMATE_INDEX,
        type: "ultimate",
        sides: species.ultimate.sides,
        locked:
            bonus ||
            monster.ultimateUses >= ULTIMATE_USES_PER_ENCOUNTER,
        rolled: false,
        raw: null,
        value: null,
        remaining: 0,
        done: false
    });

    return { monsterID: monster.id, bonus, dice };
}

// The turn record for whoever's turn it is (made on first use).
function ensureMonsterTurn(room) {
    const turn = ctx.getCurrentTurn(room);

    if (!turn || turn.type !== "monster") return null;

    const monster = getMonster(room, turn.id);

    if (!monster) return null;

    const bonus = Boolean(turn.bonus);
    const existing = room.monsterTurn;

    if (
        existing &&
        existing.monsterID === monster.id &&
        existing.bonus === bonus
    ) {
        return existing;
    }

    room.monsterTurn = buildMonsterTurn(room, monster, bonus);

    return room.monsterTurn;
}

function getPublicMonsterTurn(room) {
    const turn = room.encounter?.active ? ensureMonsterTurn(room) : null;

    if (!turn) return null;

    return {
        monsterID: turn.monsterID,
        bonus: turn.bonus,
        dice: turn.dice.map(die => ({ ...die }))
    };
}

function clearMonsterTurn(room) {
    room.monsterTurn = null;
}

// A Monster's turn (normal or bonus) just ended.
function onMonsterTurnEnd(room) {
    room.monsterTurn = null;
}

// A round just ended: Raging Demon counts rounds, starting the round after
// it was rolled.
function onRoundEnd(room, finishedRound) {
    getMonsters(room).forEach(monster => {
        if (monster.dead || monster.rage <= 0) return;
        if (finishedRound <= (monster.rageStart ?? 0)) return;

        monster.rage--;

        if (monster.rage <= 0) {
            ctx.io.to(room.roomID).emit("monster-effect-ended", {
                monsterID: monster.id,
                monsterName: monster.name,
                effect: "Raging Demon"
            });
        }
    });
}

// Applies one hit to a player's cell. Shared by attacks and Raging Demon.
function hitPlayerCell(player, position, tally) {
    const cell = player.grid[position];

    if (cell === "overheal") {
        player.grid[position] = "hp";
        tally.overhealDamage++;
        tally.overhealLostPositions.push(position);
        return true;
    }

    if (cell === "hp") {
        player.grid[position] = "empty";
        tally.damage++;
        tally.emptiedPositions.push(position);

        // A damaged Retaliate mark strikes back (once).
        if (player.marks?.has(position)) {
            player.marks.delete(position);
            tally.retaliations++;
        }

        return true;
    }

    return false;
}


/* =====================================
   SOCKET HANDLERS (the Host)
===================================== */

function registerSocketHandlers(socket) {
    const { rooms, io } = ctx;

    /* ---------- The Host's guards ---------- */

    // The Host acting on the current Monster's turn, or null (error sent).
    function getHostTurn(errorEvent = "monster-attack-error") {
        const room = rooms.get(socket.data.roomID);

        if (!ctx.isHost(socket, room)) return null;

        const fail = message => {
            socket.emit(errorEvent, message);
            return null;
        };

        if (!room.encounter?.active) return fail("There is no active encounter.");

        const turn = ensureMonsterTurn(room);

        if (!turn) return fail("It is not a Monster's turn.");

        const monster = getMonster(room, turn.monsterID);

        if (!monster || monster.dead) return fail("That Monster can't act.");

        return { room, turn, monster, fail };
    }

    function getDie(context, index, type) {
        const die = context.turn.dice[index];

        if (!die) return context.fail("That die doesn't exist.");
        if (die.locked) return context.fail("That die can't be used right now.");

        if (type && die.type !== type) {
            return context.fail(`That die isn't a ${type} die.`);
        }

        return die;
    }

    // After a pool die was spent: close it when nothing is left.
    function spendPool(die, amount) {
        die.remaining = Math.max(0, die.remaining - amount);

        if (die.remaining <= 0) die.done = true;
    }

    // Tell everyone (Host and players) what the Monster just did.
    function finishAction(context) {
        ctx.emitTurnState(context.room.roomID);
    }


    /* ---------- Bench: add / remove / paint ---------- */

    function getSetupRoom() {
        const room = rooms.get(socket.data.roomID);

        if (!ctx.isHost(socket, room)) return null;

        if (room.encounter?.active) {
            socket.emit("encounter-error", "End the current encounter first.");
            return null;
        }

        return room;
    }

    socket.on("monster-add", data => {
        const room = getSetupRoom();

        if (!room) return;

        const species = String(data?.species || "");
        const name = String(data?.name || "").trim();
        const size = Number(data?.size);

        if (!SPECIES[species]) {
            socket.emit("encounter-error", "Choose a Species first.");
            return;
        }

        if (!name || name.length > 24) {
            socket.emit("encounter-error", "Monster name must be 1–24 characters.");
            return;
        }

        if (!GRID_SIZES.includes(size)) {
            socket.emit("encounter-error", "Invalid monster grid size.");
            return;
        }

        if (getMonsters(room).length >= MAX_MONSTERS) {
            socket.emit(
                "encounter-error",
                `The bench is full (${MAX_MONSTERS} Monsters). Remove one first.`
            );
            return;
        }

        const monster = createMonster(species, name, size);

        room.encounter.monsters.push(monster);

        ctx.resetEncounterEffects(room);

        socket.emit("monster-added", {
            monsterID: monster.id,
            message: `${name} the ${SPECIES[species].name} joined the bench.`
        });

        ctx.updateEncounter(room.roomID);
        ctx.updateRoom(room.roomID);

        console.log("Monster added:", species, name, `${size}x${size}`);
    });

    socket.on("monster-remove", data => {
        const room = getSetupRoom();

        if (!room) return;

        const index = getMonsters(room).findIndex(
            monster => monster.id === data?.monsterID
        );

        if (index === -1) return;

        room.encounter.monsters.splice(index, 1);

        ctx.updateEncounter(room.roomID);
    });

    // The Host paints Overheal / Armor onto a Monster before the fight.
    socket.on("edit-monster-cell", data => {
        const room = rooms.get(socket.data.roomID);

        if (!ctx.isHost(socket, room)) return;

        if (room.encounter?.active) {
            socket.emit(
                "encounter-error",
                "Monster cells can only be changed before the encounter starts."
            );
            return;
        }

        const monster = getMonster(room, data?.monsterID);

        if (!monster) return;

        const index = Number(data?.index);
        const state = String(data?.state || "");

        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= monster.grid.length ||
            !MONSTER_SETUP_STATES.includes(state)
        ) {
            return;
        }

        monster.grid[index] = state;
        monster.curses.delete(index);

        ctx.updateEncounter(room.roomID);
    });


    /* ---------- Rolling a die ---------- */

    socket.on("monster-roll-die", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;
        const die = getDie(context, Number(data?.dieIndex));

        if (!die) return;

        if (die.rolled) {
            context.fail("That die was already rolled this turn.");
            return;
        }

        const raw = rollDie(die.sides);

        // Devil's Advantage is added to the number rolled, then it resets.
        const advantage = monster.advantage || 0;
        let value = raw + advantage;

        monster.advantage = 0;

        die.rolled = true;
        die.raw = raw;
        die.value = value;

        const detail = {
            dieIndex: die.index,
            type: die.type,
            sides: die.sides,
            raw,
            advantage,
            value
        };

        /* Attack: Weaken negates positions, as it always did. */
        if (die.type === "attack") {
            const weaken = Math.max(0, Number(room.weaken) || 0);

            if (weaken > 0) {
                const negated = Math.min(weaken, value);
                const effective = Math.max(0, value - negated);

                room.weaken = weaken - negated;

                const info = {
                    monsterID: monster.id,
                    monsterName: monster.name,
                    roll: value,
                    positionsNegated: negated,
                    absorbed: negated,
                    effective,
                    skipped: effective === 0,
                    weakenLeft: room.weaken
                };

                die.value = effective;
                die.remaining = effective;
                die.done = effective === 0;

                io.to(room.roomID).emit("monster-weakened", info);
            } else {
                die.remaining = value;
            }
        }

        /* Pools of positions */
        if (die.type === "heal" || die.type === "armor") {
            die.remaining = value;
        }

        /* Waiting for a target player */
        if (die.type === "debuff" || die.type === "counter") {
            die.remaining = 1;
        }

        /* Applied at once */
        if (die.type === "taunt") {
            monster.taunt += value;
            die.done = true;

            emitAction(room, monster, "taunt", { ...detail, taunt: monster.taunt });
        }

        if (die.type === "ultimate") {
            monster.ultimateUses++;

            const ultimate = getSpecies(monster).ultimate;

            if (ultimate.id === "raging-demon") {
                monster.rage = value;
                monster.rageStart = room.round || 1;
                die.done = true;

                emitAction(room, monster, "raging-demon", { ...detail, rage: monster.rage });
            } else if (ultimate.id === "taunt") {
                monster.taunt += value;
                die.done = true;

                emitAction(room, monster, "taunt", {
                    ...detail,
                    ultimate: true,
                    taunt: monster.taunt
                });
            } else {
                // Undying: the Host chooses the cells.
                die.remaining = value;
            }
        }

        // The Host's own roll message.
        socket.emit("monster-die-result", detail);

        finishAction(context);

        console.log(
            `${monster.name} rolled ${die.type} d${die.sides}: ${raw}` +
            (advantage ? ` +${advantage} Advantage` : "")
        );
    });

    // Give up whatever is left of a die.
    socket.on("monster-skip-die", data => {
        const context = getHostTurn();

        if (!context) return;

        const die = getDie(context, Number(data?.dieIndex));

        if (!die) return;

        if (!die.rolled || die.done) return;

        die.done = true;
        die.remaining = 0;

        finishAction(context);
    });


    /* ---------- Attack ---------- */

    socket.on("monster-attack", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;

        const die = getDie(
            context,
            Number.isInteger(data?.dieIndex)
                ? data.dieIndex
                : turn.dice.findIndex(item => item.type === "attack"),
            "attack"
        );

        if (!die) return;

        if (!die.rolled || die.done || die.remaining <= 0) {
            context.fail("Roll the Attack die before attacking.");
            return;
        }

        /* Tank's Taunt: the Tank is the only legal target. */
        if (room.taunt) {
            const tank = room.players.get(room.taunt.tankID);

            if (!tank || ctx.getHittablePositions(tank.grid).length === 0) {
                room.taunt = null;
                ctx.updateEncounter(room.roomID);
            } else if (
                !cards.isTauntPaused(room, tank) &&
                data?.playerID !== tank.id
            ) {
                context.fail(`Taunt is active! You must target ${tank.username}.`);
                return;
            }
        }

        const player = room.players.get(data?.playerID);
        const positions = data?.positions;

        if (!player) {
            context.fail("Target player not found.");
            return;
        }

        if (cards.isShielded(room, player)) {
            context.fail(`${player.username} is Shielded and cannot be targeted.`);
            return;
        }

        const hittableCount = ctx.getHittablePositions(player.grid).length;

        if (hittableCount === 0) {
            context.fail(`${player.username} has no HP left to hit. Pick another target.`);
            return;
        }

        const tauntedTank =
            room.taunt &&
            room.taunt.tankID === player.id &&
            !cards.isTauntPaused(room, player);

        let maxCount = Math.min(die.remaining, hittableCount);

        if (tauntedTank) {
            maxCount = Math.min(maxCount, room.taunt.remainingDamage);
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
                !ctx.isHittable(player.grid[position])
            )
        ) {
            context.fail(`Select between 1 and ${maxCount} hittable positions.`);
            return;
        }

        const tally = {
            damage: 0,
            overhealDamage: 0,
            retaliations: 0,
            emptiedPositions: [],
            overhealLostPositions: []
        };

        positions.forEach(position => hitPlayerCell(player, position, tally));

        /*
            Raging Demon: every cell Devil damages makes two separate checks.
            The extra damage never triggers Raging Demon again.
        */
        const rageHealed = [];
        const rageExtra = [];

        if (monster.rage > 0) {
            const damagedCells = tally.damage + tally.overhealDamage;

            for (let i = 0; i < damagedCells; i++) {
                if (chance(RAGE_HEAL_CHANCE)) {
                    const empties = monster.grid
                        .map((cell, index) => cell === "empty" ? index : -1)
                        .filter(index => index !== -1);

                    const pick = pickRandom(empties);

                    if (pick !== null) {
                        monster.grid[pick] = "hp";
                        rageHealed.push(pick);
                    }
                }

                if (chance(RAGE_EXTRA_CHANCE)) {
                    const pick = pickRandom(
                        ctx.getHittablePositions(player.grid)
                    );

                    if (pick !== null) {
                        hitPlayerCell(player, pick, tally);
                        rageExtra.push(pick);
                    }
                }
            }
        }

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

        const rolled = die.value;
        let remaining = die.remaining - positions.length;

        // If nobody has HP left to hit, the leftover is lost.
        const anyoneHittable = Array.from(room.players.values()).some(
            member =>
                ctx.getHittablePositions(member.grid).length > 0 &&
                !cards.isShielded(room, member)
        );

        if (!anyoneHittable) remaining = 0;

        die.remaining = Math.max(0, remaining);
        die.done = die.remaining <= 0;

        io.to(room.roomID).emit("monster-attack-resolved", {
            monsterID: monster.id,
            monsterName: monster.name,
            species: monster.species,
            playerID: player.id,
            username: player.username,
            positions,
            emptiedPositions: tally.emptiedPositions,
            overhealLostPositions: tally.overhealLostPositions,
            rageExtraPositions: rageExtra,
            rageHealedPositions: rageHealed,
            roll: rolled,
            remaining: die.remaining,
            damage: tally.damage,
            overhealDamage: tally.overhealDamage,
            tauntRemaining
        });

        /*
            Retaliate: each damaged mark hits a random healthy cell of THIS
            Monster only. Other Monsters never take it.
        */
        if (tally.retaliations > 0) {
            let damage = 0;
            let converted = false;

            if (adaptiveArmor(room, monster, "retaliate")) {
                converted = true;
            } else {
                const targets = ctx.shuffle(
                    getHealthyMonsterPositions(monster)
                ).slice(0, tally.retaliations);

                damage = damageMonsterCells(room, monster, targets, "retaliate").damage;
            }

            // Only players are told (the Host can't see the marks).
            for (const member of room.players.values()) {
                io.to(member.id).emit("retaliate-triggered", {
                    monsterID: monster.id,
                    monsterName: monster.name,
                    playerID: player.id,
                    username: player.username,
                    triggered: tally.retaliations,
                    damage,
                    converted
                });
            }
        }

        ctx.sendPlayerState(player);

        // A Monster that dies to its own Retaliate has nothing left to do.
        if (monster.dead) {
            ctx.advanceTurn(room);
        }

        ctx.emitTurnState(room.roomID);
    });


    /* ---------- Heal / Armor (on Monsters) ---------- */

    // Picks the Monster and cells for a heal / armor / undying action.
    function getCellChoice(context, targetID, positions, die, isAllowed) {
        const target = getMonster(context.room, targetID);

        if (!target || target.dead) {
            context.fail("Choose a living Monster.");
            return null;
        }

        if (
            !Array.isArray(positions) ||
            positions.length < 1 ||
            positions.length > die.remaining ||
            new Set(positions).size !== positions.length ||
            positions.some(position =>
                !Number.isInteger(position) ||
                position < 0 ||
                position >= target.grid.length ||
                !isAllowed(target.grid[position])
            )
        ) {
            context.fail(`Select between 1 and ${die.remaining} valid cells.`);
            return null;
        }

        return target;
    }

    function hasLegalCell(room, isAllowed) {
        return getAliveMonsters(room).some(
            target => target.grid.some(isAllowed)
        );
    }

    socket.on("monster-heal", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;
        const die = getDie(
            context,
            turn.dice.findIndex(item => item.type === "heal"),
            "heal"
        );

        if (!die) return;

        if (!die.rolled || die.done || die.remaining <= 0) {
            context.fail("Roll the Heal die first.");
            return;
        }

        const healable = cell => cell === "empty" || cell === "hp";
        const target = getCellChoice(
            context, data?.targetMonsterID, data?.positions, die, healable
        );

        if (!target) return;

        const healedPositions = [];
        const overhealedPositions = [];

        data.positions.forEach(position => {
            if (target.grid[position] === "empty") {
                target.grid[position] = "hp";
                healedPositions.push(position);
            } else {
                target.grid[position] = "overheal";
                overhealedPositions.push(position);
            }
        });

        spendPool(die, data.positions.length);

        if (!hasLegalCell(room, healable)) {
            die.done = true;
            die.remaining = 0;
        }

        emitAction(room, monster, "heal", {
            targetMonsterID: target.id,
            targetName: target.name,
            healedPositions,
            overhealedPositions,
            remaining: die.remaining
        });

        finishAction(context);
    });

    socket.on("monster-armor", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;
        const die = getDie(
            context,
            turn.dice.findIndex(item => item.type === "armor"),
            "armor"
        );

        if (!die) return;

        if (!die.rolled || die.done || die.remaining <= 0) {
            context.fail("Roll the Armor die first.");
            return;
        }

        const target = getCellChoice(
            context, data?.targetMonsterID, data?.positions, die, isArmorable
        );

        if (!target) return;

        const armored = [];

        data.positions.forEach(position => {
            const cell = target.grid[position];

            target.grid[position] =
                cell === "overheal" ? "armor-overheal"
                    : cell === "undying" ? "armor-undying"
                        : "armor";

            armored.push(position);
        });

        spendPool(die, armored.length);

        if (!hasLegalCell(room, isArmorable)) {
            die.done = true;
            die.remaining = 0;
        }

        emitAction(room, monster, "armor", {
            targetMonsterID: target.id,
            targetName: target.name,
            positions: armored,
            remaining: die.remaining
        });

        finishAction(context);
    });


    /* ---------- Undying (Spirit's ultimate) ---------- */

    socket.on("monster-undying", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster } = context;
        const die = getDie(context, ULTIMATE_INDEX, "ultimate");

        if (!die) return;

        if (
            getSpecies(monster).ultimate.id !== "undying" ||
            !die.rolled ||
            die.done ||
            die.remaining <= 0
        ) {
            context.fail("Roll the Undying ultimate first.");
            return;
        }

        const cells = data?.cells;

        // Healthy HP, with or without Armor. Overheal can't become Undying.
        const eligible = cell => cell === "hp" || cell === "armor";

        const valid =
            Array.isArray(cells) &&
            cells.length >= 1 &&
            cells.length <= die.remaining &&
            new Set(cells.map(cell => `${cell?.monsterID}:${cell?.index}`)).size === cells.length &&
            cells.every(cell => {
                const target = getMonster(room, cell?.monsterID);

                return (
                    target &&
                    !target.dead &&
                    Number.isInteger(cell.index) &&
                    cell.index >= 0 &&
                    cell.index < target.grid.length &&
                    eligible(target.grid[cell.index])
                );
            });

        if (!valid) {
            context.fail(`Select between 1 and ${die.remaining} healthy cells.`);
            return;
        }

        const touched = [];

        cells.forEach(cell => {
            const target = getMonster(room, cell.monsterID);

            target.grid[cell.index] =
                target.grid[cell.index] === "armor" ? "armor-undying" : "undying";

            touched.push(describeCell(target, cell.index));
        });

        spendPool(die, cells.length);

        if (!hasLegalCell(room, eligible)) {
            die.done = true;
            die.remaining = 0;
        }

        emitAction(room, monster, "undying", {
            cells: touched,
            remaining: die.remaining
        });

        finishAction(context);
    });


    /* ---------- Debuff / Counter (Devil) ---------- */

    function getPlayerTarget(context, playerID) {
        const player = context.room.players.get(playerID);

        if (!player) {
            context.fail("Target player not found.");
            return null;
        }

        if (ctx.isDead(player)) {
            context.fail(`${player.username} is already dead.`);
            return null;
        }

        if (cards.isShielded(context.room, player)) {
            context.fail(`${player.username} is Shielded and cannot be targeted.`);
            return null;
        }

        return player;
    }

    socket.on("monster-debuff", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;
        const die = getDie(
            context,
            turn.dice.findIndex(item => item.type === "debuff"),
            "debuff"
        );

        if (!die) return;

        if (!die.rolled || die.done) {
            context.fail("Roll the Debuff die first.");
            return;
        }

        const player = getPlayerTarget(context, data?.playerID);

        if (!player) return;

        // Energy can drop below zero, like it always could.
        player.energy -= die.value;

        die.done = true;
        die.remaining = 0;

        // Energy is secret from the Host, so the result carries no totals.
        emitAction(room, monster, "debuff", {
            playerID: player.id,
            username: player.username,
            amount: die.value
        });

        ctx.sendPlayerState(player);
        finishAction(context);
    });

    socket.on("monster-counter", data => {
        const context = getHostTurn();

        if (!context) return;

        const { room, monster, turn } = context;
        const die = getDie(
            context,
            turn.dice.findIndex(item => item.type === "counter"),
            "counter"
        );

        if (!die) return;

        if (!die.rolled || die.done) {
            context.fail("Roll the Counter die first.");
            return;
        }

        const player = getPlayerTarget(context, data?.playerID);

        if (!player) return;

        const existing = room.devilCounters.find(
            entry => entry.playerID === player.id && entry.monsterID === monster.id
        );

        if (existing) existing.turns += die.value;
        else {
            room.devilCounters.push({
                playerID: player.id,
                monsterID: monster.id,
                turns: die.value
            });
        }

        die.done = true;
        die.remaining = 0;

        emitAction(room, monster, "counter", {
            playerID: player.id,
            username: player.username,
            turns: die.value
        });

        finishAction(context);
    });
}


module.exports = {
    // Data
    MONSTER_SETUP_STATES,
    MAX_MONSTERS,

    // Bench
    createEncounterState,
    getMonsters,
    getMonster,
    getAliveMonsters,
    isMonsterDead,
    getPublicMonsters,
    getParticipants,
    beginEncounter,
    finishEncounter,
    resetRoomEffects,

    // Damage
    damageMonsterCells,
    stripMonsterDefenses,
    getHealthyMonsterPositions,
    getStatusTargetPositions,
    isMonsterHittable,
    adaptiveArmor,
    checkDeaths,

    // Player targeting
    resolveTargets,
    consumeTaunt,
    getTauntingMonsters,

    // Counters
    syncCounterTotal,
    addWarriorCounter,
    findCounteringWarrior,
    consumeWarriorCounter,
    getPublicDevilCounters,
    takeDevilCounterBonuses,

    // The Monster's turn
    ensureMonsterTurn,
    getPublicMonsterTurn,
    clearMonsterTurn,
    onMonsterTurnEnd,
    onRoundEnd,

    // Wiring
    init,
    registerSocketHandlers
};
