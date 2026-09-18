import { test } from "node:test";
import assert from "node:assert/strict";
import { GameConfig, World } from "./types";
import { Evidence } from "./evidence";
import { defaultRoleRegistry } from "./roles";
import { defaultGroupRegistry } from "./roleGroups";
import { GameSetting, processEvidence } from "./processEvidence";
import { GroundTruthTeams } from "./replay";
import {
  buildAblatedBehavioralModel,
  cumulativeCandidateVoteLogLikelihood,
  cumulativeTeamAlignmentLogLikelihood,
  empiricalTargetDirection,
  suspectBreakdown,
} from "./behavioralLikelihoodDiagnostics";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";

/**
 * Tests for the feature-level synthetic->human transfer diagnostic
 * machinery added to behavioralLikelihoodDiagnostics.ts (cumulative
 * log-likelihood, suspect breakdown, empirical-direction counting) and for
 * multi-type ablation composition - never production behavior. Proves the
 * multi-type case against real processEvidence()/updateProbabilities()
 * output, not a reimplementation.
 */

const groundTruthTeams: GroundTruthTeams = { isMafia: { "1": true, "2": false, "3": false, "4": false } };

test("cumulativeTeamAlignmentLogLikelihood: sums ln(likelihood at TRUE actor/target teams) across only the matching event type", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "1" }, // town actor -> mafia target
    { type: "suspect", round: 0, actor: "1", target: "3" }, // mafia actor -> town target
    { type: "defend", round: 0, actor: "2", target: "1" }, // different type, must be excluded
  ];
  const params = syntheticBehavioralModelParams.suspect;
  const expected =
    Math.log(params.town!.otherTeam) + // town actor(2) targeting mafia(1) -> otherTeam bucket
    Math.log(params.mafia!.otherTeam); // mafia actor(1) targeting town(3) -> otherTeam bucket
  const actual = cumulativeTeamAlignmentLogLikelihood(evidence, groundTruthTeams, params, "suspect");
  assert.ok(Math.abs(actual - expected) < 1e-12);
});

test("cumulativeCandidateVoteLogLikelihood: sums each raised-hand voter's own factor, abstainers contribute nothing", () => {
  const evidence: Evidence[] = [
    { type: "candidateVote", round: 0, stage: "initial", candidates: ["1"], handsRaised: { "1": ["2"] } }, // "3","4" abstain implicitly
  ];
  const params = syntheticBehavioralModelParams.candidateVote;
  const expected = Math.log(params.vote.town!.otherTeam); // voter 2 (town) raised hand against candidate 1 (mafia) -> otherTeam
  const actual = cumulativeCandidateVoteLogLikelihood(evidence, groundTruthTeams, params);
  assert.ok(Math.abs(actual - expected) < 1e-12);
});

test("suspectBreakdown: correctly splits target team, counts distinct vs repeated targets per actor", () => {
  const evidence: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "1" }, // targets actual mafia
    { type: "suspect", round: 1, actor: "2", target: "3" }, // targets actual town, distinct target for actor 2
    { type: "suspect", round: 2, actor: "2", target: "3" }, // repeated same target for actor 2
    { type: "suspect", round: 3, actor: "4", target: "1" }, // targets actual mafia, actor 4's only suspect
  ];
  const result = suspectBreakdown(evidence, groundTruthTeams);
  assert.equal(result.totalSuspects, 4);
  assert.equal(result.targetMafia, 2);
  assert.equal(result.targetTown, 2);
  const actor2 = result.perActor.find((a) => a.actor === "2")!;
  assert.equal(actor2.totalSuspects, 3);
  assert.equal(actor2.distinctTargets, 2);
  assert.equal(actor2.repeatedTargetActs, 1);
  const actor4 = result.perActor.find((a) => a.actor === "4")!;
  assert.equal(actor4.totalSuspects, 1);
  assert.equal(actor4.distinctTargets, 1);
  assert.equal(actor4.repeatedTargetActs, 0);
});

test("empiricalTargetDirection: counts only the requested event type, split by the target's true team", () => {
  const evidence: Evidence[] = [
    { type: "nominate", round: 0, actor: "2", target: "1" }, // mafia target
    { type: "nominate", round: 1, actor: "3", target: "4" }, // town target
    { type: "suspect", round: 0, actor: "2", target: "1" }, // wrong type, excluded
  ];
  const result = empiricalTargetDirection(evidence, groundTruthTeams, "nominate");
  assert.equal(result.n, 2);
  assert.equal(result.targetMafia, 1);
  assert.equal(result.targetTown, 1);
});

// ---- multi-type ablation composition, proven against real processEvidence() ----

const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
const setting: GameSetting = { config, roles: defaultRoleRegistry, groups: defaultGroupRegistry };
const worlds: World[] = [
  { roles: { "1": "mafia", "2": "citizen", "3": "citizen" }, probability: 0.5 },
  { roles: { "1": "citizen", "2": "mafia", "3": "citizen" }, probability: 0.5 },
];

test("multi-type ablation (suspect AND nominate disabled together): both are neutralized, a third type (candidateVote) in the same set still scores at full strength", () => {
  const disableBoth = new Set<any>(["selfRoleClaim", "roleAssertion", "investigationReport", "defend", "candidateVote", "keepOrEliminateVote"]); // everything except suspect+nominate
  const model = buildAblatedBehavioralModel(syntheticBehavioralModelParams, disableBoth);
  const history: Evidence[] = [
    { type: "suspect", round: 0, actor: "2", target: "3" },
    { type: "nominate", round: 1, actor: "2", target: "3" },
  ];
  const steps = processEvidence(worlds, history, model, setting);
  // both ablated -> posterior stays at the 0.5/0.5 prior after both steps
  steps[1].posterior.forEach((w) => assert.ok(Math.abs(w.probability - 0.5) < 1e-9));

  const withCandidateVote: Evidence[] = [{ type: "candidateVote", round: 0, stage: "initial", candidates: ["3"], handsRaised: { "3": ["2"] } }];
  const cvSteps = processEvidence(worlds, withCandidateVote, model, setting);
  const cvFull = processEvidence(worlds, withCandidateVote, buildAblatedBehavioralModel(syntheticBehavioralModelParams, new Set(["candidateVote"] as any)), setting);
  cvSteps[0].posterior.forEach((w, i) => assert.equal(w.probability, cvFull[0].posterior[i].probability));
});
