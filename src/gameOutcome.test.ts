import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, World } from "./types";
import { defaultRoleRegistry } from "./roles";
import {
  canTownForceWinUnderOptimalPlay,
  extractTeamCounts,
  getGameOutcome,
  getPossibleWorlds,
  TeamCounts,
} from "./gameOutcome";

// --- 1. Has Town already won? ---

test("all Mafia dead -> Town won", () => {
  const world: World = {
    probability: 1,
    roles: { "1": "mafia", "2": "citizen", "3": "citizen" },
  };
  const alive: AliveState = { "1": false, "2": true, "3": true };
  assert.equal(getGameOutcome(world, alive, defaultRoleRegistry), "townWon");
});

test("all Mafia dead but nobody else living either -> still Town won (mafiaAlive checked first)", () => {
  const world: World = { probability: 1, roles: { "1": "mafia", "2": "citizen" } };
  const alive: AliveState = { "1": false, "2": false };
  assert.equal(getGameOutcome(world, alive, defaultRoleRegistry), "townWon");
});

// --- 2/3. Mafia alive and Town alive -> not automatically Mafia won ---

test("Mafia alive and Town alive is not automatically Mafia won", () => {
  const world: World = {
    probability: 1,
    roles: { "1": "mafia", "2": "citizen", "3": "citizen", "4": "citizen" },
  };
  const alive: AliveState = { "1": true, "2": true, "3": true, "4": true };
  // mafiaAlive=1, townAlive=3: neither count is 0, so this is "ongoing" as
  // a rule-guaranteed fact, regardless of how the counts compare.
  assert.equal(getGameOutcome(world, alive, defaultRoleRegistry), "ongoing");
});

test("even a heavy Mafia majority is still 'ongoing', not 'mafiaWon', as long as Town has at least one living member (do not use mafiaCount >= townCount)", () => {
  const world: World = {
    probability: 1,
    roles: { "1": "mafia", "2": "mafia", "3": "mafia", "4": "mafia", "5": "citizen" },
  };
  const alive: AliveState = { "1": true, "2": true, "3": true, "4": true, "5": true };
  // mafiaAlive=4, townAlive=1: nothing in the rules alone guarantees Town
  // can never force another elimination while it still has a living
  // member - see this module's top-of-file docs.
  assert.equal(getGameOutcome(world, alive, defaultRoleRegistry), "ongoing");
});

// --- canTownForceWinUnderOptimalPlay: a separate, explicitly optional,
// non-authoritative strategic forecast - NOT a claim about what the rules
// alone guarantee, and NOT something getGameOutcome ever consults. These
// tests pin down THIS MODEL's predictions, not "who has already won". ---

test("this strategic model predicts a Mafia win at exact parity with no special roles alive", () => {
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 3,
      townAlive: 3,
      doctorAlive: false,
      commissionerAlive: false,
    }),
    false
  );
});

test("this strategic model predicts a bare 1-player Town majority is NOT sufficient without special roles", () => {
  // townAlive=3, mafiaAlive=2: town is nominally ahead, but under this
  // model's assumptions the night kill (unblockable without a Doctor)
  // erodes that lead to an exact tie before the day vote can ever exploit
  // it, and at an exact tie voting.ts's own keep-or-eliminate rule keeps
  // everyone - see stepRound's docs. This model requires a margin of at
  // least 2 without special roles, not just 1 - a property of THIS
  // strategic model, not a game rule.
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 2,
      townAlive: 3,
      doctorAlive: false,
      commissionerAlive: false,
    }),
    false
  );
  // a margin of 2 is enough under this model - it survives the night
  // erosion with margin 1 still positive, so the day vote also fires,
  // restoring the margin.
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 2,
      townAlive: 4,
      doctorAlive: false,
      commissionerAlive: false,
    }),
    true
  );
});

// --- living Commissioner / Doctor can each independently flip THIS
// STRATEGIC MODEL's prediction ---

test("a living Commissioner can flip this strategic model's prediction from a Mafia win to a forced Town win", () => {
  const base: TeamCounts = { mafiaAlive: 2, townAlive: 3, doctorAlive: false, commissionerAlive: false };
  assert.equal(canTownForceWinUnderOptimalPlay(base), false);
  assert.equal(canTownForceWinUnderOptimalPlay({ ...base, commissionerAlive: true }), true);
});

