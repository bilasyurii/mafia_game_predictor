import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { createLikelihoodModel, Evidence } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GroundTruthRoles, GroundTruthTeams } from "./replay";
import { brierScore, logLoss, evaluateGame, summarizeGameEvaluation } from "./gameEvaluation";

/**
 * Small, hand-derivable synthetic scenarios - this is an evaluation-metrics
 * layer, not new inference, so the properties worth testing are the metric
 * FORMULAS (Brier/log-loss, exact numbers checked against the real code),
 * the aggregation logic (threshold crossings, top-3 entry, overconfidence,
 * largest single change, final ranking), and that nothing here mutates or
 * feeds ground truth back into a posterior. Not re-testing processEvidence/
 * updateProbabilities itself - see updateProbabilities.test.ts etc.
 */

test("brierScore and logLoss: exact values, and safe clamping at probability 0/1", () => {
  assert.ok(Math.abs(brierScore(0.3, true) - 0.49) < 1e-12); // (0.3-1)^2
  assert.ok(Math.abs(brierScore(0.3, false) - 0.09) < 1e-12); // (0.3-0)^2
  assert.equal(brierScore(1, true), 0); // perfect forecast, y=1
  assert.equal(brierScore(0, false), 0); // perfect forecast, y=0

  assert.ok(Math.abs(logLoss(0.5, true) - Math.log(2)) < 1e-9);
  // an exact 0 or 1 forecast against the WRONG outcome must stay finite (never -Infinity/NaN)
  assert.ok(Number.isFinite(logLoss(1, false)));
  assert.ok(Number.isFinite(logLoss(0, true)));
  assert.ok(logLoss(1, false) > 15); // still a very large penalty, just not infinite
  assert.ok(logLoss(0, true) > 15);
  // a correct extreme forecast is still (near) zero cost
  assert.ok(logLoss(1, true) < 1e-6);
  assert.ok(logLoss(0, false) < 1e-6);
});

const threePlayerGame: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const threePlayerSetting: GameSetting = {
  config: threePlayerGame,
  roles: defaultRoleRegistry,
  groups: defaultGroupRegistry,
};
const threePlayerGroundTruth: GroundTruthRoles = {
  roles: { "1": "mafia", "2": "citizen", "3": "citizen" },
};
const threePlayerGroundTruthTeams: GroundTruthTeams = {
  isMafia: { "1": true, "2": false, "3": false },
};

test("evaluateStep: exact Mafia-probability trace, rank, largest-change, and per-step Brier/log-loss for a single hand-derivable step", () => {
  const worlds = generateWorlds(threePlayerGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 1, differentTeam: 3 })
  );
  const log: Evidence[] = [{ type: "suspect", round: 1, actor: "2", target: "1" }];
  const steps = processEvidence(worlds, log, model, threePlayerSetting);
  const [step] = evaluateGame(steps, threePlayerGroundTruth, threePlayerGroundTruthTeams);

  // hand-derived: 2 suspects 1, differentTeam=3x more likely than sameTeam;
  // "1"/"2" different-team in 2 of 3 worlds (mafia=1 or mafia=2), each
  // getting factor 3; "3" uninvolved gets factor 1 in the one world where
  // mafia=3 - posterior odds (3,3,1)/7
  assert.ok(Math.abs(step.mafiaProbability["1"] - 3 / 7) < 1e-9);
  assert.ok(Math.abs(step.mafiaProbability["2"] - 3 / 7) < 1e-9);
  assert.ok(Math.abs(step.mafiaProbability["3"] - 1 / 7) < 1e-9);

  // "1" is the only known-Mafia player; it's tied for 1st (stable sort keeps
  // the earlier-declared player "1" ahead of "2" at an exact tie)
  assert.equal(step.rankOfActualMafia.length, 1);
  assert.equal(step.rankOfActualMafia[0].player, "1");
  assert.equal(step.rankOfActualMafia[0].rank, 1);

  // largest change: the UNINVOLVED player "3" actually moves the most (down,
  // from the flat 1/3 prior to 1/7) - a real, counter-intuitive but correct
  // Bayesian effect, not a bug in the ranking
  assert.equal(step.largestChanges[0].player, "3");
  assert.ok(Math.abs(step.largestChanges[0].delta - (1 / 7 - 1 / 3)) < 1e-9);
  assert.ok(Math.abs(step.largestChanges[0].delta) > Math.abs(step.largestChanges[1].delta));

  assert.ok(Math.abs(step.stepBrierScore - 26 / 147) < 1e-9);
  assert.ok(Math.abs(step.stepLogLoss - 0.5203547760499615) < 1e-9);
});

