import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { GameConfig } from "./types";
import { SimulationOutput } from "./simulation/types";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  PerGameCounts,
  buildParamsFromCounts,
  computePerGameCounts,
  investigationReportJointCounts,
  leaveOneOut,
  sumPerGameCounts,
} from "./syntheticParamsRobustness";

/**
 * Tests for the leave-one-synthetic-game-out robustness diagnostic
 * machinery only - never production behavior, never
 * syntheticBehavioralModelParams itself, never the smoothing constant
 * (smoothedSplit is imported unchanged from syntheticBehavioralModel.ts,
 * not reimplemented).
 */

function bucket(townToTown: number, townToMafia: number, mafiaToMafia: number, mafiaToTown: number) {
  return { townToTown, townToMafia, mafiaToMafia, mafiaToTown };
}

const gameA: PerGameCounts = {
  seed: 1,
  suspectCounts: bucket(2, 3, 0, 4),
  defendCounts: bucket(1, 0, 0, 1),
  nominateCounts: bucket(0, 1, 0, 2),
  roleClaims: { truthful: 2, falseSameTeam: 0, falseDifferentTeam: 1 },
  investigationReportJoint: [1, 0, 0],
  voteCounts: { town: { forMafiaCandidate: 2, forTownCandidate: 1, abstain: 1 }, mafia: { forMafiaCandidate: 0, forTownCandidate: 2, abstain: 0 } },
};
const gameB: PerGameCounts = {
  seed: 2,
  suspectCounts: bucket(1, 2, 0, 3),
  defendCounts: bucket(2, 1, 0, 0),
  nominateCounts: bucket(1, 0, 0, 1),
  roleClaims: { truthful: 1, falseSameTeam: 1, falseDifferentTeam: 0 },
  investigationReportJoint: [0, 1, 1],
  voteCounts: { town: { forMafiaCandidate: 1, forTownCandidate: 2, abstain: 0 }, mafia: { forMafiaCandidate: 0, forTownCandidate: 1, abstain: 1 } },
};

test("sumPerGameCounts: sums every field across all games, including the [truthful,falseResult,bluff] investigationReportJoint triple", () => {
  const summed = sumPerGameCounts([gameA, gameB]);
  assert.deepEqual(summed.suspectCounts, bucket(3, 5, 0, 7));
  assert.deepEqual(summed.defendCounts, bucket(3, 1, 0, 1));
  assert.deepEqual(summed.roleClaims, { truthful: 3, falseSameTeam: 1, falseDifferentTeam: 1 });
  assert.deepEqual(summed.investigationReportJoint, [1, 1, 1]);
  assert.deepEqual(summed.voteCounts.town, { forMafiaCandidate: 3, forTownCandidate: 3, abstain: 1 });
  assert.deepEqual(summed.voteCounts.mafia, { forMafiaCandidate: 0, forTownCandidate: 3, abstain: 1 });
});

test("leaveOneOut: excludes exactly the held-out index, sums the rest", () => {
  const games = [gameA, gameB];
  const withoutA = leaveOneOut(games, 0);
  assert.deepEqual(withoutA.suspectCounts, gameB.suspectCounts);
  const withoutB = leaveOneOut(games, 1);
  assert.deepEqual(withoutB.suspectCounts, gameA.suspectCounts);
});

test("buildParamsFromCounts: applies the SAME smoothedSplit rule (kappa=10) as syntheticBehavioralModel.ts - verified on a hand-computed example", () => {
  const summed = sumPerGameCounts([gameA, gameB]); // suspect town: [3,5] town-to-town/town-to-mafia
  const params = buildParamsFromCounts(summed);
  // (3 + 5) / (8 + 10) = 8/18 for ownTeam; (5+5)/(8+10) = 10/18 for otherTeam
  assert.ok(Math.abs(params.suspect.town!.ownTeam - 8 / 18) < 1e-12);
  assert.ok(Math.abs(params.suspect.town!.otherTeam - 10 / 18) < 1e-12);
  // untouched categories (zero synthetic data in this milestone too) stay at defaultBehavioralModelParams
  assert.equal(params.repeatFactor, 1);
});

test("buildParamsFromCounts, summed over ALL 10 real synthetic games, reproduces syntheticBehavioralModelParams exactly - proves this diagnostic module's counting/smoothing is faithful, not a divergent reimplementation", () => {
  const SYNTHETIC_DIR =
    "/private/tmp/claude-502/-Users-yurii-Documents-personal-mafia-game-predictor/29f99942-d7c7-41c9-8d93-8a8624b90714/scratchpad/synthetic-experiment-1000";
  const SEEDS = [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009];
  const perGame: PerGameCounts[] = SEEDS.map((seed) => {
    const raw = JSON.parse(fs.readFileSync(`${SYNTHETIC_DIR}/synthetic-game-${seed}-output.json`, "utf8"));
    const config: GameConfig = raw.config;
    const output: SimulationOutput = raw;
    return computePerGameCounts(seed, config, output);
  });
  const full = buildParamsFromCounts(sumPerGameCounts(perGame));
  assert.deepEqual(full.suspect, syntheticBehavioralModelParams.suspect);
  assert.deepEqual(full.defend, syntheticBehavioralModelParams.defend);
  assert.deepEqual(full.nominate, syntheticBehavioralModelParams.nominate);
  assert.deepEqual(full.selfRoleClaim, syntheticBehavioralModelParams.selfRoleClaim);
  assert.deepEqual(full.investigationReport, syntheticBehavioralModelParams.investigationReport);
  assert.deepEqual(full.candidateVote, syntheticBehavioralModelParams.candidateVote);
});

test("investigationReportJointCounts: holder+matching result -> truthful; holder+wrong result -> falseResult; non-holder -> bluff regardless of match", () => {
  // player 1 = commissioner (holds checkIsMafia), player 2 = citizen (holds nothing).
  // getInvestigationResult(checkIsMafia, citizen) is false - citizen has no unanimousNightKill mechanic.
  const config: GameConfig = { players: ["1", "2"], roles: ["commissioner", "citizen"] };
  const output: SimulationOutput = {
    config,
    seed: 0,
    outcome: "townWon" as any,
    roundsPlayed: 1,
    terminatedByRoundCap: false,
    stats: {} as any,
    groundTruth: { roles: { "1": "commissioner", "2": "citizen" }, nights: [] },
    publicEvidence: [
      { type: "investigationReport", round: 0, actor: "1", target: "2", mechanic: "checkIsMafia", result: false } as any, // holder, correct -> truthful
      { type: "investigationReport", round: 1, actor: "1", target: "2", mechanic: "checkIsMafia", result: true } as any, // holder, wrong -> falseResult
      { type: "investigationReport", round: 2, actor: "2", target: "1", mechanic: "checkIsMafia", result: false } as any, // non-holder -> bluff (even though "correct")
    ],
  };
  const [truthful, falseResult, bluff] = investigationReportJointCounts(config, output);
  assert.equal(truthful, 1);
  assert.equal(falseResult, 1);
  assert.equal(bluff, 1);
});
