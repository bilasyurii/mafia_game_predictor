import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig } from "./types";
import { generateWorlds } from "./generateWorlds";
import { GameSetting, processEvidence } from "./processEvidence";
import { createLikelihoodModel, Evidence } from "./evidence";
import { createHandlers } from "./likelihoodHandlers";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { getProbability } from "./probability";
import { createNightResultHandler } from "./nightResultLikelihood";
import { createUniformActionModel } from "./uniformActionModel";
import { summarizeReplay, summarizeStep, evaluateAgainstGroundTruth, formatReplayStep } from "./replay";

/**
 * Proves the specific property this milestone exists for: a player's death
 * mid-game removes them as a future ACTOR, but never stops inference for
 * everyone else - every later public evidence item from a still-living
 * player keeps updating the posterior exactly as it would if nobody had
 * died. This is not new inference logic (processEvidence/facts.ts already
 * guarantee it - see facts.ts's getAliveStateForEvidence/getHistoryBefore);
 * these tests exist to pin that guarantee down explicitly for the replay
 * use case, and to test replay.ts's own new summarization code.
 */

const game: GameConfig = {
  players: ["1", "2", "3", "4"],
  roles: ["mafia", "citizen", "citizen", "citizen"],
};
const setting: GameSetting = { config: game, roles: defaultRoleRegistry, groups: defaultGroupRegistry };

function model() {
  return createLikelihoodModel(
    createHandlers(
      { truthful: 0.8, false: 0.2 },
      undefined,
      undefined,
      { sameTeam: 0.6, differentTeam: 0.4 },
      undefined,
      undefined,
      { sameTeamVote: 0.6, differentTeamVote: 0.4, abstain: 0.3 }
    ),
    createNightResultHandler(createUniformActionModel(defaultRoleRegistry))
  );
}

test("evidence recorded after a player's death still updates the posterior for every step that follows", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "citizen" } },
    { type: "suspect", round: 1, actor: "3", target: "4" },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["1"], handsRaised: {} },
    // a single candidate with no raised hands: every living voter abstains,
    // and abstention votes go to the only (=last) candidate called - "1" wins
    { type: "dayElimination", round: 1, eliminated: ["1"] },
    { type: "nightResult", round: 2, died: [] },
  ];

  const steps = processEvidence(worlds, log, model(), setting);
  assert.equal(steps.length, 6);

  // every step is a well-formed, changed-or-unchanged-but-VALID distribution
  steps.forEach((s) => {
    const total = s.posterior.reduce((sum, w) => sum + w.probability, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `step ${s.index} total=${total}`);
    assert.ok(s.posterior.every((w) => Number.isFinite(w.probability) && w.probability >= 0));
  });

  // steps AFTER the night-1 death (index 1 onward) genuinely moved the
  // posterior on later evidence - e.g. the selfRoleClaim step (index 1)
  // changed P(1=citizen) from its prior
  const priorP1Citizen = getProbability(worlds, "1", "citizen");
  const afterClaim = getProbability(steps[1].posterior, "1", "citizen");
  assert.notEqual(priorP1Citizen, afterClaim);

  // the LAST step (a second NightResultFact, long after "2" died) still
  // produces a real, distinct update relative to the step before it - the
  // pipeline never silently "stopped" after the death
  const beforeLastNight = steps[4].posterior.map((w) => w.probability);
  const afterLastNight = steps[5].posterior.map((w) => w.probability);
  assert.notDeepEqual(beforeLastNight, afterLastNight);
});

test("a dead player is correctly excluded from `alive` starting the step after their death, not before it", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "citizen" } },
  ];
  const steps = processEvidence(worlds, log, model(), setting);

  // the NightResultFact itself is scored against the alive state BEFORE its
  // own deaths (see facts.ts's getAliveStateForEvidence) - "2" is still
  // listed alive for this step
  const nightView = summarizeStep(steps[0]);
  assert.ok(nightView.alive.includes("2"));

  // the very next step (day round 1) sees "2" as dead
  const claimView = summarizeStep(steps[1]);
  assert.ok(!claimView.alive.includes("2"));
  assert.deepEqual(claimView.alive, ["1", "3", "4"]);
});

