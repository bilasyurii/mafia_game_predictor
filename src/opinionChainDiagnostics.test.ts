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
  buildCollapsedChainModel,
  computeClusterStats,
  extractTargetedActs,
  groupIntoChains,
} from "./opinionChainDiagnostics";

/**
 * Tests for the opinion-chain diagnostic machinery only (sequence
 * extraction, chain classification, clustering stats, and the collapsed-
 * chain counterfactual model) - never production behavior. The collapsed
 * model is proven against real processEvidence()/updateProbabilities()
 * output, not a reimplementation.
 */

// ---- extractTargetedActs / groupIntoChains / classification ----

test("extractTargetedActs: suspect/nominate map directly; candidateVote expands into one 'vote' act per hand-raiser, abstainers excluded", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "3" },
    { type: "nominate", round: 0, actor: "2", target: "3" },
    {
      type: "candidateVote",
      round: 0,
      stage: "initial",
      candidates: ["3"],
      handsRaised: { "3": ["1", "2"] }, // "4" implicitly abstains
    },
  ];
  const acts = extractTargetedActs(evidence);
  assert.deepEqual(acts, [
    { step: 0, type: "suspect", actor: "1", target: "3" },
    { step: 1, type: "nominate", actor: "2", target: "3" },
    { step: 2, type: "vote", actor: "1", target: "3" },
    { step: 2, type: "vote", actor: "2", target: "3" },
  ]);
});

test("groupIntoChains: SUSPECT(X)->NOMINATE(X)->VOTE(X) by the SAME actor forms one D_suspectNominateVote chain", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" },
    { type: "nominate", round: 0, actor: "1", target: "5" },
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["5"], handsRaised: { "5": ["1"] } },
  ];
  const chains = groupIntoChains(extractTargetedActs(evidence));
  assert.equal(chains.length, 1);
  assert.equal(chains[0].actor, "1");
  assert.equal(chains[0].target, "5");
  assert.equal(chains[0].category, "D_suspectNominateVote");
  assert.equal(chains[0].hasRepeatedType, false);
});

test("groupIntoChains: SUSPECT(X)->SUSPECT(Y) by the same actor are TWO SEPARATE chains, not merged", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" },
    { type: "suspect", round: 1, actor: "1", target: "6" },
  ];
  const chains = groupIntoChains(extractTargetedActs(evidence));
  assert.equal(chains.length, 2);
  assert.deepEqual(
    chains.map((c) => c.target).sort(),
    ["5", "6"]
  );
  chains.forEach((c) => assert.equal(c.category, "A_suspectOnly"));
});

test("groupIntoChains: SUSPECT(X)->SUSPECT(X) is a single chain flagged hasRepeatedType", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" },
    { type: "suspect", round: 1, actor: "1", target: "5" },
  ];
  const chains = groupIntoChains(extractTargetedActs(evidence));
  assert.equal(chains.length, 1);
  assert.equal(chains[0].category, "A_suspectOnly");
  assert.equal(chains[0].hasRepeatedType, true);
  assert.equal(chains[0].acts.length, 2);
});

test("computeClusterStats: correct counts on a small hand-built scenario", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "1", target: "5" }, // A
    { type: "suspect", round: 1, actor: "1", target: "6" }, // A (different target -> distinctTargetActor)
    { type: "nominate", round: 1, actor: "2", target: "5" }, // combines with nothing else for (2,5) -> E? no nominate-only isn't a listed category name for "nominate only"; classify falls through to "other"
  ];
  const acts = extractTargetedActs(evidence);
  const chains = groupIntoChains(acts);
  const stats = computeClusterStats(acts, chains);
  assert.equal(stats.numSuspect, 2);
  assert.equal(stats.numNominate, 1);
  assert.equal(stats.numVotes, 0);
  assert.equal(stats.numChains, 3); // (1,5) (1,6) (2,5)
  assert.equal(stats.totalTargetedActs, 3);
  assert.equal(stats.distinctTargetActors, 1); // actor "1" acted on two distinct targets
  assert.equal(stats.categoryCounts.A_suspectOnly, 2);
});

// ---- buildCollapsedChainModel ----

const config: GameConfig = { players: ["1", "2", "3", "4"], roles: ["mafia", "citizen", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen", "4": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen", "4": "citizen" }, probability: 0.5 },
];

test("collapsed model: the FIRST suspect for a (actor,target) pair scores at full real strength, identical to the uncollapsed model", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const collapsed = buildCollapsedChainModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [{ type: "suspect", round: 0, actor: "2", target: "3" }];
  const realSteps = processEvidence(worlds, history, real, setting);
  const collapsedSteps = processEvidence(worlds, history, collapsed, setting);
  realSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, collapsedSteps[0].posterior[i].probability));
});

test("collapsed model: a SECOND suspect for the SAME (actor,target) pair is collapsed to a world-independent 1 (no further posterior movement)", () => {
  const collapsed = buildCollapsedChainModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "3" }, // same actor, same target -> collapsed
  ];
  const steps = processEvidence(worlds, history, collapsed, setting);
  // posterior after step 0 (real) vs after step 1 (collapsed, should be identical since it contributes 1)
  steps[0].posterior.forEach((w, i) => assert.equal(w.probability, steps[1].posterior[i].probability));
});

test("collapsed model: a suspect toward a DIFFERENT target by the same actor is NOT collapsed", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const collapsed = buildCollapsedChainModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "suspect", round: 1, actor: "2", target: "4" }, // different target -> full strength
  ];
  const realSteps = processEvidence(worlds, history, real, setting);
  const collapsedSteps = processEvidence(worlds, history, collapsed, setting);
  realSteps[1].posterior.forEach((w, i) => assert.equal(w.probability, collapsedSteps[1].posterior[i].probability));
});

test("collapsed model: defend is NEVER collapsed, even for a repeated (actor,target) pair - the control isolation", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const collapsed = buildCollapsedChainModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [
    { type: "defend", round: 0, actor: "2", target: "3" },
    { type: "defend", round: 1, actor: "2", target: "3" },
  ];
  const realSteps = processEvidence(worlds, history, real, setting);
  const collapsedSteps = processEvidence(worlds, history, collapsed, setting);
  realSteps.forEach((s, i) => s.posterior.forEach((w, j) => assert.equal(w.probability, collapsedSteps[i].posterior[j].probability)));
});

test("collapsed model: within one candidateVote event, a redundant voter (already suspected the candidate) collapses while a fresh voter in the SAME event does not", () => {
  const real = createBehavioralLikelihoodModel(syntheticBehavioralModelParams);
  const collapsed = buildCollapsedChainModel(syntheticBehavioralModelParams);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" }, // voter 2 already opined about candidate 3
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["3"], handsRaised: { "3": ["2", "4"] } }, // voter 2 redundant, voter 4 fresh
  ];
  const realSteps = processEvidence(worlds, history, real, setting);
  const collapsedSteps = processEvidence(worlds, history, collapsed, setting);
  // the collapsed vote step must differ from the real (fully-scored) vote step - voter 2's contribution was dropped
  const realVoteStep = realSteps[1].posterior;
  const collapsedVoteStep = collapsedSteps[1].posterior;
  const anyDifference = realVoteStep.some((w, i) => Math.abs(w.probability - collapsedVoteStep[i].probability) > 1e-9);
  assert.ok(anyDifference);
});
