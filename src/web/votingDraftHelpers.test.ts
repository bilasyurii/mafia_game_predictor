import { test } from "node:test";
import assert from "node:assert/strict";
import { initAliveState } from "../facts";
import { validateCandidateVote } from "../voting";
import { CandidateVote, GameConfig } from "../types";
import { assignVoterHands, dedupeHandsRaised, handsRaisedHasDuplicateVoter, voterAssignments } from "./votingDraftHelpers";

/**
 * Regression tests for the "voter can vote for two candidates and crashes
 * getVoteTallySoFar()" bug: voting.ts's validateCandidateVote correctly
 * rejects a voter appearing under more than one candidate - the bug was
 * that the UI could build exactly that state one recordHandsForCandidate()
 * call at a time. These pure helpers are what now make that structurally
 * impossible; the last test below proves it against the REAL engine
 * validation, not just against these helpers' own definitions.
 */

const candidates = ["A", "B", "C"];

test("1: voter assigned to candidate A cannot end up voting for candidate B too - assigning to B removes them from A", () => {
  const afterA = assignVoterHands(candidates, {}, "3", "A");
  assert.deepEqual(afterA.A, ["3"]);

  const afterB = assignVoterHands(candidates, afterA, "3", "B");
  assert.deepEqual(afterB.A ?? [], []);
  assert.deepEqual(afterB.B, ["3"]);
  assert.equal(handsRaisedHasDuplicateVoter(candidates, afterB), false);
});

test("2: changing a draft vote (re-assigning) removes the previous selection rather than creating two entries; explicit unassign clears it", () => {
  let hands = assignVoterHands(candidates, {}, "1", "A");
  hands = assignVoterHands(candidates, hands, "1", "C");
  assert.deepEqual(hands.A ?? [], []);
  assert.deepEqual(hands.C, ["1"]);

  hands = assignVoterHands(candidates, hands, "1", null);
  assert.deepEqual(hands.A ?? [], []);
  assert.deepEqual(hands.C ?? [], []);
  assert.equal(voterAssignments(candidates, hands).has("1"), false);
});

test("3: distinct voters for distinct candidates don't interfere with each other", () => {
  let hands = assignVoterHands(candidates, {}, "1", "A");
  hands = assignVoterHands(candidates, hands, "2", "B");
  hands = assignVoterHands(candidates, hands, "3", "C");
  assert.deepEqual(hands.A, ["1"]);
  assert.deepEqual(hands.B, ["2"]);
  assert.deepEqual(hands.C, ["3"]);
  assert.equal(handsRaisedHasDuplicateVoter(candidates, hands), false);
});

test("4: a voter who never raised a hand for anyone is simply absent from voterAssignments (left for the engine's abstention rule to resolve)", () => {
  const hands = assignVoterHands(candidates, {}, "1", "A");
  const assignments = voterAssignments(candidates, hands);
  assert.equal(assignments.has("1"), true);
  assert.equal(assignments.has("4"), false); // "4" abstained - not this layer's concern
});

test("5: dedupeHandsRaised repairs a pre-existing duplicate (as could have been saved before this fix), and the REAL engine's validateCandidateVote accepts the repaired draft but rejects the original", () => {
  const config: GameConfig = { players: ["1", "2", "3"], roles: ["mafia", "citizen", "citizen"] };
  const alive = initAliveState(config);

  const corrupted: CandidateVote = {
    type: "candidateVote",
    round: 1,
    stage: "initial",
    candidates: ["2", "3"], // candidates must be living players
    handsRaised: { "2": ["1"], "3": ["1"] }, // voter "1" raised a hand for BOTH - the exact bug
  };
  assert.throws(() => validateCandidateVote(corrupted, alive), /raised a hand more than once/);

  const repairedHands = dedupeHandsRaised(corrupted.candidates, corrupted.handsRaised);
  const repaired: CandidateVote = { ...corrupted, handsRaised: repairedHands };
  assert.doesNotThrow(() => validateCandidateVote(repaired, alive));
  assert.deepEqual(repairedHands["2"], ["1"]); // first occurrence (candidate order) wins
  assert.deepEqual(repairedHands["3"] ?? [], []);
});