test("a living Doctor can flip this strategic model's prediction from a Mafia win to a forced Town win", () => {
  const base: TeamCounts = { mafiaAlive: 2, townAlive: 3, doctorAlive: false, commissionerAlive: false };
  assert.equal(canTownForceWinUnderOptimalPlay(base), false);
  assert.equal(canTownForceWinUnderOptimalPlay({ ...base, doctorAlive: true }), true);
});

// --- dead active roles vs living active roles, and world-relative reasoning
// (the same public alive-state, two different worlds) - these are really
// the same requirement, tested together. getGameOutcome's rule-guaranteed
// answer is "ongoing" for BOTH worlds here (neither count is 0), which is
// itself the correct, honest behavior - the two worlds only diverge once a
// strategic model (canTownForceWinUnderOptimalPlay) is explicitly applied
// to their extracted counts. ---

test("the same alive-state extracts different TeamCounts under different hidden worlds, and getGameOutcome stays honestly 'ongoing' for both", () => {
  const alive: AliveState = { "1": true, "2": true, "3": true, "4": true, "5": false, "6": false };

  const worldWithLivingSpecialRoles: World = {
    probability: 1,
    roles: {
      "1": "mafia",
      "2": "mafia",
      "3": "doctor",
      "4": "commissioner",
      "5": "citizen",
      "6": "citizen",
    },
  };
  const worldWithDeadSpecialRoles: World = {
    probability: 1,
    roles: {
      "1": "mafia",
      "2": "mafia",
      "3": "citizen",
      "4": "citizen",
      "5": "doctor",
      "6": "commissioner",
    },
  };

  // both worlds have identical mafiaAlive/townAlive counts (2 vs 2) under
  // this same alive-state - only whether the Doctor/Commissioner happen to
  // be among the living or the dead differs.
  const livingCounts = extractTeamCounts(worldWithLivingSpecialRoles, alive, defaultRoleRegistry);
  const deadCounts = extractTeamCounts(worldWithDeadSpecialRoles, alive, defaultRoleRegistry);
  assert.deepEqual(livingCounts, {
    mafiaAlive: 2,
    townAlive: 2,
    doctorAlive: true,
    commissionerAlive: true,
  });
  assert.deepEqual(deadCounts, {
    mafiaAlive: 2,
    townAlive: 2,
    doctorAlive: false,
    commissionerAlive: false,
  });

  // getGameOutcome: neither world has mafiaAlive===0 or townAlive===0, so
  // both are honestly "ongoing" - getGameOutcome never claims more than
  // the rules alone guarantee, regardless of which world this is.
  assert.equal(getGameOutcome(worldWithLivingSpecialRoles, alive, defaultRoleRegistry), "ongoing");
  assert.equal(getGameOutcome(worldWithDeadSpecialRoles, alive, defaultRoleRegistry), "ongoing");

  // the two worlds DO genuinely diverge once the separate, optional
  // strategic model is applied to their extracted counts - this is where
  // "dead vs living active roles" actually shows up as a difference.
  assert.equal(canTownForceWinUnderOptimalPlay(livingCounts), true);
  assert.equal(canTownForceWinUnderOptimalPlay(deadCounts), false);
});

// --- exhaustive, hand/script-verifiable small-state coverage for
// canTownForceWinUnderOptimalPlay, pinning down the exact margin THIS
// STRATEGIC MODEL requires for each role configuration - these are
// properties of the model, not of the game's rules ---

test("canTownForceWinUnderOptimalPlay: exact required margin for each doctor/commissioner combination", () => {
  const cases: Array<{
    doctorAlive: boolean;
    commissionerAlive: boolean;
    // this model predicts a forced Town win iff townAlive - mafiaAlive >=
    // this margin (verified exhaustively for mafiaAlive, townAlive in 1..8
    // during development; pinned here at a representative sample)
    requiredMargin: number;
  }> = [
    { doctorAlive: false, commissionerAlive: false, requiredMargin: 2 },
    { doctorAlive: true, commissionerAlive: false, requiredMargin: 1 },
    { doctorAlive: false, commissionerAlive: true, requiredMargin: 1 },
  ];

  cases.forEach(({ doctorAlive, commissionerAlive, requiredMargin }) => {
    for (let mafiaAlive = 2; mafiaAlive <= 6; mafiaAlive++) {
      const justShort: TeamCounts = {
        mafiaAlive,
        townAlive: mafiaAlive + requiredMargin - 1,
        doctorAlive,
        commissionerAlive,
      };
      const justEnough: TeamCounts = {
        mafiaAlive,
        townAlive: mafiaAlive + requiredMargin,
        doctorAlive,
        commissionerAlive,
      };
      assert.equal(
        canTownForceWinUnderOptimalPlay(justShort),
        false,
        `doctor=${doctorAlive} commissioner=${commissionerAlive} mafia=${mafiaAlive}: margin ${
          requiredMargin - 1
        } should still predict a Mafia win under this model`
      );
      assert.equal(
        canTownForceWinUnderOptimalPlay(justEnough),
        true,
        `doctor=${doctorAlive} commissioner=${commissionerAlive} mafia=${mafiaAlive}: margin ${requiredMargin} should be enough under this model`
      );
    }
  });
});