test("a dead player can still be the TARGET of a later observation - only acting as the actor is disallowed", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "suspect", round: 1, actor: "3", target: "2" }, // "3" (alive) suspects "2" (dead) - a real, legal public statement
  ];
  const steps = processEvidence(worlds, log, model(), setting);
  assert.equal(steps.length, 2);
  const total = steps[1].posterior.reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("a dead player attempting to be the ACTOR of a new observation is rejected, distinctly from the 'processing continues' guarantee above", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "suspect", round: 1, actor: "2", target: "3" }, // "2" is dead - cannot act
  ];
  assert.throws(() => processEvidence(worlds, log, model(), setting), /dead/);
});

test("summarizeReplay produces one ReplayStepView per evidence item, with rankedByMafia matching mafiaProbability exactly", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [
    { type: "nightResult", round: 1, died: ["2"] },
    { type: "suspect", round: 1, actor: "3", target: "4" },
  ];
  const steps = processEvidence(worlds, log, model(), setting);
  const views = summarizeReplay(steps);

  assert.equal(views.length, 2);
  const last = views[1];
  assert.deepEqual(Object.keys(last.mafiaProbability).sort(), ["1", "3", "4"]);
  assert.equal(last.rankedByMafia.length, 3);
  last.rankedByMafia.forEach(({ player, probability }) => {
    assert.ok(Math.abs(probability - last.mafiaProbability[player]) < 1e-12);
  });
  for (let i = 1; i < last.rankedByMafia.length; i++) {
    assert.ok(last.rankedByMafia[i - 1].probability >= last.rankedByMafia[i].probability);
  }

  // this game's config has no "don" role - donProbability is omitted, not zeroed
  assert.equal(last.donProbability, undefined);

  // formatReplayStep runs without throwing and mentions every living player
  const text = formatReplayStep(last);
  assert.ok(text.includes("1:") && text.includes("3:") && text.includes("4:"));
  assert.ok(!text.includes("2:"));
});

test("summarizeStep omits nothing for the standard 8-player config: donProbability is present and meaningful", () => {
  const standardGame: GameConfig = {
    players: ["1", "2", "3", "4", "5", "6", "7", "8"],
    roles: ["don", "mafia", "doctor", "commissioner", "citizen", "citizen", "citizen", "citizen"],
  };
  const worlds = generateWorlds(standardGame);
  const standardSetting: GameSetting = { config: standardGame, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const log: Evidence[] = [
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "commissioner" } },
  ];
  const steps = processEvidence(
    worlds,
    log,
    createLikelihoodModel(createHandlers({ truthful: 0.8, false: 0.2 })),
    standardSetting
  );
  const view = summarizeStep(steps[0]);
  assert.ok(view.donProbability !== undefined);
  assert.ok(Math.abs(view.donProbability!["2"] - getProbability(steps[0].posterior, "2", "don")) < 1e-12);
});

// ============================================================
// EVALUATION-ONLY ground truth comparison
// ============================================================

test("evaluateAgainstGroundTruth only READS an already-computed posterior and never influences it - partial ground truth is fully supported", () => {
  const worlds = generateWorlds(game);
  const log: Evidence[] = [{ type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "mafia" } }];
  const steps = processEvidence(worlds, log, model(), setting);

  // only "1"'s true role is known post-game; "3" is deliberately omitted
  const evaluation = evaluateAgainstGroundTruth(steps[0].posterior, { roles: { "1": "mafia" } });

  assert.equal(evaluation.length, 1);
  assert.equal(evaluation[0].player, "1");
  assert.equal(evaluation[0].actualRole, "mafia");
  assert.ok(
    Math.abs(evaluation[0].posteriorProbabilityOfActualRole - getProbability(steps[0].posterior, "1", "mafia")) < 1e-12
  );

  // calling it twice with different ground truth never changes the posterior itself
  const before = steps[0].posterior.map((w) => w.probability);
  evaluateAgainstGroundTruth(steps[0].posterior, { roles: { "1": "citizen", "3": "mafia" } });
  const after = steps[0].posterior.map((w) => w.probability);
  assert.deepEqual(before, after);
});
