import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { createBehavioralLikelihoodModel, defaultBehavioralModelParams } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { mafiaVsTownLikelihoodRatio } from "./behavioralLikelihoodDiagnostics";

/**
 * Focused mathematical tests for the behavioralEvidenceWeight tempering
 * transform (createLikelihoodModel/createBehavioralLikelihoodModel's new
 * third parameter) - proven against the REAL production Bayesian update
 * (updateProbabilities.ts/processEvidence.ts), not a reimplementation. Does
 * not modify defaultBehavioralModelParams or syntheticBehavioralModelParams.
 */

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const equalPriorWorlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 },
];

function finalPosterior(weight: number, history: Evidence[], worlds: World[] = equalPriorWorlds) {
  const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, weight);
  const steps = processEvidence(worlds, history, model, setting);
  return steps[steps.length - 1].posterior;
}

function ratioFor(posterior: World[]): number {
  const pMafia = posterior.find((w) => w.roles["1"] === "mafia")!.probability;
  const pTown = posterior.find((w) => w.roles["1"] === "citizen")!.probability;
  return pMafia / pTown;
}

const oneSuspect: Evidence[] = [{ type: "suspect", round: 0, actor: "1", target: "3" }];

test("1. weight=1 reproduces the untempered posterior exactly", () => {
  const untempered = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const tempered = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, 1);
  const stepsA = processEvidence(equalPriorWorlds, oneSuspect, untempered, setting);
  const stepsB = processEvidence(equalPriorWorlds, oneSuspect, tempered, setting);
  stepsA[0].posterior.forEach((w, i) => assert.equal(w.probability, stepsB[0].posterior[i].probability));
});

test("2. weight=0 makes behavioral evidence fully uninformative: posterior stays exactly at the prior, for any behavioral evidence type", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "selfRoleClaim", round: 0, actor: "2", claim: { kind: "role", role: "mafia" } },
    { type: "nominate", round: 1, actor: "3", target: "1" },
  ];
  const posterior = finalPosterior(0, history);
  posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));
});

test("3. an intermediate weight raises the likelihood RATIO to exactly that power: ratio(weight) == ratio(1)^weight", () => {
  const { ratio: fullRatio } = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.suspect, "town");
  [0.75, 0.5, 0.25].forEach((weight) => {
    const posterior = finalPosterior(weight, oneSuspect);
    const observedRatio = ratioFor(posterior);
    const expectedRatio = fullRatio ** weight;
    assert.ok(
      Math.abs(observedRatio - expectedRatio) < 1e-9,
      `weight=${weight}: expected ratio ${expectedRatio}, got ${observedRatio}`
    );
  });
});

test("4. mechanical evidence (nightResult, dayElimination) is completely unaffected by behavioralEvidenceWeight", () => {
  const fivePlayerConfig: GameConfig = {
    players: ["1", "2", "3", "4", "5"],
    roles: ["don", "mafia", "commissioner", "doctor", "citizen"],
  };
  const fivePlayerSetting: GameSetting = { config: fivePlayerConfig, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const worlds: World[] = [
    { roles: { "1": "don", "2": "mafia", "3": "commissioner", "4": "doctor", "5": "citizen" }, probability: 0.5 },
    { roles: { "1": "mafia", "2": "don", "3": "commissioner", "4": "doctor", "5": "citizen" }, probability: 0.5 },
  ];
  const history: Evidence[] = [
    { type: "nightResult", round: 1, died: ["5"] },
    { type: "suspect", round: 1, actor: "1", target: "2" },
    { type: "candidateVote", round: 1, stage: "initial", candidates: ["2"], handsRaised: { "2": ["1", "3", "4"] } },
    { type: "dayElimination", round: 1, eliminated: ["2"] },
  ];

  const weight1 = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, 1);
  const weight0 = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, 0);

  const steps1 = processEvidence(worlds, history, weight1, fivePlayerSetting);
  const steps0 = processEvidence(worlds, history, weight0, fivePlayerSetting);

  // nightResult (index 0) and dayElimination (index 3) must score IDENTICALLY
  // regardless of behavioralEvidenceWeight - only the suspect/vote steps (1,2) may differ.
  [0, 3].forEach((i) => {
    worlds.forEach((_, w) => {
      assert.equal(steps1[i].posterior[w].probability, steps0[i].posterior[w].probability);
    });
  });
});

test("5. N independent suspect observations at weight w compound to ratio(1)^(N*w)", () => {
  const { ratio: perObservationRatio } = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.suspect, "town");
  const fivePlayerConfig: GameConfig = { players: ["1", "2", "3", "4", "5"], roles: ["mafia", "citizen", "citizen", "citizen", "citizen"] };
  const fivePlayerSetting: GameSetting = { config: fivePlayerConfig, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const worlds: World[] = [
    { roles: { "1": "mafia", "2": "citizen", "3": "citizen", "4": "citizen", "5": "citizen" }, probability: 0.5 },
    { roles: { "1": "citizen", "2": "mafia", "3": "citizen", "4": "citizen", "5": "citizen" }, probability: 0.5 },
  ];
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "suspect", round: 0, actor: "1", target: "4" },
    { type: "suspect", round: 0, actor: "1", target: "5" },
  ];

  [1, 0.5, 0.25].forEach((weight) => {
    const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams, undefined, weight);
    const steps = processEvidence(worlds, history, model, fivePlayerSetting);
    const finalPost = steps[steps.length - 1].posterior;
    const observedRatio = finalPost.find((w) => w.roles["1"] === "mafia")!.probability / finalPost.find((w) => w.roles["1"] === "citizen")!.probability;
    const expectedRatio = perObservationRatio ** (3 * weight);
    assert.ok(
      Math.abs(observedRatio - expectedRatio) < 1e-6,
      `weight=${weight}: expected ${expectedRatio}, got ${observedRatio}`
    );
  });
});

test("6. weight=1 with defaultBehavioralModelParams still matches the pre-existing, un-tempered API's output (backward compatibility)", () => {
  const legacyModel = createBehavioralLikelihoodModel(defaultBehavioralModelParams);
  const explicitWeight1Model = createBehavioralLikelihoodModel(defaultBehavioralModelParams, undefined, 1);
  const history: Evidence[] = [
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "mafia" } },
    { type: "suspect", round: 0, actor: "2", target: "3" },
  ];
  const stepsA = processEvidence(equalPriorWorlds, history, legacyModel, setting);
  const stepsB = processEvidence(equalPriorWorlds, history, explicitWeight1Model, setting);
  stepsA.forEach((step, i) => {
    step.posterior.forEach((w, j) => assert.equal(w.probability, stepsB[i].posterior[j].probability));
  });
});
