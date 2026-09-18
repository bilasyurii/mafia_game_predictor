import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { buildFeatureWeightedBehavioralModel } from "./behavioralStrengthCounterfactuals";

/**
 * Tests for the per-feature likelihood-power counterfactual machinery only -
 * never production behavior. Proves against real processEvidence()/
 * updateProbabilities() output, not a reimplementation.
 */

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 },
];

test("suspect weight=1 reproduces the untempered model exactly", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 1 });
  const history: Evidence[] = [{ type: "suspect", round: 0, actor: "2", target: "3" }];
  const realSteps = processEvidence(worlds, history, real, setting);
  const weightedSteps = processEvidence(worlds, history, weighted, setting);
  realSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, weightedSteps[0].posterior[i].probability));
});

test("suspect weight=0 makes suspect evidence exactly neutral (posterior stays at the prior)", () => {
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 0 });
  const history: Evidence[] = [{ type: "suspect", round: 0, actor: "2", target: "3" }];
  const steps = processEvidence(worlds, history, weighted, setting);
  steps[0].posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));
});

test("mechanical evidence (nightResult) is completely unaffected by any feature weight, including weight=0", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 0, candidateVote: 0.25 });
  const history: Evidence[] = [{ type: "nightResult", round: 1, died: ["1"] }];
  const realSteps = processEvidence(worlds, history, real, setting);
  const weightedSteps = processEvidence(worlds, history, weighted, setting);
  realSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, weightedSteps[0].posterior[i].probability));
});

test("feature-specific weighting affects ONLY the selected feature - a same-history defend observation is untouched when only suspect is weighted", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 0 });
  const history: Evidence[] = [{ type: "defend", round: 0, actor: "2", target: "3" }];
  const realSteps = processEvidence(worlds, history, real, setting);
  const weightedSteps = processEvidence(worlds, history, weighted, setting);
  realSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, weightedSteps[0].posterior[i].probability));
});

test("an intermediate weight (0.5) raises the likelihood RATIO to exactly that power, and posteriors stay normalized (sum to 1)", () => {
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 0.5 });
  const history: Evidence[] = [{ type: "suspect", round: 0, actor: "2", target: "3" }];
  const steps = processEvidence(worlds, history, weighted, setting);
  const total = steps[0].posterior.reduce((s, w) => s + w.probability, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);

  // cross-check the exact tempered ratio against a hand-computed value
  const ratioParams = syntheticBehavioralModelParams.suspect;
  // world 0: actor "2" is town (citizen), target "3" is town -> ownTeam bucket
  // world 1: actor "2" is mafia, target "3" is town -> otherTeam bucket
  const rawTown = ratioParams.town!.ownTeam; // actor town, target town -> ownTeam
  const rawMafia = ratioParams.mafia!.otherTeam; // actor mafia, target town -> otherTeam
  const temperedTown = rawTown ** 0.5;
  const temperedMafia = rawMafia ** 0.5;
  const expectedWorld0 = (0.5 * temperedTown) / (0.5 * temperedTown + 0.5 * temperedMafia);
  assert.ok(Math.abs(steps[0].posterior[0].probability - expectedWorld0) < 1e-9);
});

test("weighting two features together (suspect and candidateVote) leaves a third feature (defend)'s own raw likelihood function byte-identical, even after a weighted event precedes it in history", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const weighted = buildFeatureWeightedBehavioralModel(syntheticBehavioralModelParams, { suspect: 0, candidateVote: 0 });
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" }, // neutralized
    { type: "defend", round: 1, actor: "2", target: "3" }, // must still be scored identically by both models
  ];
  const weightedSteps = processEvidence(worlds, history, weighted, setting);
  // step 0 (suspect): weighted stays at the prior, proving suspect really was neutralized here
  weightedSteps[0].posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));

  // Compare the defend OBSERVATION HANDLER's raw output directly (not the
  // renormalized posterior, which legitimately differs between branches
  // since it started from a different step-0 prior) - the defend event
  // itself, in the exact EvidenceContext step 1 actually used, must score
  // identically under both models.
  const ctxAtDefendStep = weightedSteps[1].context;
  worlds.forEach((w) => {
    const realValue = real.likelihood(history[1], w, ctxAtDefendStep);
    const weightedValue = weighted.likelihood(history[1], w, ctxAtDefendStep);
    assert.equal(realValue, weightedValue);
  });
});
