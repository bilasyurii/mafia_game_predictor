import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultBehavioralModelParams } from "./behavioralModel";
import { syntheticBehavioralModelParams } from "./syntheticBehavioralModel";

/**
 * Tests for the synthetic-derived behavioral priors: valid probability
 * ranges, the Dirichlet(kappa=10) smoothing formula on a couple of
 * hand-checkable categories, and that every category with ZERO synthetic
 * observations (roleAssertion, keepOrEliminateVote, repeatFactor) was left
 * exactly untouched rather than silently drifting.
 */

function assertIsProbability(value: number, label: string) {
  assert.ok(value > 0 && value < 1, `${label} should be a smoothed, non-degenerate probability, got ${value}`);
}

test("every smoothed leaf value is a valid, non-degenerate probability (never exactly 0 or 1)", () => {
  const p = syntheticBehavioralModelParams;
  assertIsProbability(p.selfRoleClaim.truthful, "selfRoleClaim.truthful");
  assertIsProbability(p.selfRoleClaim.falseSameTeam, "selfRoleClaim.falseSameTeam");
  assertIsProbability(p.selfRoleClaim.falseDifferentTeam, "selfRoleClaim.falseDifferentTeam");

  assertIsProbability(p.investigationReport.truthful as number, "investigationReport.truthful");
  assertIsProbability(p.investigationReport.falseResult as number, "investigationReport.falseResult");
  assertIsProbability(p.investigationReport.bluff as number, "investigationReport.bluff");

  (["town", "mafia"] as const).forEach((team) => {
    assertIsProbability(p.suspect[team]!.ownTeam, `suspect.${team}.ownTeam`);
    assertIsProbability(p.suspect[team]!.otherTeam, `suspect.${team}.otherTeam`);
    assertIsProbability(p.defend[team]!.ownTeam, `defend.${team}.ownTeam`);
    assertIsProbability(p.defend[team]!.otherTeam, `defend.${team}.otherTeam`);
    assertIsProbability(p.nominate[team]!.ownTeam, `nominate.${team}.ownTeam`);
    assertIsProbability(p.nominate[team]!.otherTeam, `nominate.${team}.otherTeam`);
    assertIsProbability(p.candidateVote.vote[team]!.ownTeam, `candidateVote.vote.${team}.ownTeam`);
    assertIsProbability(p.candidateVote.vote[team]!.otherTeam, `candidateVote.vote.${team}.otherTeam`);
    assertIsProbability(p.candidateVote.abstain[team] as number, `candidateVote.abstain.${team}`);
  });
});

test("selfRoleClaim matches the Dirichlet(kappa=10) smoothing formula against the raw synthetic counts (19/0/8, N=27)", () => {
  const perCategory = 10 / 3;
  const total = 27 + 10;
  assert.ok(Math.abs(syntheticBehavioralModelParams.selfRoleClaim.truthful - (19 + perCategory) / total) < 1e-9);
  assert.ok(Math.abs(syntheticBehavioralModelParams.selfRoleClaim.falseSameTeam - (0 + perCategory) / total) < 1e-9);
  assert.ok(Math.abs(syntheticBehavioralModelParams.selfRoleClaim.falseDifferentTeam - (8 + perCategory) / total) < 1e-9);
});

test("suspect.mafia.ownTeam (raw count 0 of 47) is pulled toward the prior, not left at a hard zero", () => {
  const perCategory = 10 / 2;
  const expected = (0 + perCategory) / (47 + 10);
  assert.ok(Math.abs(syntheticBehavioralModelParams.suspect.mafia!.ownTeam - expected) < 1e-9);
  assert.ok(syntheticBehavioralModelParams.suspect.mafia!.ownTeam > 0);
  assert.ok(syntheticBehavioralModelParams.suspect.mafia!.ownTeam < 0.2); // still clearly pulled toward the data, not fully back to 0.5
});

test("categories with zero synthetic observations are left exactly equal to defaultBehavioralModelParams", () => {
  assert.deepEqual(syntheticBehavioralModelParams.roleAssertion, defaultBehavioralModelParams.roleAssertion);
  assert.deepEqual(syntheticBehavioralModelParams.keepOrEliminateVote, defaultBehavioralModelParams.keepOrEliminateVote);
  assert.equal(syntheticBehavioralModelParams.repeatFactor, defaultBehavioralModelParams.repeatFactor);
});

test("candidateVote's abstain and per-team vote splits are each internally consistent smoothed probabilities", () => {
  // town: 28 abstain, 48 voted (24/24 split) out of 76 total voter-turns
  const abstainExpected = (28 + 5) / (76 + 10);
  assert.ok(Math.abs(syntheticBehavioralModelParams.candidateVote.abstain.town! - abstainExpected) < 1e-9);
  // exactly even raw counts (24/24) among voted town voters -> exactly 0.5 after symmetric smoothing
  assert.ok(Math.abs(syntheticBehavioralModelParams.candidateVote.vote.town!.ownTeam - 0.5) < 1e-9);
  assert.ok(Math.abs(syntheticBehavioralModelParams.candidateVote.vote.town!.otherTeam - 0.5) < 1e-9);
});
