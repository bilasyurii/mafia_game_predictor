import { test } from "node:test";
import assert from "node:assert/strict";
import { AliveState, CandidateVote, KeepOrEliminateVote } from "./types";
import { validateDayElimination } from "./dayEliminationValidation";

const alive: AliveState = { "1": true, "2": true, "3": true, "4": true, "5": true, "6": true };

function candidateVote(round: number, stage: "initial" | "revote", candidates: string[], handsRaised: Record<string, string[]>): CandidateVote {
  return { type: "candidateVote", round, stage, candidates, handsRaised };
}

function keepOrEliminate(round: number, candidates: string[], eliminateHands: string[]): KeepOrEliminateVote {
  return { type: "keepOrEliminateVote", round, candidates, eliminateHands };
}

test("a clean initial-vote winner validates against the matching elimination", () => {
  const vote = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "2", "3", "5"], "4": ["4", "6"] });
  assert.doesNotThrow(() => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["3"] }, [vote], alive));
});

test("throws when the elimination doesn't match the vote's actual winner", () => {
  const vote = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "2", "3", "5"], "4": ["4", "6"] });
  assert.throws(
    () => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["4"] }, [vote], alive),
    /inconsistent with its resolved vote/
  );
});

// all 6 living players (1-6) explicitly cast a hand in every vote below -
// no abstainers - so the tally is exactly the hands shown, not skewed by
// the abstention-to-last-candidate rule.

test("a tie with no revote/keepOrEliminate recorded throws - it can't resolve to any elimination", () => {
  const vote = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  assert.throws(
    () => validateDayElimination({ type: "dayElimination", round: 0, eliminated: [] }, [vote], alive),
    /ended in a tie.*no revote or keep-or-eliminate vote recorded/
  );
});

test("a revote must immediately follow a tied initial vote on the same candidates", () => {
  const initial = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const revote = candidateVote(0, "revote", ["3", "4"], { "3": ["1", "3", "5", "6"], "4": ["2", "4"] });
  assert.doesNotThrow(() => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["3"] }, [initial, revote], alive));

  const revoteWrongCandidates = candidateVote(0, "revote", ["3", "6"], { "3": ["1", "5"], "6": ["2", "4"] });
  assert.throws(
    () => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["3"] }, [initial, revoteWrongCandidates], alive),
    /do not match the preceding tie/
  );
});

test("keepOrEliminateVote must immediately follow a tied revote, and its eliminateAll result must match", () => {
  const initial = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const revote = candidateVote(0, "revote", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const keepOrElim = keepOrEliminate(0, ["3", "4"], ["1", "2", "5", "6"]); // 4 eliminate, 2 keep -> eliminateAll

  assert.doesNotThrow(() => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["3", "4"] }, [initial, revote, keepOrElim], alive));
});

test("a keepAll resolution validates against an empty elimination", () => {
  const initial = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const revote = candidateVote(0, "revote", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const keepOrElim = keepOrEliminate(0, ["3", "4"], []); // nobody votes to eliminate -> keepAll

  assert.doesNotThrow(() => validateDayElimination({ type: "dayElimination", round: 0, eliminated: [] }, [initial, revote, keepOrElim], alive));
});

test("no preceding vote at all throws", () => {
  assert.throws(
    () => validateDayElimination({ type: "dayElimination", round: 0, eliminated: ["3"] }, [], alive),
    /has no preceding candidateVote or keepOrEliminateVote/
  );
});

test("a keepOrEliminateVote that skips the required revote throws", () => {
  const initial = candidateVote(0, "initial", ["3", "4"], { "3": ["1", "3", "5"], "4": ["2", "4", "6"] });
  const keepOrElim = keepOrEliminate(0, ["3", "4"], []);
  assert.throws(
    () => validateDayElimination({ type: "dayElimination", round: 0, eliminated: [] }, [initial, keepOrElim], alive),
    /must immediately follow a revote candidateVote/
  );
});