test("summarizeGameEvaluation: average/final Brier and log-loss, and threshold crossings, over a 2-step trajectory", () => {
  const worlds = generateWorlds(threePlayerGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.1, false: 0.9 }, undefined, undefined, { sameTeam: 1, differentTeam: 3 })
  );
  const log: Evidence[] = [
    { type: "suspect", round: 1, actor: "2", target: "1" },
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "citizen" } },
  ];
  const steps = processEvidence(worlds, log, model, threePlayerSetting);
  const perStep = evaluateGame(steps, threePlayerGroundTruth, threePlayerGroundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, threePlayerGroundTruth, threePlayerGroundTruthTeams);

  // step0: {3/7, 3/7, 1/7}; step1 (a strongly "lying" self-claim of
  // citizen pushes "1", the actual Mafia, up further): {27/31, 3/31, 1/31}
  assert.ok(Math.abs(perStep[1].mafiaProbability["1"] - 27 / 31) < 1e-6);

  assert.ok(Math.abs(summary.averageBrierScore - 0.09294456596374241) < 1e-6);
  assert.ok(Math.abs(summary.averageLogLoss - 0.3056311972939391) < 1e-6);
  assert.ok(Math.abs(summary.finalBrierScore - 0.009018383628165106) < 1e-6);
  assert.ok(Math.abs(summary.finalLogLoss - 0.09090761853791678) < 1e-6);

  // "1" crosses 25% at step 0 (already 3/7≈0.43), and both 50%/75% only at
  // step 1 (0.43 < 0.5, so neither crossed yet at step 0)
  assert.deepEqual(summary.thresholdCrossings["1"], { above25: 0, above50: 1, above75: 1 });

  // with only 3 total players, "top 3" is trivially everyone - "1" is
  // already "in the top 3" from step 0
  assert.equal(summary.firstEnteredTop3["1"], 0);

  // finalRanking is sorted descending and includes every player, with
  // ground-truth annotations attached
  assert.equal(summary.finalRanking[0].player, "1");
  assert.equal(summary.finalRanking[0].isMafia, true);
  assert.equal(summary.finalRanking[0].actualRole, "mafia");
  for (let i = 1; i < summary.finalRanking.length; i++) {
    assert.ok(summary.finalRanking[i - 1].probability >= summary.finalRanking[i].probability);
  }
});

test("summarizeGameEvaluation: mostOverconfidentInnocent and largestSingleChange are self-consistent with the per-step data (no hidden extra logic)", () => {
  const players = ["1", "2", "3", "4", "5"];
  const game: GameConfig = { players, roles: ["mafia", "citizen", "citizen", "citizen", "citizen"] };
  const worlds = generateWorlds(game);
  const setting: GameSetting = { config: game, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 0.2, differentTeam: 0.8 })
  );
  const log: Evidence[] = [
    { type: "suspect", round: 1, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "4", target: "5" },
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "citizen" } },
  ];
  const steps = processEvidence(worlds, log, model, setting);
  const groundTruth: GroundTruthRoles = { roles: { "1": "mafia" } };
  const groundTruthTeams: GroundTruthTeams = {
    isMafia: { "1": true, "2": false, "3": false, "4": false, "5": false },
  };
  const perStep = evaluateGame(steps, groundTruth, groundTruthTeams);
  const summary = summarizeGameEvaluation(perStep, groundTruth, groundTruthTeams);

  // mostOverconfidentInnocent is exactly the max over every known-innocent
  // player's probability across every step - recompute independently here
  let expectedMax = -Infinity;
  ["2", "3", "4", "5"].forEach((p) => {
    perStep.forEach((s) => {
      expectedMax = Math.max(expectedMax, s.mafiaProbability[p]);
    });
  });
  assert.ok(summary.mostOverconfidentInnocent !== undefined);
  assert.ok(Math.abs(summary.mostOverconfidentInnocent!.probability - expectedMax) < 1e-9);

  // largestSingleChange is exactly the max |delta| across every step's own
  // top largestChanges entry
  const expectedLargest = Math.max(...perStep.map((s) => Math.abs(s.largestChanges[0].delta)));
  assert.ok(summary.largestSingleChange !== undefined);
  assert.ok(Math.abs(Math.abs(summary.largestSingleChange!.delta) - expectedLargest) < 1e-9);

  // finalRanking covers all 5 players exactly once
  assert.equal(summary.finalRanking.length, 5);
  assert.deepEqual(new Set(summary.finalRanking.map((r) => r.player)), new Set(players));
});

test("evaluation never mutates the posterior it reads, regardless of what ground truth is supplied", () => {
  const worlds = generateWorlds(threePlayerGame);
  const model = createLikelihoodModel(
    createHandlers({ truthful: 0.9, false: 0.1 }, undefined, undefined, { sameTeam: 1, differentTeam: 3 })
  );
  const log: Evidence[] = [{ type: "suspect", round: 1, actor: "2", target: "1" }];
  const steps = processEvidence(worlds, log, model, threePlayerSetting);
  const before = steps[0].posterior.map((w) => w.probability);

  evaluateGame(steps, threePlayerGroundTruth, threePlayerGroundTruthTeams);
  evaluateGame(steps, { roles: { "3": "mafia" } }, { isMafia: { "1": false, "2": false, "3": true } });

  const after = steps[0].posterior.map((w) => w.probability);
  assert.deepEqual(before, after);
});
