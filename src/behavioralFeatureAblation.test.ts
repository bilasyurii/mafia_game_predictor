import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { createBehavioralLikelihoodModel } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  ALL_BEHAVIORAL_EVIDENCE_TYPES,
  buildAblatedBehavioralModel,
  investigationReportLikelihoodRatios,
  roleClaimLikelihoodRatios,
} from "./behavioralLikelihoodDiagnostics";

/**
 * Tests for the feature-ablation diagnostic machinery only - never
 * production behavior. Proves against real processEvidence()/
 * updateProbabilities() output, not a reimplementation.
 */

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 },
];

test("FULL ablation (all 8 types enabled) reproduces createBehavioralLikelihoodModel exactly", () => {
  const history: Evidence[] = [
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "mafia" } },
    { type: "suspect", round: 0, actor: "2", target: "3" },
  ];
  const fullModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const ablatedFull = buildAblatedBehavioralModel(syntheticBehavioralModelParams, new Set(ALL_BEHAVIORAL_EVIDENCE_TYPES));

  const stepsA = processEvidence(worlds, history, fullModel, setting);
  const stepsB = processEvidence(worlds, history, ablatedFull, setting);
  stepsA.forEach((s, i) => s.posterior.forEach((w, j) => assert.equal(w.probability, stepsB[i].posterior[j].probability)));
});

test("NONE ablation (empty set) leaves the posterior exactly at the prior for behavioral evidence, and scores mechanical evidence (nightResult) identically to the full model", () => {
  const noneModel = buildAblatedBehavioralModel(syntheticBehavioralModelParams, new Set());

  const behavioralOnly: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "mafia" } },
  ];
  const behavioralSteps = processEvidence(worlds, behavioralOnly, noneModel, setting);
  behavioralSteps[behavioralSteps.length - 1].posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));

  // Mechanical evidence must be scored IDENTICALLY whether behavioral
  // evidence is ablated or not - compare the NONE-ablation model directly
  // against the full (non-ablated) model on the same nightResult.
  const fullModel = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const withNightResult: Evidence[] = [{ type: "nightResult", round: 1, died: ["1"] }];
  const noneSteps = processEvidence(worlds, withNightResult, noneModel, setting);
  const fullSteps = processEvidence(worlds, withNightResult, fullModel, setting);
  noneSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, fullSteps[0].posterior[i].probability));
});

test("ONLY suspect (single-feature ablation): a suspect observation moves the posterior, a selfRoleClaim in the same history does not", () => {
  const onlySuspect = buildAblatedBehavioralModel(syntheticBehavioralModelParams, new Set(["suspect"]));
  const history: Evidence[] = [
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "mafia" } }, // ablated -> no effect
    { type: "suspect", round: 1, actor: "2", target: "3" }, // enabled -> real effect
  ];
  const steps = processEvidence(worlds, history, onlySuspect, setting);
  // after step 0 (ablated selfRoleClaim), posterior must be unchanged from the 0.5/0.5 prior
  steps[0].posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));
  // after step 1 (enabled suspect), posterior must have moved
  const moved = steps[1].posterior.some((w) => Math.abs(w.probability - 0.5) > 1e-6);
  assert.ok(moved);
});

test("roleClaimLikelihoodRatios / investigationReportLikelihoodRatios: correct ratios for known parameter values", () => {
  const rc = roleClaimLikelihoodRatios({ truthful: 0.6, falseSameTeam: 0.2, falseDifferentTeam: 0.3 });
  assert.ok(Math.abs(rc.truthfulVsFalseSameTeam - 3) < 1e-12);
  assert.ok(Math.abs(rc.truthfulVsFalseDifferentTeam - 2) < 1e-12);

  const ir = investigationReportLikelihoodRatios({ truthful: 0.8, falseResult: 0.1, bluff: 0.2 });
  assert.ok(Math.abs(ir.truthfulVsFalseResult - 8) < 1e-12);
  assert.ok(Math.abs(ir.truthfulVsBluff - 4) < 1e-12);
});
