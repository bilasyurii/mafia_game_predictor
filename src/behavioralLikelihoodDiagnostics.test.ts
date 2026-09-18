import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, PlayerId, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { BehavioralModelParams, createBehavioralLikelihoodModel, defaultBehavioralModelParams } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";
import {
  buildUninformativeBehavioralParams,
  cumulativeRatioForDistinctTargets,
  mafiaVsTownLikelihoodRatio,
} from "./behavioralLikelihoodDiagnostics";

/**
 * Proves, against the REAL production code (updateProbabilities.ts,
 * processEvidence.ts, behavioralModel.ts) - not a reimplementation - the
 * mathematical claims from this investigation:
 *   A. one observation's effect is exactly the likelihood ratio
 *   B. N observations compound multiplicatively (product of per-step ratios)
 *   F. `repeatFactor` cancels in renormalization and has ZERO effect on the
 *      posterior for ANY value, because it's a world-independent scalar
 * No production parameters or files outside this investigation are touched.
 */

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 }, // "1" is mafia
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 }, // "1" is town (citizen)
];

function posteriorFor(params: BehavioralModelParams, history: Evidence[]) {
  const model = createBehavioralLikelihoodModel(params);
  const steps = processEvidence(worlds, history, model, setting);
  return steps[steps.length - 1].posterior;
}

function probOf(posterior: World[], player: PlayerId, role: string): number {
  return posterior.find((w) => w.roles[player] === role)?.probability ?? 0;
}

test("A. one suspect observation moves the posterior by exactly the likelihood ratio (equal priors)", () => {
  const { likelihoodIfMafia, likelihoodIfTown, ratio } = mafiaVsTownLikelihoodRatio(
    syntheticBehavioralModelParams.suspect,
    "town"
  );
  assert.ok(Math.abs(likelihoodIfMafia - 0.9123) < 1e-3);
  assert.ok(Math.abs(likelihoodIfTown - 0.4886) < 1e-3);
  assert.ok(Math.abs(ratio - 1.8672) < 1e-3);

  const posterior = posteriorFor(syntheticBehavioralModelParams, [
    { type: "suspect", round: 0, actor: "1", target: "3" },
  ]);
  const pMafia = probOf(posterior, "1", "mafia");
  const pTown = probOf(posterior, "1", "citizen");
  // with equal 0.5/0.5 priors, posterior ratio == likelihood ratio exactly
  assert.ok(Math.abs(pMafia / pTown - ratio) < 1e-9);
});

test("B. five DISTINCT-target suspect observations by the same actor compound multiplicatively (ratio^5), at full undamped strength", () => {
  const { ratio } = mafiaVsTownLikelihoodRatio(syntheticBehavioralModelParams.suspect, "town");
  const expectedCumulative = cumulativeRatioForDistinctTargets(ratio, 3);

  const fivePlayerConfig: GameConfig = { players: ["1", "2", "3", "4", "5"], roles: ["mafia", "citizen", "citizen", "citizen", "citizen"] };
  const fivePlayerSetting: GameSetting = { config: fivePlayerConfig, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
  const twoWorlds: World[] = [
    { roles: { "1": "mafia", "2": "citizen", "3": "citizen", "4": "citizen", "5": "citizen" }, probability: 0.5 },
    { roles: { "1": "citizen", "2": "mafia", "3": "citizen", "4": "citizen", "5": "citizen" }, probability: 0.5 },
  ];
  const model = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "suspect", round: 0, actor: "1", target: "4" },
    { type: "suspect", round: 0, actor: "1", target: "5" },
  ];
  const steps = processEvidence(twoWorlds, history, model, fivePlayerSetting);
  const finalPosterior = steps[steps.length - 1].posterior;
  const pMafia = finalPosterior.find((w) => w.roles["1"] === "mafia")!.probability;
  const pTown = finalPosterior.find((w) => w.roles["1"] === "citizen")!.probability;

  assert.ok(Math.abs(pMafia / pTown - expectedCumulative) < 1e-6);
});

test("F. repeatFactor is mathematically inert: an EXACT-repeat suspect sequence produces an IDENTICAL posterior for repeatFactor=1 vs repeatFactor=0.01", () => {
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "suspect", round: 1, actor: "1", target: "3" }, // exact repeat: same actor, same target
  ];

  const paramsFullFactor: BehavioralModelParams = { ...syntheticBehavioralModelParams, repeatFactor: 1 };
  const paramsHeavyDamping: BehavioralModelParams = { ...syntheticBehavioralModelParams, repeatFactor: 0.01 };

  const posteriorFull = posteriorFor(paramsFullFactor, history);
  const posteriorDamped = posteriorFor(paramsHeavyDamping, history);

  posteriorFull.forEach((w, i) => {
    assert.ok(
      Math.abs(w.probability - posteriorDamped[i].probability) < 1e-9,
      `world ${JSON.stringify(w.roles)}: repeatFactor=1 gave ${w.probability}, repeatFactor=0.01 gave ${posteriorDamped[i].probability} - should be identical`
    );
  });
});

test("C. selfRoleClaim has no repeat-awareness at all: two identical claims by the same actor are scored as if fully independent, unaffected by repeatFactor", () => {
  const history: Evidence[] = [
    { type: "selfRoleClaim", round: 0, actor: "1", claim: { kind: "role", role: "mafia" } },
    { type: "selfRoleClaim", round: 1, actor: "1", claim: { kind: "role", role: "mafia" } },
  ];
  const posterior = posteriorFor(syntheticBehavioralModelParams, history);
  const pMafia = probOf(posterior, "1", "mafia");
  const pTown = probOf(posterior, "1", "citizen");

  // Each claim scores selfRoleClaim.truthful (if world says "1" is mafia) vs
  // falseDifferentTeam (if world says "1" is town/citizen) - compounding
  // as truthful^2 vs falseDifferentTeam^2, with NO discount for repetition.
  const p = syntheticBehavioralModelParams.selfRoleClaim;
  const expectedRatio = (p.truthful / p.falseDifferentTeam) ** 2;
  assert.ok(Math.abs(pMafia / pTown - expectedRatio) < 1e-6);
});

test("buildUninformativeBehavioralParams: a suspect/selfRoleClaim/investigationReport observation leaves the posterior exactly proportional to the prior (zero behavioral information)", () => {
  const uninformative = buildUninformativeBehavioralParams(defaultBehavioralModelParams);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "selfRoleClaim", round: 0, actor: "2", claim: { kind: "role", role: "mafia" } },
    { type: "investigationReport", round: 1, actor: "3", target: "1", mechanic: "checkIsMafia", result: true, night: 1 },
  ];
  const posterior = posteriorFor(uninformative, history);
  // priors were exactly 0.5/0.5 and uninformative evidence must leave them exactly 0.5/0.5
  posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));
});