test("canTownForceWinUnderOptimalPlay: Doctor AND Commissioner together predict a forced Town win even at exact parity", () => {
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 4,
      townAlive: 4,
      doctorAlive: true,
      commissionerAlive: true,
    }),
    true
  );
});

test("canTownForceWinUnderOptimalPlay: a large enough Mafia majority is unrecoverable even with both special roles alive", () => {
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 20,
      townAlive: 1,
      doctorAlive: true,
      commissionerAlive: true,
    }),
    false
  );
});

test("canTownForceWinUnderOptimalPlay: mutual last-player elimination (1 Mafia vs 1 Commissioner, no Doctor) counts as a forced Town win", () => {
  // a real, mechanically reachable resolveNight outcome in a 2-living-player
  // endgame: the sole Mafia killer and the sole living Commissioner both die
  // on the same night (see getGameOutcome's docs on the mafiaAlive===0
  // tie-break, which this function shares).
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 1,
      townAlive: 1,
      doctorAlive: false,
      commissionerAlive: true,
    }),
    true
  );
});

// --- terminal base cases, direct ---

test("canTownForceWinUnderOptimalPlay: mafiaAlive 0 is always true, townAlive 0 (with mafia alive) is always false", () => {
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 0,
      townAlive: 5,
      doctorAlive: false,
      commissionerAlive: false,
    }),
    true
  );
  assert.equal(
    canTownForceWinUnderOptimalPlay({
      mafiaAlive: 5,
      townAlive: 0,
      doctorAlive: false,
      commissionerAlive: false,
    }),
    false
  );
});

// --- getPossibleWorlds: posterior interaction ---

test("getPossibleWorlds classifies every positive-probability world and excludes zero-probability (impossible) ones", () => {
  const alive: AliveState = { "1": true, "2": true };
  const worlds: World[] = [
    { probability: 0.5, roles: { "1": "mafia", "2": "citizen" } }, // mafiaAlive=1, townAlive=1 -> ongoing
    { probability: 0.5, roles: { "1": "citizen", "2": "mafia" } }, // same shape -> ongoing
    { probability: 0, roles: { "1": "mafia", "2": "mafia" } }, // zero-probability: townAlive=0 would be mafiaWon, but must be excluded entirely
  ];

  const result = getPossibleWorlds(worlds, alive, defaultRoleRegistry);
  assert.equal(result.mafiaWon.length, 0);
  assert.equal(result.townWon.length, 0);
  assert.equal(result.ongoing.length, 2);
  // the zero-probability world must not appear in ANY bucket
  const classified = [...result.townWon, ...result.mafiaWon, ...result.ongoing];
  assert.ok(classified.every((w) => w.probability > 0));
});

test("getPossibleWorlds never mutates the input worlds array or any world's probability", () => {
  const alive: AliveState = { "1": true, "2": true, "3": true };
  const worlds: World[] = [
    { probability: 0.3, roles: { "1": "mafia", "2": "citizen", "3": "citizen" } },
    { probability: 0.7, roles: { "1": "citizen", "2": "mafia", "3": "citizen" } },
  ];
  const snapshot = worlds.map((w) => ({ ...w, roles: { ...w.roles } }));

  getPossibleWorlds(worlds, alive, defaultRoleRegistry);

  assert.deepEqual(worlds, snapshot);
});

// --- no posterior mutation anywhere in this module ---

test("getGameOutcome never mutates the world or its probability", () => {
  const world: World = {
    probability: 0.42,
    roles: { "1": "mafia", "2": "citizen", "3": "citizen" },
  };
  const snapshot = { ...world, roles: { ...world.roles } };
  const alive: AliveState = { "1": true, "2": true, "3": true };

  getGameOutcome(world, alive, defaultRoleRegistry);

  assert.deepEqual(world, snapshot);
});
