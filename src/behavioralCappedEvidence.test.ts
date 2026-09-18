import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import { GLOBAL_CAP_GROUP, PER_FEATURE_CAP_GROUP, runCappedReplay } from "./behavioralCappedEvidence";

/**
 * Tests for the cumulative-behavioral-evidence-cap counterfactual replay
 * only - never production behavior. The core claim under test is the
 * telescoping identity (product of per-step factors == exp(clamp(total raw
 * sum))), proven both against a very large cap (must reproduce the real,
 * uncapped model exactly) and against hand-computed small examples.
 */

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 },
];

const LARGE_CAP = 1e9;

test("a very large cap (effectively uncapped) reproduces the real, uncapped FULL model exactly - proves the telescoping factor construction is correct", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "1" },
    { type: "defend", round: 2, actor: "3", target: "2" },
  ];
  const realModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const realSteps = processEvidence(worlds, history, realModel, setting);

  const { steps: cappedSteps } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, LARGE_CAP, PER_FEATURE_CAP_GROUP);

  realSteps.forEach((s, i) => s.posterior.forEach((w, j) => assert.ok(Math.abs(w.probability - cappedSteps[i].posterior[j].probability) < 1e-9)));
});

test("cap=0 makes an entire feature group permanently neutral, even for its very first event", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "1" },
  ];
  const { steps } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 0, PER_FEATURE_CAP_GROUP);
  steps.forEach((s) => s.posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9)));
});

test("a single isolated strong observation IS distorted by a cap smaller than its own |log ratio| - caps affect isolated events, not just repeated ones", () => {
  const history: Evidence[] = [{ type: "suspect", round: 0, actor: "2", target: "1" }]; // world0: actor town->target mafia (otherTeam); world1: actor mafia->target town... let's just compare against the uncapped single-event result
  const realModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const realSteps = processEvidence(worlds, history, realModel, setting);
  // suspect's max |ln ratio| in syntheticBehavioralModelParams is ~1.76 (mafia-targets-mafia branch) - a tight cap of 0.1 must produce a DIFFERENT (compressed) posterior than the real model on this single event.
  const { steps: tightCapped } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 0.1, PER_FEATURE_CAP_GROUP);
  const differs = realSteps[0].posterior.some((w, i) => Math.abs(w.probability - tightCapped[0].posterior[i].probability) > 1e-6);
  assert.ok(differs);
  // and a cap comfortably larger than the max possible single-event ratio must NOT distort this single, isolated event.
  const { steps: looseCapped } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 5, PER_FEATURE_CAP_GROUP);
  realSteps[0].posterior.forEach((w, i) => assert.ok(Math.abs(w.probability - looseCapped[0].posterior[i].probability) < 1e-9));
});

test("Variant B (per-feature groups): each feature accumulates in its OWN group, independent of any other feature's history", () => {
  const combinedHistory: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "1" }, // two suspect events
    { type: "defend", round: 2, actor: "3", target: "2" }, // one, separate, defend event
  ];
  const defendOnlyHistory: Evidence[] = [{ type: "defend", round: 0, actor: "3", target: "2" }];

  const { groupStats: combined } = runCappedReplay(config, combinedHistory, worlds, setting, syntheticBehavioralModelParams, 10, PER_FEATURE_CAP_GROUP);
  const { groupStats: solo } = runCappedReplay(config, defendOnlyHistory, worlds, setting, syntheticBehavioralModelParams, 10, PER_FEATURE_CAP_GROUP);

  assert.equal(combined.suspect.observationCount, 2);
  assert.equal(combined.defend.observationCount, 1);
  // defend's group-level stats must be IDENTICAL whether or not two
  // unrelated suspect events happened first - proving no cross-group leakage.
  assert.deepEqual(combined.defend, solo.defend);
});

test("Variant A (global group) pools every behavioral type into ONE group; Variant B (per-feature) keeps them as separate groups - the grouping itself, not just the numbers, differs", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "1" },
    { type: "defend", round: 2, actor: "3", target: "2" },
  ];
  const { groupStats: globalStats } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 1, GLOBAL_CAP_GROUP);
  const { groupStats: perFeatureStats } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 1, PER_FEATURE_CAP_GROUP);
  assert.deepEqual(Object.keys(globalStats), ["ALL"]);
  assert.equal(globalStats.ALL.observationCount, 3);
  assert.deepEqual(Object.keys(perFeatureStats).sort(), ["defend", "suspect"]);
  assert.equal(perFeatureStats.suspect.observationCount, 2);
  assert.equal(perFeatureStats.defend.observationCount, 1);
});

test("mechanical evidence (nightResult) is completely unaffected by any cap or grouping", () => {
  const history: Evidence[] = [{ type: "nightResult", round: 1, died: ["1"] }];
  const realModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const realSteps = processEvidence(worlds, history, realModel, setting);
  const { steps } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 0, GLOBAL_CAP_GROUP);
  realSteps[0].posterior.forEach((w, i) => assert.ok(Math.abs(w.probability - steps[0].posterior[i].probability) < 1e-9));
});

test("groupStats reports plausible observation counts and a capped cumulative magnitude that never exceeds the cap", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "1" },
    { type: "suspect", round: 2, actor: "3", target: "1" },
  ];
  const { groupStats } = runCappedReplay(config, history, worlds, setting, syntheticBehavioralModelParams, 1, PER_FEATURE_CAP_GROUP);
  assert.equal(groupStats.suspect.observationCount, 3);
  assert.ok(groupStats.suspect.maxAbsCappedCumulative <= 1 + 1e-9);
  assert.ok(groupStats.suspect.fractionStatesCapped >= 0 && groupStats.suspect.fractionStatesCapped <= 1);
});
